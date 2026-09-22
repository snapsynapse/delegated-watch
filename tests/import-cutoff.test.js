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

test("the in-progress day is held back, so a row is always a whole day", async () => {
  const yesterday = dayIn(-1);
  const today = dayIn(0);
  const { rows, stdout } = await runImport([[yesterday, 1000], [today, 7]]);
  assert.deepEqual(rows.map((row) => row.date), [yesterday]);
  assert.match(stdout, /Held back 1 receipt\(s\) for /);
  assert.match(stdout, new RegExp(today));
});

test("a complete day imports in full once it has elapsed", async () => {
  const yesterday = dayIn(-1);
  const { rows, stdout } = await runImport([[yesterday, 1000]]);
  assert.deepEqual(rows.map((row) => row.date), [yesterday]);
  assert.equal(rows[0].total, 1000);
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
