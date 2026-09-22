// Static checks for the one bug class this project cannot tolerate: code that
// turns "I could not read it" into "there was nothing there".
//
// Both instances found on 2026-07-26 were invisible to the dataset evals,
// because the data they produced was internally consistent -- just incomplete.
// A day missing from the file because a directory was unreadable validates
// exactly like a day that genuinely had no usage. The only place to catch that
// is where the read happens.
//
// Usage:
//   node scripts/eval-code-honesty.js [--strict]
//
// Suppress a deliberate case with a trailing comment on the catch line:
//   } catch { // honesty-ok: <reason>

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SCRIPT_DIR = "scripts";
const strict = process.argv.includes("--strict");
const findings = [];
const note = (file, line, rule, detail) => findings.push({ file, line, rule, detail });

// Every JavaScript module under scripts/, whatever extension it carries. The
// capture wrappers are .mjs and read provider counters, which is exactly the
// work these rules exist to guard; scanning only .js exempted them silently.
// `--list` prints the scanned set so a test can assert it never narrows again.
const SCANNED_EXTENSIONS = [".js", ".mjs", ".cjs"];
const isScannable = (name) => SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext));

async function* jsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (isScannable(entry.name)) yield path;
  }
}

const files = [];
for await (const file of jsFiles(SCRIPT_DIR)) files.push(file);
files.sort();

if (process.argv.includes("--list")) {
  for (const file of files) console.log(file);
  process.exit(0);
}

for (const file of files) {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/honesty-ok/.test(line)) return;

    // A catch whose entire body is return/continue discards the reason the read
    // failed. Absence and inaccessibility become the same outcome.
    if (/}\s*catch\s*(\([^)]*\))?\s*{\s*$/.test(line)) {
      const body = [];
      for (let i = index + 1; i < lines.length && body.length < 4; i += 1) {
        const next = lines[i].trim();
        if (next === "}") break;
        if (next && !next.startsWith("//")) body.push(next);
      }
      const silent = body.length === 1 && /^(return|continue|break)\b[^=]*;?$/.test(body[0]);
      if (silent) {
        note(file, lineNo, "silent-catch",
          `catch body is only "${body[0]}" — the failure reason is discarded`);
      }
    }

    // Inline single-line form of the same thing.
    if (/catch\s*(\([^)]*\))?\s*{\s*(return|continue)[^}]*}/.test(line)) {
      note(file, lineNo, "silent-catch", "inline catch discards the failure reason");
    }
  });

  // An extractor reads someone else's store, so it must distinguish a missing
  // store from an unreadable one -- either by inspecting error.code or by
  // failing loudly. Estimators read files handed to them explicitly, so a
  // missing path is a user error and this does not apply.
  const isExtractor = /\/extract-[^/]+\.(js|mjs|cjs)$/.test(file);
  if (isExtractor) {
    const inspectsCode = /error\.code|err\.code|\.code === "E/.test(source);
    const failsLoudly = /process\.exit\(1\)/.test(source);
    if (!inspectsCode && !failsLoudly) {
      note(file, 0, "unreadable-store",
        "reads a store but neither inspects error.code nor exits on failure");
    }
  }

  // Dropping an unparseable line is fine; dropping it uncounted is data loss
  // that looks like absence.
  if (
    /JSON\.parse\(line\)/.test(source) &&
    !/parseFailures|parseErrors|malformed|honesty-jsonl-ok/.test(source)
  ) {
    note(file, 0, "uncounted-parse-failure",
      "parses JSONL lines but never counts failures");
  }

  const personalConstant = source.match(
    /["'`]America\/Denver["'`]|["'`]2022-11-30["'`]/
  );
  if (personalConstant) {
    note(file, 0, "inline-personal-constant",
      `personal value ${personalConstant[0]} must come from config/profile.json`);
  }
}

const byRule = findings.reduce((acc, f) => {
  (acc[f.rule] ??= []).push(f);
  return acc;
}, {});

const RULES = {
  "silent-catch": "FAIL",
  "unreadable-store": "FAIL",
  "uncounted-parse-failure": "WARN",
  "inline-personal-constant": "FAIL"
};

console.log(`Scanned ${files.length} scripts for unknown-vs-zero hazards.\n`);
let failed = 0;
let warned = 0;
for (const [rule, severity] of Object.entries(RULES)) {
  const hits = byRule[rule] ?? [];
  if (!hits.length) {
    console.log(`ok    ${rule}`);
    continue;
  }
  for (const hit of hits) {
    const where = hit.line ? `${hit.file}:${hit.line}` : hit.file;
    console.log(`${severity.padEnd(5)} ${rule.padEnd(24)} ${where}\n        ${hit.detail}`);
  }
  if (severity === "FAIL") failed += hits.length;
  else warned += hits.length;
}

console.log(`\n${files.length} scripts: ${failed} fail, ${warned} warn.`);
if (failed || (strict && warned)) process.exit(1);
