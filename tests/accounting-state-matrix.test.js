import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_JOURNAL_PATH,
  ACCEPTED_DATA_PATH,
  ACCEPTED_MANIFEST_PATH,
  acceptDataset,
  recoverDataAcceptance,
  validateAcceptedManifest
} from "../scripts/lib/accepted-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerModule = join(repo, "scripts/lib/accepted-evidence.js");
const dataPath = ACCEPTED_DATA_PATH;
const identity = (letter) => `sha256:${letter.repeat(64)}`;

const receipt = ({
  date = "2026-02-01",
  source = "codex",
  tokens = 10,
  calls = 1,
  snapshot = `${source}:primary:${date}`,
  account = "primary",
  keys = [identity("a")]
} = {}) => ({
  schema_version: 2,
  date,
  timezone: "UTC",
  source,
  provider: source === "codex" ? "openai" : "anthropic",
  surface: source,
  account_alias: account,
  origin: "machine/test",
  snapshot_key: snapshot,
  authority: "provider",
  interval: { start: date, end: date },
  fidelity: "exact",
  tokens,
  calls,
  correlation_keys: keys
});

const rowsFor = (receipts) => {
  const buckets = new Map();
  for (const item of receipts) {
    const bucket = buckets.get(item.date) ?? {};
    const current = bucket[item.source] ?? { tokens: 0, calls: 0, fidelity: "exact" };
    current.tokens += item.tokens;
    current.calls += item.calls;
    bucket[item.source] = current;
    buckets.set(item.date, bucket);
  }
  return [...buckets]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, sources]) => ({
      date,
      timezone: "UTC",
      sources,
      total: Object.values(sources).reduce((sum, entry) => sum + entry.tokens, 0),
      driver: "unreviewed",
      evidence: "synthetic test"
    }));
};

const fixture = async (rows) => {
  const root = await mkdtemp(join(tmpdir(), "delegated-watch-state-matrix-"));
  await mkdir(join(root, "public/data"), { recursive: true });
  await writeFile(join(root, dataPath), JSON.stringify(rows, null, 2) + "\n");
  return root;
};

const optionalBytes = async (path) => {
  try {
    return { present: true, text: await readFile(path, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, text: "" };
    throw error;
  }
};

const canonicalBytes = async (root) => ({
  data: await optionalBytes(join(root, dataPath)),
  manifest: await optionalBytes(join(root, ACCEPTED_MANIFEST_PATH))
});

const assertCoherentPair = async (root, message) => {
  const rows = JSON.parse(await readFile(join(root, dataPath), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, ACCEPTED_MANIFEST_PATH), "utf8"));
  const { entries } = validateAcceptedManifest(manifest);
  for (const row of rows) {
    for (const [source, expected] of Object.entries(row.sources)) {
      const active = entries.filter((entry) =>
        entry.acceptance === "accepted" &&
        entry.disposition !== "excluded" &&
        entry.disposition !== "corrected-out" &&
        entry.date === row.date &&
        entry.source === source
      );
      assert.equal(active.reduce((sum, entry) => sum + entry.tokens, 0), expected.tokens, message);
      assert.equal(active.reduce((sum, entry) => sum + (entry.calls ?? 0), 0), expected.calls, message);
    }
  }
};

const shuffled = (items, seed) => {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
};

test("seeded receipt-order permutations produce one deterministic coherent ledger", async (t) => {
  const receipts = [
    receipt({ tokens: 4, keys: [identity("a")], snapshot: "codex:a" }),
    receipt({ tokens: 6, keys: [identity("b")], snapshot: "codex:b" }),
    receipt({ date: "2026-02-02", source: "claude_api", tokens: 7, keys: [identity("c")] })
  ];
  const rows = rowsFor(receipts);
  let reference;
  for (const seed of [1, 7, 42, 8675309]) {
    const root = await fixture(rows);
    t.after(() => rm(root, { recursive: true, force: true }));
    await acceptDataset({ beforeRows: rows, rows, receipts: shuffled(receipts, seed), root });
    await assertCoherentPair(root, `coherence failure for seed ${seed}`);
    const manifest = (await canonicalBytes(root)).manifest.text;
    if (reference === undefined) reference = manifest;
    else assert.equal(manifest, reference, `manifest order differs for seed ${seed}`);
  }
});

