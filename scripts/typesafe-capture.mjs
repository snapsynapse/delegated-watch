#!/usr/bin/env node

// TypeSafe System One (Jev) usage capture, state-free.
//
// TypeSafe publishes no usage or billing endpoint. The only authoritative
// token counts are the `usage` object each /v1/systemone response carries:
// `input_tokens` and `output_tokens`, in flight, gone when the response is
// discarded. Both modes below persist those counters and nothing else. The
// state sent for judgment, the questions, and the answers are never written.
//
// Two modes, the same shape as scripts/perplexity-capture.mjs:
//
//   --hook   Claude Code PostToolUse hook. Reads the hook envelope on stdin,
//            keeps only Bash calls that hit api.typesafe.ai, and captures the
//            response the tool already returned. Ad-hoc curl is captured too.
//
//   relay    Transparent client for scripted use outside Claude Code. Reads a
//            request body on stdin, relays the response to stdout byte for
//            byte, and captures on the way past.
//
// Identity. A TypeSafe response carries no request id and no timestamp, so
// the receipt keys on a SHA-256 of the canonical response document (model,
// answers, usage; keys sorted). Hook and relay captures of the same call
// therefore reconcile instead of double counting. The known cost: two calls on
// one day whose responses are byte-identical after canonicalisation collapse
// to one receipt. Identical state and questions to a deterministic model can
// produce that, so a repeated experiment run is under-counted by design rather
// than a single call being counted twice. Prefer the smaller error.
//
// Usage:
//   node scripts/typesafe-capture.mjs --hook              < hook-input.json
//   node scripts/typesafe-capture.mjs [--model jev-latest] < request.json
//
// Replay. A response body retained by an earlier run can be fed through hook
// mode after the fact with `--observed-at <ISO 8601>`, which dates the receipt
// to when the call was made rather than when it was replayed. Without the flag
// a capture is dated now, which is only correct for a live call.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountAlias, machineAlias } from "./lib/openai-integrity.js";
import { localOrigin } from "./lib/origin.js";
import { dayOf, timezone } from "./lib/profile.js";
import {
  hashCorrelationKey,
  RECEIPT_SCHEMA_VERSION,
  validateReceiptSchema
} from "./lib/receipt-schema.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RECEIPT_FILE = resolve(REPO_ROOT, "scratch/receipts/typesafe-api.jsonl");
const API_HOST = "api.typesafe.ai";
const API_PATH = "/v1/systemone";
const SOURCE = "typesafe_api";

const args = process.argv.slice(2);
const hookMode = args.includes("--hook");
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};

const observedAt = valueOf("--observed-at");
if (observedAt !== null && Number.isNaN(Date.parse(observedAt))) {
  throw new Error("--observed-at must be an ISO 8601 timestamp");
}

const receiptFile =
  valueOf("--receipt-file") ??
  process.env.TYPESAFE_CAPTURE_RECEIPT_FILE ??
  DEFAULT_RECEIPT_FILE;

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// Key order must not change identity: a pretty-printed response in a tool
// result and the raw bytes from the relay are the same call.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

// The two counters, and only the two. There is no cache split and no provider
// total to cross-check, so the total is their sum and nothing else.
const usageOf = (usage, where) => {
  if (!usage || typeof usage !== "object") return null;
  const int = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const input = int(usage.input_tokens);
  const output = int(usage.output_tokens);
  if (input === null || output === null) {
    throw new Error(
      `${where}: usage lacked integer input_tokens and output_tokens; refusing to guess a total`
    );
  }
  return { tokens: input + output, input, output };
};

const buildReceipt = async ({ digest, model, usage, questions, captureMethod, createdAt }) => {
  const date = await dayOf(createdAt);
  const origin = await localOrigin();
  const detail = [
    `input ${usage.input}`,
    `output ${usage.output}`,
    // Recorded, never summed: questions are per-call units, not tokens.
    `${questions} questions answered`
  ];
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date,
    timezone: await timezone(),
    source: SOURCE,
    tokens: usage.tokens,
    calls: 1,
    fidelity: "exact",
    provider: "typesafe",
    surface: "api",
    capture_method: captureMethod,
    account_alias: accountAlias("typesafe"),
    machine_alias: machineAlias(),
    origin,
    interval: { start: date, end: date },
    snapshot_key: `typesafe:${digest}`,
    authority: "provider",
    models: [model],
    correlation_keys: [hashCorrelationKey(digest)],
    provenance: `TypeSafe System One usage counters: ${detail.join(", ")}`
  };
  const errors = validateReceiptSchema(receipt, "TypeSafe capture receipt");
  if (errors.length) throw new Error(errors.join("\n"));
  return receipt;
};

