// Deterministic generator for the public-candidate demo dataset. Produces a
// daily-burn.json array that is realistic in shape but obviously invented:
// every identity is a reserved placeholder (config/public-candidate.json
// "reserved_identities"), every evidence string is prefixed "synthetic:", and
// the calendar year (2025) predates this repo's actual recovery window, so it
// can never collide with a measured row. See config/public-candidate.json
// "synthetic_dataset" for the constraints this script must satisfy.
//
// Deterministic by construction: a fixed in-code seed drives a small
// integer-only PRNG (mulberry32). No Date.now, no Math.random, no filesystem
// read of any personal config -- running this script twice, on any machine,
// produces byte-identical output.
//
// Usage:
//   node scripts/synthetic-dataset.js [--out path/to/file.json]
//   (default --out is candidate/public/data/daily-burn.json)

import { candidateRoot } from "./lib/candidate-layout.js";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Fixed seed. Never derived from the clock or the environment.
const SEED = 0x5eed0417;

// mulberry32: small, fast, fully specified by 32-bit integer ops, so the
// sequence is identical on every engine and every run.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fresh RNG scope per generateDataset() call. Module-level PRNG state would
// make a second call in the same process continue the first call's sequence
// instead of repeating it, which would break the "run it twice, get the same
// bytes" guarantee for anything importing this module (tests included) rather
// than only for separate process invocations.
function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    // Uniform integer in [min, max], inclusive.
    randInt: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    pick: (list) => list[Math.floor(rand() * list.length)] ?? list[0],
    chance: (probability) => rand() < probability
  };
}

export const DATE_RANGE = { start: "2025-01-01", end: "2025-12-31" };
export const EVIDENCE_PREFIX = "synthetic:";
export const RESERVED_ORIGINS = [
  "machine/example",
  "machine/example-laptop",
  "account/example-provider"
];

// Every source id used below already appears in the data contract's
// example list, so the shape reads like the real schema rather than an
// invented one. Exact sources carry a call count and a machine origin;
// estimated sources have neither, matching how a real estimator behaves.
const EXACT_SOURCES = ["codex", "claude_code", "openai_api"];
const ESTIMATED_SOURCES = ["claude_chat", "qwen_local", "perplexity_api"];

const REVIEWED_DRIVERS = [
  "building:feature",
  "building:content",
  "building:spec",
  "building:infra",
  "fixing:bug",
  "fixing:pipeline",
  "fixing:data",
  "fixing:security",
  "maintenance:docs",
  "maintenance:sync",
  "maintenance:hygiene",
  "maintenance:deps",
  "shipping",
  "writing",
  "strategy",
  "research",
  "career",
  "mixed",
  "unknown"
];

const EVIDENCE_PHRASES = {
  "building:feature": "representative feature-building day",
  "building:content": "representative content-building day",
  "building:spec": "representative spec-writing day",
  "building:infra": "representative infrastructure day",
  "fixing:bug": "representative bug-fixing day",
  "fixing:pipeline": "representative pipeline-fixing day",
  "fixing:data": "representative data-fixing day",
  "fixing:security": "representative security-fixing day",
  "maintenance:docs": "representative documentation day",
  "maintenance:sync": "representative sync-maintenance day",
  "maintenance:hygiene": "representative hygiene day",
  "maintenance:deps": "representative dependency day",
  shipping: "representative shipping day",
  writing: "representative writing day",
  strategy: "representative strategy day",
  research: "representative research day",
  career: "representative career day",
  mixed: "mixed activity, no single dominant driver",
  unknown: "no defensible driver recoverable from demo evidence"
};

// Splits `tokens` across one or two of the reserved origins, summing exactly
// back to `tokens` (the by_origin invariant checked by dataset-validation.js).
function splitOrigins(rng, tokens, originPool) {
  if (originPool.length === 1 || tokens < 2 || rng.chance(0.4)) {
    return { [originPool[0]]: tokens };
  }
  const second = originPool[1] ?? originPool[0];
  const first = originPool[0];
  const firstShare = Math.max(1, Math.min(tokens - 1, Math.round(tokens * 0.65)));
  const result = { [first]: firstShare, [second]: tokens - firstShare };
  if (first === second) return { [first]: tokens };
  return result;
}

