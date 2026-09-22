import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { localModelSource } from "../scripts/lib/local-model-source.js";

const repo = resolve(import.meta.dirname, "..");
const wrapper = join(repo, "scripts/ollama-capture.mjs");

const runWrapper = async ({ baseUrl, endpoint, receiptFile, request }) =>
  await new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        wrapper,
        "--base-url",
        baseUrl,
        "--endpoint",
        endpoint,
        "--receipt-file",
        receiptFile
      ],
      { cwd: repo, stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolveRun({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    );
    child.stdin.end(request);
  });

const withServer = async (handler, work) => {
  const server = createServer(handler);
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  try {
    const address = server.address();
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
};

test("captures exact non-streaming generate usage without retaining content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ollama-capture-generate-"));
  const receiptFile = join(cwd, "receipts.jsonl");
  const prompt = "PRIVATE_PROMPT_SENTINEL";
  const generated = "PRIVATE_RESPONSE_SENTINEL";
  const responseBody = Buffer.from(
    JSON.stringify({
      model: "gemma4:31b-mlx",
      response: generated,
      done: true,
      prompt_eval_count: 17,
      eval_count: 5
    })
  );

  await withServer(
    (request, response) => {
      assert.equal(request.url, "/api/generate");
      response.setHeader("content-type", "application/json");
      response.end(responseBody);
    },
    async (baseUrl) => {
      const result = await runWrapper({
        baseUrl,
        endpoint: "generate",
        receiptFile,
        request: JSON.stringify({ model: "gemma4:31b-mlx", prompt, stream: false })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout, responseBody);
    }
  );

  const stored = await readFile(receiptFile, "utf8");
  const receipt = JSON.parse(stored);
  assert.equal(receipt.source, "gemma_local");
  assert.equal(receipt.tokens, 22);
  assert.equal(receipt.calls, 1);
  assert.equal(receipt.fidelity, "exact");
  assert.equal(receipt.provider, "ollama");
  assert.equal(receipt.authority, "provider");
  assert.ok(!stored.includes(prompt));
  assert.ok(!stored.includes(generated));
});

test("relays streamed chat bytes unchanged and captures final counters", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ollama-capture-chat-"));
  const receiptFile = join(cwd, "receipts.jsonl");
  const chunks = [
    '{"model":"qwen3.6:35b-mlx","message":{"role":"assistant","content":"A"},"done":false}\n',
    '{"model":"qwen3.6:35b-mlx","message":{"role":"assistant","content":"B"},"done":true,"prompt_eval_count":11,"eval_count":2}\n'
  ];

  await withServer(
    (_request, response) => {
      response.setHeader("content-type", "application/x-ndjson");
      response.write(chunks[0]);
      response.end(chunks[1]);
    },
    async (baseUrl) => {
      const result = await runWrapper({
        baseUrl,
        endpoint: "chat",
        receiptFile,
        request: JSON.stringify({
          model: "qwen3.6:35b-mlx",
          messages: [{ role: "user", content: "private" }]
        })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.toString("utf8"), chunks.join(""));
    }
  );

  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.equal(receipt.source, "qwen_local");
  assert.equal(receipt.tokens, 13);
});

test("returns successful response but fails closed when counters are absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ollama-capture-missing-"));
  const receiptFile = join(cwd, "receipts.jsonl");
  const responseBody = Buffer.from('{"model":"gemma4","response":"text","done":true}');

  await withServer(
    (_request, response) => response.end(responseBody),
    async (baseUrl) => {
      const result = await runWrapper({
        baseUrl,
        endpoint: "generate",
        receiptFile,
        request: '{"model":"gemma4","prompt":"private","stream":false}'
      });
      assert.equal(result.status, 2);
      assert.deepEqual(result.stdout, responseBody);
      assert.match(result.stderr, /lacked authoritative/);
    }
  );

  await assert.rejects(readFile(receiptFile, "utf8"), { code: "ENOENT" });
});

test("relays HTTP errors without writing a receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ollama-capture-error-"));
  const receiptFile = join(cwd, "receipts.jsonl");
  const responseBody = Buffer.from('{"error":"model not found"}');

  await withServer(
    (_request, response) => {
      response.statusCode = 404;
      response.end(responseBody);
    },
    async (baseUrl) => {
      const result = await runWrapper({
        baseUrl,
        endpoint: "generate",
        receiptFile,
        request: '{"model":"missing","prompt":"private"}'
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.stdout, responseBody);
      assert.match(result.stderr, /HTTP 404/);
    }
  );

  await assert.rejects(readFile(receiptFile, "utf8"), { code: "ENOENT" });
});
