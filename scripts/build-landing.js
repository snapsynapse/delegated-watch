// Landing-page build: render src/landing.html into the served tree.
//
// The home page describes the project. The dashboard is the demonstration of
// it and lives at config.demo_path. Both are built; neither is hand-edited in
// docs/.
//
// Every public location this page names -- the origin, the demo route, the
// footer routes, the byline and its dates -- comes from config/site.json, for
// the same reason the dashboard's does: this file ships in a public repository
// and a build must never hardcode a personal name, a domain, or a URL. Unlike
// the dashboard, though, a landing page with no site config has nothing left to
// render, so this build fails rather than emitting a page full of dead links.
//
// Usage:
//   node scripts/build-landing.js

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TEMPLATE = "src/landing.html";
const CONFIG = "config/site.json";
const OUTPUT = "docs/index.html";

const site = JSON.parse(await readFile(CONFIG, "utf8"));
const landing = site.landing;

for (const [path, value] of [
  ["domain", site.domain],
  ["demo_path", site.demo_path],
  ["landing", landing],
  ["landing.author", landing?.author],
  ["landing.author_url", landing?.author_url],
  ["landing.date_published", landing?.date_published],
  ["landing.date_modified", landing?.date_modified],
  ["landing.version", landing?.version]
]) {
  if (!value) throw new Error(`${CONFIG}: ${path} is required to build ${OUTPUT}`);
}

const origin = `https://${site.domain}`;
const repo = site.links.find((link) => link.label === "Source")?.href;
if (!repo) throw new Error(`${CONFIG}: links needs a "Source" entry naming the repository`);

const TITLE = "Delegated.watch";
const HEADLINE = "Delegated.watch: a local-first record of delegated AI work";
const DESCRIPTION =
  "A local-first record of the work you delegate to AI models, counted in tokens. Unknown is never zero: a day with no recovered evidence is absent, not empty.";
const OG_IMAGE_ALT =
  "The Delegated.watch wordmark beside a calendar heatmap of blue cells at varying intensity, with scattered dark cells where no record exists.";

// Search results truncate past these, and a truncated title loses the half that
// says what the thing is.
if (HEADLINE.length > 60) throw new Error(`title is ${HEADLINE.length} chars, over the 60-char budget`);
if (DESCRIPTION.length > 160) throw new Error(`description is ${DESCRIPTION.length} chars, over the 160-char budget`);

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const humanDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });

const indent = (text, spaces) =>
  text.split("\n").map((line) => (line ? `${" ".repeat(spaces)}${line}` : line)).join("\n");

