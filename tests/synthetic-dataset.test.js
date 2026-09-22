import assert from "node:assert/strict";
import test from "node:test";

import { generateDataset, DATE_RANGE, EVIDENCE_PREFIX, RESERVED_ORIGINS } from "../scripts/synthetic-dataset.js";
import { validateDataset } from "../scripts/lib/dataset-validation.js";

test("generation is deterministic across calls", () => {
  const first = generateDataset();
  const second = generateDataset();
  assert.deepEqual(first, second);
});

test("passes strict validation: requireReviewed, no sample fidelity", () => {
  const rows = generateDataset();
  const errors = validateDataset(rows, {
    timezone: "UTC",
    windowStart: DATE_RANGE.start,
    today: "2026-01-01",
    requireReviewed: true,
    allowSample: false
  });
  assert.deepEqual(errors, []);
});

test("row count is within the public-candidate bounds (150-300)", () => {
  const rows = generateDataset();
  assert.ok(rows.length >= 150, `expected at least 150 rows, got ${rows.length}`);
  assert.ok(rows.length <= 300, `expected at most 300 rows, got ${rows.length}`);
});

test("every date falls within the configured 2025 range", () => {
  const rows = generateDataset();
  for (const row of rows) {
    assert.ok(row.date >= DATE_RANGE.start, `${row.date} precedes ${DATE_RANGE.start}`);
    assert.ok(row.date <= DATE_RANGE.end, `${row.date} follows ${DATE_RANGE.end}`);
  }
});

test("every evidence string begins with the synthetic prefix", () => {
  const rows = generateDataset();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(
      typeof row.evidence === "string" && row.evidence.startsWith(EVIDENCE_PREFIX),
      `${row.date} evidence "${row.evidence}" does not start with "${EVIDENCE_PREFIX}"`
    );
  }
});

test("every origin is a reserved identity", () => {
  const rows = generateDataset();
  let sawOrigin = false;
  for (const row of rows) {
    for (const entry of Object.values(row.sources)) {
      for (const origin of Object.keys(entry.by_origin ?? {})) {
        sawOrigin = true;
        assert.ok(
          RESERVED_ORIGINS.includes(origin),
          `origin "${origin}" on ${row.date} is not in the reserved-identities list`
        );
      }
    }
  }
  assert.ok(sawOrigin, "expected at least one by_origin split to inspect");
});

test("no row uses fidelity sample", () => {
  const rows = generateDataset();
  for (const row of rows) {
    for (const entry of Object.values(row.sources)) {
      assert.notEqual(entry.fidelity, "sample");
    }
  }
});

test("at least one whole weekday is absent (unknown is never zero)", () => {
  const rows = generateDataset();
  const present = new Set(rows.map((row) => row.date));
  let sawAbsentWeekday = false;
  let cursor = new Date(`${DATE_RANGE.start}T00:00:00Z`);
  const end = new Date(`${DATE_RANGE.end}T00:00:00Z`);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    if (!present.has(iso) && day >= 1 && day <= 5) {
      sawAbsentWeekday = true;
      break;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  assert.ok(sawAbsentWeekday, "expected at least one absent weekday in the generated range");
  // And the flip side: no row has a zero total, which validateDataset already
  // enforces, but is worth asserting directly against the invariant it exists
  // to protect ("unknown is never zero").
  for (const row of rows) assert.ok(row.total > 0);
});

test("drivers include both mixed and unknown at least once", () => {
  const rows = generateDataset();
  const drivers = new Set(rows.map((row) => row.driver));
  assert.ok(drivers.has("mixed"), "expected at least one row with driver mixed");
  assert.ok(drivers.has("unknown"), "expected at least one row with driver unknown");
});

test("rows are sorted by date, ascending, with no duplicates", () => {
  const rows = generateDataset();
  const dates = rows.map((row) => row.date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted);
  assert.equal(new Set(dates).size, dates.length);
});

test("row totals cross-foot against their own source tokens", () => {
  const rows = generateDataset();
  for (const row of rows) {
    const sum = Object.values(row.sources).reduce((total, entry) => total + entry.tokens, 0);
    assert.equal(row.total, sum, `${row.date} total does not cross-foot`);
  }
});

test("by_origin splits sum exactly to the source's tokens", () => {
  const rows = generateDataset();
  for (const row of rows) {
    for (const [source, entry] of Object.entries(row.sources)) {
      if (!entry.by_origin) continue;
      const sum = Object.values(entry.by_origin).reduce((total, tokens) => total + tokens, 0);
      assert.equal(sum, entry.tokens, `${row.date}/${source} by_origin does not sum to tokens`);
    }
  }
});

test("exact sources carry calls; estimated sources do not", () => {
  const rows = generateDataset();
  let sawExactWithCalls = false;
  for (const row of rows) {
    for (const entry of Object.values(row.sources)) {
      if (entry.fidelity === "exact") {
        if (Object.hasOwn(entry, "calls")) sawExactWithCalls = true;
      } else {
        assert.ok(!Object.hasOwn(entry, "calls"), `${row.date} estimated entry unexpectedly has calls`);
      }
    }
  }
  assert.ok(sawExactWithCalls, "expected at least one exact source entry with calls");
});
