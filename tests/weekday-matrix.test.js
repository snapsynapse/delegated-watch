// The importer holds back the whole Sunday-to-Saturday week in progress, so a
// test whose fixtures derive from the wall clock can pass on one weekday and
// fail on the next. Two such tests once used "yesterday" and passed only
// because the suite last ran on a Sunday. This runs every clock-dependent
// test file once per weekday, by shifting the clock forward zero to six days,
// so all seven weekdays are covered on every run whatever day it is.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");
const PRELOAD = join(repo, "tests", "support", "fixed-clock.mjs");

// Test files that read the wall clock, or spawn a command that does.
const CLOCK_DEPENDENT = [
  "tests/demo-import.test.js",
  "tests/import-cutoff.test.js",
  "tests/import-preservation.test.js",
  "tests/import-replay-idempotence.test.js",
  "tests/provider-cost.test.js",
  "tests/readme-worked-receipt.test.js",
  "tests/refresh-record.test.js",
  "tests/roadmap-claims.test.js", // reads demo-import.js as text only; listed so the guard stays strict
  "tests/usage-api-extractors.test.js",
  "tests/whole-week-guards.test.js"
];
const READS_CLOCK = /import-daily-burn\.js|refresh\.js"|demo-import\.js|Date\.now\(\)|new Date\(\)|calendarDay\(|dashboardCalendarDay\(/;

test("every test file that depends on the wall clock is in the weekday matrix", async () => {
  const files = (await readdir(join(repo, "tests"))).filter((name) => name.endsWith(".test.js") && name !== "weekday-matrix.test.js");
  const dependent = [];
  for (const name of files) {
    if (READS_CLOCK.test(await readFile(join(repo, "tests", name), "utf8"))) dependent.push(`tests/${name}`);
  }
  assert.deepEqual(dependent.sort(), [...CLOCK_DEPENDENT].sort(), "add new clock-dependent test files to CLOCK_DEPENDENT");
});

// Each run gets its own temporary directory, because some tests count the
// temp directories their command leaves behind and concurrent runs would see
// each other's.
const runShifted = async (days) => {
  const scratch = await mkdtemp(join(tmpdir(), `weekday-matrix-${days}-`));
  try {
    return await runIn(days, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const runIn = (days, scratch) => new Promise((done) => {
  // The outer runner marks its child processes with NODE_TEST_CONTEXT; a
  // nested run that inherits it reports to a parent that is not listening
  // instead of running, so it is removed.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const child = spawn(process.execPath, ["--test", ...CLOCK_DEPENDENT], {
    cwd: repo,
    env: {
      ...env,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      DELEGATED_WATCH_TEST_CLOCK_DAYS: String(days),
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${PRELOAD}`.trim()
    }
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("close", (status) => done({ days, status, output }));
});

test("clock-dependent tests pass on every weekday", async () => {
  // Day 0 is the real clock, which the main suite already covers; the other
  // six complete the week. They run concurrently to keep the suite fast.
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(runShifted));
  for (const { days, status, output } of runs) {
    const passed = Number(output.match(/^ℹ pass (\d+)$/m)?.[1] ?? 0);
    assert.ok(passed > 0, `clock shifted ${days} day(s) forward: no tests ran\n${output.slice(-1000)}`);
    const failing = output.split("\n").filter((line) => line.startsWith("✖")).slice(0, 5).join("\n");
    assert.equal(status, 0, `clock shifted ${days} day(s) forward:\n${failing || output.slice(-2000)}`);
  }
});
