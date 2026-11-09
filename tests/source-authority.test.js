// A daily source entry records where its counter came from: the weakest
// authority of the receipts that formed it, the way fidelity falls to
// estimated when any part is estimated. Any contributor without an authority
// leaves the entry without one, so an unlabelled part never borrows a
// stronger part's label.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateDataset } from "../scripts/lib/dataset-validation.js";
import { AUTHORITY_LEVELS, weakestAuthority } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");

const receipt = ({ origin, authority, fidelity = "exact", tokens }) => ({
  schema_version: 2,
  date: "2025-03-04",
  timezone: "UTC",
  source: "codex",
  provider: "openai",
  surface: "cli",
  account_alias: "example",
  origin,
  snapshot_key: `synthetic:codex:2025-03-04:${origin}`,
  authority,
  interval: { start: "2025-03-04", end: "2025-03-04" },
  tokens,
  calls: 1,
  fidelity,
  provenance: "synthetic: authority test"
});

async function importReceipts(t, receipts) {
  const cwd = await mkdtemp(join(tmpdir(), "dw-authority-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  await writeFile(join(cwd, "public/data/daily-burn.json"), "[]\n");
  await writeFile(join(cwd, "input.jsonl"), receipts.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const result = spawnSync(process.execPath, [join(repo, "scripts/import-daily-burn.js"), "input.jsonl"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [row] = JSON.parse(await readFile(join(cwd, "public/data/daily-burn.json"), "utf8"));
  return row.sources.codex;
}

test("weakestAuthority takes the weakest, and none when any part has none", () => {
  assert.deepEqual(AUTHORITY_LEVELS, ["estimated", "reconstructed", "tool", "provider"]);
  assert.equal(weakestAuthority([{ authority: "provider" }, { authority: "tool" }]), "tool");
  assert.equal(weakestAuthority([{ authority: "tool" }, { authority: "estimated" }]), "estimated");
  assert.equal(weakestAuthority([{ authority: "provider" }]), "provider");
  assert.equal(weakestAuthority([{ authority: "provider" }, {}]), null);
  assert.equal(weakestAuthority([{ authority: "bogus" }]), null);
  assert.equal(weakestAuthority([]), null);
});

test("an entry from one provider receipt records provider authority", async (t) => {
  const entry = await importReceipts(t, [receipt({ origin: "machine/example", authority: "provider", tokens: 100 })]);
  assert.equal(entry.authority, "provider");
});

test("an entry merged from tool and estimated receipts records the weaker, estimated", async (t) => {
  const entry = await importReceipts(t, [
    receipt({ origin: "machine/example", authority: "tool", tokens: 100 }),
    receipt({ origin: "machine/example-laptop", authority: "estimated", fidelity: "estimated", tokens: 40 })
  ]);
  assert.equal(entry.tokens, 140);
  assert.equal(entry.fidelity, "estimated");
  assert.equal(entry.authority, "estimated");
});

test("an entry with a contributor that carries no authority records none", async (t) => {
  const unversioned = { date: "2025-03-04", timezone: "UTC", source: "codex", tokens: 40, calls: 1, fidelity: "exact", origin: "machine/example-laptop" };
  const entry = await importReceipts(t, [receipt({ origin: "machine/example", authority: "provider", tokens: 100 }), unversioned]);
  assert.equal(entry.tokens, 140);
  assert.equal(Object.hasOwn(entry, "authority"), false);
});

test("the dataset accepts the four authorities and refuses anything else", () => {
  const row = (authority) => [{
    date: "2025-03-04", timezone: "UTC", driver: "unreviewed", evidence: "synthetic: authority test", total: 10,
    sources: { codex: { tokens: 10, calls: 1, fidelity: "exact", ...(authority === undefined ? {} : { authority }) } }
  }];
  for (const authority of [undefined, ...AUTHORITY_LEVELS]) assert.deepEqual(validateDataset(row(authority)), [], String(authority));
  assert.match(validateDataset(row("self_reported")).join("\n"), /authority must be estimated, reconstructed, tool, provider when present/);
});
