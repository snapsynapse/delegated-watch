// Estimate per-day claude.ai token usage from account data exports into receipt
// JSONL under scratch/receipts/. Read-only against the export.
//
// Two surfaces ride the same export and are kept apart because they are
// different products:
// - claude_chat  : `conversations.json`, the claude.ai chat surface. Chrome
//                  extension conversations ride the same account and land here.
// - claude_design: `design_chats/*.json`, the design-component surface. Its
//                  conversations carry their own uuid space and never appear in
//                  `conversations.json`.
//
// Neither surface reports token counts, so both are estimated. Claude desktop
// agent sessions and Claude Code sessions do NOT appear in this export: they
// live in local session stores with their own id space and are extracted
// exactly by scripts/extract-claude-code.js, so the two never overlap.
//
// Method (recorded in provenance):
// - tokens ~= ceil(chars / 4), summed per message over everything that entered
//   or left the model: visible text, thinking, tool call inputs, tool results,
//   and extracted attachment text. Tool traffic can far outweigh visible text
//   in an agentic account, so counting text alone would understate it badly.
// - `text` and the `content` parts hold the same visible prose in two shapes, so
//   the parts win when present and `text` is the fallback. Never both.
// - Non-textual parts (images, rag_reference and local_resource pointers) carry
//   no characters to count and are excluded, not zeroed.
// - Context re-send is NOT modelled. Every turn resends the conversation, so
//   real billed input exceeds this figure; design chats carry a cumulative
//   `turnInputTokens` that shows it directly. It is deliberately not summed:
//   most of that volume is cache reads, which every other source here excludes.
//   This estimate is a floor.
// - Messages grouped by the configured day (config/profile.json) of created_at.
// - Dedupe by conversation uuid + message uuid, so overlapping cumulative
//   exports (e.g. monthly re-exports) are safe to process together.
//
// Usage:
//   node scripts/estimate-claude-chat.js [--dry-run] [file.json ...]
//   (no file args: reads every raw/claude-export-*/conversations.json and
//    raw/claude-export-*/design_chats/*.json)
//   File arguments are routed by shape, so either kind can be passed directly.
//
// Output: scratch/receipts/claude-chat.jsonl, overwritten each run. Receipts
// are schema v2, account-scoped, with estimated authority. An export that
// cannot be read or has an unexpected shape leaves the previous file
// untouched and exits 3, because the usage it holds is unknown, not zero.

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountAlias } from "./lib/openai-integrity.js";
import { hashCorrelationKey, RECEIPT_SCHEMA_VERSION, validateReceiptSchema } from "./lib/receipt-schema.js";

const { dayOf, timezone } = await import("./lib/profile.js");
const { accountOrigin } = await import("./lib/origin.js");
const ORIGIN = accountOrigin("anthropic");
const ACCOUNT = accountAlias("anthropic");
const SURFACES = { claude_chat: "claude_ai_export", claude_design: "claude_design_export" };
const TIMEZONE = await timezone();
const OUTPUT = "scratch/receipts/claude-chat.jsonl";
const RAW_DIR = "raw";

const CHARS_PER_TOKEN = 4;
const PROVENANCE = {
  claude_chat:
    "claude.ai export conversations.json: chars/4 over message text, thinking, " +
    "tool_use input, tool_result text and attachment text; images excluded; " +
    "context re-send not modelled, so this is a floor; no exact counts exist for consumer chat",
  claude_design:
    "claude.ai export design_chats: chars/4 over message text, thinking, and " +
    "tool_call input and output; cumulative turnInputTokens not summed because it " +
    "counts re-sent cached context; no exact counts exist for this surface"
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
let files = args.filter((arg) => !arg.startsWith("--"));

// ENOENT means the directory is absent, which is evidence. Anything else means
// the contents are unknown and must surface rather than read as empty.
const listDir = async (dir) => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

if (!files.length) {
  // Exports run to ~100MB, so raw/claude-export-* is often a symlink to wherever
  // the download was unpacked rather than a copy. readdir reports the link, not
  // its target, so a symlink has to count as a candidate directory.
  const exports = (await listDir(RAW_DIR))
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        entry.name.startsWith("claude-export")
    )
    .map((entry) => join(RAW_DIR, entry.name))
    .sort();
  for (const dir of exports) {
    files.push(join(dir, "conversations.json"));
    const designs = (await listDir(join(dir, "design_chats")))
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".json"))
      .map((entry) => join(dir, "design_chats", entry.name))
      .sort();
    files.push(...designs);
  }
}
if (!files.length) {
  console.log(
    "No claude.ai export found. Request one at claude.ai -> Settings -> Privacy -> " +
      "Export data, unzip into raw/claude-export-<date>/, then rerun."
  );
  process.exit(0);
}

const len = (value) => (typeof value === "string" ? value.length : 0);
const jsonLen = (value) =>
  value === undefined || value === null ? 0 : JSON.stringify(value).length;

