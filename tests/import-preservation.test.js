import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { partitionCompleteReceipts } from "../scripts/lib/import-policy.js";
import { reconcileReceipts, validateReceiptSchema } from "../scripts/lib/receipt-schema.js";
import {
  checkEvidenceOverlap,
  recoverDataAcceptance
} from "../scripts/lib/accepted-evidence.js";

const repo = resolve(import.meta.dirname, "..");

// The public candidate ships the importer and the core commands but not the
// OpenAI lane or the personal export. A script that is absent in this layout
// is skipped by name, so the gap is visible; any other read failure surfaces.
const present = (script) => {
  try {
    statSync(join(repo, "scripts", script));
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    test.skip("a command this layout does not ship");
    return false;
  }
};
const original = [{ date: "2026-01-02", timezone: "UTC", total: 100,
  sources: { codex: { tokens: 100, calls: 2, fidelity: "exact" } }, driver: "research", evidence: "synthetic" }];
const base = { date: "2026-01-02", timezone: "UTC", source: "codex", tokens: 100, calls: 2, fidelity: "exact" };
async function fixture(receipt) {
  const cwd = await mkdtemp(join(tmpdir(), "dw-preservation-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  const data = join(cwd, "public/data/daily-burn.json");
  await writeFile(data, JSON.stringify(original) + "\n");
  const receipts = Array.isArray(receipt) ? receipt : [receipt];
  await writeFile(
    join(cwd, "input.jsonl"),
    receipts.map((value) => JSON.stringify(value)).join("\n") + "\n"
  );
  return { cwd, data };
}
for (const script of ["import-daily-burn.js", "import-openai.js"].filter(present)) {
  for (const [kind, patch] of Object.entries({ tokens: { tokens: 10 }, calls: { calls: 1 }, fidelity: { fidelity: "estimated" } })) {
    test(`${script} preserves bytes when exact ${kind} regresses`, async () => {
      const { cwd, data } = await fixture({ ...base, ...patch });
      const before = await readFile(data, "utf8");
      const result = spawnSync(process.execPath, [join(repo, "scripts", script), "input.jsonl"], { cwd, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /historical regression/);
      assert.equal(await readFile(data, "utf8"), before);
    });
  }
  test(`${script} refuses unconfirmed decrease flag`, async () => {
    const { cwd } = await fixture({ ...base, tokens: 10 });
    const result = spawnSync(process.execPath, [join(repo, "scripts", script), "--allow-decrease", "input.jsonl"], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirm-correction/);
  });
  test(`${script} holds current day without writing it`, async () => {
    const { cwd, data } = await fixture({ ...base, date: new Date().toISOString().slice(0, 10) });
    const result = spawnSync(process.execPath, [join(repo, "scripts", script), "input.jsonl"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Held back/);
    assert.deepEqual(JSON.parse(await readFile(data, "utf8")), original);
  });
}
test("cutoff uses the configured calendar day, including midnight and DST", () => {
  const receipts = ["2026-03-07", "2026-03-08"].map((date) => ({ ...base, date }));
  const parts = partitionCompleteReceipts(receipts, "America/New_York", "2026-01-01", new Date("2026-03-08T05:00:00Z"));
  assert.equal(parts.today, "2026-03-08");
  assert.equal(parts.receipts.length, 1);
  assert.equal(parts.heldBack.length, 1);
  assert.throws(() => partitionCompleteReceipts([{ ...base, date: "2026-02-30" }], "UTC", "2026-01-01"), /invalid calendar date/);
});
test("Perplexity transport compatibility preserves genuine surface conflicts", () => {
  const r = { ...base, source: "perplexity_api", provider: "perplexity", snapshot_key: "perplexity:synthetic" };
  const result = reconcileReceipts([{ ...r, surface: "native_api_capture" }, { ...r, surface: "tool_result_capture" }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].surface, "api");
  assert.equal(reconcileReceipts([{ ...r, surface: "api" }, { ...r, surface: "unrelated" }]).errors.length, 1);
});

test("snapshot reconciliation rejects scope collisions and lost request identities", () => {
  const a = { ...base, snapshot_key: "synthetic", machine_alias: "store-a", correlation_keys: ["sha256:" + "a".repeat(64)] };
  assert.match(reconcileReceipts([a, { ...a, machine_alias: "store-b" }]).errors.join(), /conflicts/);
  const larger = { ...a, tokens: 200, correlation_keys: ["sha256:" + "b".repeat(64)] };
  for (const pair of [[a, larger], [larger, a]]) {
    assert.match(reconcileReceipts(pair).errors.join(), /omits previously observed/);
  }
});

test("equivalent snapshots retain incomplete coverage regardless of file order", () => {
  const complete = { ...base, snapshot_key: "codex:synthetic" };
  const incomplete = {
    ...complete,
    coverage: "incomplete",
    coverage_reasons: ["copied_fork_parent_missing"]
  };
  for (const pair of [[complete, incomplete], [incomplete, complete]]) {
    const result = reconcileReceipts(pair);
    assert.deepEqual(result.errors, []);
    assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].coverage, "incomplete");
    assert.deepEqual(result.receipts[0].coverage_reasons, ["copied_fork_parent_missing"]);
  }
});

test("equivalent snapshots reconcile token components fieldwise regardless of file order", () => {
  const rich = {
    ...base,
    schema_version: 2,
    provider: "openai",
    surface: "codex",
    account_alias: "primary",
    origin: "machine/test",
    snapshot_key: "codex:primary:2026-01-02",
    authority: "tool",
    interval: { start: base.date, end: base.date },
    token_components: {
      schema_version: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0
    }
  };
  const legacy = structuredClone(rich);
  delete legacy.token_components;

  for (const receipts of [[rich, legacy], [legacy, rich]]) {
    const result = reconcileReceipts(receipts);
    assert.deepEqual(result.errors, []);
    assert.equal(result.receipts.length, 1);
    assert.deepEqual(result.receipts[0].token_components, rich.token_components);
  }

  const conflicting = structuredClone(rich);
  conflicting.token_components.input_tokens = 101;
  const result = reconcileReceipts([rich, conflicting]);
  assert.match(result.errors.join("\n"), /token_components.*input_tokens.*conflict/i);
});

test("receipt token components distinguish unavailable from zero and enforce subsets", () => {
  const receipt = {
    ...base,
    schema_version: 2,
    provider: "openai",
    surface: "codex",
    account_alias: "primary",
    origin: "machine/test",
    snapshot_key: "codex:primary:2026-01-02",
    authority: "tool",
    interval: { start: "2026-01-02", end: "2026-01-02" },
    token_components: {
      schema_version: 1,
      input_tokens: 1000,
      cached_input_tokens: 600,
      output_tokens: 200,
      reasoning_tokens: 50,
      cache_write_tokens: 0
    }
  };
  assert.deepEqual(validateReceiptSchema(receipt), []);
  assert.equal(receipt.token_components.cache_write_tokens, 0);

  const unavailable = structuredClone(receipt);
  delete unavailable.token_components.cache_write_tokens;
  assert.deepEqual(validateReceiptSchema(unavailable), []);
  assert.equal(Object.hasOwn(unavailable.token_components, "cache_write_tokens"), false);

  const cachedTooLarge = structuredClone(receipt);
  cachedTooLarge.token_components.cached_input_tokens = 1001;
  assert.match(validateReceiptSchema(cachedTooLarge).join("\n"), /cached_input_tokens.*input_tokens/);

  const reasoningTooLarge = structuredClone(receipt);
  reasoningTooLarge.token_components.reasoning_tokens = 201;
  assert.match(validateReceiptSchema(reasoningTooLarge).join("\n"), /reasoning_tokens.*output_tokens/);

  const invalidVersion = structuredClone(receipt);
  invalidVersion.token_components.schema_version = 2;
  assert.match(validateReceiptSchema(invalidVersion).join("\n"), /token_components schema_version must be 1/);
});

test("fresh authority reconciliation requires exact keys, day, provider, and account scope", () => {
  const correlationKey = "sha256:" + "c".repeat(64);
  const baseReceipt = {
    ...base,
    schema_version: 2,
    provider: "openai",
    account_alias: "primary",
    origin: "machine/test",
    interval: { start: base.date, end: base.date },
    correlation_keys: [correlationKey]
  };
  const tool = {
    ...baseReceipt,
    source: "codex",
    surface: "codex",
    snapshot_key: "codex:primary:2026-01-02",
    authority: "tool"
  };
  const provider = {
    ...baseReceipt,
    source: "openai_capture",
    surface: "api",
    origin: "gateway/test",
    snapshot_key: "openai:primary:2026-01-02",
    authority: "provider"
  };
  for (const pair of [[tool, provider], [provider, tool]]) {
    const result = reconcileReceipts(pair);
    assert.deepEqual(result.errors, []);
    assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].source, "openai_capture");
  }

  const wrongAccount = reconcileReceipts([
    tool,
    { ...provider, account_alias: "secondary" }
  ]);
  assert.match(wrongAccount.errors.join("\n"), /identical request set.*scope/);
});

