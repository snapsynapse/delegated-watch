import test from "node:test";
import assert from "node:assert/strict";
import { applySourceEntryExclusions } from "../scripts/lib/source-entry-exclusions.js";

const row = (tokens = 100, calls = 2) => ({
  date: "2026-01-01",
  timezone: "UTC",
  sources: {
    codex: { tokens, calls, fidelity: "exact" },
    chatgpt: { tokens: 25, calls: 1, fidelity: "estimated" }
  },
  total: tokens + 25,
  driver: "unreviewed",
  evidence: "test"
});

const exclusion = {
  date: "2026-01-01",
  source: "codex",
  tokens: 100,
  calls: 2
};

test("exact source-entry exclusions remove only the matching source", () => {
  const result = applySourceEntryExclusions([row()], [exclusion]);
  assert.deepEqual(result.removed, ["2026-01-01/codex"]);
  assert.equal(result.rows[0].total, 25);
  assert.deepEqual(Object.keys(result.rows[0].sources), ["chatgpt"]);
});

test("source-entry exclusions fail closed when counters differ", () => {
  assert.throws(
    () => applySourceEntryExclusions([row(101, 2)], [exclusion]),
    /exclusion mismatch/
  );
});

test("source-scoped imports do not alter excluded entries from other sources", () => {
  const result = applySourceEntryExclusions(
    [row()],
    [exclusion],
    new Set(["chatgpt"])
  );
  assert.equal(result.rows[0].total, 125);
  assert.deepEqual(result.removed, []);
});
