import assert from "node:assert/strict";
import test from "node:test";

import {
  filterDashboardRows,
  filtersAreActive,
  sourceTotal,
  summarizeDashboardRows,
  summarizeDriverAttribution
} from "../src/dashboard-model.js";

const filters = (overrides = {}) => ({
  source: "all",
  fidelity: "all",
  origin: "all",
  ...overrides
});

const rows = [
  {
    date: "2026-01-01",
    driver: "shipping",
    sources: {
      codex: {
        tokens: 100,
        calls: 10,
        fidelity: "exact",
        by_origin: { "machine/a": 60, "machine/b": 40 }
      },
      claude_chat: {
        tokens: 50,
        fidelity: "estimated",
        by_origin: { "account/anthropic": 50 }
      }
    },
    total: 150
  },
  {
    date: "2026-01-02",
    driver: "review",
    sources: {
      codex: {
        tokens: 25,
        calls: 2,
        fidelity: "exact",
        by_origin: { "machine/a": 25 }
      }
    },
    total: 25
  }
];

test("dashboard filters source and fidelity without breaking totals", () => {
  assert.equal(filtersAreActive(filters()), false);
  assert.equal(filtersAreActive(filters({ source: "codex" })), true);

  const exact = filterDashboardRows(rows, filters({ fidelity: "exact" }));
  assert.deepEqual(exact.map((row) => row.total), [100, 25]);
  assert.ok(exact.every((row) => Object.keys(row.sources).length === 1));
  assert.ok(exact.every((row) => sourceTotal(row) === row.total));

  const estimated = filterDashboardRows(rows, filters({ fidelity: "estimated" }));
  assert.deepEqual(estimated.map((row) => row.total), [50]);
  assert.deepEqual(Object.keys(estimated[0].sources), ["claude_chat"]);
});

test("origin filtering removes unsplittable calls but keeps whole-source calls", () => {
  const machineA = filterDashboardRows(rows, filters({ origin: "machine/a" }));
  assert.deepEqual(machineA.map((row) => row.total), [60, 25]);
  assert.equal(machineA[0].sources.codex.calls, undefined);
  assert.equal(machineA[1].sources.codex.calls, 2);
  assert.deepEqual(machineA[0].sources.codex.by_origin, { "machine/a": 60 });

  const noMatch = filterDashboardRows(
    rows,
    filters({ source: "claude_chat", origin: "machine/a" })
  );
  assert.deepEqual(noMatch, []);
});

test("summary calculations preserve fidelity, peak, averages, and coverage", () => {
  const summary = summarizeDashboardRows(
    rows,
    new Date("2026-01-01T12:00:00Z"),
    new Date("2026-01-02T12:00:00Z")
  );
  assert.equal(summary.total, 175);
  assert.deepEqual(summary.split, { exact: 125, estimated: 50 });
  assert.equal(summary.peak.date, "2026-01-01");
  assert.equal(summary.recentAverage, null);
  // The trailing window ends on the last elapsed day, so the displayed end
  // date itself is outside it: only 2026-01-01 of these two rows counts.
  assert.equal(summary.recentWindow.through, "2026-01-01");
  assert.equal(summary.recentWindow.observedDays, 1);
  assert.equal(summary.previousAverage, null);
  assert.equal(summary.deltaPercent, null);
  assert.equal(summary.exactPercent, (125 / 175) * 100);
  assert.equal(summary.evidenceDays, 2);
  assert.equal(summary.elapsedDays, 2);
});

test("empty summaries distinguish no evidence from measured zero fidelity", () => {
  const summary = summarizeDashboardRows(
    [],
    new Date("2026-01-01T12:00:00Z"),
    new Date("2026-01-31T12:00:00Z")
  );
  assert.equal(summary.total, 0);
  assert.equal(summary.peak, null);
  assert.equal(summary.exactPercent, null);
  assert.equal(summary.evidenceDays, 0);
  assert.equal(summary.elapsedDays, 31);
});

test("driver attribution separates named, reviewed unknown, and unreviewed tokens", () => {
  const attribution = summarizeDriverAttribution([
    { total: 100, driver: "shipping" },
    { total: 25, driver: "unknown" },
    { total: 10, driver: "unreviewed" },
    { total: 5 }
  ]);
  assert.deepEqual(attribution, {
    total: 140,
    named: 100,
    unknown: 25,
    unreviewed: 15,
    groups: { shipping: 100 }
  });
});
