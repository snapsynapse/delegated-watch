// Runs the real importer, scripts/import-daily-burn.js, against the synthetic
// public-candidate dataset and fixture receipts, entirely inside a fresh temp
// directory shaped like the repo (public/data/, receipts/). It never reads or
// writes this repo's real public/data/, scratch/receipts, or receipts/, and it
// removes every temp directory it creates before exiting.
//
// Four scenarios, one per fixture file under candidate/fixtures/receipts/
// (see the README there for what each demonstrates), plus a fourth generated
// at run time rather than stored as a fixture: a receipt dated today, so the
// in-progress-week gate has something to hold back. Storing a "today" fixture
// would go stale the day after it was written; generating it here means the
// demo is honest on every future run.
//
// Each scenario reports whether it behaved as expected. The script prints
// every line, then exits 1, with a summary on stderr, if any did not: a zero
// exit means all four outcomes occurred, not merely that the script ran.
//
// Usage:
//   node scripts/demo-import.js

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateRoot } from "./lib/candidate-layout.js";
import { fileURLToPath } from "node:url";

import { timezone } from "./lib/profile.js";
import { runDirectly } from "./lib/run-directly.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const IMPORTER = join(REPO_ROOT, "scripts", "import-daily-burn.js");
const CANDIDATE_ROOT = await candidateRoot(REPO_ROOT);
const CANDIDATE_DATASET = join(CANDIDATE_ROOT, "public", "data", "daily-burn.json");
const FIXTURES_DIR = join(CANDIDATE_ROOT, "fixtures", "receipts");

// Reserved identities only -- see config/public-candidate.json
// "reserved_identities". This receipt never touches disk as a fixture; it
// exists only for the lifetime of this process.
const todayReceipt = (date, tz) => ({
  schema_version: 2,
  date,
  timezone: tz,
  source: "codex",
  provider: "openai",
  surface: "cli",
  account_alias: "example",
  origin: "machine/example",
  snapshot_key: `synthetic:codex:${date}:machine/example:runtime-demo`,
  authority: "tool",
  interval: { start: date, end: date },
  tokens: 500,
  calls: 1,
  fidelity: "exact",
  provenance: "synthetic: runtime-generated receipt for the in-progress day"
});

const calendarDay = (tz) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

async function makeScenarioDir(root, name) {
  const dir = join(root, name);
  await mkdir(join(dir, "public", "data"), { recursive: true });
  await mkdir(join(dir, "receipts"), { recursive: true });
  const dataset = await readFile(CANDIDATE_DATASET, "utf8");
  await writeFile(join(dir, "public", "data", "daily-burn.json"), dataset);
  return { dir, dataset };
}

