#!/usr/bin/env node
// Plugin showcase for infinibotos.com: the homepage "Plugins" section, /plugins and
// one static page per plugin at /plugins/<id>.
//
//   node scripts/build-plugin-pages.mjs   (run before build-landing-publish.mjs)
//
// Content (outcome, who it's for, capabilities, steps, requirements, responsible use,
// FAQs, demo clips, KinglyVault lesson links) comes from docs/plugin-showcase.json,
// which has NO prices on purpose. Prices, versions, icons, screenshots and purchase
// URLs come from the public registry, fetched here at build time:
//   https://cloud.infinibotos.com/api/marketplace/index.json
// (override with PLUGIN_REGISTRY_FILE=<path> for an offline build). Totals are
// computed from the registry; nothing price-related is hardcoded.
//
// Writes:
//   docs/landing.html            region between <!--plugins:section:start/end-->
//   docs/plugins-site/index.html → published as /plugins.html = /plugins (build-landing-publish.mjs)
//   docs/plugins-site/<id>.html  → published as /plugins/<id>
//   docs/_redirects              region between # plugins:redirects:start/end

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const OUT = path.join(DOCS, "plugins-site");
const SITE = "https://infinibotos.com";
const REGISTRY_URL = "https://cloud.infinibotos.com/api/marketplace/index.json";
const CEO_URL = "https://kinglyvault.com/infinibot-plugins";
const CLOUD_APP = "https://cloud.infinibotos.com/app/";
const CEO_LABEL = "KinglyVault CEO ($47/mo)";
const CLOUD_MARKET = "https://cloud.infinibotos.com/marketplace/";
const OG_DEFAULT = `${SITE}/assets/landing/og-2026.png`;

const showcase = JSON.parse(fs.readFileSync(path.join(DOCS, "plugin-showcase.json"), "utf8"));

async function loadRegistry() {
  if (process.env.PLUGIN_REGISTRY_FILE) return JSON.parse(fs.readFileSync(process.env.PLUGIN_REGISTRY_FILE, "utf8"));
  const res = await fetch(REGISTRY_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`registry ${REGISTRY_URL}: HTTP ${res.status}`);
  return res.json();
}
const registry = await loadRegistry();
const byId = new Map((registry.plugins ?? []).map((p) => [p.id, p]));

// ---------- data ----------
const media = (rel) => (rel ? showcase.media + rel : null);
const lessonUrl = (l) => (l ? showcase.kvCourseUrl.replace("{course}", l.course).replace("{lesson}", l.lesson) : null);
const usd = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

const plugins = [];
for (const s of showcase.plugins) {
  const r = byId.get(s.id) ?? null;
  if (s.kind !== "builtin" && !r) {
    console.warn(`build-plugin-pages: ${s.id} is not in the registry, skipped`);
    continue;
  }
  const paid = r?.pricing?.model === "paid" && r.pricing.priceCents > 0;
  plugins.push({
    ...s,
    reg: r,
    tier: s.kind === "builtin" ? "builtin" : paid ? "paid" : "free",
    priceCents: paid ? r.pricing.priceCents : 0,
    buyUrl: paid ? r.pricing.purchaseUrl : null,
    getUrl: s.kind === "builtin" ? "/download" : `${CLOUD_MARKET}${s.id}`,
    icon: r?.listing?.icon ?? null,
    cover: r?.listing?.cover ?? null,
    shots: r?.listing?.screenshots ?? [],
    url: `/plugins/${s.id}`,
    iconName: s.icon ?? null,
  });
}
const paidList = plugins.filter((p) => p.tier === "paid");
const totalCents = paidList.reduce((n, p) => n + p.priceCents, 0);
const freeList = plugins.filter((p) => p.tier === "free");
const builtinList = plugins.filter((p) => p.tier === "builtin");
const VALUE_LINE = `${CEO_LABEL} includes all ${paidList.length} paid plugins — ${usd(totalCents)} if bought separately (one-time prices)`;

