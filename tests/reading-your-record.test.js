// guides/reading-your-record.md quotes figures from the shipped synthetic
// dataset. Each is recomputed here from public/data/daily-burn.json, so a
// regenerated dataset fails this test instead of leaving the guide wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const fmt = (n) => n.toLocaleString("en-US");

async function load() {
  const rows = JSON.parse(await readFile(join(repo, "public/data/daily-burn.json"), "utf8"));
  const guide = await readFile(join(repo, "guides/reading-your-record.md"), "utf8");
  let total = 0;
  const bySource = {};
  const byAuthority = {};
  for (const row of rows) {
    total += row.total;
    for (const [source, entry] of Object.entries(row.sources)) {
      bySource[source] = (bySource[source] ?? 0) + entry.tokens;
      byAuthority[entry.authority] = (byAuthority[entry.authority] ?? 0) + entry.tokens;
    }
  }
  const pct = (n) => `${((100 * n) / total).toFixed(1)}%`;
  return { rows, guide, total, bySource, byAuthority, pct };
}

test("the guide's source table matches the synthetic dataset", async () => {
  const { guide, total, bySource, pct } = await load();
  assert.equal(Object.keys(bySource).length, 6, "the guide says six sources");
  assert.ok(guide.includes(`holds ${fmt(total)} tokens across six sources`), "the guide's total");
  for (const [source, tokens] of Object.entries(bySource)) {
    assert.ok(guide.includes(`| \`${source}\` | ${fmt(tokens)} | ${pct(tokens)} |`), `row for ${source}`);
  }
});

test("the guide's authority table matches the synthetic dataset", async () => {
  const { guide, byAuthority, pct } = await load();
  assert.deepEqual(Object.keys(byAuthority).sort(), ["estimated", "provider", "tool"]);
  for (const [authority, tokens] of Object.entries(byAuthority)) {
    assert.match(guide, new RegExp(`\\| \`${authority}\`[^|]*\\| ${fmt(tokens)} \\| ${pct(tokens).replace(".", "\\.")} \\|`));
  }
  assert.ok(guide.includes(`Here ${pct(byAuthority.estimated)} of the total rests on estimates`));
});

test("the guide's coverage figures match the synthetic dataset", async () => {
  const { rows, guide } = await load();
  const first = rows[0].date;
  const last = rows.at(-1).date;
  const span = (Date.parse(last) - Date.parse(first)) / 86_400_000 + 1;
  assert.ok(guide.includes(`spans ${first} to ${last}, ${span} days. ${rows.length} of them have a row. The other ${span - rows.length} have no row at all`));
  assert.equal(rows.filter((row) => row.total === 0).length, 0, "the guide says no row records a zero total");
  for (const row of rows) assert.match(row.evidence, /^synthetic:/);
});
