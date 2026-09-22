import { assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
await assertNoPendingAcceptance();

// Dataset invariants. Where validate-data.js checks that a row is well-formed,
// this asserts properties of the dataset as a whole -- the failure modes that
// token accounting actually hits: silent zeros standing in for unknowns,
// placeholder data creeping back, sources the UI cannot label, a stale static
// build, and days duplicated or dated impossibly.
//
// Usage:
//   node scripts/eval-dataset.js [--strict]
//
// Reports every check. Exits 1 on any FAIL, or on any WARN under --strict.

import { readFile } from "node:fs/promises";

const DATA_FILE = "public/data/daily-burn.json";
const APP_FILE = "src/app.js";
// Matches the default in scripts/build.js, so an older config without
// build_output is judged against the same path the build actually uses.
const DEFAULT_BUILD_OUTPUT = "docs2B/index.html";
const site = JSON.parse(await readFile("config/site.json", "utf8"));
const BUILD_FILE = site.build_output ?? DEFAULT_BUILD_OUTPUT;
const { timezone, windowStart } = await import("./lib/profile.js");
const TIMEZONE = await timezone();
const WINDOW_START = await windowStart();

const strict = process.argv.includes("--strict");
const results = [];
const check = (name, verdict, detail = "") => results.push({ name, verdict, detail });

const denverToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));

// Arithmetic: the headline total must equal what the sources actually say.
const badTotals = rows.filter(
  (row) => row.total !== Object.values(row.sources).reduce((sum, entry) => sum + entry.tokens, 0)
);
check("total equals sum of sources", badTotals.length ? "FAIL" : "ok",
  badTotals.map((row) => row.date).slice(0, 5).join(", "));

// Ordering and uniqueness: a duplicated date silently doubles a day.
const dates = rows.map((row) => row.date);
const sorted = [...dates].sort();
const duplicates = dates.filter((date, index) => dates.indexOf(date) !== index);
check("dates sorted and unique", sorted.join() === dates.join() && !duplicates.length ? "ok" : "FAIL",
  duplicates.join(", "));

// Impossible dates: a future row means a timezone or clock bug upstream.
const today = denverToday();
const future = rows.filter((row) => row.date > today);
const preWindow = rows.filter((row) => row.date < WINDOW_START);
check("no future or pre-window rows", future.length || preWindow.length ? "FAIL" : "ok",
  [...future, ...preWindow].map((row) => row.date).join(", "));

// The tally cuts at midnight. A row for the day still in progress holds
// however much of it had happened when the import ran, presented as the whole
// day. The importer holds those receipts back; this catches any that slip in.
const inProgress = rows.filter((row) => row.date === today);
check("no in-progress day row", inProgress.length ? "FAIL" : "ok",
  inProgress.map((row) => `${row.date} is not a complete day yet`).join(", "));

// Zero is a measurement, not an absence. An unknown day must be missing from
// the file entirely, never present with a zero total.
const zeroRows = rows.filter((row) => row.total === 0);
check("no zero-total rows", zeroRows.length ? "FAIL" : "ok",
  zeroRows.map((row) => row.date).join(", "));

// A day-boundary migration leaves duplicates behind. When the profile timezone
// moved from America/Denver to UTC, every session that ran in the Denver
// evening moved forward a day; re-extraction wrote the new day, and the old row
// stayed because the importer merges by date and source and has no way to
// retire a date no receipt covers any more. Ten such entries survived, double
// counting 7,289,199 tokens.
//
// The signature is exact: the same source on adjacent days with identical token
// counts AND identical call counts. Two real days do not agree to the token.
const previousDay = (date) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
};
const rowsByDate = new Map(rows.map((row) => [row.date, row]));
const adjacentDuplicates = [];
for (const row of rows) {
  const previous = rowsByDate.get(previousDay(row.date));
  if (!previous) continue;
  for (const [source, entry] of Object.entries(row.sources)) {
    const earlier = previous.sources[source];
    if (!earlier || !entry.tokens) continue;
    if (earlier.tokens === entry.tokens && (earlier.calls ?? null) === (entry.calls ?? null)) {
      adjacentDuplicates.push(`${previous.date}=${row.date}/${source}`);
    }
  }
}
check("no adjacent duplicate source entries", adjacentDuplicates.length ? "FAIL" : "ok",
  adjacentDuplicates.slice(0, 5).join(", "));