// ---------- html helpers ----------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (v) => JSON.stringify(v, null, 1).replace(/</g, "\\u003c");
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const PLAY = '<span class="ps-play__btn" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"/></svg>';
const WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>';
// Builtins have no registry icon: premium line icons in the registry icons' style.
const BUILTIN_ICON = {
  discord: '<path d="M8.5 6.5c-1.4.3-2.7.8-3.8 1.5C3 10.7 2.5 13.6 2.8 16.4c1.4 1.1 2.9 1.8 4.4 2.2l1-1.7M15.5 6.5c1.4.3 2.7.8 3.8 1.5 1.7 2.7 2.2 5.6 1.9 8.4-1.4 1.1-2.9 1.8-4.4 2.2l-1-1.7M7.5 16.3c2.9 1.2 6.1 1.2 9 0M9 6.3a12 12 0 0 1 6 0"/><circle cx="9.3" cy="12.6" r="1.3"/><circle cx="14.7" cy="12.6" r="1.3"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><circle cx="6.2" cy="6.8" r=".6"/><circle cx="8.4" cy="6.8" r=".6"/><path d="M10 12.5v5l1.6-1.5 1.1 2.3 1.2-.6-1.1-2.2h2.2z"/>',
};
function iconHtml(p, size = 44) {
  if (p.icon) return `<img class="ps-icon" src="${esc(p.icon)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
  const d = BUILTIN_ICON[p.iconName] ?? BUILTIN_ICON.browser;
  return `<span class="ps-icon ps-icon--svg" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></span>`;
}

function badge(p) {
  if (p.tier === "paid") return `<span class="ps-badges"><span class="pill pill--gold">Included in KV CEO</span><span class="ps-or">or ${usd(p.priceCents)} one-time</span></span>`;
  if (p.tier === "free") return `<span class="ps-badges"><span class="pill pill--ok">Free</span></span>`;
  return `<span class="ps-badges"><span class="pill">Included with InfiniBot</span></span>`;
}

/** Poster button that swaps itself for a <video> on click (plugins.js). */
function demoMedia(clip, { label, w = 1280, h = 720, eager = false, cls = "" } = {}) {
  if (!clip) return "";
  const video = media(`${clip.slug}-720p.mp4`);
  const poster = media(`${clip.slug}-poster.jpg`);
  const aria = `Play video: ${label ?? clip.title}`;
  return `<button type="button" class="ps-play ${cls}" data-ps-video="${esc(video)}" data-ps-poster="${esc(poster)}" data-w="${w}" data-h="${h}" aria-label="${esc(aria)}" style="aspect-ratio:${w}/${h}"><img src="${esc(poster)}" alt="" width="${w}" height="${h}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">${PLAY}<span class="ps-play__title">${esc(clip.title)}</span></button>`;
}
function cardMedia(p) {
  if (p.demo) return demoMedia(p.demo, { label: `${p.name} demo: ${p.demo.title}` });
  if (p.cover) return `<a class="ps-cover" href="${p.url}" tabindex="-1" aria-hidden="true"><img src="${esc(p.cover)}" alt="" width="640" height="360" loading="lazy" decoding="async"></a>`;
  return "";
}

function card(p, { headingTag = "h3" } = {}) {
  const learn = lessonUrl(p.learn);
  const ctas = [];
  if (p.tier === "paid") {
    ctas.push(`<a class="btn btn-primary btn-sm" href="${CEO_URL}" rel="noopener">Get it with CEO</a>`);
    ctas.push(`<a class="btn btn-secondary btn-sm" href="${esc(p.buyUrl)}" rel="noopener">Buy ${usd(p.priceCents)}</a>`);
  } else if (p.tier === "free") {
    ctas.push(`<a class="btn btn-primary btn-sm" href="${esc(p.getUrl)}" rel="noopener">Get it</a>`);
  } else {
    // Built in: Cloud first, self-host as the quieter option (2026-10-27 owner directive).
    if (p.reg?.cloud?.availability === "self-host-only") ctas.push(`<a class="btn btn-primary btn-sm" href="/download">Get InfiniBot</a>`);
    else ctas.push(`<a class="btn btn-primary btn-sm" href="${CLOUD_APP}" data-cta="cloud">Start on Cloud</a>`, `<a class="btn btn-ghost btn-sm" href="/download">Or self-host free</a>`);
  }
  return `<article class="card ps-card" id="plugin-${esc(p.id)}" data-tier="${p.tier}">
  <div class="ps-card__media">${cardMedia(p)}</div>
  <div class="ps-card__body">
    <div class="ps-card__head">${iconHtml(p)}<div><${headingTag} class="ps-card__name"><a href="${p.url}">${esc(p.name)}</a></${headingTag}>${badge(p)}</div></div>
    <p class="ps-card__outcome">${esc(p.outcome)}</p>
    <ul class="ps-caps">${p.capabilities.map((c) => `<li>${CHECK}<span>${esc(c)}</span></li>`).join("")}</ul>
  </div>
  <div class="ps-card__foot">
    <div class="btn-row">${ctas.join("")}</div>
    <div class="ps-links"><a href="${p.url}">Details</a>${learn ? `<a href="${esc(learn)}" rel="noopener">Learn</a>` : ""}</div>
  </div>
</article>`;
}

function valueBand({ compact = false } = {}) {
  return `<div class="ps-value${compact ? " ps-value--compact" : ""}">
  <div class="ps-value__mark" aria-hidden="true">CEO</div>
  <p class="ps-value__line" data-ps-value>${esc(VALUE_LINE)}</p>
  <div class="btn-row"><a class="btn btn-primary" href="${CEO_URL}" rel="noopener">See the CEO plan</a>${compact ? "" : `<a class="btn btn-secondary" href="/plugins">All plugins ${ARROW}</a>`}</div>
</div>`;
}

const SUMMARY = `${plugins.length} plugins: ${freeList.length} free, ${paidList.length} paid as a one-time purchase, and ${builtinList.length} included with InfiniBot.`;

// ---------- homepage section ----------
const section = `<section class="section ps-section" id="marketplace" data-spy aria-labelledby="ps-title">
  <div class="container container--wide">
    <div class="section-head">
      <p class="eyebrow">Plugins</p>
      <h2 class="h2" id="ps-title">Add a whole department <span class="it">in one click.</span></h2>
      <p class="lede">Plugins are complete apps inside InfiniBot that give your agents new skills. ${esc(SUMMARY)} Each one has a short demo from its course lesson.</p>
    </div>
    ${valueBand()}
    <div class="ps-grid">
${plugins.map((p) => card(p)).join("\n")}
    </div>
    <p class="muted ps-fine">Prices are one-time, in USD, from the live plugin registry. Free plugins install from the marketplace; paid ones unlock with the KinglyVault CEO plan or a one-time purchase. <a href="/plugins">Compare every plugin</a>.</p>
  </div>
</section>`;

// ---------- page shell ----------
const NAV = `<nav class="nav" aria-label="Primary">
  <a href="/" class="nav-brand">
    <picture><source srcset="/assets/landing/logos/infinibot-logo-160.avif" type="image/avif"><source srcset="/assets/landing/logos/infinibot-logo-160.webp" type="image/webp"><img class="nav-mark" alt="" width="34" height="34" decoding="async" src="/assets/landing/logos/infinibot-logo-160.png"></picture>
    InfiniBot
  </a>
  <div class="nav-links">
    <a href="/#what">What it does</a>
    <a href="/#use-cases">Use cases</a>
    <a href="/plugins" aria-current="page">Plugins</a>
    <a href="/#pricing">Pricing</a>
    <a href="https://cloud.infinibotos.com/licenses/" class="nav-lic">Licensing</a>
    <a href="/docs/start/getting-started/">Getting started</a>
    <a href="/docs/">Docs</a>
  </div>
  <a href="https://cloud.infinibotos.com/app/" class="nav-signin">Sign in</a>
  <a href="${CLOUD_APP}" class="btn btn-primary btn-sm nav-cta" data-cta="cloud">Start on Cloud</a>
  <button class="nav-burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="nav-drawer"><span></span><span></span><span></span></button>
</nav>
<div class="nav-drawer" id="nav-drawer" aria-hidden="true">
  <a href="/#what">What it does</a>
  <a href="/#use-cases">Use cases</a>
  <a href="/plugins">Plugins</a>
  <a href="/#pricing">Pricing</a>
  <a href="https://cloud.infinibotos.com/licenses/">Commercial licensing</a>
  <a href="/docs/start/getting-started/">Getting started guide</a>
  <a href="/docs/">Docs</a>
  <a href="https://cloud.infinibotos.com/app/">Sign in to InfiniBot Cloud</a>
  <a href="${CLOUD_APP}" class="btn btn-primary" data-cta="cloud">Start on InfiniBot Cloud</a>
  <a href="/download" class="nav-drawer__alt">Or run it yourself, free</a>
</div>`;

const FOOTER = `<footer class="footer">
  <div class="container">
    <div class="footer__grid">
      <div>
        <a href="/" class="nav-brand" style="margin-bottom:12px"><picture><source srcset="/assets/landing/logos/infinibot-logo-160.avif" type="image/avif"><source srcset="/assets/landing/logos/infinibot-logo-160.webp" type="image/webp"><img class="nav-mark" alt="" width="34" height="34" decoding="async" loading="lazy" src="/assets/landing/logos/infinibot-logo-160.png"></picture> InfiniBot</a>
        <p>An AI operating system for people who run things. Built and used in production every day by the KinglyVault team.</p>
      </div>
      <div><h3>Product</h3><ul><li><a href="/#what">What it does</a></li><li><a href="/#use-cases">Use cases</a></li><li><a href="/plugins">Plugins</a></li><li><a href="/#pricing">Pricing</a></li><li><a href="https://cloud.infinibotos.com/licenses/">Licensing</a></li><li><a href="/why-we-win">Why we win</a></li></ul></div>
      <div><h3>Get it</h3><ul><li><a href="https://cloud.infinibotos.com/app/">InfiniBot Cloud</a></li><li><a href="https://cloud.infinibotos.com/pricing">Cloud plans</a></li><li><a href="/docs/start/getting-started/">Getting started</a></li><li><a href="/download">Desktop app (self-host)</a></li><li><a href="/docs/install/">Install guide</a></li><li><a href="https://cloud.infinibotos.com/marketplace">Plugin marketplace</a></li></ul></div>
      <div><h3>Learn</h3><ul><li><a href="/docs/">Documentation</a></li><li><a href="/docs/plugins/">Plugin docs</a></li><li><a href="${CEO_URL}" rel="noopener">CEO plan on KinglyVault</a></li><li><a href="/#kv-contact">Contact</a></li></ul></div>
    </div>
    <div class="footer__bottom">
      <span>© 2026 Kingly Intelligence Systems, LLC. InfiniBot is source-available under FSL-1.1-ALv2; each release becomes Apache-2.0 two years after it ships. Building a hosted, resale, white-label or OEM product on it? See <a href="https://cloud.infinibotos.com/licenses/">commercial licenses</a>.</span>
      <span>Trading plugins show analysis, not financial advice. OmniClinic supports research, not diagnosis.</span>
    </div>
  </div>
</footer>`;

function shell({ path: pagePath, title, description, ogImage = OG_DEFAULT, ogAlt = "InfiniBot plugins", jsonLd = [], body, preload }) {
  const url = `${SITE}${pagePath}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#050507">
<meta property="og:type" content="website">
<meta property="og:site_name" content="InfiniBot">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:alt" content="${esc(ogAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@infinibotos">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" type="image/png" href="/assets/landing/logos/infinibot-favicon-96.png" sizes="any">
<link rel="apple-touch-icon" href="/assets/landing/logos/infinibot-favicon-96.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${preload ? `<link rel="preload" as="image" href="${esc(preload)}" fetchpriority="high">\n` : ""}<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" media="print" onload='this.media="all"'>
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap"></noscript>
<link rel="stylesheet" href="/assets/landing/site.css">
<link rel="stylesheet" href="/assets/landing/plugins.css">
${jsonLd.map((j) => `<script type="application/ld+json">\n${json(j)}\n</script>`).join("\n")}
</head>
<body class="ps-page" data-ps-page>
<a class="skip" href="#main">Skip to content</a>
${NAV}
<main id="main">
${body}
</main>
${FOOTER}
<script src="/assets/landing/plugins.js" defer></script>
</body>
</html>
`;
}

const crumbs = (items) => `<nav class="ps-crumbs" aria-label="Breadcrumb">${items.map(([n, h], i) => (i < items.length - 1 ? `<a href="${h}">${esc(n)}</a><span aria-hidden="true">/</span>` : `<span aria-current="page">${esc(n)}</span>`)).join("")}</nav>`;
const breadcrumbLd = (items) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, href], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE}${href}` })),
});
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

