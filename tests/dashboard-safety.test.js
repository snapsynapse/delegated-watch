import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  escapeHtml,
  summarizeCalendarWindows,
  summarizeDashboardRows,
  weeklySeries
} from "../src/dashboard-model.js";

test("dashboard text escaping keeps injection-shaped evidence and labels literal", async () => {
  const payload = '<img src=x onerror="globalThis.pwned=1">&\'"';
  assert.equal(
    escapeHtml(payload),
    "&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt;&amp;&#39;&quot;"
  );

  const app = await readFile(resolve(import.meta.dirname, "../src/app.js"), "utf8");
  assert.match(app, /const text = \(value\) => escapeHtml\(value\)/);
  assert.match(app, /text\(row\.driver/);
  assert.match(app, /text\(row\.evidence\)/);
  assert.doesNotMatch(app, /innerHTML = `[^`]*\$\{error\.message\}/);
});

test("recent and prior metrics use complete calendar windows anchored to the displayed end", () => {
  const rows = [
    { date: "2026-01-14", total: 70 },
    { date: "2026-01-12", total: 35 },
    { date: "2026-01-06", total: 28 }
  ];
  const end = new Date("2026-01-14T12:00:00");
  const windows = summarizeCalendarWindows(rows, end);
  assert.deepEqual(windows.recent, {
    from: "2026-01-08", through: "2026-01-14",
    observedDays: 2, total: 105, complete: false, average: null
  });
  assert.deepEqual(windows.previous, {
    from: "2026-01-01", through: "2026-01-07",
    observedDays: 1, total: 28, complete: false, average: null
  });

  const summary = summarizeDashboardRows(rows, new Date("2026-01-01T12:00:00"), end);
  assert.equal(summary.recentAverage, null);
  assert.equal(summary.previousAverage, null);
  assert.equal(summary.deltaPercent, null);
});

test("weekly series retains calendar gaps and actual week dates", () => {
  const series = weeklySeries(
    [
      { date: "2026-01-05", total: 100 },
      { date: "2026-01-19", total: 200 }
    ],
    new Date("2026-01-05T12:00:00"),
    new Date("2026-01-25T12:00:00")
  );
  assert.deepEqual(series, [
    { date: "2026-01-05", total: 100 },
    { date: "2026-01-12", total: null },
    { date: "2026-01-19", total: 200 }
  ]);
});


test("assembled dashboard and records modules parse without concatenation collisions", async () => {
  const { spawnSync } = await import("node:child_process");
  const { renderStaticDashboard, renderStaticRecords } = await import("../scripts/lib/static-dashboard.js");
  const page = await renderStaticDashboard({
    dailyBurn: [], profile: { timezone: "UTC", windowStart: "2026-01-01" }
  });
  const records = await renderStaticRecords({ records: [], sourceColumns: [], publication: {
    canonicalUrl: "https://example.invalid/usage/", recordsTitle: "Synthetic", recordsDescription: "Synthetic"
  } });
  for (const html of [page, records]) {
    const script = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/)?.[1];
    assert.ok(script);
    const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  }
});

test("the trailing average resolves although the day in progress is never imported", () => {
  // The importer holds back the current day by design. A window ending today
  // would therefore always be one day short and the tile could never render a
  // number, which is what it did until 2026-09-22.
  const days = ["09-15", "09-16", "09-17", "09-18", "09-19", "09-20", "09-21"];
  const rows = days.map((day, index) => ({ date: `2026-${day}`, total: (index + 1) * 10 }));
  const today = new Date("2026-09-22T12:00:00");

  const endingToday = summarizeCalendarWindows(rows, today).recent;
  assert.equal(endingToday.observedDays, 6, "today has no row, so the window is short");
  assert.equal(endingToday.average, null);

  const summary = summarizeDashboardRows(rows, new Date("2026-09-01T12:00:00"), today);
  assert.equal(summary.recentWindow.through, "2026-09-21", "the window ends on the last elapsed day");
  assert.equal(summary.recentWindow.observedDays, 7);
  assert.equal(summary.recentAverage, 40, "seven measured days, mean of 10..70");
});
