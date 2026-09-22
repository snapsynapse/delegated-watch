// Deterministic importer: merge receipt JSONL from scratch/receipts/ into
// public/data/daily-burn.json.
//
// Receipt line shape:
//   {"date":"2026-07-25","timezone":TIMEZONE,"source":"qwen_local",
//    "tokens":52149,"calls":3,"fidelity":"exact","provenance":"goose usage_ledger"}
//
// Rules:
// - Receipts are aggregated by date + source across all input files
//   (tokens and calls sum; fidelity downgrades to estimated if any
//   contributing receipt is estimated).
// - Imported entries replace same-source entries on existing rows.
//   Sample rows lose their sample sources entirely when any real data
//   arrives for that day.
// - New dates get driver "unreviewed" and an import evidence note; review
//   and relabel before deploying.
// - Receipts for the in-progress day are held back. A day is only imported
//   once it has fully elapsed in TIMEZONE, so a row always describes a whole
//   day rather than however much of it had happened when the import ran.
// - Totals are recomputed; output stays sorted by date.
//
// Usage:
//   node scripts/import-daily-burn.js [--dry-run] [file.jsonl ...]
//   (no file args: reads every scratch/receipts/*.jsonl plus receipts/*.jsonl,
//    the gitignored inbox where receipt files synced from other machines land)

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  reconcileReceipts,
  validateReceiptSchema
} from "./lib/receipt-schema.js";
import {
  applySourceEntryExclusions,
  loadSourceEntryExclusions
} from "./lib/source-entry-exclusions.js";
import {
  assertSettledEntriesIntact,
  loadSettledSourceEntries,
  partitionSettledReceipts
} from "./lib/settled-source-entries.js";

