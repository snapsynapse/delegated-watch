import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reconcileReceipts, validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-codex.js");

// Every store location the extractor could resolve points inside the fixture,
// so the suite never reads the real rollouts of whoever runs it.
const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CODEX_HOME;
  return { cwd, home, env };
};

const run = (cwd, env, args = []) =>
  spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });

const receiptsIn = (stdout) =>
  stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const usage = (input, cached, output, total = input + output) =>
  ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: total });
const tokenCount = (timestamp, last, cumulative) =>
  JSON.stringify({ timestamp, payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: cumulative } } });
const responseItem = (timestamp, payload) =>
  JSON.stringify({ timestamp, type: "response_item", payload });
const threadSettingsApplied = (timestamp, threadId) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_id: threadId,
      thread_settings: { model: "test-model" }
    }
  });
const withOrdinal = (line, ordinal) => JSON.stringify({ ...JSON.parse(line), ordinal });
const copiedSessionMetaWithBoundary = (id, parentId, boundary, timestamp, ordinal = 0) => {
  const entry = JSON.parse(sessionMeta(id, parentId, null, timestamp));
  entry.ordinal = ordinal;
  entry.payload.forked_from_ordinal_exclusive = boundary;
  return JSON.stringify(entry);
};
const sessionMeta = (id, forkedFromId = null, historyBase = null, timestamp = "2026-01-02T07:00:00Z") =>
  JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: {
      id,
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
      ...(historyBase ? { history_base: historyBase } : {})
    }
  });

const writeRollout = async (dir, name, input, date = "2026-01-02") => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `rollout-${name}.jsonl`),
    [
      JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
      tokenCount(`${date}T07:30:00Z`, usage(input, 0, 0), usage(input, 0, 0))
    ].join("\n") + "\n"
  );
};

test("non-cached input plus output, cumulative snapshots deduped, counter resets noted", async () => {
  const { cwd, env } = await sandbox("codex-count-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  await writeFile(join(sessions, "rollout-test.jsonl"), [
    JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 40, 20), usage(100, 40, 20)),
    tokenCount("2026-01-02T07:31:00Z", usage(100, 40, 20), usage(100, 40, 20)), // repeated snapshot
    tokenCount("2026-01-02T07:32:00Z", usage(100, 0, 0), usage(200, 40, 20, 220)),
    tokenCount("2026-01-02T07:33:00Z", usage(100, 40, 20), usage(100, 40, 20)), // cumulative fell: reset
    "{not-json"
  ].join("\n"));

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.authority, "tool");
  assert.equal(receipt.machine_alias, "example-laptop");
  assert.equal(receipt.origin, "example-laptop");
  assert.equal(receipt.date, "2026-01-02");
  assert.equal(receipt.tokens, 80 + 100 + 80);
  assert.equal(receipt.calls, 3);
  assert.deepEqual(receipt.models, ["test-model"]);
  assert.match(receipt.provenance, /cached_input 80 excluded/);
  assert.match(receipt.provenance, /1 counter resets observed/);
  assert.match(result.stderr, /1 duplicates skipped, 0 inherited fork events skipped, 1 counter resets/);
  assert.match(result.stderr, /1 unparseable Codex JSONL line/);
});

test("copied fork history counts inherited token events once", async () => {
  const { cwd, env } = await sandbox("codex-copied-fork-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000001";
  const childId = "00000000-0000-0000-0000-000000000002";
  const parentHistory = [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0)),
    tokenCount("2026-01-02T07:31:00Z", usage(200, 0, 0), usage(300, 0, 0))
  ];
  await writeFile(join(sessions, "rollout-parent.jsonl"), parentHistory.join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(100, 0, 0), usage(100, 0, 0)),
    tokenCount("2026-01-03T07:00:03Z", usage(200, 0, 0), usage(300, 0, 0)),
    threadSettingsApplied("2026-01-03T07:00:04Z", childId),
    tokenCount("2026-01-03T07:32:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  assert.deepEqual(receipts.map(({ date, tokens, calls }) => ({ date, tokens, calls })), [
    { date: "2026-01-02", tokens: 300, calls: 2 },
    { date: "2026-01-03", tokens: 50, calls: 1 }
  ]);
  assert.match(result.stderr, /2 inherited fork events skipped/);

  const windowed = run(cwd, env, [
    "--sessions", sessions,
    "--tag", "example-laptop",
    "--since", "2026-01-03",
    "--dry-run"
  ]);
  assert.equal(windowed.status, 0, windowed.stderr);
  assert.deepEqual(receiptsIn(windowed.stdout).map(({ date, tokens }) => ({ date, tokens })), [
    { date: "2026-01-03", tokens: 50 }
  ]);
});

