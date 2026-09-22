// Gate on the assembled public candidate. Publication is one-way: once a tree
// is pushed to a public remote, every byte in it is public forever, including
// the ones nobody looked at. So this verifier works from a positive inventory
// -- config/public-candidate.json names what may be present -- and treats any
// file outside that list as a failure rather than as something to judge.
//
// A negative list (scan for secrets, ship the rest) fails open: it clears the
// files whose contents it happens to recognise. The inventory fails closed,
// which is the only posture that survives a file being added by accident.
//
// Everything here is read-only against the candidate. The single write is
// --pin, which records the reviewed hashes back into the inventory.
//
// Usage:
//   node scripts/verify-public-candidate.js --candidate <dir>
//     [--inventory config/public-candidate.json]
//     [--private-data <path>]   fail if a candidate row matches a real one
//     [--json <out>]            machine-readable report
//     [--pin]                   record current hashes as reviewed
//     [--self]                  the candidate IS this tree (shipped CI copy)
//     [--before-build]          generated files may be absent (WARN)
//     [--fresh-history]         require a one-commit, remote-free .git
//
// Exits 1 on any FAIL, 2 on a usage error, 0 otherwise.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { privateTextFindings } from "./lib/receipt-privacy.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// receipt-privacy.js owns the pattern set. These four mean "this file still
// carries something personal"; its "URL" rule is superseded by the allowlist
// below, and its "markup" rule fires on every HTML file by design.
const PRIVATE_RULES = new Set([
  "secret-like token", "authorization header", "absolute user path", "email address"
]);

// Inventory keys the rest of this script dereferences without checking again.
const REQUIRED_ARRAYS = [
  "producer_files", "generated_files", "allowed_scripts", "allowed_url_prefixes", "scan_exempt_files"
];
// Present in the producer inventory, absent from the projected copy the
// candidate ships: the scrubbing policy is itself private.
const PRODUCER_ONLY_KEYS = ["forbidden_terms", "forbidden_script_fragments", "source_revision"];
const REQUIRED_OBJECTS = [
  "license", "overlay_files", "overlay_globs", "allowed_identity_terms",
  "reserved_identities", "synthetic_dataset", "pinned"
];

const usage = (message) => {
  process.stderr.write(`${message}\nUsage: node scripts/verify-public-candidate.js --candidate <dir> ` +
    `[--inventory <path>] [--private-data <path>] [--json <out>] ` +
    `[--pin] [--self] [--before-build] [--fresh-history]\n`);
  process.exit(2);
};

// ---------------------------------------------------------------- arguments

const options = { candidate: null, inventory: null, privateData: null, json: null };
const flags = new Set();
const argv = process.argv.slice(2);
const VALUED = new Map([
  ["--candidate", "candidate"], ["--inventory", "inventory"],
  ["--private-data", "privateData"], ["--json", "json"]
]);
const BARE = new Set(["--pin", "--self", "--before-build", "--fresh-history"]);

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (VALUED.has(argument)) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`${argument} needs a value.`);
    options[VALUED.get(argument)] = value;
    index += 1;
  } else if (BARE.has(argument)) {
    flags.add(argument);
  } else {
    usage(`Unrecognised argument "${argument}".`);
  }
}
const pinning = flags.has("--pin");
const selfMode = flags.has("--self");
// In --self mode the tree that holds this script is the candidate: the shipped
// copy verifies its own repository in CI without being told where it is.
if (!options.candidate && !selfMode) usage("--candidate is required unless --self is given.");
const beforeBuild = flags.has("--before-build");
const freshHistory = flags.has("--fresh-history");
const inventoryPath = resolve(options.inventory ?? join(REPO_ROOT, "config/public-candidate.json"));
const candidateDir = resolve(options.candidate ?? REPO_ROOT);

// ------------------------------------------------------------------ results

const results = [];
const check = (name, verdict, detail = "") => results.push({ name, verdict, detail });

const report = () => {
  const width = Math.max(...results.map((result) => result.name.length));
  for (const { name, verdict, detail } of results) {
    console.log(`${verdict.padEnd(5)} ${name.padEnd(width)}${detail ? "  " + detail : ""}`);
  }
};

