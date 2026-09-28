// Zed agent threads, stored as zstd-compressed JSON in threads.db, the shape
// Zed 1.20.2 uses. Every database here is a synthetic fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-zed-agent.js");

const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  return { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), XDG_DATA_HOME: join(home, ".local", "share") } };
};
const defaultDb = (env) =>
  process.platform === "darwin"
    ? join(env.HOME, "Library", "Application Support", "Zed", "threads", "threads.db")
    : process.platform === "win32"
      ? join(env.LOCALAPPDATA, "Zed", "threads", "threads.db")
      : join(env.XDG_DATA_HOME, "zed", "threads", "threads.db");
const run = (cwd, env, args = []) => spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });
const receiptsIn = (stdout) => stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const writeThreads = async (path, threads) => {
  await mkdir(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB,
    parent_id TEXT, worktree_branch TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)`);
  const insert = db.prepare("INSERT INTO threads (id, summary, created_at, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?, ?)");
  for (const { id, created, updated, usage, raw, dataType = "zstd" } of threads) {
    const json = raw ?? JSON.stringify({
      title: "private title", messages: [{ text: "private content" }],
      cumulative_token_usage: usage, request_token_usage: { u1: usage, u2: usage },
      model: { provider: "anthropic", model: "claude-test" }
    });
    insert.run(id, "private summary", created, updated ?? created, dataType, dataType === "zstd" ? zstdCompressSync(Buffer.from(json)) : Buffer.from(json));
  }
  db.close();
};

test("threads count once each, dated by creation, with cache reads excluded", async () => {
  const { cwd, env } = await sandbox("zed-threads-");
  await writeThreads(defaultDb(env), [
    { id: "t1", created: "2026-01-02T09:00:00Z", updated: "2026-01-05T09:00:00Z",
      usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 60, cache_read_input_tokens: 9000 } },
    { id: "t2", created: "2026-01-02T15:00:00Z", updated: "2026-01-02T16:00:00Z", dataType: "json",
      usage: { input_tokens: 10, output_tokens: 5 } }
  ]);

  const result = run(cwd, env, ["--dry-run", "--tag", "test-host"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt, ...rest] = receiptsIn(result.stdout);
  assert.equal(rest.length, 0, "a thread continued later stays on its creation day");
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.date, "2026-01-02");
  assert.equal(receipt.tokens, (100 + 60 + 40) + 15);
  assert.equal(receipt.calls, 4);
  assert.deepEqual(receipt.models, ["claude-test"]);
  assert.match(receipt.provenance, /cache_read 9000 excluded/);
  assert.doesNotMatch(result.stdout, /private|"t1"/);
});

test("absent writes nothing; an undecodable thread is unknown and changes nothing", async () => {
  const { cwd, env } = await sandbox("zed-unknown-");
  const absent = run(cwd, env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /not found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });

  await writeThreads(defaultDb(env), [{ id: "bad", created: "2026-01-02T09:00:00Z", raw: "not json at all" }]);
  const previous = join(cwd, "scratch", "receipts", "zed_agent-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  const bad = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /could not be decoded/);
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");

  const notSqlite = join(cwd, "not.db");
  await writeFile(notSqlite, "plain text");
  assert.equal(run(cwd, env, ["--db", notSqlite]).status, 3);
  assert.equal(run(cwd, env, ["--db", join(cwd, "typo.db")]).status, 66);
});
