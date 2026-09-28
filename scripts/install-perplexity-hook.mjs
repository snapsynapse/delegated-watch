#!/usr/bin/env node
// Register, or re-register, the Perplexity capture hook in Claude Code settings.
//
// Perplexity publishes no usage endpoint, so the usage object in each response
// is the only token count that will ever exist for a call. This installs the
// PostToolUse hook that captures it from Bash tool results. It is idempotent:
// re-running repoints an existing entry rather than adding a second, so it is
// safe after moving or re-cloning the repository.
//
// The settings file is the user's own configuration, so it is edited with care:
// - an existing file is backed up first, privately, never over an earlier backup
// - a file that is not valid JSON, or cannot be read, is refused, never replaced
// - every other key and hook is preserved in place, as is the file's mode
// - the new content is written to a temporary file, verified, then renamed
// - when the entry is already current, nothing is written at all
//
// Each machine needs its own run. Receipts carry that machine's origin, so
// copies brought home into receipts/ sum rather than collide.
//
// Usage:
//   node scripts/install-perplexity-hook.mjs [--settings PATH] [--check]
//
// --settings defaults to settings.json in $CLAUDE_CONFIG_DIR, or ~/.claude.
// --check reports what is registered and whether its target exists; it writes
// nothing.

import { copyFile, constants, mkdir, open, readFile, rename, stat, unlink, writeFile, chmod, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO, "scripts", "perplexity-capture-hook.sh");
const MARKER = "perplexity-capture-hook";

const args = process.argv.slice(2);
const settingsIndex = args.indexOf("--settings");
if (settingsIndex !== -1 && !args[settingsIndex + 1]) {
  console.error("--settings requires a path.");
  process.exit(64);
}
for (const [index, arg] of args.entries()) {
  if (arg === "--check" || arg === "--settings" || args[index - 1] === "--settings") continue;
  console.error(`Unknown argument: ${arg}`);
  process.exit(64);
}
const check = args.includes("--check");
const settings = settingsIndex === -1
  ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")
  : resolve(args[settingsIndex + 1]);

// The command is run by a shell, so the path is quoted for one: spaces,
// apostrophes, ampersands, and non-ASCII characters stay literal.
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const command = shellQuote(HOOK);
const unquote = (value) => {
  const match = /^'((?:[^']|'\\'')*)'$/.exec(value);
  return match ? match[1].replace(/'\\''/g, "'") : value;
};

try {
  await access(HOOK, constants.X_OK);
} catch {
  console.error(`Missing or non-executable hook: ${HOOK}`);
  console.error("Restore it from the repository, or make it executable, then run this again.");
  process.exit(1);
}

let original = null;
let data = {};
try {
  original = await readFile(settings, "utf8");
} catch (error) {
  // Absent is a fresh install. Anything else is unknown and must not be
  // silently replaced with a new file.
  if (error.code !== "ENOENT") {
    console.error(`Settings file exists but could not be read (${error.code}): ${settings}`);
    process.exit(1);
  }
}
if (original !== null) {
  try {
    data = JSON.parse(original);
  } catch (error) {
    console.error(`Settings file is not valid JSON (${error.message}); refusing to rewrite it.`);
    process.exit(1);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.error("Settings file is not a JSON object; refusing to rewrite it.");
    process.exit(1);
  }
}

const entries = (data.hooks?.PostToolUse ?? []).flatMap((entry) => entry?.hooks ?? []);
const existing = entries.filter((inner) => typeof inner?.command === "string" && inner.command.includes(MARKER));

if (check) {
  if (!existing.length) {
    console.log(`NOT INSTALLED: no ${MARKER} entry in ${settings}.`);
    process.exit(1);
  }
  for (const inner of existing) {
    let state = "ok";
    try {
      await access(unquote(inner.command));
    } catch {
      state = "MISSING TARGET";
    }
    console.log(`installed: ${inner.command} [${state}]`);
  }
  process.exit(0);
}

let action;
if (existing.length) {
  const stale = existing.filter((inner) => inner.command !== command);
  if (!stale.length) {
    console.log(`Already registered and current: ${command}`);
    process.exit(0);
  }
  for (const inner of stale) inner.command = command;
  action = "Repointed";
} else {
  data.hooks ??= {};
  data.hooks.PostToolUse ??= [];
  data.hooks.PostToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 15 }] });
  action = "Registered";
}

await mkdir(dirname(settings), { recursive: true });
let mode = 0o600;
if (original !== null) {
  mode = (await stat(settings)).mode & 0o777;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const backup = `${settings}.bak-${stamp}`;
  // Private from creation, and never over an earlier backup.
  const handle = await open(backup, "wx", 0o600);
  await handle.close();
  await copyFile(settings, backup);
  await chmod(backup, 0o600);
  console.log(`Backed up to ${backup}`);
}

const content = `${JSON.stringify(data, null, 2)}\n`;
const temp = join(dirname(settings), `.settings.json.${process.pid}.${Date.now()}.tmp`);
try {
  await writeFile(temp, content, { flag: "wx", mode });
  await chmod(temp, mode);
  if (!isDeepStrictEqual(JSON.parse(await readFile(temp, "utf8")), data)) {
    throw new Error("temporary settings validation changed the document");
  }
  await rename(temp, settings);
} catch (error) {
  await unlink(temp).catch(() => {});
  console.error(`Could not write ${settings}: ${error.message}`);
  process.exit(1);
}

console.log(`${action} hook: ${command}`);
console.log("");
console.log("Hooks load when a Claude Code session starts, so restart it before this takes effect.");
console.log("Verify afterwards with: node scripts/install-perplexity-hook.mjs --check");
console.log("");
console.log("The hook reads what a Bash command printed. A command that prints only the answer");
console.log("text discards the usage object before the hook sees it, and nothing is captured.");
console.log("Print the raw response, or at least its id, model, created, and usage fields.");
