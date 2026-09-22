// Every fixture here is synthetic and lives in a temp directory. The tests
// build their own tiny inventory rather than leaning on
// config/public-candidate.json, so a change to the real file list cannot turn
// a passing verifier into a failing test, or the reverse.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const command = join(repo, "scripts/verify-public-candidate.js");

const INVENTORY = {
  schema_version: 1,
  name: "example-watch",
  license: { spdx: "MIT", first_line: "MIT License", holder: "Example Holder LLC" },
  source_revision: "0000000000000000000000000000000000000000",
  producer_files: ["scripts/build.js"],
  overlay_files: { "LICENSE": "candidate/LICENSE", "package.json": "candidate/package.json", "README.md": "candidate/README.md", "public/data/daily-burn.json": "candidate/public/data/daily-burn.json" },
  overlay_globs: { "fixtures/receipts/*.jsonl": "candidate/fixtures/receipts/" },
  generated_files: ["docs/index.html"],
  allowed_scripts: ["build", "test"],
  forbidden_script_fragments: ["extract-", "refresh-"],
  forbidden_terms: ["ACME-INTERNAL", "docs2B"],
  allowed_identity_terms: { "Example Holder": ["LICENSE", "README.md"] },
  allowed_url_prefixes: ["https://example.com/", "http://localhost"],
  reserved_identities: {
    origins: ["machine/example", "fixture/store"],
    account_aliases: ["example"],
    machine_aliases: ["example"]
  },
  synthetic_dataset: {
    path: "public/data/daily-burn.json",
    evidence_prefix: "synthetic:",
    date_range: ["2025-01-01", "2025-12-31"],
    max_rows: 400
  },
  pinned: {},
  scan_exempt_files: []
};

const ROW = {
  date: "2025-03-04",
  timezone: "UTC",
  driver: "building:feature",
  evidence: "synthetic: example work family",
  total: 1200,
  sources: { example_tool: { tokens: 1200, calls: 3, fidelity: "exact", by_origin: { "machine/example": 1200 } } }
};

const RECEIPT = {
  schema_version: 2,
  date: "2025-03-04",
  source: "example_tool",
  origin: "fixture/store",
  account_alias: "example",
  machine_alias: "example",
  tokens: 1200,
  calls: 3,
  fidelity: "exact",
  provenance: "synthetic fixture"
};

// A candidate that satisfies every rule. Each negative test copies it and
// breaks exactly one thing, so a failure names the rule under test.
const buildCandidate = async (t, overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), "dw-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const inventoryPath = join(root, "inventory.json");

  const write = async (relative, body) => {
    const path = join(candidate, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };

  await write("LICENSE", "MIT License\n\nCopyright (c) 2025 Example Holder LLC\n\nPermission is hereby granted.\n");
  await write("package.json", JSON.stringify({
    name: "example-watch", version: "0.1.0", license: "MIT", type: "module",
    scripts: { build: "node scripts/build.js", test: "node --test tests/*.test.js" }
  }, null, 2) + "\n");
  await write("README.md", "# Example Watch\n\nBy Example Holder LLC. See https://example.com/docs for more.\n");
  await write("scripts/build.js", "export const build = () => \"ok\";\n");
  await write("public/data/daily-burn.json", JSON.stringify([ROW], null, 2) + "\n");
  await write("fixtures/receipts/example.jsonl", JSON.stringify(RECEIPT) + "\n");
  await write("docs/index.html", "<!doctype html><title>Example Watch</title><p>1200 tokens</p>\n");

  const inventory = { ...INVENTORY, ...overrides };
  await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");
  return { root, candidate, inventoryPath, write };
};

const run = (fixture, ...extra) => spawnSync(
  process.execPath,
  [command, "--candidate", fixture.candidate, "--inventory", fixture.inventoryPath, ...extra],
  { encoding: "utf8" }
);

const output = (result) => `${result.stdout}${result.stderr}`;

test("a minimal well-formed candidate passes", async (t) => {
  const fixture = await buildCandidate(t);
  const result = run(fixture);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /0 fail\./);
  // No pins recorded yet, so the run is clean but explicitly unreviewed.
  assert.match(result.stdout, /WARN.*pinned hashes match.*unpinned/);
});

test("an extra file is named and fails", async (t) => {
  const fixture = await buildCandidate(t);
  await fixture.write("notes/leftover.txt", "nothing to see\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no files outside the inventory/);
  assert.match(result.stdout, /notes\/leftover\.txt/);
});

test("a listed file that is missing is named and fails", async (t) => {
  const fixture = await buildCandidate(t);
  await rm(join(fixture.candidate, "scripts/build.js"));
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /every inventoried file present/);
  assert.match(result.stdout, /scripts\/build\.js/);
});

