// Where the record lives: the shipped synthetic demo, or a person's own.
//
// The repository ships a synthetic demonstration record in tracked files:
// public/data/ for the dataset and config/ for its intervals, built into the
// served page at docs/demo/. A person's own record must never land in any of
// those, because committing and pushing a clone would publish it.
//
// config/record.json switches every script to a person's own record. It is
// git-ignored and names a git-ignored directory, record/ by default, which
// then holds the dataset, evidence manifest, CSV exports, observed intervals,
// known activity, and the built dashboard at record/index.html. Without the
// file, every script works on the demo exactly as before. `npm run refresh`
// creates it on first use.
//
// Paths are relative to the working directory, like the receipt inboxes,
// because every command runs from the repository root.

import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

export const RECORD_CONFIG = "config/record.json";
export const DEFAULT_RECORD_DIR = "record";

const DEMO = {
  mode: "demo",
  dataset: "public/data/daily-burn.json",
  manifest: "public/data/evidence-manifest.json",
  githubSummary: "public/data/github-summary.json",
  csvDaily: "public/data/daily-burn.csv",
  csvDetail: "public/data/daily-burn-detail.csv",
  intervals: "config/observed-intervals.json",
  knownActivity: "config/known-activity.json",
  // The demo's page goes where config/site.json says.
  dashboard: null
};

// A record directory must stay out of every tracked or served location.
export function assertRecordDir(dir) {
  const clean = normalize(String(dir ?? "")).replace(/\/+$/, "");
  if (!clean || clean === "." || isAbsolute(clean) || clean.startsWith("..")) {
    throw new Error(`${RECORD_CONFIG}: dir must be a relative directory inside the repository, got ${JSON.stringify(dir)}`);
  }
  for (const tracked of ["docs", "public", "config", "scripts", "src", "tests", "fixtures", "candidate"]) {
    if (clean === tracked || clean.startsWith(`${tracked}/`)) {
      throw new Error(`${RECORD_CONFIG}: dir ${JSON.stringify(dir)} is inside ${tracked}/, which is tracked or served`);
    }
  }
  return clean;
}

// Reads config/record.json once per process. Absent means the demo; present
// but unreadable or malformed is an error, never a silent fall back to the demo.
let cached;
export function recordPaths() {
  if (cached) return cached;
  let config;
  try {
    config = JSON.parse(readFileSync(RECORD_CONFIG, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return (cached = DEMO);
    throw new Error(`${RECORD_CONFIG} exists but could not be read: ${error.message}`);
  }
  const dir = assertRecordDir(config?.dir ?? DEFAULT_RECORD_DIR);
  return (cached = {
    mode: "record",
    dir,
    dataset: `${dir}/daily-burn.json`,
    manifest: `${dir}/evidence-manifest.json`,
    githubSummary: `${dir}/github-summary.json`,
    csvDaily: `${dir}/daily-burn.csv`,
    csvDetail: `${dir}/daily-burn-detail.csv`,
    intervals: `${dir}/observed-intervals.json`,
    knownActivity: `${dir}/known-activity.json`,
    dashboard: `${dir}/index.html`
  });
}

// A person's record need not declare observed intervals or known activity yet.
// In record mode a missing file reads as the empty declaration; in the demo,
// where both ship, a missing file is still an error.
export async function readRecordJson(path, empty) {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && recordPaths().mode === "record") return empty;
    throw error;
  }
}
export const emptyIntervals = (timezone) => ({ timezone, sources: {} });
export const EMPTY_KNOWN_ACTIVITY = { schema_version: 1, surfaces: [] };
