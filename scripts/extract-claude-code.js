// Extract exact per-day Claude token usage from local transcript JSONL into
// receipt JSONL under scratch/receipts/. Read-only against every store it reads.
//
// Two stores, each its own source id:
// - claude_code:   the Claude Code transcript store. Claude Code CLI, the
//                  desktop app's Claude Code mode, and the IDE extensions all
//                  write here. It is $CLAUDE_CONFIG_DIR/projects when that is
//                  set, otherwise ~/.claude/projects, on every platform.
// - claude_cowork: the Claude desktop app's agent session stores, same
//                  transcript format. Under the app's data directory:
//                  ~/Library/Application Support/Claude on macOS,
//                  %APPDATA%\Claude on Windows, and
//                  $XDG_CONFIG_HOME/Claude (default ~/.config/Claude) on Linux.
//                  Verified on macOS; the Windows and Linux locations are the
//                  platform conventions and have not been checked against the app.
//
// Token definition: input + cache_creation + output per request. Cache-read
// tokens are excluded from the headline count, because they re-process the same
// cached bytes and would dwarf every other source; each day's cache-read total
// is kept in the receipt's provenance, per invariant 5.
//
// A transcript writes the same assistant message several times as it streams,
// under different uuids and one requestId. Records are deduped by requestId and
// the latest write wins, because earlier writes hold partial output counts.
//
// Usage:
//   node scripts/extract-claude-code.js [--source claude_code|claude_cowork]...
//     [--since YYYY-MM-DD] [--root DIR]... [--tag ORIGIN] [--dry-run]
//
// --source limits the run to one store; repeat it for both. With no --source,
//   both stores are read.
// --root scans DIR instead of the default store location, and may be repeated.
//   Point it at a backup of the transcript store to recover usage from
//   transcripts that have since been pruned: requestId dedupe makes overlapping
//   extractions safe. Roots are read as claude_code unless exactly one other
//   --source is given.
// --tag sets the receipts' origin, for a store copied from another machine or
//   a backup, so its receipts sum alongside this machine's instead of
//   replacing them. Default: this machine and user, per scripts/lib/origin.js.
//
// Output: one file per source, scratch/receipts/<source>-<origin>.jsonl,
// overwritten on each run. A store that cannot be read leaves its previous
// file untouched, so a failed read never looks like a smaller day.
//
// Every selected store is reported as read, not found, or unreadable. Not
// found is evidence of absence and writes nothing. Unreadable is unknown: the
// run exits 3 so that a pipeline cannot mistake it for a clean empty result.

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";
import { accountAlias, machineAlias } from "./lib/openai-integrity.js";

const SOURCES = {
  claude_code: { surface: "claude_code_transcripts", label: "Claude Code transcripts" },
  claude_cowork: { surface: "claude_desktop_agent_sessions", label: "Claude desktop agent sessions" }
};
const EXIT_UNREADABLE = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const flagAll = (name) =>
  args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));

const requested = flagAll("--source");
for (const source of requested) {
  if (!SOURCES[source]) {
    console.error(`Unknown --source ${source}. Choose from: ${Object.keys(SOURCES).join(", ")}.`);
    process.exit(64);
  }
}
const selected = requested.length ? [...new Set(requested)] : Object.keys(SOURCES);
const since = flag("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
const dryRun = args.includes("--dry-run");

const desktopDataDir = () => {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Claude");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude");
};

const defaultStores = (source) => source === "claude_code"
  ? [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")]
  : [
      join(desktopDataDir(), "local-agent-mode-sessions"),
      join(desktopDataDir(), "claude-code-sessions")
    ];

const customRoots = flagAll("--root");
const customSource = selected.length === 1 ? selected[0] : "claude_code";
const stores = customRoots.length
  ? customRoots.map((dir) => ({ dir, source: customSource }))
  : selected.flatMap((source) => defaultStores(source).map((dir) => ({ dir, source })));

const ORIGIN = await localOrigin(flag("--tag"));
const TIMEZONE = await timezone();

// Per-store findings. "absent" is evidence that the store does not exist;
// "unreadable" is not evidence of anything, and must never be summed as zero.
const findings = stores.map((store) => ({ ...store, state: "absent", files: 0, error: null }));

async function* walkJsonl(dir, finding) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" && dir === finding.dir) return;
    finding.state = "unreadable";
    finding.error = error.code ?? String(error);
    return;
  }
  if (dir === finding.dir && finding.state === "absent") finding.state = "read";
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(path, finding);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

const chosen = new Map();
let usageRecords = 0;
let parseFailures = 0;
// A per-line uuid is not a request identity: one streamed turn writes several
// lines, so falling back to uuid can inflate. Counted so the fallback can never
// be silently load-bearing.
let uuidFallbacks = 0;