test("generated files are a WARN before the build and a FAIL after it", async (t) => {
  const fixture = await buildCandidate(t);
  await rm(join(fixture.candidate, "docs/index.html"));
  const after = run(fixture);
  assert.equal(after.status, 1);
  assert.match(after.stdout, /FAIL.*generated files present/);

  const before = run(fixture, "--before-build");
  assert.equal(before.status, 0, output(before));
  assert.match(before.stdout, /WARN.*generated files present.*not built yet/);
});

test("a symlink anywhere in the candidate fails without being followed", async (t) => {
  const fixture = await buildCandidate(t);
  await symlink(join(fixture.candidate, "README.md"), join(fixture.candidate, "docs/link.md"));
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*no symlinks in candidate/);
  assert.match(result.stdout, /docs\/link\.md/);
});

test("a .git directory fails unless a fresh history was asked for", async (t) => {
  const fixture = await buildCandidate(t);
  await mkdir(join(fixture.candidate, ".git"));
  await writeFile(join(fixture.candidate, ".git/HEAD"), "ref: refs/heads/main\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*no stray git or dot entries/);
  assert.match(result.stdout, /\.git present/);
});

test("stray dotfiles and .DS_Store fail", async (t) => {
  const fixture = await buildCandidate(t);
  await writeFile(join(fixture.candidate, ".DS_Store"), "\0\0\0");
  await writeFile(join(fixture.candidate, ".env.local"), "EXAMPLE_KEY=unset\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*no stray git or dot entries/);
  assert.match(result.stdout, /\.DS_Store/);
  assert.match(result.stdout, /\.env\.local/);
});

test("a forbidden term fails with its file and line", async (t) => {
  const fixture = await buildCandidate(t);
  await fixture.write("README.md", "# Example Watch\n\nBy Example Holder LLC.\nBuilt into docs2B for staging.\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /README\.md:4 {2}forbidden term {2}docs2B/);
});

test("an identity term fails outside its allowed files and passes inside them", async (t) => {
  const allowed = await buildCandidate(t);
  assert.equal(run(allowed).status, 0, output(run(allowed)));

  const disallowed = await buildCandidate(t);
  await disallowed.write("scripts/build.js", "// maintained by Example Holder LLC\nexport const build = () => \"ok\";\n");
  const result = run(disallowed);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /scripts\/build\.js:1 {2}identity term outside its allowed files {2}Example Holder/);
});

test("a URL outside the allowlist is reported in full", async (t) => {
  const fixture = await buildCandidate(t);
  await fixture.write("README.md", "# Example Watch\n\nBy Example Holder LLC.\nSee https://elsewhere.invalid/page for details.\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /README\.md:4 {2}URL outside the allowlist {2}https:\/\/elsewhere\.invalid\/page/);
});

test("a secret-shaped token, an absolute user path and an email address all fail", async (t) => {
  const fixture = await buildCandidate(t);
  const token = `sk-${"x".repeat(32)}`;
  await fixture.write("scripts/build.js", `// key ${token}\n// from /Users/example/project\n// contact nobody@example.invalid\nexport const build = () => "ok";\n`);
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /scripts\/build\.js:1 {2}secret-like token/);
  assert.match(result.stdout, /scripts\/build\.js:2 {2}absolute user path/);
  assert.match(result.stdout, /scripts\/build\.js:3 {2}email address/);
});

test("a LICENSE with the wrong first line or no holder fails", async (t) => {
  const wrongLine = await buildCandidate(t);
  await wrongLine.write("LICENSE", "Apache License\n\nCopyright (c) 2025 Example Holder LLC\n");
  const first = run(wrongLine);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /FAIL.*LICENSE states the declared licence and holder/);
  assert.match(first.stdout, /first line is "Apache License"/);

  const noHolder = await buildCandidate(t);
  await noHolder.write("LICENSE", "MIT License\n\nCopyright (c) 2025 Somebody Else\n");
  const second = run(noHolder);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /no Copyright line names "Example Holder LLC"/);
});

