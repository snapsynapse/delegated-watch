import { assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
await assertNoPendingAcceptance();

// Static dashboard contract. The page intentionally inlines private aggregate
// data, but the freshness panel needs only reduced views of known activity and
// the evidence manifest. This eval proves the reduction did
// not drift and that the controls required to interpret those values remain in
// the built artifact.
//
// Usage:
//   node scripts/eval-dashboard.js [--strict]
//
// Exits 1 on any FAIL, or on any WARN under --strict.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// Matches the default in scripts/build.js, so an older config without
// build_output is judged against the same path the build actually uses.
const DEFAULT_BUILD_OUTPUT = "docs2B/index.html";
const TEMPLATE_FILE = "src/index.html";
const DATA_FILE = "public/data/daily-burn.json";
const INTERVALS_FILE = "config/observed-intervals.json";
const KNOWN_ACTIVITY_FILE = "config/known-activity.json";
const MANIFEST_FILE = "public/data/evidence-manifest.json";
const SITE_FILE = "config/site.json";

const site = JSON.parse(await readFile(SITE_FILE, "utf8"));
const BUILD_FILE = site.build_output ?? DEFAULT_BUILD_OUTPUT;

const strict = process.argv.includes("--strict");
const results = [];
const check = (name, verdict, detail = "") => results.push({ name, verdict, detail });
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const [built, template, rows, observed, knownActivity, manifest] = await Promise.all([
  readFile(BUILD_FILE, "utf8").catch(() => null),
  readFile(TEMPLATE_FILE, "utf8"),
  readFile(DATA_FILE, "utf8").then(JSON.parse),
  readFile(INTERVALS_FILE, "utf8").then(JSON.parse),
  readFile(KNOWN_ACTIVITY_FILE, "utf8").then(JSON.parse),
  // No ledger exists until an import has accepted evidence; ENOENT is that
  // state, not a broken read, and everything else still surfaces.
  readFile(MANIFEST_FILE, "utf8").then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })
]);

check("built dashboard exists", built ? "ok" : "FAIL", built ? "" : `run npm run build`);

const inlineParseFailures = [];
const extractInline = (name) => {
  if (!built) return null;
  const match = built.match(new RegExp(`window\\.${name} = (.*?);\\n`, "s"));
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/\\\\u003c/g, "<"));
  } catch (error) {
    inlineParseFailures.push(`${name}: ${error.message}`);
    return null;
  }
};

const builtIntervals = extractInline("__OBSERVED_INTERVALS__");
const expectedIntervals = {
  timezone: observed.timezone,
  sources: Object.fromEntries(
    Object.entries(observed.sources).map(([source, value]) => [
      source,
      {
        observed: value.observed.map(({ from, to, status }) => ({ from, to, status }))
      }
    ])
  )
};
check(
  "observed intervals are reduced exactly",
  sameJson(builtIntervals, expectedIntervals) ? "ok" : "FAIL",
  sameJson(builtIntervals, expectedIntervals) ? "" : "built interval view differs from the date/status allowlist"
);

const builtKnownActivity = extractInline("__KNOWN_ACTIVITY__");
check(
  "known activity is inlined exactly",
  sameJson(builtKnownActivity, knownActivity) ? "ok" : "FAIL",
  sameJson(builtKnownActivity, knownActivity) ? "" : "built known-activity view differs from config"
);
const activityFailures = (knownActivity.surfaces || []).flatMap((surface) => {
  const valid = datePattern.test(surface.first_known)
    && datePattern.test(surface.last_known)
    && surface.first_known <= surface.last_known
    && ["openai", "anthropic", "other"].includes(surface.provider);
  return valid ? [] : [surface.id];
});
check(
  "known activity bounds are displayable",
  activityFailures.length ? "FAIL" : "ok",
  activityFailures.join(", ")
);

const builtManifest = extractInline("__EVIDENCE_MANIFEST__");
const expectedManifest = manifest
  ? {
      receipts: manifest.receipts,
      identified_requests: manifest.identified_requests,
      malformed_receipt_lines: manifest.malformed_receipt_lines,
      coverage: manifest.coverage
    }
  : null;
check(
  "evidence manifest is reduced exactly",
  sameJson(builtManifest, expectedManifest) ? "ok" : "FAIL",
  sameJson(builtManifest, expectedManifest) ? "" : "built manifest differs from the aggregate allowlist"
);
check(
  "inlined dashboard metadata parses",
  inlineParseFailures.length ? "FAIL" : "ok",
  inlineParseFailures.join("; ")
);

const manifestScript = built?.match(/window\.__EVIDENCE_MANIFEST__ = (.*?);\n/s)?.[1] || "";
const forbiddenManifestFields = [
  '"entries"',
  '"correlation_keys"',
  '"snapshot_key"',
  '"provenance"',
  '"account_alias"',
  '"machine_alias"'
].filter((field) => manifestScript.includes(field));
check(
  "request identity stays out of dashboard metadata",
  forbiddenManifestFields.length ? "FAIL" : "ok",
  forbiddenManifestFields.join(", ")
);