// No DefinedTerm block here, unlike the sibling open-spec pages. INTENT.md is
// explicit that this repository is a product and defines no term for anyone
// else to conform to; claiming membership in a defined-term set would be a
// structured-data assertion the project does not make in prose.
const structuredData = [
  {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: TITLE,
    alternativeHeadline: "A local-first record of delegated AI work",
    description: DESCRIPTION,
    inLanguage: "en",
    url: `${origin}/`,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${origin}/` },
    datePublished: landing.date_published,
    dateModified: landing.date_modified,
    author: { "@type": "Person", name: landing.author, url: landing.author_url },
    publisher: { "@type": "Organization", name: "Snap Synapse LLC", url: landing.author_url },
    image: `${origin}/imgs/og.png`,
    keywords: [
      "token usage",
      "token burn",
      "AI usage tracking",
      "local-first",
      "delegated work",
      "inference receipts",
      "provenance"
    ],
    license: "https://opensource.org/license/mit",
    citation: [
      {
        "@type": "WebPage",
        name: "Build a Token Burn Dashboard to Track What Your AI Actually Does",
        url: "https://natesnewsletter.substack.com/p/token-burn-dashboard"
      }
    ]
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: TITLE,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    url: `${origin}/`,
    softwareVersion: landing.version,
    license: "https://opensource.org/license/mit",
    description: DESCRIPTION,
    image: `${origin}/imgs/og.png`,
    codeRepository: repo,
    author: { "@type": "Person", name: landing.author, url: landing.author_url }
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: TITLE,
    url: `${origin}/`,
    description: DESCRIPTION,
    inLanguage: "en"
  }
];

const discovery = [
  `<link rel="canonical" href="${origin}/">`,
  `<link rel="alternate" type="text/plain" href="${origin}/llms.txt" title="LLM-readable summary">`,
  "",
  '<meta property="og:type" content="website">',
  `<meta property="og:site_name" content="${TITLE}">`,
  '<meta property="og:locale" content="en_US">',
  `<meta property="og:url" content="${origin}/">`,
  `<meta property="og:title" content="${escapeAttr(HEADLINE)}">`,
  `<meta property="og:description" content="${escapeAttr(DESCRIPTION)}">`,
  `<meta property="og:image" content="${origin}/imgs/og.png">`,
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  `<meta property="og:image:alt" content="${escapeAttr(OG_IMAGE_ALT)}">`,
  `<meta property="article:published_time" content="${landing.date_published}">`,
  `<meta property="article:modified_time" content="${landing.date_modified}">`,
  `<meta property="article:author" content="${escapeAttr(landing.author)}">`,
  "",
  '<meta name="twitter:card" content="summary_large_image">',
  `<meta name="twitter:title" content="${escapeAttr(HEADLINE)}">`,
  `<meta name="twitter:description" content="${escapeAttr(DESCRIPTION)}">`,
  `<meta name="twitter:image" content="${origin}/imgs/og.png">`,
  `<meta name="twitter:image:alt" content="${escapeAttr(OG_IMAGE_ALT)}">`,
  ...(landing.twitter
    ? [
        `<meta name="twitter:site" content="${escapeAttr(landing.twitter)}">`,
        `<meta name="twitter:creator" content="${escapeAttr(landing.twitter)}">`
      ]
    : []),
  "",
  // IndieWeb rel=me: claim the external profiles this page speaks for.
  ...(landing.same_as ?? []).map((href) => `<link rel="me" href="${escapeAttr(href)}">`),
  "",
  ...structuredData.map((block) =>
    ['<script type="application/ld+json">', JSON.stringify(block, null, 2), "</script>"].join("\n")
  )
].join("\n");

// One rel attribute per element. A second rel="..." is dropped by the parser,
// and the author or license semantics go with it.
const byline = [
  '<p class="byline">',
  `  By <a href="${escapeAttr(landing.author_url)}" target="_blank" rel="noopener author">${escapeAttr(landing.author)}</a>, <a href="${escapeAttr(landing.author_url)}" target="_blank" rel="noopener">${escapeAttr(landing.author_label ?? "Snap Synapse")}</a>`,
  '  <span class="sep">&middot;</span>',
  `  Published <time datetime="${landing.date_published}">${humanDate(landing.date_published)}</time>`,
  '  <span class="sep">&middot;</span>',
  `  Updated <time datetime="${landing.date_modified}">${humanDate(landing.date_modified)}</time>`,
  '  <span class="sep">&middot;</span>',
  `  <span class="version">v${escapeAttr(landing.version)}</span>`,
  '  <span class="sep">&middot;</span>',
  `  <a href="${repo}/blob/main/LICENSE" rel="license noopener" target="_blank">MIT</a>`,
  "</p>"
].join("\n");

// The shared routes come from site.links so the landing page and the dashboard
// footer cannot drift. A self-link to "/" is dropped: on the home page it goes
// nowhere the reader is not already.
const footerLinks = [...site.links, ...(landing.extra_links ?? [])]
  .filter((link) => link.href !== "/")
  .map(({ label, href }) => {
    const external = /^https?:/i.test(href);
    const attrs = external ? ' target="_blank" rel="noopener"' : "";
    return `<a href="${escapeAttr(href)}"${attrs}>${escapeAttr(label)}</a>`;
  })
  .join("\n");

const template = await readFile(TEMPLATE, "utf8");
const values = {
  DISCOVERY: indent(discovery, 2),
  BYLINE: indent(byline, 4),
  FOOTER_LINKS: indent(footerLinks, 8),
  DEMO: site.demo_path,
  REPO: repo,
  ORIGIN: origin,
  VERSION: landing.version,
  MODIFIED: landing.date_modified,
  MODIFIED_HUMAN: humanDate(landing.date_modified),
  AUTHOR: escapeAttr(landing.author),
  AUTHOR_URL: escapeAttr(landing.author_url),
  AUTHOR_LABEL: escapeAttr(landing.author_label ?? "Snap Synapse")
};

const page = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
  if (!(key in values)) throw new Error(`${TEMPLATE}: no value for ${match}`);
  return values[key];
});

// A token that survived substitution is a literal "{{NAME}}" served to readers.
// Cheaper to fail here than to find it in a search result.
if (/\{\{/.test(page)) {
  throw new Error(`${TEMPLATE}: unsubstituted token in output: ${page.match(/\{\{[^}]*\}\}/)[0]}`);
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, page);
console.log(`Built ${OUTPUT} (${(page.length / 1024).toFixed(1)} KB, demo at ${site.demo_path}).`);
