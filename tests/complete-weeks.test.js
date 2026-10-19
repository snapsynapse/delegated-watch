import test from "node:test";
import assert from "node:assert/strict";
import { partitionCompleteReceipts, weekStartOf } from "../scripts/lib/import-policy.js";

test("weekStartOf returns the Sunday that opens a Sunday-to-Saturday week", () => {
  assert.equal(weekStartOf("2026-01-04"), "2026-01-04");
  assert.equal(weekStartOf("2026-01-07"), "2026-01-04");
  assert.equal(weekStartOf("2026-01-10"), "2026-01-04");
  assert.equal(weekStartOf("2026-01-11"), "2026-01-11");
});

test("completeWeeks holds back the whole week in progress", () => {
  const receipts = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-06"].map((date) => ({ date }));
  const now = new Date("2026-01-07T12:00:00Z");
  const daily = partitionCompleteReceipts(receipts, "UTC", "2025-01-01", now);
  assert.deepEqual(daily.receipts.map((r) => r.date), ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-06"]);
  const weekly = partitionCompleteReceipts(receipts, "UTC", "2025-01-01", now, { completeWeeks: true });
  assert.equal(weekly.cutoff, "2026-01-04");
  assert.deepEqual(weekly.receipts.map((r) => r.date), ["2026-01-02", "2026-01-03"]);
  assert.deepEqual(weekly.heldBack.map((r) => r.date), ["2026-01-04", "2026-01-06"]);
});
