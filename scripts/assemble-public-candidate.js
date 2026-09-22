// Assembles the public candidate: a fresh, self-contained directory built by
// copying exactly the files config/public-candidate.json names, nothing more.
// It is the producer side of the template split
// -- this script never decides what belongs in the candidate, it only ever
// executes the inventory's own list. scripts/verify-public-candidate.js is the
// independent checker that confirms the result matches that same inventory and
// carries none of the forbidden terms or identities; this script does not
// duplicate that judgment.
//
// Usage:
//   node scripts/assemble-public-candidate.js --out <dir> [--inventory <path>] [--allow-dirty]
//
// Refuses to run against an uncommitted working tree (the assembled source
// revision would not describe what was actually copied) unless --allow-dirty
// is given, and refuses to write into a directory that already has content in
// it, so a stale or partial candidate is never silently reused.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = process.cwd();
const DEFAULT_INVENTORY = "config/public-candidate.json";
const MANIFEST_PATH = "scratch/candidate-manifest.json";
const PUBLIC_CANDIDATE_KEY = "config/public-candidate.json";
// The shipped copy of the inventory is what CI verifies the public tree with.
// It must not carry the producer's scrubbing policy: the forbidden terms are
// the private identifiers themselves, the script fragments name unreleased
// tooling, and the revision points into a private history.
const PRODUCER_ONLY_KEYS = ["forbidden_terms", "forbidden_script_fragments", "source_revision"];