const sourceIds = [...new Set(rows.flatMap((row) => Object.keys(row.sources || {})))].sort();
const intervalSources = Object.keys(observed.sources || {}).sort();
const manifestSources = Object.keys(manifest?.coverage || {}).sort();
const missingIntervals = sourceIds.filter((source) => !intervalSources.includes(source));
const missingManifest = sourceIds.filter((source) => !manifestSources.includes(source));
check(
  "every retained source has interval coverage",
  missingIntervals.length ? "FAIL" : "ok",
  missingIntervals.join(", ")
);
check(
  "every retained source has manifest coverage",
  manifest === null ? "ok" : missingManifest.length ? "FAIL" : "ok",
  manifest === null ? "no evidence manifest present; nothing accepted yet" : missingManifest.join(", ")
);

const allowedStatuses = new Set(["covered", "known_empty", "unknown"]);
const badIntervals = Object.entries(observed.sources || {}).flatMap(([source, value]) =>
  (value.observed || []).flatMap(({ from, to, status }) => {
    const datesValid =
      datePattern.test(from) &&
      (to === "present" || datePattern.test(to)) &&
      (to === "present" || from <= to);
    return datesValid && allowedStatuses.has(status) ? [] : [`${source}:${from}/${to}/${status}`];
  })
);
check("coverage intervals are displayable", badIntervals.length ? "FAIL" : "ok", badIntervals.slice(0, 5).join(", "));

const requiredIds = [
  "sourceFilter",
  "fidelityFilter",
  "originFilter",
  "resetFilters",
  "filterStatus",
  "exactShare",
  "coverageDays",
  "missingLegendLabel",
  "pipelineHeadline",
  "pipelineHealth",
  "driverDonut",
  "sourceDonut"
];
const missingIds = requiredIds.filter((id) => !template.includes(`id="${id}"`));
check("dashboard interpretation controls exist", missingIds.length ? "FAIL" : "ok", missingIds.join(", "));

const labelledSelects = ["sourceFilter", "fidelityFilter", "originFilter"].filter(
  (id) => !new RegExp(`<label>[\\s\\S]*?<select id="${id}"`).test(template)
);
check("filter selects retain visible labels", labelledSelects.length ? "FAIL" : "ok", labelledSelects.join(", "));
check(
  "filter status announces updates",
  /<output id="filterStatus"[^>]*aria-live="polite"/.test(template) ? "ok" : "FAIL",
  /<output id="filterStatus"[^>]*aria-live="polite"/.test(template)
    ? ""
    : "filterStatus must remain a polite live region"
);
check(
  "freshness groups preserve provider column order",
  built?.includes('["openai", "OpenAI"]')
    && built?.includes('["anthropic", "Anthropic"]')
    && built?.includes('["other", "Other"]')
    && built.indexOf('["openai", "OpenAI"]') < built.indexOf('["anthropic", "Anthropic"]')
    && built.indexOf('["anthropic", "Anthropic"]') < built.indexOf('["other", "Other"]')
    ? "ok"
    : "FAIL",
  "expected unlabeled OpenAI, Anthropic, and other freshness columns"
);
check(
  "weekly trend keeps fixed 100 through 100M logarithmic scale",
  built?.includes("const minLog = 2;")
    && built?.includes("const maxLog = 8;")
    && built?.includes("tokens/week · logarithmic")
    ? "ok"
    : "FAIL",
  "fixed scale and top 100M gridline must remain inspectable"
);
check(
  "coverage timeline is withheld",
  !template.includes('id="coverageMap"')
    && template.includes("Coverage timeline withheld pending")
    ? "ok"
    : "FAIL",
  "the misleading coverage panel must stay out of the rendered page"
);
check(
  "freshness distinguishes activity evidence from coverage",
  built?.includes("Dates show first and latest known evidence, not extractor uptime or continuous token coverage.")
    && built?.includes("interval_lower_bound")
    && built?.includes("included_in_snapdev")
    ? "ok"
    : "FAIL",
  "known activity needs explicit non-coverage and non-additive semantics"
);
const driverSemantics = [
  "Unknown attribution",
  "reviewed unknown",
  "Awaiting review"
].filter((text) => !built?.includes(text));
check(
  "driver attribution states stay distinct",
  driverSemantics.length ? "FAIL" : "ok",
  driverSemantics.join(", ")
);

const externalAssets = built
  ? ["/src/app.js", "/src/styles.css", "./dashboard-model.js"].filter((asset) => built.includes(asset))
  : [];
check("static dashboard stays self-contained", externalAssets.length ? "FAIL" : "ok", externalAssets.join(", "));

const moduleScript = built?.match(/<script type="module">\n([\s\S]*?)\n<\/script>/)?.[1] || "";
const syntax = moduleScript
  ? spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: moduleScript,
      encoding: "utf8"
    })
  : null;
check(
  "inlined dashboard module parses",
  syntax?.status === 0 ? "ok" : "FAIL",
  syntax?.status === 0 ? "" : (syntax?.stderr || "module script not found").trim().split("\n")[0]
);

const width = Math.max(...results.map((result) => result.name.length));
for (const { name, verdict, detail } of results) {
  console.log(`${verdict.padEnd(5)} ${name.padEnd(width)}${detail ? "  " + detail : ""}`);
}

const failed = results.filter((result) => result.verdict === "FAIL");
const warned = results.filter((result) => result.verdict === "WARN");
console.log(`\nDashboard contract: ${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail.`);

if (failed.length || (strict && warned.length)) process.exit(1);
