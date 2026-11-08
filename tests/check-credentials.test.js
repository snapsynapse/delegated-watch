import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

const script = join(resolve(import.meta.dirname, ".."), "scripts/check-credentials.js");
const GOOD = "sk-admin-good";
const TRUNCATED = `sk-admin-${"x".repeat(119)}`;

// A local stand-in for both providers, never the network: one accepted key,
// everything else is rejected the way a provider rejects an unknown key, with
// a message that echoes the key.
const standInProvider = async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const key = request.headers["x-api-key"] ?? request.headers.authorization?.split(" ")[1];
    response.setHeader("content-type", "application/json");
    if (key === GOOD) {
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key provided: ${key}` } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, requests, close: () => new Promise((done) => server.close(done)) };
};

const check = (env, args = []) => new Promise((done) => {
  execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
    done({ status: error ? error.code : 0, output: stdout + stderr });
  });
});

const providerEnv = (base, keys) => ({
  ANTHROPIC_API_BASE_URL: `${base}/anthropic/usage_report/messages`,
  OPENAI_API_BASE_URL: `${base}/openai/usage`,
  ...keys
});

test("accepted keys pass", async () => {
  const { base, close } = await standInProvider();
  try {
    const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: GOOD, OPENAI_ADMIN_KEY: GOOD }));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Anthropic admin key: accepted/);
    assert.match(result.output, /OpenAI admin key: accepted/);
  } finally {
    await close();
  }
});

test("a rejected key fails with the provider's code, never the key or its message", async () => {
  const { base, close } = await standInProvider();
  try {
    const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: GOOD, OPENAI_ADMIN_KEY: TRUNCATED }));
    assert.equal(result.status, 1);
    assert.match(result.output, /OpenAI admin key: rejected -- HTTP 401 \(invalid_request_error, invalid_api_key\)/);
    assert.match(result.output, /exactly 128 characters/, "a 128-character key points at Keychain truncation");
    assert.doesNotMatch(result.output, /x{20}/);
    assert.doesNotMatch(result.output, /Incorrect API key/);
  } finally {
    await close();
  }
});

test("a rejected key of another length gets no truncation hint", async () => {
  const { base, close } = await standInProvider();
  try {
    const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: "sk-ant-admin-old", OPENAI_ADMIN_KEY: GOOD }));
    assert.equal(result.status, 1);
    assert.match(result.output, /Anthropic admin key: rejected/);
    assert.doesNotMatch(result.output, /128 characters/);
  } finally {
    await close();
  }
});

test("an unset key is skipped without a request, because its extractor skips too", async () => {
  const { base, requests, close } = await standInProvider();
  try {
    const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: GOOD }));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /OpenAI admin key: skipped -- OPENAI_ADMIN_KEY is not set/);
    assert.equal(requests.length, 1, "only the Anthropic key was read");
    const none = await check(providerEnv(base, {}));
    assert.equal(none.status, 0, none.output);
    assert.equal(requests.length, 1);
  } finally {
    await close();
  }
});

test("--provider checks only that provider", async () => {
  const { base, requests, close } = await standInProvider();
  try {
    const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: "rejected-key", OPENAI_ADMIN_KEY: GOOD }), ["--provider", "openai"]);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /Anthropic/);
    assert.deepEqual(requests.map((url) => url.split("?")[0]), ["/openai/usage/completions"]);
    const usage = await check({}, ["--provider", "other"]);
    assert.equal(usage.status, 64);
  } finally {
    await close();
  }
});

test("an unreachable provider is unknown, not a rejected key", async () => {
  const { base, close } = await standInProvider();
  await close();
  const result = await check(providerEnv(base, { ANTHROPIC_ADMIN_KEY: GOOD, OPENAI_ADMIN_KEY: GOOD }));
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /unreachable \(ECONNREFUSED\)/);
});