const writeReceipts = async (receipts) => {
  if (!receipts.length) return;
  await mkdir(dirname(receiptFile), { recursive: true });
  await appendFile(
    receiptFile,
    `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
    { encoding: "utf8", flag: "a" }
  );
};

// A System One response, wherever it appears: a `model`, an `answers` map, and
// a `usage` object. Returns null when the object is not one, and throws when it
// is one whose counters cannot be trusted.
const captureFrom = (value, where) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) {
    return null;
  }
  if (!value.usage) return null;
  const usage = usageOf(value.usage, where);
  if (!usage) return null;
  const model = typeof value.model === "string" && value.model.trim() ? value.model : "unknown";
  const digest = createHash("sha256")
    .update(canonical({ model, answers: value.answers, usage: value.usage }))
    .digest("hex");
  return {
    digest,
    model,
    usage,
    questions: Object.keys(value.answers).length,
    createdAt: observedAt ?? new Date().toISOString()
  };
};

const fail = (message, code = 2) => {
  console.error(`TypeSafe capture: ${message}`);
  process.exit(code);
};

const warnUnavailable = (reason) => {
  console.error(`TypeSafe capture: API call produced no usable usage counters (${reason}).`);
};

if (hookMode) {
  // A hook must never break the tool call it observes. Anything unrecognised
  // exits 0 and silent; only a TypeSafe response with unusable counters is
  // worth a warning, and even that does not fail the user's command.
  let envelope;
  try {
    envelope = JSON.parse((await readStdin()).toString("utf8"));
  } catch {
    // An unreadable envelope is a harness fault, not an absence of usage. Say so
    // on stderr, then still exit 0 so the observed tool call is unaffected.
    console.error("TypeSafe capture: hook envelope was not valid JSON.");
    process.exit(0);
  }
  const command = envelope?.tool_input?.command;
  if (typeof command !== "string" || !command.includes(API_HOST)) process.exit(0);

  const response = envelope.tool_response;
  const text =
    typeof response === "string"
      ? response
      : typeof response?.stdout === "string"
        ? response.stdout
        : null;
  if (!text) {
    warnUnavailable("response text absent");
    process.exit(0);
  }

  // One Bash call can make several TypeSafe calls, and the response is often
  // wrapped in other output. Scan for every top-level JSON object rather than
  // assuming the whole payload parses.
  const captures = [];
  const seen = new Set();
  let unparsed = 0;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        const slice = text.slice(start, index + 1);
        let parsed;
        try {
          parsed = JSON.parse(slice);
        } catch {
          // A brace-balanced slice that is not JSON is ordinary in mixed output,
          // but it is also what a truncated or error-page response looks like.
          // Count it, so a run that captures nothing can say why.
          unparsed += 1;
          break;
        }
        let capture;
        try {
          capture = captureFrom(parsed, "hook capture");
        } catch (error) {
          console.error(`TypeSafe capture: ${error.message}`);
          break;
        }
        if (capture && !seen.has(capture.digest)) {
          seen.add(capture.digest);
          captures.push(capture);
        }
        start = index;
        break;
      }
    }
  }
  if (!captures.length) {
    warnUnavailable(unparsed ? "response JSON malformed" : "usage object absent or response truncated");
    process.exit(0);
  }

  try {
    const receipts = [];
    for (const capture of captures) {
      receipts.push(await buildReceipt({ ...capture, captureMethod: "tool_result_capture" }));
    }
    await writeReceipts(receipts);
  } catch (error) {
    // Loud enough to see, quiet enough not to fail the command that triggered it.
    console.error(`TypeSafe capture: ${error.message}`);
  }
  process.exit(0);
}

// Relay mode.
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) fail("TYPESAFE_API_KEY is not set.", 1);

let requestBytes;
let requestBody;
try {
  requestBytes = await readStdin();
  requestBody = JSON.parse(requestBytes.toString("utf8"));
} catch {
  fail("stdin must contain one valid JSON request body.", 1);
}
if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
  fail("request body must be a JSON object.", 1);
}
const model = valueOf("--model") ?? requestBody.model;
if (typeof model !== "string" || !model.trim()) {
  fail("request.model must be a nonempty string.", 1);
}
if (!("state" in requestBody)) fail("request.state is required.", 1);
if (
  !requestBody.questions ||
  typeof requestBody.questions !== "object" ||
  Array.isArray(requestBody.questions) ||
  !Object.keys(requestBody.questions).length
) {
  fail("request.questions must be a nonempty map.", 1);
}
requestBytes = Buffer.from(JSON.stringify({ ...requestBody, model }), "utf8");

let response;
try {
  response = await new Promise((accept, reject) => {
    const outgoing = httpsRequest(
      new URL(API_PATH, `https://${API_HOST}`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "content-length": requestBytes.length
        }
      }
    );
    outgoing.once("response", accept);
    outgoing.once("error", reject);
    outgoing.end(requestBytes);
  });
} catch (error) {
  fail(`request failed: ${error.message}`, 1);
}

const responseChunks = [];
for await (const chunk of response) {
  const bytes = Buffer.from(chunk);
  responseChunks.push(bytes);
  if (!process.stdout.write(bytes)) {
    await new Promise((accept) => process.stdout.once("drain", accept));
  }
}

const status = response.statusCode ?? 500;
if (status < 200 || status >= 300) {
  fail(`TypeSafe returned HTTP ${status}; no receipt written.`, 1);
}

let capture;
try {
  capture = captureFrom(
    JSON.parse(Buffer.concat(responseChunks).toString("utf8")),
    "relay capture"
  );
} catch (error) {
  if (error instanceof SyntaxError) {
    fail("response was not valid JSON; no receipt written.");
  }
  fail(error.message);
}
if (!capture) {
  fail("response carried no usable usage counters; no receipt written.");
}

try {
  await writeReceipts([
    await buildReceipt({ ...capture, captureMethod: "native_api_capture" })
  ]);
} catch (error) {
  fail(`could not append receipt: ${error.message}`);
}
