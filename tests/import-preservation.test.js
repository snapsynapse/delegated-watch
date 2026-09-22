import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { partitionCompleteReceipts } from "../scripts/lib/import-policy.js";
import { reconcileReceipts } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");

// The public candidate ships the importer and the core commands but not the
// OpenAI lane or the personal export. A script that is absent in this layout
// is skipped by name, so the gap is visible; any other read failure surfaces.
const present = (script) => {
  try {
    statSync(join(repo, "scripts", script));
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    test.skip("a command this layout does not ship");
    return false;
  }
};
const original = [{ date: "2026-01-02", timezone: "UTC", total: 100,
  sources: { codex: { tokens: 100, calls: 2, fidelity: "exact" } }, driver: "research", evidence: "synthetic" }];
const base = { date: "2026-01-02", timezone: "UTC", source: "codex", tokens: 100, calls: 2, fidelity: "exact" };
async function fixture(receipt) {
  const cwd = await mkdtemp(join(tmpdir(), "dw-preservation-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  const data = join(cwd, "public/data/daily-burn.json");
  await writeFile(data, JSON.stringify(original) + "\n");
  await writeFile(join(cwd, "input.jsonl"), JSON.stringify(receipt) + "\n");
  return { cwd, data };
}
for (const script of ["import-daily-burn.js", "import-openai.js"].filter(present)) {
  for (const [kind, patch] of Object.entries({ tokens: { tokens: 10 }, calls: { calls: 1 }, fidelity: { fidelity: "estimated" } })) {
    test(`${script} preserves bytes when exact ${kind} regresses`, async () => {
      const { cwd, data } = await fixture({ ...base, ...patch });
      const before = await readFile(data, "utf8");
      const result = spawnSync(process.execPath, [join(repo, "scripts", script), "input.jsonl"], { cwd, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /historical regression/);
      assert.equal(await readFile(data, "utf8"), before);
    });
  }
  test(`${script} refuses unconfirmed decrease flag`, async () => {
    const { cwd } = await fixture({ ...base, tokens: 10 });
    const result = spawnSync(process.execPath, [join(repo, "scripts", script), "--allow-decrease", "input.jsonl"], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirm-correction/);
  });
  test(`${script} holds current day without writing it`, async () => {
    const { cwd, data } = await fixture({ ...base, date: new Date().toISOString().slice(0, 10) });
    const result = spawnSync(process.execPath, [join(repo, "scripts", script), "input.jsonl"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Held back/);
    assert.deepEqual(JSON.parse(await readFile(data, "utf8")), original);
  });
}
test("cutoff uses the configured calendar day, including midnight and DST", () => {
  const receipts = ["2026-03-07", "2026-03-08"].map((date) => ({ ...base, date }));
  const parts = partitionCompleteReceipts(receipts, "America/New_York", "2026-01-01", new Date("2026-03-08T05:00:00Z"));
  assert.equal(parts.today, "2026-03-08");
  assert.equal(parts.receipts.length, 1);
  assert.equal(parts.heldBack.length, 1);
  assert.throws(() => partitionCompleteReceipts([{ ...base, date: "2026-02-30" }], "UTC", "2026-01-01"), /invalid calendar date/);
});
test("Perplexity transport compatibility preserves genuine surface conflicts", () => {
  const r = { ...base, source: "perplexity_api", provider: "perplexity", snapshot_key: "perplexity:synthetic" };
  const result = reconcileReceipts([{ ...r, surface: "native_api_capture" }, { ...r, surface: "tool_result_capture" }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].surface, "api");
  assert.equal(reconcileReceipts([{ ...r, surface: "api" }, { ...r, surface: "unrelated" }]).errors.length, 1);
});

test("snapshot reconciliation rejects scope collisions and lost request identities", () => {
  const a = { ...base, snapshot_key: "synthetic", machine_alias: "store-a", correlation_keys: ["sha256:" + "a".repeat(64)] };
  assert.match(reconcileReceipts([a, { ...a, machine_alias: "store-b" }]).errors.join(), /conflicts/);
  const larger = { ...a, tokens: 200, correlation_keys: ["sha256:" + "b".repeat(64)] };
  for (const pair of [[a, larger], [larger, a]]) {
    assert.match(reconcileReceipts(pair).errors.join(), /omits previously observed/);
  }
});

test("pending acceptance blocks public export and dependent commands before output changes", async () => {
  const { cwd } = await fixture(base);
  await mkdir(join(cwd, "scratch"), { recursive: true });
  await mkdir(join(cwd, "dist/personal-public"), { recursive: true });
  const output = join(cwd, "dist/personal-public/index.html");
  await writeFile(output, "previous reviewed output");
  await writeFile(join(cwd, "scratch/accepted-evidence-transaction.json"), "{}");
  for (const script of ["validate-data.js", "eval-dataset.js", "build.js", "export-personal-public.js", "eval-personal-public.js", "export-csv.js", "apply-drivers.js", "apply-source-entry-exclusions.js"].filter(present)) {
    const result = spawnSync(process.execPath, [join(repo, "scripts", script)], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /Pending evidence acceptance/, script);
    assert.equal(await readFile(output, "utf8"), "previous reviewed output");
  }
});