const authorityReceipt = ({
  authority,
  source,
  keys,
  account = "primary",
  date = base.date,
  tokens = 100,
  token_components
}) => ({
  schema_version: 2,
  date,
  timezone: "UTC",
  source,
  provider: "openai",
  surface: authority === "provider" ? "api" : "codex",
  account_alias: account,
  origin: authority === "provider" ? "gateway/test" : "machine/test",
  snapshot_key: `${source}:${account}:${date}`,
  authority,
  interval: { start: date, end: date },
  fidelity: "exact",
  tokens,
  calls: 1,
  correlation_keys: keys,
  ...(token_components ? { token_components } : {})
});

const makeAuthorityFixture = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dw-authority-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  await writeFile(join(cwd, "public/data/daily-burn.json"), "[]\n");
  return cwd;
};

const runImport = (cwd, receipts, env = process.env) => {
  const input = join(cwd, "input.jsonl");
  const text = receipts.map((value) => JSON.stringify(value)).join("\n");
  return writeFile(input, text ? text + "\n" : "").then(() =>
    spawnSync(
      process.execPath,
      [join(repo, "scripts", "import-daily-burn.js"), "input.jsonl"],
      { cwd, encoding: "utf8", env }
    )
  );
};

test("combined and sequential authority imports converge in both orders", async (t) => {
  const correlationKey = "sha256:" + "d".repeat(64);
  const toolComponents = {
    schema_version: 1,
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 20,
    reasoning_tokens: 0
  };
  const providerComponents = {
    schema_version: 1,
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 20,
    reasoning_tokens: 5
  };
  const tool = authorityReceipt({
    authority: "tool",
    source: "codex",
    keys: [correlationKey],
    token_components: toolComponents
  });
  const provider = authorityReceipt({
    authority: "provider",
    source: "openai_capture",
    keys: [correlationKey],
    token_components: providerComponents
  });
  for (const order of ["combined", "tool-provider", "provider-tool"]) {
    const cwd = await makeAuthorityFixture();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    if (order === "combined") {
      const result = await runImport(cwd, [tool, provider]);
      assert.equal(result.status, 0, result.stderr);
    } else {
      const [first, second] = order === "tool-provider" ? [tool, provider] : [provider, tool];
      const initial = await runImport(cwd, [first]);
      assert.equal(initial.status, 0, initial.stderr);
      const beforeReplay = order === "provider-tool"
        ? {
            data: await readFile(join(cwd, "public/data/daily-burn.json"), "utf8"),
            manifest: await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8")
          }
        : null;
      const next = await runImport(cwd, [second]);
      assert.equal(next.status, 0, next.stderr);
      if (beforeReplay) {
        assert.equal(
          await readFile(join(cwd, "public/data/daily-burn.json"), "utf8"),
          beforeReplay.data
        );
        assert.equal(
          await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8"),
          beforeReplay.manifest
        );
      }
    }
    const [record] = JSON.parse(await readFile(join(cwd, "public/data/daily-burn.json"), "utf8"));
    assert.equal(record.total, 100, order);
    assert.deepEqual(Object.keys(record.sources), ["openai_capture"], order);
    assert.deepEqual(record.sources.openai_capture.token_components, providerComponents, order);
    const manifest = JSON.parse(
      await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8")
    );
    const active = manifest.entries.filter((entry) => !entry.disposition);
    assert.equal(active.length, 1, order);
    assert.equal(active[0].authority, "provider", order);
    assert.deepEqual(active[0].token_components, providerComponents, order);
    for (const replay of [tool, provider]) {
      const overlap = checkEvidenceOverlap(manifest, [replay]);
      assert.equal(overlap.conflicts.length, 0, order);
      assert.equal(overlap.replay_receipts, 1, order);
    }

    const beforeRawDisappearance = await readFile(
      join(cwd, "public/data/evidence-manifest.json"),
      "utf8"
    );
    const withoutRaw = await runImport(cwd, []);
    assert.equal(withoutRaw.status, 0, withoutRaw.stderr);
    assert.equal(
      await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8"),
      beforeRawDisappearance,
      order
    );
  }
});