// Printed at the point a structural problem makes every later check meaningless
// -- an unreadable inventory cannot be used to judge anything, and continuing
// would report a long list of "ok" derived from nothing.
const bail = () => {
  report();
  const failed = results.filter((result) => result.verdict === "FAIL").length;
  console.log(`\nverification stopped: ${failed} fail.`);
  process.exit(1);
};

// ------------------------------------------------------------------ inventory

let inventoryBytes;
try {
  inventoryBytes = await readFile(inventoryPath);
} catch (error) {
  // ENOENT and EACCES are different findings, but neither yields an inventory,
  // so both stop the run -- named, so the operator knows which one happened.
  check("inventory readable", "FAIL", `${inventoryPath} (${error.code ?? error.name})`);
  bail();
}
const inventorySha = createHash("sha256").update(inventoryBytes).digest("hex");

let inventory;
try {
  inventory = JSON.parse(inventoryBytes.toString("utf8"));
} catch (error) {
  check("inventory parses as JSON", "FAIL", `${inventoryPath}: ${error.message}`);
  bail();
}

const schemaProblems = [];
if (inventory === null || typeof inventory !== "object" || Array.isArray(inventory)) {
  schemaProblems.push("inventory must be a JSON object");
} else {
  if (typeof inventory.name !== "string" || !inventory.name) schemaProblems.push("name must be a nonempty string");
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(inventory[key])) schemaProblems.push(`${key} must be an array`);
  }
  for (const key of REQUIRED_OBJECTS) {
    const value = inventory[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      schemaProblems.push(`${key} must be an object`);
    }
  }
  if (!schemaProblems.length) {
    for (const key of ["spdx", "first_line", "holder"]) {
      if (typeof inventory.license[key] !== "string") schemaProblems.push(`license.${key} must be a string`);
    }
    const dataset = inventory.synthetic_dataset;
    if (typeof dataset.path !== "string") schemaProblems.push("synthetic_dataset.path must be a string");
    const overrides = inventory.scan_overrides ?? {};
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)
      || Object.entries(overrides).some(([path, allowed]) => !path.startsWith("tests/") || !Array.isArray(allowed) || allowed.some((v) => typeof v !== "string" || !v))) {
      schemaProblems.push("scan_overrides must map tests/ paths to arrays of rule or term strings");
    }
    const binaries = inventory.binary_files ?? {};
    if (binaries === null || typeof binaries !== "object" || Array.isArray(binaries)
      || Object.values(binaries).some((type) => typeof type !== "string" || !type)) {
      schemaProblems.push("binary_files must map each path to a media type string");
    }
    if (!Array.isArray(dataset.date_range) || dataset.date_range.length !== 2) {
      schemaProblems.push("synthetic_dataset.date_range must be a two-element array");
    }
  }
}
check("inventory schema", schemaProblems.length ? "FAIL" : "ok", schemaProblems.join("; "));
if (schemaProblems.length) bail();

const sourceRevision = inventory.source_revision ?? null;

// -------------------------------------------------------------- candidate root

let candidateStat;
try {
  candidateStat = await lstat(candidateDir);
} catch (error) {
  check("candidate directory", "FAIL", `${candidateDir} (${error.code ?? error.name})`);
  bail();
}
if (!candidateStat.isDirectory()) {
  check("candidate directory", "FAIL", `${candidateDir} is not a directory`);
  bail();
}
check("candidate directory", "ok", candidateDir);

// A verifier pointed at the producer checkout would "verify" the private tree
// and report it clean against a list drawn from it. That is an invocation
// mistake rather than a finding about a candidate, so it exits 2, not 1.
if (!selfMode) {
  const [candidateReal, repoReal] = await Promise.all([
    realpath(candidateDir), realpath(REPO_ROOT)
  ]);
  if (candidateReal === repoReal) {
    usage(`--candidate resolves to the producer checkout (${repoReal}); pass an assembled candidate, or --self.`);
  }
}

// -------------------------------------------------------------------- walking

const files = [];          // candidate-relative paths, "/" separated
const symlinks = [];
const gitDirectories = [];
const unreadable = [];     // exists but could not be listed, with its code
const irregular = [];      // sockets, fifos, devices: not publishable content

