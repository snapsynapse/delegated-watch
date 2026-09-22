import { readFile } from "node:fs/promises";

const inlineJson = (value) =>
  JSON.stringify(typeof value === "string" ? JSON.parse(value) : value).replace(/</g, "\\u003c");

// Identity (site name, nav, footer, schema.org author) is never hardcoded here:
// this file ships in the public repository, so every personal name, domain,
// and URL comes from publication.identity, supplied by whichever publication
// configuration drives the export. Without one, none of those blocks render.
const escapeAmpersand = (value) => value.replace(/&/g, "&amp;");

const buildPersonalSiteNav = (identity) => {
  const items = identity.nav
    .map(({ label, href, current }) =>
      `        <li><a href="${href}"${current ? ' aria-current="page"' : ""}>${escapeAmpersand(label)}</a></li>`)
    .join("\n");
  return `
    <nav class="personal-site-nav" aria-label="Primary">
      <a class="personal-site-title" href="${identity.siteUrl}">${escapeAmpersand(identity.siteName)}</a>
      <ul>
${items}
      </ul>
    </nav>`;
};

const buildPersonalSiteFooter = (identity) => {
  const links = identity.footer.links
    .map(({ label, href }) => `        <a href="${href}">${escapeAmpersand(label)}</a>`)
    .join("\n");
  return `
    <footer class="personal-site-footer">
      <p>${escapeAmpersand(identity.footer.copyright)}</p>
      <nav aria-label="Footer">
${links}
      </nav>
    </footer>`;
};

// Discovery metadata (canonical URL, social cards, structured data) names a
// domain, so like identity it is never hardcoded in src/index.html: it comes
// from config/site.json through the build. A render without a site config
// emits none of it, which keeps a page built for local viewing free of
// absolute URLs it cannot honor.
const SITE_TITLE = "Delegated.watch";
const SITE_DESCRIPTION =
  "Account-wide record of AI work delegated to models, across every provider, surface, and machine.";

const buildSiteDiscovery = (site, publication) => {
  if (!site?.domain || publication?.canonicalUrl) return "";
  const origin = `https://${site.domain}`;
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_TITLE,
      url: `${origin}/`,
      description: SITE_DESCRIPTION,
      inLanguage: "en"
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: SITE_TITLE,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      url: `${origin}/`,
      license: "https://opensource.org/licenses/MIT",
      description: SITE_DESCRIPTION
    }
  ];
  const lines = [
    `<link rel="canonical" href="${origin}/">`,
    `<link rel="alternate" type="text/plain" href="${origin}/llms.txt" title="LLM-readable summary">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${SITE_TITLE}">`,
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:url" content="${origin}/">`,
    `<meta property="og:title" content="${SITE_TITLE}">`,
    `<meta property="og:description" content="${SITE_DESCRIPTION}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${SITE_TITLE}">`,
    `<meta name="twitter:description" content="${SITE_DESCRIPTION}">`,
    ...structuredData.map((block) =>
      [
        '<script type="application/ld+json">',
        JSON.stringify(block, null, 2),
        "</script>"
      ].join("\n")
    )
  ];
  return lines
    .join("\n")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
};

const DEMO_BANNER = '      <p class="demo-banner" role="note">This page renders synthetic demonstration data. Nothing here is a measured record.</p>';