// ---------- /plugins ----------
function indexPage() {
  const reel = showcase.reel;
  // The reel's poster is not named <slug>-poster.jpg, so render it directly.
  const reelHtml = reel
    ? `<button type="button" class="ps-play ps-play--reel" data-ps-video="${esc(media(reel.video))}" data-ps-poster="${esc(media(reel.poster))}" data-w="720" data-h="1280" aria-label="${esc(`Play video: ${reel.caption}`)}" style="aspect-ratio:720/1280"><img src="${esc(media(reel.poster))}" alt="" width="540" height="960" fetchpriority="high" decoding="async">${PLAY}<span class="ps-play__title">${esc(reel.caption)}</span></button>`
    : "";
  const rows = paidList
    .map((p) => `<tr><th scope="row"><a href="${p.url}">${esc(p.name)}</a></th><td>${usd(p.priceCents)}<span class="ps-ot"> one-time</span></td><td><span class="ps-yes">${CHECK}Included</span></td><td><a href="${esc(p.buyUrl)}" rel="noopener">Buy</a></td></tr>`)
    .join("");
  const body = `
<section class="section ps-hero">
  <div class="container container--wide ps-hero__grid">
    <div>
      ${crumbs([["Home", "/"], ["Plugins", "/plugins"]])}
      <p class="eyebrow">Plugins</p>
      <h1 class="h2 ps-h1">Plugins for <span class="it">InfiniBot.</span></h1>
      <p class="lede">Complete apps that live inside InfiniBot and give your agents new skills: content, phones, trading, research, your business and your community. ${esc(SUMMARY)}</p>
      <div class="btn-row" style="margin-top:26px"><a class="btn btn-primary" href="${CEO_URL}" rel="noopener">Get every paid plugin with CEO</a><a class="btn btn-secondary" href="#all">Browse plugins ${ARROW}</a></div>
      <p class="ps-value__line ps-hero__value" data-ps-value>${esc(VALUE_LINE)}</p>
    </div>
    <div class="ps-hero__reel">${reelHtml}</div>
  </div>
</section>

<section class="section section--tight" id="value" aria-labelledby="value-title">
  <div class="container">
    <div class="section-head"><p class="eyebrow">Paid plugins</p><h2 class="h2" id="value-title" style="font-size:var(--fs-h3)">One plan, or <span class="it">one at a time.</span></h2>
      <p class="lede">Paid plugins are one-time purchases. The KinglyVault CEO plan includes all of them. Prices below come from the live plugin registry.</p></div>
    <div class="ps-table-wrap"><table class="ps-table">
      <caption class="sr-only">Paid InfiniBot plugins: one-time price and KinglyVault CEO inclusion</caption>
      <thead><tr><th scope="col">Plugin</th><th scope="col">Bought separately</th><th scope="col">KV CEO</th><th scope="col"><span class="sr-only">Buy</span></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">All ${paidList.length} paid plugins</th><td>${usd(totalCents)}<span class="ps-ot"> one-time</span></td><td><span class="ps-yes">${CHECK}Included</span></td><td></td></tr></tfoot>
    </table></div>
    ${valueBand({ compact: true })}
    <p class="muted ps-fine">${freeList.length} plugins are free (${freeList.map((p) => esc(p.name)).join(", ")}). ${builtinList.map((p) => esc(p.name)).join(" and ")} ${builtinList.length === 1 ? "is" : "are"} included with InfiniBot.</p>
  </div>
</section>

<section class="section" id="all" aria-labelledby="all-title">
  <div class="container container--wide">
    <div class="section-head"><p class="eyebrow">All plugins</p><h2 class="h2" id="all-title" style="font-size:var(--fs-h3)">Pick what your business <span class="it">needs.</span></h2></div>
    <div class="ps-grid">
${plugins.map((p) => card(p, { headingTag: "h3" })).join("\n")}
    </div>
  </div>
</section>`;
  return shell({
    path: "/plugins",
    title: "InfiniBot Plugins: apps and agent skills for your AI OS",
    description: clip(`InfiniBot plugins: ${plugins.map((p) => p.name).join(", ")}. Watch a demo of each, see who it's for and how to start. ${VALUE_LINE}.`, 300),
    ogImage: reel ? media(reel.poster) : OG_DEFAULT,
    ogAlt: reel?.caption,
    preload: reel ? media(reel.poster) : null,
    body,
    jsonLd: [
      breadcrumbLd([["Home", "/"], ["Plugins", "/plugins"]]),
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "InfiniBot plugins",
        itemListElement: plugins.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.name, url: `${SITE}${p.url}` })),
      },
    ],
  });
}

