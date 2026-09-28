// Extract exact per-day token usage from goose's local session database into
// receipt JSONL under scratch/receipts/. Read-only against the database.
//
// goose records every model call in the usage_ledger table of sessions.db.
// The database is found, in order, at:
// - --db PATH, when given
// - $GOOSE_PATH_ROOT/data/sessions/sessions.db, when that is set
// - %APPDATA%\Block\goose\data\sessions\sessions.db on Windows
// - ${XDG_DATA_HOME:-~/.local/share}/goose/sessions/sessions.db elsewhere
// The last is verified on macOS. GOOSE_PATH_ROOT and the Windows location come
// from goose's documentation and have not been checked here.
//
// The database is opened read-only through Node's built-in SQLite, so no
// external program is needed. A read-only connection still reads committed WAL
// frames, so usage goose has written but not checkpointed is included.
//
// Token definition: input + output per call. Cache reads are kept out of the
// headline, per invariant 5. A ledger row with cache reads is ambiguous,
// because whether goose's input count already includes them depends on the
// provider, so such rows need --cache-convention: "inclusive" when input
// includes cache reads (they are subtracted), "exclusive" when it does not
// (input is used as recorded). Without it they are reported as undecided and
// the run exits 3. The ledger's cost column is never read.
//
// Local models map to their family's source id (qwen_local, gemma_local, ...)
// through scripts/lib/local-model-source.js. Calls goose routed to a hosted
// provider become goose_<provider>, so they are never mistaken for local
// inference. Those calls may also appear in that provider's own usage API.
//
// Usage:
//   node scripts/extract-goose.js [--db PATH] [--since YYYY-MM-DD]
//     [--cache-convention inclusive|exclusive] [--tag ORIGIN] [--dry-run]
//
// Output: scratch/receipts/goose-<origin>.jsonl, overwritten on each run. A
// database that cannot be read leaves the previous file untouched.
//
// Exit status: 0 read or not found; 3 unreadable, an unsupported schema, or
// undecided cache rows, all of which are unknown rather than zero; 64 usage;
// 66 an explicit --db that does not exist.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { accountAlias, atomicWriteText, machineAlias } from "./lib/openai-integrity.js";
import { LOCAL_PROVIDERS, localModelSource } from "./lib/local-model-source.js";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";
import { dayOf, timezone } from "./lib/profile.js";
import { localOrigin } from "./lib/origin.js";

const EXIT_UNKNOWN = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const explicitDb = flag("--db");
const since = flag("--since");
const cacheConvention = flag("--cache-convention");
const dryRun = args.includes("--dry-run");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must be YYYY-MM-DD.");
  process.exit(64);
}
if (cacheConvention && !["inclusive", "exclusive"].includes(cacheConvention)) {
  console.error("--cache-convention must be inclusive or exclusive.");
  process.exit(64);
}

const defaultDb = () => {
  if (process.env.GOOSE_PATH_ROOT) return join(process.env.GOOSE_PATH_ROOT, "data", "sessions", "sessions.db");
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Block", "goose", "data", "sessions", "sessions.db");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "goose", "sessions", "sessions.db");
};
const dbPath = explicitDb ?? defaultDb();

const ORIGIN = await localOrigin(flag("--tag"));
const TIMEZONE = await timezone();
const OUTPUT = `scratch/receipts/goose-${ORIGIN.replace(/\//g, "_")}.jsonl`;
const log = dryRun ? console.error : console.log;

const unknown = (reason) => {
  log(`  goose ${dbPath}: ${reason}`);
  log(`goose: not written; ${OUTPUT} is unchanged.`);
  console.error("");
  console.error("WARNING: goose usage could not be established. It is UNKNOWN, not zero.");
  process.exit(EXIT_UNKNOWN);
};

log("Stores:");
try {
  await access(dbPath);
} catch (error) {
  if (error.code === "ENOENT") {
    if (explicitDb) {
      console.error(`No goose database at ${explicitDb}.`);
      process.exit(66);
    }
    log(`  goose ${dbPath}: not found`);
    log("goose: nothing written.");
    process.exit(0);
  }
  unknown(`UNREADABLE (${error.code})`);
}

