import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "../scripts/export-csv.js");
const run = (cwd, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const records = [{ date: "2026-01-02", timezone: "UTC", sources: {
  codex: {
    tokens: 600,
    calls: 2,
    fidelity: "exact",
    by_origin: { "machine/a": 240, "machine/b": 360 },
    token_components: {
      schema_version: 1,
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_tokens: 0,
      output_tokens: 200
    }
  }
}, total: 600, driver: "research", evidence: 'synthetic, "quoted"\nsecond line' }];

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
  assert.match(
    detailBefore,
    /input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,component_scope/
  );
  assert.match(detailBefore, /machine\/a,240,,exact,1000,600,0,200,,source,/);
  assert.match(detailBefore, /machine\/b,360,,exact,,,,,,,/);
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

test("CSV export preserves standalone measured-zero activity and its evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dw-csv-measured-zero-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  await writeFile(join(cwd, "public/data/daily-burn.json"), JSON.stringify([{
    date: "2026-01-02",
    timezone: "UTC",
    sources: {
      openai_api: {
        tokens: 0,
        calls: 5,
        fidelity: "exact",
        by_origin: { "account/openai": 0 },
        token_components: {
          schema_version: 1,
          input_tokens: 750,
          cached_input_tokens: 750,
          output_tokens: 0
        }
      }
    },
    total: 0,
    driver: "research",
    evidence: "measured cached-only activity"
  }]));

  const result = run(cwd);
  assert.equal(result.status, 0, result.stderr);
  const wide = await readFile(join(cwd, "public/data/daily-burn.csv"), "utf8");
  const detail = await readFile(join(cwd, "public/data/daily-burn-detail.csv"), "utf8");
  assert.match(wide, /2026-01-02,UTC,0,research,measured cached-only activity,openai_api,exact/);
  assert.match(detail, /openai_api,account\/openai,0,5,exact,750,750,,0,,source,0/);
});
