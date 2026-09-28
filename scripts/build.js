import { assertNoPendingAcceptance } from "./lib/accepted-evidence.js";
await assertNoPendingAcceptance();

// Static-site build: bake the current data, styles, and app code into one
// self-contained page that renders when opened straight from disk (file://),
// no server required. Re-run after every data import.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderStaticDashboard } from "./lib/static-dashboard.js";
import { EMPTY_KNOWN_ACTIVITY, emptyIntervals, readRecordJson, recordPaths } from "./lib/record-paths.js";

// Where the built page lands is configuration, not a hardcoded path, so a
// checkout that stages its page outside the served tree and one that serves it
// from docs/ run the same build. A config without the key keeps the staging
// default.
const DEFAULT_BUILD_OUTPUT = "docs2B/index.html";
const configuredSite = JSON.parse(await readFile("config/site.json", "utf8"));
const paths = recordPaths();
// A person's own record builds to its own ignored directory, and renders as a
// measured record: no demo banner, no demo window, no demo anchor date.
const site = paths.mode === "record"
  ? { ...configuredSite, dataset: "measured", as_of: undefined, window_start: undefined }
  : configuredSite;
const buildOutput = paths.dashboard ?? site.build_output ?? DEFAULT_BUILD_OUTPUT;

const [dailyBurn, githubSummary, observedIntervals, knownActivity, evidenceManifest] = await Promise.all([
  readFile(paths.dataset, "utf8"),
  readFile(paths.githubSummary, "utf8").catch(() => null),
  readRecordJson(paths.intervals, emptyIntervals("UTC")).then((value) => JSON.stringify(value)),
  readRecordJson(paths.knownActivity, EMPTY_KNOWN_ACTIVITY).then((value) => JSON.stringify(value)),
  readFile(paths.manifest, "utf8").catch(() => null)
]);

// The page needs the recovery window, not just the rows, or "all" silently
// means "all we found" and the years with nothing recovered become invisible.
// Personal values stay in config/ and reach the page only through the build.
// A synthetic demo may frame its own year through site.window_start, the way
// as_of anchors its end; a measured record always uses the profile's window.
const { timezone, windowStart } = await import("./lib/profile.js");
const pageWindowStart = site?.dataset === "synthetic" && site?.window_start ? site.window_start : await windowStart();
const profileForPage = { timezone: await timezone(), windowStart: pageWindowStart };

// Coverage visualization needs interval bounds and status, not the private
// evidence notes or request costs stored beside them.
const observed = JSON.parse(observedIntervals);
const observedForPage = {
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

// The full manifest contains request-level correlation hashes. The dashboard
// needs only aggregate health counters and per-source bounds.
const manifest = evidenceManifest ? JSON.parse(evidenceManifest) : null;
const manifestForPage = manifest
  ? {
      receipts: manifest.receipts,
      identified_requests: manifest.identified_requests,
      malformed_receipt_lines: manifest.malformed_receipt_lines,
      coverage: manifest.coverage
    }
  : null;

const page = await renderStaticDashboard({
  dailyBurn,
  githubSummary,
  profile: profileForPage,
  observedIntervals: observedForPage,
  knownActivity,
  evidenceManifest: manifestForPage,
  site
});

// The page inlines the whole dataset. Writing it under docs/ publishes that
// data the moment GitHub Pages serves the tree, so a checkout holding a real
// record stages the page elsewhere until a public-mode decision is recorded
// in config/site.json; scripts/eval-served-tree.js enforces that posture. A
// checkout whose dataset is synthetic can build straight into docs/.
await mkdir(dirname(buildOutput), { recursive: true });
await writeFile(buildOutput, page);

const rows = JSON.parse(dailyBurn);
console.log(`Built self-contained ${buildOutput} (${rows.length} data rows inlined).`);
