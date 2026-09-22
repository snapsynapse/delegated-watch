import {
  filterDashboardRows,
  filtersAreActive,
  sourceTotal,
  summarizeDashboardRows,
  summarizeDriverAttribution,
  summarizeCalendarWindows,
  escapeHtml,
  weeklySeries,
  dashboardCalendarDay
} from "./dashboard-model.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const state = {
  // A site may open on "all" instead of the trailing year, which a demo whose
  // synthetic rows sit in a fixed past year needs to be seen at all.
  range: ["365", "all"].includes(window.__SITE__?.default_range) ? window.__SITE__.default_range : "365",
  rows: [],
  filters: {
    source: "all",
    fidelity: "all",
    origin: "all"
  }
};

const publicationFeature = (feature) =>
  window.__PUBLICATION__?.features?.[feature] !== false;

const applyPublicationView = () => {
  const publication = window.__PUBLICATION__;
  if (!publication) return;
  document.documentElement.dataset.publication = publication.mode;
  document.querySelectorAll("[data-publication-feature]").forEach((element) => {
    const feature = element.dataset.publicationFeature;
    const enabled = publicationFeature(feature);
    element.hidden = !enabled;
    if (enabled && element.dataset.href) element.href = element.dataset.href;
  });
  const recordsPanel = document.querySelector("#recordsPanel");
  if (recordsPanel) {
    recordsPanel.hidden = !publicationFeature("records") && !publicationFeature("recordsTable");
  }
  document.querySelectorAll(".dashboard-grid > article:not([hidden]) .eyebrow")
    .forEach((label, index) => {
      label.textContent = String(index + 1).padStart(2, "0");
    });
  const scope = document.querySelector("#publicationScope");
  document.querySelector("#publicationScopeText").textContent = publication.scopeNote;
  scope.hidden = false;
  document.querySelector("#pipelineTitle").textContent = "Data freshness";
  document.querySelector("#receiptTitle").textContent = "Recent daily records";
  document.querySelector("#receiptScope").textContent = "last 30 active days";
  const coverageTitle = document.querySelector("#coverageTitle");
  if (coverageTitle) coverageTitle.textContent = "Coverage timeline";
  const githubCta = document.querySelector("#githubCta");
  if (publicationFeature("github")) {
    githubCta.href = publication.githubProfileUrl;
    githubCta.hidden = false;
  }
  const resumeCta = document.querySelector("#resumeCta");
  if (publicationFeature("resume")) {
    resumeCta.href = publication.resumeUrl;
    resumeCta.hidden = false;
  }
  const recordsLink = document.querySelector("#publicationRecordsLink");
  if (publicationFeature("records")) {
    recordsLink.href = recordsLink.dataset.href;
    recordsLink.hidden = false;
  }
};

// Theme: explicit choice wins and persists. The private dashboard keeps its
// dark default; the personal-public rendering opens light for a first visit.
const THEME_KEY = "delegated-watch-theme";
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  const toggle = document.querySelector("#themeToggle");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(!dark));
  document.querySelector("#themeIcon").textContent = dark ? "\u263e" : "\u2600";
  document.querySelector("#themeLabel").textContent = dark ? "Dark" : "Light";
};
const initTheme = () => {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored ?? (window.__PUBLICATION__ ? "light" : "dark"));
};

const sourceLabels = {
  chatgpt: "ChatGPT",
  claude_api: "Claude API",
  claude_chat: "Claude Chat",
  claude_code: "Claude Code",
  claude_cowork: "Claude Cowork",
  claude_design: "Claude Design",
  codex: "Codex",
  deepseek_local: "DeepSeek local",
  gemini: "Gemini",
  gpt_oss: "GPT-OSS",
  grok: "Grok",
  llama_local: "Llama local",
  kilo: "Kilo Code",
  gemma_local: "Gemma local",
  openai_api: "OpenAI API",
  local_deepseek: "DeepSeek local",
  local_gemma: "Gemma local",
  local_llama: "Llama local",
  perplexity: "Perplexity",
  perplexity_api: "Perplexity API",
  perplexity_chat: "Perplexity Chat",
  qwen_local: "Qwen local",
  snapdev: "Snapdev",
  typesafe_api: "TypeSafe API",
  local_qwen: "Qwen local"
};

const formatTokens = (value) => {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return "unavailable";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
};
const formatAxisTokens = (value) => formatTokens(value).replace(".0M", "M");

const formatDate = (date) => new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric"
}).format(new Date(`${date}T12:00:00`));

const parseLocalDate = (date) => new Date(`${date}T12:00:00`);

const sum = (rows, key = "total") => rows.reduce((acc, row) => acc + Number(row[key] || 0), 0);

const labelSource = (source) => sourceLabels[source] || source
  .split("_")
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

const text = (value) => escapeHtml(value);
const labelSourceHtml = (source) => text(labelSource(source));
const fidelityClass = (value) => ["exact", "estimated", "sample"].includes(value)
  ? value
  : "estimated";

const normalizeLegacyRow = (row) => {
  if (row.sources) return row;
  return {
    date: row.date,
    timezone: "America/Denver",
    sources: {
      codex: { tokens: row.codex_tokens || 0, fidelity: "exact" },
      claude_code: { tokens: row.claude_code_tokens || 0, calls: row.claude_code_calls || 0, fidelity: "exact" },
      claude_chat: { tokens: row.claude_chat_est || 0, fidelity: "estimated" },
      chatgpt: { tokens: row.chatgpt_est || 0, fidelity: "estimated" }
    },
    total: row.total,
    driver: row.driver,
    evidence: row.evidence
  };
};

const allSources = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row.sources || {})))]
  .sort((a, b) => labelSource(a).localeCompare(labelSource(b)));

const movingAverage = (rows, endDate) =>
  summarizeCalendarWindows(rows, parseLocalDate(endDate)).recent;

const today = () => parseLocalDate(dashboardCalendarDay(window.__PROFILE__?.timezone || "UTC"));

const configuredDayBoundaryCopy = (timezone) =>
  `Days are grouped by the configured ${timezone || "UTC"} day boundary. ` +
  "Provider reports can use different boundaries, so this dashboard does not infer when work belongs to another day.";

// Fixed ranges roll back from today rather than from the last row that has
// data, so a stalled extractor shows up as trailing gaps instead of silently
// shortening the window.
const getVisibleWindow = () => {
  const sorted = [...state.rows].sort((a, b) => a.date.localeCompare(b.date));
  if (state.range === "all") {
    // "all" means the whole recovery window, not the span that happens to hold
    // data. The earliest recovered day is 2025-05-02 and the window opens
    // 2022-11-30; showing only the former would present 2.4 unexamined years as
    // though they did not exist. They render as "no data recovered" -- unknown,
    // which is the finding.
    const opened = window.__PROFILE__?.windowStart;
    const earliest = sorted[0]?.date;
    const first = opened && (!earliest || opened < earliest)
      ? opened : earliest || isoDay(today());
    return { rows: sorted, start: parseLocalDate(first), end: today() };
  }
  const end = today();
  const start = new Date(end);
  start.setDate(start.getDate() - (Number(state.range) - 1));
  const rows = sorted.filter((row) => {
    const date = parseLocalDate(row.date);
    return date >= start && date <= end;
  });
  return { rows, start, end };
};