async function walk(relativeDir) {
  const absolute = relativeDir ? join(candidateDir, relativeDir) : candidateDir;
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    // Every code lands here, ENOENT included: the root was proven to exist
    // before the walk started, so a directory that cannot be listed now means
    // part of the tree went unexamined. An unexamined part cannot be cleared.
    unreadable.push(`${relativeDir || "."} (${error.code ?? error.name})`);
    return;
  }
  for (const entry of entries) {
    const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      // Never followed: the target may sit outside the candidate entirely, and
      // what a published symlink resolves to is not what was reviewed.
      symlinks.push(path);
    } else if (entry.isDirectory()) {
      if (entry.name === ".git") gitDirectories.push(path);
      else await walk(path);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      irregular.push(path);
    }
  }
}
await walk("");
files.sort();

// In --self mode the candidate is a live working checkout, so the walk also
// picks up whatever the developer's tools left lying around: an editor's dot
// directory, an agent's scratch state, a local research cache. None of those
// can reach a published candidate, because git never carries them, so counting
// them as inventory extras reports a leak that cannot exist and trains the
// reader to ignore this check. A path is dropped only when git says it is
// ignored AND does not track it; a tracked file stays in scope even if a
// pattern would otherwise match it, which is the case a stale rule could hide.
let ignoredCount = 0;
if (selfMode) {
  const runGit = (args, input) => {
    const result = spawnSync("git", ["-C", candidateDir, ...args], {
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    // status 1 from check-ignore means "nothing matched", which is not a failure.
    if (result.error || (result.status !== 0 && result.status !== 1)) return null;
    return result.stdout.split("\0").filter(Boolean);
  };
  const tracked = runGit(["ls-files", "-z"], undefined);
  const ignored = runGit(["check-ignore", "--stdin", "-z", "-z"], files.join("\0"));
  if (tracked === null || ignored === null) {
    // Without both answers the filter cannot be applied safely, so nothing is
    // dropped: a noisy extras list beats a silently narrowed scan.
    check("working-tree state excluded", "WARN", "git unavailable; ignored paths stay in scope");
  } else {
    const trackedSet = new Set(tracked);
    const drop = new Set(ignored.filter((path) => !trackedSet.has(path)));
    ignoredCount = drop.size;
    if (drop.size) {
      const kept = files.filter((path) => !drop.has(path));
      files.length = 0;
      files.push(...kept);
    }
  }
}

if (ignoredCount) check("git-ignored working state excluded", "ok", `${ignoredCount} path(s) git ignores and does not track`);
check("candidate fully walkable", unreadable.length ? "FAIL" : "ok",
  unreadable.length ? `cannot list: ${unreadable.join(", ")} — the tree cannot be cleared` : "");
check("no symlinks in candidate", symlinks.length ? "FAIL" : "ok",
  symlinks.slice(0, 8).join(", "));
check("no irregular files in candidate", irregular.length ? "FAIL" : "ok",
  irregular.slice(0, 8).join(", "));
if (unreadable.length) bail();

// ------------------------------------------------------------ expected sets

const producerFiles = inventory.producer_files.filter((path) => typeof path === "string");
const overlayKeys = Object.keys(inventory.overlay_files);
const generatedFiles = inventory.generated_files.filter((path) => typeof path === "string");
// A command may leave a file behind that a fresh clone does not have, such as
// the evidence ledger an import creates. Optional generated files are
// inventoried when present and never required.
const optionalGenerated = (inventory.optional_generated_files ?? []).filter((path) => typeof path === "string");
const globPatterns = Object.keys(inventory.overlay_globs);

// Patterns are shell-simple by design: a literal directory prefix and a single
// "*" in the basename. Anything richer invites a pattern that quietly widens
// the allowed set, which is the one thing the inventory exists to prevent.
const globMatches = (pattern, path) => {
  const source = pattern.split("/").map((segment) => segment
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*")).join("/");
  return new RegExp(`^${source}$`).test(path);
};

const globbed = new Map(globPatterns.map((pattern) => [pattern, files.filter((path) => globMatches(pattern, path))]));
const listed = new Set([...producerFiles, ...overlayKeys, ...generatedFiles, ...optionalGenerated, ...[...globbed.values()].flat()]);
const present = new Set(files);

const missingRequired = [...producerFiles, ...overlayKeys].filter((path) => !present.has(path));
const missingGenerated = generatedFiles.filter((path) => !present.has(path));
const emptyGlobs = [...globbed.entries()].filter(([, matched]) => !matched.length).map(([pattern]) => pattern);
const extras = files.filter((path) => !listed.has(path));

check("every inventoried file present", missingRequired.length ? "FAIL" : "ok",
  missingRequired.length ? `missing: ${missingRequired.slice(0, 10).join(", ")}` : "");
check("generated files present", missingGenerated.length ? (beforeBuild ? "WARN" : "FAIL") : "ok",
  missingGenerated.length
    ? `${beforeBuild ? "not built yet" : "missing"}: ${missingGenerated.join(", ")}`
    : "");
check("overlay globs match files", emptyGlobs.length ? "WARN" : "ok",
  emptyGlobs.length ? `matched nothing: ${emptyGlobs.join(", ")}` : "");
check("no files outside the inventory", extras.length ? "FAIL" : "ok",
  extras.length ? `extra: ${extras.slice(0, 20).join(", ")}${extras.length > 20 ? ` (+${extras.length - 20} more)` : ""}` : "");

// .git, plus the dotfiles that carry provenance nobody meant to publish.
// In --self mode the tree is a checkout of the published repository, so its
// own .git is expected; an assembled candidate has none, and --fresh-history
// requires exactly one.
const gitProblems = freshHistory
  ? (gitDirectories.length ? [] : ["--fresh-history given but the candidate has no .git"])
  : selfMode
    ? gitDirectories.filter((path) => path !== ".git").map((path) => `${path} present (nested repository)`)
    : gitDirectories.map((path) => `${path} present (history is not assembled output)`);
const ALWAYS_FORBIDDEN = new Set([".gitmodules", ".DS_Store"]);
const dotProblems = files.filter((path) => {
  const segments = path.split("/");
  if (segments.some((segment) => ALWAYS_FORBIDDEN.has(segment))) return true;
  return segments.some((segment) => segment.startsWith(".")) && !listed.has(path);
});
check("no stray git or dot entries", gitProblems.length || dotProblems.length ? "FAIL" : "ok",
  [...gitProblems, ...dotProblems.slice(0, 8)].join("; "));

// .github/ runs on GitHub's infrastructure, so an unreviewed file there is a
// workflow nobody read, not just a stray byte.
const githubStrays = files.filter((path) => path.startsWith(".github/") && !overlayKeys.includes(path));
check(".github holds only overlay files", githubStrays.length ? "FAIL" : "ok",
  githubStrays.slice(0, 8).join(", "));

// -------------------------------------------------------------------- hashing

const contents = new Map();   // path -> Buffer
const hashes = {};            // path -> sha256, for the report and for pinning
const unreadableFiles = [];

for (const path of files) {
  try {
    contents.set(path, await readFile(join(candidateDir, path)));
  } catch (error) {
    // Same classification as the directory walk: a file that cannot be read
    // cannot be scanned, and an unscanned file is not a cleared one.
    unreadableFiles.push(`${path} (${error.code ?? error.name})`);
  }
}
for (const [path, buffer] of contents) {
  hashes[path] = createHash("sha256").update(buffer).digest("hex");
}
check("every candidate file readable", unreadableFiles.length ? "FAIL" : "ok",
  unreadableFiles.slice(0, 8).join(", "));

const pinned = inventory.pinned;
const pinnedPaths = Object.keys(pinned);
if (pinning) {
  check("pinned hashes match", "ok", "skipped: --pin rewrites the pinned map");
} else if (!pinnedPaths.length) {
  check("pinned hashes match", "WARN", "unpinned: no reviewed hashes recorded yet");
} else {
  const drift = pinnedPaths
    .filter((path) => pinned[path] !== hashes[path])
    .map((path) => `${path}: ${hashes[path] ? "changed" : "absent"}`);
  check("pinned hashes match", drift.length ? "FAIL" : "ok",
    drift.length ? drift.slice(0, 10).join(", ") : `${pinnedPaths.length} pinned`);
}

// --------------------------------------------------------------- binaries

// A binary file cannot be text-cleared, so it is admitted only with a declared
// media type and a structural check for that type. PNG is the only type today.
// Text and EXIF chunks are refused outright: they are where a screenshot tool
// writes an author, a software name, or the path the file was saved to.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

function pngFindings(buffer) {
  const problems = [];
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return ["not a PNG: signature missing"];
  }
  let offset = 8;
  let first = null;
  let last = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) { problems.push(`malformed chunk type at byte ${offset}`); break; }
    first ??= type;
    last = type;
    if (PNG_METADATA_CHUNKS.has(type)) problems.push(`${type} metadata chunk present`);
    offset += 12 + length;   // length, type, data, crc
  }
  if (offset !== buffer.length) problems.push("chunk lengths do not add up to the file length");
  if (first !== "IHDR") problems.push("first chunk is not IHDR");
  if (last !== "IEND") problems.push("last chunk is not IEND");
  return problems;
}

