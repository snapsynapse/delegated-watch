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
  assert.match(records, /class="table-wrap records-table-wrap"[^>]*role="region"[^>]*aria-label="Latest active days table\. Use arrow keys to scroll\."[^>]*tabindex="0"/);
  assert.match(styles, /\.heatmap:focus-visible,\s*\.table-wrap:focus-visible\s*\{[\s\S]*outline: 2px solid var\(--cyan\)/);
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
