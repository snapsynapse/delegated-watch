// Re-importing evidence that is already accepted must change nothing, for every
// receipt shape the extractors produce. A weekly run re-reads the same stores,
// so a replay that reads as new evidence, or as a conflict with itself, either
// double-counts or blocks the run. The unscoped local-store case did the
// latter until accepted evidence learned to recognise it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");
const DATE = "2026-01-02";
const key = (letter) => `sha256:${letter.repeat(64)}`;

const v2 = (overrides) => ({
  schema_version: 2,
  date: DATE,
  timezone: "UTC",
  provider: "openai",
  account_alias: "primary",
  interval: { start: DATE, end: DATE },
  fidelity: "exact",
  calls: 1,
  ...overrides
});

const SHAPES = {
  "tool receipt with request keys": [v2({
    source: "codex", surface: "codex", origin: "machine/synthetic", authority: "tool",
    snapshot_key: `codex:machine/synthetic:${DATE}`, tokens: 100, correlation_keys: [key("a")]
  })],
  "provider receipt with token components": [v2({
    source: "openai_api", surface: "api", origin: "gateway/synthetic", authority: "provider",
    snapshot_key: `openai_api:primary:${DATE}`, tokens: 50, calls: 2,
    token_components: { schema_version: 1, input_tokens: 40, output_tokens: 10, cached_input_tokens: 0 }
  })],
  "estimated receipt": [v2({
    source: "chatgpt", provider: "openai", surface: "chatgpt_export", origin: "export/synthetic",
    authority: "estimated", fidelity: "estimated", snapshot_key: `chatgpt:primary:${DATE}`, tokens: 30
  })],
  "cached-only measured zero": [v2({
    source: "codex", surface: "codex", origin: "machine/synthetic", authority: "tool",
    snapshot_key: `codex:machine/synthetic:${DATE}`, tokens: 0, correlation_keys: [key("b")],
    token_components: { schema_version: 1, input_tokens: 100, output_tokens: 0, cached_input_tokens: 100 }
  })],
  "unversioned local receipt with no provider or account": [{
    date: DATE, timezone: "UTC", source: "claude_code", tokens: 75, calls: 1, fidelity: "exact",
    origin: "machine/synthetic", provenance: "synthetic local store", correlation_keys: [key("e")]
  }],
  "two sources on one day": [
    v2({
      source: "codex", surface: "codex", origin: "machine/synthetic", authority: "tool",
      snapshot_key: `codex:machine/synthetic:${DATE}`, tokens: 100, correlation_keys: [key("c")]
    }),
    v2({
      source: "openai_api", surface: "api", origin: "gateway/synthetic", authority: "provider",
      snapshot_key: `openai_api:primary:${DATE}`, tokens: 50, correlation_keys: [key("d")]
    })
  ]
};

const runImport = async (cwd, receipts) => {
  await writeFile(join(cwd, "input.jsonl"), receipts.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return spawnSync(process.execPath, [join(repo, "scripts", "import-daily-burn.js"), "input.jsonl"], { cwd, encoding: "utf8" });
};

// Every file the importer owns, by relative path, so a replay that touches any
// of them is caught, not only the dataset.
const snapshot = async (dir, prefix = "") => {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(path, `${prefix}${entry.name}/`));
    else files[`${prefix}${entry.name}`] = await readFile(path, "utf8");
  }
  return files;
};

for (const [shape, receipts] of Object.entries(SHAPES)) {
  test(`replaying an accepted ${shape} changes nothing, in either order`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "dw-replay-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, "public/data"), { recursive: true });
    await writeFile(join(cwd, "public/data/daily-burn.json"), "[]\n");

    const first = await runImport(cwd, receipts);
    assert.equal(first.status, 0, first.stderr);
    const accepted = await snapshot(join(cwd, "public"));
    const rows = JSON.parse(accepted["data/daily-burn.json"]);
    assert.equal(rows.length, 1, "the first import records the day");

    for (const replay of [receipts, [...receipts].reverse()]) {
      const result = await runImport(cwd, replay);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(await snapshot(join(cwd, "public")), accepted);
    }
  });
}
