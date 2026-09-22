#!/usr/bin/env node

// Transparent Ollama native-API client with prompt-free usage capture.
//
// The request body is read from stdin and the response body is relayed to
// stdout byte-for-byte. Only model identity and authoritative token counters
// are persisted. Prompts, messages, generated text, and tool payloads are not.
//
// Usage:
//   node scripts/ollama-capture.mjs --endpoint generate < request.json
//   node scripts/ollama-capture.mjs --endpoint chat < request.json

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
import {
  hashCorrelationKey,
  RECEIPT_SCHEMA_VERSION,
  validateReceiptSchema
} from "./lib/receipt-schema.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RECEIPT_FILE = resolve(
  REPO_ROOT,
  "scratch/receipts/ollama-capture.jsonl"
);
const ALLOWED_ENDPOINTS = new Set(["chat", "generate"]);

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
};

const endpoint = valueOf("--endpoint") ?? "generate";
if (!ALLOWED_ENDPOINTS.has(endpoint)) {
  throw new Error("--endpoint must be chat or generate");
}

let baseUrl = (
  valueOf("--base-url") ??
  process.env.OLLAMA_HOST ??
  "http://127.0.0.1:11434"
).replace(/\/+$/, "");
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
const receiptFile =
  valueOf("--receipt-file") ??
  process.env.OLLAMA_CAPTURE_RECEIPT_FILE ??
  DEFAULT_RECEIPT_FILE;

let requestBytes;
let request;
try {
  const inputChunks = [];
  for await (const chunk of process.stdin) inputChunks.push(Buffer.from(chunk));
  requestBytes = Buffer.concat(inputChunks);
  request = JSON.parse(requestBytes.toString("utf8"));
} catch {
  console.error("Ollama capture: stdin must contain one valid JSON request body.");
  process.exit(1);
}
if (!request || typeof request !== "object" || Array.isArray(request)) {
  console.error("Ollama capture: request body must be a JSON object.");
  process.exit(1);
}
if (typeof request.model !== "string" || !request.model.trim()) {
  console.error("Ollama capture: request.model must be a nonempty string.");
  process.exit(1);
}

const responseUrl = new URL(`/api/${endpoint}`, `${baseUrl}/`);
if (!["http:", "https:"].includes(responseUrl.protocol)) {
  throw new Error("--base-url must use http or https");
}
let response;
try {
  response = await new Promise((resolveResponse, rejectResponse) => {
    const send = responseUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(responseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": requestBytes.length
      }
    });
    outgoing.once("response", resolveResponse);
    outgoing.once("error", rejectResponse);
    outgoing.end(requestBytes);
  });
} catch (error) {
  console.error(`Ollama capture: request failed: ${error.message}`);
  process.exit(1);
}

let usage;
let responseBytes = [];
let pendingLine = "";
const decoder = new TextDecoder();
const isStreaming =
  request.stream !== false ||
  String(response.headers["content-type"]).includes("ndjson");
const inspectUsage = (candidate) => {
  if (!candidate.trim()) return;
  try {
    const parsed = JSON.parse(candidate);
    if (
      Number.isInteger(parsed.prompt_eval_count) &&
      parsed.prompt_eval_count >= 0 &&
      Number.isInteger(parsed.eval_count) &&
      parsed.eval_count >= 0
    ) {
      usage = {
        model:
          typeof parsed.model === "string" && parsed.model.trim()
            ? parsed.model
            : request.model,
        promptTokens: parsed.prompt_eval_count,
        outputTokens: parsed.eval_count
      };
    }
  } catch {
    // Never include response content in diagnostics or receipts.
  }
};
for await (const chunk of response) {
  const bytes = Buffer.from(chunk);
  if (!process.stdout.write(bytes)) {
    await new Promise((accept) => process.stdout.once("drain", accept));
  }
  if (isStreaming) {
    pendingLine += decoder.decode(bytes, { stream: true });
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop() ?? "";
    for (const line of lines) inspectUsage(line);
  } else {
    responseBytes.push(bytes);
  }
}

if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
  console.error(
    `Ollama capture: Ollama returned HTTP ${response.statusCode}; no receipt written.`
  );
  process.exit(1);
}

if (isStreaming) inspectUsage(pendingLine + decoder.decode());
else inspectUsage(Buffer.concat(responseBytes).toString("utf8"));

if (!usage) {
  console.error(
    "Ollama capture: response lacked authoritative prompt_eval_count and eval_count; no receipt written."
  );
  process.exit(2);
}

const capturedAt = new Date().toISOString();
const date = await dayOf(capturedAt);
const requestId = randomUUID();
const origin = await localOrigin();
const receipt = {
  schema_version: RECEIPT_SCHEMA_VERSION,
  date,
  timezone: await timezone(),
  source: localModelSource(usage.model, "ollama"),
  tokens: usage.promptTokens + usage.outputTokens,
  calls: 1,
  fidelity: "exact",
  provider: "ollama",
  surface: "native_api_capture",
  account_alias: accountAlias("ollama"),
  machine_alias: machineAlias(),
  origin,
  interval: { start: date, end: date },
  snapshot_key: `ollama:${origin}:${requestId}`,
  authority: "provider",
  models: [usage.model],
  correlation_keys: [hashCorrelationKey(requestId)],
  provenance: `Ollama native response counters: prompt ${usage.promptTokens}, output ${usage.outputTokens}`
};
const schemaErrors = validateReceiptSchema(receipt, "Ollama capture receipt");
if (schemaErrors.length) {
  console.error(schemaErrors.join("\n"));
  process.exit(2);
}

try {
  await mkdir(dirname(receiptFile), { recursive: true });
  await appendFile(receiptFile, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    flag: "a"
  });
} catch (error) {
  console.error(`Ollama capture: could not append receipt: ${error.message}`);
  process.exit(2);
}
