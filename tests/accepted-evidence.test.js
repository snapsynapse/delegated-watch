import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_JOURNAL_PATH,
  ACCEPTANCE_LOCK_PATH,
  ACCEPTED_MANIFEST_PATH,
  acceptDataset,
  assertNoPendingAcceptance,
  checkEvidenceOverlap,
  recoverDataAcceptance
} from "../scripts/lib/accepted-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerModule = join(repo, "scripts/lib/accepted-evidence.js");
const manifestCommand = join(repo, "scripts/build-evidence-manifest.js");
const key = (letter) => `sha256:${letter.repeat(64)}`;

const row = (date, source, tokens, calls = 1) => ({
  date,
  timezone: "UTC",
  sources: { [source]: { tokens, calls, fidelity: "exact" } },
  total: tokens,
  driver: "unreviewed",
  evidence: "synthetic test"
});

const receipt = ({
  date = "2026-01-01",
  source = "codex",
  tokens = 10,
  calls = 1,
  snapshot = `${source}:primary:test:${date}`,
  keys = [key("a")],
  origin = "machine/test"
} = {}) => ({
  schema_version: 2,
  date,
  timezone: "UTC",
  source,
  provider: source === "codex" ? "openai" : "test",
  surface: source === "codex" ? "codex" : source,
  account_alias: "primary",
  origin,
  snapshot_key: snapshot,
  authority: "provider",
  interval: { start: date, end: date },
  fidelity: "exact",
  tokens,
  calls,
  correlation_keys: keys
});

const emptyManifest = () => ({
  note: "test",
  dedupe_levels: {},
  receipts: 0,
  identified_requests: 0,
  malformed_receipt_lines: 0,
  coverage: {},
  entries: []
});

const makeFixture = async ({ rows = [row("2026-01-01", "codex", 10)] } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "delegated-watch-acceptance-"));
  await mkdir(join(root, "public/data"), { recursive: true });
  await writeFile(
    join(root, "public/data/daily-burn.json"),
    JSON.stringify(rows, null, 2) + "\n"
  );
  return root;
};

const readJson = async (root, relative) =>
  JSON.parse(await readFile(join(root, relative), "utf8"));

const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

test("acceptance initializes a durable ledger and retains identities after receipts disappear", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const beforeRows = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({ beforeRows, rows: beforeRows, receipts: [receipt()], root });
  const first = await readJson(root, ACCEPTED_MANIFEST_PATH);
  assert.equal(first.ledger.accepted_receipts, 1);
  assert.deepEqual(first.entries[0].correlation_keys, [key("a")]);

  await acceptDataset({ beforeRows, rows: beforeRows, receipts: [], root });
  const second = await readJson(root, ACCEPTED_MANIFEST_PATH);
  assert.deepEqual(second.entries, first.entries);
});

test("legacy identities remain labelled unverified while new accepted evidence is added", async (t) => {
  const rows = [
    {
      ...row("2026-01-01", "codex", 15),
      sources: {
        codex: { tokens: 10, calls: 1, fidelity: "exact" },
        test_api: { tokens: 5, calls: 1, fidelity: "exact" }
      },
      total: 15
    }
  ];
  const root = await makeFixture({ rows });
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = receipt();
  const manifest = emptyManifest();
  manifest.receipts = 1;
  manifest.identified_requests = 1;
  manifest.entries = [legacy];
  manifest.coverage = { codex: {} };
  await writeFile(
    join(root, ACCEPTED_MANIFEST_PATH),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  const incoming = receipt({
    source: "test_api",
    tokens: 5,
    snapshot: "test:primary:2026-01-01",
    keys: [key("b")]
  });
  await acceptDataset({ beforeRows: rows, rows, receipts: [incoming], root });
  const accepted = await readJson(root, ACCEPTED_MANIFEST_PATH);
  assert.equal(accepted.ledger.accepted_receipts, 1);
  assert.equal(accepted.ledger.legacy_unverified_receipts, 1);
  assert.equal(
    accepted.entries.find((entry) => entry.source === "codex").acceptance,
    "legacy-unverified"
  );
});

test("same snapshot advances monotonically and retains prior request keys", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRows = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({ beforeRows: firstRows, rows: firstRows, receipts: [receipt()], root });
  const secondRows = [row("2026-01-01", "codex", 15, 2)];
  await acceptDataset({
    beforeRows: firstRows,
    rows: secondRows,
    receipts: [receipt({ tokens: 15, calls: 2, keys: [key("a"), key("b")] })],
    root
  });
  const manifest = await readJson(root, ACCEPTED_MANIFEST_PATH);
  assert.equal(manifest.entries[0].tokens, 15);
  assert.deepEqual(manifest.entries[0].correlation_keys, [key("a"), key("b")]);
  assert.deepEqual(manifest.entries[0].superseded_snapshots[0].correlation_keys, [key("a")]);
});