test("package.json fails on dependencies, unlisted scripts, forbidden fragments and private:true", async (t) => {
  const manifest = (extra) => JSON.stringify({
    name: "example-watch", version: "0.1.0", license: "MIT", type: "module",
    scripts: { build: "node scripts/build.js" }, ...extra
  }, null, 2) + "\n";

  const withDependency = await buildCandidate(t);
  await withDependency.write("package.json", manifest({ dependencies: { chalk: "^5.0.0" } }));
  const dependency = run(withDependency);
  assert.equal(dependency.status, 1);
  assert.match(dependency.stdout, /dependencies declares chalk/);

  const withScript = await buildCandidate(t);
  await withScript.write("package.json", manifest({ scripts: { build: "node scripts/build.js", publish: "npm publish" } }));
  const script = run(withScript);
  assert.equal(script.status, 1);
  assert.match(script.stdout, /script "publish" is not in allowed_scripts/);

  const withFragment = await buildCandidate(t);
  await withFragment.write("package.json", manifest({ scripts: { build: "node scripts/extract-codex.js" } }));
  const fragment = run(withFragment);
  assert.equal(fragment.status, 1);
  assert.match(fragment.stdout, /script "build" references "extract-"/);

  const stillPrivate = await buildCandidate(t);
  await stillPrivate.write("package.json", manifest({ private: true }));
  const isPrivate = run(stillPrivate);
  assert.equal(isPrivate.status, 1);
  assert.match(isPrivate.stdout, /"private" must be absent or false/);
});

test("the synthetic dataset fails on sample fidelity, a date outside the range, a bad evidence prefix and an unreserved origin", async (t) => {
  const mutate = async (change) => {
    const fixture = await buildCandidate(t);
    const row = structuredClone(ROW);
    change(row);
    await fixture.write("public/data/daily-burn.json", JSON.stringify([row], null, 2) + "\n");
    return run(fixture);
  };

  const sample = await mutate((row) => { row.sources.example_tool.fidelity = "sample"; });
  assert.equal(sample.status, 1);
  assert.match(sample.stdout, /fidelity "sample" must be exact or estimated/);

  const outside = await mutate((row) => { row.date = "2024-12-31"; });
  assert.equal(outside.status, 1);
  assert.match(outside.stdout, /row date "2024-12-31" is outside 2025-01-01\.\.2025-12-31/);

  const evidence = await mutate((row) => { row.evidence = "a real work description"; });
  assert.equal(evidence.status, 1);
  assert.match(evidence.stdout, /evidence does not begin with "synthetic:"/);

  const origin = await mutate((row) => { row.sources.example_tool.by_origin = { "machine/real-laptop": 1200 }; });
  assert.equal(origin.status, 1);
  assert.match(origin.stdout, /origin "machine\/real-laptop" is not reserved/);
});

test("a fixture receipt with an unreserved origin fails", async (t) => {
  const fixture = await buildCandidate(t);
  await fixture.write("fixtures/receipts/example.jsonl",
    JSON.stringify({ ...RECEIPT, origin: "machine/real-laptop" }) + "\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /origin "machine\/real-laptop" is not reserved/);
});

test("an overlapping private triple fails, reporting only the count", async (t) => {
  const fixture = await buildCandidate(t);
  // Same (date, source, tokens) as the candidate row, plus a row that must
  // never be echoed anywhere in the verifier's output.
  const privatePath = join(fixture.root, "private.json");
  await writeFile(privatePath, JSON.stringify([
    { date: "2025-03-04", sources: { example_tool: { tokens: 1200, fidelity: "exact" } } },
    { date: "2025-03-05", sources: { secret_tool: { tokens: 987654321, fidelity: "exact" } } }
  ]) + "\n");
  const result = run(fixture, "--private-data", privatePath);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*no overlap with the private dataset/);
  assert.match(result.stdout, /1 \(date, source, tokens\) triples/);
  assert.doesNotMatch(output(result), /secret_tool|987654321|2025-03-05/);
});

test("a non-overlapping private dataset passes", async (t) => {
  const fixture = await buildCandidate(t);
  const privatePath = join(fixture.root, "private.json");
  await writeFile(privatePath, JSON.stringify([
    { date: "2025-03-04", sources: { example_tool: { tokens: 999, fidelity: "exact" } } }
  ]) + "\n");
  const result = run(fixture, "--private-data", privatePath);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /ok.*no overlap with the private dataset/);
});

