// Extract exact per-day Anthropic API token usage via the Admin Usage Report
// API into receipt JSONL under scratch/receipts/. Read-only against the API.
//
// Requires an Anthropic admin key in the environment (never committed):
//   ANTHROPIC_ADMIN_KEY=... node scripts/extract-claude-api.js
//
// Without the key the script prints a skip notice and exits 0 so that the
// refresh chain keeps running on machines without console access.
//
// Buckets are regrouped into the configured calendar day (config/profile.json)
// so the boundary matches every other source. Token definition mirrors
// extract-claude-code.js: uncached input + cache_creation + output; cache
// reads are excluded from the headline count and preserved in provenance.
//
// Usage:
//   node scripts/extract-claude-api.js [--since YYYY-MM-DD] [--pace MS] [--dry-run]
//   node scripts/extract-claude-api.js --backfill   # ignore the horizon, read all history
//   node scripts/extract-claude-api.js --scan   # locate where usage begins, cheaply
//
// Output: scratch/reconcile/claude-api.jsonl until a reconciliation verdict is
// recorded, scratch/receipts/claude-api.jsonl once it is additive; overwritten
// each run. Receipts are schema v2, account-scoped, with provider authority.
//
// This report covers every API key in the organization, whichever client used
// it. Any local extractor that also counted that traffic (Claude Code with an
// API key, or an editor extension or agent pointed at the same organization)
// overlaps it, which is what the reconciliation step exists to decide.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { accountAlias } from "./lib/openai-integrity.js";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const { dayOf, finalizedThrough, timezone, windowStart } = await import("./lib/profile.js");
const { accountOrigin } = await import("./lib/origin.js");
const ORIGIN = accountOrigin("anthropic");
const ACCOUNT = accountAlias("anthropic");
const TIMEZONE = await timezone();
const CONFIG = "config/claude-reconciliation.json";

// Subscription-billed Claude Code traffic does not appear in a Console
// organization's usage report, so API usage is normally separate spend. That is
// the likely case, not a guaranteed one: an API key routed through Claude Code
// or an SDK wrapper would show up in both places and double count. Until the
// reconciliation decision is recorded, receipts are quarantined where the
// importer cannot reach them.
const { mode } = JSON.parse(await readFile(CONFIG, "utf8"));
const quarantined = mode !== "additive";
const OUTPUT = quarantined
  ? "scratch/reconcile/claude-api.jsonl"
  : "scratch/receipts/claude-api.jsonl";
