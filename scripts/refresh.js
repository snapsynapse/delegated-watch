// One command from install to dashboard: extract every surface this machine
// has, import, validate, export, build, and evaluate, into a person's own
// record.
//
// The record lives in record/, which, like config/record.json that selects
// it, is git-ignored: a clone holding a real record cannot publish it by
// committing. The first run creates both, with an empty dataset. After that,
// every command in this repository works on the record rather than on the
// shipped synthetic demo; deleting config/record.json switches back.
//
// Each extractor reports its own stores. One whose store is absent writes
// nothing and succeeds; one that finds a store it cannot read, or cannot
// decide, exits 3 and leaves its previous receipts untouched, which is
// reported here and does not stop the run. The usage-API extractors skip
// cleanly without their keys. Call-time captures (Ollama, Perplexity, TypeSafe)
// are not run here: they record calls as they happen, and their receipts are
// imported with everything else.
//
// Options a person has decided once, such as which token convention an editor
// extension's ambiguous records follow, live in config/record.json under
// "options", as extra arguments per step:
//   { "dir": "record",
//     "options": { "extract:vscode-agents": ["--token-convention", "snapdev=inclusive"] } }
//
// Usage:
//   node scripts/refresh.js [--skip STEP]... [--only STEP]...
//
// STEP is a step name as the summary prints it, such as extract:codex.
//
// Exit status: 0 when every step succeeded; 3 when a source was unknown but
// the record was still imported and built; 1 when an import, validation, or
// build step failed; 64 usage.

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RECORD_DIR, RECORD_CONFIG, recordPaths } from "./lib/record-paths.js";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const EXTRACT = [
  ["extract:claude-code", "extract-claude-code.js"],
  ["extract:codex", "extract-codex.js"],
  ["extract:goose", "extract-goose.js"],
  ["extract:vscode-agents", "extract-vscode-agents.js"],
  ["extract:gemini-cli", "extract-gemini-cli.js"],
  ["extract:copilot-cli", "extract-copilot-cli.js"],
  ["extract:zed-agent", "extract-zed-agent.js"],
  ["extract:cursor", "extract-cursor.js"],
  ["estimate:claude-chat", "estimate-claude-chat.js"],
  ["estimate:chatgpt", "estimate-chatgpt.js"],
  ["extract:claude-api", "extract-claude-api.js"],
  ["extract:openai-api", "extract-openai-api.js"]
];
// These must all succeed, in order, for the record to be trusted.
const FINISH = [
  ["import", "import-daily-burn.js"],
  ["export:csv", "export-csv.js"],
  ["build", "build.js"],
  ["eval", "eval-dataset.js"],
  ["eval:dashboard", "eval-dashboard.js"],
  ["eval:served", "eval-served-tree.js"]
];

const args = process.argv.slice(2);
const listOf = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
const skip = new Set(listOf("--skip"));
const only = new Set(listOf("--only"));
const known = new Set([...EXTRACT, ...FINISH].map(([name]) => name));
for (const [index, arg] of args.entries()) {
  const isValue = index > 0 && ["--skip", "--only"].includes(args[index - 1]);
  if (isValue ? !known.has(arg) : !["--skip", "--only"].includes(arg)) {
    console.error(`Unknown ${isValue ? "step" : "argument"}: ${arg}. Steps: ${[...known].join(", ")}.`);
    process.exit(64);
  }
}
const selected = ([name]) => !skip.has(name) && (!only.size || only.has(name));

// First run: switch this checkout to a record of its own.
let paths = recordPaths();
if (paths.mode === "demo") {
  await mkdir(dirname(RECORD_CONFIG), { recursive: true });
  await writeFile(RECORD_CONFIG, `${JSON.stringify({ dir: DEFAULT_RECORD_DIR }, null, 2)}\n`, { flag: "wx" });
  console.log(`Created ${RECORD_CONFIG}: this checkout now keeps its own record in ${DEFAULT_RECORD_DIR}/, which git ignores.`);
  console.log(`Delete ${RECORD_CONFIG} to go back to the shipped demo.`);
  paths = { dir: DEFAULT_RECORD_DIR, dataset: join(DEFAULT_RECORD_DIR, "daily-burn.json"), dashboard: join(DEFAULT_RECORD_DIR, "index.html") };
}
try {
  await access(paths.dataset);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.dataset, "[]\n", { flag: "wx" });
  console.log(`Started an empty record at ${paths.dataset}.`);
}

const options = JSON.parse(await readFile(RECORD_CONFIG, "utf8")).options ?? {};
for (const [step, extra] of Object.entries(options)) {
  if (!known.has(step) || !Array.isArray(extra) || !extra.every((value) => typeof value === "string")) {
    console.error(`${RECORD_CONFIG}: options.${step} must name a step and list string arguments.`);
    process.exit(64);
  }
}

const outcomes = [];
const runStep = ([name, script]) => {
  const extra = options[name] ?? [];
  console.log(`\n== ${name}${extra.length ? ` ${extra.join(" ")}` : ""}`);
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...extra], { stdio: "inherit" });
  const status = result.status ?? 1;
  const outcome = status === 0 ? "ok" : status === 3 ? "unknown" : "failed";
  outcomes.push({ name, outcome, status });
  return outcome;
};

for (const step of EXTRACT.filter(selected)) runStep(step);
let finished = true;
for (const step of FINISH.filter(selected)) {
  if (runStep(step) === "failed") {
    finished = false;
    break;
  }
}

console.log("\nSummary:");
for (const { name, outcome, status } of outcomes) {
  const note = outcome === "unknown" ? " (exit 3: a source is unknown, not zero; see its output above)" : outcome === "failed" ? ` (exit ${status})` : "";
  console.log(`  ${outcome.padEnd(8)} ${name}${note}`);
}
const failedExtract = outcomes.some(({ name, outcome }) => outcome === "failed" && name.startsWith("e"));
if (!finished) {
  console.log("\nThe record was not rebuilt, because a required step failed. Nothing already committed to it was lowered.");
  process.exit(1);
}
console.log(`\nYour dashboard is ${paths.dashboard}. Open it directly, or run npm run dev and visit the address it prints.`);
if (failedExtract) process.exit(1);
if (outcomes.some(({ outcome }) => outcome === "unknown")) process.exit(3);
