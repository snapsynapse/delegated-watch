// npm run refresh and record mode. Each test runs in a temporary copy of the
// repository with a fixture home, so no real store is read and the real
// checkout is never switched into record mode.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertRecordDir } from "../scripts/lib/record-paths.js";

const repo = resolve(import.meta.dirname, "..");
const TRACKED = ["public/data/daily-burn.json", "docs/demo/index.html", "config/observed-intervals.json"];

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "refresh-record-"));
  for (const dir of ["scripts", "src", "config", "public", "docs"]) {
    await cp(join(repo, dir), join(root, dir), { recursive: true });
  }
  await cp(join(repo, "package.json"), join(root, "package.json"));
  const home = join(root, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_ADMIN_KEY: "", OPENAI_ADMIN_KEY: "" };
  for (const variable of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "COPILOT_HOME", "GOOSE_PATH_ROOT"]) delete env[variable];
  // One Codex rollout: the only store this fixture machine has.
  const sessions = join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  const usage = { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, total_tokens: 550 };
  await writeFile(join(sessions, "rollout-fixture.jsonl"), [
    JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
    JSON.stringify({ timestamp: "2026-01-02T10:00:00Z", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } })
  ].join("\n") + "\n");
  return { root, env };
};
const digest = async (root) => Promise.all(TRACKED.map(async (file) => createHash("sha256").update(await readFile(join(root, file))).digest("hex")));
const refresh = (root, env, args = []) =>
  spawnSync(process.execPath, [join(root, "scripts", "refresh.js"), ...args], { cwd: root, env, encoding: "utf8" });

test("the first refresh starts a record of its own and never touches the shipped demo", async () => {
  const { root, env } = await workspace();
  const before = await digest(root);

  const first = refresh(root, env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Created config\/record\.json/);
  assert.match(first.stdout, /ok\s+import/);
  assert.match(first.stdout, /ok\s+eval:served/);
  assert.deepEqual(JSON.parse(await readFile(join(root, "config", "record.json"), "utf8")), { dir: "record" });

  const rows = JSON.parse(await readFile(join(root, "record", "daily-burn.json"), "utf8"));
  assert.deepEqual(rows.map((row) => [row.date, row.total, Object.keys(row.sources)]), [["2026-01-02", 450, ["codex"]]]);
  const page = await readFile(join(root, "record", "index.html"), "utf8");
  assert.match(page, /"codex"/);
  assert.doesNotMatch(page, /class="demo-banner"/, "a real record is not labelled synthetic");
  assert.deepEqual(await digest(root), before, "tracked demo files are byte-identical");

  // A second run finds the same evidence and changes nothing.
  const second = refresh(root, env);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stdout, /Created config\/record\.json/);
  assert.deepEqual(JSON.parse(await readFile(join(root, "record", "daily-burn.json"), "utf8")).map((row) => row.total), [450]);
});

test("per-step options from config/record.json reach the extractor, and bad steps are refused", async () => {
  const { root, env } = await workspace();
  await writeFile(join(root, "config", "record.json"), JSON.stringify({
    dir: "record",
    options: { "extract:vscode-agents": ["--token-convention", "snapdev=inclusive"] }
  }));
  const result = refresh(root, env, ["--only", "extract:vscode-agents"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /== extract:vscode-agents --token-convention snapdev=inclusive/);

  assert.equal(refresh(root, env, ["--only", "extract:nothing"]).status, 64);
  await writeFile(join(root, "config", "record.json"), JSON.stringify({ options: { "extract:nothing": [] } }));
  assert.equal(refresh(root, env).status, 64);
});

test("a record directory can never sit in a tracked or served location", () => {
  for (const dir of ["docs", "docs/record", "public/data", "config", "/tmp/record", "../elsewhere", "."]) {
    assert.throws(() => assertRecordDir(dir), /record\.json/, dir);
  }
  assert.equal(assertRecordDir("record/"), "record");
  assert.equal(assertRecordDir("my-record"), "my-record");
});