// Overridable only so a test can point this at a loopback server; production
// always reads the real endpoint.
const API = process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com/v1/organizations/usage_report/messages";
const DEFAULT_SINCE = await windowStart();

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
// Days older than the horizon are final. Re-reading them cannot discover new
// work: it only re-samples the provider's aggregation, which has disagreed
// with itself: a day's daily bucket can read lower than the hourly series
// covering the same day. An explicit --since or --backfill
// still reaches the whole history for a genuine rebuild.
const backfill = args.includes("--backfill");
const horizon = backfill ? null : await finalizedThrough();
const requestedSince = flag("--since");
if (requestedSince && !/^\d{4}-\d{2}-\d{2}$/.test(requestedSince)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
const since = requestedSince
  ?? (horizon && horizon > DEFAULT_SINCE ? horizon : DEFAULT_SINCE);
const dryRun = args.includes("--dry-run");
// Pause between pages. A full-history backfill is hundreds of requests, and
// this endpoint's limit is strict enough that reactive backoff alone loses the
// run: once tripped, every retry 429s for minutes. Pacing up front is cheaper
// than recovering. Raise --pace if the account limit is tighter.
const pace = Number(flag("--pace") ?? 1500);

// Bucket width is a cost decision. The API caps limit at 168 for hourly buckets
// and 31 for daily, so a request covers 7 days hourly versus 31 daily -- 4.4x
// fewer requests, not the 50x a 365 cap would have given. The endpoint enforces
// an hourly request QUOTA rather than a per-second rate, so pacing does not
// help; only asking less does.
//
// Daily buckets are UTC-aligned. While the profile timezone is UTC they map
// exactly onto our calendar days and are the correct default: a full history
// costs a handful of requests instead of two hundred. Under any other zone they
// would straddle day boundaries, so the script refuses to write receipts from
// them and falls back to hourly.
// Hourly is the default width, whatever the profile zone. The daily rollup is
// a separate aggregate that can under-report a day the hourly series counts in
// full, and the committed history was read hourly, so daily reads manufacture
// regressions against our own record. --daily-rollup is kept for diagnosing
// that disagreement, not for producing receipts.
const dailyOK = TIMEZONE === "UTC";
const hourly = !args.includes("--daily-rollup") || !dailyOK;
const scan = args.includes("--scan");
if (!dailyOK && args.includes("--daily-rollup")) {
  console.warn(`Profile timezone is ${TIMEZONE}, not UTC: daily buckets cannot be attributed to a calendar day, reading hourly instead.`);
}

// Three exit classes for this extractor, in order of how little they say:
//   0  not configured -- no key, so nothing was asked of the provider at all.
//   3  unreachable -- the provider could not be contacted; this run knows
//      nothing about the window, which is UNKNOWN, not a measured zero.
//   1  failed -- everything else, including an HTTP error status the
//      provider did return (an auth failure stays in this class, distinct
//      from unreachable).
const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
if (!adminKey) {
  console.log("ANTHROPIC_ADMIN_KEY not set; skipping Claude API extraction.");
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
    `Anthropic Admin Usage API unreachable at ${host} (${isAbort ? "timeout" : code}); ` +
      "provider unreachable, this run knows nothing about the requested window."
  );
  process.exit(3);
};

// Hourly buckets from the day before `since` (UTC offset safety) to now.
const startingAt = new Date(`${since}T00:00:00Z`);
startingAt.setUTCDate(startingAt.getUTCDate() - 1);

const buckets = new Map();
let page = null;
let requests = 0;
do {
  const url = new URL(API);
  url.searchParams.set("starting_at", startingAt.toISOString());
  url.searchParams.set("bucket_width", hourly ? "1h" : "1d");
  url.searchParams.set("limit", hourly ? "168" : "31");
  if (!scan) url.searchParams.append("group_by[]", "model");
  if (page) url.searchParams.set("page", page);
  // Pace before every request after the first, then retry 429 and 5xx with
  // exponential backoff so a long run degrades rather than dies.
  if (requests > 0 && pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          "x-api-key": adminKey,
          "anthropic-version": "2023-06-01"
        }
      });
    } catch (error) {
      // One attempt, classified -- no retry-with-sleep here, which would hold
      // an unattended run open against a provider that is not answering.
      exitIfUnreachable(error, url.host);
      // An unrecognized transport error is still "failed", not "unreachable";
      // only the host and error identity are logged, never the URL itself.
      console.error(`Anthropic Admin Usage API request failed at ${url.host}: ${error.cause?.code ?? error.name}`);
      process.exit(1);
    }
    requests += 1;
    if (response.ok) break;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 9) {
      console.error(`\nAdmin usage API returned ${response.status} after ${attempt} retries: ${await response.text()}`);
      console.error(`Reached page ${requests}. Extraction is idempotent -- rerun later, or raise --pace.`);
      process.exit(1);
    }
    // Cap at 60s: this limit resets on a window, so very long sleeps just idle.
    const backoff = Math.min(Number(response.headers.get("retry-after")) * 1000 || 5000 * 2 ** attempt, 60000);
    if (attempt === 0) process.stderr.write(`\n  rate limited at page ${requests}; backing off `);
    process.stderr.write(`${Math.round(backoff / 1000)}s `);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  if (requests % 20 === 0) process.stderr.write(`  …${requests} pages, ${buckets.size} days so far\n`);
  const body = await response.json();
  for (const bucket of body.data ?? []) {
    for (const result of bucket.results ?? []) {
      const date = await dayOf(bucket.starting_at);
      if (date < since) continue;
      const entry = buckets.get(date) ?? {
        date,
        tokens: 0,
        cacheRead: 0,
        models: new Set()
      };
      const cacheCreation =
        typeof result.cache_creation === "object" && result.cache_creation
          ? Object.values(result.cache_creation).reduce((sum, n) => sum + (n ?? 0), 0)
          : result.cache_creation_input_tokens ?? 0;
      entry.tokens +=
        (result.uncached_input_tokens ?? 0) + cacheCreation + (result.output_tokens ?? 0);
      entry.cacheRead += result.cache_read_input_tokens ?? 0;
      if (result.model) entry.models.add(result.model);
      buckets.set(date, entry);
    }
  }
  page = body.has_more ? body.next_page : null;
} while (page);

