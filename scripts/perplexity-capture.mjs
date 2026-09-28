#!/usr/bin/env node

// Perplexity Sonar API usage capture, prompt-free.
//
// Perplexity publishes no usage or billing endpoint: the only authoritative
// token counts are the `usage` object each chat/completions response carries.
// They exist once, in flight, and are gone when the response is discarded.
// Both modes below persist those counters and nothing else. Queries, answers,
// citations, and search results are never written.
//
// Two modes, because Perplexity is reached two ways here:
//
//   --hook   Claude Code PostToolUse hook. Reads the hook envelope on stdin,
//            keeps only Bash calls that hit api.perplexity.ai, and captures
//            the response the tool already returned. Nothing about how the
//            call is made has to change, so ad-hoc curl is captured too.
//
//   relay    Transparent client for scripted use outside Claude Code. Reads a
//            request body on stdin, relays the response to stdout byte for
//            byte, and captures on the way past.
//
// Usage:
//   node scripts/perplexity-capture.mjs --hook            < hook-input.json
//   node scripts/perplexity-capture.mjs --model sonar-pro < request.json

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
const DEFAULT_RECEIPT_FILE = resolve(
  REPO_ROOT,
  "scratch/receipts/perplexity-api.jsonl"
);
const API_HOST = "api.perplexity.ai";
const SOURCE = "perplexity_api";

const args = process.argv.slice(2);
const hookMode = args.includes("--hook");
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};

const receiptFile =
  valueOf("--receipt-file") ??
  process.env.PERPLEXITY_CAPTURE_RECEIPT_FILE ??
  DEFAULT_RECEIPT_FILE;

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

// Every field that is a token count, and every field that merely looks like one.
//
// `num_search_queries` and `search_context_size` describe search work, not
// tokens; summing them into a token total is the same mistake as summing
// Anthropic's `server_tool_use` counters. `cost` is deliberately unused —
// this repo models tokens, never money.
const usageOf = (usage, where) => {
  if (!usage || typeof usage !== "object") return null;
  const int = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  const prompt = int(usage.prompt_tokens);
  const completion = int(usage.completion_tokens);
  if (prompt === null || completion === null) {
    throw new Error(
      `${where}: usage lacked integer prompt_tokens and completion_tokens; refusing to guess a total`
    );
  }
  const parts = prompt + completion;
  const reported = int(usage.total_tokens);
  // sonar-deep-research bills citation and reasoning tokens that do not appear
  // in the prompt/completion split. Where the provider's own total exceeds the
  // parts, the provider is right and the difference is real work; keep it, and
  // say so in provenance rather than quietly reporting the smaller number.
  const tokens = reported !== null && reported > parts ? reported : parts;
  if (reported !== null && reported < parts) {
    throw new Error(
      `${where}: total_tokens ${reported} is below prompt+completion ${parts}; counters are inconsistent`
    );
  }
  return {
    tokens,
    prompt,
    completion,
    unattributed: tokens - parts,
    searchQueries: int(usage.num_search_queries),
    contextSize:
      typeof usage.search_context_size === "string" ? usage.search_context_size : null
  };
};

const buildReceipt = async ({ id, model, usage, captureMethod, createdAt }) => {
  const date = await dayOf(createdAt);
  const origin = await localOrigin();
  const detail = [
    `prompt ${usage.prompt}`,
    `completion ${usage.completion}`,
    usage.unattributed > 0 ? `provider total adds ${usage.unattributed}` : null,
    usage.contextSize ? `search context ${usage.contextSize}` : null,
    // Recorded, never summed: these are per-call units, not tokens.
    usage.searchQueries !== null ? `${usage.searchQueries} search queries` : null
  ].filter(Boolean);
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date,
    timezone: await timezone(),
    source: SOURCE,
    tokens: usage.tokens,
    calls: 1,
    fidelity: "exact",
    provider: "perplexity",
    surface: "api",
    capture_method: captureMethod,
    account_alias: accountAlias("perplexity"),
    machine_alias: machineAlias(),
    origin,
    interval: { start: date, end: date },
    // The response id is Perplexity's own request identifier, so a receipt
    // written twice for one call collapses instead of doubling.
    snapshot_key: `perplexity:${id}`,
    authority: "provider",
    models: [model],
    correlation_keys: [hashCorrelationKey(id)],
    provenance: `Perplexity chat/completions usage counters: ${detail.join(", ")}`
  };
  const errors = validateReceiptSchema(receipt, "Perplexity capture receipt");
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

// A completion response, wherever it appears. Returns null when the object is
// not one, and throws when it is one whose counters cannot be trusted.
const captureFrom = (value, where) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (!value.usage) return null;
  const usage = usageOf(value.usage, where);
  if (!usage) return null;
  return {
    id: value.id,
    model: typeof value.model === "string" && value.model.trim() ? value.model : "unknown",
    usage,
    createdAt: Number.isInteger(value.created)
      ? new Date(value.created * 1000).toISOString()
      : new Date().toISOString()
  };
};

const fail = (message, code = 2) => {
  console.error(`Perplexity capture: ${message}`);
  process.exit(code);
};

const warnUnavailable = (reason) => {
  console.error(
    `Perplexity capture: API call produced no usable usage counters (${reason}).`
  );
};

if (hookMode) {
  // A hook must never break the tool call it observes. Anything unrecognised
  // exits 0 and silent; only a Perplexity response with unusable counters is
  // worth a warning, and even that does not fail the user's command.
  let envelope;
  try {
    envelope = JSON.parse((await readStdin()).toString("utf8"));
  } catch {
    // An unreadable envelope is a harness fault, not an absence of usage. Say so
    // on stderr, then still exit 0 so the observed tool call is unaffected.
    console.error("Perplexity capture: hook envelope was not valid JSON.");
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

  // One Bash call can make several Perplexity calls, and the response is often
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
          // Count it, so a run that captures nothing can say why rather than
          // being indistinguishable from a call that carried no usage.
          unparsed += 1;
          break;
        }
        let capture;
        try {
          capture = captureFrom(parsed, "hook capture");
        } catch (error) {
          console.error(`Perplexity capture: ${error.message}`);
          break;
        }
        if (capture && !seen.has(capture.id)) {
          seen.add(capture.id);
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
    console.error(`Perplexity capture: ${error.message}`);
  }
  process.exit(0);
}

// Relay mode.
const apiKey = process.env.PERPLEXITY_API_KEY;
if (!apiKey) fail("PERPLEXITY_API_KEY is not set.", 1);

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
if (requestBody.stream) {
  // Streaming responses put `usage` in a terminal SSE frame that this relay
  // does not reassemble. Refusing is honest; capturing a partial count is not.
  fail("streaming requests are not captured; omit \"stream\": true.", 1);
}
requestBytes = Buffer.from(JSON.stringify({ ...requestBody, model }), "utf8");

let response;
try {
  response = await new Promise((accept, reject) => {
    const outgoing = httpsRequest(
      new URL("/chat/completions", `https://${API_HOST}`),
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
  fail(`Perplexity returned HTTP ${status}; no receipt written.`, 1);
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
