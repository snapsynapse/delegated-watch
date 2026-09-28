// Extract exact per-day Codex token usage from local rollout JSONL into
// receipt JSONL under scratch/receipts/. Read-only against every store it reads.
//
// The store is $CODEX_HOME when that is set, otherwise ~/.codex, on every
// platform. Both its sessions/ and archived_sessions/ directories are read, and
// a rollout found in both (moved while this ran) is counted once.
//
// Token definition: non-cached input + output per API response. Codex reports
// cached_input_tokens as a subset of input_tokens, so cached input is
// subtracted rather than counted again, and kept in provenance per invariant 5.
// Reasoning output is already included in output_tokens.
//
// Rollouts can emit the same cumulative token_count snapshot more than once.
// Within each rollout, the cumulative usage is the dedupe key: each first-seen
// snapshot contributes its last_token_usage exactly once. A cumulative total
// that falls is a counter reset, counted and noted in provenance.
//
// Usage:
//   node scripts/extract-codex.js [--sessions DIR (--tag ORIGIN | --local-store)]
//     [--since YYYY-MM-DD] [--dry-run]
//
// --sessions reads one explicit rollout root instead of the default store, for
//   a backup or a store copied from another machine. It must say whose store it
//   is: --tag names an independent store, so its receipts sum alongside this
//   machine's; --local-store acknowledges it is this machine's own store, so a
//   backup of it dedupes against the live one. Without either, a copied store
//   would silently inherit this machine's identity.
//
// Output: scratch/receipts/codex-<origin>.jsonl, overwritten on each run. A
// store that cannot be read leaves the previous file untouched.
//
// Every store is reported as read, not found, or unreadable. Not found writes
// nothing. Unreadable is unknown, not zero: the run exits 3.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const EXIT_UNREADABLE = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const explicitSessions = flag("--sessions");
const since = flag("--since");
const tag = flag("--tag");
const localStore = args.includes("--local-store");
const dryRun = args.includes("--dry-run");

if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
if (tag && !/^[a-z0-9][a-z0-9._/-]*$/.test(tag)) {
  console.error("--tag must be lowercase alphanumeric with . _ - / separators; it becomes the origin and the file name.");
  process.exit(64);
}
if (tag && localStore) {
  console.error("Use either --tag for an independent store or --local-store for this machine's own store, not both.");
  process.exit(64);
}
if (explicitSessions && !tag && !localStore) {
  console.error(
    "--sessions needs an explicit store identity: --tag ORIGIN for a store from another machine or profile, " +
      "or --local-store when it is this machine's own store."
  );
  process.exit(64);
}

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const roots = explicitSessions
  ? [explicitSessions]
  : [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(tag);
const receiptMachine = tag ?? (await profile()).machine_alias ?? machineAlias();
const receiptAccount = accountAlias("openai");
const OUTPUT = `scratch/receipts/codex-${ORIGIN.replace(/\//g, "_")}.jsonl`;

const findings = roots.map((dir) => ({ dir, state: "absent", files: 0, error: null }));
const rolloutFiles = [];

const visit = async (dir, finding) => {
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
    if (entry.isDirectory()) await visit(path, finding);
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      rolloutFiles.push({ path, finding });
    }
  }
};
for (const finding of findings) await visit(finding.dir, finding);

// An explicitly named root that does not exist is a mistake, not evidence.
if (explicitSessions && findings[0].state === "absent") {
  console.error(`No Codex rollout directory at ${explicitSessions}.`);
  process.exit(66);
}

// The filename carries the stable thread id, so one copy per name is kept when
// a rollout is caught in both sessions/ and archived_sessions/.
const uniqueRollouts = [
  ...new Map(rolloutFiles.sort((a, b) => a.path.localeCompare(b.path)).map((file) => [basename(file.path), file])).values()
];

const usageSignature = (usage) =>
  [
    usage.input_tokens ?? 0,
    usage.cached_input_tokens ?? 0,
    usage.cache_write_input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.reasoning_output_tokens ?? 0,
    usage.total_tokens ?? 0
  ].join(":");

const days = new Map();
let usageEvents = 0;
let duplicateEvents = 0;
let counterResets = 0;
let parseFailures = 0;