test("an exact current snapshot replay leaves the accepted manifest byte-identical", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = await readJson(root, "public/data/daily-burn.json");
  const incoming = receipt();
  await acceptDataset({ beforeRows: rows, rows, receipts: [incoming], root });
  const before = await readFile(join(root, ACCEPTED_MANIFEST_PATH), "utf8");

  const replay = await acceptDataset({ beforeRows: rows, rows, receipts: [incoming], root });

  assert.deepEqual(replay.changes, { added: 0, updated: 0, promoted: 0, replay: 1 });
  assert.equal(await readFile(join(root, ACCEPTED_MANIFEST_PATH), "utf8"), before);
});

test("snapshot-only overlap reporting distinguishes exact, historical, evolved, and unrecorded versions", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = await readJson(root, "public/data/daily-burn.json");
  const current = receipt({ keys: [] });
  await acceptDataset({ beforeRows: rows, rows, receipts: [current], root });
  const manifest = await readJson(root, ACCEPTED_MANIFEST_PATH);

  const exact = checkEvidenceOverlap(manifest, [current]);
  assert.equal(exact.replay_receipts, 1);
  assert.equal(exact.evolved_snapshots, 0);

  const evolved = checkEvidenceOverlap(manifest, [receipt({ tokens: 15, calls: 2, keys: [] })]);
  assert.equal(evolved.evolved_snapshots, 1);
  assert.equal(evolved.replay_receipts, 0);

  const old = checkEvidenceOverlap(manifest, [receipt({ tokens: 5, calls: 0, keys: [] })]);
  assert.equal(old.replay_receipts, 0);
  assert.equal(old.snapshot_variants.length, 1);

  const crossing = checkEvidenceOverlap(manifest, [receipt({ tokens: 15, calls: 0, keys: [] })]);
  assert.equal(crossing.conflicts.length, 1);

  const newSnapshot = checkEvidenceOverlap(manifest, [receipt({ snapshot: "codex:primary:other:2026-01-01", keys: [] })]);
  assert.equal(newSnapshot.new_requests, 0);
  assert.equal(newSnapshot.new_snapshots, 1);

  const incoming = join(root, "incoming.jsonl");
  await writeFile(incoming, JSON.stringify(receipt({ snapshot: "codex:primary:other:2026-01-01", keys: [] })) + "\n");
  const newSnapshotCheck = spawnSync(process.execPath, [manifestCommand, "--check", incoming], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(newSnapshotCheck.status, 0, newSnapshotCheck.stderr);
  assert.match(newSnapshotCheck.stdout, /new: 0 requests, 1 snapshots/);

  await writeFile(incoming, JSON.stringify(receipt({ tokens: 5, calls: 0, keys: [] })) + "\n");
  const oldSnapshotCheck = spawnSync(process.execPath, [manifestCommand, "--check", incoming], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(oldSnapshotCheck.status, 1);
  assert.match(oldSnapshotCheck.stderr, /UNRECOGNISED SNAPSHOT HISTORY/);
});

test("a forward same-key snapshot update remains an evolution under accepted snapshot semantics", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = await readJson(root, "public/data/daily-burn.json");
  const current = receipt();
  await acceptDataset({ beforeRows: rows, rows, receipts: [current], root });
  const manifest = await readJson(root, ACCEPTED_MANIFEST_PATH);

  const evolved = checkEvidenceOverlap(manifest, [receipt({ tokens: 15, calls: 2 })]);
  assert.equal(evolved.evolved_snapshots, 1);
  assert.equal(evolved.conflicts.length, 0);
});

