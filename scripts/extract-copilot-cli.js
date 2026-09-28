// Extract exact per-day token usage from GitHub Copilot CLI session state.
// Read-only against every store it reads.
//
// Copilot CLI keeps one append-only events.jsonl per session under
// <home>/session-state/<session>/, where <home> is $COPILOT_HOME, otherwise
// ~/.copilot. Per-call usage events are ephemeral and never written; what
// survives is the session.shutdown event, whose modelMetrics carry the
// session's totals per model:
//   requests.count, usage.inputTokens, usage.outputTokens,
//   usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens
// A resumed session restores those totals and keeps adding to them, so each
// shutdown is cumulative for its session. Each shutdown contributes only its
// increase over the previous one, dated by the shutdown; a total that falls is
// treated as a fresh start. Usage in a session that has not shut down yet is
// not written anywhere, and appears once it does.
//
// Verified against the @github/copilot 1.0.73 SDK that ships with VS Code:
// inputTokens is the provider's prompt_tokens, which includes cached input,
// and reasoning is already inside outputTokens. Copilot Chat inside VS Code
// keeps no token counts on disk and is not recoverable here.
//
// Token definition: input - cache read + output. Cache reads are excluded from
// the headline and kept in provenance, per invariant 5.
//
// Usage:
//   node scripts/extract-copilot-cli.js [--root DIR] [--since YYYY-MM-DD]
//     [--tag ORIGIN] [--dry-run]
//
// --root reads one session-state directory, or a backup of it.
//
// Output: scratch/receipts/copilot_cli-<origin>.jsonl, overwritten on each run.
// A store that cannot be read, or an events file that does not parse, leaves
// the previous file untouched.
//
// Exit status: 0 read or not found; 3 unknown; 64 usage; 66 an explicit --root
// that does not exist.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const SOURCE = "copilot_cli";
const EXIT_UNKNOWN = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const explicitRoot = flag("--root");
const since = flag("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
const dryRun = args.includes("--dry-run");
const log = dryRun ? console.error : console.log;
const root = explicitRoot ?? join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state");

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(flag("--tag"));
const receiptMachine = flag("--tag") ?? (await profile()).machine_alias ?? machineAlias();
const OUTPUT = `scratch/receipts/${SOURCE}-${ORIGIN.replace(/\//g, "_")}.jsonl`;

const unknown = (reasons) => {
  log(`${SOURCE}: not written; ${OUTPUT} is unchanged. Usage is UNKNOWN, not zero:`);
  for (const reason of [...new Set(reasons)]) log(`  - ${reason}`);
  console.error("");
  console.error("WARNING: Copilot CLI usage could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
};

log("Stores:");
let sessions;
try {
  sessions = await readdir(root, { withFileTypes: true });
} catch (error) {
  if (error.code === "ENOENT") {
    if (explicitRoot) {
      console.error(`No session-state directory at ${explicitRoot}.`);
      process.exit(66);
    }
    log(`  ${SOURCE} ${root}: not found`);
    log(`${SOURCE}: nothing written.`);
    process.exit(0);
  }
  log(`  ${SOURCE} ${root}: UNREADABLE (${error.code})`);
  unknown([`${root} could not be read (${error.code})`]);
}

const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const problems = [];
const increments = [];
let sessionCount = 0;
let shutdownCount = 0;

for (const session of sessions.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  let text;
  try {
    text = await readFile(join(root, session.name, "events.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    problems.push(`a session's events.jsonl could not be read (${error.code})`);
    continue;
  }
  // honesty-jsonl-ok: an unparseable line is counted as a problem below, and
  // any problem holds the whole source back rather than writing a smaller total.
  let events;
  try {
    events = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    problems.push("a session's events.jsonl has a line that is not valid JSON");
    continue;
  }
  sessionCount += 1;
  const previous = new Map();
  for (const event of events) {
    if (event?.type !== "session.shutdown" || event.ephemeral) continue;
    const metrics = event.data?.modelMetrics;
    if (!metrics || typeof metrics !== "object" || !event.timestamp) {
      problems.push("a session.shutdown event has no model metrics or timestamp");
      continue;
    }
    shutdownCount += 1;
    for (const [model, entry] of Object.entries(metrics)) {
      const usage = entry?.usage ?? {};
      const now = {
        input: counter(usage.inputTokens),
        output: counter(usage.outputTokens),
        cacheRead: counter(usage.cacheReadTokens ?? 0),
        requests: counter(entry?.requests?.count ?? 0)
      };
      if (Object.values(now).some((value) => value === null) || now.cacheRead > now.input) {
        problems.push("a model's session totals are not valid counters");
        continue;
      }
      const before = previous.get(model);
      const fresh = !before || Object.keys(now).some((key) => now[key] < before[key]);
      const base = fresh ? { input: 0, output: 0, cacheRead: 0, requests: 0 } : before;
      previous.set(model, now);
      const delta = {
        input: now.input - base.input,
        output: now.output - base.output,
        cacheRead: now.cacheRead - base.cacheRead,
        requests: now.requests - base.requests
      };
      if (!delta.input && !delta.output) continue;
      increments.push({
        timestamp: event.timestamp,
        model,
        tokens: delta.input - delta.cacheRead + delta.output,
        cacheRead: delta.cacheRead,
        calls: delta.requests,
        key: hashCorrelationKey(`${SOURCE}:${session.name}:${event.id ?? event.timestamp}:${model}`)
      });
    }
  }
}

log(`  ${SOURCE} ${root}: read, ${sessionCount} session(s), ${shutdownCount} shutdown record(s)`);
if (problems.length) unknown(problems);

const days = new Map();
for (const increment of increments) {
  const date = await dayOf(increment.timestamp);
  if (since && date < since) continue;
  const day = days.get(date) ?? { date, tokens: 0, calls: 0, cacheRead: 0, models: new Set(), keys: new Set() };
  day.tokens += increment.tokens;
  day.calls += increment.calls;
  day.cacheRead += increment.cacheRead;
  day.models.add(increment.model);
  day.keys.add(increment.key);
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
    provider: "github",
    surface: "copilot_cli_session",
    account_alias: account,
    machine_alias: receiptMachine,
    origin: ORIGIN,
    interval: { start: day.date, end: day.date },
    snapshot_key: `${SOURCE}:${account}:${receiptMachine}:${day.date}`,
    authority: "tool",
    models: [...day.models].sort(),
    correlation_keys: [...day.keys].sort(),
    provenance: `Copilot CLI session totals, increase per shutdown, dated by session end; cache_read ${day.cacheRead} excluded`
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
