import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "demo-import.js");
const REAL_DATASET = join(REPO_ROOT, "public", "data", "daily-burn.json");

// This repo's private production data file. The test hashes it -- never reads
// its parsed contents -- purely to prove demo-import.js never touches it.
const hashOf = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

const demoTempDirs = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith("delegated-watch-demo-import-")).sort();

test("demo-import runs all four scenarios and reports their outcomes", async () => {
  const before = await hashOf(REAL_DATASET);
  const tempsBefore = await demoTempDirs();

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });

  assert.equal(result.status, 0, `demo-import.js exited ${result.status}\n${result.stderr}`);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 4, `expected exactly 4 narrative lines, got:\n${result.stdout}`);

  const [dayOne, regression, estimated, today] = lines;

  assert.match(dayOne, /^day-one: imports 2 new row\(s\)/);
  assert.match(dayOne, /as driver "unreviewed"/);
  assert.match(dayOne, /2\/2 confirmed/);

  assert.match(regression, /^regression: refused by the importer's own no-decrease gate/);
  assert.match(regression, /Blocked exact historical regression/);
  assert.match(regression, /2025-01-02\/codex: tokens 36327 -> 10000/);

  assert.match(estimated, /^estimated: merges "claude_chat" \(estimated\) into 2025-01-09/);
  assert.match(estimated, /mixes fidelities: estimated, exact/);

  assert.match(today, /^today \(\d{4}-\d{2}-\d{2}\): held back by the midnight cutoff/);
  assert.match(today, /Held back 1 receipt\(s\) for \d{4}-\d{2}-\d{2}: not yet a complete day in UTC/);

  const after = await hashOf(REAL_DATASET);
  assert.equal(after, before, "demo-import.js must never modify the real public/data/daily-burn.json");

  const tempsAfter = await demoTempDirs();
  assert.deepEqual(tempsAfter, tempsBefore, "demo-import.js must remove every temp directory it creates");
});
