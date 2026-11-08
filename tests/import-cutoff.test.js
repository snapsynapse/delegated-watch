import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The importer buckets by the day-grouping timezone in config/profile.json,
// so the fixture derives its dates the same way rather than assuming UTC.
const { timezone } = await import("../scripts/lib/profile.js");
const TIMEZONE = await timezone();
const dayIn = (offset) => {
  const date = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
};

const receipt = (date, tokens) => JSON.stringify({
  date, timezone: TIMEZONE, source: "codex", tokens, calls: 1,
  fidelity: "exact", provenance: "synthetic fixture"
});

const runImport = async (dates) => {
  const cwd = await mkdtemp(join(tmpdir(), "import-cutoff-"));
  await mkdir(join(cwd, "public", "data"), { recursive: true });
  await writeFile(join(cwd, "public", "data", "daily-burn.json"), "[]\n");
  const receipts = join(cwd, "receipts.jsonl");
  await writeFile(receipts, dates.map(([date, tokens]) => receipt(date, tokens)).join("\n") + "\n");
  const result = execFileSync(
    process.execPath,
    [join(repo, "scripts", "import-daily-burn.js"), receipts],
    { cwd, encoding: "utf8" }
  );
  const rows = JSON.parse(await readFile(join(cwd, "public", "data", "daily-burn.json"), "utf8"));
  return { rows, stdout: result };
};

// The importer holds back the whole Sunday-to-Saturday week in progress by
// default (import_weeks "complete"), so these dates are derived from the
// current week rather than from yesterday, which on most weekdays is still in
// the week being held back.
const { weekStartOf } = await import("../scripts/lib/import-policy.js");
const shift = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const today = dayIn(0);
const thisSunday = weekStartOf(today);
const lastSaturday = shift(thisSunday, -1);
const lastSunday = shift(thisSunday, -7);

test("the week in progress is held back, so the record only gains whole weeks", async () => {
  const inProgress = [...new Set([thisSunday, today])];
  const { rows, stdout } = await runImport([[lastSaturday, 1000], ...inProgress.map((date) => [date, 7])]);
  assert.deepEqual(rows.map((row) => row.date), [lastSaturday]);
  assert.match(stdout, new RegExp(`Held back ${inProgress.length} receipt\\(s\\) for `));
  assert.match(stdout, /not yet a complete Sunday-to-Saturday week/);
  assert.match(stdout, new RegExp(today));
});

test("a complete week imports in full once it has elapsed", async () => {
  const { rows, stdout } = await runImport([[lastSunday, 500], [lastSaturday, 1000]]);
  assert.deepEqual(rows.map((row) => row.date), [lastSunday, lastSaturday]);
  assert.equal(rows[1].total, 1000);
  assert.doesNotMatch(stdout, /Held back/);
});

test("a receipt dated past the cutoff fails the import instead of being held back", async () => {
  await assert.rejects(
    async () => runImport([[dayIn(2), 5]]),
    (error) => {
      assert.match(error.stderr, /after the current day/);
      return true;
    }
  );
});