test("a recorded prior snapshot version is reported as a replay, not an evolution", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRows = await readJson(root, "public/data/daily-burn.json");
  const first = receipt({ keys: [] });
  await acceptDataset({ beforeRows: firstRows, rows: firstRows, receipts: [first], root });
  const currentRows = [row("2026-01-01", "codex", 15, 2)];
  const current = receipt({ tokens: 15, calls: 2, keys: [] });
  await acceptDataset({ beforeRows: firstRows, rows: currentRows, receipts: [current], root });
  const manifest = await readJson(root, ACCEPTED_MANIFEST_PATH);

  const historical = checkEvidenceOverlap(manifest, [first]);
  assert.equal(historical.replay_receipts, 1);
  assert.equal(historical.replayed_older_snapshots, 1);
  assert.equal(historical.evolved_snapshots, 0);
});

test("partial request overlap across accepted snapshots fails closed", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({
    beforeRows: before,
    rows: before,
    receipts: [
      receipt({ tokens: 4, calls: 1, snapshot: "snap-1", keys: [key("a")] }),
      receipt({ tokens: 6, calls: 0, snapshot: "snap-2", keys: [key("b")] })
    ],
    root
  });
  await assert.rejects(
    acceptDataset({
      beforeRows: before,
      rows: before,
      receipts: [
        receipt({ tokens: 7, calls: 1, snapshot: "snap-1", keys: [key("a"), key("b")] }),
        receipt({ tokens: 3, calls: 0, snapshot: "snap-2", keys: [key("b")] })
      ],
      root
    }),
    /another accepted snapshot|Partial historic request overlap/
  );
});

test("the same request identity on a different day fails closed", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({ beforeRows: before, rows: before, receipts: [receipt()], root });
  const after = [...before, row("2026-01-02", "codex", 5)];
  await assert.rejects(
    acceptDataset({
      beforeRows: before,
      rows: after,
      receipts: [receipt({ date: "2026-01-02", tokens: 5, keys: [key("a")] })],
      root
    }),
    /crosses scope or day/
  );
});

const crashAcceptance = (root, point) => {
  const code = `
    import { readFile } from "node:fs/promises";
    import { acceptDataset } from ${JSON.stringify(`file://${ledgerModule}`)};
    const root = process.argv[1];
    const rows = JSON.parse(await readFile(root + "/public/data/daily-burn.json", "utf8"));
    const receipt = ${JSON.stringify(receipt())};
    await acceptDataset({ beforeRows: rows, rows, receipts: [receipt], root });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, root], {
    encoding: "utf8",
    env: { ...process.env, DELEGATED_WATCH_ACCEPT_INTERRUPT: point }
  });
};

test("interruption after the first canonical write completes to a coherent pair", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = crashAcceptance(root, "after-first-file");
  assert.notEqual(child.status, 0);
  assert.equal(await pathExists(join(root, ACCEPTANCE_JOURNAL_PATH)), true);
  await assert.rejects(assertNoPendingAcceptance(root), /Pending evidence acceptance/);
  await recoverDataAcceptance({ mode: "complete", root });
  assert.equal(await pathExists(join(root, ACCEPTANCE_JOURNAL_PATH)), false);
  assert.equal(await pathExists(join(root, ACCEPTANCE_LOCK_PATH)), false);
  assert.equal((await readJson(root, ACCEPTED_MANIFEST_PATH)).ledger.accepted_receipts, 1);
});