function parseArgs(argv) {
  const args = { out: null, inventory: DEFAULT_INVENTORY, allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--inventory") args.inventory = argv[++i];
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else throw new Error(`Unrecognized argument: ${arg}`);
  }
  if (!args.out) throw new Error("Usage: assemble-public-candidate.js --out <dir> [--inventory <path>] [--allow-dirty]");
  return args;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const posixRel = (path) => path.split("\\").join("/");

// "does not exist" and "exists but is unreadable" are different findings per
// INTENT invariant 10 -- only the first licenses treating a path as absent.
async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function directoryIsEmpty(path) {
  const entries = await readdir(path);
  return entries.length === 0;
}

// The inventory's overlay_globs keys are destination glob patterns with a
// single trailing "*.ext" segment; this repo has no need for anything richer.
function globToRegExp(basenamePattern) {
  const escaped = basenamePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

async function main() {
  const { out, inventory: inventoryPath, allowDirty } = parseArgs(process.argv.slice(2));

  if (!allowDirty) {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    if (status.trim()) {
      console.error("FAIL working tree is dirty; commit or stash first, or pass --allow-dirty.");
      console.error(status.trim().split("\n").map((line) => `  ${line}`).join("\n"));
      process.exit(1);
    }
  }
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  }).trim();

  const inventoryAbs = resolve(REPO_ROOT, inventoryPath);
  let inventory;
  try {
    inventory = JSON.parse(await readFile(inventoryAbs, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`FAIL inventory not found: ${inventoryPath}`);
      process.exit(1);
    }
    throw error;
  }

  const outAbs = resolve(REPO_ROOT, out);
  const outStat = await statOrNull(outAbs);
  if (outStat) {
    if (!outStat.isDirectory() || !(await directoryIsEmpty(outAbs))) {
      console.error(`FAIL output directory already exists and is not empty: ${out}`);
      process.exit(1);
    }
  } else {
    await mkdir(outAbs, { recursive: true });
  }

  // Regenerate the committed public-candidate.json with this run's source
  // revision filled in, before any copying happens, so the overlay copy below
  // (which reads it from the producer tree) picks up the current value rather
  // than a stale null. Only applies when the inventory in use actually
  // describes that overlay -- a narrow test inventory need not.
  let regenerated = null;
  const publicCandidateOverlay = inventory.overlay_files?.[PUBLIC_CANDIDATE_KEY];
  if (publicCandidateOverlay) {
    const producerCopyAbs = resolve(REPO_ROOT, publicCandidateOverlay);
    const projected = Object.fromEntries(Object.entries(inventory).filter(([key]) => !PRODUCER_ONLY_KEYS.includes(key)));
    projected.note_projection = "Projected for the public tree: producer-only scrubbing policy and the source revision are omitted. The producer inventory is the authority.";
    const nextText = JSON.stringify(projected, null, 2) + "\n";
    let previousText = null;
    const previousStat = await statOrNull(producerCopyAbs);
    if (previousStat) previousText = await readFile(producerCopyAbs, "utf8");
    if (previousText !== nextText) {
      await mkdir(dirname(producerCopyAbs), { recursive: true });
      await writeFile(producerCopyAbs, nextText);
    }
    regenerated = { path: relative(REPO_ROOT, producerCopyAbs), changed: previousText !== nextText };
  }

  const fails = [];
  const copied = [];

  async function copyOne(srcAbs, destAbs, label) {
    const st = await statOrNull(srcAbs);
    if (!st) {
      fails.push(`missing source: ${label}`);
      return;
    }
    if (st.isSymbolicLink()) {
      fails.push(`refusing to copy a symlink: ${label}`);
      return;
    }
    if (basename(srcAbs) === ".git") {
      fails.push(`refusing to copy .git: ${label}`);
      return;
    }
    await mkdir(dirname(destAbs), { recursive: true });
    await copyFile(srcAbs, destAbs);
    copied.push(destAbs);
  }

  for (const relPath of inventory.producer_files ?? []) {
    await copyOne(resolve(REPO_ROOT, relPath), resolve(outAbs, relPath), relPath);
  }

  let overlayFilesCopied = 0;
  for (const [destRel, srcRel] of Object.entries(inventory.overlay_files ?? {})) {
    const before = copied.length;
    await copyOne(resolve(REPO_ROOT, srcRel), resolve(outAbs, destRel), srcRel);
    if (copied.length > before) overlayFilesCopied += 1;
  }

  let overlayGlobFilesCopied = 0;
  for (const [pattern, srcDirRel] of Object.entries(inventory.overlay_globs ?? {})) {
    const slash = pattern.lastIndexOf("/");
    const destDirRel = slash === -1 ? "" : pattern.slice(0, slash);
    const globBasename = slash === -1 ? pattern : pattern.slice(slash + 1);
    const srcDirAbs = resolve(REPO_ROOT, srcDirRel);
    let entries;
    try {
      entries = await readdir(srcDirAbs, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        fails.push(`missing source directory: ${srcDirRel}`);
        continue;
      }
      throw error;
    }
    const regex = globToRegExp(globBasename);
    const matches = entries.filter((entry) => entry.isFile() && regex.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of matches) {
      const before = copied.length;
      await copyOne(
        join(srcDirAbs, entry.name),
        resolve(outAbs, destDirRel, entry.name),
        posixRel(join(srcDirRel, entry.name))
      );
      if (copied.length > before) overlayGlobFilesCopied += 1;
    }
  }

  if (fails.length) {
    for (const fail of fails) console.error(`FAIL ${fail}`);
    process.exit(1);
  }

  const files = {};
  for (const destAbs of copied.sort()) {
    const content = await readFile(destAbs);
    files[posixRel(relative(outAbs, destAbs))] = sha256(content);
  }
  const manifest = {
    source_revision: sourceRevision,
    assembled_at: new Date().toISOString(),
    files
  };
  const manifestAbs = resolve(REPO_ROOT, MANIFEST_PATH);
  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Assembled public candidate at ${out}`);
  console.log(`  producer files copied: ${(inventory.producer_files ?? []).length}`);
  console.log(`  overlay files copied:  ${overlayFilesCopied}`);
  console.log(`  overlay glob files copied: ${overlayGlobFilesCopied}`);
  console.log(`  source_revision: ${sourceRevision}`);
  if (regenerated) {
    console.log(`  ${regenerated.path} ${regenerated.changed ? "updated" : "already up to date"} as the projected public inventory`);
  }
  console.log(`Manifest written to ${MANIFEST_PATH}`);
}

await main();
