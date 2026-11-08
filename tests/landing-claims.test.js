// The landing page answers "How much does this release actually ship?". That
// answer named one capture for a long time after the release shipped four
// captures and a dozen extractors, so it is now checked against scripts/:
// every call-time capture must be named, and each class of reader it claims
// must exist. A new capture without a landing mention fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const scripts = await readdir(join(repo, "scripts"));

// The name the landing page uses for each capture script's surface.
const CAPTURE_NAMES = {
  "ollama-capture.mjs": "Ollama",
  "openai-compatible-capture.mjs": "any OpenAI-compatible endpoint",
  "perplexity-capture.mjs": "Perplexity",
  "typesafe-capture.mjs": "TypeSafe"
};

async function shipAnswer(path) {
  const html = await readFile(join(repo, path), "utf8");
  const start = html.indexOf("<summary>How much does this release actually ship?</summary>");
  assert.notEqual(start, -1, `${path} no longer asks how much the release ships`);
  return html.slice(start, html.indexOf("</details>", start));
}

test("the landing page names every call-time capture the release ships", async () => {
  const answer = await shipAnswer("src/landing.html");
  const captures = scripts.filter((name) => name.endsWith("-capture.mjs")).sort();
  assert.deepEqual(captures, Object.keys(CAPTURE_NAMES).sort(), "a capture was added or removed: update CAPTURE_NAMES and the landing page");
  for (const [script, name] of Object.entries(CAPTURE_NAMES)) {
    assert.ok(answer.includes(name), `the landing page does not name ${name} (${script})`);
  }
  assert.doesNotMatch(answer, /One capture/);
});

test("each class of reader the landing page claims exists", async () => {
  const answer = await shipAnswer("src/landing.html");
  assert.match(answer, /Extractors for local agent, editor, and desktop stores/);
  assert.ok(scripts.filter((name) => /^extract-/.test(name)).length >= 6);
  assert.match(answer, /estimators for chat exports/);
  assert.ok(scripts.some((name) => /^estimate-/.test(name)));
  assert.match(answer, /Anthropic and OpenAI organization usage reports/);
  for (const name of ["extract-claude-api.js", "extract-openai-api.js"]) assert.ok(scripts.includes(name), `${name} is gone`);
  assert.match(answer, /SURFACES\.md<\/code> says which, row by row/);
});

test("the built landing page carries the same answer as its source", async () => {
  // The build fills {{REPO}}-style placeholders in link targets; the prose
  // itself must arrive unchanged.
  const withoutLinks = (html) => html.replace(/href="[^"]*"/g, 'href=""');
  assert.equal(withoutLinks(await shipAnswer("docs/index.html")), withoutLinks(await shipAnswer("src/landing.html")));
});
