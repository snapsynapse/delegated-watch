// Provider-reported cost is provenance on a receipt and nothing else. These
// tests use synthetic figures only and pin the boundary: validated on the
// receipt, never imported into a daily row, the ledger, or a public field.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateDataset } from "../scripts/lib/dataset-validation.js";
import { parseJsonWithNumberText, providerReportedCost } from "../scripts/lib/provider-cost.js";
import { receiptPrivacyFindings } from "../scripts/lib/receipt-privacy.js";
import {
  PROVIDER_COST_FIELD,
  validateProviderReportedCost,
  validateReceiptSchema
} from "../scripts/lib/receipt-schema.js";

const repo = resolve(import.meta.dirname, "..");
const { timezone } = await import("../scripts/lib/profile.js");
const TIMEZONE = await timezone();
const yesterday = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(Date.now() - 86400000));

const syntheticCost = providerReportedCost("perplexity_usage_total_cost", "0.00700000", "USD");

test("each reviewed basis fixes its unit and currency basis", () => {
  assert.deepEqual(syntheticCost, {
    schema_version: 1,
    basis: "perplexity_usage_total_cost",
    amount: "0.00700000",
    currency: "USD",
    unit: "major",
    currency_basis: "documented"
  });
  assert.equal(providerReportedCost("anthropic_cost_report_day", "123.45", "USD").unit, "minor");
  assert.equal(providerReportedCost("openai_costs_day", "0.06", "usd").currency_basis, "reported");
  // No basis, no figure: there is no route for a modelled or guessed cost.
  assert.equal(providerReportedCost("price_table_estimate", "1.00", "USD"), null);
});

test("the validator refuses anything that is not the provider's own decimal text", () => {
  const valid = { ...syntheticCost };
  assert.deepEqual(validateProviderReportedCost(valid), []);
  for (const [label, value] of [
    ["number instead of text", { ...valid, amount: 0.004 }],
    ["formatted text", { ...valid, amount: "$0.004" }],
    ["empty amount", { ...valid, amount: "" }],
    ["unknown basis", { ...valid, basis: "modelled" }],
    ["unit contradicts basis", { ...valid, unit: "minor" }],
    ["currency basis contradicts basis", { ...valid, currency_basis: "reported" }],
    ["unapproved field", { ...valid, converted_usd: "0.004" }],
    ["bad currency", { ...valid, currency: "dollars" }],
    ["wrong version", { ...valid, schema_version: 2 }]
  ]) {
    assert.ok(validateProviderReportedCost(value).length, label);
  }
  assert.ok(validateProviderReportedCost(null).length);
});

test("number text survives parsing exactly as sent", () => {
  const parsed = parseJsonWithNumberText('{"usage":{"cost":{"total_cost":0.00700000}},"n":[1e-7]}');
  assert.equal(parsed.numberText(parsed.value.usage.cost, "total_cost"), "0.00700000");
  assert.equal(parsed.numberText(parsed.value.n, "0"), "1e-7");
  assert.equal(parsed.numberText(parsed.value.usage, "missing"), null);
});

test("receipts carry the field under schema and privacy checks, versioned or not", () => {
  const unversioned = {
    date: "2026-01-02", timezone: "UTC", source: "claude_api", tokens: 10,
    fidelity: "exact", origin: "account/synthetic", provenance: "synthetic fixture",
    [PROVIDER_COST_FIELD]: providerReportedCost("anthropic_cost_report_day", "12.5", "USD")
  };
  assert.deepEqual(validateReceiptSchema(unversioned), []);
  assert.deepEqual(receiptPrivacyFindings(unversioned), []);

  const malformed = { ...unversioned, [PROVIDER_COST_FIELD]: { amount: "0.31415926" } };
  assert.ok(validateReceiptSchema(malformed).length);
  const findings = receiptPrivacyFindings(malformed);
  assert.deepEqual(findings, [`${PROVIDER_COST_FIELD}: expected reviewed provider cost`]);
  assert.ok(!findings.join("\n").includes("0.31415926"));
});

test("a daily row may never carry a provider-reported cost", () => {
  const row = {
    date: "2026-01-02",
    timezone: "UTC",
    sources: { perplexity_api: { tokens: 140, calls: 1, fidelity: "exact", [PROVIDER_COST_FIELD]: syntheticCost } },
    total: 140,
    driver: "research",
    evidence: "synthetic fixture"
  };
  const errors = validateDataset([row]);
  assert.ok(errors.some((error) => error.includes(PROVIDER_COST_FIELD)), errors.join("\n"));
  const { [PROVIDER_COST_FIELD]: omitted, ...clean } = row.sources.perplexity_api;
  assert.ok(omitted);
  assert.ok(!validateDataset([{ ...row, sources: { perplexity_api: clean } }])
    .some((error) => error.includes(PROVIDER_COST_FIELD)));
});

test("import keeps the cost out of the dataset, its totals, and the ledger", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "provider-cost-import-"));
  await mkdir(join(cwd, "public", "data"), { recursive: true });
  await writeFile(join(cwd, "public", "data", "daily-burn.json"), "[]\n");
  const receipts = join(cwd, "receipts.jsonl");
  await writeFile(receipts, `${JSON.stringify({
    date: yesterday, timezone: TIMEZONE, source: "perplexity_api", tokens: 140, calls: 1,
    fidelity: "exact", provenance: "synthetic fixture", [PROVIDER_COST_FIELD]: syntheticCost
  })}\n`);
  execFileSync(process.execPath, [join(repo, "scripts", "import-daily-burn.js"), receipts], {
    cwd, encoding: "utf8"
  });
  const rows = JSON.parse(await readFile(join(cwd, "public", "data", "daily-burn.json"), "utf8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 140);
  assert.ok(!Object.hasOwn(rows[0].sources.perplexity_api, PROVIDER_COST_FIELD));
  for (const name of await readdir(join(cwd, "public", "data"))) {
    const text = await readFile(join(cwd, "public", "data", name), "utf8");
    assert.ok(!text.includes(PROVIDER_COST_FIELD), name);
    assert.ok(!text.includes("0.00700000"), name);
  }
});