// One `content` part of a conversations.json message. Every branch is something
// that occupied context; anything without characters returns 0 rather than being
// silently treated as absent.
const partChars = (part) => {
  switch (part?.type) {
    case "text":
      return len(part.text);
    case "thinking":
      return len(part.thinking);
    case "tool_use":
      return jsonLen(part.input);
    case "tool_result": {
      // `content` is an array of typed results; text and knowledge carry prose,
      // the image and pointer types do not.
      const inner = (part.content ?? []).reduce((sum, item) => sum + len(item?.text), 0);
      return inner + jsonLen(part.structured_content);
    }
    default:
      return 0;
  }
};

const chatMessageChars = (message) => {
  const parts = message.content ?? [];
  // `text` is the flattened form of the text parts, so counting both double
  // counts the visible prose.
  let chars = parts.length
    ? parts.reduce((sum, part) => sum + partChars(part), 0)
    : len(message.text);
  for (const attachment of message.attachments ?? []) {
    chars += len(attachment?.extracted_content);
  }
  return chars;
};

// A design-chat message: `contentBlocks` when the turn had structure, otherwise
// the flattened `content` string.
const designMessageChars = (message) => {
  const body = message.content ?? {};
  const blocks = body.contentBlocks ?? [];
  let chars = 0;
  if (blocks.length) {
    for (const block of blocks) {
      switch (block?.type) {
        case "text":
        case "thinking":
          chars += len(block.text);
          break;
        case "user_interjection":
          chars += len(block.message);
          break;
        case "tool_call":
          chars += jsonLen(block.toolCall?.input) + len(block.toolCall?.output);
          break;
        default:
          break;
      }
    }
  } else {
    chars += len(body.content);
  }
  for (const attachment of body.attachments ?? []) {
    chars += len(attachment?.content);
  }
  return chars;
};

const buckets = new Map();
const seen = new Set();
let conversations = 0;
let designChats = 0;
let skippedFiles = 0;

const record = async (source, timestamp, chars, isAssistant, identity) => {
  if (!timestamp || !chars) return;
  const date = await dayOf(timestamp);
  const key = `${date} ${source}`;
  const bucket = buckets.get(key) ?? { date, source, tokens: 0, calls: 0, correlationKeys: [] };
  bucket.tokens += Math.ceil(chars / CHARS_PER_TOKEN);
  if (isAssistant) bucket.calls += 1;
  // The conversation+message uuid pair is this surface's message identity, and
  // is already what dedupes overlapping cumulative exports. Hashing it into the
  // receipt keeps that identity after the export itself is deleted -- the
  // export is the only evidence this source has.
  if (identity) bucket.correlationKeys.push(hashCorrelationKey(identity));
  buckets.set(key, bucket);
};

for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    skippedFiles += 1;
    continue;
  }

  if (Array.isArray(parsed)) {
    for (const conversation of parsed) {
      conversations += 1;
      for (const message of conversation.chat_messages ?? []) {
        const id = `chat ${conversation.uuid} ${message.uuid}`;
        if (seen.has(id)) continue;
        seen.add(id);
        await record(
          "claude_chat",
          message.created_at ?? conversation.created_at,
          chatMessageChars(message),
          message.sender === "assistant",
          id
        );
      }
    }
    continue;
  }

  if (Array.isArray(parsed?.messages)) {
    designChats += 1;
    for (const message of parsed.messages) {
      const id = `design ${parsed.uuid} ${message.uuid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      await record(
        "claude_design",
        message.created_at ?? parsed.created_at,
        designMessageChars(message),
        (message.role ?? message.content?.role) === "assistant",
        id
      );
    }
    continue;
  }

  skippedFiles += 1;
}

if (skippedFiles) {
  console.error(
    `Could not read or validate ${skippedFiles} required Claude export input(s); existing receipt preserved. ` +
      "Usage in them is UNKNOWN, not zero."
  );
  process.exit(3);
}

const receipts = [...buckets.values()]
  .filter((bucket) => bucket.tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source))
  .map((bucket) => ({
    schema_version: RECEIPT_SCHEMA_VERSION,
    date: bucket.date,
    timezone: TIMEZONE,
    source: bucket.source,
    tokens: bucket.tokens,
    calls: bucket.calls,
    fidelity: "estimated",
    provider: "anthropic",
    surface: SURFACES[bucket.source],
    account_alias: ACCOUNT,
    origin: ORIGIN,
    interval: { start: bucket.date, end: bucket.date },
    snapshot_key: `${bucket.source}:${ACCOUNT}:${bucket.date}`,
    authority: "estimated",
    correlation_keys: [...new Set(bucket.correlationKeys)].sort(),
    provenance: PROVENANCE[bucket.source]
  }));
for (const receipt of receipts) {
  const errors = validateReceiptSchema(receipt, `${receipt.source} ${receipt.date}`);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
}

if (!receipts.length) {
  console.log(
    `No messages found across ${conversations} conversations and ${designChats} design chats; nothing written.`
  );
  process.exit(0);
}

const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
const summary =
  `${receipts.length} daily receipts from ${conversations} conversations ` +
  `and ${designChats} design chats.`;

if (dryRun) {
  process.stdout.write(jsonl);
  console.log(`Dry run: ${summary}`);
} else {
  await mkdir("scratch/receipts", { recursive: true });
  await writeFile(OUTPUT, jsonl);
  console.log(`Wrote ${summary} -> ${OUTPUT}`);
}