const filtersActive = () => filtersAreActive(state.filters);

// Quartile thresholds over the visible days that carry data. This is the
// convention the contribution calendar actually uses, and the log scale that
// stood here was the invention: anchored to the quietest day in the window, it
// spread 4.9 decades across four shades and put 225 of 287 days in the top two.
// The calendar read as nearly one colour. Quartiles give four equally populated
// bands by construction, so a shade means "which quarter of your days was this"
// -- a claim a reader can act on without knowing the range.
const quartileCuts = (values) => {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { q1: at(0.25), q2: at(0.5), q3: at(0.75), max: sorted.at(-1), min: sorted[0] };
};

// Band edges for the tooltip, so a cell can say why it is the shade it is.
const intensityBands = (cuts) => {
  if (!cuts) return null;
  return [
    { level: 1, from: cuts.min, to: cuts.q1 },
    { level: 2, from: cuts.q1 + 1, to: cuts.q2 },
    { level: 3, from: cuts.q2 + 1, to: cuts.q3 },
    { level: 4, from: cuts.q3 + 1, to: cuts.max }
  ];
};

const getIntensity = (value, cuts) => {
  if (!value || !cuts) return 0;
  if (value <= cuts.q1) return 1;
  if (value <= cuts.q2) return 2;
  if (value <= cuts.q3) return 3;
  return 4;
};

const renderSummary = (rows, start, end) => {
  const {
    total,
    split,
    peak,
    recentAverage,
    previousAverage,
    recentWindow,
    previousWindow,
    deltaPercent,
    exactPercent,
    evidenceDays,
    elapsedDays
  } = summarizeDashboardRows(rows, start, end);

  document.querySelector("#totalTokens").textContent = `${formatTokens(total)} tokens`;
  // The headline mixes exact counters with chars/4 arithmetic over an export.
  // Splitting it is what makes the number readable as a floor: the exact part is
  // measured, the estimated part is a lower bound on work that reports no
  // counters at all.
  document.querySelector("#totalSplit").innerHTML = split.estimated
    ? `${formatTokens(split.exact)} exact · <b>${formatTokens(split.estimated)} estimated</b>`
    : `${formatTokens(split.exact)} exact`;
  document.querySelector("#peakDay").textContent = peak ? `${formatTokens(peak.total)} ${formatDate(peak.date)}` : "No match";
  // "unreviewed spike" reads as a kind of spike rather than an unlabelled one.
  document.querySelector("#peakDriver").textContent = !peak
    ? "adjust the filters"
    : !peak.driver || peak.driver === "unreviewed"
      ? "driver not yet reviewed"
      : `${peak.driver} spike`;
  document.querySelector("#avgSeven").textContent = recentAverage === null
    ? "Unavailable"
    : `${formatTokens(recentAverage)}`;
  // The window is named, not implied. It ends on the last elapsed day rather
  // than today, so a reader comparing the tile against the heatmap's final
  // cell can see which seven days the mean covers.
  const windowLabel = `${formatDate(recentWindow.from)}\u2013${formatDate(recentWindow.through)}`;
  document.querySelector("#avgDelta").textContent = recentAverage === null || previousAverage === null
    ? `${windowLabel}: recent ${recentWindow.observedDays}/7 and prior ${previousWindow.observedDays}/7 days observed; incomplete coverage`
    : previousAverage
    ? `${windowLabel} \u00b7 ${deltaPercent > 0 ? "+" : ""}${deltaPercent}% vs prior 7d`
    : `${windowLabel} \u00b7 prior window has no measured tokens`;
  if (exactPercent !== null) {
    const exactLabel = Number.isInteger(exactPercent) ? exactPercent.toFixed(0) : exactPercent.toFixed(1);
    document.querySelector("#exactShare").textContent = `${exactLabel}% exact`;
  } else {
    document.querySelector("#exactShare").textContent = "No evidence";
  }
  document.querySelector("#coverageDays").textContent = `${evidenceDays} / ${elapsedDays} days with evidence`;
};

const renderGithubSummary = (summary) => {
  document.querySelector("#githubContributions").textContent = Number(summary.contributions || 0).toLocaleString();
  document.querySelector("#githubWindow").textContent = `${summary.username}, ${summary.window.replace("_", " ")}`;
  const ctaStats = document.querySelector("#githubCtaStats");
  if (ctaStats) {
    ctaStats.textContent =
      `${Number(summary.contributions || 0).toLocaleString()} contributions in the year ending ${summary.as_of}`;
  }
};