test("a pinned hash mismatch fails, and --pin records hashes that then match", async (t) => {
  const fixture = await buildCandidate(t, { pinned: { "README.md": "0".repeat(64) } });
  const mismatch = run(fixture);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /FAIL.*pinned hashes match/);
  assert.match(mismatch.stdout, /README\.md: changed/);

  const pinned = run(fixture, "--pin");
  assert.equal(pinned.status, 0, output(pinned));
  const inventory = JSON.parse(await readFile(fixture.inventoryPath, "utf8"));
  assert.equal(Object.keys(inventory.pinned).length, 7);
  assert.match(inventory.pinned["README.md"], /^[a-f0-9]{64}$/);

  const rerun = run(fixture);
  assert.equal(rerun.status, 0, output(rerun));
  assert.match(rerun.stdout, /ok.*pinned hashes match.*7 pinned/);
});

test("--pin refuses to record a failing candidate", async (t) => {
  const fixture = await buildCandidate(t);
  await fixture.write("notes/leftover.txt", "nothing to see\n");
  const result = run(fixture, "--pin");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*pinned hashes recorded.*resolve the failures above first/);
  const inventory = JSON.parse(await readFile(fixture.inventoryPath, "utf8"));
  assert.deepEqual(inventory.pinned, {});
});

test("an unreadable file fails rather than being skipped", async (t) => {
  if (process.getuid?.() === 0) {
    t.diagnostic("running as root: chmod 000 does not block a read, so this case cannot be exercised");
    return;
  }
  const fixture = await buildCandidate(t);
  const path = join(fixture.candidate, "scripts/build.js");
  await chmod(path, 0o000);
  const result = run(fixture);
  await chmod(path, 0o644);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*every candidate file readable/);
  assert.match(result.stdout, /scripts\/build\.js \(EACCES\)/);
});

test("an unreadable directory stops the run rather than reporting a clean tree", async (t) => {
  if (process.getuid?.() === 0) {
    t.diagnostic("running as root: chmod 000 does not block a readdir, so this case cannot be exercised");
    return;
  }
  const fixture = await buildCandidate(t);
  const path = join(fixture.candidate, "scripts");
  await chmod(path, 0o000);
  const result = run(fixture);
  // Restored immediately: an unlistable directory also defeats the temp-tree
  // cleanup, and a leaked fixture would outlive the run.
  await chmod(path, 0o755);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*candidate fully walkable/);
  assert.match(result.stdout, /scripts \(EACCES\)/);
  assert.match(result.stdout, /verification stopped/);
});

// Documented behaviour: pointing the verifier at the producer checkout is an
// invocation mistake, not a finding about a candidate, so it exits 2.
test("a candidate that resolves to the producer checkout is refused with exit 2", async (t) => {
  const fixture = await buildCandidate(t);
  const result = spawnSync(
    process.execPath,
    [command, "--candidate", repo, "--inventory", fixture.inventoryPath],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /resolves to the producer checkout/);
});

test("usage errors exit 2 without touching the candidate", async (t) => {
  const fixture = await buildCandidate(t);
  const missing = spawnSync(process.execPath, [command], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--candidate is required/);

  const unknown = run(fixture, "--publish-now");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unrecognised argument "--publish-now"/);
});

test("a malformed inventory fails rather than crashing", async (t) => {
  const fixture = await buildCandidate(t);
  await writeFile(fixture.inventoryPath, JSON.stringify({ name: "example-watch", producer_files: "scripts/build.js" }) + "\n");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*inventory schema/);
  assert.match(result.stdout, /producer_files must be an array/);
  assert.doesNotMatch(output(result), /at .*verify-public-candidate\.js:\d+/);
});

