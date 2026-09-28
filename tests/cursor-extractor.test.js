// Cursor's cursorDiskKV bubbles in state.vscdb, the shape Cursor 3.17.21 uses.
// Every database here is a synthetic fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-cursor.js");

const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  return { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: join(home, ".config") } };
};
const defaultDb = (env) => join(
  process.platform === "darwin" ? join(env.HOME, "Library", "Application Support", "Cursor")
    : process.platform === "win32" ? join(env.APPDATA, "Cursor") : join(env.XDG_CONFIG_HOME, "Cursor"),
  "User", "globalStorage", "state.vscdb");
const run = (cwd, env, args = []) => spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });
const receiptsIn = (stdout) => stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const writeBubbles = async (path, rows) => {
  await mkdir(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const [key, value] of rows) insert.run(key, typeof value === "string" ? value : JSON.stringify(value));
  db.close();
};
const bubble = (createdAt, inputTokens, outputTokens, model) =>
  ({ type: 2, text: "private answer", createdAt, tokenCount: { inputTokens, outputTokens }, ...(model && { modelInfo: { modelName: model } }) });

test("messages with token counts become daily receipts; zero-count messages are skipped", async () => {
  const { cwd, env } = await sandbox("cursor-count-");
  await writeBubbles(defaultDb(env), [
    ["composerData:c1", { composerId: "c1", name: "private title" }],
    ["bubbleId:c1:b1", bubble("2026-01-02T09:00:00.000Z", 0, 0)],
    ["bubbleId:c1:b2", bubble("2026-01-02T09:01:00.000Z", 1200, 300, "cursor-test")],
    ["bubbleId:c1:b3", bubble("2026-01-03T10:00:00.000Z", 50, 5)]
  ]);
  const result = run(cwd, env, ["--dry-run", "--tag", "test-host"]);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  assert.deepEqual(receipts.map((r) => [r.date, r.tokens, r.calls]), [["2026-01-02", 1500, 1], ["2026-01-03", 55, 1]]);
  for (const receipt of receipts) assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.deepEqual(receipts[0].models, ["cursor-test"]);
  assert.doesNotMatch(result.stdout, /private|bubbleId|"c1"|"b2"/);
});

test("absent writes nothing; a malformed message is unknown and changes nothing", async () => {
  const { cwd, env } = await sandbox("cursor-unknown-");
  const absent = run(cwd, env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /not found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });

  await writeBubbles(defaultDb(env), [["bubbleId:c:b", "{truncated"]]);
  const previous = join(cwd, "scratch", "receipts", "cursor-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  const bad = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /could not be parsed/);
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");
  assert.equal(run(cwd, env, ["--db", join(cwd, "typo.vscdb")]).status, 66);
});
