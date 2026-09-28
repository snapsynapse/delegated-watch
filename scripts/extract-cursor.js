// Extract per-day token usage from Cursor's chat and agent history. Read-only
// against the database.
//
// Cursor keeps its history in User/globalStorage/state.vscdb under its data
// directory: ~/Library/Application Support/Cursor on macOS, %APPDATA%\Cursor on
// Windows, and ${XDG_CONFIG_HOME:-~/.config}/Cursor on Linux. Each message is
// a row in the cursorDiskKV table keyed bubbleId:<composer>:<bubble>, whose
// JSON value carries tokenCount {inputTokens, outputTokens} and createdAt.
// Cursor fills tokenCount from its own server; whether inputTokens includes
// cached context is not visible in the client, so the counts are recorded as
// Cursor reports them, with tool authority. A message whose counts are both
// zero carries no evidence and is skipped. The storage format is taken from
// Cursor 3.17.21 on macOS, whose history on the author's machine holds no
// messages; the Windows and Linux locations are unverified.
//
// Usage:
//   node scripts/extract-cursor.js [--db PATH] [--since YYYY-MM-DD]
//     [--tag ORIGIN] [--dry-run]
//
// Output: scratch/receipts/cursor-<origin>.jsonl, overwritten on each run. A
// database that cannot be read, or a message that does not parse, leaves the
// previous file untouched.
//
// Exit status: 0 read or not found; 3 unknown; 64 usage; 66 an explicit --db
// that does not exist.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const SOURCE = "cursor";
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
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Cursor");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Cursor");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Cursor");
};
const dbPath = explicitDb ?? join(dataDir(), "User", "globalStorage", "state.vscdb");

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(flag("--tag"));
const receiptMachine = flag("--tag") ?? (await profile()).machine_alias ?? machineAlias();
const OUTPUT = `scratch/receipts/${SOURCE}-${ORIGIN.replace(/\//g, "_")}.jsonl`;

const unknown = (reasons) => {
  log(`${SOURCE}: not written; ${OUTPUT} is unchanged. Usage is UNKNOWN, not zero:`);
  for (const reason of [...new Set(reasons)]) log(`  - ${reason}`);
  console.error("");
  console.error("WARNING: Cursor usage could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
};

log("Stores:");
try {
  await access(dbPath);
} catch (error) {
  if (error.code === "ENOENT") {
    if (explicitDb) {
      console.error(`No Cursor database at ${explicitDb}.`);
      process.exit(66);
    }
    log(`  ${SOURCE} ${dbPath}: not found`);
    log(`${SOURCE}: nothing written.`);
    process.exit(0);
  }
  log(`  ${SOURCE} ${dbPath}: UNREADABLE (${error.code})`);
  unknown([`the database could not be read (${error.code})`]);
}

let rows;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cursorDiskKV'").get();
    rows = hasTable
      ? db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all()
      : [];
  } finally {
    db.close();
  }
} catch (error) {
  log(`  ${SOURCE} ${dbPath}: UNREADABLE`);
  unknown([`the database could not be read (${error.code ?? error.message})`]);
}

const counter = (value) => (value === undefined || value === null ? 0 : Number.isSafeInteger(value) && value >= 0 ? value : null);
const problems = [];
const messages = [];
for (const row of rows) {
  let bubble;
  try {
    bubble = JSON.parse(typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8"));
  } catch {
    problems.push("a message could not be parsed");
    continue;
  }
  const input = counter(bubble?.tokenCount?.inputTokens);
  const output = counter(bubble?.tokenCount?.outputTokens);
  if (input === null || output === null) {
    problems.push("a message has invalid token counters");
    continue;
  }
  if (!input && !output) continue;
  if (!bubble.createdAt || Number.isNaN(Date.parse(bubble.createdAt))) {
    problems.push("a message with token counts has no creation time");
    continue;
  }
  messages.push({
    createdAt: new Date(Date.parse(bubble.createdAt)).toISOString(),
    tokens: input + output,
    model: typeof bubble.modelInfo?.modelName === "string" ? bubble.modelInfo.modelName : null,
    key: hashCorrelationKey(`${SOURCE}:${row.key}`)
  });
}

log(`  ${SOURCE} ${dbPath}: read, ${rows.length} message(s), ${messages.length} with token counts`);
if (problems.length) unknown(problems);

const days = new Map();
for (const message of messages) {
  const date = await dayOf(message.createdAt);
  if (since && date < since) continue;
  const day = days.get(date) ?? { date, tokens: 0, calls: 0, models: new Set(), keys: new Set() };
  day.tokens += message.tokens;
  day.calls += 1;
  if (message.model) day.models.add(message.model);
  day.keys.add(message.key);
  days.set(date, day);
}

const account = accountAlias(SOURCE);
const receipts = [];
for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: day.date,
    timezone: TIMEZONE,
    source: SOURCE,
    tokens: day.tokens,
    calls: day.calls,
    fidelity: "exact",
    provider: "mixed",
    surface: "cursor_chat",
    account_alias: account,
    machine_alias: receiptMachine,
    origin: ORIGIN,
    interval: { start: day.date, end: day.date },
    snapshot_key: `${SOURCE}:${account}:${receiptMachine}:${day.date}`,
    authority: "tool",
    models: [...day.models].sort(),
    correlation_keys: [...day.keys].sort(),
    provenance: "Cursor message tokenCount as Cursor reports it; whether input includes cached context is unverified"
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
