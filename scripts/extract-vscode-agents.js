// Extract exact per-day usage from the task stores of Cline and the agent
// extensions built on it: Roo Code, Kilo Code, and Snapdev. Read-only against
// every store it reads.
//
// These extensions share one store format. Each task directory holds a
// ui_messages.json array, and every settled model request is a say /
// api_req_started record whose text is a JSON payload of counters: tokensIn,
// tokensOut, cacheWrites, cacheReads. Only those counters, the timestamp, and
// the task's configured model name are read. Prompts, responses, file paths,
// cost figures, and raw task ids never leave the store.
//
// Each extension keeps its tasks at <editor data>/User/globalStorage/<id>/tasks,
// where the editor data directory is ~/Library/Application Support/<Editor> on
// macOS, %APPDATA%\<Editor> on Windows, and ${XDG_CONFIG_HOME:-~/.config}/<Editor>
// on Linux. Every known editor is read: VS Code, VS Code Insiders, VSCodium,
// Cursor, and Windsurf. Verified for Cline, Kilo Code, and Snapdev in VS Code
// on macOS; the rest follow the same conventions and have not been checked.
//
// Two token-counter conventions exist in these stores, and one store can hold
// both, so the convention is decided per record:
// - cacheReads and cacheWrites both zero: no convention is involved.
// - tokensIn < cacheReads + cacheWrites: an inclusive counter can never fall
//   below the cache totals it contains, so the record is legacy (tokensIn is
//   non-cached input, cacheWrites separate). Decided by the counters alone.
// - anything else is consistent with both. --token-convention legacy|inclusive
//   breaks that tie and only that tie, for every selected source, or
//   --token-convention SOURCE=legacy|inclusive for one source; repeat it for
//   several. Without one, those records are counted as undecided and the
//   source is not written.
// Headline tokens are input + cache writes + output. Cache reads are excluded
// and kept in provenance, per invariant 5.
//
// Usage:
//   node scripts/extract-vscode-agents.js [--source cline|roo_code|kilo|snapdev]...
//     [--root TASKS_DIR] [--since YYYY-MM-DD] [--tag ORIGIN]
//     [--token-convention legacy|inclusive] [--dry-run]
//
// With no --source, all four are read. --root reads one tasks directory, for a
// backup or another machine's store, and needs exactly one --source. The
// tie-breaker applies to every selected source; run sources separately if
// they need different ones.
//
// Output: scratch/receipts/<source>-<origin>.jsonl per source, overwritten on
// each run. Each source is independent: a source whose store could not be
// read, whose counters are malformed, or that has undecided records is not
// written and its previous file is left untouched, while the others are.
//
// Exit status: 0 when every selected source was read or not found; 3 when any
// source is unknown; 64 usage; 66 an explicit --root that does not exist.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const EXTENSIONS = {
  cline: { id: "saoudrizwan.claude-dev", label: "Cline" },
  roo_code: { id: "rooveterinaryinc.roo-cline", label: "Roo Code" },
  kilo: { id: "kilocode.kilo-code", label: "Kilo Code" },
  snapdev: { id: "remotebase.snapdev", label: "Snapdev" }
};
const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
const EXIT_UNKNOWN = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const flagAll = (name) =>
  args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));

const requested = flagAll("--source");
for (const source of requested) {
  if (!EXTENSIONS[source]) {
    console.error(`Unknown --source ${source}. Choose from: ${Object.keys(EXTENSIONS).join(", ")}.`);
    process.exit(64);
  }
}
const selected = requested.length ? [...new Set(requested)] : Object.keys(EXTENSIONS);
const explicitRoot = flag("--root");
if (explicitRoot && selected.length !== 1) {
  console.error("--root reads one tasks directory, so it needs exactly one --source.");
  process.exit(64);
}
const since = flag("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
// A bare value applies to every source; SOURCE=value applies to one.
const conventions = new Map();
let defaultConvention = null;
for (const value of flagAll("--token-convention")) {
  const [source, convention] = value.includes("=") ? value.split("=", 2) : [null, value];
  if (!["legacy", "inclusive"].includes(convention) || (source !== null && !EXTENSIONS[source])) {
    console.error(`--token-convention must be legacy or inclusive, optionally as SOURCE=value with SOURCE one of ${Object.keys(EXTENSIONS).join(", ")}.`);
    process.exit(64);
  }
  if (source === null) defaultConvention = convention;
  else conventions.set(source, convention);
}
const conventionFor = (source) => conventions.get(source) ?? defaultConvention;
const tag = flag("--tag");
const dryRun = args.includes("--dry-run");
const log = dryRun ? console.error : console.log;

const editorDataDir = (editor) => {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", editor);
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), editor);
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), editor);
};
const storesFor = (source) => explicitRoot
  ? [explicitRoot]
  : EDITORS.map((editor) => join(editorDataDir(editor), "User", "globalStorage", EXTENSIONS[source].id, "tasks"));

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(tag);
const receiptMachine = tag ?? (await profile()).machine_alias ?? machineAlias();

