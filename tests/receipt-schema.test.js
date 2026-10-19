// The receipt schema is the last check every extractor runs before it writes.
// A headline counter coerced by string concatenation, a fraction, or a sign
// error must be refused there, for every schema version, not first noticed by
// the importer.

import assert from "node:assert/strict";
import test from "node:test";
import { validateReceiptSchema } from "../scripts/lib/receipt-schema.js";

const v2 = (overrides = {}) => ({
  schema_version: 2,
  date: "2026-01-02",
  timezone: "UTC",
  source: "codex",
  provider: "openai",
  surface: "codex",
  account_alias: "primary",
  origin: "machine/synthetic",
  snapshot_key: "codex:primary:synthetic:2026-01-02",
  authority: "tool",
  interval: { start: "2026-01-02", end: "2026-01-02" },
  fidelity: "exact",
  tokens: 10,
  calls: 1,
  ...overrides
});

const unversioned = (overrides = {}) => {
  const receipt = v2(overrides);
  delete receipt.schema_version;
  return receipt;
};

test("a well-formed receipt, including a measured zero, has no errors", () => {
  assert.deepEqual(validateReceiptSchema(v2()), []);
  assert.deepEqual(validateReceiptSchema(v2({ tokens: 0, calls: 1 })), []);
  assert.deepEqual(validateReceiptSchema(unversioned()), []);
});

for (const [name, value] of [
  ["concatenated string", "0100abc"],
  ["numeric string", "10"],
  ["fraction", 6.5],
  ["negative", -1],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["NaN", Number.NaN],
  ["missing", undefined]
]) {
  for (const [shape, make] of [["v2", v2], ["unversioned", unversioned]]) {
    test(`${shape} receipt with ${name} tokens is refused`, () => {
      const receipt = make({ tokens: value });
      if (value === undefined) delete receipt.tokens;
      assert.ok(validateReceiptSchema(receipt).some((error) => /tokens must be a nonnegative integer/.test(error)));
    });
    if (value === undefined) continue;
    test(`${shape} receipt with ${name} calls is refused`, () => {
      assert.ok(validateReceiptSchema(make({ calls: value })).some((error) => /calls must be a nonnegative integer/.test(error)));
    });
  }
}

test("calls stay optional", () => {
  const receipt = v2();
  delete receipt.calls;
  assert.deepEqual(validateReceiptSchema(receipt), []);
});
