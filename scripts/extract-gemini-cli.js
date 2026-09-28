// Extract exact per-day token usage from Gemini CLI chat sessions, and from
// Qwen Code, which is built on Gemini CLI and records sessions the same way.
// Read-only against every store it reads.
//
// Gemini CLI records each session under <home>/.gemini/tmp/<project>/chats/
// as session-*.jsonl, one record per line, or as session-*.json in older
// versions. A model reply is a record with type "gemini"; once the API's usage
// metadata arrives, the same message id is written again with a tokens object:
//   input    promptTokenCount, which includes cached input
//   output   candidatesTokenCount
//   cached   cachedContentTokenCount
//   thoughts thoughtsTokenCount
//   tool     toolUsePromptTokenCount
// <home> is $GEMINI_CLI_HOME when set, otherwise the user's home directory.
// Verified against Gemini CLI 0.58.0's own recording code. Qwen Code is read
// from ~/.qwen in the same layout, which follows from its origin and has not
// been checked against a Qwen Code install.
//
// Token definition: non-cached input + output + thoughts + tool-use prompt.
// Cached input is excluded from the headline and kept in provenance, per
// invariant 5. Each message counts once, from its latest record carrying tokens.
//
// Usage:
//   node scripts/extract-gemini-cli.js [--source gemini_cli|qwen_code]...
//     [--root DIR] [--since YYYY-MM-DD] [--tag ORIGIN] [--dry-run]
//
// --root reads one store's tmp directory, or a backup of it, and needs exactly
// one --source.
//
// Output: scratch/receipts/<source>-<origin>.jsonl per source, overwritten on
// each run. A source whose store cannot be read, or whose session files do not
// parse, is not written and its previous file is left untouched.
//
// Exit status: 0 read or not found; 3 when any source is unknown; 64 usage;
// 66 an explicit --root that does not exist.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, profile, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const SOURCES = {
  gemini_cli: {
    label: "Gemini CLI",
    provider: "google",
    surface: "gemini_cli_session",
    root: () => join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini", "tmp")
  },
  qwen_code: {
    label: "Qwen Code",
    provider: "mixed",
    surface: "qwen_code_session",
    root: () => join(homedir(), ".qwen", "tmp")
  }
};
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
  if (!SOURCES[source]) {
    console.error(`Unknown --source ${source}. Choose from: ${Object.keys(SOURCES).join(", ")}.`);
    process.exit(64);
  }
}
const selected = requested.length ? [...new Set(requested)] : Object.keys(SOURCES);
const explicitRoot = flag("--root");
if (explicitRoot && selected.length !== 1) {
  console.error("--root reads one store, so it needs exactly one --source.");
  process.exit(64);
}
const since = flag("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
const dryRun = args.includes("--dry-run");
const log = dryRun ? console.error : console.log;

if (explicitRoot) {
  try {
    await readdir(explicitRoot);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`No store at ${explicitRoot}.`);
      process.exit(66);
    }
  }
}

const TIMEZONE = await timezone();
const ORIGIN = await localOrigin(flag("--tag"));
const receiptMachine = flag("--tag") ?? (await profile()).machine_alias ?? machineAlias();
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;