test("a file that is not valid UTF-8 fails, because unreadable content cannot be cleared", async (t) => {
  const fixture = await buildCandidate(t);
  await writeFile(join(fixture.candidate, "scripts/build.js"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL.*every scanned file decodes as UTF-8/);
  assert.match(result.stdout, /scripts\/build\.js/);
});

test("--json writes the inventory hash, the per-file hashes and the verdict", async (t) => {
  const fixture = await buildCandidate(t);
  const reportPath = join(fixture.root, "report.json");
  const result = run(fixture, "--json", reportPath);
  assert.equal(result.status, 0, output(result));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.match(report.inventory_sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.candidate_dir, fixture.candidate);
  assert.equal(report.source_revision, INVENTORY.source_revision);
  assert.equal(report.verdict, "pass");
  assert.equal(report.findings_count, 0);
  assert.equal(Object.keys(report.files).length, 7);
  assert.match(report.files["README.md"], /^[a-f0-9]{64}$/);
  assert.ok(report.checks.some((check) => check.name === "no files outside the inventory" && check.verdict === "ok"));
});

test("--fresh-history accepts one local commit and rejects two, a remote, or a dirty tree", async (t) => {
  const prepare = async () => {
    const fixture = await buildCandidate(t);
    const git = (...args) => execFileSync("git", ["-C", fixture.candidate, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("add", "-A");
    git("commit", "-q", "-m", "Assemble the public candidate");
    return { fixture, git };
  };

  const { fixture: clean } = await prepare();
  const ok = run(clean, "--fresh-history");
  assert.equal(ok.status, 0, output(ok));
  assert.match(ok.stdout, /ok.*history is a single local commit/);

  const { fixture: twoCommits, git: gitTwo } = await prepare();
  await writeFile(join(twoCommits.candidate, "README.md"), "# Example Watch\n\nBy Example Holder LLC. See https://example.com/ for more.\n");
  gitTwo("commit", "-q", "-am", "Adjust the README");
  const two = run(twoCommits, "--fresh-history");
  assert.equal(two.status, 1);
  assert.match(two.stdout, /2 commits; a fresh history has exactly 1/);

  const { fixture: withRemote, git: gitRemote } = await prepare();
  gitRemote("remote", "add", "origin", "https://example.com/example/example-watch.git");
  const remote = run(withRemote, "--fresh-history");
  assert.equal(remote.status, 1);
  assert.match(remote.stdout, /remotes configured: origin/);

  const { fixture: dirty } = await prepare();
  await writeFile(join(dirty.candidate, "README.md"), "# Example Watch\n\nBy Example Holder LLC. Uncommitted.\n");
  const unclean = run(dirty, "--fresh-history");
  assert.equal(unclean.status, 1);
  assert.match(unclean.stdout, /working tree is not clean/);
});

test("--fresh-history fails when the candidate has no history at all", async (t) => {
  const fixture = await buildCandidate(t);
  const result = run(fixture, "--fresh-history");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /--fresh-history given but the candidate has no \.git/);
});

test("--self skips the producer-checkout refusal and still verifies in place", async (t) => {
  const fixture = await buildCandidate(t);
  const copy = join(fixture.root, "self");
  await cp(fixture.candidate, copy, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [command, "--candidate", copy, "--inventory", fixture.inventoryPath, "--self"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /0 fail\./);
});

test("a scan-exempt file is checked structurally instead of being scanned", async (t) => {
  // The inventory names the very terms it forbids, so a copy of it inside the
  // candidate must be exempted -- and must still be the same shape.
  const fixture = await buildCandidate(t, {
    overlay_files: { ...INVENTORY.overlay_files, "config/public-candidate.json": "candidate/config/public-candidate.json" },
    scan_exempt_files: ["config/public-candidate.json"]
  });
  const inventory = JSON.parse(await readFile(fixture.inventoryPath, "utf8"));
  // The shipped copy is the projection: producer-only policy and the source
  // revision are gone, and a projection note is present.
  const { forbidden_terms, forbidden_script_fragments, source_revision, ...projected } = inventory;
  projected.note_projection = "projected";
  await fixture.write("config/public-candidate.json", JSON.stringify(projected, null, 2) + "\n");
  const result = run(fixture);
  assert.equal(result.status, 0, output(result));

  await fixture.write("config/public-candidate.json", JSON.stringify({ name: "example-watch" }, null, 2) + "\n");
  const wrongShape = run(fixture);
  assert.equal(wrongShape.status, 1);
  assert.match(wrongShape.stdout, /exempt file schema differs from the inventory/);

  // A copy that still carries the scrubbing policy would publish the very
  // identifiers it exists to suppress.
  await fixture.write("config/public-candidate.json", JSON.stringify({ ...projected, forbidden_terms }, null, 2) + "\n");
  const leaking = run(fixture);
  assert.equal(leaking.status, 1);
  assert.match(leaking.stdout, /producer-only policy in the public inventory/);
});

// Binary files cannot be text-cleared, so each one is declared with a media
// type and checked structurally. The synthetic PNGs here are built byte by
// byte: a signature, an IHDR chunk, an IDAT chunk, and IEND, with an optional
// tEXt chunk standing in for the metadata a screenshot tool would embed.
const pngChunk = (type, data = Buffer.alloc(0)) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);   // the verifier checks structure, not the CRC
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, crc]);
};
const png = ({ text = null } = {}) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", Buffer.alloc(13)),
  ...(text ? [pngChunk("tEXt", Buffer.from(`Author\0${text}`, "latin1"))] : []),
  pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00])),
  pngChunk("IEND")
]);