import { assertDataset } from "./lib/dataset-validation.js";
import { acceptDataset, assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
import { assertHistoricalPreservation, importArguments, partitionCompleteReceipts } from "./lib/import-policy.js";

const DATA_FILE = "public/data/daily-burn.json";
const RECEIPT_DIRS = ["scratch/receipts", "receipts"];
const { timezone, windowStart } = await import("./lib/profile.js");
const TIMEZONE = await timezone();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const { correction, files: inputFiles } = importArguments(args);
let files = inputFiles;
await assertNoPendingAcceptance();

if (!files.length) {
  for (const dir of RECEIPT_DIRS) {
    try {
      files.push(
        ...(await readdir(dir))
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map((name) => join(dir, name))
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
if (!files.length) {
  console.error(`No receipt files found. Pass paths or add JSONL under ${RECEIPT_DIRS.join("/ or ")}/.`);
  process.exit(1);
}

const errors = [];
let receipts = [];
for (const file of files) {
  // honesty-jsonl-ok: every parse error is collected and fails the import.
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      errors.push(`${where} is not valid JSON`);
      return;
    }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) { errors.push(`${where} must be a receipt object`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receipt.date ?? "")) errors.push(`${where} has invalid date`);
    if (receipt.timezone !== TIMEZONE) errors.push(`${where} timezone must be ${TIMEZONE}`);
    if (!/^[a-z0-9_]+$/.test(receipt.source ?? "")) errors.push(`${where} source must be lowercase snake_case`);
    if (!Number.isSafeInteger(receipt.tokens) || receipt.tokens < 0) errors.push(`${where} tokens must be a nonnegative integer`);
    if (!["exact", "estimated"].includes(receipt.fidelity)) errors.push(`${where} fidelity must be exact or estimated`);
    if ("origin" in receipt && !/^[a-z0-9][a-z0-9._/-]*$/.test(receipt.origin)) errors.push(`${where} origin must be lowercase alphanumeric with . _ - / separators`);
    if ("calls" in receipt && (!Number.isSafeInteger(receipt.calls) || receipt.calls < 0)) errors.push(`${where} calls must be a nonnegative integer`);
    errors.push(...validateReceiptSchema(receipt, where));
    receipts.push({ ...receipt, _where: where });
  });
}
const reconciliation = reconcileReceipts(receipts);
errors.push(...reconciliation.errors);
receipts = reconciliation.receipts;

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const complete = partitionCompleteReceipts(receipts, TIMEZONE, await windowStart());
const { heldBack } = complete;
receipts = complete.receipts;

const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
const beforeRows = structuredClone(rows);
const settled = await loadSettledSourceEntries();
assertSettledEntriesIntact(beforeRows, settled, { label: "committed dataset" });
const settledSplit = partitionSettledReceipts(receipts, settled, beforeRows);
receipts = settledSplit.kept;

// Aggregate by date + source.
const buckets = new Map();
for (const receipt of receipts) {
  const key = `${receipt.date} ${receipt.source}`;
  const bucket = buckets.get(key) ?? {
    date: receipt.date,
    source: receipt.source,
    tokens: 0,
    calls: 0,
    hasCalls: false,
    fidelity: "exact",
    drivers: new Set(),
    // Which (machine, profile) or account each token came from. Kept alongside
    // the sum so a day worked on several machines can still be broken down.
    byOrigin: new Map()
  };
  bucket.tokens += receipt.tokens;
  if (receipt.origin) {
    bucket.byOrigin.set(receipt.origin, (bucket.byOrigin.get(receipt.origin) ?? 0) + receipt.tokens);
  }
  if ("calls" in receipt) {
    bucket.calls += receipt.calls;
    bucket.hasCalls = true;
  }
  if (receipt.fidelity === "estimated") bucket.fidelity = "estimated";
  if (receipt.driver) bucket.drivers.add(receipt.driver);
  buckets.set(key, bucket);
}

const rowsByDate = new Map(rows.map((row) => [row.date, row]));

let updatedSources = 0;
const touchedDates = new Set();
for (const bucket of buckets.values()) {
  let row = rowsByDate.get(bucket.date);
  if (!row) {
    row = {
      date: bucket.date,
      timezone: TIMEZONE,
      sources: {},
      total: 0,
      driver: [...bucket.drivers][0] ?? "unreviewed",
      evidence: "imported from local receipts; pending review"
    };
    rowsByDate.set(bucket.date, row);
  } else if (!touchedDates.has(bucket.date)) {
    // Real data supersedes sample placeholders for the whole day.
    for (const [source, entry] of Object.entries(row.sources)) {
      if (entry.fidelity === "sample") delete row.sources[source];
    }
  }
  touchedDates.add(bucket.date);
  const entry = { tokens: bucket.tokens, fidelity: bucket.fidelity };
  if (bucket.hasCalls) entry.calls = bucket.calls;
  // Always recorded once origin is known, so the dataset is self-describing and
  // the dashboard can attribute a day without re-reading receipts. An empty map
  // means the receipts predate origin tagging.
  if (bucket.byOrigin.size > 0) {
    entry.by_origin = Object.fromEntries([...bucket.byOrigin.entries()].sort());
  }
  row.sources[bucket.source] = entry;
  updatedSources += 1;
}

const mergedBeforeExclusions = [...rowsByDate.values()].sort((a, b) =>
  a.date.localeCompare(b.date)
);
for (const row of mergedBeforeExclusions) {
  row.total = Object.values(row.sources).reduce((sum, entry) => sum + entry.tokens, 0);
}
const exclusions = await loadSourceEntryExclusions();
const { rows: merged, removed: excludedSources } =
  applySourceEntryExclusions(mergedBeforeExclusions, exclusions);
assertHistoricalPreservation(beforeRows, merged, { excludedSources, correction });
// Postcondition, not just a precondition: nothing may leave this run having
// altered a settled entry, whatever route it took through the merge.
assertSettledEntriesIntact(merged, settled, { label: "merged dataset" });
assertDataset(merged, { timezone: TIMEZONE, windowStart: await windowStart(), today: complete.today });
const correctedByDate = new Map(merged.map((row) => [row.date, row]));

if (heldBack.length) {
  const days = [...new Set(heldBack.map((receipt) => receipt.date))].sort();
  console.log(
    `Held back ${heldBack.length} receipt(s) for ${days.join(", ")}: not yet a complete day in ${TIMEZONE}.`
  );
}

if (settledSplit.dropped.length) {
  const pairs = [...new Set(settledSplit.dropped.map((receipt) => `${receipt.date}/${receipt.source}`))].sort();
  console.log(
    `Dropped ${settledSplit.dropped.length} receipt(s) for settled entries: ${pairs.join(", ")}. ` +
      "Their committed figures are the last complete measurement; see config/settled-source-entries.json."
  );
}

if (dryRun) {
  await acceptDataset({ beforeRows, rows: merged, receipts: receipts, excludedSources, correction, dryRun: true });
  for (const date of [...touchedDates].sort()) {
    const row = correctedByDate.get(date);
    if (!row) {
      console.log(`${date}: row removed because no retained sources remain`);
      continue;
    }
    console.log(`${date}: total ${row.total} across ${Object.keys(row.sources).length} sources (${row.driver})`);
  }
  console.log(`Dry run: would update ${updatedSources} source entries across ${touchedDates.size} days.`);
  console.log(`Dry run: would exclude ${excludedSources.length} corrected source entries.`);
} else {
  await acceptDataset({ beforeRows, rows: merged, receipts, excludedSources, correction });
  console.log(`Merged ${updatedSources} source entries across ${touchedDates.size} days into ${DATA_FILE}.`);
  console.log(`Excluded ${excludedSources.length} corrected source entries.`);
  console.log("Run npm run validate before committing.");
}