test("sequential equivalent snapshot replay preserves the richest component evidence", async (t) => {
  const correlationKey = "sha256:" + "4".repeat(64);
  const tokenComponents = {
    schema_version: 1,
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: 0
  };
  const rich = authorityReceipt({
    authority: "tool",
    source: "codex",
    keys: [correlationKey],
    token_components: tokenComponents
  });
  const legacy = structuredClone(rich);
  delete legacy.token_components;

  for (const order of [[rich, legacy], [legacy, rich, legacy]]) {
    const cwd = await makeAuthorityFixture();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    let richState;
    for (const receipt of order) {
      const result = await runImport(cwd, [receipt]);
      assert.equal(result.status, 0, result.stderr);
      const data = await readFile(join(cwd, "public/data/daily-burn.json"), "utf8");
      const manifest = await readFile(
        join(cwd, "public/data/evidence-manifest.json"),
        "utf8"
      );
      if (receipt.token_components) richState = { data, manifest };
      else if (richState) {
        assert.equal(data, richState.data);
        assert.equal(manifest, richState.manifest);
      }
    }
    const [record] = JSON.parse(
      await readFile(join(cwd, "public/data/daily-burn.json"), "utf8")
    );
    assert.deepEqual(record.sources.codex.token_components, tokenComponents);
  }
});

