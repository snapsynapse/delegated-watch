// The honesty eval is only as honest as its own file list. It scanned .js only
// for long enough that both .mjs capture wrappers -- the scripts that read
// provider counters, which is the entire point of the rules -- were exempt
// while the run still printed a reassuring "Scanned 34 scripts".
//
// These tests derive the expected set from the tree independently of the eval,
// so any future narrowing (an extension dropped, a directory skipped, a name
// filtered) fails here rather than passing quietly.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const evalScript = join(repo, "scripts/eval-code-honesty.js");

// Anything Node will execute as a module, found without consulting the eval.
const MODULE_EXTENSIONS = [".js", ".mjs", ".cjs"];

async function* modulesUnder(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* modulesUnder(path);
    else if (MODULE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) yield path;
  }
}

const scannedFiles = async () => {
  const { stdout } = await run(process.execPath, [evalScript, "--list"], { cwd: repo });
  return stdout.split("\n").filter(Boolean).sort();
};

test("scans every JavaScript module under scripts/ and src/, whatever the extension", async () => {
  const expected = [];
  for (const dir of ["scripts", "src"]) {
    for await (const path of modulesUnder(join(repo, dir))) {
      expected.push(path.slice(repo.length + 1));
    }
  }
  expected.sort();

  assert.deepEqual(
    await scannedFiles(),
    expected,
    "the eval's file set drifted from the modules actually on disk"
  );
});

test("covers the capture wrappers by name", async () => {
  // Named explicitly: .mjs wrappers are the files the .js-only walk exempted,
  // and a generic set comparison would still pass if they vanished from the
  // tree. Only the wrapper every layout ships is named here.
  const scanned = await scannedFiles();
  for (const wrapper of [
    "scripts/ollama-capture.mjs"
  ]) {
    assert.ok(scanned.includes(wrapper), `${wrapper} is not scanned by the honesty eval`);
  }
});

test("reports a count that matches the files it scanned", async () => {
  const { stdout } = await run(process.execPath, [evalScript], { cwd: repo });
  const claimed = stdout.match(/Scanned (\d+) scripts/);
  assert.ok(claimed, "the eval no longer reports how many scripts it scanned");
  assert.equal(Number(claimed[1]), (await scannedFiles()).length);
});

// The usage-literal rule runs against a throwaway tree, so the cases below can
// hold numbers the real tree must never contain.
async function scanTree(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "dw-honesty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, "src"), { recursive: true });
  for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
  return run(process.execPath, [evalScript, "--strict"], { cwd: dir }).then(
    (result) => ({ status: 0, stdout: result.stdout }),
    (error) => ({ status: error.code, stdout: error.stdout })
  );
}

test("an unmarked token-count anecdote in a production comment fails without echoing it", async (t) => {
  const result = await scanTree(t, {
    "scripts/tool.js": "// That afternoon burned 41,299,881 tokens on one task.\nexport const x = 1;\n",
    "src/app.js": "export const y = 2;\n"
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+usage-literal\s+scripts\/tool\.js:1/);
  assert.doesNotMatch(result.stdout, /41,299,881|41299881/);
});

test("an embedded token literal in code fails, in src/ as well as scripts/", async (t) => {
  const result = await scanTree(t, {
    "scripts/tool.js": "export const x = 1;\n",
    "src/app.js": "const sample = { tokens: 52149, calls: 3 };\n"
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL\s+usage-literal\s+src\/app\.js:1/);
  assert.doesNotMatch(result.stdout, /52149/);
});

test("synthetic, example, and documented-limit counts pass, as do dates and formulas", async (t) => {
  const result = await scanTree(t, {
    "scripts/tool.js": [
      "// Synthetic receipt: tokens 4200, calls 6.",
      "//   {\"tokens\":4200,\"provenance\":\"example receipt\"}",
      "// Refuse more than 100000 tokens in one call (documented limit).",
      "// Usage on 2025-01-04 is read from the counter, never estimated.",
      "// tokens = input + output; a day of usage holds 86400 seconds.",
      "export const MAX_TOKENS = 1000000; // limit",
      "export const total = tokens * 1000;",
      ""
    ].join("\n"),
    "src/app.js": "export const y = 2;\n"
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /ok\s+usage-literal/);
});
