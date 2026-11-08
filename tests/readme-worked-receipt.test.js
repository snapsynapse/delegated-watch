// The README opens with a worked receipt and the daily row it produces. Both
// are claims about this code, so both are checked against it: the receipt
// must be the fixture's first line and a valid receipt, and the row must be
// exactly what the importer writes when it imports that fixture. A README that
// drifts from the importer fails here instead of teaching the wrong model.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");

async function workedExample() {
  const readme = await readFile(join(repo, "README.md"), "utf8");
  const start = readme.indexOf("## A worked receipt, synthetic\n");
  assert.notEqual(start, -1, "README has no worked-receipt section");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.equal(blocks.length, 2, "the worked-receipt section should show one receipt and one row");
  return { receipt: blocks[0], row: blocks[1], section };
}

test("the README's worked receipt is the day-one fixture's first receipt, and valid", async () => {
  const { receipt } = await workedExample();
  const fixture = (await readFile(join(repo, "fixtures/receipts/day-one.jsonl"), "utf8")).split("\n")[0];
  assert.deepEqual(receipt, JSON.parse(fixture));
  assert.doesNotThrow(() => validateReceiptSchema(receipt));
  assert.match(receipt.provenance, /^synthetic:/);
});

test("the README's worked row is exactly what the importer writes for that fixture", async (t) => {
  const { receipt, row } = await workedExample();
  const dir = await mkdtemp(join(tmpdir(), "dw-readme-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "public/data"), { recursive: true });
  await mkdir(join(dir, "receipts"), { recursive: true });
  await cp(join(repo, "public/data/daily-burn.json"), join(dir, "public/data/daily-burn.json"));
  await cp(join(repo, "fixtures/receipts/day-one.jsonl"), join(dir, "receipts/day-one.jsonl"));
  const result = spawnSync(process.execPath, [join(repo, "scripts/import-daily-burn.js")], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(await readFile(join(dir, "public/data/daily-burn.json"), "utf8"));
  assert.deepEqual(rows.find((candidate) => candidate.date === receipt.date), row);
});

test("the worked example is labelled synthetic where it is shown", async () => {
  const { section } = await workedExample();
  assert.match(section, /^## A worked receipt, synthetic$/m);
  assert.match(section, /Every identity, date, and count in this section is invented/);
  assert.match(section, /This example is synthetic\./);
});
