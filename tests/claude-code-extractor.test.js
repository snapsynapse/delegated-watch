import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-claude-code.js");

// Every store location the extractor could resolve points inside the fixture,
// so the suite never reads the real transcripts of whoever runs it.
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
  delete env.CLAUDE_CONFIG_DIR;
  return { cwd, home, env };
};

const desktopDir = (env) =>
  process.platform === "darwin"
    ? join(env.HOME, "Library", "Application Support", "Claude")
    : process.platform === "win32"
      ? join(env.APPDATA, "Claude")
      : join(env.XDG_CONFIG_HOME, "Claude");

const run = (cwd, env, args = []) =>
  spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });

const receiptsIn = (stdout) =>
  stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const usageLine = (overrides = {}) => JSON.stringify({
  uuid: "u-1",
  requestId: "req_1",
  timestamp: "2026-03-05T20:00:00.000Z",
  message: {
    model: "claude-test-model",
    usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: 25 }
  },
  ...overrides
});

test("a backup root is read, cache reads are excluded, and receipts meet schema v2", async () => {
  const { cwd, env } = await sandbox("claude-code-root-");
  const root = join(cwd, "projects-backup", "some-project");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "session.jsonl"), `${usageLine()}\n${usageLine({ uuid: "u-2" })}\n`);

  const result = run(cwd, env, ["--dry-run", "--root", join(cwd, "projects-backup"), "--tag", "backup-2026-03"]);
  assert.equal(result.status, 0, result.stderr);
  const [receipt, ...rest] = receiptsIn(result.stdout);
  assert.equal(rest.length, 0);
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.schema_version, 2);
  assert.equal(receipt.source, "claude_code");
  assert.equal(receipt.date, "2026-03-05");
  assert.equal(receipt.tokens, 175); // one request; cache reads excluded
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.origin, "backup-2026-03");
  assert.equal(receipt.authority, "tool");
  assert.match(receipt.provenance, /cache_read 9000 excluded/);
  assert.ok(receipt.correlation_keys.every((key) => /^sha256:[a-f0-9]{64}$/.test(key)));
  assert.doesNotMatch(JSON.stringify(receipt), /req_1/, "a raw request id never enters a receipt");
});

test("streaming rewrites of one request collapse to the final write, in any line order", async () => {
  const { cwd, env } = await sandbox("claude-code-stream-");
  const root = join(cwd, "projects", "p");
  await mkdir(root, { recursive: true });
  const partial = (uuid, second, output) => usageLine({
    uuid,
    timestamp: `2026-03-05T20:00:0${second}.000Z`,
    message: {
      model: "claude-test-model",
      usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000, output_tokens: output }
    }
  });
  const other = usageLine({
    uuid: "u-other",
    requestId: "req_2",
    timestamp: "2026-03-05T20:01:00.000Z",
    message: { model: "claude-test-model", usage: { input_tokens: 7, output_tokens: 3 } }
  });
  await writeFile(join(root, "s.jsonl"), [partial("a", 1, 2), partial("b", 2, 2), partial("d", 4, 900), partial("c", 3, 2), other].join("\n") + "\n");

  const [receipt] = receiptsIn(run(cwd, env, ["--dry-run", "--root", join(cwd, "projects")]).stdout);
  assert.equal(receipt.tokens, 100 + 50 + 900 + 7 + 3);
  assert.equal(receipt.calls, 2);
});

test("stores that do not exist are reported as not found, and nothing is written", async () => {
  const { cwd, env } = await sandbox("claude-code-absent-");
  const result = run(cwd, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude_code .*: not found/);
  assert.match(result.stdout, /claude_cowork .*: not found/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNREADABLE|UNKNOWN/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });
});

test("CLAUDE_CONFIG_DIR and the platform's desktop data directory are the default stores", async () => {
  const { cwd, env } = await sandbox("claude-code-defaults-");
  env.CLAUDE_CONFIG_DIR = join(cwd, "relocated-claude");
  await mkdir(join(env.CLAUDE_CONFIG_DIR, "projects", "p"), { recursive: true });
  await writeFile(join(env.CLAUDE_CONFIG_DIR, "projects", "p", "s.jsonl"), `${usageLine()}\n`);
  const cowork = join(desktopDir(env), "local-agent-mode-sessions", "s");
  await mkdir(cowork, { recursive: true });
  await writeFile(join(cowork, "s.jsonl"), `${usageLine({ requestId: "req_cowork", timestamp: "2026-03-06T10:00:00.000Z" })}\n`);

  const result = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(result.status, 0, result.stderr);
  const files = (await readdir(join(cwd, "scratch", "receipts"))).sort();
  // One file per source, so one store's failure can never overwrite the other's.
  assert.deepEqual(files, ["claude_code-fixture_user.jsonl", "claude_cowork-fixture_user.jsonl"]);
  const code = JSON.parse(await readFile(join(cwd, "scratch", "receipts", files[0]), "utf8"));
  const coworkReceipt = JSON.parse(await readFile(join(cwd, "scratch", "receipts", files[1]), "utf8"));
  assert.equal(code.date, "2026-03-05");
  assert.equal(coworkReceipt.source, "claude_cowork");
  assert.equal(coworkReceipt.date, "2026-03-06");
});

test("--source limits the run to one store", async () => {
  const { cwd, env } = await sandbox("claude-code-source-");
  await mkdir(join(env.HOME, ".claude", "projects", "p"), { recursive: true });
  await writeFile(join(env.HOME, ".claude", "projects", "p", "s.jsonl"), `${usageLine()}\n`);

  const result = run(cwd, env, ["--dry-run", "--source", "claude_cowork"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(receiptsIn(result.stdout).length, 0);
  assert.doesNotMatch(result.stderr, /claude_code /);

  assert.equal(run(cwd, env, ["--source", "claude_web"]).status, 64);
});

test("an unreadable store exits 3, is reported as unknown, and leaves the previous receipts untouched", async (t) => {
  if (process.getuid?.() === 0) return t.skip("permissions do not bind root");
  const { cwd, env } = await sandbox("claude-code-eacces-");
  const locked = join(env.HOME, ".claude", "projects");
  await mkdir(locked, { recursive: true });
  const previous = join(cwd, "scratch", "receipts", "claude_code-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  await chmod(locked, 0o000);
  try {
    const result = run(cwd, env, ["--source", "claude_code", "--tag", "fixture/user"]);
    assert.equal(result.status, 3);
    assert.match(result.stdout, /UNREADABLE \(EACCES\)/);
    assert.match(result.stderr, /UNKNOWN, not zero/);
  } finally {
    await chmod(locked, 0o755);
  }
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");
});
