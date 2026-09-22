const DASHBOARD_MS_PER_DAY = 24 * 60 * 60 * 1000;

// Return the profile's calendar label for an instant, independent of the host zone.
export const dashboardCalendarDay = (timezone, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);

export const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const calendarIsoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const mondayFor = (date) => {
  const monday = new Date(date);
  const day = monday.getDay();
  monday.setDate(monday.getDate() + (day === 0 ? -6 : 1 - day));
  return monday;
};

const calendarWindow = (rows, end, offset) => {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const dates = Array.from({ length: 7 }, (_, index) => calendarIsoDay(addDays(end, -(offset + index))));
  const observed = dates.map((date) => byDate.get(date)).filter(Boolean);
  const total = observed.reduce((sum, row) => sum + Number(row.total || 0), 0);
  return {
    from: dates.at(-1),
    through: dates[0],
    observedDays: observed.length,
    total,
    complete: observed.length === 7,
    average: observed.length === 7 ? Math.round(total / 7) : null
  };
};

// The trailing average ends on the last day that has fully elapsed, never on
// the day in progress. The importer holds back the current day on purpose, so
// a window ending today is always one short and the average would never
// resolve: not a coverage gap, an arithmetic impossibility. Ending a day
// earlier makes it a true seven-day mean of seven measured days, at the cost
// of lagging by the same day the cutoff rule already costs everywhere else.
export const lastElapsedDay = (end) => addDays(end, -1);

// Recent summary windows are calendar windows ending at the displayed end date.
// A missing day is unknown evidence, so incomplete windows never imply zero use.
export const summarizeCalendarWindows = (rows, end) => ({
  recent: calendarWindow(rows, end, 0),
  previous: calendarWindow(rows, end, 7)
});

// Include every calendar week in the displayed range. Weeks without recovered
// rows are explicit gaps, allowing the renderer to leave the trend unbridged.
export const weeklySeries = (rows, start, end) => {
  const totals = new Map();
  for (const row of rows) {
    const monday = calendarIsoDay(mondayFor(new Date(`${row.date}T12:00:00`)));
    totals.set(monday, (totals.get(monday) || 0) + Number(row.total || 0));
  }
  const series = [];
  for (let cursor = mondayFor(start); cursor <= end; cursor = addDays(cursor, 7)) {
    const date = calendarIsoDay(cursor);
    series.push({ date, total: totals.has(date) ? totals.get(date) : null });
  }
  return series;
};

export const sourceTotal = (row) =>
  Object.values(row.sources || {}).reduce(
    (total, source) => total + Number(source.tokens || 0),
    0
  );

export const filtersAreActive = (filters) =>
  Object.values(filters).some((value) => value !== "all");

export const filterDashboardRows = (rows, filters) =>
  rows
    .map((row) => {
      const sources = Object.fromEntries(
        Object.entries(row.sources || {}).flatMap(([source, entry]) => {
          if (filters.source !== "all" && source !== filters.source) return [];
          if (filters.fidelity !== "all" && entry.fidelity !== filters.fidelity) return [];

          if (filters.origin === "all") return [[source, entry]];
          const tokens = entry.by_origin?.[filters.origin];
          if (!tokens) return [];

          const originTotal = Object.values(entry.by_origin).reduce(
            (total, value) => total + value,
            0
          );
          const filteredEntry = {
            ...entry,
            tokens,
            by_origin: { [filters.origin]: tokens }
          };

          // Calls are source-level. Keep them only when the selected origin
          // represents the entire source entry; dividing them would invent
          // request attribution that the daily schema does not retain.
          if (tokens !== originTotal) delete filteredEntry.calls;
          return [[source, filteredEntry]];
        })
      );
      return { ...row, sources, total: sourceTotal({ sources }) };
    })
    .filter((row) => row.total > 0);

export const summarizeDashboardRows = (rows, start, end) => {
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const split = rows.reduce(
    (totals, row) => {
      for (const entry of Object.values(row.sources || {})) {
        totals[entry.fidelity === "exact" ? "exact" : "estimated"] += Number(entry.tokens || 0);
      }
      return totals;
    },
    { exact: 0, estimated: 0 }
  );
  const peak = rows.length
    ? rows.reduce((best, row) => (row.total > best.total ? row : best), rows[0])
    : null;
  const windows = summarizeCalendarWindows(rows, lastElapsedDay(end));

  return {
    total,
    split,
    peak,
    recentAverage: windows.recent.average,
    previousAverage: windows.previous.average,
    recentWindow: windows.recent,
    previousWindow: windows.previous,
    deltaPercent: windows.recent.average !== null && windows.previous.average
      ? Math.round(((windows.recent.average - windows.previous.average) / windows.previous.average) * 100)
      : null,
    exactPercent: total ? (split.exact / total) * 100 : null,
    evidenceDays: rows.length,
    elapsedDays: Math.max(1, Math.round((end - start) / DASHBOARD_MS_PER_DAY) + 1)
  };
};

export const summarizeDriverAttribution = (rows) => {
  const groups = {};
  let unknown = 0;
  let unreviewed = 0;

  for (const row of rows) {
    const tokens = Number(row.total || 0);
    if (!row.driver || row.driver === "unreviewed") {
      unreviewed += tokens;
    } else if (row.driver === "unknown") {
      unknown += tokens;
    } else {
      groups[row.driver] = (groups[row.driver] || 0) + tokens;
    }
  }

  const named = Object.values(groups).reduce(
    (total, tokens) => total + tokens,
    0
  );
  return {
    total: named + unknown + unreviewed,
    named,
    unknown,
    unreviewed,
    groups
  };
};
