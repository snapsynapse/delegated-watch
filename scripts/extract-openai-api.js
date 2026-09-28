// Extract exact daily text-token usage from the OpenAI organization Usage API.
//
// Requires an organization admin key in OPENAI_ADMIN_KEY. When the variable is
// absent, the script exits successfully so unattended refreshes can still run.
// With the configured UTC day boundary it reads daily completions, embeddings,
// and moderations buckets directly. A non-UTC template falls back to hourly
// buckets and groups them into its configured calendar day. Non-token usage
// units such as images, audio seconds/characters, vector-store bytes, and Code
// Interpreter sessions are intentionally outside this token dashboard.
//
// Token definition follows the local Codex extractor: non-cached input plus
// output. Cached input is preserved in provenance and excluded from headline
// totals.
//
// Usage:
//   OPENAI_ADMIN_KEY=... node scripts/extract-openai-api.js
//     [--since YYYY-MM-DD] [--dry-run]
//
// Output: scratch/receipts/openai-api.jsonl (overwritten each run). Receipts
// are schema v2, account-scoped, with provider authority.
//
// This report covers every API key in the organization, whichever client used
// it. A local extractor that also counted that traffic (Codex signed in with
// an API key, or an editor extension or agent using the same organization's
// key) overlaps it and would be counted twice.

import {
  accountAlias,
  atomicWriteText
} from "./lib/openai-integrity.js";
import {
  nextUsagePage,
  tokenUsageForResult
} from "./lib/openai-usage.js";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const { timezone, windowStart } = await import("./lib/profile.js");
const { accountOrigin } = await import("./lib/origin.js");
const ORIGIN = accountOrigin("openai");
const TIMEZONE = await timezone();
const OUTPUT = "scratch/receipts/openai-api.jsonl";
// Overridable only so a test can point this at a loopback server; production
// always reads the real endpoint.
const API_ROOT = process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1/organization/usage";
const DEFAULT_SINCE = await windowStart();
const ENDPOINTS = ["completions", "embeddings", "moderations"];

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const since = flag("--since") ?? DEFAULT_SINCE;
const dryRun = args.includes("--dry-run");
const adminKey = process.env.OPENAI_ADMIN_KEY;
const receiptAccount = accountAlias("openai");

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must use YYYY-MM-DD.");
  process.exit(64);
}
// Three exit classes for this extractor, in order of how little they say:
//   0  not configured -- no key, so nothing was asked of the provider at all.
//   3  unreachable -- the provider could not be contacted; this run knows
//      nothing about the window, which is UNKNOWN, not a measured zero.
//   1  failed -- everything else, including an HTTP error status the
//      provider did return (an auth failure stays in this class, distinct
//      from unreachable).
if (!adminKey) {
  console.log("OPENAI_ADMIN_KEY not set; skipping OpenAI API extraction.");
  process.exit(0);
}

// Transport-level failures a network problem can produce -- the connection
// never reached the provider, so nothing about the window is known. Never
// logged with the request URL's query string or the key.
const UNREACHABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT"
]);

const exitIfUnreachable = (error, host) => {
  const code = error.cause?.code;
  const isAbort = error.name === "AbortError";
  if (!isAbort && !(code && UNREACHABLE_CODES.has(code))) return;
  console.error(
    `OpenAI Organization Usage API unreachable at ${host} (${isAbort ? "timeout" : code}); ` +
      "provider unreachable, this run knows nothing about the requested window."
  );
  process.exit(3);
};

const configuredDay = (unixSeconds) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(unixSeconds * 1000));

const start = new Date(`${since}T00:00:00Z`);
const bucketWidth = TIMEZONE === "UTC" ? "1d" : "1h";
const bucketLimit = TIMEZONE === "UTC" ? "31" : "168";
// A non-UTC calendar day can overlap the prior UTC day.
if (TIMEZONE !== "UTC") start.setUTCDate(start.getUTCDate() - 1);
const end = Math.floor(Date.now() / 1000) + 1;

const buckets = new Map();
let pages = 0;
for (const endpoint of ENDPOINTS) {
  let page = null;
  do {
    const url = new URL(`${API_ROOT}/${endpoint}`);
    url.searchParams.set("start_time", String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set("end_time", String(end));
    url.searchParams.set("bucket_width", bucketWidth);
    url.searchParams.set("limit", bucketLimit);
    url.searchParams.append("group_by", "model");
    if (page) url.searchParams.set("page", page);

    let response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      // One attempt, classified -- no retry-with-sleep here, which would hold
      // an unattended run open against a provider that is not answering.
      exitIfUnreachable(error, url.host);
      // An unrecognized transport error is still "failed", not "unreachable";
      // only the host and error identity are logged, never the URL itself.
      console.error(`OpenAI Organization Usage API request failed at ${url.host}: ${error.cause?.code ?? error.name}`);
      process.exit(1);
    }
    pages += 1;
    if (!response.ok) {
      console.error(
        `OpenAI Usage API ${endpoint} request failed: ${response.status} ${response.statusText}.`
      );
      process.exit(1);
    }
    const body = await response.json();
    for (const apiBucket of body.data ?? []) {
      const date = configuredDay(apiBucket.start_time);
      if (date < since) continue;
      for (const result of apiBucket.results ?? []) {
        const { tokens, cached } = tokenUsageForResult(result);
        if (!tokens) continue;
        const bucket = buckets.get(date) ?? {
          date,
          tokens: 0,
          cachedInput: 0,
          calls: 0,
          models: new Set(),
          endpoints: new Set()
        };
        bucket.tokens += tokens;
        bucket.cachedInput += cached;
        bucket.calls += result.num_model_requests ?? 0;
        bucket.endpoints.add(endpoint);
        if (result.model) bucket.models.add(result.model);
        buckets.set(date, bucket);
      }
    }
    try {
      page = nextUsagePage(body);
    } catch (error) {
      console.error(`OpenAI Usage API ${endpoint} schema error: ${error.message}.`);
      process.exit(1);
    }
  } while (page);
}

const receipts = [...buckets.values()]
  .filter((bucket) => bucket.tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((bucket) => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: "openai_api",
    provider: "openai",
    surface: "api",
    account_alias: receiptAccount,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `openai_api:${receiptAccount}:${bucket.date}`,
    authority: "provider",
    models: [...bucket.models].sort(),
    tokens: bucket.tokens,
    calls: bucket.calls,
    fidelity: "exact",
    origin: ORIGIN,
    provenance:
      `OpenAI organization Usage API (${[...bucket.endpoints].sort().join(", ")}): ${[...bucket.models].sort().join(", ") || "models not grouped"}; cached_input ${bucket.cachedInput} excluded`
  }));

for (const receipt of receipts) {
  const errors = validateReceiptSchema(receipt, `openai_api ${receipt.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
}

if (!receipts.length) {
  console.log(`No OpenAI API text-token usage found since ${since} (${pages} API pages); nothing written.`);
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) {
  process.stdout.write(jsonl);
  console.log(`Dry run: ${receipts.length} daily receipts from ${pages} OpenAI Usage API pages.`);
} else {
  await atomicWriteText(OUTPUT, jsonl);
  console.log(`Wrote ${receipts.length} daily receipts to ${OUTPUT} from ${pages} OpenAI Usage API pages.`);
}