const BINARY_CHECKS = new Map([["image/png", pngFindings]]);
const binaryFiles = inventory.binary_files ?? {};

// ----------------------------------------------------------------- text scan

const scanExempt = new Set(inventory.scan_exempt_files);
const projectedKeys = Object.keys(inventory).filter((key) => !PRODUCER_ONLY_KEYS.includes(key)).concat("note_projection").filter((key, index, all) => all.indexOf(key) === index).sort().join(",");
const decoder = new TextDecoder("utf-8", { fatal: true });

const findings = [];       // every finding, counted in full
const undecodable = [];
let scanned = 0;
// A test of the privacy scanner has to contain what the scanner rejects. The
// inventory may name, per test file, the rules or terms that file is allowed
// to trigger; anything else in it still counts.
const scanOverrides = inventory.scan_overrides ?? {};
const note = (path, line, rule, detail) => {
  const allowed = scanOverrides[path];
  if (allowed && (allowed.includes(rule) || allowed.includes(detail))) return;
  findings.push({ path, line, rule, detail });
};

// Trailing punctuation belongs to the prose around a URL, not to the URL.
// A template literal such as `http://${host}` is code, not a destination; the
// lookahead skips it. Everything else that looks like a URL is checked.
const URL_PATTERN = /(?:https?|file):\/\/(?!\$\{)[^\s"'`<>()[\]{},;\\]+/gi;
const trimUrl = (url) => url.replace(/[.,:;!?]+$/, "");

const identityTerms = Object.entries(inventory.allowed_identity_terms)
  .filter(([, allowed]) => Array.isArray(allowed));

for (const path of files) {
  const buffer = contents.get(path);
  if (!buffer) continue;   // already reported as unreadable above

  if (Object.hasOwn(binaryFiles, path)) {
    const type = binaryFiles[path];
    const inspect = BINARY_CHECKS.get(type);
    if (!inspect) { note(path, 0, "unsupported binary type", type); continue; }
    for (const problem of inspect(buffer)) note(path, 0, `binary ${type}`, problem);
    continue;
  }

  if (scanExempt.has(path)) {
    // The inventory names the very terms it bans, so scanning it for them would
    // always fail. It is checked structurally instead: same shape, still JSON.
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(buffer));
    } catch (error) {
      note(path, 0, "exempt file is not parseable JSON", error.message);
      continue;
    }
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).sort().join(",")
      : null;
    if (keys !== projectedKeys) note(path, 0, "exempt file schema differs from the inventory", "top-level keys do not match the projected public inventory");
    for (const key of PRODUCER_ONLY_KEYS) {
      if (parsed && Object.hasOwn(parsed, key)) note(path, 0, "producer-only policy in the public inventory", key);
    }
    // Exempt from the term scan only. Secret shapes, user paths, and URLs are
    // still checked, line by line, like any other file.
    decoder.decode(buffer).split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(URL_PATTERN)) {
        const url = trimUrl(match[0]);
        if (!inventory.allowed_url_prefixes.some((prefix) => url.startsWith(prefix))) note(path, index + 1, "URL outside the allowlist", url);
      }
      for (const rule of privateTextFindings(line)) {
        if (PRIVATE_RULES.has(rule) && rule !== "absolute user path") note(path, index + 1, rule, "");
      }
    });
    continue;
  }

  let text;
  try {
    text = decoder.decode(buffer);
  } catch {
    // Content that does not decode cannot be read, and content that cannot be
    // read cannot be cleared for publication. A deliberately binary file is
    // declared in binary_files and checked structurally instead.
    undecodable.push(path);
    continue;
  }

  scanned += 1;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    for (const term of inventory.forbidden_terms ?? []) {
      if (typeof term === "string" && term && line.includes(term)) {
        note(path, lineNo, "forbidden term", term);
      }
    }
    for (const [term, allowed] of identityTerms) {
      if (line.includes(term) && !allowed.includes(path)) {
        note(path, lineNo, "identity term outside its allowed files", term);
      }
    }
    for (const match of line.matchAll(URL_PATTERN)) {
      const url = trimUrl(match[0]);
      if (!inventory.allowed_url_prefixes.some((prefix) => url.startsWith(prefix))) {
        note(path, lineNo, "URL outside the allowlist", url);
      }
    }
    for (const rule of privateTextFindings(line)) {
      if (PRIVATE_RULES.has(rule)) note(path, lineNo, rule, "");
    }
  });
}

