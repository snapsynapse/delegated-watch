// Extract exact per-day token usage from Zed's agent threads. Read-only
// against the database.
//
// Zed keeps agent threads in threads/threads.db under its data directory:
// ~/Library/Application Support/Zed on macOS, %LOCALAPPDATA%\Zed on Windows,
// and ${XDG_DATA_HOME:-~/.local/share}/zed on Linux. Each row's data column
// is the thread as JSON, compressed with zstd when data_type is "zstd". The
// thread carries cumulative_token_usage in Anthropic's shape:
//   input_tokens, output_tokens, cache_creation_input_tokens,
//   cache_read_input_tokens
// and the model it used. The format is taken from the field names in Zed
// 1.20.2 on macOS, whose thread database was empty on the author's machine;
// the Windows and Linux locations follow Zed's platform conventions and have
// not been checked.
//
// A thread records no per-request times, only when it was created and last
// updated, so each thread is dated by the day it was created. That date never
// moves: continuing a thread later adds to its creation day rather than moving
// its whole total to a newer day.
//
// Token definition: input + cache creation + output. Cache reads are excluded
// from the headline and kept in provenance, per invariant 5.
//
// The database is opened read-only through Node's built-in SQLite and the
// threads decompressed with Node's built-in zstd, so nothing beyond Node is
// needed.
//
// Usage:
//   node scripts/extract-zed-agent.js [--db PATH] [--since YYYY-MM-DD]
//     [--tag ORIGIN] [--dry-run]
//
// Output: scratch/receipts/zed_agent-<origin>.jsonl, overwritten on each run.
// A database that cannot be read, or a thread that does not decode, leaves the
// previous file untouched.
//
// Exit status: 0 read or not found; 3 unknown; 64 usage; 66 an explicit --db
// that does not exist.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const SOURCE = "zed_agent";
const EXIT_UNKNOWN = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const explicitDb = flag("--db");
const since = flag("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
const dryRun = args.includes("--dry-run");
const log = dryRun ? console.error : console.log;

const dataDir = () => {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Zed");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Zed");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "zed");
};
const dbPath = explicitDb ?? join(dataDir(), "threads", "threads.db");

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(flag("--tag"));
const receiptMachine = flag("--tag") ?? (await profile()).machine_alias ?? machineAlias();
const OUTPUT = `scratch/receipts/${SOURCE}-${ORIGIN.replace(/\//g, "_")}.jsonl`;

const unknown = (reasons) => {
  log(`${SOURCE}: not written; ${OUTPUT} is unchanged. Usage is UNKNOWN, not zero:`);
  for (const reason of [...new Set(reasons)]) log(`  - ${reason}`);
  console.error("");
  console.error("WARNING: Zed agent usage could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
};

log("Stores:");
try {
  await access(dbPath);
} catch (error) {
  if (error.code === "ENOENT") {
    if (explicitDb) {
      console.error(`No Zed thread database at ${explicitDb}.`);
      process.exit(66);
    }
    log(`  ${SOURCE} ${dbPath}: not found`);
    log(`${SOURCE}: nothing written.`);
    process.exit(0);
  }
  log(`  ${SOURCE} ${dbPath}: UNREADABLE (${error.code})`);
  unknown([`the thread database could not be read (${error.code})`]);
}

let rows;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    rows = db.prepare("SELECT id, created_at, updated_at, data_type, data FROM threads").all();
  } finally {
    db.close();
  }
} catch (error) {
  log(`  ${SOURCE} ${dbPath}: UNREADABLE`);
  unknown([`the thread database could not be read (${error.code ?? error.message})`]);
}

const counter = (value) => (value === undefined || value === null ? 0 : Number.isSafeInteger(value) && value >= 0 ? value : null);
const problems = [];
const threads = [];
for (const row of rows) {
  let thread;
  try {
    const bytes = Buffer.from(row.data);
    const text = row.data_type === "zstd" ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
    thread = JSON.parse(text);
  } catch {
    problems.push(`a thread could not be decoded (data_type ${row.data_type})`);
    continue;
  }
  const usage = thread?.cumulative_token_usage;
  if (!usage) continue;
  const input = counter(usage.input_tokens);
  const output = counter(usage.output_tokens);
  const cacheWrite = counter(usage.cache_creation_input_tokens);
  const cacheRead = counter(usage.cache_read_input_tokens);
  const created = row.created_at ?? row.updated_at;
  if ([input, output, cacheWrite, cacheRead].includes(null) || !created || Number.isNaN(Date.parse(created))) {
    problems.push("a thread has invalid token counters or no creation time");
    continue;
  }
  threads.push({
    created,
    model: typeof thread.model?.model === "string" ? thread.model.model : null,
    tokens: input + cacheWrite + output,
    cacheRead,
    calls: thread.request_token_usage && typeof thread.request_token_usage === "object"
      ? Object.keys(thread.request_token_usage).length
      : 0,
    key: hashCorrelationKey(`${SOURCE}:${row.id}`)
  });
}

log(`  ${SOURCE} ${dbPath}: read, ${rows.length} thread(s)`);
if (problems.length) unknown(problems);

const days = new Map();
for (const thread of threads) {
  const date = await dayOf(new Date(Date.parse(thread.created)).toISOString());
  if (since && date < since) continue;
  const day = days.get(date) ?? { date, tokens: 0, calls: 0, cacheRead: 0, models: new Set(), keys: new Set() };
  day.tokens += thread.tokens;
  day.calls += thread.calls;
  day.cacheRead += thread.cacheRead;
  if (thread.model) day.models.add(thread.model);
  day.keys.add(thread.key);
  days.set(date, day);
}

const account = accountAlias(SOURCE);
const receipts = [];
for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
  if (day.tokens <= 0) continue;
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: day.date,
    timezone: TIMEZONE,
    source: SOURCE,
    tokens: day.tokens,
    calls: day.calls,
    fidelity: "exact",
    provider: "mixed",
    surface: "zed_agent_thread",
    account_alias: account,
    machine_alias: receiptMachine,
    origin: ORIGIN,
    interval: { start: day.date, end: day.date },
    snapshot_key: `${SOURCE}:${account}:${receiptMachine}:${day.date}`,
    authority: "tool",
    models: [...day.models].sort(),
    correlation_keys: [...day.keys].sort(),
    provenance: `Zed agent thread totals, dated by thread creation; cache_read ${day.cacheRead} excluded`
  };
  const errors = validateReceiptSchema(receipt, `${SOURCE} ${day.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  receipts.push(receipt);
}

if (!receipts.length) {
  log(`${SOURCE}: no usage found; nothing written.`);
  process.exit(0);
}
const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) process.stdout.write(jsonl);
else await atomicWriteText(OUTPUT, jsonl);
log(`${SOURCE}: ${receipts.length} daily receipt(s)${dryRun ? " (dry run)" : ` written to ${OUTPUT}`}.`);
