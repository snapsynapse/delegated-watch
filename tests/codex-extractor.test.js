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
  assert.match(result.stderr, /1 duplicates skipped, 1 counter resets/);
  assert.match(result.stderr, /1 unparseable Codex JSONL line/);
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
