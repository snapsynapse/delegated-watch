import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-goose.js");

// Every database location the extractor could resolve points inside the
// fixture, so the suite never reads the real goose history of whoever runs it.
const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_DATA_HOME: join(home, ".local", "share")
  };
  delete env.GOOSE_PATH_ROOT;
  return { cwd, home, env };
};

const run = (cwd, env, args = []) =>
  spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });

const receiptsIn = (stdout) =>
  stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

// The shape goose writes, including the columns this extractor must ignore.
const createDb = (path, { ledger = true, wal = true } = {}) => {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, provider_name TEXT)");
  if (ledger) {
    db.exec(`CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, created_timestamp INTEGER,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost REAL, cost_source TEXT, is_compaction INTEGER)`);
  }
  return db;
};
const JAN_2 = 1767355200; // 2026-01-02T12:00:00Z

test("local model calls become exact v2 receipts, including committed WAL frames, without touching the database", async () => {
  const { cwd, env } = await sandbox("goose-local-");
  const dbPath = join(cwd, "sessions.db");
  const writer = createDb(dbPath);
  try {
    writer.exec("INSERT INTO sessions VALUES ('s1', 'ollama')");
    writer.exec(`INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cost)
      VALUES ('s1', ${JAN_2}, 'gemma4:31b', 200, 100, 300, 9.99), ('s1', ${JAN_2 + 60}, 'gemma4:31b', 20, 10, 30, NULL)`);
    // The writer stays open, so these rows live in the WAL, not the main file.
    const before = [await readFile(dbPath), await readFile(`${dbPath}-wal`)];

    const result = run(cwd, env, ["--db", dbPath, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    const [receipt, ...rest] = receiptsIn(result.stdout);
    assert.equal(rest.length, 0);
    assert.deepEqual(validateReceiptSchema(receipt), []);
    assert.equal(receipt.source, "gemma_local");
    assert.equal(receipt.provider, "ollama");
    assert.equal(receipt.date, "2026-01-02");
    assert.equal(receipt.tokens, 330);
    assert.equal(receipt.calls, 2);
    assert.doesNotMatch(JSON.stringify(receipt), /9\.99|cost/, "the cost column is never read");
    assert.deepEqual([await readFile(dbPath), await readFile(`${dbPath}-wal`)], before);
  } finally {
    writer.close();
  }
});

test("calls routed to a hosted provider are labelled as goose traffic, not local inference", async () => {
  const { cwd, env } = await sandbox("goose-hosted-");
  const dbPath = join(cwd, "sessions.db");
  const db = createDb(dbPath);
  db.exec("INSERT INTO sessions VALUES ('s1', 'anthropic')");
  db.exec(`INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens) VALUES ('s1', ${JAN_2}, 'claude-test', 50, 5)`);
  db.close();

  const [receipt] = receiptsIn(run(cwd, env, ["--db", dbPath, "--dry-run"]).stdout);
  assert.equal(receipt.source, "goose_anthropic");
  assert.equal(receipt.provider, "anthropic");
  assert.equal(receipt.tokens, 55);
});

test("cache reads are never guessed: undecided rows exit 3 until a convention is given", async () => {
  const { cwd, env } = await sandbox("goose-cache-");
  const dbPath = join(cwd, "sessions.db");
  const db = createDb(dbPath);
  db.exec("INSERT INTO sessions VALUES ('s1', 'anthropic')");
  db.exec(`INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, cache_read_tokens)
    VALUES ('s1', ${JAN_2}, 'claude-test', 1000, 50, 800)`);
  db.close();

  const undecided = run(cwd, env, ["--db", dbPath, "--dry-run"]);
  assert.equal(undecided.status, 3);
  assert.match(undecided.stderr, /1 ledger row\(s\) carry cache reads/);
  assert.match(undecided.stderr, /UNKNOWN, not zero/);
  assert.equal(receiptsIn(undecided.stdout).length, 0);

  const inclusive = receiptsIn(run(cwd, env, ["--db", dbPath, "--dry-run", "--cache-convention", "inclusive"]).stdout)[0];
  assert.equal(inclusive.tokens, 200 + 50);
  assert.match(inclusive.provenance, /cache_read 800 excluded \(inclusive convention\)/);
  const exclusive = receiptsIn(run(cwd, env, ["--db", dbPath, "--dry-run", "--cache-convention", "exclusive"]).stdout)[0];
  assert.equal(exclusive.tokens, 1000 + 50);
});

test("the default database follows XDG_DATA_HOME, and GOOSE_PATH_ROOT overrides it", async () => {
  const { cwd, env } = await sandbox("goose-paths-");
  const absent = run(cwd, env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /sessions\.db: not found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });

  env.GOOSE_PATH_ROOT = join(cwd, "goose-root");
  const dir = join(env.GOOSE_PATH_ROOT, "data", "sessions");
  await mkdir(dir, { recursive: true });
  const db = createDb(join(dir, "sessions.db"), { wal: false });
  db.exec("INSERT INTO sessions VALUES ('s1', 'ollama')");
  db.exec(`INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens) VALUES ('s1', ${JAN_2}, 'qwen3', 7, 3)`);
  db.close();

  const result = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(join(cwd, "scratch", "receipts", "goose-fixture_user.jsonl"), "utf8"));
  assert.equal(receipt.source, "qwen_local");
  assert.equal(receipt.tokens, 10);
});

test("a database without a usage ledger, or one that is not SQLite, is unknown and changes nothing", async () => {
  const { cwd, env } = await sandbox("goose-unknown-");
  const noLedger = join(cwd, "old.db");
  createDb(noLedger, { ledger: false }).close();
  const old = run(cwd, env, ["--db", noLedger]);
  assert.equal(old.status, 3);
  assert.match(old.stdout, /no usage_ledger table/);

  const previous = join(cwd, "scratch", "receipts", "goose-fixture_user.jsonl");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(previous, "previous receipts\n");
  const corrupt = join(cwd, "corrupt.db");
  await writeFile(corrupt, "this is not a database");
  const result = run(cwd, env, ["--db", corrupt, "--tag", "fixture/user"]);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /UNREADABLE/);
  assert.equal(await readFile(previous, "utf8"), "previous receipts\n");

  assert.equal(run(cwd, env, ["--db", join(cwd, "typo.db")]).status, 66);
});
