import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-vscode-agents.js");

// Every store location the extractor could resolve points inside the fixture,
// so the suite never reads the real extension history of whoever runs it.
const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config")
  };
  return { cwd, env };
};

const editorDir = (env, editor) =>
  process.platform === "darwin"
    ? join(env.HOME, "Library", "Application Support", editor)
    : process.platform === "win32"
      ? join(env.APPDATA, editor)
      : join(env.XDG_CONFIG_HOME, editor);
const tasksDir = (env, editor, extensionId) => join(editorDir(env, editor), "User", "globalStorage", extensionId, "tasks");

const run = (cwd, env, args = []) =>
  spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });
const receiptsIn = (stdout) =>
  stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const JAN_2 = Date.parse("2026-01-02T12:00:00Z");
const usageMessage = (ts, usage) => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify(usage) });
const writeTask = async (root, id, messages, configName) => {
  const task = join(root, id);
  await mkdir(task, { recursive: true });
  if (configName) await writeFile(join(task, "history_item.json"), JSON.stringify({ id, apiConfigName: configName }));
  await writeFile(join(task, "ui_messages.json"), JSON.stringify(messages));
};

test("a record the counters decide is legacy, and no private payload escapes", async () => {
  const { cwd, env } = await sandbox("vscode-legacy-");
  const root = join(cwd, "tasks");
  await writeTask(root, "task-1", [
    usageMessage(JAN_2, { tokensIn: 100, tokensOut: 20, cacheWrites: 50, cacheReads: 900, cost: 1.23, request: "private content" })
  ], "Claude Sonnet 4.5");

  const result = run(cwd, env, ["--dry-run", "--source", "snapdev", "--root", root, "--tag", "test-host"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt, ...rest] = receiptsIn(result.stdout);
  assert.equal(rest.length, 0);
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.tokens, 170); // input + cache write + output; cache read excluded
  assert.equal(receipt.calls, 1);
  assert.deepEqual(receipt.models, ["claude-sonnet-4-5"]);
  assert.equal(receipt.origin, "test-host");
  assert.match(receipt.provenance, /cache_read 900 excluded/);
  assert.ok(receipt.correlation_keys.every((key) => /^sha256:[a-f0-9]{64}$/.test(key)));
  assert.doesNotMatch(result.stdout + result.stderr, /private content|task-1|1\.23/);
});

test("an ambiguous record is never guessed, and a tie-breaker settles only the ambiguous ones", async () => {
  const { cwd, env } = await sandbox("vscode-tie-");
  const root = join(cwd, "tasks");
  await writeTask(root, "task-1", [
    usageMessage(JAN_2, { tokensIn: 100, tokensOut: 20, cacheWrites: 50, cacheReads: 900 }), // decided: legacy
    usageMessage(JAN_2 + 1000, { tokensIn: 1000, tokensOut: 10, cacheWrites: 100, cacheReads: 800 }) // ambiguous
  ]);
  const previous = join(cwd, "scratch", "receipts", "snapdev-test-host.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");

  const refused = run(cwd, env, ["--source", "snapdev", "--root", root, "--tag", "test-host"]);
  assert.equal(refused.status, 3);
  assert.match(refused.stdout, /1 record\(s\) have cache counters consistent with both conventions/);
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");

  const inclusive = receiptsIn(run(cwd, env, ["--dry-run", "--source", "snapdev", "--root", root, "--token-convention", "inclusive"]).stdout)[0];
  assert.equal(inclusive.tokens, 170 + (1000 - 800 + 10));
  assert.match(inclusive.provenance, /1 of 2 records tie-broken as inclusive/);
  const legacy = receiptsIn(run(cwd, env, ["--dry-run", "--source", "snapdev", "--root", root, "--token-convention", "legacy"]).stdout)[0];
  assert.equal(legacy.tokens, 170 + (1000 + 100 + 10));
});

test("Cline, Roo Code, Kilo Code, and Snapdev are read from every VS Code-family editor", async () => {
  const { cwd, env } = await sandbox("vscode-editors-");
  const noCache = (ts, tokensIn) => usageMessage(ts, { tokensIn, tokensOut: 1, cacheWrites: 0, cacheReads: 0 });
  await writeTask(tasksDir(env, "Code", "saoudrizwan.claude-dev"), "a", [noCache(JAN_2, 10)]);
  await writeTask(tasksDir(env, "Cursor", "saoudrizwan.claude-dev"), "b", [noCache(JAN_2, 20)]);
  await writeTask(tasksDir(env, "Windsurf", "rooveterinaryinc.roo-cline"), "c", [noCache(JAN_2, 30)]);
  await writeTask(tasksDir(env, "Code - Insiders", "kilocode.kilo-code"), "d", [noCache(JAN_2, 40)]);
  await writeTask(tasksDir(env, "VSCodium", "remotebase.snapdev"), "e", [noCache(JAN_2, 50)]);

  const result = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(result.status, 0, result.stderr);
  const files = (await readdir(join(cwd, "scratch", "receipts"))).sort();
  assert.deepEqual(files, [
    "cline-fixture_user.jsonl",
    "kilo-fixture_user.jsonl",
    "roo_code-fixture_user.jsonl",
    "snapdev-fixture_user.jsonl"
  ]);
  const read = async (file) => JSON.parse(await readFile(join(cwd, "scratch", "receipts", file), "utf8"));
  assert.equal((await read("cline-fixture_user.jsonl")).tokens, 11 + 21); // VS Code and Cursor summed
  assert.equal((await read("roo_code-fixture_user.jsonl")).tokens, 31);
});

test("one source's failure leaves the other sources written", async (t) => {
  if (process.getuid?.() === 0) return t.skip("permissions do not bind root");
  const { cwd, env } = await sandbox("vscode-independent-");
  await writeTask(tasksDir(env, "Code", "saoudrizwan.claude-dev"), "a", [
    usageMessage(JAN_2, { tokensIn: 5, tokensOut: 5, cacheWrites: 0, cacheReads: 0 })
  ]);
  const locked = tasksDir(env, "Code", "kilocode.kilo-code");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o000);
  try {
    const result = run(cwd, env, ["--tag", "fixture/user"]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /kilo .*UNREADABLE \(EACCES\)/);
    assert.match(result.stdout, /kilo: not written/);
  } finally {
    await chmod(locked, 0o755);
  }
  assert.deepEqual(await readdir(join(cwd, "scratch", "receipts")), ["cline-fixture_user.jsonl"]);
});

test("malformed counters make the source unknown rather than smaller", async () => {
  const { cwd, env } = await sandbox("vscode-malformed-");
  const root = join(cwd, "tasks");
  await writeTask(root, "good", [usageMessage(JAN_2, { tokensIn: 5, tokensOut: 5 })]);
  await writeTask(root, "bad", [usageMessage(JAN_2, { tokensIn: -1, tokensOut: 5 })]);
  const result = run(cwd, env, ["--dry-run", "--source", "cline", "--root", root]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /invalid counters/);
  assert.equal(receiptsIn(result.stdout).length, 0);
});

test("no stores means nothing written, and usage errors are refused", async () => {
  const { cwd, env } = await sandbox("vscode-absent-");
  const result = run(cwd, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cline: no Cline task store found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });

  assert.equal(run(cwd, env, ["--source", "copilot"]).status, 64);
  assert.equal(run(cwd, env, ["--root", join(cwd, "tasks")]).status, 64); // --root needs one --source
  assert.equal(run(cwd, env, ["--source", "cline", "--root", join(cwd, "typo")]).status, 66);
});
