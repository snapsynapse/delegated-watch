// Reconcile Anthropic Admin Usage API figures against transcript-derived
// Claude usage, and recommend whether the two are additive or overlapping.
//
// This is the only oracle in the project: every other source is self-reported
// by the same logs it is derived from, so nothing else can catch a systematic
// extraction error. The Admin Usage API is Anthropic's own accounting, so where
// the two describe the same traffic they must agree.
//
// The script never writes dashboard data and never records the decision for
// you. It reports evidence; a human records the verdict in
// config/claude-reconciliation.json.
//
// Usage:
//   ANTHROPIC_ADMIN_KEY=... npm run extract:claude-api   (fetch first)
//   npm run reconcile:claude

import { readFile } from "node:fs/promises";

const DATA_FILE = "public/data/daily-burn.json";
const CONFIG = "config/claude-reconciliation.json";
const CANDIDATES = ["scratch/reconcile/claude-api.jsonl", "scratch/receipts/claude-api.jsonl"];
const TRANSCRIPT_SOURCES = ["claude_code", "claude_cowork"];
// Days this close in magnitude are treated as describing the same traffic.
const SAME_TRAFFIC_TOLERANCE = 0.15;

const config = JSON.parse(await readFile(CONFIG, "utf8"));

let apiReceipts = null;
let usedFile = null;
for (const file of CANDIDATES) {
  // honesty-jsonl-ok: parse errors reach the catch below and fail closed.
  try {
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
    apiReceipts = lines.map((line) => JSON.parse(line));
    usedFile = file;
    break;
  } catch (error) {
    // A missing candidate is expected; anything else means the file is there
    // but unusable, which must not be mistaken for "no receipts exist".
    if (error.code === "ENOENT") continue;
    console.error(`Found ${file} but could not read it: ${error.message}`);
    console.error("Refusing to report 'no receipts' when a receipt file exists but is unreadable.");
    process.exit(1);
  }
}

if (!apiReceipts?.length) {
  console.log("No claude_api receipts found.");
  console.log("");
  console.log("To produce them, set an Anthropic Console admin key in your own shell");
  console.log("(never commit it, and do not paste it into a chat), then extract:");
  console.log("");
  console.log("  export ANTHROPIC_ADMIN_KEY=...        # from console.anthropic.com");
  console.log("  npm run extract:claude-api");
  console.log("  npm run reconcile:claude");
  console.log("");
  console.log(`Current reconciliation mode: ${config.mode}`);
  process.exit(0);
}

const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
const transcriptByDate = new Map(
  rows.map((row) => [
    row.date,
    TRANSCRIPT_SOURCES.reduce((sum, source) => sum + (row.sources[source]?.tokens ?? 0), 0)
  ])
);
const apiByDate = new Map();
for (const receipt of apiReceipts) {
  apiByDate.set(receipt.date, (apiByDate.get(receipt.date) ?? 0) + receipt.tokens);
}

const dates = [...new Set([...apiByDate.keys(), ...transcriptByDate.keys()])].sort();
const both = [];
const apiOnly = [];
const transcriptOnly = [];
for (const date of dates) {
  const api = apiByDate.get(date) ?? 0;
  const transcript = transcriptByDate.get(date) ?? 0;
  if (api && transcript) both.push({ date, api, transcript });
  else if (api) apiOnly.push({ date, api });
  else if (transcript) transcriptOnly.push({ date, transcript });
}

const fmt = (n) => n.toLocaleString();
console.log(`Reconciling ${usedFile} against ${TRANSCRIPT_SOURCES.join(" + ")} in ${DATA_FILE}`);
console.log(`Recorded mode: ${config.mode}`);
console.log("");
console.log(`days with API usage only:        ${apiOnly.length}`);
console.log(`days with transcript usage only: ${transcriptOnly.length}`);
console.log(`days with both:                  ${both.length}`);
console.log("");

if (both.length) {
  console.log("date         api tokens    transcript tokens   ratio");
  for (const { date, api, transcript } of both.slice(0, 20)) {
    console.log(
      `${date}  ${fmt(api).padStart(12)}  ${fmt(transcript).padStart(18)}   ${(api / transcript).toFixed(3)}`
    );
  }
  if (both.length > 20) console.log(`... and ${both.length - 20} more`);
  console.log("");
}

// A day where the two figures nearly match is the signature of one stream of
// traffic described twice; wildly different magnitudes on the same day are
// consistent with genuinely separate work that happened to occur together.
const close = both.filter(
  ({ api, transcript }) => Math.abs(api - transcript) / Math.max(api, transcript) <= SAME_TRAFFIC_TOLERANCE
);

let verdict;
let reasoning;
if (!both.length) {
  verdict = "additive";
  reasoning = "No day carries both API and transcript usage, so the two describe disjoint traffic.";
} else if (close.length >= Math.ceil(both.length * 0.6)) {
  verdict = "overlapping";
  reasoning = `${close.length} of ${both.length} shared days agree within ${SAME_TRAFFIC_TOLERANCE * 100}%, which is the signature of the same requests counted twice.`;
} else {
  verdict = "additive";
  reasoning = `Only ${close.length} of ${both.length} shared days are close in magnitude; the figures look like separate traffic that overlaps in time.`;
}

console.log(`Suggested verdict: ${verdict}`);
console.log(reasoning);
console.log("");
console.log("This is a suggestion from magnitudes alone. Confirm it against how you");
console.log("actually use the account before recording it. A key used by an SDK script");
console.log("or MCP server is additive; a key routed through Claude Code is overlapping.");
console.log("");
console.log(`Record the decision by setting "mode" in ${CONFIG} to "${verdict}",`);
console.log('with "decided_on" and a one-line "evidence" note. Until then the receipts');
console.log("stay quarantined and are excluded from every total.");