for (const finding of findings) {
  for await (const file of walkJsonl(finding.dir, finding)) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      finding.state = "unreadable";
      finding.error = error.code ?? String(error);
      continue;
    }
    finding.files += 1;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        parseFailures += 1;
        continue;
      }
      const usage = entry.message?.usage;
      if (!usage || !entry.timestamp) continue;
      usageRecords += 1;
      const requestId = entry.requestId ?? entry.message?.id;
      if (!requestId) uuidFallbacks += 1;
      const id = requestId ?? entry.uuid ?? `${file}:${entry.timestamp}`;
      const key = `${finding.source}|${id}`;
      const previous = chosen.get(key);
      if (previous && previous.timestamp >= entry.timestamp) continue;
      chosen.set(key, {
        source: finding.source,
        timestamp: entry.timestamp,
        model: entry.message?.model,
        // One-way: raw request ids never enter a receipt, but the hash lets a
        // re-import from a backup or another machine be recognised.
        correlationKey: requestId ? hashCorrelationKey(`${finding.source}:${requestId}`) : null,
        usage
      });
    }
  }
}

const buckets = new Map();
for (const record of chosen.values()) {
  const date = await dayOf(record.timestamp);
  if (since && date < since) continue;
  const key = `${record.source} ${date}`;
  const bucket = buckets.get(key) ?? {
    date,
    source: record.source,
    tokens: 0,
    calls: 0,
    cacheRead: 0,
    models: new Set(),
    correlationKeys: new Set()
  };
  bucket.tokens +=
    (record.usage.input_tokens ?? 0) +
    (record.usage.cache_creation_input_tokens ?? 0) +
    (record.usage.output_tokens ?? 0);
  bucket.cacheRead += record.usage.cache_read_input_tokens ?? 0;
  bucket.calls += 1;
  if (record.model) bucket.models.add(record.model);
  if (record.correlationKey) bucket.correlationKeys.add(record.correlationKey);
  buckets.set(key, bucket);
}

const receiptsBySource = new Map(
  (customRoots.length ? [customSource] : selected).map((source) => [source, []])
);
for (const bucket of [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))) {
  if (bucket.tokens <= 0) continue;
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: bucket.source,
    tokens: bucket.tokens,
    calls: bucket.calls,
    fidelity: "exact",
    provider: "anthropic",
    surface: SOURCES[bucket.source].surface,
    account_alias: accountAlias("anthropic"),
    machine_alias: machineAlias(),
    origin: ORIGIN,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `${bucket.source}:${ORIGIN}:${bucket.date}`,
    authority: "tool",
    models: [...bucket.models].sort(),
    correlation_keys: [...bucket.correlationKeys].sort(),
    provenance: `${SOURCES[bucket.source].label}: cache_read ${bucket.cacheRead} excluded`
  };
  const errors = validateReceiptSchema(receipt, `${bucket.source} ${bucket.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  receiptsBySource.get(bucket.source).push(receipt);
}

const log = dryRun ? console.error : console.log;
log("Stores:");
for (const finding of findings) {
  const state = finding.state === "read"
    ? `read, ${finding.files} transcript file(s)`
    : finding.state === "absent"
      ? "not found"
      : `UNREADABLE (${finding.error})`;
  log(`  ${finding.source.padEnd(13)} ${finding.dir}: ${state}`);
}

const unreadableSources = new Set(findings.filter((f) => f.state === "unreadable").map((f) => f.source));
for (const [source, receipts] of receiptsBySource) {
  const outputPath = `scratch/receipts/${source}-${ORIGIN.replace(/\//g, "_")}.jsonl`;
  if (unreadableSources.has(source)) {
    log(`${source}: not written, because a store could not be read; ${outputPath} is unchanged.`);
    continue;
  }
  if (!receipts.length) {
    log(`${source}: no usage found; nothing written.`);
    continue;
  }
  const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
  if (dryRun) {
    process.stdout.write(jsonl);
    log(`${source}: ${receipts.length} daily receipt(s) (dry run).`);
  } else {
    await mkdir("scratch/receipts", { recursive: true });
    await writeFile(outputPath, jsonl);
    log(`${source}: wrote ${receipts.length} daily receipt(s) to ${outputPath}.`);
  }
}
log(`${usageRecords} usage records collapsed to ${chosen.size} unique requests.`);
if (parseFailures) console.error(`WARNING: ${parseFailures} unparseable JSONL line(s) skipped.`);
if (uuidFallbacks) console.error(`WARNING: ${uuidFallbacks} record(s) had no requestId or message id; keyed by uuid, which can inflate.`);

if (unreadableSources.size) {
  console.error("");
  console.error("WARNING: some stores exist but could not be read. Their usage is UNKNOWN, not zero.");
  console.error("Run the extractor as the user who owns them, or grant read access, then run it again.");
  process.exit(EXIT_UNREADABLE);
}
