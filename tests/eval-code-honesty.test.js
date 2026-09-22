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
import { readdir } from "node:fs/promises";
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

test("scans every JavaScript module under scripts/, whatever the extension", async () => {
  const expected = [];
  for await (const path of modulesUnder(join(repo, "scripts"))) {
    expected.push(path.slice(repo.length + 1));
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
