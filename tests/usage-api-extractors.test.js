// The two organization usage API extractors. Every test is local: a loopback
// server stands in for the provider, or fetch is replaced by a stub before the
// extractor runs, so no request ever leaves the machine. No key used here is
// real, and every test asserts the key never reaches output.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const KEY = "test-not-a-real-key";

const workdir = async (mode = "unset") => {
  const cwd = await mkdtemp(join(tmpdir(), "usage-api-"));
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(join(cwd, "config", "claude-reconciliation.json"), JSON.stringify({ mode }));
  return cwd;
};

const run = (script, args, env, cwd, preload = []) => new Promise((done) => {
  const child = spawn(process.execPath, [...preload, join(repo, "scripts", script), ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_ADMIN_KEY: "", OPENAI_ADMIN_KEY: "", ...env }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => done({ status, stdout, stderr }));
});
const receiptsIn = (text) => text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

// Serves canned pages keyed by path and page token; records what was asked.
const provider = async (routes) => {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ path: url.pathname, headers: req.headers });
    const pages = routes[url.pathname] ?? [{ data: [], has_more: false }];
    const body = pages[url.searchParams.get("page") ? 1 : 0];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }).listen(0, "127.0.0.1");
  await new Promise((ready) => server.once("listening", ready));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
};

const hour = (day, h) => new Date(Date.UTC(2026, 0, day, h)).toISOString();
const second = (day) => Date.UTC(2026, 0, day) / 1000;

test("Anthropic usage becomes provider-authority v2 receipts, quarantined until reconciled", async () => {
  const api = await provider({
    "/usage": [
      { data: [
        { starting_at: hour(2, 10), results: [{ model: "claude-a", uncached_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 }, cache_read_input_tokens: 5000, output_tokens: 40 }] }
      ], has_more: true, next_page: "p2" },
      { data: [{ starting_at: hour(3, 0), results: [{ model: "claude-a", uncached_input_tokens: 11, cache_read_input_tokens: 9, output_tokens: 2 }] }], has_more: false }
    ]
  });
  try {
    const cwd = await workdir();
    const env = { ANTHROPIC_ADMIN_KEY: KEY, ANTHROPIC_API_BASE_URL: `${api.base}/usage` };
    const result = await run("extract-claude-api.js", ["--since", "2026-01-01", "--pace", "0"], env, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /NOT imported/);
    assert.deepEqual(await readdir(join(cwd, "scratch")), ["reconcile"]);
    const receipts = receiptsIn(await readFile(join(cwd, "scratch", "reconcile", "claude-api.jsonl"), "utf8"));
    assert.deepEqual(receipts.map((r) => [r.date, r.tokens]), [["2026-01-02", 190], ["2026-01-03", 13]]);
    for (const receipt of receipts) {
      assert.deepEqual(validateReceiptSchema(receipt), []);
      assert.equal(receipt.authority, "provider");
      assert.equal(receipt.origin, "account/anthropic");
    }
    assert.match(receipts[0].provenance, /cache_read 5000 excluded/);
    assert.equal(api.seen[0].headers["x-api-key"], KEY);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));

    const additive = await workdir("additive");
    assert.equal((await run("extract-claude-api.js", ["--since", "2026-01-01", "--pace", "0"], env, additive)).status, 0);
    assert.deepEqual(await readdir(join(additive, "scratch")), ["receipts"]);
  } finally {
    api.close();
  }
});

test("OpenAI usage sums text endpoints, excludes cached input, and fails on a broken page", async () => {
  const api = await provider({
    "/org/completions": [
      { data: [{ start_time: second(2), results: [{ model: "gpt-a", input_tokens: 1000, input_cached_tokens: 400, output_tokens: 50, num_model_requests: 3 }] }], has_more: true, next_page: "c2" },
      { data: [{ start_time: second(3), results: [{ model: "gpt-b", input_tokens: 10, output_tokens: 5, num_model_requests: 1 }] }], has_more: false }
    ],
    "/org/embeddings": [{ data: [{ start_time: second(2), results: [{ model: "emb", input_tokens: 300, num_model_requests: 2 }] }], has_more: false }]
  });
  try {
    const cwd = await workdir();
    const env = { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: `${api.base}/org` };
    const result = await run("extract-openai-api.js", ["--since", "2026-01-01", "--dry-run"], env, cwd);
    assert.equal(result.status, 0, result.stderr);
    const receipts = receiptsIn(result.stdout);
    assert.deepEqual(receipts.map((r) => [r.date, r.tokens, r.calls]), [["2026-01-02", 950, 5], ["2026-01-03", 15, 1]]);
    for (const receipt of receipts) {
      assert.deepEqual(validateReceiptSchema(receipt), []);
      assert.equal(receipt.origin, "account/openai");
    }
    assert.match(receipts[0].provenance, /cached_input 400 excluded/);
    assert.equal(api.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(KEY));
  } finally {
    api.close();
  }

  const broken = await provider({ "/org/completions": [{ data: [], has_more: true }] });
  try {
    const result = await run("extract-openai-api.js", ["--since", "2026-01-01", "--dry-run"],
      { OPENAI_ADMIN_KEY: KEY, OPENAI_API_BASE_URL: `${broken.base}/org` }, await workdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has_more without next_page/);
  } finally {
    broken.close();
  }
});

test("without a key, each extractor skips cleanly and asks nothing of the provider", async () => {
  const cwd = await workdir();
  const anthropic = await run("extract-claude-api.js", ["--dry-run"], {}, cwd);
  assert.equal(anthropic.status, 0);
  assert.match(anthropic.stdout, /ANTHROPIC_ADMIN_KEY not set/);
  const openai = await run("extract-openai-api.js", ["--dry-run"], {}, cwd);
  assert.equal(openai.status, 0);
  assert.match(openai.stdout, /OPENAI_ADMIN_KEY not set/);
});

// A provider that cannot be reached is unknown (exit 3), distinct from an
// ordinary failure (exit 1). fetch is stubbed before the extractor loads.
const stubbedFetch = async (cwd, code) => {
  const path = join(cwd, "fetch-stub.mjs");
  await writeFile(path, `globalThis.fetch = async () => { const e = new TypeError("fetch failed"); e.cause = { code: ${JSON.stringify(code)} }; throw e; };\n`);
  return ["--import", path];
};

for (const [script, keyName, host] of [
  ["extract-claude-api.js", "ANTHROPIC_ADMIN_KEY", /api\.anthropic\.com/],
  ["extract-openai-api.js", "OPENAI_ADMIN_KEY", /api\.openai\.com/]
]) {
  test(`${script} classifies transport failures without leaking the key or the query`, async () => {
    for (const [code, status] of [["ENOTFOUND", 3], ["UND_ERR_CONNECT_TIMEOUT", 3], ["SOME_OTHER_ERROR", 1]]) {
      const cwd = await workdir("additive");
      const result = await run(script, ["--dry-run"], { [keyName]: KEY }, cwd, await stubbedFetch(cwd, code));
      assert.equal(result.status, status, `${code}: ${result.stderr}`);
      if (status === 3) {
        assert.match(result.stderr, /unreachable/);
        assert.match(result.stderr, host);
      }
      assert.doesNotMatch(result.stderr, new RegExp(KEY));
      assert.doesNotMatch(result.stderr, /\?/, "never the URL's query string");
      assert.equal(receiptsIn(result.stdout).length, 0);
    }
  });
}