test("sequential equivalent snapshot replay fails closed on conflicting measured components", async (t) => {
  const cwd = await makeAuthorityFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const rich = authorityReceipt({
    authority: "tool",
    source: "codex",
    keys: ["sha256:" + "6".repeat(64)],
    token_components: {
      schema_version: 1,
      input_tokens: 100,
      output_tokens: 20
    }
  });
  const first = await runImport(cwd, [rich]);
  assert.equal(first.status, 0, first.stderr);
  const dataPath = join(cwd, "public/data/daily-burn.json");
  const manifestPath = join(cwd, "public/data/evidence-manifest.json");
  const beforeData = await readFile(dataPath, "utf8");
  const beforeManifest = await readFile(manifestPath, "utf8");
  const conflicting = structuredClone(rich);
  conflicting.token_components.input_tokens = 101;

  const replay = await runImport(cwd, [conflicting]);
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /token_components.*input_tokens.*conflict/i);
  assert.equal(await readFile(dataPath, "utf8"), beforeData);
  assert.equal(await readFile(manifestPath, "utf8"), beforeManifest);
});

test("evidence summary counts active accepted identities separately from superseded history", async (t) => {
  const cwd = await makeAuthorityFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const correlationKey = "sha256:" + "5".repeat(64);
  const tool = authorityReceipt({
    authority: "tool",
    source: "codex",
    keys: [correlationKey]
  });
  const provider = authorityReceipt({
    authority: "provider",
    source: "openai_capture",
    keys: [correlationKey]
  });
  assert.equal((await runImport(cwd, [tool])).status, 0);
  const replacement = await runImport(cwd, [provider]);
  assert.equal(replacement.status, 0, replacement.stderr);

  const manifest = JSON.parse(
    await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8")
  );
  assert.equal(manifest.receipts, 2);
  assert.equal(manifest.identified_requests, 1);
  assert.equal(manifest.ledger.accepted_receipts, 1);
  assert.equal(manifest.ledger.legacy_unverified_receipts, 0);
  assert.equal(manifest.ledger.superseded_history_receipts, 1);
  assert.equal(manifest.coverage.codex.receipts, 1);
  assert.equal(manifest.coverage.codex.active_receipts, 0);
  assert.equal(manifest.coverage.codex.accepted_receipts, 0);
  assert.equal(manifest.coverage.codex.identified_requests, 0);
  assert.equal(manifest.coverage.codex.superseded_history_receipts, 1);
  assert.equal(manifest.coverage.openai_capture.active_receipts, 1);
  assert.equal(manifest.coverage.openai_capture.accepted_receipts, 1);
  assert.equal(manifest.coverage.openai_capture.identified_requests, 1);
  assert.equal(manifest.coverage.openai_capture.superseded_history_receipts, 0);
});

