import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reconcileReceipts } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const capture = join(repo, "scripts/typesafe-capture.mjs");

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
    child.stdin.end(typeof envelope === "string" ? envelope : JSON.stringify(envelope));
  });

const receiptsIn = async (receiptFile) => {
  const body = await readFile(receiptFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

const scratch = async () => {
  const directory = await mkdtemp(join(tmpdir(), "typesafe-capture-"));
  return join(directory, "typesafe-api.jsonl");
};

// A System One response: no id, no timestamp, typed answers, two counters.
const evaluation = (usage, answers = { is_urgent: { type: "noul", noul: 0.95 } }, model = "jev-1.13.0") => ({
  model,
  answers,
  usage
});

const curl = (body) => ({
  tool_input: { command: "curl -s -X POST https://api.typesafe.ai/v1/systemone" },
  tool_response: body
});

const runRelay = async (receiptFile, responseBody, requestBody) => {
  const directory = await mkdtemp(join(tmpdir(), "typesafe-relay-mock-"));
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
      env: { ...process.env, TYPESAFE_API_KEY: "synthetic-no-network", SYNTHETIC_RESPONSE_FILE: responseFile }
    });
    const stdout = [], stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) => resolveRun({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.stdin.end(JSON.stringify(requestBody ?? {
      model: "jev-latest",
      state: "synthetic private state",
      questions: { is_urgent: { type: "noul", instructions: "synthetic question" } }
    }));
  });
};

test("captures exact counters and records neither state nor answers", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: curl(
      `noise before\n${JSON.stringify(
        evaluation({ input_tokens: 2713, output_tokens: 195 }, {
          family_building: { type: "noul", noul: 0.81 },
          family_writing: { type: "noul", noul: 0.12 },
          tone: { type: "choice", choice: "private-choice-sentinel", confidence: 0.7 }
        })
      )}\nnoise after`
    )
  });
  assert.equal(result.status, 0, result.stderr);

  const [receipt] = await receiptsIn(receiptFile);
  assert.equal(receipt.source, "typesafe_api");
  assert.equal(receipt.provider, "typesafe");
  assert.equal(receipt.tokens, 2908);
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.fidelity, "exact");
  assert.equal(receipt.authority, "provider");
  assert.equal(receipt.surface, "api");
  assert.equal(receipt.capture_method, "tool_result_capture");
  assert.match(receipt.snapshot_key, /^typesafe:[a-f0-9]{64}$/);
  assert.deepEqual(receipt.models, ["jev-1.13.0"]);
  // Questions are per-call units, recorded in provenance and never summed.
  assert.ok(receipt.provenance.includes("3 questions answered"));

  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes("private-choice-sentinel"));
  assert.ok(!serialized.includes("0.81"));
  assert.ok(!serialized.includes("family_building"));
});

test("identity survives reformatting: pretty-printed and raw responses share one key", async () => {
  const receiptFile = await scratch();
  const body = evaluation({ input_tokens: 40, output_tokens: 6 }, { b: { type: "noul", noul: 0.2 }, a: { type: "noul", noul: 0.9 } });
  await runHook({ receiptFile, envelope: curl(JSON.stringify(body, null, 2)) });
  const reordered = { usage: body.usage, answers: { a: body.answers.a, b: body.answers.b }, model: body.model };
  await runHook({ receiptFile, envelope: curl(JSON.stringify(reordered)) });
  const receipts = await receiptsIn(receiptFile);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].snapshot_key, receipts[1].snapshot_key);
  const { receipts: reconciled, errors } = reconcileReceipts(receipts);
  assert.deepEqual(errors, []);
  assert.equal(reconciled.length, 1);
});

test("replay dates a retained response to when it was observed", async () => {
  const receiptFile = await scratch();
  const result = await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [capture, "--hook", "--receipt-file", receiptFile, "--observed-at", "2026-03-04T23:59:00Z"],
      { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] }
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) => resolveRun({ status, stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify(curl(JSON.stringify(evaluation({ input_tokens: 9, output_tokens: 1 })))));
  });
  assert.equal(result.status, 0, result.stderr);
  const [receipt] = await receiptsIn(receiptFile);
  assert.equal(receipt.date, "2026-03-04");
  assert.deepEqual(receipt.interval, { start: "2026-03-04", end: "2026-03-04" });
});

test("captures every call when one command makes several", async () => {
  const receiptFile = await scratch();
  await runHook({
    receiptFile,
    envelope: curl(
      [
        JSON.stringify(evaluation({ input_tokens: 10, output_tokens: 2 })),
        JSON.stringify(evaluation({ input_tokens: 11, output_tokens: 2 }))
      ].join("\n")
    )
  });
  const receipts = await receiptsIn(receiptFile);
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].snapshot_key, receipts[1].snapshot_key);
  assert.deepEqual(receipts.map((receipt) => receipt.tokens), [12, 13]);
});

test("refuses non-integer counters rather than guessing a total", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: curl(JSON.stringify(evaluation({ input_tokens: "100", output_tokens: 2 })))
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /refusing to guess a total/);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});

test("ignores commands that never reached TypeSafe", async () => {
  const receiptFile = await scratch();
  const result = await runHook({
    receiptFile,
    envelope: {
      tool_input: { command: "curl -s https://api.perplexity.ai/chat/completions" },
      tool_response: JSON.stringify(evaluation({ input_tokens: 5, output_tokens: 5 }))
    }
  });
  assert.equal(result.status, 0);
  assert.deepEqual(await receiptsIn(receiptFile), []);
});

test("the same call captured by hook and relay reconciles to one API inference", async () => {
  const receiptFile = await scratch();
  const envelope = curl(JSON.stringify(evaluation({ input_tokens: 40, output_tokens: 60 })));
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

test("relay refuses a request without state or questions before any network call", async () => {
  const receiptFile = await scratch();
  const missingQuestions = await runRelay(receiptFile, "{}", { model: "jev-latest", state: "x", questions: {} });
  assert.equal(missingQuestions.status, 1);
  assert.match(missingQuestions.stderr, /questions must be a nonempty map/);
  const missingState = await runRelay(receiptFile, "{}", { model: "jev-latest", questions: { q: { type: "noul", instructions: "x" } } });
  assert.equal(missingState.status, 1);
  assert.match(missingState.stderr, /state is required/);
  assert.deepEqual(await receiptsIn(receiptFile), []);
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
    { body: '{"model":"private-marker"', reason: /usage object absent or response truncated/ },
    { body: "{private-marker}", reason: /response JSON malformed/ },
    {
      body: JSON.stringify({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.5, note: "private-marker" } } }),
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
  const result = await runHook({ receiptFile, envelope: '{"private-marker":' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "TypeSafe capture: hook envelope was not valid JSON.\n");
  assert.deepEqual(await receiptsIn(receiptFile), []);
});
