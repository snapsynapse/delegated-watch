// Estimate per-day ChatGPT consumer usage from OpenAI account exports.
//
// Reads conversations.json, manifest-declared sharded exports, or export ZIPs
// without extracting raw conversation text to the repo. The export has message
// content but no authoritative token counters, so this records a conservative
// content-volume estimate: ceil(text characters / 4) over user and assistant
// messages.
//
// Usage:
//   node scripts/estimate-chatgpt.js [--since YYYY-MM-DD] [--dry-run]
//     [conversations.json | export_manifest.json | export.zip ...]
//   (no paths: scans raw/ recursively for account export manifests,
//    conversations.json, sharded conversations-NNN.json, and ZIP files whose
//    names contain chatgpt or openai)
//
// ZIP exports are read through the unzip program, which macOS and most Linux
// systems include. Where it is missing, as on Windows, extract the ZIP and pass
// its conversations.json or export_manifest.json instead.
//
// Output: scratch/receipts/chatgpt.jsonl, overwritten each run. Receipts are
// schema v2, account-scoped, with estimated authority. An export that cannot
// be read or has an unexpected shape leaves the previous file untouched and
// exits 3, because the usage it holds is unknown, not zero.

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  accountAlias,
  atomicWriteText
} from "./lib/openai-integrity.js";
import { RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const { dayOf, timezone, windowStart } = await import("./lib/profile.js");
const { accountOrigin } = await import("./lib/origin.js");
const ORIGIN = accountOrigin("openai");
const TIMEZONE = await timezone();
const OUTPUT = "scratch/receipts/chatgpt.jsonl";
const DEFAULT_SINCE = await windowStart();

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const valueFlags = new Set(["--since"]);
const files = [];
for (let index = 0; index < args.length; index += 1) {
  if (valueFlags.has(args[index])) {
    index += 1;
  } else if (!args[index].startsWith("--")) {
    files.push(args[index]);
  }
}
const since = flag("--since") ?? DEFAULT_SINCE;
const dryRun = args.includes("--dry-run");
const receiptAccount = accountAlias("openai");

if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since must use YYYY-MM-DD.");
  process.exit(64);
}

const discover = async (dir) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const manifest = entries.find(
    (entry) => entry.isFile() && entry.name === "export_manifest.json"
  );
  if (manifest) files.push(join(dir, manifest.name));

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await discover(path);
    else if (
      entry.isFile() &&
      !manifest &&
      (entry.name === "conversations.json" ||
        /^conversations-\d+\.json$/.test(entry.name) ||
        (entry.name.toLowerCase().endsWith(".zip") &&
          /chatgpt|openai/i.test(entry.name)))
    ) {
      files.push(path);
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".zip") &&
      /chatgpt|openai/i.test(entry.name)
    ) {
      files.push(path);
    }
  }
};

if (!files.length) await discover("raw");
const uniqueFiles = [...new Set(files)].sort();

if (!uniqueFiles.length) {
  console.log(
    "No ChatGPT export found. Place the OpenAI export ZIP, export_manifest.json, or conversation JSON under raw/, then rerun."
  );
  process.exit(0);
}

const configuredDay = async (timestamp) => {
  const date =
    typeof timestamp === "number"
      ? new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000)
      : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return dayOf(date.toISOString());
};

const textFromPart = (part) => {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
};

const messageText = (message) => {
  const content = message?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content.parts)) return content.parts.map(textFromPart).join("");
  return "";
};

const safeManifestPath = (manifestFile, declaredPath) => {
  if (typeof declaredPath !== "string" || !declaredPath || isAbsolute(declaredPath)) {
    throw new Error("manifest conversation shard path must be a relative path");
  }
  const root = resolve(dirname(manifestFile));
  const candidate = resolve(root, declaredPath);
  if (relative(root, candidate).startsWith("..")) {
    throw new Error("manifest conversation shard path escapes the export directory");
  }
  return candidate;
};

const readManifestExport = async (file) => {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  const declared = manifest?.logical_files?.["conversations.json"]?.files;
  if (!Array.isArray(declared) || !declared.length) {
    throw new Error("manifest has no logical conversations.json files");
  }
  return Promise.all(
    declared.map((declaredPath) =>
      readFile(safeManifestPath(file, declaredPath), "utf8")
    )
  );
};