// One calendar day's worth of source entries, or null when the day is a
// deliberate gap (unknown is never zero: an absent day, not a zero day).
function generateRow(rng, date, dayOfWeek) {
  if (!rng.chance(0.62)) return null;

  const sourceCount = rng.randInt(1, 3);
  const pool = [...EXACT_SOURCES, ...ESTIMATED_SOURCES];
  const chosen = new Set();
  while (chosen.size < sourceCount && chosen.size < pool.length) {
    chosen.add(rng.pick(pool));
  }

  const sources = {};
  for (const source of chosen) {
    const isExact = EXACT_SOURCES.includes(source);
    const tokens = isExact ? rng.randInt(1500, 42000) : rng.randInt(300, 9000);
    const entry = { tokens, fidelity: isExact ? "exact" : "estimated" };
    if (isExact) entry.calls = rng.randInt(1, 40);
    const originPool = isExact
      ? [RESERVED_ORIGINS[0], RESERVED_ORIGINS[1]]
      : [RESERVED_ORIGINS[2], RESERVED_ORIGINS[0]];
    entry.by_origin = splitOrigins(rng, tokens, originPool);
    sources[source] = entry;
  }

  const total = Object.values(sources).reduce((sum, entry) => sum + entry.tokens, 0);
  // A weekend nudges toward the categories that plausibly happen off-hours;
  // still deterministic, still just flavor for a demo dataset.
  const weekendDrivers = ["writing", "strategy", "research", "career", "unknown"];
  const driver = dayOfWeek === 0 || dayOfWeek === 6
    ? rng.pick([...weekendDrivers, ...REVIEWED_DRIVERS])
    : rng.pick(REVIEWED_DRIVERS);

  return {
    date,
    timezone: "UTC",
    sources,
    total,
    driver,
    evidence: `${EVIDENCE_PREFIX} ${EVIDENCE_PHRASES[driver]}`
  };
}

function* datesInRange(start, end) {
  let cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const iso = cursor.toISOString().slice(0, 10);
    yield { date: iso, dayOfWeek: cursor.getUTCDay() };
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
}

export function generateDataset() {
  const rng = makeRng(SEED);
  const rows = [];
  for (const { date, dayOfWeek } of datesInRange(DATE_RANGE.start, DATE_RANGE.end)) {
    const row = generateRow(rng, date, dayOfWeek);
    if (row) rows.push(row);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex === -1 || !args[outIndex + 1]
    ? join(await candidateRoot(resolve(dirname(fileURLToPath(import.meta.url)), "..")), "public", "data", "daily-burn.json")
    : args[outIndex + 1];

  const rows = generateDataset();
  const resolved = resolve(outPath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`Wrote ${rows.length} synthetic rows to ${outPath}.`);

  // The dashboard requires an observed interval for every source in the
  // dataset, so the generator declares one per source spanning its rows. The
  // register lands beside the dataset's config directory: candidate/config in
  // the producer checkout, config/ in the public repository.
  const intervalsPath = resolve(dirname(resolved), "..", "..", "config", "observed-intervals.json");
  await mkdir(dirname(intervalsPath), { recursive: true });
  await writeFile(intervalsPath, `${JSON.stringify(observedIntervals(rows), null, 2)}\n`);
  console.log(`Wrote observed intervals for ${Object.keys(observedIntervals(rows).sources).length} sources to ${intervalsPath}.`);
}

// One covered interval per source, from its first synthetic row to its last.
// Status "covered" is the same word the private register uses for a span the
// extractor is known to have read completely.
export function observedIntervals(rows) {
  const bounds = new Map();
  for (const row of rows) {
    for (const source of Object.keys(row.sources)) {
      const current = bounds.get(source) ?? { from: row.date, to: row.date };
      if (row.date < current.from) current.from = row.date;
      if (row.date > current.to) current.to = row.date;
      bounds.set(source, current);
    }
  }
  return {
    note: "Synthetic observed intervals generated with the demonstration dataset. Each source is declared covered from its first synthetic row to its last; nothing here describes a real store.",
    timezone: "UTC",
    sources: Object.fromEntries([...bounds].sort(([a], [b]) => a.localeCompare(b)).map(([source, { from, to }]) => [
      source,
      { observed: [{ from, to, status: "covered", evidence: "synthetic: generated with the dataset" }] }
    ]))
  };
}

// Allow the module to be imported by tests without running the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