// Placeholder fidelity must never reappear in committed data.
const sampleEntries = rows.flatMap((row) =>
  Object.entries(row.sources)
    .filter(([, entry]) => entry.fidelity === "sample")
    .map(([source]) => `${row.date}/${source}`)
);
check("no sample-fidelity entries", sampleEntries.length ? "FAIL" : "ok",
  sampleEntries.slice(0, 5).join(", "));

// Every source the data carries must have a display label, or the dashboard
// renders a raw snake_case id at the user.
const appSource = await readFile(APP_FILE, "utf8");
const labelBlock = appSource.slice(appSource.indexOf("const sourceLabels"), appSource.indexOf("};", appSource.indexOf("const sourceLabels")));
const labelled = new Set([...labelBlock.matchAll(/^\s*([a-z0-9_]+):/gm)].map((match) => match[1]));
const usedSources = [...new Set(rows.flatMap((row) => Object.keys(row.sources)))];
const unlabelled = usedSources.filter((source) => !labelled.has(source));
check("every source has a UI label", unlabelled.length ? "FAIL" : "ok", unlabelled.join(", "));

// Fidelity must be declared per source entry, and honestly typed.
const badFidelity = rows.flatMap((row) =>
  Object.entries(row.sources)
    .filter(([, entry]) => !["exact", "estimated"].includes(entry.fidelity) || !Number.isInteger(entry.tokens) || entry.tokens < 0)
    .map(([source]) => `${row.date}/${source}`)
);
check("source entries well typed", badFidelity.length ? "FAIL" : "ok", badFidelity.slice(0, 5).join(", "));

// A stale docs/index.html silently serves yesterday's numbers from a file that looks current.
try {
  const built = await readFile(BUILD_FILE, "utf8");
  const match = built.match(/window\.__DAILY_BURN__ = (\[.*?\]);/s);
  const builtRows = match ? JSON.parse(match[1].replace(/\\u003c/g, "<")) : null;
  const same = builtRows && JSON.stringify(builtRows) === JSON.stringify(rows);
  check("static build matches data", same ? "ok" : "WARN", same ? "" : "run npm run build");
} catch {
  check("static build matches data", "WARN", "docs2B/index.html absent; run npm run build");
}

// Cross-foot: the grand total must equal the sum of every per-source series.
// Catches grouping and filter bugs that leave a panel disagreeing with the
// headline figure.
const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
const perSource = usedSources.reduce(
  (sum, source) => sum + rows.reduce((acc, row) => acc + (row.sources[source]?.tokens ?? 0), 0),
  0
);
check("grand total cross-foots by source", grandTotal === perSource ? "ok" : "FAIL",
  grandTotal === perSource ? "" : `${grandTotal} vs ${perSource}`);

// Per-origin splits must reconcile with the source total, or a machine's
// contribution has been lost or double counted somewhere in the merge.
const originBreaks = rows.flatMap((row) =>
  Object.entries(row.sources)
    .filter(([, entry]) => entry.by_origin)
    .filter(([, entry]) => Object.values(entry.by_origin).reduce((sum, n) => sum + n, 0) !== entry.tokens)
    .map(([source]) => `${row.date}/${source}`)
);
check("by_origin splits reconcile", originBreaks.length ? "FAIL" : "ok", originBreaks.slice(0, 5).join(", "));

const origins = [...new Set(rows.flatMap((row) =>
  Object.values(row.sources).flatMap((entry) => Object.keys(entry.by_origin ?? {}))))].sort();
check("origins present", "info", origins.length ? origins.join(", ") : "none yet (single-origin data)");

// Unreviewed days are expected, but worth surfacing as a standing backlog.
const unreviewed = rows.filter((row) => row.driver === "unreviewed");
check("driver labels reviewed", unreviewed.length ? "WARN" : "ok",
  `${unreviewed.length} of ${rows.length} rows still unreviewed`);

const width = Math.max(...results.map((result) => result.name.length));
for (const { name, verdict, detail } of results) {
  console.log(`${verdict.padEnd(5)} ${name.padEnd(width)}${detail ? "  " + detail : ""}`);
}

const failed = results.filter((result) => result.verdict === "FAIL");
const warned = results.filter((result) => result.verdict === "WARN");
console.log(`\n${rows.length} rows checked: ${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail.`);

if (failed.length || (strict && warned.length)) process.exit(1);
