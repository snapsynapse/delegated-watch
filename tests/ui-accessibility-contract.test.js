import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const source = (path) => readFile(resolve(import.meta.dirname, "..", path), "utf8");

test("keyboard-scroll regions have names, landmarks, and visible focus treatment", async () => {
  const [index, records, styles] = await Promise.all([
    source("src/index.html"),
    source("src/records.html"),
    source("src/styles.css")
  ]);

  assert.match(index, /id="heatmap"[^>]*role="region"[^>]*aria-label="Daily token burn heatmap\. Use arrow keys to scroll the calendar\."[^>]*tabindex="0"/);
  assert.match(index, /class="table-wrap"[^>]*role="region"[^>]*aria-label="Recent daily records table\. Use arrow keys to scroll\."[^>]*tabindex="0"/);
  // The drivers list scrolls on its own (.mix-layout > .drivers sets overflow-y),
  // so it needs the same treatment. A live axe scan caught this one in 2026-09
  // after the contract test had asserted only the heatmap and the tables.
  assert.match(index, /id="drivers"[^>]*role="region"[^>]*aria-label="Burn drivers list\. Use arrow keys to scroll\."[^>]*tabindex="0"/);
  assert.match(records, /class="table-wrap records-table-wrap"[^>]*role="region"[^>]*aria-label="Latest active days table\. Use arrow keys to scroll\."[^>]*tabindex="0"/);
  assert.match(styles, /\.heatmap:focus-visible,\s*\.drivers:focus-visible,\s*\.table-wrap:focus-visible\s*\{[\s\S]*outline: 2px solid var\(--cyan\)/);

  // A labelled div needs a role for the label to be exposed; axe flags the
  // bare aria-label as prohibited otherwise.
  assert.match(index, /class="range-panel" role="group" aria-label="Time range"/);
});

test("freshness groups retain visually unlabeled provider columns with accessible empty states", async () => {
  const app = await source("src/app.js");

  assert.match(app, /<div class="freshness-column" role="group" aria-label="\$\{text\(group\.label\)\} sources\$\{group\.entries\.length \? "" : ": no known surfaces"\}">/);
  assert.match(app, /group\.entries\.map\(renderFreshnessRow\)\.join\(""\)/);
  assert.doesNotMatch(app, /<h3 id="freshness-/);
});

test("records panel is absent only when both records features are disabled", async () => {
  const [index, app] = await Promise.all([source("src/index.html"), source("src/app.js")]);
  const match = app.match(/const publicationFeature = \(feature\) =>[\s\S]*?\n};\n\n\/\/ Theme/);
  assert.ok(match, "publication feature gate is available for the UI contract");
  const setup = match[0].replace(/\n\n\/\/ Theme[\s\S]*/, "");

  assert.match(index, /<article id="recordsPanel" class="panel panel-full">/);
  assert.ok(
    app.indexOf("recordsPanel.hidden") < app.indexOf(".dashboard-grid > article:not([hidden]) .eyebrow"),
    "records panel is hidden before visible-panel numbering"
  );
  for (const [records, recordsTable, expectedHidden] of [
    [false, false, true],
    [false, true, false],
    [true, false, false],
    [true, true, false]
  ]) {
    const nodes = new Map();
    const get = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, hidden: false, textContent: "" });
      return nodes.get(selector);
    };
    const window = { __PUBLICATION__: {
      mode: "personal-public",
      scopeNote: "Synthetic scope",
      features: { records, recordsTable }
    } };
    const document = {
      documentElement: { dataset: {} },
      querySelector: get,
      querySelectorAll: () => []
    };
    get("#publicationRecordsLink").dataset.href = "./records/";
    const applyPublicationView = new Function("window", "document", `${setup}\nreturn applyPublicationView;`)(window, document);
    applyPublicationView();
    assert.equal(get("#recordsPanel").hidden, expectedHidden, `${records}/${recordsTable}`);
  }
});

test("configured day-boundary copy stays truthful for UTC and regional profiles", async () => {
  const app = await source("src/app.js");
  const match = app.match(/const configuredDayBoundaryCopy = \(timezone\) =>\n([\s\S]*?);\n\n\/\/ Fixed ranges/);
  assert.ok(match, "configured day-boundary helper is available for the UI contract");
  const configuredDayBoundaryCopy = new Function(`${match[0].replace(/\n\n\/\/ Fixed ranges[\s\S]*/, "")}\nreturn configuredDayBoundaryCopy;`)();

  for (const timezone of ["UTC", "America/Denver"]) {
    const copy = configuredDayBoundaryCopy(timezone);
    assert.match(copy, new RegExp(`configured ${timezone} day boundary`));
    assert.match(copy, /Provider reports can use different boundaries/);
    assert.doesNotMatch(copy, /matching how providers bucket|western evening|following cell/);
  }
});

// The landing page's code blocks scroll horizontally below roughly 700px, which
// makes them keyboard-operable regions at phone and small-tablet widths and
// static text at desktop width. A scan run at one viewport cannot see the
// condition at all, which is how this shipped: the desktop axe run reported zero
// violations because the blocks did not scroll there. The contract asserts the
// treatment unconditionally, because the source is what can be checked cheaply.
test("landing code blocks are keyboard reachable and named", async () => {
  const landing = await source("src/landing.html");
  const blocks = [...landing.matchAll(/<pre\b([^>]*)>/g)].map(([, attrs]) => attrs);
  assert.ok(blocks.length > 0, "no <pre> blocks found in src/landing.html");
  for (const attrs of blocks) {
    assert.match(attrs, /tabindex="0"/, `a <pre> scrolls on a phone but is not focusable: ${attrs.trim()}`);
    assert.match(attrs, /role="region"/, `a <pre> is a scrollable region without the role: ${attrs.trim()}`);
    assert.match(attrs, /aria-label="[^"]{8,}"/, `a <pre> region has no accessible name: ${attrs.trim()}`);
  }
  assert.match(
    landing,
    /pre:focus-visible\s*\{[^}]*outline:/,
    "focusable <pre> blocks need a visible focus ring; the link and button rules do not cover them"
  );
});
