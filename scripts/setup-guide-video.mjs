// The InfiniBot setup-guide video: ONE config for infinibotos.com.
//
// Swap in a v2 by uploading the new files to the media site
// (deploy/infinibot-media/README.md) under a new dated folder and changing
// SETUP_GUIDE below. Everything else (landing, /download, docs pages, the
// VideoObject JSON-LD) is rendered from this constant at build time by
// scripts/build-landing-publish.mjs and scripts/render-docs-static.mjs.

export const SETUP_GUIDE = {
  version: "2026-10-26",
  base: "https://infinibot-media.netlify.app/setup-guide/2026-10-26/",
  files: {
    mp4_1080: "infinibot-setup-guide-1080p.mp4",
    mp4_720: "infinibot-setup-guide-720p.mp4",
    poster: "infinibot-setup-guide-poster.jpg",
    captions: "infinibot-setup-guide.en.vtt",
    chapters: "infinibot-setup-guide.chapters.vtt",
  },
  title: "InfiniBot Setup Guide (2026): from zero to your first message",
  description:
    "Install and set up InfiniBot, the AI operating system, in about 6 minutes: the desktop app for Windows and Linux, the 8-step setup, API keys explained simply, the cloud and npm routes, and fixes for the most common problems.",
  uploadDate: "2026-10-26",
  durationSec: 372,
  chapters: [
    { t: 0, title: "Intro: what InfiniBot is" },
    { t: 24, title: "Download & install" },
    { t: 82, title: "First launch & the 8-step setup" },
    { t: 159, title: "AI brain & API keys" },
    { t: 232, title: "Getting started" },
    { t: 259, title: "Cloud route" },
    { t: 286, title: "npm route" },
    { t: 310, title: "Common issues & fixes" },
    { t: 357, title: "Get help" },
  ],
};

const url = (k) => SETUP_GUIDE.base + SETUP_GUIDE.files[k];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const isoDuration = (s) => `PT${Math.floor(s / 60)}M${s % 60}S`;

/** schema.org VideoObject (with chapter Clips). `pageUrl` = the page that embeds it. */
export function setupGuideJsonLd(pageUrl) {
  const g = SETUP_GUIDE;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: g.title,
    description: g.description,
    thumbnailUrl: [url("poster")],
    uploadDate: g.uploadDate,
    duration: isoDuration(g.durationSec),
    contentUrl: url("mp4_1080"),
    embedUrl: `${pageUrl}#setup-guide`,
    inLanguage: "en",
    publisher: { "@type": "Organization", name: "Kingly Intelligence Systems, LLC", url: "https://infinibotos.com" },
    hasPart: g.chapters.map((c, i) => ({
      "@type": "Clip",
      name: c.title,
      startOffset: c.t,
      endOffset: g.chapters[i + 1]?.t ?? g.durationSec,
      url: `${pageUrl}?t=${c.t}#setup-guide`,
    })),
  };
}

export function setupGuideJsonLdTag(pageUrl) {
  return `<script type="application/ld+json">${JSON.stringify(setupGuideJsonLd(pageUrl)).replace(/</g, "\\u003c")}</script>`;
}

/**
 * Player markup. Static (poster, chapters, sizes) so there is no layout shift;
 * /assets/setup-guide/setup-guide.js swaps the poster for a <video> on click.
 * Never autoplays.
 */
export function setupGuidePlayerHtml({ id = "setup-guide", compact = false } = {}) {
  const g = SETUP_GUIDE;
  const chapters = g.chapters
    .map(
      (c, i) =>
        `<li><button type="button" class="sg-chap" data-t="${c.t}" aria-label="Play from ${fmtTime(c.t)}: ${esc(c.title)}"><span class="sg-chap__n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><span class="sg-chap__title">${esc(c.title)}</span><span class="sg-chap__t">${fmtTime(c.t)}</span></button></li>`,
    )
    .join("");
  // Cloud first: every setup-video placement leads with the hosted path; the
  // video then shows the run-it-yourself install for anyone who wants it.
  const cloud = `<div class="sg-cloud" role="note">
  <p class="sg-cloud__text"><b>Skip the install.</b> Start on InfiniBot Cloud and your private InfiniBot opens in the browser. Free plan, no card; paid plans from $19/mo.</p>
  <div class="sg-cloud__actions"><a class="sg-cloud__btn" href="https://cloud.infinibotos.com/app/" data-cta="cloud">Start on InfiniBot Cloud</a><a class="sg-cloud__alt" href="/download">Or run it yourself, free &rarr;</a></div>
</div>`;
  return `${cloud}
<div class="sg${compact ? " sg--compact" : ""}" id="${esc(id)}" data-setup-guide data-src-hd="${esc(url("mp4_1080"))}" data-src-sd="${esc(url("mp4_720"))}" data-captions="${esc(url("captions"))}" data-chapters="${esc(url("chapters"))}">
  <div class="sg-frame">
    <button type="button" class="sg-poster" aria-label="Play the ${fmtTime(g.durationSec)} InfiniBot setup guide video">
      <img src="${esc(url("poster"))}" alt="" width="1280" height="720" loading="lazy" decoding="async">
      <span class="sg-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg></span>
      <span class="sg-badge"><span class="sg-badge__dot" aria-hidden="true"></span><span class="sg-badge__label">Watch the setup guide</span><span class="sg-badge__dur">${fmtTime(g.durationSec)}</span></span>
    </button>
  </div>
  <div class="sg-meta">
    <p class="sg-chapters-label" id="${esc(id)}-chapters-label">Chapters <span>· tap to jump</span></p>
    <ol class="sg-chapters" aria-labelledby="${esc(id)}-chapters-label">${chapters}</ol>
  </div>
  <noscript><p class="sg-noscript"><a href="${esc(url("mp4_1080"))}">Watch the setup guide (MP4, ${fmtTime(g.durationSec)})</a></p></noscript>
</div>`;
}

/** <head> assets for a page that embeds the player. */
export const SETUP_GUIDE_HEAD = `<link rel="stylesheet" href="/assets/setup-guide/setup-guide.css">
<script src="/assets/setup-guide/setup-guide.js" defer></script>`;

/**
 * Fill the build markers a page opts in with:
 *   <!--setup-guide:head-->     stylesheet + script
 *   <!--setup-guide:player-->   full player (`<!--setup-guide:player compact-->` for the stacked layout)
 *   <!--setup-guide:jsonld-->   VideoObject JSON-LD for `pageUrl`
 */
export function injectSetupGuide(html, pageUrl) {
  return html
    .replace(/<!--setup-guide:head-->/g, SETUP_GUIDE_HEAD)
    .replace(/<!--setup-guide:jsonld-->/g, () => setupGuideJsonLdTag(pageUrl))
    .replace(/<!--setup-guide:player( compact)?-->/g, (_, c) => setupGuidePlayerHtml({ compact: Boolean(c) }));
}
