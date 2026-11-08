// Guards for the whole-week import default (import_weeks "complete"): the
// dataset eval must notice a row inside the week still in progress, which a
// whole-week import never writes and which the 7-day tile would otherwise
// read as scanned. Dates derive from the current week, so this runs on any
// weekday; tests/weekday-matrix.test.js runs it under every one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { calendarDay, weekStartOf } from "../scripts/lib/import-policy.js";

const repo = resolve(import.meta.dirname, "..");
const { importWeeks, timezone } = await import("../scripts/lib/profile.js");
const today = calendarDay(await timezone());
const thisSunday = weekStartOf(today);
const shift = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// One synthetic demo row, redated, so every other dataset check has a valid row.
const demoRow = JSON.parse(await readFile(join(repo, "public/data/daily-burn.json"), "utf8"))[0];
const evalWith = async (dates) => {
  const cwd = await mkdtemp(join(tmpdir(), "whole-week-guards-"));
  await mkdir(join(cwd, "public", "data"), { recursive: true });
  // The eval also reads the site config and the dashboard's source labels.
  await cp(join(repo, "config", "site.json"), join(cwd, "config", "site.json"));
  await cp(join(repo, "src", "app.js"), join(cwd, "src", "app.js"));
  const rows = dates.map((date) => ({ ...structuredClone(demoRow), date }));
  await writeFile(join(cwd, "public", "data", "daily-burn.json"), `${JSON.stringify(rows, null, 2)}\n`);
  return spawnSync(process.execPath, [join(repo, "scripts", "eval-dataset.js")], { cwd, encoding: "utf8" });
};

test("the shipped profile imports whole weeks", async () => {
  assert.equal(await importWeeks(), "complete");
});

test("rows from complete weeks pass the in-progress week check", async () => {
  const result = await evalWith([shift(thisSunday, -7), shift(thisSunday, -1)]);
  assert.match(result.stdout, /ok\s+no in-progress week rows/, result.stdout + result.stderr);
});

test("a row inside the week in progress warns", async (t) => {
  if (today === thisSunday) {
    t.skip("today is Sunday: the week in progress has no elapsed day to hold a row");
    return;
  }
  const result = await evalWith([shift(thisSunday, -1), thisSunday]);
  assert.match(result.stdout, new RegExp(`WARN\\s+no in-progress week rows\\s+${thisSunday} sit in the week from ${thisSunday}`), result.stdout);
  assert.match(result.stdout, new RegExp(`ok\\s+no in-progress day row`), "a row before today is not the in-progress day");
});