export async function renderStaticDashboard({
  dailyBurn,
  profile,
  observedIntervals,
  knownActivity = null,
  evidenceManifest = null,
  githubSummary = null,
  publication = null,
  site = null
}) {
  const [htmlSource, css, dashboardModel, app] = await Promise.all([
    readFile("src/index.html", "utf8"),
    readFile("src/styles.css", "utf8"),
    readFile("src/dashboard-model.js", "utf8"),
    readFile("src/app.js", "utf8")
  ]);

  const dataScript = [
    "<script>",
    `window.__DAILY_BURN__ = ${inlineJson(dailyBurn)};`,
    githubSummary ? `window.__GITHUB_SUMMARY__ = ${inlineJson(githubSummary)};` : "",
    `window.__PROFILE__ = ${inlineJson(profile)};`,
    observedIntervals ? `window.__OBSERVED_INTERVALS__ = ${inlineJson(observedIntervals)};` : "",
    knownActivity ? `window.__KNOWN_ACTIVITY__ = ${inlineJson(knownActivity)};` : "",
    evidenceManifest ? `window.__EVIDENCE_MANIFEST__ = ${inlineJson(evidenceManifest)};` : "",
    publication ? `window.__PUBLICATION__ = ${inlineJson(publication)};` : "",
    // Only the two site keys the page acts on reach the page; the rest of
    // config/site.json (posture, hosting notes) stays out of the artifact.
    site ? `window.__SITE__ = ${inlineJson({ dataset: site.dataset ?? null, default_range: site.default_range ?? null })};` : "",
    "</script>"
  ].filter(Boolean).join("\n");

  const modelForPage = dashboardModel.replace(/^export\s+/gm, "");
  const appForPage = app.replace(
    /^import\s*\{[\s\S]*?\}\s*from "\.\/dashboard-model\.js";\n\n/,
    ""
  );

  let html = htmlSource;
  if (site?.dataset === "synthetic") {
    html = html.replace('<main class="shell">', `<main class="shell">\n${DEMO_BANNER}`);
  }
  if (publication) {
    const structuredData = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": publication.canonicalUrl,
      url: publication.canonicalUrl,
      name: publication.siteTitle,
      description: publication.description,
      ...(publication.identity
        ? {
            isPartOf: {
              "@type": "WebSite",
              "@id": publication.identity.structuredData.websiteId,
              url: publication.identity.siteUrl,
              name: publication.identity.siteName
            },
            author: {
              "@type": "Person",
              "@id": publication.identity.structuredData.authorId,
              name: publication.identity.structuredData.authorName,
              url: publication.identity.structuredData.authorUrl
            }
          }
        : {}),
      ...(publication.ogImage ? { image: publication.ogImage } : {})
    }).replace(/</g, "\\u003c");
    const socialMeta = [
      `<script type="application/ld+json">${structuredData}</script>`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${publication.canonicalUrl}">`,
      `<meta property="og:title" content="${publication.siteTitle}">`,
      `<meta property="og:description" content="${publication.description}">`,
      ...(publication.ogImage
        ? [
            `<meta property="og:image" content="${publication.ogImage}">`,
            `<meta property="og:image:width" content="1200">`,
            `<meta property="og:image:height" content="630">`,
            `<meta name="twitter:card" content="summary_large_image">`,
            `<meta name="twitter:image" content="${publication.ogImage}">`
          ]
        : [`<meta name="twitter:card" content="summary">`]),
      `<meta name="twitter:title" content="${publication.siteTitle}">`,
      `<meta name="twitter:description" content="${publication.description}">`
    ].join("\n    ");
    html = html
      .replace("<title>Delegated.watch</title>", `<title>${publication.siteTitle}</title>`)
      .replace(
        '<meta name="description" content="Account-wide record of AI work delegated to models, across every provider, surface, and machine.">',
        `<meta name="description" content="${publication.description}">\n    <link rel="canonical" href="${publication.canonicalUrl}">\n    ${socialMeta}`
      )
      .replace("<h1 id=\"page-title\">Delegated.watch</h1>", "<h1 id=\"page-title\">AI usage over time</h1>")
      .replace(
        "<p class=\"lede\">Daily AI usage across exact logs and labeled estimates, normalized into one scrubbed file.</p>",
        "<p class=\"lede\">Recovered daily token usage across providers and tools, with exact counters kept distinct from conservative estimates and unrecoverable history kept visible as unknown.</p>"
      );
    if (publication.identity) {
      html = html
        .replace(
          "<p class=\"eyebrow\">Local usage surface</p>",
          `<p class="eyebrow">${escapeAmpersand(publication.identity.eyebrow)}</p>`
        )
        .replace(
          '    <main class="shell">',
          `${buildPersonalSiteNav(publication.identity)}\n    <main class="shell">`
        )
        .replace("    </main>", `    </main>\n${buildPersonalSiteFooter(publication.identity)}`);
    }
  }

  const page = html
    .replace("    <!--SITE_DISCOVERY-->\n", () => {
      const discovery = buildSiteDiscovery(site, publication);
      return discovery ? `${discovery}\n` : "";
    })
    .replace('<link rel="stylesheet" href="/src/styles.css">', () => `<style>\n${css}\n</style>`)
    .replace(
      '<script type="module" src="/src/app.js"></script>',
      () => `${dataScript}\n<script type="module">\n${modelForPage}\n${appForPage}\n</script>`
    );

  if (page.includes("/src/app.js") || page.includes("/src/styles.css") || page.includes("./dashboard-model.js")) {
    throw new Error("Static build retained a source asset reference.");
  }
  return page;
}

export async function renderStaticRecords({
  records,
  sourceColumns,
  publication
}) {
  const [htmlSource, css, recordsApp] = await Promise.all([
    readFile("src/records.html", "utf8"),
    readFile("src/styles.css", "utf8"),
    readFile("src/records.js", "utf8")
  ]);
  const recordsCanonical = new URL("records/", publication.canonicalUrl).href;
  const html = htmlSource
    .replace("<title>Recent AI usage records</title>", `<title>${publication.recordsTitle}</title>`)
    .replace(
      '<meta name="description" content="The latest 30 recovered AI usage records, with empty source columns omitted.">',
      `<meta name="description" content="${publication.recordsDescription}">`
    )
    .replace('<link rel="canonical" href="">', `<link rel="canonical" href="${recordsCanonical}">`);
  const dataScript = [
    "<script>",
    `window.__RECENT_RECORDS__ = ${inlineJson(records)};`,
    `window.__RECENT_SOURCES__ = ${inlineJson(sourceColumns)};`,
    "</script>"
  ].join("\n");
  const page = html
    .replace('<link rel="stylesheet" href="/src/styles.css">', () => `<style>\n${css}\n</style>`)
    .replace(
      '<script type="module" src="/src/records.js"></script>',
      () => `${dataScript}\n<script type="module">\n${recordsApp}\n</script>`
    );
  if (page.includes("/src/records.js") || page.includes("/src/styles.css")) {
    throw new Error("Static records build retained a source asset reference.");
  }
  return page;
}
