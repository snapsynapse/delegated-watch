import assert from "node:assert/strict";
import test from "node:test";

import { renderStaticDashboard } from "../scripts/lib/static-dashboard.js";

// Synthetic-only fixtures. Shape follows tests/dashboard-model.test.js.
const dailyBurn = [
  {
    date: "2026-01-01",
    timezone: "UTC",
    sources: { codex: { tokens: 100, fidelity: "exact" } },
    total: 100,
    driver: "building:feature"
  }
];
const profile = { timezone: "UTC", windowStart: "2026-01-01" };
const observedIntervals = { timezone: "UTC", sources: {} };

const reservedIdentity = {
  siteName: "Example Person",
  siteUrl: "https://example.org/",
  eyebrow: "Example Person's personal AI usage record",
  nav: [
    { label: "Blog", href: "https://example.org/blog", current: false },
    { label: "AI Usage", href: "https://example.org/usage/", current: true },
    { label: "Notes & Now", href: "https://example.org/now", current: false }
  ],
  footer: {
    copyright: "© 2026 Example Person",
    links: [
      { label: "Links", href: "https://example.org/links" },
      { label: "Signals & Subtractions", href: "https://example.org/signals" }
    ]
  },
  structuredData: {
    websiteId: "https://example.org/#website",
    authorId: "https://example.org/#example-person",
    authorName: "Example Person",
    authorUrl: "https://example.org/"
  }
};

const reservedPublication = {
  mode: "personal-public",
  canonicalUrl: "https://example.org/usage/",
  siteTitle: "AI Usage | Example Person",
  description: "Synthetic renderer-identity test fixture.",
  ogImage: undefined,
  identity: reservedIdentity
};

test("renderer identity: nav, footer, and ld+json come from publication.identity only", async () => {
  const page = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    publication: reservedPublication
  });

  assert.match(page, /<nav class="personal-site-nav" aria-label="Primary">/);
  assert.ok(page.includes('href="https://example.org/"'));
  assert.ok(page.includes('href="https://example.org/blog"'));
  assert.ok(page.includes('href="https://example.org/usage/" aria-current="page"'));

  assert.match(page, /<footer class="personal-site-footer">/);
  assert.ok(page.includes("© 2026 Example Person"));
  assert.ok(page.includes('href="https://example.org/links"'));
  assert.ok(page.includes("Signals &amp; Subtractions"));

  const jsonLdBlocks = [...page.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  assert.equal(jsonLdBlocks.length, 1);
  const structuredData = JSON.parse(jsonLdBlocks[0][1]);
  assert.equal(structuredData.isPartOf["@id"], "https://example.org/#website");
  assert.equal(structuredData.isPartOf.url, "https://example.org/");
  assert.equal(structuredData.isPartOf.name, "Example Person");
  assert.equal(structuredData.author["@id"], "https://example.org/#example-person");
  assert.equal(structuredData.author.name, "Example Person");
  assert.equal(structuredData.author.url, "https://example.org/");

  assert.ok(page.includes("Example Person's personal AI usage record"));

  // Every external link on the page belongs to the supplied identity. This is
  // stronger than checking for the absence of any one name: no other origin
  // can leak through the renderer, whatever it is called.
  const externalHrefs = [...page.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(externalHrefs.length > 0);
  assert.ok(externalHrefs.every((href) => href.startsWith("https://example.org/")), externalHrefs.join(", "));
  const structuredUrls = JSON.stringify(structuredData).match(/https?:\/\/[^"\\]+/g) ?? [];
  assert.ok(structuredUrls.every((url) => url.startsWith("https://example.org/") || url.startsWith("https://schema.org")), structuredUrls.join(", "));
});

test("renderer identity: publication null renders no personal blocks and the default eyebrow", async () => {
  const page = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    publication: null
  });

  assert.ok(!page.includes('<nav class="personal-site-nav"'));
  assert.ok(!page.includes('class="personal-site-footer"'));
  assert.ok(!/<script\b[^>]*type=["']application\/ld\+json["']/.test(page));
  assert.ok(page.includes('<p class="eyebrow">Local usage surface</p>'));
});

test("renderer identity: synthetic-dataset demo banner is gated on site.dataset", async () => {
  const withBanner = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    site: { dataset: "synthetic" }
  });
  assert.match(withBanner, /<p class="demo-banner" role="note">/);
  assert.ok(withBanner.includes(
    "This page renders synthetic demonstration data. Nothing here is a measured record."
  ));

  const withoutBanner = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    site: null
  });
  assert.ok(!withoutBanner.includes('class="demo-banner"'));
});

test("renderer site: only dataset and default_range reach the page", async () => {
  const page = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals: null,
    site: { dataset: "synthetic", default_range: "all", posture: "live", pages_verified: "never inlined" }
  });
  assert.ok(page.includes('window.__SITE__ = {"dataset":"synthetic","default_range":"all"};'));
  assert.ok(!page.includes("pages_verified"));
});

test("renderer identity: discovery metadata comes from site config, never the page source", async () => {
  const withoutSite = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals
  });

  // No site config means no absolute URL the page cannot honor, and no marker
  // left behind in the output.
  assert.ok(!withoutSite.includes("<!--SITE_DISCOVERY-->"));
  assert.ok(!/href="https:\/\/delegated\.watch/.test(withoutSite));
  assert.ok(!/<script\b[^>]*type=["']application\/ld\+json["']/.test(withoutSite));

  const withSite = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    site: { domain: "example.net" }
  });

  assert.ok(!withSite.includes("<!--SITE_DISCOVERY-->"));
  assert.ok(withSite.includes('<link rel="canonical" href="https://example.net/">'));
  assert.ok(withSite.includes('<meta property="og:url" content="https://example.net/">'));
  assert.ok(withSite.includes('<link rel="alternate" type="text/plain" href="https://example.net/llms.txt"'));
  assert.ok(withSite.includes('<meta property="og:image" content="https://example.net/imgs/og.png">'));
  assert.ok(withSite.includes('<meta name="twitter:image" content="https://example.net/imgs/og.png">'));
  assert.match(withSite, /<meta property="og:image:alt" content="[^"]{40,}">/);

  const blocks = [...withSite.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )].map((match) => JSON.parse(match[1]));
  assert.deepEqual(blocks.map((block) => block["@type"]), ["WebSite", "SoftwareApplication"]);
  assert.ok(blocks.every((block) => block.url === "https://example.net/"));

  // A publication config already emits its own canonical and social meta; the
  // site-driven set must not double up on it.
  const withBoth = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    site: { domain: "example.net" },
    publication: reservedPublication
  });
  assert.ok(!withBoth.includes("https://example.net/"));
});

test("renderer identity: no control ships a placeholder href", async () => {
  // The publication CTAs are hidden until a config supplies their URLs, and
  // they used to hold href="#" while waiting. Hidden is not absent: a fetcher
  // reading raw HTML sees a link that goes nowhere, and an external agent-
  // readiness scan counted both as dead CTAs on the live site. The activation
  // path already sets .href from the config, so the placeholder bought nothing.
  const page = await renderStaticDashboard({
    dailyBurn,
    profile,
    observedIntervals,
    publication: null
  });

  assert.ok(
    !/href=(["'])#\1/.test(page),
    'a control shipped href="#"; leave the attribute off and let activation set it'
  );
});