// Model names for the configurations these extensions commonly save. An
// unrecognised configuration name contributes no model rather than a guess.
const modelForConfig = (name) => {
  const normalized = String(name ?? "").trim().toLowerCase();
  const mappings = [
    [/^(anthropic - )?opus 4\.6$|^claude opus 4\.6$/, "claude-opus-4-6"],
    [/^(anthropic - )?opus 4\.5$|^claude opus 4\.5$/, "claude-opus-4-5"],
    [/^(anthropic - )?sonnet 4\.6$|^claude sonnet 4\.6$/, "claude-sonnet-4-6"],
    [/^(anthropic - )?sonnet 4\.5$|^claude sonnet 4\.5$/, "claude-sonnet-4-5"],
    [/^gemini 3\.1 pro preview$/, "gemini-3.1-pro-preview"],
    [/^gemini 3 pro preview$|^gemini 3$/, "gemini-3-pro-preview"],
    [/^gemini flash$/, "gemini-3-flash-preview"]
  ];
  return mappings.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
};

const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

// Reads one source across all of its stores. Returns the per-store findings,
// the daily buckets, and every reason the source's total cannot be trusted.
async function extractSource(source) {
  const tokenConvention = conventionFor(source);
  const stores = storesFor(source).map((dir) => ({ dir, state: "absent", tasks: 0, error: null }));
  const days = new Map();
  const problems = [];
  const counts = { requests: 0, legacy: 0, inclusive: 0, noCache: 0, decided: 0, tieBroken: 0, undecided: 0 };

  for (const store of stores) {
    let entries;
    try {
      entries = await readdir(store.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      store.state = "unreadable";
      store.error = error.code ?? String(error);
      problems.push(`${store.dir} could not be read (${store.error})`);
      continue;
    }
    store.state = "read";
    for (const taskId of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const taskRoot = join(store.dir, taskId);
      let messages;
      try {
        messages = JSON.parse(await readFile(join(taskRoot, "ui_messages.json"), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        problems.push(`a task's ui_messages.json could not be read or parsed (${error.code ?? "invalid JSON"})`);
        continue;
      }
      if (!Array.isArray(messages)) {
        problems.push("a task's ui_messages.json is not a JSON array");
        continue;
      }
      store.tasks += 1;

      let model = null;
      try {
        model = modelForConfig(JSON.parse(await readFile(join(taskRoot, "history_item.json"), "utf8")).apiConfigName);
      } catch (error) {
        if (error.code !== "ENOENT") problems.push(`a task's history_item.json could not be read or parsed (${error.code ?? "invalid JSON"})`);
      }

      let requestIndex = 0;
      for (const message of messages) {
        if (message?.type !== "say" || message?.say !== "api_req_started" || typeof message.text !== "string") continue;
        let usage;
        try {
          usage = JSON.parse(message.text);
        } catch {
          problems.push("a usage payload is not valid JSON");
          continue;
        }
        const input = Number(usage.tokensIn ?? 0);
        const output = Number(usage.tokensOut ?? 0);
        const cacheWrite = Number(usage.cacheWrites ?? 0);
        const cacheRead = Number(usage.cacheReads ?? 0);
        if (![input, output, cacheWrite, cacheRead].every(isCounter) || !Number.isFinite(message.ts)) {
          problems.push("a usage payload has invalid counters or no timestamp");
          continue;
        }
        // One-way over the task id, so a backup of the same store is
        // recognised without the raw id entering a receipt.
        const correlationKey = hashCorrelationKey(`${taskId}:${message.ts}:${requestIndex}`);
        requestIndex += 1;
        counts.requests += 1;
        const date = await dayOf(new Date(message.ts).toISOString());
        if (since && date < since) continue;

        let tokens;
        let convention;
        let tieBroken = false;
        if (cacheRead === 0 && cacheWrite === 0) {
          tokens = input + output;
          convention = "no_cache";
          counts.noCache += 1;
        } else if (input < cacheRead + cacheWrite) {
          tokens = input + cacheWrite + output;
          convention = "legacy";
          counts.legacy += 1;
          counts.decided += 1;
        } else if (tokenConvention === "inclusive") {
          tokens = input - cacheRead + output;
          convention = "inclusive";
          counts.inclusive += 1;
          counts.tieBroken += 1;
          tieBroken = true;
        } else if (tokenConvention === "legacy") {
          tokens = input + cacheWrite + output;
          convention = "legacy";
          counts.legacy += 1;
          counts.tieBroken += 1;
          tieBroken = true;
        } else {
          counts.undecided += 1;
          continue;
        }

        const day = days.get(date) ?? {
          date, tokens: 0, calls: 0, cacheRead: 0, cacheWrite: 0, tieBroken: 0,
          conventions: new Set(), models: new Set(), correlationKeys: new Set()
        };
        day.tokens += tokens;
        day.calls += 1;
        day.cacheRead += cacheRead;
        day.cacheWrite += cacheWrite;
        if (tieBroken) day.tieBroken += 1;
        day.conventions.add(convention);
        if (model) day.models.add(model);
        day.correlationKeys.add(correlationKey);
        days.set(date, day);
      }
    }
  }
  if (counts.undecided) {
    problems.push(
      `${counts.undecided} record(s) have cache counters consistent with both conventions; ` +
        "rerun with --token-convention legacy or inclusive to break the tie"
    );
  }
  return { stores, days, problems, counts };
}

if (explicitRoot) {
  try {
    await readdir(explicitRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`No tasks directory at ${explicitRoot}.`);
      process.exit(66);
    }
  }
}

let anyUnknown = false;
const output = [];
log("Stores:");
for (const source of selected) {
  const { label } = EXTENSIONS[source];
  const { stores, days, problems, counts } = await extractSource(source);
  for (const store of stores) {
    if (store.state === "absent" && !explicitRoot) continue;
    const state = store.state === "read" ? `read, ${store.tasks} task(s)` : store.state === "absent" ? "not found" : `UNREADABLE (${store.error})`;
    log(`  ${source.padEnd(8)} ${store.dir}: ${state}`);
  }
  const outputPath = `scratch/receipts/${source}-${ORIGIN.replace(/\//g, "_")}.jsonl`;
  if (!stores.some((store) => store.state !== "absent")) {
    log(`${source}: no ${label} task store found; nothing written.`);
    continue;
  }
  if (problems.length) {
    anyUnknown = true;
    log(`${source}: not written; ${outputPath} is unchanged. Usage is UNKNOWN, not zero:`);
    for (const problem of [...new Set(problems)]) log(`  - ${problem}`);
    continue;
  }

  const account = accountAlias(source);
  const receipts = [];
  for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    if (day.tokens <= 0) continue;
    const receipt = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      date: day.date,
      timezone: TIMEZONE,
      source,
      tokens: day.tokens,
      calls: day.calls,
      fidelity: "exact",
      provider: "mixed",
      surface: "vscode_extension",
      account_alias: account,
      machine_alias: receiptMachine,
      origin: ORIGIN,
      interval: { start: day.date, end: day.date },
      snapshot_key: `${source}:${account}:${receiptMachine}:${day.date}`,
      authority: "tool",
      models: [...day.models].sort(),
      correlation_keys: [...day.correlationKeys].sort(),
      provenance:
        `${label} task counters; cache_read ${day.cacheRead} excluded; cache_write ${day.cacheWrite} included; ` +
        `token conventions ${[...day.conventions].sort().join(",")}` +
        (day.tieBroken ? `; ${day.tieBroken} of ${day.calls} records tie-broken as ${conventionFor(source)}` : "")
    };
    const errors = validateReceiptSchema(receipt, `${source} ${day.date}`);
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(2);
    }
    receipts.push(receipt);
  }
  const summary =
    `${counts.requests} requests; ${counts.legacy} legacy, ${counts.inclusive} inclusive, ${counts.noCache} no-cache; ` +
    `${counts.decided} decided by counters, ${counts.tieBroken} tie-broken`;
  if (!receipts.length) {
    log(`${source}: no usage found (${summary}); nothing written.`);
    continue;
  }
  const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
  if (dryRun) output.push(jsonl);
  else await atomicWriteText(outputPath, jsonl);
  log(`${source}: ${dryRun ? "" : `wrote `}${receipts.length} daily receipt(s)${dryRun ? " (dry run)" : ` to ${outputPath}`} (${summary}).`);
}

if (dryRun) process.stdout.write(output.join(""));
if (anyUnknown) {
  console.error("");
  console.error("WARNING: at least one source could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
}
