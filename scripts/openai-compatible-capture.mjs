#!/usr/bin/env node

// Transparent client for any OpenAI-compatible chat completions endpoint, with
// prompt-free usage capture. One capture covers local runners (LM Studio,
// llama.cpp's server, vLLM, MLX's server) and hosted APIs (xAI, Mistral,
// DeepSeek, Groq, OpenRouter, Together, and any other endpoint in the same
// shape), because all of them return the same usage object in each response.
//
// The request body is read from stdin and sent unchanged; the response is
// relayed to stdout byte for byte. Only the model and the usage counters are
// kept. Prompts, messages, completions, tool payloads, and keys never are.
//
// Token definition: prompt - cached prompt + completion. Cached prompt tokens
// come from prompt_tokens_details.cached_tokens, or DeepSeek's
// prompt_cache_hit_tokens, and are kept in provenance, per invariant 5.
// Reasoning tokens are already inside completion_tokens.
//
// OpenAI itself is deliberately not a preset: its organization usage report
// (npm run extract:openai-api) already counts every call made with its keys,
// so capturing them here too would count them twice.
//
// Usage:
//   node scripts/openai-compatible-capture.mjs --provider NAME < request.json
//   node scripts/openai-compatible-capture.mjs --base-url URL --source ID
//     [--key-env VARIABLE] [--local] < request.json
//
// Presets set the base URL, the environment variable holding the key, and the
// source id; --base-url overrides a preset's URL, for a runner on another port.
// Streaming requests are refused: usage arrives in a final chunk only when the
// request asks for it, and this relay never rewrites a request.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountAlias, machineAlias } from "./lib/openai-integrity.js";
import { localModelSource } from "./lib/local-model-source.js";
import { localOrigin } from "./lib/origin.js";
import { dayOf, timezone } from "./lib/profile.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const PRESETS = {
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", local: true },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", local: true },
  vllm: { baseUrl: "http://127.0.0.1:8000/v1", local: true },
  mlx: { baseUrl: "http://127.0.0.1:8080/v1", local: true },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" }
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`, 64);
  return value;
};
function fail(message, code = 2) {
  console.error(`OpenAI-compatible capture: ${message}`);
  process.exit(code);
}

const providerName = valueOf("--provider");
const preset = providerName ? PRESETS[providerName] : null;
if (providerName && !preset) {
  fail(`unknown --provider ${providerName}. Presets: ${Object.keys(PRESETS).join(", ")}; or use --base-url with --source.`, 64);
}
const baseUrl = (valueOf("--base-url") ?? preset?.baseUrl ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(baseUrl)) fail("give --provider NAME, or --base-url http(s)://HOST/v1 with --source ID.", 64);
const customSource = valueOf("--source");
if (!providerName && !customSource) fail("--base-url needs --source ID, the source id its receipts carry.", 64);
if (customSource && !/^[a-z][a-z0-9_]*$/.test(customSource)) fail("--source must be lowercase letters, digits, and underscores.", 64);
const local = preset?.local ?? args.includes("--local");
const keyEnv = valueOf("--key-env") ?? preset?.keyEnv ?? null;
const provider = providerName ?? customSource;
const receiptFile =
  valueOf("--receipt-file") ??
  process.env.OPENAI_COMPATIBLE_CAPTURE_RECEIPT_FILE ??
  resolve(REPO_ROOT, "scratch/receipts/openai-compatible-capture.jsonl");

const apiKey = keyEnv ? process.env[keyEnv] : null;
if (keyEnv && !apiKey) fail(`${keyEnv} is not set.`, 1);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const requestBytes = Buffer.concat(chunks);
let requestBody;
try {
  requestBody = JSON.parse(requestBytes.toString("utf8"));
} catch {
  fail("stdin must contain one valid JSON request body.", 1);
}
if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) fail("request body must be a JSON object.", 1);
if (typeof requestBody.model !== "string" || !requestBody.model.trim()) fail("request.model must be a nonempty string.", 1);
if (requestBody.stream) fail("streaming requests are not captured; omit \"stream\": true.", 1);

const target = new URL(`${baseUrl}/chat/completions`);
let response;
try {
  response = await new Promise((accept, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": requestBytes.length,
        ...(apiKey ? { authorization: ["Bearer", apiKey].join(" ") } : {})
      }
    });
    outgoing.once("response", accept);
    outgoing.once("error", reject);
    outgoing.end(requestBytes);
  });
} catch (error) {
  // The request never reached the endpoint: its usage is unknown.
  fail(`${target.host} could not be reached (${error.code ?? error.message}); no receipt written.`, 3);
}

const responseChunks = [];
for await (const chunk of response) {
  const bytes = Buffer.from(chunk);
  responseChunks.push(bytes);
  if (!process.stdout.write(bytes)) await new Promise((accept) => process.stdout.once("drain", accept));
}
const status = response.statusCode ?? 500;
if (status < 200 || status >= 300) fail(`${target.host} returned HTTP ${status}; no receipt written.`, 1);

let body;
try {
  body = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
} catch {
  fail("the response was not valid JSON; no receipt written.");
}
const usage = body?.usage;
const int = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const prompt = int(usage?.prompt_tokens);
const completion = int(usage?.completion_tokens);
if (prompt === null || completion === null) fail("the response carried no integer prompt_tokens and completion_tokens; no receipt written.");
const cached = int(usage.prompt_tokens_details?.cached_tokens) ?? int(usage.prompt_cache_hit_tokens) ?? 0;
if (cached > prompt) fail("cached prompt tokens exceed prompt tokens; counters are inconsistent, no receipt written.");

const model = typeof body.model === "string" && body.model.trim() ? body.model : requestBody.model;
const source = local ? localModelSource(model, provider) : `${provider}_api`;
const capturedAt = Number.isInteger(body.created) ? new Date(body.created * 1000).toISOString() : new Date().toISOString();
const date = await dayOf(capturedAt);
const origin = await localOrigin();
const identity = typeof body.id === "string" && body.id.trim() ? body.id : randomUUID();
const receipt = {
  schema_version: RECEIPT_SCHEMA_VERSION,
  date,
  timezone: await timezone(),
  source,
  tokens: prompt - cached + completion,
  calls: 1,
  fidelity: "exact",
  provider,
  surface: "openai_compatible_capture",
  account_alias: accountAlias(provider),
  machine_alias: machineAlias(),
  origin,
  interval: { start: date, end: date },
  // The response id, where the endpoint gives one, is its own request identity,
  // so a receipt written twice for one call collapses instead of doubling.
  snapshot_key: `${provider}:${identity}`,
  authority: "provider",
  models: [model],
  correlation_keys: [hashCorrelationKey(`${provider}:${identity}`)],
  provenance: `OpenAI-compatible usage from ${local ? "a local runner" : "the provider"}: prompt ${prompt}, completion ${completion}; cached ${cached} excluded`
};
const errors = validateReceiptSchema(receipt, "OpenAI-compatible capture receipt");
if (errors.length) fail(errors.join("; "));
try {
  await mkdir(dirname(receiptFile), { recursive: true });
  await appendFile(receiptFile, `${JSON.stringify(receipt)}\n`, "utf8");
} catch (error) {
  fail(`could not append the receipt: ${error.message}`);
}