const readExport = async (file) => {
  if (basename(file) === "export_manifest.json") {
    return readManifestExport(file);
  }
  if (extname(file).toLowerCase() !== ".zip") {
    return [await readFile(file, "utf8")];
  }
  let names;
  try {
    names = execFileSync("unzip", ["-Z1", file], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    })
      .split("\n")
      .filter((name) =>
        /(^|\/)conversations(?:-\d+)?\.json$/.test(name)
      )
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("the unzip program is not installed; extract the ZIP and pass its conversations.json instead");
    }
    throw new Error(`could not list ZIP (${error.status ?? "unzip error"})`);
  }
  if (!names.length) {
    throw new Error("expected conversation JSON in ZIP, found none");
  }
  try {
    return names.map((name) =>
      execFileSync("unzip", ["-p", file, name], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024
      })
    );
  } catch (error) {
    throw new Error(`could not read conversation JSON (${error.status ?? "unzip error"})`);
  }
};

const buckets = new Map();
const seen = new Set();
const models = new Set();
let conversationCount = 0;
let messageCount = 0;
let nonTextParts = 0;
let skippedFiles = 0;
const skipReasons = new Set();

for (const file of uniqueFiles) {
  let exports;
  try {
    exports = (await readExport(file)).map((payload) => JSON.parse(payload));
  } catch (error) {
    skippedFiles += 1;
    skipReasons.add(error instanceof SyntaxError ? "invalid JSON" : error.message);
    continue;
  }
  for (const parsed of exports) {
    if (!Array.isArray(parsed)) {
      skippedFiles += 1;
      skipReasons.add("conversation JSON is not an array");
      continue;
    }
    for (const conversation of parsed) {
      conversationCount += 1;
      const nodes = Object.values(conversation.mapping ?? {});
      for (const node of nodes) {
        const message = node?.message;
        if (!message) continue;
        const role = message.author?.role;
        if (role !== "user" && role !== "assistant") continue;
        const conversationId = conversation.id ?? conversation.conversation_id ?? "unknown";
        const messageId = message.id ?? node.id;
        const dedupeKey = `${conversationId}:${messageId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const date = await configuredDay(message.create_time ?? conversation.create_time);
        if (!date || date < since) continue;
        const text = messageText(message);
        const parts = message.content?.parts;
        if (Array.isArray(parts)) {
          nonTextParts += parts.filter((part) => part && typeof part === "object" && !textFromPart(part)).length;
        }
        if (!text) continue;

        const bucket = buckets.get(date) ?? { date, tokens: 0, calls: 0, messages: 0, models: new Set() };
        bucket.tokens += Math.ceil(text.length / 4);
        bucket.messages += 1;
        if (role === "assistant") bucket.calls += 1;
        buckets.set(date, bucket);
        messageCount += 1;

        const model =
          message.metadata?.model_slug ??
          message.metadata?.default_model_slug ??
          conversation.default_model_slug;
        if (model) {
          models.add(model);
          bucket.models.add(model);
        }
      }
    }
  }
}

if (skippedFiles) {
  console.error(
    `Could not read or validate ${skippedFiles} required ChatGPT export input(s) (${[...skipReasons].join("; ")}); ` +
      "existing receipt preserved. Usage in them is UNKNOWN, not zero."
  );
  process.exit(3);
}

const modelNote = models.size ? `; ${models.size} models observed` : "";
const mediaNote = nonTextParts ? `; ${nonTextParts} non-text parts excluded` : "";
const receipts = [...buckets.values()]
  .filter((bucket) => bucket.tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((bucket) => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: "chatgpt",
    provider: "openai",
    surface: "chatgpt_consumer",
    account_alias: receiptAccount,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `chatgpt:${receiptAccount}:${bucket.date}`,
    authority: "estimated",
    models: [...bucket.models].sort(),
    tokens: bucket.tokens,
    calls: bucket.calls,
    fidelity: "estimated",
    origin: ORIGIN,
    provenance:
      `OpenAI account export: chars/4 over user+assistant text; conservative content-volume estimate, not provider token accounting${modelNote}${mediaNote}`
  }));

for (const receipt of receipts) {
  const errors = validateReceiptSchema(receipt, `chatgpt ${receipt.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
}

if (!receipts.length) {
  console.log(`No ChatGPT messages found since ${since}; nothing written.`);
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
if (dryRun) {
  process.stdout.write(jsonl);
  console.log(
    `Dry run: ${receipts.length} daily receipts from ${conversationCount} conversations and ${messageCount} messages.`
  );
} else {
  await atomicWriteText(OUTPUT, jsonl);
  console.log(
    `Wrote ${receipts.length} daily receipts to ${OUTPUT} from ${conversationCount} conversations and ${messageCount} messages.`
  );
}