check("every scanned file decodes as UTF-8", undecodable.length ? "FAIL" : "ok",
  undecodable.length ? `${undecodable.join(", ")} — cannot be text-cleared` : "");
check("no private content in candidate text", findings.length ? "FAIL" : "ok",
  findings.length ? `${findings.length} findings` : `${scanned} files scanned`);

// ---------------------------------------------------------------- dataset

const datasetPath = inventory.synthetic_dataset.path;
const datasetProblems = [];
let datasetRows = null;

const datasetBuffer = contents.get(datasetPath);
if (!datasetBuffer) {
  datasetProblems.push(`${datasetPath} is absent or unreadable`);
} else {
  try {
    datasetRows = JSON.parse(datasetBuffer.toString("utf8"));
  } catch (error) {
    datasetProblems.push(`${datasetPath} does not parse: ${error.message}`);
  }
}

const origins = new Set(inventory.reserved_identities.origins ?? []);
const accountAliases = new Set(inventory.reserved_identities.account_aliases ?? []);
const machineAliases = new Set(inventory.reserved_identities.machine_aliases ?? []);

const triples = new Set();
if (datasetRows !== null) {
  if (!Array.isArray(datasetRows)) {
    datasetProblems.push(`${datasetPath} must be an array`);
  } else {
    const [from, to] = inventory.synthetic_dataset.date_range;
    const prefix = inventory.synthetic_dataset.evidence_prefix;
    const maxRows = inventory.synthetic_dataset.max_rows;
    if (Number.isInteger(maxRows) && datasetRows.length > maxRows) {
      datasetProblems.push(`${datasetRows.length} rows exceeds max_rows ${maxRows}`);
    }
    for (const row of datasetRows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        datasetProblems.push("a row is not an object");
        continue;
      }
      if (typeof row.date !== "string" || row.date < from || row.date > to) {
        datasetProblems.push(`row date ${JSON.stringify(row.date)} is outside ${from}..${to}`);
      }
      if (Object.hasOwn(row, "evidence") && typeof prefix === "string" &&
          !(typeof row.evidence === "string" && row.evidence.startsWith(prefix))) {
        datasetProblems.push(`${row.date} evidence does not begin with "${prefix}"`);
      }
      const sources = row.sources;
      if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
        datasetProblems.push(`${row.date} has no sources object`);
        continue;
      }
      for (const [source, entry] of Object.entries(sources)) {
        if (entry === null || typeof entry !== "object") {
          datasetProblems.push(`${row.date} source ${source} is not an object`);
          continue;
        }
        if (!["exact", "estimated"].includes(entry.fidelity)) {
          datasetProblems.push(`${row.date} source ${source} fidelity ${JSON.stringify(entry.fidelity)} must be exact or estimated`);
        }
        triples.add(`${row.date} ${source} ${entry.tokens}`);
        for (const origin of Object.keys(entry.by_origin ?? {})) {
          if (!origins.has(origin)) datasetProblems.push(`${row.date} source ${source} origin "${origin}" is not reserved`);
        }
      }
    }
  }
}

