import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compareEntries } from "../scripts/lib/accepted-evidence.js";

const shuffled = (items, seed = 1) => {
  // Deterministic shuffle, so a failure reproduces.
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// The committed ledger exists once something has been accepted. In a fresh
// tree nothing has, and ENOENT says so; any other failure is a broken read.
const committedManifest = async (t) => {
  try {
    return JSON.parse(await readFile("public/data/evidence-manifest.json", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("no committed evidence manifest: nothing accepted yet");
    return null;
  }
};

const entry = (over = {}) => ({
  date: "2026-08-05",
  source: "codex",
  origin: "machine/example",
  machine_alias: "example",
  snapshot_key: null,
  acceptance: "accepted",
  tokens: 1,
  calls: 1,
  correlation_keys: [],
  ...over
});

test("entries alike on every named key still order deterministically", () => {
  // Without a total order these compare equal, and the committed file would
  // then depend on whatever order the receipts were read in.
  const a = entry({ tokens: 10 });
  const b = entry({ tokens: 20 });
  assert.notEqual(compareEntries(a, b), 0, "identical named keys must still break the tie");
  assert.equal(Math.sign(compareEntries(a, b)), -Math.sign(compareEntries(b, a)), "must be antisymmetric");
});

test("sorting is independent of input order", () => {
  const entries = [
    entry({ tokens: 3 }),
    entry({ tokens: 1 }),
    entry({ date: "2026-08-04" }),
    entry({ source: "claude_code" }),
    entry({ origin: "machine/example-laptop" }),
    entry({ tokens: 2 })
  ];
  const canonical = [...entries].sort(compareEntries).map((e) => JSON.stringify(e));
  for (const seed of [1, 7, 99, 12345]) {
    const resorted = shuffled(entries, seed).sort(compareEntries).map((e) => JSON.stringify(e));
    assert.deepEqual(resorted, canonical, `seed ${seed} produced a different order`);
  }
});

test("the committed manifest is already in canonical order", async (t) => {
  const manifest = await committedManifest(t);
  if (!manifest) return;
  const resorted = [...manifest.entries].sort(compareEntries);
  assert.deepEqual(
    resorted.map((e) => JSON.stringify(e)),
    manifest.entries.map((e) => JSON.stringify(e)),
    "committed manifest entries are not in the order the writer would produce"
  );
});

test("no two committed entries are indistinguishable", async (t) => {
  // A duplicate here would mean the record cannot tell two receipts apart.
  const manifest = await committedManifest(t);
  if (!manifest) return;
  const seen = new Set(manifest.entries.map((e) => JSON.stringify(e)));
  assert.equal(seen.size, manifest.entries.length, "duplicate evidence entries in the committed manifest");
});