test("interruption before canonical writes rolls back without creating a manifest", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readFile(join(root, "public/data/daily-burn.json"), "utf8");
  const child = crashAcceptance(root, "before-files");
  assert.notEqual(child.status, 0);
  await recoverDataAcceptance({ mode: "rollback", root });
  assert.equal(await readFile(join(root, "public/data/daily-burn.json"), "utf8"), before);
  assert.equal(await pathExists(join(root, ACCEPTED_MANIFEST_PATH)), false);
});

test("recovery refuses a live writer and explicitly clears a demonstrably stale journal-free lock", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, ACCEPTANCE_LOCK_PATH);
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, hostname: hostname(), transaction_id: "live" }) + "\n"
  );
  await assert.rejects(
    recoverDataAcceptance({ mode: "complete", root }),
    /writer PID .* is live/
  );
  await rm(lock, { recursive: true });
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, hostname: hostname(), transaction_id: "stale" }) + "\n"
  );
  const result = await recoverDataAcceptance({ mode: "rollback", root });
  assert.equal(result.lock_only, true);
  assert.equal(await pathExists(lock), false);
});

test("manifest check reads only ledger and incoming file and fails malformed or uncheckable input", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({ beforeRows: rows, rows, receipts: [receipt()], root });
  const incoming = join(root, "incoming.jsonl");
  await writeFile(incoming, JSON.stringify(receipt()) + "\n");
  const replay = spawnSync(process.execPath, [manifestCommand, "--check", incoming], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(replay.status, 2, replay.stderr);
  assert.match(replay.stdout, /already counted/);
  assert.equal(await pathExists(join(root, "scratch/receipts")), false);

  await writeFile(incoming, "{not-json\n");
  const malformed = spawnSync(process.execPath, [manifestCommand, "--check", incoming], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(malformed.status, 1);

  const blind = receipt({ snapshot: null, keys: [] });
  delete blind.snapshot_key;
  delete blind.schema_version;
  await writeFile(incoming, JSON.stringify(blind) + "\n");
  const uncheckable = spawnSync(process.execPath, [manifestCommand, "--check", incoming], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(uncheckable.status, 1);
  assert.match(uncheckable.stderr, /UNCHECKABLE/);
});

test("an identity-free figure changes only under a recorded correction, and supersedes rather than overwrites", async (t) => {
  const identityFree = (tokens) => {
    const base = receipt({
      source: "claude_api",
      tokens,
      calls: null,
      snapshot: null,
      keys: []
    });
    delete base.snapshot_key;
    return base;
  };
  const root = await makeFixture({
    rows: [row("2026-01-01", "claude_api", 10, null)]
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const beforeRows = await readJson(root, "public/data/daily-burn.json");
  await acceptDataset({ beforeRows, rows: beforeRows, receipts: [identityFree(10)], root });

  const revisedRows = [row("2026-01-01", "claude_api", 12, null)];
  await assert.rejects(
    acceptDataset({ beforeRows, rows: revisedRows, receipts: [identityFree(12)], root }),
    /cannot be distinguished from previously accepted evidence/
  );

  await acceptDataset({
    beforeRows,
    rows: revisedRows,
    receipts: [identityFree(12)],
    correction: { confirmed: true, reason: "provider revised the day" },
    root
  });
  const manifest = await readJson(root, ACCEPTED_MANIFEST_PATH);
  const entry = manifest.entries.find((item) => item.source === "claude_api");
  assert.equal(entry.tokens, 12);
  assert.equal(entry.acceptance_basis, "identity-free-correction-after-review");
  assert.equal(entry.correction.reason, "provider revised the day");
  assert.deepEqual(entry.superseded_snapshots.map((version) => version.tokens), [10]);
});