test("copied fork recognizes an inherited response item whose missing id was assigned on fork", async () => {
  const { cwd, env } = await sandbox("codex-transformed-copied-prefix-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000061";
  const childId = "00000000-0000-0000-0000-000000000062";
  await writeFile(join(sessions, "rollout-parent.jsonl"), [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0)),
    responseItem("2026-01-02T07:30:01Z", { type: "message", role: "assistant", content: [] }),
    tokenCount("2026-01-02T07:31:00Z", usage(200, 0, 0), usage(300, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(100, 0, 0), usage(100, 0, 0)),
    responseItem("2026-01-03T07:00:03Z", { id: "msg_assigned", type: "message", role: "assistant", content: [] }),
    tokenCount("2026-01-03T07:00:04Z", usage(200, 0, 0), usage(300, 0, 0)),
    threadSettingsApplied("2026-01-03T07:00:05Z", childId),
    tokenCount("2026-01-03T07:32:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(receiptsIn(result.stdout).map(({ date, tokens }) => ({ date, tokens })), [
    { date: "2026-01-02", tokens: 300 },
    { date: "2026-01-03", tokens: 50 }
  ]);
  assert.match(result.stderr, /2 inherited fork events skipped/);
  assert.doesNotMatch(result.stderr, /prefix that could not be verified/);
});

test("an identity-free copied sequence without a verified endpoint is retained as incomplete", async () => {
  const { cwd, env } = await sandbox("codex-unbounded-copied-prefix-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000071";
  const childId = "00000000-0000-0000-0000-000000000072";
  const legacySettings = JSON.stringify({
    timestamp: "2026-01-02T07:30:01Z",
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: { model: "test-model" } }
  });
  const legacyResponse = responseItem(
    "2026-01-02T07:30:02Z",
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] }
  );
  await writeFile(join(sessions, "rollout-parent.jsonl"), [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0)),
    legacySettings,
    legacyResponse,
    tokenCount("2026-01-02T07:31:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(100, 0, 0), usage(100, 0, 0)),
    legacySettings,
    legacyResponse,
    tokenCount("2026-01-03T07:31:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.tokens, 0), 300);
  const child = receipts.find((receipt) => receipt.date === "2026-01-03");
  assert.equal(child.coverage, "incomplete");
  assert.deepEqual(child.coverage_reasons, ["copied_fork_prefix_unverified"]);
  assert.match(child.provenance, /unverified fork evidence retained/);
  assert.match(result.stderr, /prefix that could not be verified/);
});

test("referenced fork counts only its local token events", async () => {
  const { cwd, env } = await sandbox("codex-referenced-fork-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000011";
  const childId = "00000000-0000-0000-0000-000000000012";
  await writeFile(join(sessions, "rollout-parent.jsonl"), [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:30:00Z", usage(300, 0, 0), usage(300, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, { end_ordinal_exclusive: 2, end_byte_offset: 500 }),
    tokenCount("2026-01-02T07:31:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 350);
  assert.equal(receipt.calls, 2);
  assert.match(result.stderr, /0 inherited fork events skipped/);
});

test("nested copied forks count each inherited prefix once", async () => {
  const { cwd, env } = await sandbox("codex-nested-fork-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const rootId = "00000000-0000-0000-0000-000000000021";
  const childId = "00000000-0000-0000-0000-000000000022";
  const grandchildId = "00000000-0000-0000-0000-000000000023";
  const rootHistory = [
    sessionMeta(rootId),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0))
  ];
  const childHistory = [
    sessionMeta(childId, rootId),
    ...rootHistory,
    threadSettingsApplied("2026-01-02T07:30:30Z", childId),
    tokenCount("2026-01-02T07:31:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ];
  await writeFile(join(sessions, "rollout-root.jsonl"), rootHistory.join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), childHistory.join("\n") + "\n");
  await writeFile(join(sessions, "rollout-grandchild.jsonl"), [
    sessionMeta(grandchildId, childId),
    ...childHistory,
    threadSettingsApplied("2026-01-02T07:31:30Z", grandchildId),
    tokenCount("2026-01-02T07:32:00Z", usage(25, 0, 0), usage(175, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 175);
  assert.equal(receipt.calls, 3);
  assert.match(result.stderr, /3 inherited fork events skipped/);
});

test("copied and referenced forks remain additive through mixed chains", async () => {
  const { cwd, env } = await sandbox("codex-mixed-fork-chains-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);

  const copiedRoot = "00000000-0000-0000-0000-000000000091";
  const copiedChild = "00000000-0000-0000-0000-000000000092";
  const referencedGrandchild = "00000000-0000-0000-0000-000000000093";
  await writeFile(join(sessions, "rollout-copied-root.jsonl"), [
    sessionMeta(copiedRoot),
    tokenCount("2026-01-02T07:00:00Z", usage(100, 0, 0), usage(100, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-copied-child.jsonl"), [
    sessionMeta(copiedChild, copiedRoot),
    sessionMeta(copiedRoot),
    tokenCount("2026-01-02T07:00:00Z", usage(100, 0, 0), usage(100, 0, 0)),
    threadSettingsApplied("2026-01-02T07:00:30Z", copiedChild),
    tokenCount("2026-01-02T07:01:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-referenced-grandchild.jsonl"), [
    sessionMeta(referencedGrandchild, copiedChild, { end_ordinal_exclusive: 4, end_byte_offset: 800 }),
    tokenCount("2026-01-02T07:02:00Z", usage(25, 0, 0), usage(175, 0, 0))
  ].join("\n") + "\n");

  const referencedRoot = "00000000-0000-0000-0000-000000000094";
  const referencedChild = "00000000-0000-0000-0000-000000000095";
  const copiedGrandchild = "00000000-0000-0000-0000-000000000096";
  const historyBase = { end_ordinal_exclusive: 2, end_byte_offset: 500 };
  const referencedMeta = sessionMeta(referencedChild, referencedRoot, historyBase);
  await writeFile(join(sessions, "rollout-referenced-root.jsonl"), [
    sessionMeta(referencedRoot),
    tokenCount("2026-01-02T08:00:00Z", usage(100, 0, 0), usage(100, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-referenced-child.jsonl"), [
    referencedMeta,
    tokenCount("2026-01-02T08:01:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-copied-grandchild.jsonl"), [
    sessionMeta(copiedGrandchild, referencedChild),
    referencedMeta,
    tokenCount("2026-01-02T08:01:00Z", usage(50, 0, 0), usage(150, 0, 0)),
    threadSettingsApplied("2026-01-02T08:01:30Z", copiedGrandchild),
    tokenCount("2026-01-02T08:02:00Z", usage(25, 0, 0), usage(175, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 350);
  assert.equal(receipt.calls, 6);
  assert.equal("coverage" in receipt, false);
});

test("ordinal boundary prevents matching into parent work added after the fork", async () => {
  const { cwd, env } = await sandbox("codex-ordinal-fork-boundary-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000101";
  const childId = "00000000-0000-0000-0000-000000000102";
  await writeFile(join(sessions, "rollout-parent.jsonl"), [
    withOrdinal(sessionMeta(parentId), 0),
    withOrdinal(tokenCount("2026-01-02T07:00:00Z", usage(100, 0, 0), usage(100, 0, 0)), 1),
    withOrdinal(tokenCount("2026-01-02T07:01:00Z", usage(50, 0, 0), usage(150, 0, 0)), 2)
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    copiedSessionMetaWithBoundary(childId, parentId, 2, "2026-01-03T07:00:00Z"),
    withOrdinal(sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"), 1),
    withOrdinal(tokenCount("2026-01-03T07:00:02Z", usage(100, 0, 0), usage(100, 0, 0)), 2),
    withOrdinal(threadSettingsApplied("2026-01-03T07:00:03Z", childId), 3),
    withOrdinal(tokenCount("2026-01-03T07:01:00Z", usage(50, 0, 0), usage(150, 0, 0)), 4)
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receiptsIn(result.stdout).reduce((sum, receipt) => sum + receipt.tokens, 0), 200);
  assert.doesNotMatch(result.stderr, /could not be verified/);
});

test("a counter reset immediately after a verified copied prefix preserves new usage", async () => {
  const { cwd, env } = await sandbox("codex-copied-prefix-reset-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000111";
  const childId = "00000000-0000-0000-0000-000000000112";
  await writeFile(join(sessions, "rollout-parent.jsonl"), [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:00:00Z", usage(300, 0, 0), usage(300, 0, 0))
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(300, 0, 0), usage(300, 0, 0)),
    threadSettingsApplied("2026-01-03T07:00:03Z", childId),
    tokenCount("2026-01-03T07:01:00Z", usage(50, 0, 0), usage(50, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receiptsIn(result.stdout).reduce((sum, receipt) => sum + receipt.tokens, 0), 350);
  assert.match(result.stderr, /1 counter resets/);
});

test("a copied fork with a missing parent retains its surviving prefix", async () => {
  const { cwd, env } = await sandbox("codex-missing-copied-parent-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const missingId = "00000000-0000-0000-0000-000000000031";
  const childId = "00000000-0000-0000-0000-000000000032";
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, missingId),
    sessionMeta(missingId),
    tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0)),
    tokenCount("2026-01-02T07:31:00Z", usage(200, 0, 0), usage(300, 0, 0)),
    tokenCount("2026-01-02T07:32:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 350);
  assert.equal(receipt.calls, 3);
  assert.equal(receipt.coverage, "incomplete");
  assert.deepEqual(receipt.coverage_reasons, ["copied_fork_parent_missing"]);
  assert.match(receipt.provenance, /unverified fork evidence retained/);
  assert.doesNotMatch(receipt.provenance, /lineage-confirmed copied-fork prefixes excluded/);
  assert.match(result.stderr, /missing parent rollout/);
  assert.match(result.stderr, /may duplicate inherited usage and its original dates are unknown/);
  assert.match(result.stderr, /0 inherited fork events skipped/);
});

test("a referenced fork with a missing parent reports uncovered history without inventing it", async () => {
  const { cwd, env } = await sandbox("codex-missing-referenced-parent-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const missingId = "00000000-0000-0000-0000-000000000041";
  const childId = "00000000-0000-0000-0000-000000000042";
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, missingId, { end_ordinal_exclusive: 3, end_byte_offset: 800 }),
    tokenCount("2026-01-02T07:32:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 50);
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.coverage, "incomplete");
  assert.deepEqual(receipt.coverage_reasons, ["referenced_fork_parent_missing"]);
  assert.match(result.stderr, /referenced parent usage remains uncovered/);
});

test("ambiguous copied lineage retains evidence with durable incomplete coverage", async () => {
  const { cwd, env } = await sandbox("codex-ambiguous-copied-parent-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000081";
  const childId = "00000000-0000-0000-0000-000000000082";
  for (const suffix of ["a", "b"]) {
    await writeFile(join(sessions, `rollout-parent-${suffix}.jsonl`), [
      sessionMeta(parentId),
      tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0))
    ].join("\n") + "\n");
  }
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(100, 0, 0), usage(100, 0, 0)),
    threadSettingsApplied("2026-01-03T07:00:03Z", childId),
    tokenCount("2026-01-03T07:32:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const child = receiptsIn(result.stdout).find((receipt) => receipt.date === "2026-01-03");
  assert.equal(child.tokens, 150);
  assert.equal(child.coverage, "incomplete");
  assert.deepEqual(child.coverage_reasons, ["copied_fork_parent_ambiguous"]);
  assert.match(result.stderr, /multiple candidate parent rollouts/);
});

test("ambiguous referenced lineage keeps local usage and marks parent coverage incomplete", async () => {
  const { cwd, env } = await sandbox("codex-ambiguous-referenced-parent-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const parentId = "00000000-0000-0000-0000-000000000083";
  const childId = "00000000-0000-0000-0000-000000000084";
  for (const suffix of ["a", "b"]) {
    await writeFile(join(sessions, `rollout-parent-${suffix}.jsonl`), [
      sessionMeta(parentId),
      tokenCount("2026-01-02T07:30:00Z", usage(100, 0, 0), usage(100, 0, 0))
    ].join("\n") + "\n");
  }
  await writeFile(join(sessions, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, { end_ordinal_exclusive: 2, end_byte_offset: 500 }, "2026-01-03T07:00:00Z"),
    tokenCount("2026-01-03T07:32:00Z", usage(50, 0, 0), usage(150, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const child = receiptsIn(result.stdout).find((receipt) => receipt.date === "2026-01-03");
  assert.equal(child.tokens, 50);
  assert.equal(child.coverage, "incomplete");
  assert.deepEqual(child.coverage_reasons, ["referenced_fork_parent_ambiguous"]);
  assert.match(result.stderr, /referenced fork.*multiple candidate parent rollouts/);
});

test("unrelated rollouts with equal token events remain additive", async () => {
  const { cwd, env } = await sandbox("codex-equal-independent-");
  const sessions = join(cwd, "sessions");
  await mkdir(sessions);
  const event = tokenCount("2026-01-02T07:30:00Z", usage(300, 0, 0), usage(300, 0, 0));
  await writeFile(join(sessions, "rollout-a.jsonl"), [
    sessionMeta("00000000-0000-0000-0000-000000000051"),
    event
  ].join("\n") + "\n");
  await writeFile(join(sessions, "rollout-b.jsonl"), [
    sessionMeta("00000000-0000-0000-0000-000000000052"),
    event
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--sessions", sessions, "--tag", "example-laptop", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = receiptsIn(result.stdout);
  assert.equal(receipt.tokens, 600);
  assert.equal(receipt.calls, 2);
});

test("a custom root must say whose store it is", async () => {
  const { cwd, env } = await sandbox("codex-identity-");
  const sessions = join(cwd, "copied-store");
  await writeRollout(sessions, "a", 100);

  const missing = run(cwd, env, ["--sessions", sessions, "--dry-run"]);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /--sessions needs an explicit store identity/);

  const local = run(cwd, env, ["--sessions", sessions, "--local-store", "--dry-run"]);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(receiptsIn(local.stdout).length, 1);

  assert.equal(run(cwd, env, ["--sessions", join(cwd, "typo"), "--local-store"]).status, 66);
});

test("distinct tagged stores sum, while a second copy of one store dedupes", async () => {
  const { cwd, env } = await sandbox("codex-sum-");
  await writeRollout(join(cwd, "first"), "first", 100);
  await writeRollout(join(cwd, "second"), "second", 200);
  const extract = (dir, tag) => receiptsIn(run(cwd, env, ["--sessions", dir, "--tag", tag, "--dry-run"]).stdout)[0];

  const first = extract(join(cwd, "first"), "laptop-a");
  const second = extract(join(cwd, "second"), "laptop-b");
  const backup = extract(join(cwd, "first"), "laptop-a");
  assert.notEqual(first.snapshot_key, second.snapshot_key);
  assert.equal(backup.snapshot_key, first.snapshot_key);

  const reconciled = reconcileReceipts([
    { ...first, _where: "first.jsonl:1" },
    { ...second, _where: "second.jsonl:1" },
    { ...backup, _where: "backup.jsonl:1" }
  ]);
  assert.deepEqual(reconciled.errors, []);
  assert.equal(reconciled.receipts.reduce((sum, receipt) => sum + receipt.tokens, 0), 300);
});

test("CODEX_HOME is the default store, and a rollout in both sessions and the archive counts once", async () => {
  const { cwd, env } = await sandbox("codex-home-");
  env.CODEX_HOME = join(cwd, "relocated-codex");
  await writeRollout(join(env.CODEX_HOME, "sessions", "2026", "01", "02"), "thread-1", 100);
  await writeRollout(join(env.CODEX_HOME, "archived_sessions"), "thread-1", 100);
  await writeRollout(join(env.CODEX_HOME, "archived_sessions"), "thread-2", 50);

  const result = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), ["codex-fixture_user.jsonl"]);
  const receipt = JSON.parse(await readFile(join(cwd, "scratch", "receipts", "codex-fixture_user.jsonl"), "utf8"));
  assert.equal(receipt.tokens, 150);
  assert.equal(receipt.calls, 2);
});

test("a copied fork still dedupes when its parent exists in live and archived stores", async () => {
  const { cwd, env } = await sandbox("codex-live-archive-fork-");
  env.CODEX_HOME = join(cwd, "relocated-codex");
  const live = join(env.CODEX_HOME, "sessions", "2026", "01", "03");
  const archive = join(env.CODEX_HOME, "archived_sessions");
  await mkdir(live, { recursive: true });
  await mkdir(archive, { recursive: true });
  const parentId = "00000000-0000-0000-0000-000000000121";
  const childId = "00000000-0000-0000-0000-000000000122";
  const parent = [
    sessionMeta(parentId),
    tokenCount("2026-01-02T07:00:00Z", usage(300, 0, 0), usage(300, 0, 0))
  ].join("\n") + "\n";
  await writeFile(join(live, "rollout-parent.jsonl"), parent);
  await writeFile(join(archive, "rollout-parent.jsonl"), parent);
  await writeFile(join(live, "rollout-child.jsonl"), [
    sessionMeta(childId, parentId, null, "2026-01-03T07:00:00Z"),
    sessionMeta(parentId, null, null, "2026-01-03T07:00:01Z"),
    tokenCount("2026-01-03T07:00:02Z", usage(300, 0, 0), usage(300, 0, 0)),
    threadSettingsApplied("2026-01-03T07:00:03Z", childId),
    tokenCount("2026-01-03T07:01:00Z", usage(50, 0, 0), usage(350, 0, 0))
  ].join("\n") + "\n");

  const result = run(cwd, env, ["--tag", "fixture/user", "--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receiptsIn(result.stdout).reduce((sum, receipt) => sum + receipt.tokens, 0), 350);
  assert.match(result.stderr, /2 rollout file\(s\)/);
  assert.match(result.stderr, /1 inherited fork events skipped/);
});

test("a store that does not exist is reported as not found, and nothing is written", async () => {
  const { cwd, env } = await sandbox("codex-absent-");
  const result = run(cwd, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sessions: not found/);
  assert.match(result.stdout, /archived_sessions: not found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });
});

test("an unreadable store exits 3, is reported as unknown, and leaves the previous receipts untouched", async (t) => {
  if (process.getuid?.() === 0) return t.skip("permissions do not bind root");
  const { cwd, env } = await sandbox("codex-eacces-");
  const locked = join(env.HOME, ".codex", "sessions");
  await mkdir(locked, { recursive: true });
  const previous = join(cwd, "scratch", "receipts", "codex-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  await chmod(locked, 0o000);
  try {
    const result = run(cwd, env, ["--tag", "fixture/user"]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /UNREADABLE \(EACCES\)/);
    assert.match(result.stderr, /UNKNOWN, not zero/);
  } finally {
    await chmod(locked, 0o755);
  }
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");
});
