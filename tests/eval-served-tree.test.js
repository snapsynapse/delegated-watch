// The live branch of eval:served checks what public_mode "synthetic" promises.
// Every case runs the real eval against a disposable copy of the committed
// served tree, so nothing here touches the repository's own files.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const evalScript = join(repo, "scripts/eval-served-tree.js");
const MARKER = "window.__DAILY_BURN__ = ";

async function servedCopy(t) {
  const dir = await mkdtemp(join(tmpdir(), "dw-served-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ["config", "docs", "public/data"]) {
    await cp(join(repo, path), join(dir, path), { recursive: true });
  }
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [evalScript, "--strict"], { cwd: dir, encoding: "utf8" });
const output = (result) => `${result.stdout}${result.stderr}`;

async function editJson(dir, path, edit) {
  const file = join(dir, path);
  const value = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify(edit(value) ?? value, null, 2)}\n`);
}

// Rewrites the rows inlined in the built page the way the build does.
async function setInlineRows(dir, rows) {
  const page = join(dir, "docs/demo/index.html");
  const lines = (await readFile(page, "utf8")).split("\n");
  const index = lines.findIndex((line) => line.startsWith(MARKER));
  assert.notEqual(index, -1, "built page has no inlined dataset");
  lines[index] = `${MARKER}${JSON.stringify(rows).replace(/</g, "\\u003c")};`;
  await writeFile(page, lines.join("\n"));
}

const datasetRows = async (dir) => JSON.parse(await readFile(join(dir, "public/data/daily-burn.json"), "utf8"));

test("the committed synthetic served tree passes", async (t) => {
  const dir = await servedCopy(t);
  const result = run(dir);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /ok\s+served page data matches the tracked dataset/);
  assert.match(result.stdout, /ok\s+served page data is synthetic/);
  assert.doesNotMatch(result.stdout, /skipped/);
});

test("a rebuilt page with the same rows passes byte and semantic checks", async (t) => {
  const dir = await servedCopy(t);
  await setInlineRows(dir, await datasetRows(dir));
  const result = run(dir);
  assert.equal(result.status, 0, output(result));
});

test("a misspelled or unsupported public_mode fails", async (t) => {
  for (const mode of ["synthetc", "public", ""]) {
    const dir = await servedCopy(t);
    await editJson(dir, "config/site.json", (site) => { site.public_mode = mode; });
    const result = run(dir);
    assert.equal(result.status, 1, `${JSON.stringify(mode)}: ${output(result)}`);
    assert.match(result.stdout, /FAIL\s+public mode recorded before going live/);
  }
});

test("public_mode synthetic with a measured dataset declared fails", async (t) => {
  const dir = await servedCopy(t);
  await editJson(dir, "config/site.json", (site) => { site.dataset = "measured"; });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+site declares a synthetic dataset/);
});

test("a measured row in both the page and the dataset fails as not synthetic", async (t) => {
  const dir = await servedCopy(t);
  const rows = await datasetRows(dir);
  rows[0].evidence = "measured: a real day";
  await editJson(dir, "public/data/daily-burn.json", () => rows);
  await setInlineRows(dir, rows);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ok\s+served page data matches the tracked dataset/);
  assert.match(result.stdout, /FAIL\s+served page data is synthetic.*evidence does not begin with "synthetic:"/);
});

test("an unreserved identity in the served page fails", async (t) => {
  const dir = await servedCopy(t);
  const rows = await datasetRows(dir);
  const entry = Object.values(rows[0].sources)[0];
  entry.by_origin = { "machine/someones-laptop": entry.tokens };
  await editJson(dir, "public/data/daily-burn.json", () => rows);
  await setInlineRows(dir, rows);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+served page data is synthetic.*is not reserved/);
});

test("a built page whose inlined rows differ from the tracked dataset fails", async (t) => {
  const dir = await servedCopy(t);
  const rows = await datasetRows(dir);
  rows[0].total += 1;
  await setInlineRows(dir, rows);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+served page data matches the tracked dataset.*rows differ/);
});

test("a page with no inlined dataset fails instead of passing unchecked", async (t) => {
  const dir = await servedCopy(t);
  const page = join(dir, "docs/demo/index.html");
  const html = (await readFile(page, "utf8")).split("\n").filter((line) => !line.startsWith(MARKER)).join("\n");
  await writeFile(page, html);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+served page data matches the tracked dataset.*carries no inlined dataset/);
});

test("another declared public_mode is reported as not evaluated, never as ok", async (t) => {
  const dir = await servedCopy(t);
  await editJson(dir, "config/site.json", (site) => { site.public_mode = "rounded"; });
  const result = run(dir);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /n\/a\s+served data checked against its public mode\s+not evaluated/);
  assert.match(result.stdout, /1 not evaluated\./);
});

test("record mode still rejects a person's record values under docs/", async (t) => {
  const dir = await servedCopy(t);
  // A local record whose largest daily total then appears in a served file.
  await writeFile(join(dir, "config/record.json"), `${JSON.stringify({ dir: "record" })}\n`);
  await mkdir(join(dir, "record"), { recursive: true });
  const row = {
    date: "2025-06-01", timezone: "UTC", driver: "unreviewed", evidence: "test",
    total: 73519246, sources: { codex: { tokens: 73519246, calls: 4, fidelity: "exact" } }
  };
  await writeFile(join(dir, "record/daily-burn.json"), `${JSON.stringify([row])}\n`);
  await writeFile(join(dir, "docs/leak.txt"), "73519246\n");
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+no record content in served tree.*docs\/leak\.txt/);
});

test("with a local record configured, the served demo is still compared with the synthetic dataset", async (t) => {
  const dir = await servedCopy(t);
  await writeFile(join(dir, "config/record.json"), `${JSON.stringify({ dir: "record" })}\n`);
  await mkdir(join(dir, "record"), { recursive: true });
  const row = {
    date: "2025-06-01", timezone: "UTC", driver: "unreviewed", evidence: "test",
    total: 73519246, sources: { codex: { tokens: 73519246, calls: 4, fidelity: "exact" } }
  };
  await writeFile(join(dir, "record/daily-burn.json"), `${JSON.stringify([row])}\n`);
  const result = run(dir);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /ok\s+served page data matches the tracked dataset/);
  assert.doesNotMatch(result.stdout, /record\/daily-burn\.json/);
});