const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Calendar grid in GitHub's shape: one column per week, seven weekday rows,
// Sunday at the top. Every date in the span gets a cell, so days with no
// recovered data stay visible as gaps instead of being silently skipped.
const buildCalendar = (rows, first, last) => {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const start = new Date(first.getTime() - first.getDay() * MS_PER_DAY);
  const end = new Date(last.getTime() + (6 - last.getDay()) * MS_PER_DAY);

  // Step by calendar day and compare by date string. Adding 86,400,000ms from a
  // noon anchor drifts an hour at each DST boundary, so over a multi-year span
  // the cursor ends up an hour past the anchor and the final day tests as out of
  // range -- which is how today's cell went missing once "all" widened to cover
  // the whole recovery window.
  const firstIso = isoDay(first);
  const lastIso = isoDay(last);
  const weeks = [];
  const cursor = new Date(start);
  const endIso = isoDay(end);
  for (let date = isoDay(cursor); date <= endIso; date = isoDay(cursor)) {
    if (cursor.getDay() === 0) weeks.push([]);
    weeks.at(-1).push({
      date,
      inRange: date >= firstIso && date <= lastIso,
      row: byDate.get(date) || null
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return weeks;
};

const renderHeatmap = (rows, first, last) => {
  const heatmap = document.querySelector("#heatmap");
  if (!rows.length) {
    heatmap.innerHTML = "";
    return;
  }
  const totals = rows.map((row) => row.total).filter((total) => total > 0);
  const max = Math.max(...totals, 1);
  const min = Math.min(...totals, max);
  const weeks = buildCalendar(rows, first, last);

  // A month label sits above the first week that starts a new month. Labels
  // closer than two columns would overlap, so keep the later one; a partial
  // month in column zero yields to the full month that follows it.
  const starts = weeks.reduce((acc, week, index) => {
    const month = parseLocalDate(week[0].date).getMonth();
    const previous = index === 0 ? null : parseLocalDate(weeks[index - 1][0].date).getMonth();
    if (month !== previous) acc.push({ index, month });
    return acc;
  }, []);
  const kept = starts.filter((start, index) => {
    const next = starts[index + 1];
    if (start.index === 0 && next && next.index <= 2) return false;
    const previousKept = starts.slice(0, index).filter((other) => other.keep !== false).at(-1);
    const spaced = !previousKept || start.index - previousKept.index >= 2;
    start.keep = spaced;
    return spaced;
  });
  const months = weeks.map((week, index) => {
    const label = kept.find((start) => start.index === index);
    return label ? MONTH_NAMES[label.month] : "";
  });

  // Cells are sized to fill the card rather than to a fixed guess, so the
  // calendar spans the panel at any range. The fallback matters: the element is
  // measured, and on first paint or in a hidden tab it measures zero, where a
  // computed size of zero would render an invisible grid rather than a small
  // one. Bounded at both ends -- below about 7px a cell stops being readable,
  // above about 30px a short range turns into wall art -- and the container
  // keeps overflow-x, so "all" scrolls once the floor is hit.
  const HEAT_GAP = 3;
  const HEAT_LABEL = 34;
  const measured = heatmap.clientWidth || 0;
  const available = Math.max(measured - HEAT_LABEL, 0);
  const fitted = available
    ? Math.floor(available / weeks.length) - HEAT_GAP
    : 13;
  const cellSize = Math.max(7, Math.min(30, fitted || 13));

  const cuts = quartileCuts(rows.map((row) => row.total));
  const bands = intensityBands(cuts);
  const missingLabel = filtersActive() ? "no matching evidence" : "no data recovered";
  const missingWhy = filtersActive()
    ? "No evidence on this day matches the active source, fidelity, and origin filters."
    : "Absent from the dataset; unknown, not a measured zero.";
  document.querySelector("#missingLegendLabel").textContent = missingLabel;
  const cell = ({ date, inRange, row }) => {
    if (!inRange) return `<div class="heat-cell heat-blank" aria-hidden="true"></div>`;
    if (!row) {
      return `<div class="heat-cell heat-missing" role="listitem" data-date="${text(date)}" aria-label="${text(date)}, ${text(missingLabel)}"></div>`;
    }
    const intensity = getIntensity(row.total, cuts);
    return `<div class="heat-cell i${intensity}" role="listitem" data-date="${text(date)}" aria-label="${text(date)}, ${Number(row.total || 0)} tokens, ${text(row.driver || "driver not reviewed")}"></div>`;
  };

  // Explaining the colour is the point: a shade is meaningless without the
  // quartile scale that produced it.
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const tipFor = (date) => {
    const row = byDate.get(date);
    const heading = `<strong>${text(date)}</strong>`;
    if (!row) {
      return `${heading}<span class="tip-none">${missingLabel}</span>
        <span class="tip-why">${missingWhy}</span>`;
    }
    const level = getIntensity(row.total, cuts);
    const band = bands?.find((entry) => entry.level === level);
    const sources = Object.entries(row.sources)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([source, entry]) => `<span class="tip-src"><i class="i${level > 0 ? level : 1}"></i>${labelSourceHtml(source)}<b>${formatTokens(entry.tokens)}</b></span>`)
      .join("");
    const why = band
      ? `Level ${level} of 4 — the quietest to busiest quarter of days in this window; ${formatTokens(band.from)}–${formatTokens(band.to)} lands here.`
      : `Level ${level} of 4.`;
    return `${heading}
      <span class="tip-total">${Number(row.total || 0).toLocaleString()} tokens</span>
      <span class="tip-driver">${text(row.driver || "driver not reviewed")}</span>
      ${sources}
      <span class="tip-why">${why}</span>`;
  };

  const tip = document.querySelector("#heatTip");
  const show = (event) => {
    const target = event.target.closest(".heat-cell[data-date]");
    if (!target) return;
    tip.innerHTML = tipFor(target.dataset.date);
    tip.setAttribute("aria-hidden", "false");
    const box = target.getBoundingClientRect();
    tip.style.visibility = "hidden";
    tip.classList.add("visible");
    const width = tip.offsetWidth;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${box.top + window.scrollY - tip.offsetHeight - 10}px`;
    tip.style.visibility = "visible";
  };
  const hide = () => {
    tip.classList.remove("visible");
    tip.setAttribute("aria-hidden", "true");
  };
  heatmap.addEventListener("pointerover", show);
  heatmap.addEventListener("pointerout", hide);
  heatmap.addEventListener("focusin", show);
  heatmap.addEventListener("focusout", hide);

  // Naming the cut points turns the legend from a gradient into a readable
  // scale: a reader can place their own day without hovering a cell.
  const scaleNote = document.querySelector("#heatScale");
  if (scaleNote) {
    scaleNote.textContent = cuts
      ? `quartiles · ${formatTokens(cuts.q1)} / ${formatTokens(cuts.q2)} / ${formatTokens(cuts.q3)}`
      : "quartile color scale";
  }

  // Two things a reader cannot infer from the grid: the configured day boundary
  // and that the window opens earlier than the data does. Both are load-bearing:
  // the first makes the dashboard grouping explicit without assuming every
  // provider uses it, and the second distinguishes "nothing happened" from
  // "nothing was recovered".
  const note = document.querySelector("#heatNote");
  if (note) {
    const zone = window.__PROFILE__?.timezone ?? rows[0]?.timezone ?? "UTC";
    const opened = window.__PROFILE__?.windowStart;
    // The earliest evidence is a fact about the dataset, not about the visible
    // window. Reading it off `rows` made the 1y view claim the record began
    // 2025-07-31, which is only where that window starts.
    const earliest = [...state.rows].sort((a, b) => a.date.localeCompare(b.date))[0]?.date;
    const gap =
      opened && earliest && opened < earliest
        ? ` The recovery window opens ${opened}; the earliest day with any evidence is ${earliest}, so everything before it is unknown rather than zero.`
        : "";
    note.textContent = `${configuredDayBoundaryCopy(zone)}${gap}`;
  }

  state.lastHeatmapArgs = [rows, first, last];
  bindHeatmapResize(rows, first, last);
  heatmap.style.setProperty("--heat-cell", `${cellSize}px`);
  heatmap.innerHTML = `
    <div class="heat-months" aria-hidden="true" style="grid-template-columns: repeat(${weeks.length}, var(--heat-cell))">
      ${months.map((month) => `<span>${month}</span>`).join("")}
    </div>
    <div class="heat-weekdays" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
    <div class="heat-grid" role="list" aria-label="Daily token burn calendar" style="grid-template-columns: repeat(${weeks.length}, var(--heat-cell))">
      ${weeks.map((week) => week.map(cell).join("")).join("")}
    </div>`;
};

// The calendar is sized from a measurement, so it has to be re-measured when the
// measurement changes. Without this a window resize leaves the grid at the width
// it was built for.
let heatmapResizeBound = false;
const bindHeatmapResize = (rows, first, last) => {
  if (heatmapResizeBound) return;
  heatmapResizeBound = true;
  let frame = null;
  window.addEventListener("resize", () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderHeatmap(...(state.lastHeatmapArgs ?? [rows, first, last])));
  });
};

let trendResizeBound = false;
const bindTrendResize = () => {
  if (trendResizeBound) return;
  trendResizeBound = true;
  let frame = null;
  window.addEventListener("resize", () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderTrend(...(state.lastTrendArgs ?? [])));
  });
};

const renderTrend = (rows, start, end) => {
  const svg = document.querySelector("#trendChart");
  state.lastTrendArgs = [rows, start, end];
  bindTrendResize();
  const weeks = weeklySeries(rows, start, end);
  // The viewBox follows the card width, with a small mobile floor. This keeps
  // the 300px plotting height useful on desktop and avoids the letterboxed
  // empty space caused by forcing a wide desktop viewBox into a narrow screen.
  const width = Math.max(360, Math.round(svg.clientWidth || 860));
  const height = 300;
  // Room on the left for token labels and below for dates. The axes carry
  // values now, so the old uniform padding would have clipped both.
  const padLeft = 62;
  const padRight = 24;
  const padTop = 34;
  const padBottom = 44;
  // Fixed public scale: 100 tokens through 100M tokens. A previous zero-based
  // logarithmic transform spent three eighths of the plot below the first
  // labelled 1K line, leaving the data compressed toward the top. Mapping the
  // labelled log domain itself uses the card height honestly and keeps 100M as
  // the stable ceiling across filters and ranges.
  const minLog = 2;
  const maxLog = 8;
  const plotHeight = height - padTop - padBottom;
  const x = (index) =>
    weeks.length === 1
      ? (padLeft + width - padRight) / 2
      : padLeft + index * ((width - padLeft - padRight) / (weeks.length - 1));
  const y = (total) => {
    const log = Math.min(maxLog, Math.max(minLog, Math.log10(total || 1)));
    return padTop + ((maxLog - log) / (maxLog - minLog)) * plotHeight;
  };
  const observedWeeks = weeks.filter((week) => week.total !== null);
  const segments = [];
  let segment = [];
  weeks.forEach((week, index) => {
    if (week.total === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ week, index });
  });
  if (segment.length) segments.push(segment);
  const peak = observedWeeks.reduce((best, week) => week.total > best.total ? week : best, observedWeeks[0]);
  const peakIndex = weeks.indexOf(peak);
  document.querySelector("#peakWeekLabel").textContent = peak
    ? `peak week ${formatDate(peak.date)}`
    : "no recovered weeks";

  // The y axis is log, so evenly spaced ticks would be misread as a linear
  // scale. Ticks are placed at powers of ten and labelled with the value they
  // actually represent, which is the only honest way to show a log axis to a
  // reader who did not choose it.
  const decades = Array.from(
    { length: maxLog - minLog + 1 },
    (_, index) => 10 ** (minLog + index)
  );
  const yTicks = decades
    .map(
      (value) => `
      <line x1="${padLeft}" y1="${y(value)}" x2="${width - padRight}" y2="${y(value)}" class="grid-line"></line>
      <text x="${padLeft - 8}" y="${y(value) + 4}" class="axis-label axis-label-y">${formatAxisTokens(value)}</text>`
    )
    .join("");

  // At most six date labels, evenly spaced, always including the first and last
  // week. More than that and they collide at any range wider than a quarter.
  const labelCount = Math.min(6, weeks.length);
  const step = labelCount > 1 ? (weeks.length - 1) / (labelCount - 1) : 1;
  const xTicks = Array.from({ length: labelCount }, (_, slot) => Math.round(slot * step))
    .filter((index, slot, all) => all.indexOf(index) === slot)
    .map(
      (index) => `
      <text x="${x(index)}" y="${height - padBottom + 18}" class="axis-label axis-label-x">${formatDate(weeks[index].date)}</text>`
    )
    .join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    ${yTicks}
    <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" class="axis"></line>
    <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" class="axis"></line>
    ${segments.map((part) => `<polyline points="${part.map(({ week, index }) => `${x(index)},${y(week.total)}`).join(" ")}" class="trend-line"></polyline>`).join("")}
    ${observedWeeks.map((week) => {
      const index = weeks.indexOf(week);
      return `<circle cx="${x(index)}" cy="${y(week.total)}" r="${week === peak ? 5 : 3}" class="${week === peak ? "peak-dot" : "trend-dot"}"><title>${text(week.date)}: ${formatTokens(week.total)} tokens</title></circle>`;
    }).join("")}
    ${xTicks}
    ${peak ? `<text x="${Math.min(width - padRight - 130, x(peakIndex) + 10)}" y="${Math.max(padTop - 6, y(peak.total) - 10)}" class="peak-label">Peak ${formatTokens(peak.total)}</text>` : ""}
    <text x="${padLeft - 8}" y="${padTop - 18}" class="axis-title">tokens/week · logarithmic</text>
    <text x="${width - padRight}" y="${height - 6}" class="axis-title axis-title-x">week beginning</text>
  `;
};

const renderDrivers = (rows) => {
  const drivers = document.querySelector("#drivers");
  const donut = document.querySelector("#driverDonut");
  const attribution = summarizeDriverAttribution(rows);
  if (!attribution.named && !attribution.unknown) {
    donut.innerHTML = "";
    drivers.innerHTML =
      `<p class="driver-empty">No day has been reviewed yet, so there is no driver mix to show. ` +
      `${rows.length} days carry usage and await a label.</p>`;
    return;
  }
  const ranked = Object.entries(attribution.groups).sort((a, b) => b[1] - a[1]);
  const donutEntries = ranked.slice(0, 5);
  const otherNamed = ranked.slice(5).reduce((total, [, value]) => total + value, 0);
  if (otherNamed) donutEntries.push(["Other named work", otherNamed]);
  if (attribution.unknown) donutEntries.push(["Unknown attribution", attribution.unknown]);
  if (attribution.unreviewed) donutEntries.push(["Awaiting review", attribution.unreviewed]);
  renderDonut(
    donut,
    donutSlices(donutEntries, attribution.total),
    formatTokens(attribution.total),
    `${ranked.length} driver labels`
  );
  const driverRows = ranked
    .map(([driver, value]) => {
      const pct = attribution.total
        ? Math.round((value / attribution.total) * 100)
        : 0;
      return `
        <div class="driver-row">
          <div>
            <strong>${text(driver)}</strong>
            <span>${formatTokens(value)} tokens</span>
          </div>
          <b>${share(value, attribution.total)}</b>
          <i style="--w:${pct}%"></i>
        </div>`;
    });
  if (attribution.unknown) {
    const pct = Math.round(
      (attribution.unknown / (attribution.total || 1)) * 100
    );
    driverRows.push(`
      <div class="driver-row driver-row-boundary">
        <div>
          <strong>Unknown attribution <span class="driver-state">reviewed</span></strong>
          <span>${formatTokens(attribution.unknown)} tokens · insufficient evidence for a named driver</span>
        </div>
        <b>${share(attribution.unknown, attribution.total)}</b>
        <i style="--w:${pct}%"></i>
      </div>`);
  }
  if (attribution.unreviewed) {
    const pct = Math.round(
      (attribution.unreviewed / (attribution.total || 1)) * 100
    );
    driverRows.push(`
      <div class="driver-row driver-row-pending">
        <div>
          <strong>Awaiting review</strong>
          <span>${formatTokens(attribution.unreviewed)} tokens · no driver decision yet</span>
        </div>
        <b>${share(attribution.unreviewed, attribution.total)}</b>
        <i style="--w:${pct}%"></i>
      </div>`);
  }
  driverRows.push(
    `<p class="driver-note">Attribution status: ${share(attribution.named, attribution.total)} named, ` +
      `${share(attribution.unknown, attribution.total)} reviewed unknown` +
      (attribution.unreviewed
        ? `, ${share(attribution.unreviewed, attribution.total)} awaiting review.</p>`
        : ".</p>")
  );
  drivers.innerHTML = driverRows.join("");
};

// Donut geometry. One shared helper so the source and origin charts stay
// visually identical and only their data differs.
const SERIES_COLORS = ["--cyan", "--green", "--amber", "--rose", "--heat-3", "--heat-1"];
const donutSlices = (entries, total) => {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return entries.map(([key, value], index) => {
    const fraction = total ? value / total : 0;
    const slice = {
      key,
      value,
      fraction,
      color: `var(${SERIES_COLORS[index % SERIES_COLORS.length]})`,
      dash: `${fraction * circumference} ${circumference}`,
      offset: -offset * circumference
    };
    offset += fraction;
    return slice;
  });
};

const renderDonut = (svg, slices, centerTop, centerSub) => {
  svg.setAttribute("viewBox", "0 0 140 140");
  svg.innerHTML = `
    <g transform="translate(70,70) rotate(-90)">
      <circle r="54" fill="none" stroke="var(--panel-2)" stroke-width="20"></circle>
      ${slices.map((slice) => `
        <circle r="54" fill="none" stroke="${slice.color}" stroke-width="20"
          stroke-dasharray="${slice.dash}" stroke-dashoffset="${slice.offset}">
          <title>${text(slice.key)}: ${Math.round(slice.fraction * 100)}%</title>
        </circle>`).join("")}
    </g>
    <text x="70" y="66" text-anchor="middle" class="donut-value">${text(centerTop)}</text>
    <text x="70" y="84" text-anchor="middle" class="donut-label">${text(centerSub)}</text>`;
};

// A source that rounds to zero still carries tokens. Printing "0%" beside a
// real number reads as "none", so anything under half a percent is shown as
// a bound instead. Four of the eleven sources now land there.
const share = (value, total) => {
  if (!total || !value) return "0%";
  const pct = (value / total) * 100;
  return pct < 0.5 ? "<1%" : `${Math.round(pct)}%`;
};

const renderSources = (rows) => {
  const sources = document.querySelector("#sources");
  const total = sum(rows);
  const grouped = rows.reduce((acc, row) => {
    Object.entries(row.sources || {}).forEach(([source, entry]) => {
      acc[source] = acc[source] || { tokens: 0, exact: 0, estimated: 0, sample: 0, calls: 0 };
      acc[source].tokens += entry.tokens || 0;
      acc[source][entry.fidelity || "estimated"] += entry.tokens || 0;
      acc[source].calls += Number(entry.calls || 0);
    });
    return acc;
  }, {});
  const ranked = Object.entries(grouped).sort((a, b) => b[1].tokens - a[1].tokens);
  const slices = donutSlices(ranked.map(([key, value]) => [labelSource(key), value.tokens]), total);
  const colorFor = new Map(ranked.map(([key], index) => [key, slices[index].color]));
  renderDonut(document.querySelector("#sourceDonut"), slices, formatTokens(total), `${ranked.length} sources`);

  sources.innerHTML = ranked
    .map(([source, value]) => {
      const pct = total ? Math.round((value.tokens / total) * 100) : 0;
      const pctLabel = share(value.tokens, total);
      const fidelity = ["exact", "estimated", "sample"]
        .filter((key) => value[key] > 0)
        .map((key) => `<span class="tag ${key}">${key}</span>`)
        .join("");
      return `
        <div class="source-row">
          <i class="swatch" style="background:${colorFor.get(source)}"></i>
          <div>
            <strong>${labelSourceHtml(source)}</strong>
            <span>${formatTokens(value.tokens)} tokens${value.calls ? `, ${Number(value.calls)} calls` : ""}</span>
          </div>
          <b>${pctLabel}</b>
          <div>${fidelity}</div>
        </div>`;
    }).join("");
};

// Where the evidence came from. A machine-local store is identified by the
// (machine, profile) pair; provider-reported usage has no machine and is
// account-scoped. Rows imported before origin tagging, whose source transcripts
// have since been pruned, are shown as unattributed rather than folded into a
// machine that may not have produced them.
const renderOrigins = (rows) => {
  const panel = document.querySelector("#origins");
  if (!panel) return;
  const totals = new Map();
  let unattributed = 0;
  for (const row of rows) {
    for (const entry of Object.values(row.sources)) {
      if (entry.by_origin) {
        for (const [origin, tokens] of Object.entries(entry.by_origin)) {
          totals.set(origin, (totals.get(origin) ?? 0) + tokens);
        }
      } else {
        unattributed += entry.tokens;
      }
    }
  }
  if (unattributed) totals.set("unattributed", unattributed);

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((acc, [, value]) => acc + value, 0);
  if (!ranked.length) {
    panel.innerHTML = `<p class="origin-empty">No origin recorded yet. Receipts gain an origin on the next extraction.</p>`;
    return;
  }
  // Two origin shapes reach this panel. Locally extracted receipts carry
  // <machine>/<profile>; receipts tagged with --tag on another machine carry a
  // bare host with no profile, because the extractor there knows the host and
  // not which profile the importer will file it under. Counting only the
  // slashed form said "1 machine/profile pair" while two machines were listed,
  // and splitting it printed a literal "profile undefined".
  const isMachine = (key) => key !== "unattributed" && !key.startsWith("account/");
  const machines = ranked.filter(([key]) => isMachine(key)).length;
  const describe = (key) => {
    if (key === "unattributed") return "imported before origin tagging";
    if (key.startsWith("account/")) return "provider-reported, no machine";
    const [machine, profile] = key.split("/");
    return profile ? `${machine} · profile ${profile}` : `${machine} · profile not recorded`;
  };
  panel.innerHTML = ranked.map(([key, value], index) => {
    const pct = total ? Math.round((value / total) * 100) : 0;
    const pctLabel = share(value, total);
    const color = key === "unattributed" ? "var(--muted)" : `var(${SERIES_COLORS[index % SERIES_COLORS.length]})`;
    return `
      <div class="origin-row">
        <div class="origin-head">
          <strong>${text(key)}</strong>
          <b>${pctLabel}</b>
        </div>
        <div class="origin-bar"><span style="width:${Math.max(pct, 1)}%;background:${color}"></span></div>
        <span class="origin-meta">${formatTokens(value)} tokens · ${text(describe(key))}</span>
      </div>`;
  }).join("") + `<p class="origin-note">${machines} ${machines === 1 ? "machine" : "machines"} represented. Other profiles and devices are unknown, not zero.</p>`;
};

// Cadence: how often work is delegated at all, separate from how much. A day
// absent from the dataset is unknown rather than idle, so "quiet" days are
// counted as gaps in coverage, not as measured zeros.
const renderCadence = (rows, start, end) => {
  const panel = document.querySelector("#cadence");
  if (!panel || !rows.length) return;
  const elapsed = Math.round((end - start) / MS_PER_DAY) + 1;
  const active = rows.length;
  const pct = Math.round((active / elapsed) * 100);

  const present = new Set(rows.map((row) => row.date));
  let best = 0;
  let current = 0;
  let currentRun = 0;
  for (let i = 0; i < elapsed; i += 1) {
    const day = isoDay(new Date(start.getTime() + i * MS_PER_DAY));
    if (present.has(day)) {
      currentRun += 1;
      best = Math.max(best, currentRun);
    } else {
      currentRun = 0;
    }
  }
  current = currentRun;

  const weekday = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) weekday[parseLocalDate(row.date).getDay()] += row.total;
  const peakWeek = Math.max(...weekday, 1);
  const names = ["S", "M", "T", "W", "T", "F", "S"];

  panel.innerHTML = `
    <div class="cadence-top">
      <div><strong>${pct}%</strong><span>${active} of ${elapsed} days carry data</span></div>
      <div><strong>${best}</strong><span>longest run</span></div>
      <div><strong>${current}</strong><span>current run</span></div>
    </div>
    <div class="weekdays">
      ${weekday.map((value, index) => `
        <div class="weekday" title="${names[index]}: ${formatTokens(value)}">
          <div class="weekday-bar"><span style="height:${Math.max((value / peakWeek) * 100, 2)}%"></span></div>
          <small>${names[index]}</small>
        </div>`).join("")}
    </div>
    <p class="cadence-note">${filtersActive()
      ? "Days without matching evidence count as filter gaps, not as zero-usage days."
      : "Days with no recovered evidence count as gaps, not as zero-usage days."}</p>`;
};

// Request size. The committed data holds a daily total and a daily call count,
// so this is a distribution of DAILY MEANS, not of individual requests -- a day
// mixing one huge call with many small ones shows as its average. Saying so
// matters more than the chart.
const renderRequestSize = (rows) => {
  const panel = document.querySelector("#requestSize");
  if (!panel) return;
  const means = rows
    .map((row) => {
      const entries = Object.values(row.sources).filter((entry) => entry.calls);
      const tokens = entries.reduce((acc, entry) => acc + entry.tokens, 0);
      const calls = entries.reduce((acc, entry) => acc + entry.calls, 0);
      return calls ? tokens / calls : null;
    })
    .filter((value) => value && value > 0);

  if (means.length < 2) {
    panel.innerHTML = `<p class="origin-empty">Not enough days with call counts to show a distribution.</p>`;
    return;
  }

  // Log buckets: the range spans orders of magnitude, so linear bins would put
  // everything in one column.
  const lo = Math.log10(Math.min(...means));
  const hi = Math.log10(Math.max(...means));
  const BUCKETS = 8;
  const step = (hi - lo) / BUCKETS || 1;
  const bins = Array.from({ length: BUCKETS }, (_, index) => ({
    from: 10 ** (lo + index * step),
    to: 10 ** (lo + (index + 1) * step),
    count: 0
  }));
  for (const mean of means) {
    const index = Math.min(BUCKETS - 1, Math.floor((Math.log10(mean) - lo) / step));
    bins[index].count += 1;
  }
  const peak = Math.max(...bins.map((bin) => bin.count), 1);
  const sorted = [...means].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const overall = means.reduce((acc, value) => acc + value, 0) / means.length;

  document.querySelector("#requestSizeNote").textContent = `${means.length} days`;
  panel.innerHTML = `
    <div class="hist-stats">
      <div><strong>${formatTokens(Math.round(median))}</strong><span>median day</span></div>
      <div><strong>${formatTokens(Math.round(overall))}</strong><span>mean day</span></div>
    </div>
    <div class="hist-bars">
      ${bins.map((bin) => `
        <div class="hist-bar" title="${formatTokens(Math.round(bin.from))}–${formatTokens(Math.round(bin.to))} per request: ${bin.count} days">
          <span style="height:${(bin.count / peak) * 100}%"></span>
        </div>`).join("")}
    </div>
    <div class="hist-axis"><span>${formatTokens(Math.round(bins[0].from))}</span><span>tokens per request</span><span>${formatTokens(Math.round(bins.at(-1).to))}</span></div>
    <p class="cadence-note">Each day contributes its mean request size, not each request. Sources without call counts are excluded.</p>`;
};

const renderScale = (rows) => {
  const total = sum(rows);
  const prompts = Math.round(total / 1_500);
  const books = (total / 90_000).toFixed(1);
  const hours = (total / 11_000).toFixed(1);
  document.querySelector("#scaleEquivalents").innerHTML = `
    <div><strong>${prompts.toLocaleString()}</strong><span>rough medium prompts at 1,500 tokens each</span></div>
    <div><strong>${books}</strong><span>short-book equivalents at 90,000 tokens each</span></div>
    <div><strong>${hours}</strong><span>reading-hour equivalents at 11,000 tokens each</span></div>
  `;
};

const optionLabel = (filter, value) => {
  if (value === "all") return filter === "source"
    ? "All sources"
    : filter === "origin"
      ? "All origins"
      : "Exact + estimated";
  if (filter === "source") return labelSource(value);
  if (filter === "fidelity") return `${value.charAt(0).toUpperCase()}${value.slice(1)} only`;
  return value;
};

const renderFilterStatus = (rows) => {
  const selections = Object.entries(state.filters)
    .filter(([, value]) => value !== "all")
    .map(([filter, value]) => optionLabel(filter, value));
  const prefix = selections.length ? selections.join(" · ") : "All evidence";
  document.querySelector("#filterStatus").textContent =
    `${prefix} · ${rows.length} days · ${formatTokens(sum(rows))} tokens`;
};

const populateFilters = () => {
  const sourceSelect = document.querySelector("#sourceFilter");
  const originSelect = document.querySelector("#originFilter");
  const addOptions = (select, values, label) => {
    for (const value of values) select.add(new Option(label(value), value));
  };
  addOptions(sourceSelect, allSources(state.rows), labelSource);
  const origins = [...new Set(
    state.rows.flatMap((row) =>
      Object.values(row.sources || {}).flatMap((entry) => Object.keys(entry.by_origin || {}))
    )
  )].sort();
  addOptions(originSelect, origins, (value) => value);
};

const ageInDays = (date) => Math.max(0, Math.round((today() - parseLocalDate(date)) / MS_PER_DAY));

const ageLabel = (days) => days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;

const freshnessProvider = (source) => {
  if (["chatgpt", "codex", "openai_api"].includes(source)) return "openai";
  if (source.startsWith("claude_")) return "anthropic";
  return "other";
};

const renderPipeline = () => {
  const panel = document.querySelector("#pipelineHealth");
  if (!panel) return;
  const sourceDates = new Map();
  for (const row of state.rows) {
    for (const source of Object.keys(row.sources || {})) {
      const current = sourceDates.get(source);
      sourceDates.set(source, {
        id: source,
        label: labelSource(source),
        provider: freshnessProvider(source),
        firstKnown: current?.firstKnown ?? row.date,
        lastKnown: row.date,
        accounting: "daily_tokens"
      });
    }
  }
  for (const surface of window.__KNOWN_ACTIVITY__?.surfaces || []) {
    const current = sourceDates.get(surface.id);
    sourceDates.set(surface.id, {
      id: surface.id,
      label: surface.label,
      provider: surface.provider,
      firstKnown: current
        ? [current.firstKnown, surface.first_known].filter(Boolean).sort()[0]
        : surface.first_known,
      lastKnown: current
        ? [current.lastKnown, surface.last_known].filter(Boolean).sort().at(-1)
        : surface.last_known,
      accounting: surface.accounting
    });
  }
  let ranked = [...sourceDates.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (state.filters.source !== "all") {
    ranked = ranked.filter((entry) => entry.id === state.filters.source);
  }
  const latest = ranked.map((entry) => entry.lastKnown).filter(Boolean).sort().at(-1);
  const manifest = window.__EVIDENCE_MANIFEST__;
  const publicView = Boolean(window.__PUBLICATION__);
  document.querySelector("#pipelineHeadline").textContent = latest
    ? `latest ${publicView ? "data" : "evidence"} ${formatDate(latest)}`
    : "no retained evidence";
  const receiptStats = manifest
    ? `<div class="pipeline-stat"><strong>${Number(manifest.receipts || 0).toLocaleString()}</strong><span>receipt records</span></div>
      <div class="pipeline-stat"><strong>${Number(manifest.identified_requests || 0).toLocaleString()}</strong><span>identified requests</span></div>`
    : "";
  const freshnessGroups = [
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["other", "Other"]
  ].map(([key, label]) => ({
    key,
    label,
    entries: ranked.filter((entry) => entry.provider === key)
  }));
  const accountingLabel = {
    daily_tokens: "daily tokens",
    dates_only: "dates only",
    included_in_snapdev: "included in Snapdev",
    interval_lower_bound: "interval estimate"
  };
  const renderFreshnessRow = (entry) => {
    const age = ageInDays(entry.lastKnown);
    const status = age <= 1 ? "current" : age <= 7 ? "recent" : "older";
    return `
      <div class="freshness-row ${status}" title="${accountingLabel[entry.accounting] || "activity evidence"}">
        <i aria-hidden="true"></i>
        <strong>${text(entry.label)}</strong>
        <span class="freshness-range">
          <b>${text(entry.firstKnown)}</b>
          <em aria-hidden="true">→</em>
          <b>${text(entry.lastKnown)}</b>
        </span>
        <span class="freshness-age">${ageLabel(age)}${entry.accounting === "daily_tokens"
          ? ""
          : ` · ${accountingLabel[entry.accounting] || "activity evidence"}`}</span>
      </div>`;
  };
  panel.innerHTML = `
    <div class="pipeline-summary">
      <div class="pipeline-stat"><strong>${text(latest ?? "-")}</strong><span>latest retained day</span></div>
      <div class="pipeline-stat"><strong>${ranked.length}</strong><span>known surfaces</span></div>
      ${receiptStats}
    </div>
    <div class="freshness-list${state.filters.source === "all" ? "" : " freshness-list-filtered"}">
      ${freshnessGroups
        .filter((group) => state.filters.source === "all" || group.entries.length)
        .map((group) => `
          <div class="freshness-column" role="group" aria-label="${text(group.label)} sources${group.entries.length ? "" : ": no known surfaces"}">
            ${group.entries.map(renderFreshnessRow).join("")}
          </div>`)
        .join("")}
    </div>
    <p class="pipeline-note">${publicView
      ? "Dates show first and latest known evidence, not continuous token coverage. Some named surfaces are included in another source total or support only an interval estimate."
      : "Dates show first and latest known evidence, not extractor uptime or continuous token coverage. Hover a row for its accounting treatment."}</p>`;
};

const intervalPosition = (from, to, start, end) => {
  const boundedFrom = new Date(Math.max(parseLocalDate(from).getTime(), start.getTime()));
  const requestedEnd = to === "present" ? today() : parseLocalDate(to);
  const boundedTo = new Date(Math.min(requestedEnd.getTime(), end.getTime()));
  if (boundedTo < boundedFrom) return null;
  const duration = end.getTime() - start.getTime() + MS_PER_DAY;
  return {
    left: ((boundedFrom - start) / duration) * 100,
    width: Math.max(0.2, ((boundedTo - boundedFrom + MS_PER_DAY) / duration) * 100)
  };
};

const renderCoverageMap = () => {
  const panel = document.querySelector("#coverageMap");
  if (!panel) return;
  const observed = window.__OBSERVED_INTERVALS__?.sources || {};
  const start = parseLocalDate(window.__PROFILE__?.windowStart || state.rows[0]?.date);
  const end = today();
  let sources = Object.keys(observed).sort((a, b) => labelSource(a).localeCompare(labelSource(b)));
  if (state.filters.source !== "all") sources = sources.filter((source) => source === state.filters.source);

  const windowStart = window.__PROFILE__?.windowStart || state.rows[0]?.date;
  document.querySelector("#coverageWindowLabel").textContent = `${windowStart} \u2192 today`;
  const axis = `
    <div class="coverage-axis" aria-hidden="true">
      <span></span>
      <div><span>${text(windowStart)}</span><b>time \u2192</b><span>today</span></div>
      <span></span>
    </div>`;
  panel.innerHTML = axis + sources.map((source) => {
    const intervals = [...(observed[source]?.observed || [])].sort((a, b) => {
      const priority = { unknown: 0, known_empty: 1, covered: 2 };
      return (priority[a.status] ?? 0) - (priority[b.status] ?? 0);
    });
    const fidelities = new Set(
      state.rows.flatMap((row) => row.sources?.[source]?.fidelity ? [row.sources[source].fidelity] : [])
    );
    const fidelity = fidelities.size > 1 ? "mixed fidelity" : fidelities.size ? `${[...fidelities][0]} counters` : "no retained rows";
    const statuses = [...new Set(intervals.map((interval) => interval.status))]
      .map((status) => status.replace("_", " "))
      .join(" + ");
    const segments = intervals.flatMap((interval) => {
      const position = intervalPosition(interval.from, interval.to, start, end);
      if (!position) return [];
      const statusClass = ["unknown", "known_empty", "covered"].includes(interval.status)
        ? interval.status.replace("_", "-")
        : "unknown";
      return [`
        <span class="coverage-segment ${statusClass}"
          style="left:${position.left}%;width:${position.width}%"
          title="${text(interval.from)} to ${text(interval.to)}: ${text(interval.status.replace("_", " "))}"></span>`];
    }).join("");
    return `
      <div class="coverage-row">
        <div class="coverage-label">
          <strong>${labelSourceHtml(source)}</strong>
          <span>${text(fidelity)}</span>
        </div>
        <div class="coverage-track" aria-label="${labelSourceHtml(source)} coverage: ${text(statuses)}">${segments}</div>
        <span class="coverage-summary">${text(statuses)}</span>
      </div>`;
  }).join("");
};

const renderNoMatches = () => {
  const message = `<p class="empty-state">No evidence matches this filter combination in the selected range.</p>`;
  document.querySelector("#heatmap").innerHTML = message;
  document.querySelector("#trendChart").innerHTML = "";
  document.querySelector("#drivers").innerHTML = message;
  document.querySelector("#driverDonut").innerHTML = "";
  document.querySelector("#sources").innerHTML = message;
  document.querySelector("#sourceDonut").innerHTML = "";
  document.querySelector("#origins").innerHTML = message;
  document.querySelector("#cadence").innerHTML = message;
  document.querySelector("#requestSize").innerHTML = message;
  document.querySelector("#scaleEquivalents").innerHTML = message;
  document.querySelector("#receiptHeader").innerHTML = "<th>Date</th><th>Total</th><th>7d avg</th>";
  document.querySelector("#receiptRows").innerHTML = "";
};

const renderTable = (rows) => {
  const tbody = document.querySelector("#receiptRows");
  const sources = allSources(rows);
  const showEvidence = publicationFeature("evidence");
  document.querySelector("#receiptHeader").innerHTML = `
    <th>Date</th>
    <th>Total</th>
    <th>7d avg</th>
    ${sources.map((source) => `<th>${labelSourceHtml(source)}</th>`).join("")}
    <th>Driver</th>
    ${showEvidence ? "<th>Evidence</th>" : ""}
  `;
  tbody.innerHTML = rows.slice(-30).reverse().map((row) => {
    const average = movingAverage(rows, row.date);
    const sourceCells = sources.map((source) => {
      const entry = row.sources[source];
      if (!entry) return "<td>-</td>";
      return `<td>${formatTokens(entry.tokens)} <span class="tag ${fidelityClass(entry.fidelity)}">${text(entry.fidelity)}</span>${entry.calls ? `<span class="calls">${Number(entry.calls)} calls</span>` : ""}</td>`;
    }).join("");
    return `
      <tr>
        <td>${text(row.date)}</td>
        <td>${formatTokens(row.total)}</td>
        <td>${average.average === null ? `unavailable (${average.observedDays}/7)` : formatTokens(average.average)}</td>
        ${sourceCells}
        <td>${text(row.driver || "unreviewed")}</td>
        ${showEvidence ? `<td>${text(row.evidence)}</td>` : ""}
      </tr>`;
  }).join("");
};

const render = () => {
  const { rows: windowRows, start, end } = getVisibleWindow();
  const rows = filterDashboardRows(windowRows, state.filters);
  renderFilterStatus(rows);
  renderSummary(rows, start, end);
  renderPipeline();
  renderCoverageMap();
  if (!rows.length) {
    renderNoMatches();
    return;
  }
  renderHeatmap(rows, start, end);
  renderTrend(rows, start, end);
  renderDrivers(rows);
  renderSources(rows);
  renderOrigins(rows);
  renderCadence(rows, start, end);
  renderRequestSize(rows);
  renderScale(rows);
  if (publicationFeature("recordsTable")) renderTable(rows);
};

applyPublicationView();
initTheme();
document.querySelector("#themeToggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  // Charts read CSS variables at draw time, so redraw after the swap.
  if (state.rows.length) render();
});

document.querySelectorAll(".range-button").forEach((item) => {
  const active = item.dataset.range === state.range;
  item.classList.toggle("active", active);
  item.setAttribute("aria-pressed", String(active));
});
document.querySelectorAll(".range-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".range-button").forEach((item) => {
      item.classList.remove("active");
      item.setAttribute("aria-pressed", "false");
    });
    button.classList.add("active");
    button.setAttribute("aria-pressed", "true");
    state.range = button.dataset.range;
    render();
  });
});

