const sourceLabels = {
  chatgpt: "ChatGPT",
  claude_api: "Claude API",
  claude_chat: "Claude Chat",
  claude_code: "Claude Code",
  claude_cowork: "Claude Cowork",
  claude_design: "Claude Design",
  codex: "Codex",
  gemma_local: "Gemma local",
  kilo: "Kilo Code",
  openai_api: "OpenAI API",
  perplexity_api: "Perplexity API",
  qwen_local: "Qwen local",
  snapdev: "Snapdev",
  typesafe_api: "TypeSafe API"
};

const formatTokens = (value) => {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return "unavailable";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
};

const text = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const fidelityClass = (value) => ["exact", "estimated", "sample"].includes(value)
  ? value
  : "estimated";

const THEME_KEY = "delegated-watch-theme";
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  document.querySelector("#themeToggle").setAttribute("aria-pressed", String(!dark));
  document.querySelector("#themeIcon").textContent = dark ? "\u263e" : "\u2600";
  document.querySelector("#themeLabel").textContent = dark ? "Dark" : "Light";
};
applyTheme(localStorage.getItem(THEME_KEY) ?? "dark");
document.querySelector("#themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

const records = window.__RECENT_RECORDS__ ?? [];
const sources = window.__RECENT_SOURCES__ ?? [];
const total = records.reduce((sum, row) => sum + Number(row.total || 0), 0);
document.querySelector("#recordsSummary").innerHTML = `
  <div><strong>${records.length}</strong><span>active days</span></div>
  <div><strong>${formatTokens(total)}</strong><span>tokens in this table</span></div>
  <div><strong>${sources.length}</strong><span>active sources</span></div>
  <div><strong>${text(records[0]?.date ?? "-")}</strong><span>first shown</span></div>
  <div><strong>${text(records.at(-1)?.date ?? "-")}</strong><span>latest shown</span></div>`;

document.querySelector("#recordsHeader").innerHTML = `
  <th>Date</th>
  <th>Total</th>
  <th>7-day avg</th>
  ${sources.map((source) => `<th>${text(sourceLabels[source] ?? source)}</th>`).join("")}
  <th>Driver</th>`;

document.querySelector("#recordsRows").innerHTML = [...records].reverse().map((row) => `
  <tr>
    <td>${text(row.date)}</td>
    <td>${formatTokens(row.total)}</td>
    <td>${row.moving_average === null ? `unavailable (${Number(row.moving_average_observed_days || 0)}/7)` : formatTokens(row.moving_average)}</td>
    ${sources.map((source) => {
      const entry = row.sources[source];
      return entry
        ? `<td>${formatTokens(entry.tokens)} <span class="tag ${fidelityClass(entry.fidelity)}">${text(entry.fidelity)}</span></td>`
        : "<td>-</td>";
    }).join("")}
    <td>${text(row.driver || "unreviewed")}</td>
  </tr>`).join("");
