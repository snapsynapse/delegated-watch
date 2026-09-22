import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { isSupportedNodeVersion } from "../scripts/lib/runtime.js";

const check = resolve(import.meta.dirname, "../scripts/check-runtime.js");

test("runtime contract accepts the supported Node line", () => {
  const result = spawnSync(process.execPath, [check], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime supported/);
});

test("runtime contract pins LTS while retaining verified Node 26 compatibility", () => {
  assert.equal(isSupportedNodeVersion("24.18.0"), true);
  assert.equal(isSupportedNodeVersion("24.17.0"), false);
  assert.equal(isSupportedNodeVersion("25.9.0"), false);
  assert.equal(isSupportedNodeVersion("26.0.0"), true);
  assert.equal(isSupportedNodeVersion("27.0.0"), false);
});
