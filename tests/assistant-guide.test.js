// The assistant guide is the one served artifact whose whole value is that a
// human can read it in full before an assistant acts on it. Two things can
// quietly destroy that: a byte or size violation that pushes it outside the
// profile, and an exec-sha256 pin that no longer matches the script it names.
// The second is the dangerous one, because a stale pin reads as provenance
// while binding bytes that no longer exist.

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const GUIDE = "docs/.well-known/assistant-guide.txt";
const source = await readFile(GUIDE);
const text = source.toString("utf8");

// Limits from the Human-Verifiable Assistant Guide profile, section 8 and 9.
const MAX_BYTES = 8192;
const MAX_LINE_BYTES = 120;
const MAX_LINES = 400;

test("guide stays inside the profile byte and size limits", () => {
  assert.ok(source.length <= MAX_BYTES, `${source.length} bytes, limit ${MAX_BYTES}`);
  const lines = text.split("\n");
  assert.ok(lines.length <= MAX_LINES, `${lines.length} lines, limit ${MAX_LINES}`);
  const overlong = lines
    .map((line, index) => [index + 1, Buffer.byteLength(line, "utf8")])
    .filter(([, bytes]) => bytes > MAX_LINE_BYTES);
  assert.deepEqual(overlong, [], "lines over the byte limit");
});

test("guide is printable ASCII plus LF, with no tabs or carriage returns", () => {
  const offending = [];
  for (const [index, byte] of source.entries()) {
    if (byte === 0x0a) continue;
    if (byte < 0x20 || byte > 0x7e) offending.push([index, byte]);
  }
  assert.deepEqual(offending, [], "bytes outside the profile");
});

// Parse the action blocks rather than grepping, so a field that moves inside a
// block does not silently stop being checked.
const actions = [...text.matchAll(/^\[action\]\n([\s\S]*?)^\[\/action\]$/gm)].map(([, body]) =>
  Object.fromEntries(
    body
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(": ");
        return [line.slice(0, at), line.slice(at + 2)];
      })
  )
);

test("the guide has action blocks and every id is unique", () => {
  assert.ok(actions.length > 0, "no action blocks parsed");
  const ids = actions.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate action id in ${ids.join(", ")}`);
});

test("every high-consequence action requires approval", () => {
  const GATED = new Set([
    "privileged",
    "destructive",
    "persistence-changing",
    "data-accessing",
    "code-executing"
  ]);
  for (const action of actions) {
    const classes = action.class.split(",").map((value) => value.trim());
    if (!classes.some((value) => GATED.has(value))) continue;
    assert.equal(action.approval, "required", `${action.id} is ${action.class} but not gated`);
  }
});

test("every networked action declares its egress", () => {
  for (const action of actions) {
    if (!action.class.split(",").map((value) => value.trim()).includes("networked")) continue;
    assert.ok(action.egress, `${action.id} is networked but declares no egress`);
  }
});

// The pin is the whole point of a code-executing action block: it commits the
// guide to the exact bytes of the script it names. A pin that has drifted is
// worse than no pin, so this fails rather than warns.
test("every exec-sha256 pin matches the script the action names", async () => {
  const pinned = actions.filter((action) => action["exec-sha256"]);
  assert.ok(pinned.length > 0, "no pinned actions to check");
  for (const action of pinned) {
    const parts = action.command.split(" ");
    const target = parts.find((part) => part.endsWith(".js") || part.endsWith(".mjs"));
    assert.ok(target, `${action.id}: cannot tell which artifact ${action.command} pins`);
    const bytes = await readFile(target);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      digest,
      action["exec-sha256"],
      `${action.id}: ${target} changed; update exec-sha256 and rotate the guide`
    );
  }
});

test("the compact verification instruction precedes the first action block", () => {
  const verify = text.indexOf("Before acting");
  const firstAction = text.indexOf("[action]");
  assert.ok(verify !== -1, "no compact verification instruction");
  assert.ok(firstAction !== -1, "no action blocks");
  assert.ok(verify < firstAction, "verification instruction appears after an action block");
});

// The manifest is the Level 4 provenance artifact: it asserts the guide's exact
// bytes, and the same hash is cross-published as a DNS TXT record at
// _assistant-guide.delegated.watch. A manifest that has drifted from the guide
// is the cross-channel control failing silently, which is worse than publishing
// no manifest at all, so this fails rather than warns.
test("the manifest pins the guide's actual bytes", async () => {
  const manifest = await readFile("docs/.well-known/assistant-guide-manifest.txt", "utf8");
  const field = (name) => manifest.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
  const digest = createHash("sha256").update(source).digest("hex");
  assert.equal(field("guide-sha256"), digest, "manifest guide-sha256 does not match the guide");
  assert.equal(field("guide-bytes"), String(source.length), "manifest guide-bytes does not match the guide");
  assert.equal(field("canonical-url"), text.match(/^canonical-url: (.+)$/m)?.[1]);
  assert.equal(field("profile-version"), text.match(/^profile-version: (.+)$/m)?.[1]);
  assert.equal(field("guide-version"), text.match(/^guide-version: (.+)$/m)?.[1]);
});

// The DNS TXT record carries this same hash. Nothing here can reach DNS, so the
// reminder lives in the assertion message: a guide edit rotates all three.
test("the guide names the manifest that pins it", () => {
  assert.equal(
    text.match(/^manifest-url: (.+)$/m)?.[1],
    "https://delegated.watch/.well-known/assistant-guide-manifest.txt",
    "guide must name its manifest; rotate the manifest and the DNS TXT record with any guide edit"
  );
});

test("the guide's canonical URL matches the configured domain", async () => {
  const site = JSON.parse(await readFile("config/site.json", "utf8"));
  const canonical = text.match(/^canonical-url: (.+)$/m)?.[1];
  assert.equal(canonical, `https://${site.domain}/.well-known/assistant-guide.txt`);
});