// ---------- /plugins/<id> ----------
const CLOUD_LABEL = { available: "Works on InfiniBot Cloud", partial: "Works on InfiniBot Cloud, with some features self-hosted only", "coming-soon": "Coming soon to InfiniBot Cloud", "self-host-only": "Self-hosted InfiniBot only" };

function pluginPage(p) {
  const learn = lessonUrl(p.learn);
  const crumbItems = [["Home", "/"], ["Plugins", "/plugins"], [p.name, p.url]];
  const priceText = p.tier === "paid" ? `Included in KinglyVault CEO, or ${usd(p.priceCents)} one-time` : p.tier === "free" ? "Free" : "Included with InfiniBot";
  const ctas =
    p.tier === "paid"
      ? `<a class="btn btn-primary" href="${CEO_URL}" rel="noopener">Get it with KinglyVault CEO</a><a class="btn btn-secondary" href="${esc(p.buyUrl)}" rel="noopener">Buy for ${usd(p.priceCents)} one-time</a>`
      : p.tier === "free"
        ? `<a class="btn btn-primary" href="${esc(p.getUrl)}" rel="noopener">Get it free</a><a class="btn btn-secondary" href="${CLOUD_APP}" data-cta="cloud">Start on InfiniBot Cloud</a><a class="btn btn-ghost" href="/download">Or run it yourself, free</a>`
        : p.reg?.cloud?.availability === "self-host-only"
          ? `<a class="btn btn-primary" href="/download">Get InfiniBot</a><a class="btn btn-secondary" href="${CLOUD_APP}">Open InfiniBot Cloud</a>`
          : `<a class="btn btn-primary" href="${CLOUD_APP}" data-cta="cloud">Start on InfiniBot Cloud</a><a class="btn btn-ghost" href="/download">Or run it yourself, free</a>`;
  const meta = [
    ["Price", priceText],
    p.reg?.version ? ["Version", p.reg.version] : null,
    p.reg?.cloud?.availability ? ["Where it runs", CLOUD_LABEL[p.reg.cloud.availability] ?? p.reg.cloud.availability] : null,
    ["Publisher", p.reg ? `${p.reg.publisher?.name ?? "InfiniBot"} (first-party)` : "InfiniBot (built in)"],
  ].filter(Boolean);
  const examples = (p.examples ?? []).map((e) => `<figure class="ps-example">${demoMedia(e, { label: e.title })}<figcaption><a href="${esc(lessonUrl(e))}" rel="noopener">${esc(e.title)}</a></figcaption></figure>`).join("");
  const shots = p.shots.map((s) => `<figure class="ps-shot"><img src="${esc(s.src)}" alt="${esc(s.caption ? `${p.name}: ${s.caption}` : `${p.name} screenshot`)}" width="1280" height="800" loading="lazy" decoding="async">${s.caption ? `<figcaption>${esc(s.caption)}</figcaption>` : ""}</figure>`).join("");
  const respLesson = lessonUrl(p.responsibleLesson);
  const faqs = p.faqs ?? [];
  const desc = clip(`${p.outcome} ${p.forWho}`, 158);
  const title = `${p.name}: InfiniBot plugin${p.tier === "paid" ? "" : p.tier === "free" ? " (free)" : ""} | demo, setup, FAQ`;

  const body = `
<section class="section ps-hero ps-hero--plugin">
  <div class="container ps-hero__grid ps-hero__grid--plugin">
    <div>
      ${crumbs(crumbItems)}
      <div class="ps-title">${iconHtml(p, 64)}<div><p class="eyebrow eyebrow--plain">${p.tier === "builtin" ? "Built into InfiniBot" : "InfiniBot plugin"}</p><h1 class="h2 ps-h1">${esc(p.name)}</h1></div></div>
      <p class="lede">${esc(p.outcome)}</p>
      ${badge(p)}
      <div class="btn-row" style="margin-top:22px">${ctas}</div>
      ${learn ? `<p class="ps-learn"><a href="${esc(learn)}" rel="noopener">Learn it step by step: ${esc(p.learn.title)} on KinglyVault ${ARROW}</a></p>` : ""}
    </div>
    <div class="ps-hero__demo">${p.demo ? demoMedia(p.demo, { label: `${p.name} demo: ${p.demo.title}`, eager: true }) : p.cover ? `<img class="ps-hero__cover" src="${esc(p.cover)}" alt="" width="640" height="360" fetchpriority="high">` : ""}</div>
  </div>
</section>

<section class="section section--tight">
  <div class="container ps-cols">
    <div>
      <h2 class="h3">Who it's for</h2>
      <p class="ps-p">${esc(p.forWho)}</p>
      <h2 class="h3" style="margin-top:34px">What it does</h2>
      <ul class="ps-caps ps-caps--lg">${p.capabilities.map((c) => `<li>${CHECK}<span>${esc(c)}</span></li>`).join("")}</ul>
    </div>
    <aside class="card ps-meta" aria-label="${esc(p.name)} details"><dl>${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
      ${p.reg?.cloud?.note ? `<p class="ps-meta__note">${esc(p.reg.cloud.note)}</p>` : ""}
    </aside>
  </div>
</section>

<section class="section section--tight">
  <div class="container">
    <h2 class="h3">How to start</h2>
    <ol class="ps-steps">${p.steps.map((s) => `<li><span>${esc(s)}</span></li>`).join("")}</ol>
  </div>
</section>
${examples ? `
<section class="section section--tight">
  <div class="container">
    <h2 class="h3">See it in action</h2>
    <div class="ps-examples">${examples}</div>
  </div>
</section>` : ""}${shots ? `
<section class="section section--tight">
  <div class="container">
    <h2 class="h3">Screenshots</h2>
    <div class="ps-shots">${shots}</div>
  </div>
</section>` : ""}

<section class="section section--tight">
  <div class="container ps-cols ps-cols--even">
    <div>
      <h2 class="h3">What you need</h2>
      <ul class="ps-reqs">${p.requirements.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    </div>
    ${p.responsibleUse ? `<div class="ps-resp" role="note" aria-label="Responsible use">${WARN}<div><h2 class="h4">Responsible use</h2><p>${esc(p.responsibleUse)}</p>${respLesson ? `<p><a href="${esc(respLesson)}" rel="noopener">Watch: ${esc(p.responsibleLesson.title)}</a></p>` : ""}</div></div>` : ""}
  </div>
</section>
${faqs.length ? `
<section class="section section--tight" aria-labelledby="faq-title">
  <div class="container">
    <h2 class="h3" id="faq-title">Questions</h2>
    <div class="ps-faq">${faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div>
  </div>
</section>` : ""}

<section class="section section--tight">
  <div class="container">
    ${p.tier === "paid" ? valueBand() : `<div class="ps-value"><div class="ps-value__mark" aria-hidden="true">+</div><p class="ps-value__line">${p.tier === "free" ? `${esc(p.name)} is free. Paid plugins: ${esc(VALUE_LINE)}.` : `${esc(p.name)} is included with InfiniBot. Paid plugins: ${esc(VALUE_LINE)}.`}</p><div class="btn-row"><a class="btn btn-secondary" href="/plugins">All plugins ${ARROW}</a></div></div>`}
  </div>
</section>`;

  const ld = [breadcrumbLd(crumbItems)];
  const app = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: p.name,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "InfiniBot plugin",
    operatingSystem: "InfiniBot (Windows, Linux, InfiniBot Cloud)",
    description: p.outcome,
    url: `${SITE}${p.url}`,
    publisher: { "@type": "Organization", name: "InfiniBot", url: `${SITE}/` },
  };
  if (p.reg?.version) app.softwareVersion = p.reg.version;
  if (p.demo) app.image = media(`${p.demo.slug}-poster.jpg`);
  if (p.reg) {
    // Offer only for a real registry price: paid → its one-time price, free → 0.
    app.offers = {
      "@type": "Offer",
      price: (p.priceCents / 100).toFixed(2),
      priceCurrency: p.reg.pricing.currency || "USD",
      url: p.tier === "paid" ? p.buyUrl : p.getUrl,
    };
  }
  ld.push(app);
  if (faqs.length) {
    ld.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
  }
  return shell({
    path: p.url,
    title,
    description: desc,
    ogImage: p.demo ? media(`${p.demo.slug}-poster.jpg`) : OG_DEFAULT,
    ogAlt: p.demo ? p.demo.title : `${p.name} for InfiniBot`,
    preload: p.demo ? media(`${p.demo.slug}-poster.jpg`) : null,
    body,
    jsonLd: ld,
  });
}

