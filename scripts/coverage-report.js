// Source coverage report for public/data/daily-burn.json.
//
// Reports, for the real-data window starting 2022-11-30:
// - days present vs missing (with explicit missing-day/range listing)
// - sample-only days (present but still placeholder data)
// - exact vs estimated token split
// - per-source coverage and last-seen date
//
// Usage:
//   node scripts/coverage-report.js [--start YYYY-MM-DD] [--strict]
// --strict exits 1 when the window has missing or sample-only days
// (for use as a deploy gate).

import { readFile } from "node:fs/promises";

const { timezone, windowStart } = await import("./lib/profile.js");
const TIMEZONE = await timezone();
const WINDOW_START = await windowStart();

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const start = flagValue("--start") ?? WINDOW_START;
const strict = args.includes("--strict");

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const rows = JSON.parse(await readFile("public/data/daily-burn.json", "utf8"));
const rowsByDate = new Map(rows.map((row) => [row.date, row]));

const nextDay = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// Walk every day in the window.
const missing = [];
const sampleOnly = [];
let realDays = 0;
for (let date = start; date <= today; date = nextDay(date)) {
  const row = rowsByDate.get(date);
  if (!row) {
    missing.push(date);
  } else if (Object.values(row.sources).every((entry) => entry.fidelity === "sample")) {
    sampleOnly.push(date);
  } else {
    realDays += 1;
  }
}
const windowDays = missing.length + sampleOnly.length + realDays;

// Collapse a sorted day list into readable ranges.
const ranges = (dates) => {
  const out = [];
  for (const date of dates) {
    const last = out[out.length - 1];
    if (last && nextDay(last.end) === date) last.end = date;
    else out.push({ start: date, end: date });
  }
  return out.map((r) => (r.start === r.end ? r.start : `${r.start}..${r.end}`));
};

// Fidelity token split and per-source stats across all committed rows.
const tokensByFidelity = { exact: 0, estimated: 0, sample: 0 };
const sources = new Map();
for (const row of rows) {
  for (const [source, entry] of Object.entries(row.sources)) {
    tokensByFidelity[entry.fidelity] = (tokensByFidelity[entry.fidelity] ?? 0) + entry.tokens;
    const stat = sources.get(source) ?? { days: 0, tokens: 0, fidelities: new Set(), lastSeen: row.date };
    stat.days += 1;
    stat.tokens += entry.tokens;
    stat.fidelities.add(entry.fidelity);
    stat.lastSeen = row.date;
    sources.set(source, stat);
  }
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

console.log(`Coverage window: ${start} .. ${today} (${TIMEZONE}, ${windowDays} days)`);
console.log(`  real data:   ${realDays} days (${pct(realDays, windowDays)})`);
console.log(`  sample only: ${sampleOnly.length} days`);
console.log(`  missing:     ${missing.length} days`);
if (missing.length) console.log(`  missing ranges: ${ranges(missing).join(", ")}`);
if (sampleOnly.length) console.log(`  sample ranges:  ${ranges(sampleOnly).join(", ")}`);

const totalTokens = Object.values(tokensByFidelity).reduce((a, b) => a + b, 0);
console.log(`Token fidelity split (all ${rows.length} committed rows, ${totalTokens} tokens):`);
for (const [fidelity, tokens] of Object.entries(tokensByFidelity)) {
  if (tokens) console.log(`  ${fidelity}: ${tokens} (${pct(tokens, totalTokens)})`);
}

console.log("Per-source coverage:");
for (const [source, stat] of [...sources.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${source}: ${stat.days} days, ${stat.tokens} tokens, fidelity ${[...stat.fidelities].sort().join("+")}, last seen ${stat.lastSeen}`);
}

const unreviewed = rows.filter((row) => row.driver === "unreviewed").map((row) => row.date);
if (unreviewed.length) console.log(`Unreviewed imported days (relabel driver/evidence): ${ranges(unreviewed).join(", ")}`);

if (strict && (missing.length || sampleOnly.length)) {
  console.error(`Strict mode: window incomplete (${missing.length} missing, ${sampleOnly.length} sample-only).`);
  process.exit(1);
}