// Fixture receipts carry the same identities as the dataset and are just as
// publishable, so they are held to the same reserved list.
let malformedFixtureLines = 0;
for (const path of files.filter((candidate) => globMatches("fixtures/receipts/*.jsonl", candidate))) {
  const buffer = contents.get(path);
  if (!buffer) continue;
  buffer.toString("utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let receipt;
    try {
      receipt = JSON.parse(line);
    } catch {
      // Counted rather than dropped: a malformed line is content nobody read.
      malformedFixtureLines += 1;
      datasetProblems.push(`${path}:${index + 1} is malformed JSON; its identities are unknown`);
      return;
    }
    for (const [field, allowed] of [
      ["origin", origins], ["machine_alias", machineAliases], ["account_alias", accountAliases]
    ]) {
      const value = receipt?.[field];
      if (value !== undefined && !allowed.has(value)) {
        datasetProblems.push(`${path}:${index + 1} ${field} "${value}" is not reserved`);
      }
    }
  });
}

check("synthetic dataset and fixtures are synthetic", datasetProblems.length ? "FAIL" : "ok",
  datasetProblems.length
    ? `${datasetProblems.length} problems: ${datasetProblems.slice(0, 6).join("; ")}`
    : `${Array.isArray(datasetRows) ? datasetRows.length : 0} rows, ${malformedFixtureLines} malformed fixture lines`);

