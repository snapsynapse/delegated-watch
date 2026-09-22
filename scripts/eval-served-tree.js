// Served-tree guard. Everything under docs/ becomes publicly fetchable the
// moment GitHub Pages is enabled, and a private repo does not change that.
//
// While posture is "pre-launch" this asserts that no dataset content has leaked
// into docs/ — derived from the real data rather than a hardcoded list, so it
// catches a stray copy, a mis-pointed build, or a hand-edited file. Going live
// is gated on recording a public_mode, because publishing docs/ publishes
// whatever is in it.
//
// Usage:
//   node scripts/eval-served-tree.js [--strict]
//
// Exits 1 on any FAIL, or on any WARN under --strict.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SERVED_DIR = "docs";
// Matches the default in scripts/build.js, so an older config without
// build_output is judged against the same path the build actually uses.
const DEFAULT_BUILD_OUTPUT = "docs2B/index.html";
const DATA_FILE = "public/data/daily-burn.json";
const GITHUB_FILE = "public/data/github-summary.json";
const CONFIG = "config/site.json";

const strict = process.argv.includes("--strict");
const results = [];
const check = (name, verdict, detail = "") => results.push({ name, verdict, detail });

const config = JSON.parse(await readFile(CONFIG, "utf8"));
const buildOutput = config.build_output ?? DEFAULT_BUILD_OUTPUT;
const BUILD_FILE = buildOutput;

// A directory that cannot be read cannot be cleared. Skipping it silently would
// let this eval report the served tree clean while part of it went unscanned --
// the one failure mode that matters here, since the whole point is proving
// nothing sensitive is about to be published.
const unscannable = [];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") unscannable.push(`${dir} (${error.code})`);
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const servedFiles = [];
for await (const file of walk(SERVED_DIR)) servedFiles.push(file);

check("served tree fully scannable", unscannable.length ? "FAIL" : "ok",
  unscannable.length ? `cannot read: ${unscannable.join(", ")} — cannot certify the tree` : "");

check(`${SERVED_DIR}/ exists and has content`, servedFiles.length ? "ok" : "FAIL",
  servedFiles.length ? `${servedFiles.length} files` : "nothing to serve");

// Platform config GitHub Pages needs for branch-folder publishing.
for (const required of ["CNAME", ".nojekyll", "robots.txt"]) {
  const present = servedFiles.some((file) => file === join(SERVED_DIR, required));
  check(`${required} present`, present ? "ok" : "WARN", present ? "" : "Pages/crawler config incomplete");
}

const cname = await readFile(join(SERVED_DIR, "CNAME"), "utf8").catch(() => "");
check("CNAME matches configured domain", cname.trim() === config.domain ? "ok" : "FAIL",
  cname.trim() === config.domain ? "" : `CNAME "${cname.trim()}" vs config "${config.domain}"`);

// Distinctive strings drawn from the real dataset. If any appears in the served
// tree while pre-launch, data has leaked.
const rows = JSON.parse(await readFile(DATA_FILE, "utf8"));
const sources = [...new Set(rows.flatMap((row) => Object.keys(row.sources)))];
const sampledDates = rows.filter((_, index) => index % Math.ceil(rows.length / 12) === 0).map((row) => row.date);
const largestTotals = [...rows].sort((a, b) => b.total - a.total).slice(0, 5).map((row) => String(row.total));
const github = await readFile(GITHUB_FILE, "utf8").catch(() => null);
const username = github ? JSON.parse(github).username : null;

const needles = [
  ...sources,
  ...sampledDates,
  ...largestTotals,
  "__DAILY_BURN__",
  "__GITHUB_SUMMARY__",
  "daily-burn.json",
  ...(username ? [username] : [])
];

if (config.posture === "pre-launch") {
  const leaks = [];
  for (const file of servedFiles) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (!content) continue;
    for (const needle of needles) {
      if (content.includes(needle)) leaks.push(`${file} contains "${needle}"`);
    }
  }
  check("no dataset content in served tree", leaks.length ? "FAIL" : "ok",
    leaks.slice(0, 6).join("; "));

  // The configured build output must not target the served tree while staging.
  // Reading the resolved path from config/site.json (rather than pattern-matching
  // scripts/build.js's source) means this stays correct however the build script
  // is written, as long as it honors the same config key.
  const targetsServed = buildOutput === SERVED_DIR || buildOutput.startsWith(`${SERVED_DIR}/`);
  check("build does not write into served tree", targetsServed ? "FAIL" : "ok",
    targetsServed ? `config/site.json build_output "${buildOutput}" is under ${SERVED_DIR}/; it would clobber the placeholder` : "");

  const built = await readFile(BUILD_FILE, "utf8").catch(() => null);
  check("built dashboard staged outside served tree", built ? "ok" : "WARN",
    built ? "" : `${BUILD_FILE} absent; run npm run build`);

  // A placeholder that gets crawled and indexed becomes the canonical page.
  const robots = await readFile(join(SERVED_DIR, "robots.txt"), "utf8").catch(() => "");
  check("placeholder is not open to crawlers", /Disallow:\s*\/\s*$/m.test(robots) ? "ok" : "WARN",
    /Disallow:\s*\/\s*$/m.test(robots) ? "" : "robots.txt does not disallow while pre-launch");
} else if (config.posture === "live") {
  check("public mode recorded before going live", config.public_mode ? "ok" : "FAIL",
    config.public_mode ? config.public_mode : "set public_mode in config/site.json first");
  check("no dataset content in served tree", "ok", "skipped: posture is live, publishing data is intentional");
} else {
  check("posture recognised", "FAIL", `unknown posture "${config.posture}"`);
}

const width = Math.max(...results.map((result) => result.name.length));
for (const { name, verdict, detail } of results) {
  console.log(`${verdict.padEnd(5)} ${name.padEnd(width)}${detail ? "  " + detail : ""}`);
}

const failed = results.filter((result) => result.verdict === "FAIL");
const warned = results.filter((result) => result.verdict === "WARN");
console.log(`\nposture "${config.posture}", ${servedFiles.length} served files: ${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail.`);

if (failed.length || (strict && warned.length)) process.exit(1);