const withBinary = async (t, body, type = "image/png") => {
  const fixture = await buildCandidate(t, {
    overlay_files: { ...INVENTORY.overlay_files, "docs/screenshot.png": "candidate/docs/screenshot.png" },
    binary_files: { "docs/screenshot.png": type }
  });
  await mkdir(join(fixture.candidate, "docs"), { recursive: true });
  await writeFile(join(fixture.candidate, "docs/screenshot.png"), body);
  return fixture;
};

test("a declared PNG with no metadata chunks passes", async (t) => {
  const fixture = await withBinary(t, png());
  const result = run(fixture);
  assert.equal(result.status, 0, output(result));
});

test("a declared PNG carrying a text chunk fails, because metadata is where identity hides", async (t) => {
  const fixture = await withBinary(t, png({ text: "example laptop" }));
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs\/screenshot\.png/);
  assert.match(result.stdout, /tEXt/);
});

test("a declared PNG whose bytes are not a PNG fails", async (t) => {
  const fixture = await withBinary(t, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs\/screenshot\.png/);
});

test("a binary declared with an unsupported media type fails rather than being skipped", async (t) => {
  const fixture = await withBinary(t, png(), "image/jpeg");
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unsupported binary type/);
});

test("--self verifies the tree that holds the script, as the shipped copy does in CI", async (t) => {
  // The candidate carries its own verifier and inventory; overlay keys are
  // plain paths there and the inventory itself is checked structurally.
  const inventory = {
    ...INVENTORY,
    producer_files: ["scripts/build.js", "scripts/verify-public-candidate.js", "scripts/lib/receipt-privacy.js"],
    overlay_files: { ...INVENTORY.overlay_files, "config/public-candidate.json": "candidate/config/public-candidate.json" },
    scan_exempt_files: ["config/public-candidate.json"]
  };
  const fixture = await buildCandidate(t, inventory);
  await mkdir(join(fixture.candidate, "scripts/lib"), { recursive: true });
  await mkdir(join(fixture.candidate, "config"), { recursive: true });
  await cp(command, join(fixture.candidate, "scripts/verify-public-candidate.js"));
  await cp(join(repo, "scripts/lib/receipt-privacy.js"), join(fixture.candidate, "scripts/lib/receipt-privacy.js"));
  const { forbidden_terms, forbidden_script_fragments, source_revision, ...projected } = inventory;
  projected.note_projection = "projected";
  await writeFile(join(fixture.candidate, "config/public-candidate.json"), JSON.stringify(projected, null, 2) + "\n");
  const result = spawnSync(process.execPath, [join(fixture.candidate, "scripts/verify-public-candidate.js"), "--self"], { cwd: fixture.candidate, encoding: "utf8" });
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /every inventoried file present/);

  // The published repository verifies itself from a checkout, where .git is
  // the tree's own history rather than assembled output.
  execFileSync("git", ["init", "-q"], { cwd: fixture.candidate });
  const checkedOut = spawnSync(process.execPath, [join(fixture.candidate, "scripts/verify-public-candidate.js"), "--self"], { cwd: fixture.candidate, encoding: "utf8" });
  assert.equal(checkedOut.status, 0, output(checkedOut));
});

test("an optional generated file is accepted when present and not required when absent", async (t) => {
  const fixture = await buildCandidate(t, { optional_generated_files: ["public/data/ledger.json"] });
  assert.equal(run(fixture).status, 0);
  await fixture.write("public/data/ledger.json", "{}\n");
  const withLedger = run(fixture);
  assert.equal(withLedger.status, 0, output(withLedger));
  await fixture.write("public/data/other.json", "{}\n");
  const extra = run(fixture);
  assert.equal(extra.status, 1);
  assert.match(extra.stdout, /public\/data\/other\.json/);
});

test("--fresh-history fails when an inventoried file is ignored by the repository", async (t) => {
  const fixture = await buildCandidate(t, { producer_files: [...INVENTORY.producer_files, ".gitignore"] });
  await fixture.write(".gitignore", "receipts/\n");   // matches fixtures/receipts/ at any depth
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fixture.candidate });
  execFileSync("git", ["add", "-A"], { cwd: fixture.candidate });
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Example", "-c", "user.email=example@example.org", "commit", "-q", "-m", "initial"], { cwd: fixture.candidate });
  const result = run(fixture, "--fresh-history");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /inventoried but not tracked: fixtures\/receipts\/example\.jsonl/);
});