test("duplicate replay is byte-stable while scope collisions fail closed", async (t) => {
  const original = receipt();
  const rows = rowsFor([original]);
  const root = await fixture(rows);
  t.after(() => rm(root, { recursive: true, force: true }));
  await acceptDataset({ beforeRows: rows, rows, receipts: [original], root });
  const accepted = await canonicalBytes(root);

  const replay = await acceptDataset({ beforeRows: rows, rows, receipts: [original], root });
  assert.equal(replay.changes.replay, 1);
  assert.deepEqual(await canonicalBytes(root), accepted);

  const collision = receipt({ account: "secondary", snapshot: original.snapshot_key });
  await assert.rejects(
    acceptDataset({ beforeRows: rows, rows, receipts: [collision], root }),
    /different scope or day/
  );
  assert.deepEqual(await canonicalBytes(root), accepted);
});

test("evolving snapshots retain history and finish as a coherent canonical pair", async (t) => {
  const first = receipt({ tokens: 10, calls: 1, keys: [identity("a")] });
  const firstRows = rowsFor([first]);
  const root = await fixture(firstRows);
  t.after(() => rm(root, { recursive: true, force: true }));
  await acceptDataset({ beforeRows: firstRows, rows: firstRows, receipts: [first], root });

  const evolved = receipt({ tokens: 18, calls: 2, keys: [identity("b"), identity("a")] });
  const evolvedRows = rowsFor([evolved]);
  const result = await acceptDataset({
    beforeRows: firstRows,
    rows: evolvedRows,
    receipts: [evolved],
    root
  });
  assert.equal(result.changes.updated, 1);
  assert.deepEqual(result.manifest.entries[0].correlation_keys, [identity("a"), identity("b")]);
  assert.deepEqual(result.manifest.entries[0].superseded_snapshots, [{
    tokens: 10,
    calls: 1,
    correlation_keys: [identity("a")]
  }]);
  await assertCoherentPair(root, "evolved snapshot must agree with final dataset");
});

const interruptedAcceptance = (root) => {
  const code = `
    import { readFile } from "node:fs/promises";
    import { acceptDataset } from ${JSON.stringify(`file://${ledgerModule}`)};
    const root = process.argv[1];
    const rows = JSON.parse(await readFile(root + "/${dataPath}", "utf8"));
    await acceptDataset({ beforeRows: rows, rows, receipts: [${JSON.stringify(receipt())}], root });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, root], {
    encoding: "utf8",
    env: { ...process.env, DELEGATED_WATCH_ACCEPT_INTERRUPT: "after-first-file" }
  });
};

for (const { label, kind } of [
  { label: "truncated journal", kind: "truncated" },
  { label: "journal with an invalid byte record", kind: "invalid-byte-record" }
]) {
  test(`recovery refuses a ${label} without changing canonical bytes`, async (t) => {
    const rows = rowsFor([receipt()]);
    const root = await fixture(rows);
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = interruptedAcceptance(root);
    assert.notEqual(child.status, 0);
    const beforeRecovery = await canonicalBytes(root);
    const journalPath = join(root, ACCEPTANCE_JOURNAL_PATH);
    if (kind === "truncated") {
      await writeFile(journalPath, "{\"version\":1,");
    } else {
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.files[0].after.sha256 = "0".repeat(64);
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
    }
    await assert.rejects(
      recoverDataAcceptance({ mode: "complete", root }),
      kind === "truncated" ? /not valid JSON/ : /does not match its size and hash/
    );
    assert.deepEqual(await canonicalBytes(root), beforeRecovery);
  });
}
