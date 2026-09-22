import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "../scripts/export-csv.js");
const run = (cwd, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const records = [{ date: "2026-01-02", timezone: "UTC", sources: {
  codex: { tokens: 100, calls: 2, fidelity: "exact", by_origin: { "machine/a": 40, "machine/b": 60 } }
}, total: 100, driver: "research", evidence: 'synthetic, "quoted"\nsecond line' }];

test("CSV check detects field drift even when grand totals still agree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dw-csv-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  await writeFile(join(cwd, "public/data/daily-burn.json"), JSON.stringify(records));
  assert.equal(run(cwd).status, 0);
  const detail = join(cwd, "public/data/daily-burn-detail.csv");
  const wide = join(cwd, "public/data/daily-burn.csv");
  const detailBefore = await readFile(detail, "utf8");
  const wideBefore = await readFile(wide, "utf8");
  assert.match(wideBefore, /"synthetic, ""quoted""\nsecond line"/);
  assert.equal(run(cwd, ["--check"]).status, 0);
  for (const [file, before, after] of [
    [detail, detailBefore, detailBefore.replace("machine/a", "machine/c")],
    [detail, detailBefore, detailBefore.replace("2026-01-02", "2026-01-03")],
    [detail, detailBefore, detailBefore.replace("codex", "chatgpt")],
    [wide, wideBefore, wideBefore.replace("research", "writing")]
  ]) {
    await writeFile(file, after);
    const check = run(cwd, ["--check"]);
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /CSV parity failed/);
    assert.equal(await readFile(file, "utf8"), after);
    await writeFile(file, before);
  }
});

test("CSV export refuses inconsistent canonical arithmetic before replacing outputs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dw-csv-invalid-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  await writeFile(join(cwd, "public/data/daily-burn.json"), JSON.stringify([{ ...records[0], total: 999 }]));
  const wide = join(cwd, "public/data/daily-burn.csv");
  await writeFile(wide, "prior bytes");
  assert.notEqual(run(cwd).status, 0);
  assert.equal(await readFile(wide, "utf8"), "prior bytes");
});