// ---------- write ----------
function replaceRegion(file, start, end, content) {
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${path.relative(ROOT, file)}: markers ${start} … ${end} not found`);
  fs.writeFileSync(file, text.slice(0, a + start.length) + "\n" + content + "\n" + text.slice(b));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "index.html"), indexPage());
for (const p of plugins) fs.writeFileSync(path.join(OUT, `${p.id}.html`), pluginPage(p));

replaceRegion(path.join(DOCS, "landing.html"), "<!--plugins:section:start-->", "<!--plugins:section:end-->", section);
// The "What it does" stat counts the registry's first-party plugins.
{
  const f = path.join(DOCS, "landing.html");
  const regFirst = (registry.plugins ?? []).filter((r) => r.firstParty);
  const regFree = regFirst.filter((r) => r.pricing?.model !== "paid").length;
  const t = fs.readFileSync(f, "utf8").replace(
    /<span data-count="\d+">\d+<\/span><\/b><span>first-party plugins, \d+ of them free<\/span>/,
    `<span data-count="${regFirst.length}">${regFirst.length}</span></b><span>first-party plugins, ${regFree} of them free</span>`,
  );
  fs.writeFileSync(f, t);
}

// Netlify matches a rule with or without a trailing slash, so no "/x/" variants.
const redirects = [
  "/plugins          /plugins.html         200",
  ...plugins.map((p) => `/plugins/${p.id}   /plugins/${p.id}.html   200`),
  "/plugins/*        /docs/404.html        404",
  "/marketplace      /plugins              301",
  ...plugins.map((p) => `/marketplace/${p.id}   /plugins/${p.id}   301`),
  "/marketplace/*    /plugins              301",
  "/pricing          /#pricing             301",
].join("\n");
replaceRegion(path.join(DOCS, "_redirects"), "# plugins:redirects:start", "# plugins:redirects:end", redirects);

console.log(`plugin pages: ${plugins.length} plugins (${paidList.length} paid = ${usd(totalCents)}, ${freeList.length} free, ${builtinList.length} builtin) → docs/plugins-site/, landing section, _redirects`);
console.log(`value line: ${VALUE_LINE}`);