[
  ["sourceFilter", "source"],
  ["fidelityFilter", "fidelity"],
  ["originFilter", "origin"]
].forEach(([id, filter]) => {
  document.querySelector(`#${id}`)?.addEventListener("change", (event) => {
    state.filters[filter] = event.target.value;
    render();
  });
});

document.querySelector("#resetFilters")?.addEventListener("click", () => {
  state.filters = { source: "all", fidelity: "all", origin: "all" };
  document.querySelector("#sourceFilter").value = "all";
  document.querySelector("#fidelityFilter").value = "all";
  document.querySelector("#originFilter").value = "all";
  render();
});

// Data is always inlined by the build; there is no runtime fetch. The dev
// server rebuilds and serves the same artifact, so development and production
// exercise one path instead of two that can drift apart.
Promise.resolve(window.__DAILY_BURN__)
  .then((rows) => {
    if (!rows) throw new Error("No data inlined \u2014 run npm run build.");
    state.rows = rows.map(normalizeLegacyRow).map((row) => ({
      ...row,
      total: row.total ?? sourceTotal(row)
    }));
    populateFilters();
    render();
  })
  .catch((error) => {
    const main = document.createElement("main");
    main.className = "shell";
    const panel = document.createElement("section");
    panel.className = "panel";
    const heading = document.createElement("h1");
    heading.textContent = "Data load failed";
    const detail = document.createElement("p");
    detail.textContent = error instanceof Error ? error.message : String(error);
    panel.append(heading, detail);
    main.append(panel);
    document.body.replaceChildren(main);
  });

if (publicationFeature("github")) Promise.resolve(window.__GITHUB_SUMMARY__)
  .then((summary) => {
    if (!summary) throw new Error("no github summary inlined");
    renderGithubSummary(summary);
  })
  .catch(() => {
    document.querySelector("#githubContributions").textContent = "-";
    document.querySelector("#githubWindow").textContent = "lookup unavailable";
  });
