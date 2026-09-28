// The claude.ai and ChatGPT export estimators. Every export here is synthetic
// and written to a temporary directory; no real conversation is read.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const run = (script, args, cwd) =>
  spawnSync(process.execPath, [join(repo, "scripts", script), ...args], { cwd, encoding: "utf8" });
const receiptsIn = (stdout) =>
  stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));

test("claude.ai: parts win over text, tool traffic and attachments count, and re-exports dedupe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-export-"));
  const conversations = [{
    uuid: "conv-1",
    created_at: "2026-01-02T09:00:00Z",
    chat_messages: [
      { uuid: "m1", sender: "human", created_at: "2026-01-02T09:00:00Z", text: "12345678",
        content: [{ type: "text", text: "12345678" }], attachments: [{ extracted_content: "abcd" }] },
      { uuid: "m2", sender: "assistant", created_at: "2026-01-02T09:01:00Z", text: "ignored when parts exist",
        content: [
          { type: "thinking", thinking: "1234" },
          { type: "tool_use", input: { q: "x" } },
          { type: "tool_result", content: [{ type: "text", text: "12345678" }, { type: "image" }] }
        ] }
    ]
  }];
  for (const name of ["claude-export-2026-01", "claude-export-2026-02"]) {
    await mkdir(join(cwd, "raw", name, "design_chats"), { recursive: true });
    await writeFile(join(cwd, "raw", name, "conversations.json"), JSON.stringify(conversations));
  }
  await writeFile(join(cwd, "raw", "claude-export-2026-02", "design_chats", "d.json"), JSON.stringify({
    uuid: "design-1",
    messages: [{ uuid: "dm1", role: "assistant", created_at: "2026-01-03T10:00:00Z",
      content: { contentBlocks: [{ type: "text", text: "12345678" }, { type: "tool_call", toolCall: { input: "ab", output: "abcd" } }] } }]
  }));

  const result = run("estimate-claude-chat.js", ["--dry-run"], cwd);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  const chat = receipts.find((r) => r.source === "claude_chat");
  const design = receipts.find((r) => r.source === "claude_design");
  // m1: 8 chars of parts + 4 of attachment = 12 -> 3 tokens.
  // m2: 4 thinking + 9 ('{"q":"x"}') tool input + 8 tool result = 21 -> 6 tokens.
  // The second, identical export adds nothing.
  assert.equal(chat.tokens, 3 + 6);
  assert.equal(chat.calls, 1);
  assert.equal(chat.correlation_keys.length, 2);
  // 8 text + 4 ('"ab"') tool input + 4 tool output = 16 -> 4 tokens.
  assert.equal(design.tokens, 4);
  for (const receipt of receipts) {
    assert.deepEqual(validateReceiptSchema(receipt), []);
    assert.equal(receipt.fidelity, "estimated");
    assert.equal(receipt.authority, "estimated");
    assert.equal(receipt.origin, "account/anthropic");
  }
  assert.doesNotMatch(result.stdout, /12345678|conv-1|m2/, "no content or raw ids in receipts");
});

test("claude.ai: an unreadable export is unknown and the previous receipts survive", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-export-bad-"));
  await mkdir(join(cwd, "raw", "claude-export-1"), { recursive: true });
  await writeFile(join(cwd, "raw", "claude-export-1", "conversations.json"), "{truncated");
  await mkdir(join(cwd, "scratch", "receipts"), { recursive: true });
  await writeFile(join(cwd, "scratch", "receipts", "claude-chat.jsonl"), "previous receipts\n");

  const result = run("estimate-claude-chat.js", [], cwd);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /UNKNOWN, not zero/);
  assert.equal(await readFile(join(cwd, "scratch", "receipts", "claude-chat.jsonl"), "utf8"), "previous receipts\n");

  const empty = await mkdtemp(join(tmpdir(), "claude-export-none-"));
  const none = run("estimate-claude-chat.js", [], empty);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No claude\.ai export found/);
});

const chatgptConversation = (id, day, model, messages) => ({
  id,
  create_time: Date.parse(`${day}T08:00:00Z`) / 1000,
  default_model_slug: model,
  mapping: Object.fromEntries(messages.map(([role, text], index) => [`n${index}`, {
    id: `n${index}`,
    message: { id: `${id}-m${index}`, author: { role }, create_time: Date.parse(`${day}T08:0${index}:00Z`) / 1000, content: { parts: [text] } }
  }]))
});

test("ChatGPT: user and assistant text is estimated per day, with that day's models only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chatgpt-export-"));
  const dir = join(cwd, "raw", "openai-export");
  await mkdir(join(dir, "shards"), { recursive: true });
  await writeFile(join(dir, "shards", "a.json"), JSON.stringify([
    chatgptConversation("c1", "2026-01-02", "gpt-a", [["user", "12345678"], ["assistant", "1234"], ["system", "not counted"]])
  ]));
  await writeFile(join(dir, "shards", "b.json"), JSON.stringify([
    chatgptConversation("c2", "2026-01-03", "gpt-b", [["user", "1234"], ["assistant", { image: true }]])
  ]));
  await writeFile(join(dir, "export_manifest.json"), JSON.stringify({
    logical_files: { "conversations.json": { files: ["shards/a.json", "shards/b.json"] } }
  }));

  const result = run("estimate-chatgpt.js", ["--dry-run", "--since", "2026-01-01"], cwd);
  assert.equal(result.status, 0, result.stderr);
  const receipts = receiptsIn(result.stdout);
  assert.deepEqual(receipts.map((r) => [r.date, r.tokens, r.calls, r.models]), [
    ["2026-01-02", 2 + 1, 1, ["gpt-a"]],
    ["2026-01-03", 1, 0, ["gpt-b"]]
  ]);
  for (const receipt of receipts) {
    assert.deepEqual(validateReceiptSchema(receipt), []);
    assert.equal(receipt.origin, "account/openai");
  }
  assert.match(receipts[1].provenance, /1 non-text parts excluded/);
});

test("ChatGPT: a manifest that points outside its export is refused as unknown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chatgpt-escape-"));
  const dir = join(cwd, "raw", "chatgpt-export");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "export_manifest.json"), JSON.stringify({
    logical_files: { "conversations.json": { files: ["../../outside.json"] } }
  }));
  const result = run("estimate-chatgpt.js", ["--since", "2026-01-01"], cwd);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /escapes the export directory/);
  assert.match(result.stderr, /UNKNOWN, not zero/);
  assert.equal(run("estimate-chatgpt.js", ["--since", "yesterday"], cwd).status, 64);
});