function runImporter(cwd) {
  const result = spawnSync(process.execPath, [IMPORTER], { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

async function copyFixture(name, destDir) {
  const text = await readFile(join(FIXTURES_DIR, name), "utf8");
  await writeFile(join(destDir, "receipts", name), text);
}

async function datasetRows(dir) {
  const text = await readFile(join(dir, "public", "data", "daily-burn.json"), "utf8");
  return JSON.parse(text);
}

async function runDayOne(root, tz) {
  const { dir, dataset } = await makeScenarioDir(root, "day-one");
  await copyFixture("day-one.jsonl", dir);
  const before = JSON.parse(dataset);
  const beforeDates = new Set(before.map((row) => row.date));
  const result = runImporter(dir);
  if (result.status !== 0) {
    return { ok: false, line: `day-one: expected success, importer exited ${result.status}\n${result.stderr}` };
  }
  const after = await datasetRows(dir);
  const added = after.filter((row) => !beforeDates.has(row.date));
  const unreviewed = added.filter((row) => row.driver === "unreviewed");
  if (!added.length || unreviewed.length !== added.length) {
    return {
      ok: false,
      line: `day-one: expected new rows, every one with driver "unreviewed", but ${unreviewed.length} of ${added.length} were`
    };
  }
  return {
    ok: true,
    line: `day-one: imports ${added.length} new row(s) (${added.map((r) => r.date).join(", ")}) ` +
      `as driver "unreviewed" (${unreviewed.length}/${added.length} confirmed).`
  };
}

async function runRegression(root) {
  const { dir } = await makeScenarioDir(root, "regression");
  await copyFixture("regression.jsonl", dir);
  const result = runImporter(dir);
  if (result.status === 0) {
    return { ok: false, line: "regression: expected the importer to refuse this receipt, but it exited 0." };
  }
  // Node prints the throwing source line before the actual "Error: ..." text,
  // so match the thrown message itself rather than the first line containing
  // the phrase, and keep reading until the stack trace ("    at ...") starts.
  const lines = result.stderr.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Error: Blocked exact historical regression"));
  const body = [];
  if (start !== -1) {
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim() || line.startsWith("    at") || line.startsWith("Node.js ")) break;
      body.push(line);
    }
  }
  if (start === -1) {
    // Refused, but not by the gate this scenario exists to show.
    const other = lines.find((line) => line.startsWith("Error")) ?? lines.find((line) => line.trim()) ?? "(no message captured)";
    return { ok: false, line: `regression: expected the no-decrease gate to refuse it, but the importer failed otherwise -- "${other}"` };
  }
  return { ok: true, line: `regression: refused by the importer's own no-decrease gate -- "${body.join(" ").trim()}"` };
}

async function runEstimated(root) {
  const { dir, dataset } = await makeScenarioDir(root, "estimated");
  await copyFixture("estimated.jsonl", dir);
  const before = JSON.parse(dataset);
  const incoming = JSON.parse((await readFile(join(FIXTURES_DIR, "estimated.jsonl"), "utf8")).trim());
  const beforeRow = before.find((row) => row.date === incoming.date);
  const result = runImporter(dir);
  if (result.status !== 0) {
    return { ok: false, line: `estimated: expected success, importer exited ${result.status}\n${result.stderr}` };
  }
  const after = await datasetRows(dir);
  const afterRow = after.find((row) => row.date === incoming.date);
  const fidelities = [...new Set(Object.values(afterRow?.sources ?? {}).map((entry) => entry.fidelity))].sort();
  if (afterRow?.sources?.[incoming.source]?.fidelity !== "estimated" || !fidelities.includes("exact")) {
    return {
      ok: false,
      line: `estimated: expected ${incoming.date} to hold "${incoming.source}" as estimated beside exact sources, ` +
        `but its fidelities are: ${fidelities.join(", ") || "none"}`
    };
  }
  return {
    ok: true,
    line: `estimated: merges "${incoming.source}" (estimated) into ${incoming.date}, which already carried ` +
      `${Object.keys(beforeRow.sources).length} exact source(s); the row now mixes fidelities: ${fidelities.join(", ")}.`
  };
}

async function runToday(root, tz) {
  const { dir } = await makeScenarioDir(root, "today");
  const date = calendarDay(tz);
  const receiptText = `${JSON.stringify(todayReceipt(date, tz))}\n`;
  await writeFile(join(dir, "receipts", "today.jsonl"), receiptText);
  const result = runImporter(dir);
  if (result.status !== 0) {
    return { ok: false, line: `today (${date}): expected success (held back, not refused), importer exited ${result.status}\n${result.stderr}` };
  }
  const heldBack = result.stdout.includes("Held back") && result.stdout.includes(date);
  return heldBack
    ? { ok: true, line: `today (${date}): held back until its Sunday-to-Saturday week is complete -- "${result.stdout.split("\n")[0]}"` }
    : { ok: false, line: `today (${date}): expected a "Held back" notice for the in-progress day, but stdout was:\n${result.stdout}` };
}

async function main() {
  const tz = await timezone();
  const root = await mkdtemp(join(tmpdir(), "delegated-watch-demo-import-"));
  const outcomes = [];
  try {
    outcomes.push(await runDayOne(root, tz));
    outcomes.push(await runRegression(root));
    outcomes.push(await runEstimated(root));
    outcomes.push(await runToday(root, tz));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(outcomes.map((outcome) => outcome.line).join("\n"));
  const unexpected = outcomes.filter((outcome) => !outcome.ok).length;
  if (unexpected) {
    console.error(`${unexpected} of ${outcomes.length} scenarios did not behave as expected.`);
    process.exitCode = 1;
  }
}

if (runDirectly(import.meta.url)) {
  await main();
}

export { runDayOne, runEstimated, runRegression, runToday };
