// GitHub Copilot CLI session state, in the event shapes the @github/copilot
// 1.0.73 SDK writes. Every store here is a synthetic fixture.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const extractor = join(repo, "scripts", "extract-copilot-cli.js");

const sandbox = async (prefix) => {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.COPILOT_HOME;
  return { cwd, home, env };
};
const run = (cwd, env, args = []) => spawnSync(process.execPath, [extractor, ...args], { cwd, env, encoding: "utf8" });
const receiptsIn = (stdout) => stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

const metrics = (input, output, cacheRead, requests) =>
  ({ requests: { count: requests, cost: 1 }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, reasoningTokens: 5 } });
const shutdown = (id, timestamp, modelMetrics) =>
  ({ type: "session.shutdown", id, timestamp, data: { shutdownType: "routine", modelMetrics } });
const writeSession = async (stateRoot, name, events) => {
  await mkdir(join(stateRoot, name), { recursive: true });
  await writeFile(join(stateRoot, name, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
};

test("each shutdown adds only its increase, dated by the shutdown, with cache reads excluded", async () => {
  const { cwd, home, env } = await sandbox("copilot-deltas-");
  const state = join(home, ".copilot", "session-state");
  await writeSession(state, "s1", [
    { type: "session.start", id: "e0", timestamp: "2026-01-02T09:00:00.000Z", data: { sessionId: "s1" } },
    { type: "user.message", id: "e1", timestamp: "2026-01-02T09:00:01.000Z", data: { content: "private question" } },
    // Ephemeral per-call events are never written by Copilot; if one appears it is ignored.
    { type: "assistant.usage", id: "e2", timestamp: "2026-01-02T09:00:02.000Z", ephemeral: true, data: { model: "m", inputTokens: 999, outputTokens: 999 } },
    shutdown("e3", "2026-01-02T10:00:00.000Z", { "gpt-test": metrics(1000, 100, 600, 4) }),
    // Resumed the next day: totals restored and extended, so the second shutdown is cumulative.
    { type: "session.resume", id: "e4", timestamp: "2026-01-03T09:00:00.000Z", data: {} },
    shutdown("e5", "2026-01-03T11:00:00.000Z", { "gpt-test": metrics(1500, 130, 900, 6), "claude-test": metrics(50, 10, 0, 1) })
  ]);

  const result = run(cwd, env, ["--dry-run", "--tag", "test-host"]);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  assert.deepEqual(receipts.map((r) => [r.date, r.tokens, r.calls]), [
    ["2026-01-02", 1000 - 600 + 100, 4],
    ["2026-01-03", (500 - 300 + 30) + (50 + 10), 2 + 1]
  ]);
  for (const receipt of receipts) assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.deepEqual(receipts[1].models, ["claude-test", "gpt-test"]);
  assert.match(receipts[0].provenance, /cache_read 600 excluded/);
  assert.doesNotMatch(result.stdout, /private question|"s1"|"e3"/);
});

test("a total that falls starts fresh rather than counting negative", async () => {
  const { cwd, home, env } = await sandbox("copilot-reset-");
  const state = join(home, ".copilot", "session-state");
  await writeSession(state, "s2", [
    shutdown("a", "2026-01-02T10:00:00.000Z", { m: metrics(100, 10, 0, 1) }),
    shutdown("b", "2026-01-02T12:00:00.000Z", { m: metrics(40, 4, 0, 1) })
  ]);
  const [receipt] = receiptsIn(run(cwd, env, ["--dry-run"]).stdout);
  assert.equal(receipt.tokens, 110 + 44);
  assert.equal(receipt.calls, 2);
});

test("COPILOT_HOME moves the store; absent writes nothing; malformed is unknown and changes nothing", async () => {
  const { cwd, env } = await sandbox("copilot-home-");
  const absent = run(cwd, env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /not found/);
  await assert.rejects(readdir(join(cwd, "scratch")), { code: "ENOENT" });

  env.COPILOT_HOME = join(cwd, "relocated");
  await writeSession(join(env.COPILOT_HOME, "session-state"), "s", [shutdown("x", "2026-01-04T10:00:00.000Z", { m: metrics(20, 2, 0, 1) })]);
  assert.equal(run(cwd, env, ["--tag", "fixture/user"]).status, 0);
  const receipt = JSON.parse(await readFile(join(cwd, "scratch", "receipts", "copilot_cli-fixture_user.jsonl"), "utf8"));
  assert.equal(receipt.tokens, 22);

  await writeFile(join(env.COPILOT_HOME, "session-state", "s", "events.jsonl"), "{truncated\n");
  const bad = run(cwd, env, ["--tag", "fixture/user"]);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /not valid JSON/);
  assert.equal(JSON.parse(await readFile(join(cwd, "scratch", "receipts", "copilot_cli-fixture_user.jsonl"), "utf8")).tokens, 22);
  assert.equal(run(cwd, env, ["--root", join(cwd, "typo")]).status, 66);
});