// The overlap check proves the candidate is not the private record with the
// names filed off. Only the count is ever printed; the private rows are read
// to build a comparison set and are never echoed, logged, or written out.
if (options.privateData) {
  let privateTriples = null;
  try {
    const parsed = JSON.parse(await readFile(resolve(options.privateData), "utf8"));
    privateTriples = new Set();
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        for (const [source, entry] of Object.entries(row?.sources ?? {})) {
          privateTriples.add(`${row.date} ${source} ${entry?.tokens}`);
        }
      }
    }
  } catch (error) {
    check("no overlap with the private dataset", "FAIL",
      `private dataset unreadable (${error.code ?? error.name}); overlap unknown`);
  }
  if (privateTriples) {
    const overlap = [...triples].filter((triple) => privateTriples.has(triple)).length;
    check("no overlap with the private dataset", overlap ? "FAIL" : "ok",
      overlap ? `${overlap} (date, source, tokens) triples also appear in the private record` : "no shared triples");
  }
}

// ------------------------------------------------------- licence and manifest

const licenseBuffer = contents.get("LICENSE");
if (!licenseBuffer) {
  check("LICENSE states the declared licence and holder", "FAIL", "LICENSE is absent or unreadable");
} else {
  const licenseLines = licenseBuffer.toString("utf8").split(/\r?\n/);
  const firstLine = licenseLines.find((line) => line.trim())?.trim() ?? "";
  const copyright = licenseLines.filter((line) => line.includes("Copyright"));
  const problems = [];
  if (firstLine !== inventory.license.first_line) {
    problems.push(`first line is "${firstLine}", expected "${inventory.license.first_line}"`);
  }
  if (!copyright.length) problems.push("no Copyright line");
  else if (!copyright.some((line) => line.includes(inventory.license.holder))) {
    problems.push(`no Copyright line names "${inventory.license.holder}"`);
  }
  check("LICENSE states the declared licence and holder", problems.length ? "FAIL" : "ok", problems.join("; "));
}

const manifestBuffer = contents.get("package.json");
if (!manifestBuffer) {
  check("package.json is publishable", "FAIL", "package.json is absent or unreadable");
} else {
  const problems = [];
  let manifest = null;
  try {
    manifest = JSON.parse(manifestBuffer.toString("utf8"));
  } catch (error) {
    problems.push(`does not parse: ${error.message}`);
  }
  if (manifest) {
    if (manifest.name !== inventory.name) problems.push(`name "${manifest.name}" is not "${inventory.name}"`);
    if (manifest.license !== inventory.license.spdx) problems.push(`license "${manifest.license}" is not "${inventory.license.spdx}"`);
    // "private": true is what stops an accidental npm publish, and is exactly
    // what must be gone before this tree becomes a public package.
    if (manifest.private !== undefined && manifest.private !== false) problems.push('"private" must be absent or false');
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const declared = Object.keys(manifest[field] ?? {});
      if (declared.length) problems.push(`${field} declares ${declared.join(", ")}; this project has none`);
    }
    for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
      if (!inventory.allowed_scripts.includes(name)) problems.push(`script "${name}" is not in allowed_scripts`);
      const fragment = (inventory.forbidden_script_fragments ?? []).find((needle) => String(value).includes(needle));
      if (fragment) problems.push(`script "${name}" references "${fragment}"`);
    }
  }
  check("package.json is publishable", problems.length ? "FAIL" : "ok", problems.slice(0, 8).join("; "));
}

