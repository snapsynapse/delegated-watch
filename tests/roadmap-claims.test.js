// ROADMAP.md lists only what is not delivered yet, and several of its items
// make checkable claims about the code. Each test below pins one claim, so
// the day a gap closes, this file fails and names the roadmap text to update.
// A roadmap that still lists delivered work, or misstates what is missing,
// misleads every reader who plans from it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const read = (path) => readFile(join(repo, path), "utf8");
const roadmap = await read("ROADMAP.md");
const surfaces = await read("SURFACES.md");
const scripts = (await readdir(join(repo, "scripts"))).filter((name) => /\.(m?js|cjs)$/.test(name));

const section = (number) => {
  const start = roadmap.search(new RegExp(`^## ${number}\\. `, "m"));
  assert.notEqual(start, -1, `ROADMAP.md has no "## ${number}." section`);
  const end = roadmap.indexOf("\n## ", start + 1);
  return roadmap.slice(start, end === -1 ? undefined : end);
};
const surfaceRow = (name) => {
  const row = surfaces.split("\n").find((line) => line.startsWith(`| ${name} |`));
  assert.ok(row, `SURFACES.md has no row for ${name}`);
  return row;
};
const scriptsMatching = async (pattern) => {
  const hits = [];
  for (const name of scripts) if (pattern.test(await read(`scripts/${name}`))) hits.push(name);
  return hits.sort();
};

test("the roadmap lists no delivered work", () => {
  assert.doesNotMatch(roadmap, /\bDone as of\b|\bDone\.|\bdelivered\b/i,
    "a delivered item belongs in CHANGELOG.md, not ROADMAP.md");
});

test("numbered sections run 1 to 6, and every cross-reference resolves", () => {
  const numbers = [...roadmap.matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6]);
  assert.match(roadmap, /Item 5 below records why a gateway/);
  assert.match(section(5), /^## 5\. Gateway/);
  assert.match(roadmap, /Item 6 is the version of this that fits/);
  assert.match(section(6), /^## 6\. Self-reported acceptance/);
  assert.match(roadmap, /Unranked against items 1 through 5/);
  // Nothing elsewhere still cites a roadmap item by a number that moved.
  assert.doesNotMatch(surfaces, /item \d+ of `ROADMAP\.md`/);
});

test("item 1: exactly the extractors it names emit token components", async () => {
  const named = section(1).match(/emit them: (.*?)\./)?.[1];
  assert.ok(named, "item 1 no longer names the extractors that emit components");
  const claimed = [...named.matchAll(/`extract:([a-z-]+)`/g)].map((match) => `extract-${match[1]}.js`).sort();
  const actual = (await scriptsMatching(/token_components/)).filter((name) => name.startsWith("extract-"));
  assert.deepEqual(actual, claimed, "update ROADMAP.md item 1's list of extractors that emit token components");
});

test("item 3: the receipt schema has no route field yet", async () => {
  assert.doesNotMatch(await read("scripts/lib/receipt-schema.js"), /\broute\b/, "route exists: update ROADMAP.md item 3");
});

test("item 4: the receipt schema has only a sorted models array, not a requested/resolved split", async () => {
  const schema = await read("scripts/lib/receipt-schema.js");
  assert.doesNotMatch(schema, /model_requested|model_resolved/, "the model split exists: update ROADMAP.md item 4");
  assert.match(schema, /\["models", "correlation_keys"\]/);
  assert.match(schema, /must be sorted and unique/);
});

test("item 6: no self_reported authority exists yet", async () => {
  assert.deepEqual(await scriptsMatching(/self_reported/), [], "self_reported exists: update ROADMAP.md item 6");
  assert.doesNotMatch(await read("scripts/lib/receipt-schema.js"), /self_reported/);
});

test("item 2: nothing captures known activity automatically yet", async () => {
  const writers = [];
  for (const name of scripts) {
    const source = await read(`scripts/${name}`);
    if (/writeFile[^\n]*(knownActivity|known-activity)/.test(source)) writers.push(name);
  }
  assert.deepEqual(writers, [], "a script writes known activity: update ROADMAP.md item 2");
  assert.match(await read("DATA_CONTRACT.md"), /`config\/known-activity\.json` is the third option/);
});

test("the surface list: what it calls planned is planned, and has no extractor", async () => {
  for (const name of ["OpenCode", "Amp", "Factory Droid", "Kimi CLI", "Grok Build CLI"]) {
    assert.match(surfaceRow(name), /\| Planned \|/, `${name} is no longer Planned in SURFACES.md`);
    const slug = name.toLowerCase().replace(/ (cli|build cli)$/, "").replace(/ /g, "-");
    const named = new RegExp(`(^|[-_.])${slug}([-_.]|$)`);
    assert.ok(!scripts.some((script) => named.test(script)), `an extractor for ${name} exists: update ROADMAP.md`);
  }
  for (const name of ["Gemini API, Vertex AI, AI Studio", "Azure OpenAI", "Amazon Bedrock", "LiteLLM, Helicone, Langfuse"]) {
    assert.match(surfaceRow(name), /\| Planned \|/, `${name} is no longer Planned in SURFACES.md`);
  }
  // OpenRouter: per-call ships through the OpenAI-compatible capture; the
  // account-wide usage API does not.
  assert.match(surfaceRow("OpenRouter"), /Ships per call; account-wide Planned/);
  assert.match(await read("scripts/openai-compatible-capture.mjs"), /openrouter: \{ baseUrl:/);
  assert.ok(!scripts.some((script) => /openrouter/.test(script)), "an OpenRouter usage extractor exists: update ROADMAP.md");
  assert.match(surfaceRow("Cline"), /not yet counted/, "Cline is counted now: update ROADMAP.md item 1 of the surface list");
});

test("the surface list: validation still covers only the shipped synthetic dataset", async () => {
  assert.match(await read("scripts/validate-data.js"), /readFile\("public\/data\/daily-burn\.json"/,
    "validate now follows a personal record: update ROADMAP.md");
});
