import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const command = join(repo, "scripts/privacy-check-receipts.js");
const sha = (letter) => `sha256:${letter.repeat(64)}`;

const receipt = (source = "codex") => ({
  schema_version: 2,
  date: "2030-01-02",
  timezone: "UTC",
  source,
  provider: "openai",
  surface: "app",
  account_alias: "personal",
  origin: "fixture/store",
  snapshot_key: `fixture:${source}`,
  authority: "tool",
  interval: { start: "2030-01-02", end: "2030-01-02" },
  correlation_keys: [sha("a")],
  tokens: 12,
  calls: 1,
  fidelity: "exact",
  provenance: "synthetic fixture"
});

const run = (cwd) => spawnSync(process.execPath, [command], { cwd, encoding: "utf8" });

const fixture = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dw-privacy-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "public/data"), { recursive: true });
  await writeFile(join(root, "public/data/daily-burn.json"), "[]\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
};

const bytes = async (root) => {
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...await visit(path));
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const content = entry.isSymbolicLink()
          ? Buffer.from(`symlink:${await readFile(path, { encoding: "utf8" }).catch(() => "unreadable")}`)
          : await readFile(path);
        found.push([relative(root, path), createHash("sha256").update(content).digest("hex")]);
      }
    }
    return found;
  };
  return Object.fromEntries((await visit(root)).sort(([a], [b]) => a.localeCompare(b)));
};

test("discovers both receipt directories and leaves every fixture byte unchanged", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "scratch/receipts"), { recursive: true });
  await mkdir(join(root, "receipts"), { recursive: true });
  await writeFile(join(root, "scratch/receipts/local.jsonl"), JSON.stringify(receipt("codex")) + "\n");
  await writeFile(join(root, "receipts/remote.jsonl"), JSON.stringify(receipt("claude_code")) + "\n");
  const before = await bytes(root);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 receipts, 0 findings/);
  assert.deepEqual(await bytes(root), before);
});

test("rejects tracked protected sources without echoing their contents or mutating inputs", async (t) => {
  const root = await fixture(t);
  const secret = `sk-${"x".repeat(32)}`;
  await mkdir(join(root, "raw"));
  await writeFile(join(root, "raw/private.txt"), secret + "\n");
  execFileSync("git", ["add", "raw/private.txt"], { cwd: root });
  const before = await bytes(root);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected source\/scratch paths are tracked/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  assert.deepEqual(await bytes(root), before);
});

test("refuses malformed JSONL without echoing its raw content", async (t) => {
  const root = await fixture(t);
  const secret = `ghp_${"x".repeat(36)}`;
  await mkdir(join(root, "receipts"));
  await writeFile(join(root, "receipts/malformed.jsonl"), `{\"token\":\"${secret}\"\n`);
  const before = await bytes(root);
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed JSON; privacy unknown/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  assert.deepEqual(await bytes(root), before);
});

test("refuses symlinked receipt files and directories without following them", async (t) => {
  const root = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "dw-privacy-target-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = `pplx-${"x".repeat(32)}`;
  await writeFile(join(outside, "secret.jsonl"), JSON.stringify({ provenance: secret }) + "\n");
  await mkdir(join(root, "receipts"));
  await symlink(join(outside, "secret.jsonl"), join(root, "receipts/linked.jsonl"));
  const beforeFile = await bytes(root);
  const fileResult = run(root);
  assert.notEqual(fileResult.status, 0);
  assert.match(fileResult.stderr, /regular file/);
  assert.doesNotMatch(`${fileResult.stdout}${fileResult.stderr}`, new RegExp(secret));
  assert.deepEqual(await bytes(root), beforeFile);

  await rm(join(root, "receipts"), { recursive: true, force: true });
  await symlink(outside, join(root, "receipts"));
  const beforeDirectory = await bytes(root);
  const directoryResult = run(root);
  assert.notEqual(directoryResult.status, 0);
  assert.match(directoryResult.stderr, /Receipt directory could not be inspected/);
  assert.doesNotMatch(`${directoryResult.stdout}${directoryResult.stderr}`, new RegExp(secret));
  assert.deepEqual(await bytes(root), beforeDirectory);
});

test("absent optional receipt directories pass while bad-type and unreadable inputs fail closed", async (t) => {
  const absent = await fixture(t);
  const absentBefore = await bytes(absent);
  const absentResult = run(absent);
  assert.equal(absentResult.status, 0, absentResult.stderr);
  assert.match(absentResult.stdout, /0 receipts, 0 findings/);
  assert.deepEqual(await bytes(absent), absentBefore);

  const badType = await fixture(t);
  await mkdir(join(badType, "scratch"));
  await writeFile(join(badType, "scratch/receipts"), "not a directory\n");
  const badTypeBefore = await bytes(badType);
  const badTypeResult = run(badType);
  assert.notEqual(badTypeResult.status, 0);
  assert.match(badTypeResult.stderr, /Receipt directory could not be inspected/);
  assert.deepEqual(await bytes(badType), badTypeBefore);

  if (process.getuid?.() === 0) return;
  const unreadable = await fixture(t);
  const secret = `github_pat_${"x".repeat(32)}`;
  await mkdir(join(unreadable, "receipts"));
  const path = join(unreadable, "receipts/unreadable.jsonl");
  await writeFile(path, secret + "\n");
  const unreadableBefore = await bytes(unreadable);
  await chmod(path, 0o000);
  t.after(() => chmod(path, 0o600).catch(() => {}));
  const unreadableResult = run(unreadable);
  assert.notEqual(unreadableResult.status, 0);
  assert.doesNotMatch(`${unreadableResult.stdout}${unreadableResult.stderr}`, new RegExp(secret));
  await chmod(path, 0o600);
  assert.deepEqual(await bytes(unreadable), unreadableBefore);
});
