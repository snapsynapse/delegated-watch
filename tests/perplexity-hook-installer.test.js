// The hook installer edits a person's own Claude Code settings, so every test
// here writes only to a temporary settings file, never to the real one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "..");

// A copy of the repository at a path a naive installer would mangle.
const specialRepo = async (root) => {
  const destination = join(root, "repo space's & ñ");
  await mkdir(destination);
  await cp(join(repo, "scripts"), join(destination, "scripts"), { recursive: true });
  await cp(join(repo, "config"), join(destination, "config"), { recursive: true });
  // The installer names the hook by its real path; macOS temp paths are symlinked.
  return realpath(destination);
};
const install = (copy, args) =>
  spawnSync(process.execPath, [join(copy, "scripts", "install-perplexity-hook.mjs"), ...args], { encoding: "utf8" });
// What a shell actually runs when it executes the registered command.
const shellTarget = (command) =>
  spawnSync("sh", ["-c", `printf '%s' ${command}`], { encoding: "utf8" }).stdout;
const managed = (settings) =>
  settings.hooks.PostToolUse.flatMap((entry) => entry.hooks).filter((inner) => inner.command.includes("perplexity-capture-hook"));

test("installing preserves every other setting, backs up privately, and quotes the path for a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "hook-installer-"));
  const copy = await specialRepo(root);
  const dir = join(root, "claude");
  const settings = join(dir, "settings.json");
  await mkdir(dir);
  const original = {
    env: { PRIVATE_VALUE: "kept" },
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/other-hook.sh", timeout: 3 }] }] },
    unrelated: { nested: ["kept"] }
  };
  await writeFile(settings, `${JSON.stringify(original, null, 2)}\n`);
  await chmod(settings, 0o600);

  const first = install(copy, ["--settings", settings]);
  assert.equal(first.status, 0, first.stderr);
  const installed = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(installed.env, original.env);
  assert.deepEqual(installed.unrelated, original.unrelated);
  assert.equal(installed.hooks.PostToolUse[0].hooks[0].command, "/opt/other-hook.sh");
  const [entry, ...extra] = managed(installed);
  assert.equal(extra.length, 0);
  assert.equal(shellTarget(entry.command), join(copy, "scripts", "perplexity-capture-hook.sh"));
  assert.equal((await stat(settings)).mode & 0o777, 0o600);

  const backups = (await readdir(dir)).filter((name) => name.startsWith("settings.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal((await stat(join(dir, backups[0]))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dir, backups[0]), "utf8")), original);

  // A second run finds the entry current and touches nothing.
  const bytes = await readFile(settings, "utf8");
  const second = install(copy, ["--settings", settings]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Already registered and current/);
  assert.equal(await readFile(settings, "utf8"), bytes);
  assert.equal((await readdir(dir)).filter((name) => name.startsWith("settings.json.bak-")).length, 1);

  const checked = install(copy, ["--settings", settings, "--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /\[ok\]/);
});

test("a stale entry is repointed rather than duplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "hook-installer-stale-"));
  const copy = await specialRepo(root);
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [
    { type: "command", command: "/moved/away/scripts/perplexity-capture-hook.sh", timeout: 15 }
  ] }] } }));
  assert.match(install(copy, ["--settings", settings, "--check"]).stdout, /MISSING TARGET/);

  const result = install(copy, ["--settings", settings]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Repointed/);
  const entries = managed(JSON.parse(await readFile(settings, "utf8")));
  assert.equal(entries.length, 1);
  assert.equal(shellTarget(entries[0].command), join(copy, "scripts", "perplexity-capture-hook.sh"));
});

test("settings that are not valid JSON are refused and left exactly as they were", async () => {
  const root = await mkdtemp(join(tmpdir(), "hook-installer-bad-"));
  const settings = join(root, "settings.json");
  await writeFile(settings, "{ not json");
  const result = install(repo, ["--settings", settings]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/);
  assert.equal(await readFile(settings, "utf8"), "{ not json");
  assert.deepEqual((await readdir(root)).sort(), ["settings.json"]);

  const fresh = join(root, "new", "settings.json");
  const created = install(repo, ["--settings", fresh]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal((await stat(fresh)).mode & 0o777, 0o600);
  assert.equal(install(repo, ["--bogus"]).status, 64);
});