// Scan mode reports where usage lives and stops. No receipts: the UTC-aligned
// daily buckets it reads cannot be attributed to a non-UTC calendar day.
if (scan) {
  const active = [...buckets.values()].filter((bucket) => bucket.tokens > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!active.length) {
    console.log(`Scanned ${requests} pages from ${since}: no usage found anywhere in the window.`);
    process.exit(0);
  }
  const byMonth = new Map();
  for (const bucket of active) {
    const month = bucket.date.slice(0, 7);
    const entry = byMonth.get(month) ?? { days: 0, tokens: 0 };
    entry.days += 1;
    entry.tokens += bucket.tokens;
    byMonth.set(month, entry);
  }
  console.log(`Scanned ${requests} pages of daily buckets from ${since}.`);
  console.log(`Earliest day with usage: ${active[0].date}`);
  console.log(`Latest day with usage:   ${active.at(-1).date}`);
  console.log(`${active.length} active days, ${active.reduce((sum, b) => sum + b.tokens, 0).toLocaleString()} tokens (UTC-day approximation).`);
  console.log("");
  console.log("month     days        tokens");
  for (const [month, entry] of [...byMonth.entries()].sort()) {
    console.log(`${month}  ${String(entry.days).padStart(4)}  ${entry.tokens.toLocaleString().padStart(12)}`);
  }
  console.log("");
  console.log(`Next: node scripts/extract-claude-api.js --since ${active[0].date}`);
  console.log("(hourly buckets, configured-day aligned, writes receipts)");
  process.exit(0);
}

const receipts = [...buckets.values()]
  .filter((bucket) => bucket.tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((bucket) => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: "claude_api",
    tokens: bucket.tokens,
    fidelity: "exact",
    provider: "anthropic",
    surface: "admin_usage_report",
    account_alias: ACCOUNT,
    origin: ORIGIN,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `claude_api:${ACCOUNT}:${bucket.date}`,
    authority: "provider",
    models: [...bucket.models].sort(),
    provenance: `Anthropic Admin Usage Report; cache_read ${bucket.cacheRead} excluded`
  }));
for (const receipt of receipts) {
  const errors = validateReceiptSchema(receipt, `claude_api ${receipt.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
}

if (!receipts.length) {
  console.log(`No API usage found since ${since} (${requests} API pages); nothing written.`);
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";

if (dryRun) {
  process.stdout.write(jsonl);
  console.log(`Dry run: ${receipts.length} daily receipts from ${requests} API pages.`);
} else {
  await mkdir(OUTPUT.slice(0, OUTPUT.lastIndexOf("/")), { recursive: true });
  await writeFile(OUTPUT, jsonl);
  console.log(`Wrote ${receipts.length} daily receipts to ${OUTPUT} from ${requests} API pages.`);
  // Said plainly, because a shorter window is otherwise indistinguishable from
  // a provider that lost history.
  if (horizon && !requestedSince) {
    console.log(
      `Read from ${since}: days before it are final and were not requested. ` +
        `Use --backfill to read the whole history.`
    );
  }
  if (quarantined) {
    console.warn(
      `Reconciliation mode is "${mode}": these receipts are NOT imported. ` +
        `Run npm run reconcile:claude, then record the decision in ${CONFIG}.`
    );
  }
}
