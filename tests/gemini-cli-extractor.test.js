// Gemini CLI and Qwen Code sessions, in the record shapes Gemini CLI 0.58.0
// writes. Every store here is a synthetic fixture under a temporary home.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-gemini-cli.js");

const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.GEMINI_CLI_HOME;
  return { cwd, home, env };
};
const run = (cwd, env, args = []) => spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });
const receiptsIn = (stdout) => stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const tokens = (input, output, cached = 0, thoughts = 0, tool = 0) =>
  ({ input, output, cached, thoughts, tool, total: input + output + thoughts + tool });
// The append-only session log: a header, metadata updates, a user turn, a
// reply written without tokens, then the same reply id again with tokens.
const sessionLog = (sessionId, replies) => [
  { sessionId, projectHash: "p", startTime: "2026-01-02T09:00:00.000Z", kind: "main" },
  { $set: { lastUpdated: "2026-01-02T09:00:00.000Z" } },
  { id: "u1", timestamp: "2026-01-02T09:00:00.000Z", type: "user", content: [{ text: "private question" }] },
  ...replies.flatMap(([id, time, usage, model = "gemini-test"]) => [
    { id, timestamp: time, type: "gemini", content: "private answer", model },
    { id, timestamp: time, type: "gemini", content: "private answer", model, tokens: usage }
  ])
].map((record) => JSON.stringify(record)).join("\n") + "\n";
const writeSession = async (home, dir, project, name, text) => {
  const chats = join(home, dir, "tmp", project, "chats");
  await mkdir(chats, { recursive: true });
  await writeFile(join(chats, name), text);
};

test("each reply counts once from its tokens record, excluding cached input", async () => {
  const { cwd, home, env } = await sandbox("gemini-count-");
  await writeSession(home, ".gemini", "proj-a", "session-2026-01-02-a.jsonl", sessionLog("s1", [
    ["r1", "2026-01-02T09:01:00.000Z", tokens(1000, 50, 800, 30, 20)],
    ["r2", "2026-01-02T09:02:00.000Z", tokens(10, 5)]
  ]));

  const result = run(cwd, env, ["--dry-run", "--source", "gemini_cli", "--tag", "test-host"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt, ...rest] = receiptsIn(result.stdout);
  assert.equal(rest.length, 0);
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.source, "gemini_cli");
  assert.equal(receipt.provider, "google");
  assert.equal(receipt.tokens, (1000 - 800 + 50 + 30 + 20) + (10 + 5));
  assert.equal(receipt.calls, 2);
  assert.deepEqual(receipt.models, ["gemini-test"]);
  assert.match(receipt.provenance, /cached 800 excluded; thoughts 30 included/);
  assert.doesNotMatch(result.stdout, /private|r1|s1/);
});

test("the older single-JSON session format is read, and GEMINI_CLI_HOME moves the store", async () => {
  const { cwd, env } = await sandbox("gemini-legacy-");
  env.GEMINI_CLI_HOME = join(cwd, "relocated");
  await writeSession(env.GEMINI_CLI_HOME, ".gemini", "proj", "session-old.json", JSON.stringify({
    sessionId: "s-old",
    messages: [
      { id: "m1", timestamp: "2026-01-03T10:00:00.000Z", type: "user", content: "q" },
      { id: "m2", timestamp: "2026-01-03T10:00:05.000Z", type: "gemini", model: "gemini-old", tokens: tokens(40, 2) }
    ]
  }));
  const result = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), ["gemini_cli-fixture_user.jsonl"]);
  const receipt = JSON.parse(await readFile(join(cwd, "scratch", "receipts", "gemini_cli-fixture_user.jsonl"), "utf8"));
  assert.equal(receipt.date, "2026-01-03");
  assert.equal(receipt.tokens, 42);
});

test("Qwen Code is read from its own store as a separate source", async () => {
  const { cwd, home, env } = await sandbox("gemini-qwen-");
  await writeSession(home, ".qwen", "proj", "session-q.jsonl", sessionLog("sq", [["q1", "2026-01-04T08:00:00.000Z", tokens(7, 3), "qwen3-coder"]]));
  const [receipt] = receiptsIn(run(cwd, env, ["--dry-run"]).stdout);
  assert.equal(receipt.source, "qwen_code");
  assert.equal(receipt.tokens, 10);
});

test("absent stores write nothing; malformed or unreadable ones are unknown and change nothing", async (t) => {
  const { cwd, home, env } = await sandbox("gemini-unknown-");
  const absent = run(cwd, env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /gemini_cli .*: not found/);

  await writeSession(home, ".gemini", "proj", "session-bad.jsonl", "{truncated\n");
  const previous = join(cwd, "scratch", "receipts", "gemini_cli-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  const malformed = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(malformed.status, 3);
  assert.match(malformed.stdout, /session file could not be read or parsed/);
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");

  assert.equal(run(cwd, env, ["--root", join(cwd, "x")]).status, 64);
  assert.equal(run(cwd, env, ["--source", "gemini_cli", "--root", join(cwd, "typo")]).status, 66);

  if (process.getuid?.() === 0) return t.skip("permissions do not bind root");
  const locked = join(home, ".qwen", "tmp");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o000);
  try {
    const result = run(cwd, env, ["--source", "qwen_code", "--dry-run"]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /qwen_code .*UNREADABLE/);
  } finally {
    await chmod(locked, 0o755);
  }
});