for (const { path, finding } of uniqueRollouts) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    finding.state = "unreadable";
    finding.error = error.code ?? String(error);
    continue;
  }
  finding.files += 1;
  let lastCumulativeSignature = null;
  let lastCumulativeTotal = null;
  let currentModel = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      parseFailures += 1;
      continue;
    }

    if (entry.type === "turn_context" && entry.payload?.model) {
      currentModel = entry.payload.model;
      continue;
    }

    if (entry.payload?.type !== "token_count" || !entry.timestamp) continue;
    const usage = entry.payload.info?.last_token_usage;
    const cumulative = entry.payload.info?.total_token_usage;
    if (!usage || !cumulative) continue;

    const signature = usageSignature(cumulative);
    if (signature === lastCumulativeSignature) {
      duplicateEvents += 1;
      continue;
    }
    const cumulativeTotal =
      cumulative.total_tokens ?? (cumulative.input_tokens ?? 0) + (cumulative.output_tokens ?? 0);
    const wasReset = lastCumulativeTotal !== null && cumulativeTotal < lastCumulativeTotal;
    if (wasReset) counterResets += 1;
    lastCumulativeSignature = signature;
    lastCumulativeTotal = cumulativeTotal;
    usageEvents += 1;

    const date = await dayOf(entry.timestamp);
    if (since && date < since) continue;

    const input = usage.input_tokens ?? 0;
    const cachedInput = usage.cached_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const day = days.get(date) ?? { date, tokens: 0, calls: 0, cachedInput: 0, counterResets: 0, models: new Set() };
    day.tokens += Math.max(0, input - cachedInput) + output;
    day.cachedInput += cachedInput;
    if (wasReset) day.counterResets += 1;
    day.calls += 1;
    if (currentModel) day.models.add(currentModel);
    days.set(date, day);
  }
}

const receipts = [];
for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
  if (day.tokens <= 0) continue;
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: day.date,
    timezone: TIMEZONE,
    source: "codex",
    tokens: day.tokens,
    calls: day.calls,
    fidelity: "exact",
    provider: "openai",
    surface: "codex_local",
    account_alias: receiptAccount,
    machine_alias: receiptMachine,
    origin: ORIGIN,
    interval: { start: day.date, end: day.date },
    snapshot_key: `codex:${receiptAccount}:${receiptMachine}:${day.date}`,
    authority: "tool",
    models: [...day.models].sort(),
    provenance:
      `Codex rollout token_count; cached_input ${day.cachedInput} excluded; adjacent cumulative snapshots deduped` +
      (day.counterResets ? `; ${day.counterResets} counter resets observed` : "")
  };
  const errors = validateReceiptSchema(receipt, `codex ${day.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  receipts.push(receipt);
}

const log = dryRun ? console.error : console.log;
log("Stores:");
for (const finding of findings) {
  const state = finding.state === "read"
    ? `read, ${finding.files} rollout file(s)`
    : finding.state === "absent"
      ? "not found"
      : `UNREADABLE (${finding.error})`;
  log(`  codex ${finding.dir}: ${state}`);
}
const summary =
  `${uniqueRollouts.length} rollout file(s), ${usageEvents} usage events, ` +
  `${duplicateEvents} duplicates skipped, ${counterResets} counter resets`;
if (parseFailures) console.error(`WARNING: ${parseFailures} unparseable Codex JSONL line(s) skipped.`);

if (findings.some((finding) => finding.state === "unreadable")) {
  log(`codex: not written, because a store could not be read; ${OUTPUT} is unchanged.`);
  console.error("");
  console.error("WARNING: a Codex store exists but could not be read. Its usage is UNKNOWN, not zero.");
  console.error("Run the extractor as the user who owns it, or grant read access, then run it again.");
  process.exit(EXIT_UNREADABLE);
}
if (!receipts.length) {
  log(`codex: no usage found (${summary}); nothing written.`);
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) {
  process.stdout.write(jsonl);
  log(`codex: ${receipts.length} daily receipt(s) (dry run; ${summary}).`);
} else {
  await atomicWriteText(OUTPUT, jsonl);
  log(`codex: wrote ${receipts.length} daily receipt(s) to ${OUTPUT} (${summary}).`);
}