// The records of one session file, in write order, whichever format it uses.
// honesty-jsonl-ok: a line that does not parse throws, and the caller counts
// the whole file as a problem, so the source is unknown rather than smaller.
const sessionRecords = (text, name) => {
  if (name.endsWith(".jsonl")) {
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  const document = JSON.parse(text);
  return Array.isArray(document?.messages)
    ? document.messages.map((message) => ({ ...message, sessionId: document.sessionId }))
    : [];
};

async function extractSource(source) {
  const root = explicitRoot ?? SOURCES[source].root();
  const finding = { root, state: "absent", sessions: 0, problems: [] };
  // Latest tokens record per message, keyed by session and message id.
  const messages = new Map();

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { finding, messages };
    finding.state = "unreadable";
    finding.problems.push(`${root} could not be read (${error.code ?? error})`);
    return { finding, messages };
  }
  finding.state = "read";
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const chats = join(root, project.name, "chats");
    let files;
    try {
      files = await readdir(chats);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      finding.problems.push(`a chats directory could not be read (${error.code ?? error})`);
      continue;
    }
    for (const name of files.filter((file) => /^session-.*\.jsonl?$/.test(file)).sort()) {
      let records;
      try {
        records = sessionRecords(await readFile(join(chats, name), "utf8"), name);
      } catch (error) {
        finding.problems.push(`a session file could not be read or parsed (${error.code ?? "invalid JSON"})`);
        continue;
      }
      finding.sessions += 1;
      let sessionId = name;
      for (const record of records) {
        if (typeof record?.sessionId === "string") sessionId = record.sessionId;
        if (record?.type !== "gemini" || !record.tokens || typeof record.id !== "string") continue;
        const { input = 0, output = 0, cached = 0, thoughts = 0, tool = 0 } = record.tokens;
        if (![input, output, cached, thoughts, tool].every(isCounter) || cached > input || !record.timestamp) {
          finding.problems.push("a message has invalid token counters or no timestamp");
          continue;
        }
        messages.set(`${sessionId}:${record.id}`, {
          timestamp: record.timestamp,
          model: typeof record.model === "string" ? record.model : null,
          tokens: input - cached + output + thoughts + tool,
          cached,
          thoughts,
          correlationKey: hashCorrelationKey(`${source}:${sessionId}:${record.id}`)
        });
      }
    }
  }
  return { finding, messages };
}

let anyUnknown = false;
const output = [];
log("Stores:");
for (const source of selected) {
  const { label, provider, surface } = SOURCES[source];
  const { finding, messages } = await extractSource(source);
  const state = finding.state === "read"
    ? `read, ${finding.sessions} session file(s)`
    : finding.state === "absent" ? "not found" : "UNREADABLE";
  log(`  ${source.padEnd(10)} ${finding.root}: ${state}`);
  const outputPath = `scratch/receipts/${source}-${ORIGIN.replace(/\//g, "_")}.jsonl`;
  if (finding.state === "absent") {
    if (explicitRoot) anyUnknown = true;
    log(`${source}: no ${label} store found; nothing written.`);
    continue;
  }
  if (finding.problems.length) {
    anyUnknown = true;
    log(`${source}: not written; ${outputPath} is unchanged. Usage is UNKNOWN, not zero:`);
    for (const problem of [...new Set(finding.problems)]) log(`  - ${problem}`);
    continue;
  }

  const days = new Map();
  for (const message of messages.values()) {
    const date = await dayOf(message.timestamp);
    if (since && date < since) continue;
    const day = days.get(date) ?? { date, tokens: 0, calls: 0, cached: 0, thoughts: 0, models: new Set(), keys: new Set() };
    day.tokens += message.tokens;
    day.calls += 1;
    day.cached += message.cached;
    day.thoughts += message.thoughts;
    if (message.model) day.models.add(message.model);
    day.keys.add(message.correlationKey);
    days.set(date, day);
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
      provider,
      surface,
      account_alias: account,
      machine_alias: receiptMachine,
      origin: ORIGIN,
      interval: { start: day.date, end: day.date },
      snapshot_key: `${source}:${account}:${receiptMachine}:${day.date}`,
      authority: "tool",
      models: [...day.models].sort(),
      correlation_keys: [...day.keys].sort(),
      provenance: `${label} session tokens; cached ${day.cached} excluded; thoughts ${day.thoughts} included`
    };
    const errors = validateReceiptSchema(receipt, `${source} ${day.date}`);
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(2);
    }
    receipts.push(receipt);
  }
  if (!receipts.length) {
    log(`${source}: no usage found (${messages.size} model replies with tokens); nothing written.`);
    continue;
  }
  const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
  if (dryRun) output.push(jsonl);
  else await atomicWriteText(outputPath, jsonl);
  log(`${source}: ${receipts.length} daily receipt(s)${dryRun ? " (dry run)" : ` written to ${outputPath}`}.`);
}

if (dryRun) process.stdout.write(output.join(""));
if (anyUnknown) {
  console.error("");
  console.error("WARNING: at least one source could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
}
