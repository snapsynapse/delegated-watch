// The OpenAI-compatible capture. A loopback server stands in for every
// endpoint, so no request leaves the machine, and no key used here is real.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const capture = join(repo, "scripts", "openai-compatible-capture.mjs");
const KEY = "test-not-a-real-key";

const endpoint = async (reply) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body });
      const { status = 200, json } = reply;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    });
  }).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
};
const run = (args, input, env = {}) => new Promise(async (done) => {
  const dir = await mkdtemp(join(tmpdir(), "compat-capture-"));
  const receiptFile = join(dir, "receipts.jsonl");
  const child = spawn(process.execPath, [capture, ...args, "--receipt-file", receiptFile], {
    env: { ...process.env, XAI_API_KEY: "", DEEPSEEK_API_KEY: "", ...env }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", async (status) => {
    const text = await readFile(receiptFile, "utf8").catch(() => "");
    done({ status, stdout, stderr, receipts: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) });
  });
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
});
const completion = (usage, extra = {}) => ({
  id: "cmpl-1", object: "chat.completion", created: 1767355200, model: "qwen3-14b",
  choices: [{ message: { role: "assistant", content: "private answer" } }], usage, ...extra
});

test("a local runner's response is relayed unchanged and only its counters are kept", async () => {
  const body = completion({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } });
  const api = await endpoint({ json: body });
  try {
    const result = await run(["--provider", "lmstudio", "--base-url", api.url], { model: "qwen3-14b", messages: [{ role: "user", content: "private question" }] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), body, "the response reaches the caller unchanged");
    assert.equal(api.seen[0].path, "/v1/chat/completions");
    assert.equal(api.seen[0].headers.authorization, undefined, "a local runner gets no key");
    const [receipt] = result.receipts;
    assert.deepEqual(validateReceiptSchema(receipt), []);
    assert.equal(receipt.source, "qwen_local");
    assert.equal(receipt.provider, "lmstudio");
    assert.equal(receipt.tokens, 120 - 20 + 30);
    assert.doesNotMatch(JSON.stringify(receipt), /private/);
  } finally {
    api.close();
  }
});

test("a hosted preset sends its key, names its source, and reads DeepSeek's cache field", async () => {
  const api = await endpoint({ json: completion({ prompt_tokens: 1000, completion_tokens: 40, prompt_cache_hit_tokens: 600 }, { model: "deepseek-chat", id: "ds-1" }) });
  try {
    const result = await run(["--provider", "deepseek", "--base-url", api.url], { model: "deepseek-chat", messages: [] }, { DEEPSEEK_API_KEY: KEY });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${KEY}`);
    const [receipt] = result.receipts;
    assert.equal(receipt.source, "deepseek_api");
    assert.equal(receipt.tokens, 1000 - 600 + 40);
    assert.equal(receipt.snapshot_key, "deepseek:ds-1");
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(receipt), new RegExp(KEY));
  } finally {
    api.close();
  }
});

test("a custom endpoint needs a source id and records under it", async () => {
  const api = await endpoint({ json: completion({ prompt_tokens: 5, completion_tokens: 5 }, { model: "house-model" }) });
  try {
    assert.equal((await run(["--base-url", api.url], { model: "m" })).status, 64);
    const result = await run(["--base-url", api.url, "--source", "house_gateway"], { model: "m" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.receipts[0].source, "house_gateway_api");
  } finally {
    api.close();
  }
});

test("refusals write nothing: streaming, no key, no counters, an HTTP error, an unreachable endpoint", async () => {
  const noUsage = await endpoint({ json: { id: "x", model: "m", choices: [] } });
  const failing = await endpoint({ status: 500, json: { error: "boom" } });
  try {
    const cases = [
      [["--provider", "lmstudio", "--base-url", noUsage.url], { model: "m", stream: true }, {}, 1],
      [["--provider", "xai", "--base-url", noUsage.url], { model: "m" }, {}, 1],
      [["--provider", "lmstudio", "--base-url", noUsage.url], { model: "m" }, {}, 2],
      [["--provider", "lmstudio", "--base-url", failing.url], { model: "m" }, {}, 1],
      [["--provider", "lmstudio", "--base-url", "http://127.0.0.1:9/v1"], { model: "m" }, {}, 3],
      [["--provider", "openai"], { model: "m" }, {}, 64]
    ];
    for (const [args, input, env, status] of cases) {
      const result = await run(args, input, env);
      assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.receipts.length, 0);
    }
  } finally {
    noUsage.close();
    failing.close();
  }
});
