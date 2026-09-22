import { assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
await assertNoPendingAcceptance();

// Export the dataset as CSV, for pivoting outside the dashboard and as a second
// serialization of the only durable copy of this record.
//
// Two complementary views:
// - public/data/daily-burn.csv         one row per day; totals and labels
// - public/data/daily-burn-detail.csv  one row per (day, source, origin);
//                                      preserves token/source/origin totals
//
// The detail file is the one to trust for arithmetic. The wide file drops the
// per-source split, so its totals are correct and its breakdown is absent --
// which is the honest way to flatten a nested structure, rather than picking a
// dominant source and implying it was the only one.
//
// Usage:
//   node scripts/export-csv.js [--dry-run | --check]

import { readFile, writeFile } from "node:fs/promises";
import { assertDataset } from "./lib/dataset-validation.js";
import { profile } from "./lib/profile.js";
import { calendarDay } from "./lib/import-policy.js";

const DATA_FILE = "public/data/daily-burn.json";
const WIDE_FILE = "public/data/daily-burn.csv";
const DETAIL_FILE = "public/data/daily-burn-detail.csv";
const dryRun = process.argv.includes("--dry-run");
const check = process.argv.includes("--check");

// RFC 4180: quote anything containing a comma, quote or newline, and double any
// embedded quote. Evidence strings carry commas routinely.
const cell = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const row = (values) => values.map(cell).join(",");

const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
const config = await profile();
assertDataset(rows, { timezone: config.timezone, windowStart: config.window_start, today: calendarDay(config.timezone) });

const wide = [
  row(["date", "timezone", "total_tokens", "driver", "evidence", "sources", "fidelity"])
];
const detail = [
  row([
    "date",
    "timezone",
    "source",
    "origin",
    "tokens",
    "calls",
    "fidelity",
    "day_total_tokens",
    "driver",
    "evidence"
  ])
];

for (const record of rows) {
  const entries = Object.entries(record.sources).sort(([a], [b]) => a.localeCompare(b));
  // A day is exact only if every source on it is. One estimated source makes the
  // day's total a floor, and the wide file has to say so or it overstates.
  const fidelity = entries.every(([, entry]) => entry.fidelity === "exact") ? "exact" : "mixed";
  wide.push(
    row([
      record.date,
      record.timezone,
      record.total,
      record.driver,
      record.evidence,
      entries.map(([source]) => source).join(" "),
      fidelity
    ])
  );

  for (const [source, entry] of entries) {
    const origins = entry.by_origin ? Object.entries(entry.by_origin) : null;
    if (origins?.length) {
      for (const [origin, tokens] of origins.sort(([a], [b]) => a.localeCompare(b))) {
        // `calls` is recorded per source, not per origin, so it cannot be split
        // across origins without inventing a division. It is left blank on all
        // but the single-origin case rather than duplicated onto each row,
        // where summing the column would multiply it.
        detail.push(
          row([
            record.date,
            record.timezone,
            source,
            origin,
            tokens,
            origins.length === 1 ? entry.calls : "",
            entry.fidelity,
            record.total,
            record.driver,
            record.evidence
          ])
        );
      }
      continue;
    }
    detail.push(
      row([
        record.date,
        record.timezone,
        source,
        "",
        entry.tokens,
        entry.calls,
        entry.fidelity,
        record.total,
        record.driver,
        record.evidence
      ])
    );
  }
}

// Cross-foot before writing: the detail file must sum to the same grand total as
// the JSON, or the export is lying in a way a reader cannot see.
const jsonTotal = rows.reduce((sum, record) => sum + record.total, 0);
const detailTotal = detail
  .slice(1)
  .reduce((sum, line) => sum + Number(line.split(",")[4] || 0), 0);
if (jsonTotal !== detailTotal) {
  console.error(
    `Refusing to write: detail rows sum to ${detailTotal}, dataset totals ${jsonTotal}.`
  );
  process.exit(1);
}

const wideText = wide.join("\n") + "\n";
const detailText = detail.join("\n") + "\n";

if (check) {
  // Exact deterministic comparison checks every date/source/origin/label and
  // serialization field, including independently stale wide or detail output.
  for (const [path, expected] of [[WIDE_FILE, wideText], [DETAIL_FILE, detailText]]) {
    let actual;
    try { actual = await readFile(path, "utf8"); }
    catch { throw new Error(`CSV parity failed: ${path} is unavailable`); }
    if (actual !== expected) throw new Error(`CSV parity failed: ${path} differs from canonical input; run npm run export:csv`);
  }
  console.log(`CSV parity verified for ${rows.length} days and ${detail.length - 1} source/origin rows.`);
} else if (dryRun) {
  console.log(wide.slice(0, 4).join("\n"));
  console.log("...");
  console.log(detail.slice(0, 4).join("\n"));
  console.log(
    `\nDry run: ${rows.length} days -> ${wide.length - 1} wide rows, ${detail.length - 1} detail rows, ${jsonTotal.toLocaleString()} tokens.`
  );
} else {
  await writeFile(WIDE_FILE, wideText);
  await writeFile(DETAIL_FILE, detailText);
  console.log(
    `Wrote ${wide.length - 1} rows to ${WIDE_FILE} and ${detail.length - 1} to ${DETAIL_FILE} ` +
      `(${jsonTotal.toLocaleString()} tokens, cross-footed).`
  );
}