test("authority replacement retires only the matched request set", async (t) => {
  const cwd = await makeAuthorityFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const a = "sha256:" + "1".repeat(64);
  const b = "sha256:" + "2".repeat(64);
  const first = await runImport(cwd, [
    authorityReceipt({ authority: "tool", source: "codex", keys: [a], tokens: 40 }),
    {
      ...authorityReceipt({ authority: "tool", source: "codex", keys: [b], tokens: 60 }),
      snapshot_key: "codex:primary:2026-01-02:second"
    }
  ]);
  assert.equal(first.status, 0, first.stderr);
  const replacement = authorityReceipt({
    authority: "provider",
    source: "openai_capture",
    keys: [a],
    tokens: 40
  });
  const second = await runImport(cwd, [replacement]);
  assert.equal(second.status, 0, second.stderr);
  const [record] = JSON.parse(
    await readFile(join(cwd, "public/data/daily-burn.json"), "utf8")
  );
  assert.equal(record.total, 100);
  assert.equal(record.sources.codex.tokens, 60);
  assert.equal(record.sources.openai_capture.tokens, 40);
});

test("interrupted authority migration recovers the dataset and ledger as one transition", async (t) => {
  const cwd = await makeAuthorityFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const correlationKey = "sha256:" + "3".repeat(64);
  const tool = authorityReceipt({ authority: "tool", source: "codex", keys: [correlationKey] });
  const provider = authorityReceipt({ authority: "provider", source: "openai_capture", keys: [correlationKey] });
  assert.equal((await runImport(cwd, [tool])).status, 0);
  const interrupted = await runImport(cwd, [provider], {
    ...process.env,
    DELEGATED_WATCH_ACCEPT_INTERRUPT: "after-first-file"
  });
  assert.notEqual(interrupted.status, 0);
  await recoverDataAcceptance({ mode: "complete", root: cwd });
  const [record] = JSON.parse(
    await readFile(join(cwd, "public/data/daily-burn.json"), "utf8")
  );
  const manifest = JSON.parse(
    await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8")
  );
  assert.deepEqual(Object.keys(record.sources), ["openai_capture"]);
  assert.equal(
    manifest.entries.filter((entry) => entry.disposition !== "superseded")[0].authority,
    "provider"
  );
});

test("persisted authority replacement fails closed for partial, cross-day, or account-mismatched evidence", async (t) => {
  const a = "sha256:" + "e".repeat(64);
  const b = "sha256:" + "f".repeat(64);
  for (const incoming of [
    authorityReceipt({ authority: "provider", source: "openai_capture", keys: [a] }),
    authorityReceipt({ authority: "provider", source: "openai_capture", keys: [a, b], account: "secondary" }),
    authorityReceipt({ authority: "provider", source: "openai_capture", keys: [a, b], date: "2026-01-03" })
  ]) {
    const cwd = await makeAuthorityFixture();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const tool = authorityReceipt({ authority: "tool", source: "codex", keys: [a, b] });
    assert.equal((await runImport(cwd, [tool])).status, 0);
    const dataPath = join(cwd, "public/data/daily-burn.json");
    const manifestPath = join(cwd, "public/data/evidence-manifest.json");
    const beforeData = await readFile(dataPath, "utf8");
    const beforeManifest = await readFile(manifestPath, "utf8");
    const result = await runImport(cwd, [incoming]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overlap|scope|day/i);
    assert.equal(await readFile(dataPath, "utf8"), beforeData);
    assert.equal(await readFile(manifestPath, "utf8"), beforeManifest);
  }
});