let rows;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasLedger = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'")
      .get();
    if (!hasLedger) {
      db.close();
      unknown("found, but it has no usage_ledger table. This goose version records usage elsewhere, which is not yet supported");
    }
    const columns = new Set(db.prepare("PRAGMA table_info(usage_ledger)").all().map((column) => column.name));
    const cacheRead = columns.has("cache_read_tokens") ? "ul.cache_read_tokens" : "NULL";
    rows = db.prepare(`
      SELECT ul.created_timestamp AS ts,
             ul.model AS model,
             ul.input_tokens AS input,
             ul.output_tokens AS output,
             ul.total_tokens AS total,
             ${cacheRead} AS cache_read,
             s.provider_name AS provider
      FROM usage_ledger ul
      LEFT JOIN sessions s ON s.id = ul.session_id
      WHERE ul.model IS NOT NULL
      ORDER BY ul.created_timestamp
    `).all();
  } finally {
    try {
      db.close();
    } catch {
      // Already closed on the unsupported-schema path.
    }
  }
} catch (error) {
  unknown(`UNREADABLE (${error.code ?? error.message})`);
}

const sanitize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const sourceFor = (model, provider) =>
  !provider || LOCAL_PROVIDERS.has(String(provider).toLowerCase())
    ? localModelSource(model, provider || "ollama")
    : `goose_${sanitize(provider)}`;

const buckets = new Map();
let undecided = 0;
for (const row of rows) {
  const cacheReadTokens = Number(row.cache_read ?? 0);
  let tokens;
  if (row.input === null && row.output === null) {
    if (cacheReadTokens > 0 || row.total === null) {
      undecided += 1;
      continue;
    }
    tokens = Number(row.total);
  } else {
    let input = Number(row.input ?? 0);
    if (cacheReadTokens > 0) {
      if (!cacheConvention) {
        undecided += 1;
        continue;
      }
      if (cacheConvention === "inclusive") input = Math.max(0, input - cacheReadTokens);
    }
    tokens = input + Number(row.output ?? 0);
  }
  const date = await dayOf(new Date(Number(row.ts) * 1000).toISOString());
  if (since && date < since) continue;
  const provider = row.provider ? sanitize(row.provider) : "unknown";
  const source = sourceFor(row.model, row.provider);
  const key = `${date} ${source}`;
  const bucket = buckets.get(key) ?? { date, source, provider, tokens: 0, calls: 0, cacheRead: 0, models: new Set() };
  bucket.tokens += tokens;
  bucket.cacheRead += cacheReadTokens;
  bucket.calls += 1;
  bucket.models.add(row.model);
  buckets.set(key, bucket);
}

const receipts = [];
for (const bucket of [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source))) {
  if (bucket.tokens <= 0) continue;
  const receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: bucket.source,
    tokens: bucket.tokens,
    calls: bucket.calls,
    fidelity: "exact",
    provider: bucket.provider,
    surface: "goose_usage_ledger",
    account_alias: accountAlias(bucket.provider),
    machine_alias: machineAlias(),
    origin: ORIGIN,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `goose:${ORIGIN}:${bucket.source}:${bucket.date}`,
    authority: "tool",
    models: [...bucket.models].sort(),
    provenance:
      `goose usage_ledger` +
      (bucket.cacheRead ? `; cache_read ${bucket.cacheRead} excluded (${cacheConvention} convention)` : "")
  };
  const errors = validateReceiptSchema(receipt, `goose ${bucket.date} ${bucket.source}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  receipts.push(receipt);
}

if (undecided) {
  unknown(
    `read, but ${undecided} ledger row(s) carry cache reads and no --cache-convention was given. ` +
      "Pass --cache-convention inclusive if goose's input counts include cache reads for your provider, or exclusive if they do not"
  );
}
log(`  goose ${dbPath}: read, ${rows.length} ledger row(s)`);
if (!receipts.length) {
  log("goose: no usage found; nothing written.");
  process.exit(0);
}
const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) {
  process.stdout.write(jsonl);
  log(`goose: ${receipts.length} daily receipt(s) (dry run).`);
} else {
  await atomicWriteText(OUTPUT, jsonl);
  log(`goose: wrote ${receipts.length} daily receipt(s) to ${OUTPUT}.`);
}
