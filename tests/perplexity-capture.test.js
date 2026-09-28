import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reconcileReceipts } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const capture = join(repo, "scripts/perplexity-capture.mjs");

const runHook = async ({ receiptFile, envelope }) =>
  await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [capture, "--hook", "--receipt-file", receiptFile],
      { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] }
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolveRun({ status, stderr: Buffer.concat(stderr).toString("utf8") })
    );
    child.stdin.end(JSON.stringify(envelope));
  });

const receiptsIn = async (receiptFile) => {
  const body = await readFile(receiptFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const scratch = async () => {
  const directory = await mkdtemp(join(tmpdir(), "perplexity-capture-"));
  return join(directory, "perplexity-api.jsonl");
};

const completion = (id, usage, model = "sonar-pro") => ({
  id,
  model,
  object: "chat.completion",
  created: 1785190700,
  choices: [{ message: { content: "synthetic answer body" } }],
  citations: ["https://example.com/synthetic"],
  usage
});

const curl = (body) => ({
  tool_input: { command: "curl -s -X POST https://api.perplexity.ai/chat/completions" },
  tool_response: body
});

const runRelay = async (receiptFile, responseBody) => {
  const directory = await mkdtemp(join(tmpdir(), "perplexity-relay-mock-"));
  const preload = join(directory, "https-mock.mjs");
  const responseFile = join(directory, "response.json");
  await writeFile(responseFile, responseBody);
  await writeFile(preload, `import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
https.request = () => {
  const request = new EventEmitter();
  request.end = () => queueMicrotask(() => {
    const response = Readable.from([readFileSync(process.env.SYNTHETIC_RESPONSE_FILE)]);
    response.statusCode = 200;
    request.emit("response", response);
  });
  return request;
};
syncBuiltinESMExports();
`);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", preload, capture, "--receipt-file", receiptFile], {
      cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PERPLEXITY_API_KEY: "synthetic-no-network", SYNTHETIC_RESPONSE_FILE: responseFile }
    });
    const stdout = [], stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) => resolveRun({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.stdin.end(JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content: "synthetic" }] }));
  });
};

test("captures exact counters and records neither prompt nor answer", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: curl(
      `noise before\n${JSON.stringify(
        completion("id-exact", {
          prompt_tokens: 129,
          completion_tokens: 2790,
          total_tokens: 2919,
          search_context_size: "low",
          num_search_queries: 2,
          cost: { total_cost: 0.048 }
        })
      )}\nnoise after`
    )
  });
  assert.equal(result.status, 0);

  const [receipt] = await receiptsIn(receiptFile);
  assert.equal(receipt.source, "perplexity_api");
  assert.equal(receipt.tokens, 2919);
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.fidelity, "exact");
  assert.equal(receipt.authority, "provider");
  assert.equal(receipt.surface, "api");
  assert.equal(receipt.capture_method, "tool_result_capture");
  assert.equal(receipt.snapshot_key, "perplexity:id-exact");
  assert.deepEqual(receipt.models, ["sonar-pro"]);

  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes("synthetic answer body"));
  assert.ok(!serialized.includes("example.com"));
  // Search counts are per-call units, not tokens. Present as provenance only.
  assert.ok(receipt.provenance.includes("2 search queries"));
  assert.ok(!serialized.includes("0.048"));
});

test("keeps the provider total when deep research bills beyond prompt and completion", async () => {
  const receiptFile = await scratch();
  await runHook({
    receiptFile,
    envelope: curl(
      JSON.stringify(
        completion(
          "id-deep",
          { prompt_tokens: 100, completion_tokens: 200, total_tokens: 5000 },
          "sonar-deep-research"
        )
      )
    )
  });
  const [receipt] = await receiptsIn(receiptFile);
  assert.equal(receipt.tokens, 5000);
  assert.ok(receipt.provenance.includes("provider total adds 4700"));
});

test("captures every call when one command makes several", async () => {
  const receiptFile = await scratch();
  await runHook({
    receiptFile,
    envelope: curl(
      [
        JSON.stringify(
          completion("id-a", { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })
        ),
        JSON.stringify(
          completion("id-b", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
        )
      ].join("\n")
    )
  });
  const receipts = await receiptsIn(receiptFile);
  assert.deepEqual(
    receipts.map((receipt) => receipt.snapshot_key),
    ["perplexity:id-a", "perplexity:id-b"]
  );
});

test("refuses inconsistent counters rather than recording a wrong total", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: curl(
      JSON.stringify(
        completion("id-bad", { prompt_tokens: 100, completion_tokens: 200, total_tokens: 5 })
      )
    )
  });
  // Exit 0 so the observed command is never failed, but the problem is loud
  // and no receipt is written. An unusable read must not look like zero usage.
  assert.equal(result.status, 0);
  assert.match(result.stderr, /counters are inconsistent/);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});

test("ignores commands that never reached Perplexity", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: {
      tool_input: { command: "npm run build" },
      tool_response: JSON.stringify(
        completion("id-elsewhere", {
          prompt_tokens: 5,
          completion_tokens: 5,
          total_tokens: 10
        })
      )
    }
  });
  assert.equal(result.status, 0);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});

test("the same call captured by hook and relay reconciles to one API inference", async () => {
  const receiptFile = await scratch();
  const envelope = curl(
    JSON.stringify(
      completion("id-shared", { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 })
    )
  );
  await runHook({ receiptFile, envelope });
  const relay = await runRelay(receiptFile, envelope.tool_response);
  assert.equal(relay.status, 0, relay.stderr);
  assert.equal(relay.stdout, envelope.tool_response);

  const receipts = await receiptsIn(receiptFile);
  assert.equal(receipts.length, 2);

  assert.equal(receipts[0].capture_method, "tool_result_capture");
  assert.equal(receipts[1].capture_method, "native_api_capture");
  const { receipts: reconciled, errors } = reconcileReceipts(receipts);
  assert.deepEqual(errors, []);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].tokens, 100);
  assert.equal(reconciled[0].surface, "api");
});

test("relay malformed-response diagnostics do not repeat private response excerpts", async () => {
  const receiptFile = await scratch();
  const result = await runRelay(receiptFile, '{"private-sentinel":');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /private-sentinel/);
  assert.match(result.stderr, /response was not valid JSON/);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});

test("identified API calls without counters warn safely and never fail the tool call", async () => {
  const cases = [
    { body: "", reason: /response text absent/ },
    { body: "private-marker without braces", reason: /usage object absent or response truncated/ },
    { body: '{"id":"private-marker"', reason: /usage object absent or response truncated/ },
    { body: "{private-marker}", reason: /response JSON malformed/ },
    {
      body: JSON.stringify({ id: "private-marker", model: "sonar-pro", choices: [] }),
      reason: /usage object absent or response truncated/
    }
  ];

  for (const fixture of cases) {
    const receiptFile = await scratch();
    const result = await runHook({ receiptFile, envelope: curl(fixture.body) });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /API call produced no usable usage counters/);
    assert.match(result.stderr, fixture.reason);
    assert.doesNotMatch(result.stderr, /private-marker/);
    assert.deepEqual(await receiptsIn(receiptFile), []);
  }
});

test("malformed hook envelopes use a fixed content-free diagnostic", async () => {
  const receiptFile = await scratch();
  const result = await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [capture, "--hook", "--receipt-file", receiptFile],
      { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] }
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolveRun({ status, stderr: Buffer.concat(stderr).toString("utf8") })
    );
    child.stdin.end('{"private-marker":');
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "Perplexity capture: hook envelope was not valid JSON.\n");
  assert.doesNotMatch(result.stderr, /private-marker/);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});