test("import preserves incomplete receipt coverage on the source entry", async () => {
  const { cwd, data } = await fixture({
    ...base,
    coverage: "incomplete",
    coverage_reasons: ["copied_fork_parent_missing"]
  });
  const result = spawnSync(
    process.execPath,
    [join(repo, "scripts", "import-daily-burn.js"), "input.jsonl"],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const [row] = JSON.parse(await readFile(data, "utf8"));
  assert.equal(row.sources.codex.coverage, "incomplete");
  assert.deepEqual(row.sources.codex.coverage_reasons, ["copied_fork_parent_missing"]);
});

test("import aggregates only fully available token components and retains measured zero", async () => {
  const v2 = (snapshot, tokens, token_components) => ({
    ...base,
    tokens,
    calls: 1,
    schema_version: 2,
    provider: "openai",
    surface: "codex",
    account_alias: "primary",
    origin: "machine/test",
    snapshot_key: snapshot,
    authority: "tool",
    interval: { start: base.date, end: base.date },
    token_components
  });
  const { cwd, data } = await fixture([
    v2("codex:a", 60, {
      schema_version: 1,
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 10,
      reasoning_tokens: 0,
      cache_write_tokens: 0
    }),
    v2("codex:b", 40, {
      schema_version: 1,
      input_tokens: 50,
      cached_input_tokens: 20,
      output_tokens: 10,
      cache_write_tokens: 0
    })
  ]);
  const result = spawnSync(
    process.execPath,
    [join(repo, "scripts", "import-daily-burn.js"), "input.jsonl"],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const [imported] = JSON.parse(await readFile(data, "utf8"));
  assert.equal(imported.sources.codex.tokens, 100);
  assert.deepEqual(imported.sources.codex.token_components, {
    schema_version: 1,
    input_tokens: 150,
    output_tokens: 20,
    cached_input_tokens: 70,
    cache_write_tokens: 0
  });
  assert.equal(Object.hasOwn(imported.sources.codex.token_components, "reasoning_tokens"), false);

  const manifest = JSON.parse(
    await readFile(join(cwd, "public/data/evidence-manifest.json"), "utf8")
  );
  assert.deepEqual(manifest.entries.map((entry) => entry.token_components), [
    {
      schema_version: 1,
      input_tokens: 100,
      output_tokens: 10,
      cached_input_tokens: 50,
      cache_write_tokens: 0,
      reasoning_tokens: 0
    },
    {
      schema_version: 1,
      input_tokens: 50,
      output_tokens: 10,
      cached_input_tokens: 20,
      cache_write_tokens: 0
    }
  ]);
});

test("import persists a standalone cached-only measured day instead of treating it as unknown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dw-measured-zero-"));
  await mkdir(join(cwd, "public/data"), { recursive: true });
  const data = join(cwd, "public/data/daily-burn.json");
  await writeFile(data, "[]\n");
  await writeFile(join(cwd, "input.jsonl"), JSON.stringify({
    schema_version: 2,
    date: "2026-01-02",
    timezone: "UTC",
    source: "openai_api",
    provider: "openai",
    surface: "api",
    account_alias: "primary-scope",
    origin: "account/openai",
    interval: { start: "2026-01-02", end: "2026-01-02" },
    snapshot_key: "openai_api:primary-scope:2026-01-02",
    authority: "provider",
    tokens: 0,
    calls: 5,
    fidelity: "exact",
    token_components: {
      schema_version: 1,
      input_tokens: 750,
      cached_input_tokens: 750,
      output_tokens: 0
    }
  }) + "\n");

  const result = spawnSync(
    process.execPath,
    [join(repo, "scripts", "import-daily-burn.js"), "input.jsonl"],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(data, "utf8")), [{
    date: "2026-01-02",
    timezone: "UTC",
    sources: {
      openai_api: {
        tokens: 0,
        fidelity: "exact",
        calls: 5,
        token_components: {
          schema_version: 1,
          input_tokens: 750,
          output_tokens: 0,
          cached_input_tokens: 750
        },
        by_origin: { "account/openai": 0 }
      }
    },
    total: 0,
    driver: "unreviewed",
    evidence: "imported from local receipts; pending review"
  }]);
});

test("pending acceptance blocks public export and dependent commands before output changes", async () => {
  const { cwd } = await fixture(base);
  await mkdir(join(cwd, "scratch"), { recursive: true });
  await mkdir(join(cwd, "dist/personal-public"), { recursive: true });
  const output = join(cwd, "dist/personal-public/index.html");
  await writeFile(output, "previous reviewed output");
  await writeFile(join(cwd, "scratch/accepted-evidence-transaction.json"), "{}");
  for (const script of ["validate-data.js", "eval-dataset.js", "build.js", "export-personal-public.js", "eval-personal-public.js", "export-csv.js", "apply-drivers.js", "apply-source-entry-exclusions.js"].filter(present)) {
    const result = spawnSync(process.execPath, [join(repo, "scripts", script)], { cwd, encoding: "utf8" });
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /Pending evidence acceptance/, script);
    assert.equal(await readFile(output, "utf8"), "previous reviewed output");
  }
});