// ------------------------------------------------------------- fresh history

if (freshHistory) {
  const problems = [];
  const git = (...args) => execFileSync("git", ["-C", candidateDir, ...args], { encoding: "utf8" });
  try {
    const commits = git("rev-list", "--all", "--count").trim();
    if (commits !== "1") problems.push(`${commits} commits; a fresh history has exactly 1`);
    const remotes = git("remote").trim();
    if (remotes) problems.push(`remotes configured: ${remotes.split("\n").join(", ")}`);
    const tags = git("tag").trim();
    if (tags) problems.push(`tags present: ${tags.split("\n").join(", ")}`);
    const status = git("status", "--porcelain").trim();
    if (status) problems.push(`working tree is not clean (${status.split("\n").length} entries)`);
    // A file the inventory names but the repository ignores exists on this
    // disk and nowhere else: a clone would fail its own inventory.
    const tracked = new Set(git("ls-files").trim().split("\n"));
    const untracked = [...present].filter((path) => listed.has(path) && !tracked.has(path)).sort();
    if (untracked.length) problems.push(`inventoried but not tracked: ${untracked.slice(0, 8).join(", ")}${untracked.length > 8 ? ` and ${untracked.length - 8} more` : ""}`);
  } catch (error) {
    // A git that will not answer leaves the history unknown, which is a finding
    // in its own right: summarised, never echoed wholesale.
    const stderr = String(error.stderr ?? error.message).trim().split("\n")[0] ?? "no detail";
    problems.push(`git failed: ${stderr}`);
  }
  check("history is a single local commit", problems.length ? "FAIL" : "ok", problems.join("; "));
}

// ---------------------------------------------------------------- pinning

// Pinning records a reviewed state, so it only runs over a candidate that has
// nothing outstanding. Pinning a failing tree would freeze the failure into the
// inventory and make every later run agree with it.
if (pinning) {
  if (results.some((result) => result.verdict === "FAIL")) {
    check("pinned hashes recorded", "FAIL", "not pinned: resolve the failures above first");
  } else {
    // scan_exempt_files hold the inventory itself. Pinning its hash into the
    // file being written changes the bytes that hash describes, so the entry
    // would be stale the instant it is saved.
    inventory.pinned = Object.fromEntries(
      Object.entries(hashes).filter(([path]) => !scanExempt.has(path)).sort(([a], [b]) => a.localeCompare(b))
    );
    const temporary = `${inventoryPath}.tmp-${process.pid}`;
    try {
      // Same directory as the target, so the rename is a same-device atomic
      // replace rather than a copy that can be interrupted half-written.
      await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`);
      await rename(temporary, inventoryPath);
      check("pinned hashes recorded", "ok", `${Object.keys(inventory.pinned).length} hashes written to ${inventoryPath}`);
    } catch (error) {
      // A read-only inventory leaves the file untouched, which is safe, but the
      // operator must know the pin did not happen rather than assume it did.
      await rm(temporary, { force: true });
      check("pinned hashes recorded", "FAIL", `${error.code ?? error.name}: inventory unchanged`);
    }
  }
}

// -------------------------------------------------------------------- output

report();

if (findings.length) {
  console.log("");
  for (const finding of findings.slice(0, 50)) {
    console.log(`  ${finding.path}:${finding.line}  ${finding.rule}${finding.detail ? `  ${finding.detail}` : ""}`);
  }
  if (findings.length > 50) console.log(`  ...and ${findings.length - 50} more findings`);
}

const failed = results.filter((result) => result.verdict === "FAIL");
const warned = results.filter((result) => result.verdict === "WARN");
const verdict = failed.length ? "fail" : "pass";
console.log(`\n${files.length} candidate files, ${findings.length} findings: ` +
  `${results.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail.`);

if (options.json) {
  await writeFile(resolve(options.json), `${JSON.stringify({
    inventory_sha256: inventorySha,
    candidate_dir: candidateDir,
    source_revision: sourceRevision,
    checks: results,
    files: hashes,
    findings_count: findings.length,
    verdict
  }, null, 2)}\n`);
}

if (failed.length) process.exit(1);
