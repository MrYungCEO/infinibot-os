/**
 * Landing-page renderer — converts a `LandingPage` (component schema) into a
 * static HTML site that can be zipped and shipped to a host (Netlify).
 *
 * Output is a flat directory:
 *   index.html    — the rendered page
 *   styles.css    — generated CSS
 *   track.js      — analytics + form-capture client script
 *   _redirects    — Netlify redirects (form-action proxy if needed)
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { LandingPage, PageComponent } from "../community/landing-pages.js";
import {
  buildBrandingCssVars,
  getBusinessBranding,
  projectBrandingToPageSettings,
} from "../business/branding.js";

// ── Helpers ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ── Component renderers ─────────────────────────────────────

function renderHero(c: any): string {
  const align = c.alignment || "center";
  const overlay = c.overlay
    ? `<div class="hero__overlay" style="opacity:${c.overlayOpacity ?? 0.5}"></div>`
    : "";
  const bgStyle: string[] = [];
  if (c.backgroundImage) bgStyle.push(`background-image:url('${escapeAttr(c.backgroundImage)}')`);
  if (c.backgroundColor) bgStyle.push(`background-color:${escapeAttr(c.backgroundColor)}`);
  return `<section class="lp-hero lp-hero--${align}" style="${bgStyle.join(";")}">
    ${overlay}
    <div class="lp-hero__inner">
      <h1>${escapeHtml(c.headline || "")}</h1>
      ${c.subheadline ? `<p class="lp-hero__sub">${escapeHtml(c.subheadline)}</p>` : ""}
      <div class="lp-hero__ctas">
        ${c.ctaText && c.ctaUrl ? `<a class="lp-btn lp-btn--primary" href="${escapeAttr(c.ctaUrl)}" data-track="cta:hero:primary">${escapeHtml(c.ctaText)}</a>` : ""}
        ${c.ctaSecondaryText && c.ctaSecondaryUrl ? `<a class="lp-btn lp-btn--secondary" href="${escapeAttr(c.ctaSecondaryUrl)}" data-track="cta:hero:secondary">${escapeHtml(c.ctaSecondaryText)}</a>` : ""}
      </div>
    </div>
  </section>`;
}

function renderFeatures(c: any): string {
  const items = (c.items || [])
    .map(
      (it: any) => `<div class="lp-feature">
      ${it.icon ? `<div class="lp-feature__icon">${escapeHtml(it.icon)}</div>` : ""}
      <h3>${escapeHtml(it.title || "")}</h3>
      <p>${escapeHtml(it.description || "")}</p>
      ${it.link ? `<a href="${escapeAttr(it.link)}" data-track="feature">Learn more</a>` : ""}
    </div>`,
    )
    .join("");
  return `<section class="lp-features lp-features--cols-${c.columns || 3}">
    ${c.title ? `<h2>${escapeHtml(c.title)}</h2>` : ""}
    ${c.subtitle ? `<p class="lp-section__sub">${escapeHtml(c.subtitle)}</p>` : ""}
    <div class="lp-features__grid">${items}</div>
  </section>`;
}

function renderCta(c: any): string {
  return `<section class="lp-cta">
    <h2>${escapeHtml(c.headline || c.title || "")}</h2>
    ${c.subheadline ? `<p>${escapeHtml(c.subheadline)}</p>` : ""}
    ${c.buttonText && c.buttonUrl ? `<a class="lp-btn lp-btn--primary lp-btn--lg" href="${escapeAttr(c.buttonUrl)}" data-track="cta:section">${escapeHtml(c.buttonText)}</a>` : ""}
  </section>`;
}

function renderText(c: any): string {
  return `<section class="lp-text">${c.html || `<p>${escapeHtml(c.content || "")}</p>`}</section>`;
}

function renderForm(c: any, ctx: { siteId: string; pageId: string }): string {
  const fields = (c.fields || [])
    .map((f: any) => {
      const id = `lp-field-${escapeAttr(f.name || f.id || "x")}`;
      const required = f.required ? "required" : "";
      const label = `<label for="${id}">${escapeHtml(f.label || f.name || "")}</label>`;
      let input = "";
      const name = escapeAttr(f.name || f.id || "");
      if (f.type === "textarea") {
        input = `<textarea id="${id}" name="${name}" ${required} placeholder="${escapeAttr(f.placeholder || "")}"></textarea>`;
      } else if (f.type === "select") {
        const opts = (f.options || [])
          .map(
            (o: any) =>
              `<option value="${escapeAttr(o.value || o)}">${escapeHtml(o.label || o)}</option>`,
          )
          .join("");
        input = `<select id="${id}" name="${name}" ${required}>${opts}</select>`;
      } else {
        input = `<input id="${id}" name="${name}" type="${escapeAttr(f.type || "text")}" placeholder="${escapeAttr(f.placeholder || "")}" ${required} />`;
      }
      return `<div class="lp-form__row">${label}${input}</div>`;
    })
    .join("");
  // Honeypot field
  const honeypot = `<div style="position:absolute;left:-9999px"><input type="text" name="company_url" tabindex="-1" autocomplete="off" /></div>`;
  return `<section class="lp-form-section">
    ${c.title ? `<h2>${escapeHtml(c.title)}</h2>` : ""}
    ${c.subtitle ? `<p>${escapeHtml(c.subtitle)}</p>` : ""}
    <form class="lp-form" data-form-id="${escapeAttr(c.id)}" data-site-id="${escapeAttr(ctx.siteId)}" data-page-id="${escapeAttr(ctx.pageId)}">
      ${honeypot}
      ${fields}
      <button type="submit" class="lp-btn lp-btn--primary lp-btn--block">${escapeHtml(c.submitText || "Submit")}</button>
      <div class="lp-form__status" hidden></div>
    </form>
  </section>`;
}

function renderFooter(c: any): string {
  const cols = (c.columns || [])
    .map(
      (col: any) => `<div class="lp-footer__col">
    <h4>${escapeHtml(col.title || "")}</h4>
    <ul>${(col.links || []).map((l: any) => `<li><a href="${escapeAttr(l.url || "")}" data-track="footer:link">${escapeHtml(l.label || "")}</a></li>`).join("")}</ul>
  </div>`,
    )
    .join("");
  return `<footer class="lp-footer">
    ${c.tagline ? `<p class="lp-footer__tagline">${escapeHtml(c.tagline)}</p>` : ""}
    <div class="lp-footer__cols">${cols}</div>
    ${c.copyright ? `<p class="lp-footer__copy">${escapeHtml(c.copyright)}</p>` : ""}
  </footer>`;
}

function renderCustom(c: any): string {
  const styleTag = c.css ? `<style>${c.css}</style>` : "";
  const scriptTag = c.js ? `<script>${c.js}</script>` : "";
  return `<section class="lp-custom">${styleTag}${c.html || ""}${scriptTag}</section>`;
}

function renderComponent(c: PageComponent, ctx: { siteId: string; pageId: string }): string {
  if (!c.visible) return "";
  switch (c.type) {
    case "hero":
      return renderHero(c);
    case "features":
      return renderFeatures(c);
    case "cta":
      return renderCta(c);
    case "text":
      return renderText(c);
    case "form":
      return renderForm(c, ctx);
    case "footer":
      return renderFooter(c);
    case "custom":
      return renderCustom(c);
    default:
      // Generic: just dump JSON for components we don't have specific renderers for yet.
      return `<section class="lp-${escapeAttr(c.type)}"><pre style="display:none">${escapeHtml(JSON.stringify(c, null, 2))}</pre></section>`;
  }
}

// ── CSS generator ───────────────────────────────────────────

function generateCss(settings: {
  colors?: { primary?: string; text?: string; background?: string };
  fonts?: { heading?: string; body?: string };
}): string {
  const c = settings.colors || {};
  const f = settings.fonts || {};
  const primary = c.primary || "#6366f1";
  const text = c.text || "#0f0f10";
  const bg = c.background || "#ffffff";
  const headingFont = f.heading || "system-ui, -apple-system, sans-serif";
  const bodyFont = f.body || "system-ui, -apple-system, sans-serif";
  return `:root {
  --lp-primary: ${primary};
  --lp-text: ${text};
  --lp-bg: ${bg};
}
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body { font-family: ${bodyFont}; color: var(--lp-text); background: var(--lp-bg); line-height:1.55; }
h1, h2, h3, h4 { font-family: ${headingFont}; line-height:1.15; margin: 0 0 .5em 0; }
h1 { font-size: clamp(2rem, 5vw, 3.5rem); }
h2 { font-size: clamp(1.5rem, 3vw, 2.25rem); }
section { padding: 64px 24px; max-width: 1200px; margin: 0 auto; }

.lp-hero { position: relative; padding: 120px 24px; background-position:center; background-size:cover; }
.lp-hero__overlay { position:absolute; inset:0; background:#000; }
.lp-hero__inner { position:relative; max-width: 880px; margin: 0 auto; }
.lp-hero--center .lp-hero__inner { text-align:center; }
.lp-hero--right .lp-hero__inner { text-align:right; }
.lp-hero__sub { font-size: 1.125rem; opacity:.85; margin-bottom: 1.5em; }
.lp-hero__ctas { display:flex; gap: 12px; flex-wrap:wrap; }
.lp-hero--center .lp-hero__ctas { justify-content:center; }

.lp-btn { display:inline-block; padding: 12px 22px; border-radius: 8px; text-decoration:none; font-weight:600; transition: transform .12s ease, opacity .12s ease; }
.lp-btn--primary { background: var(--lp-primary); color: #fff; }
.lp-btn--secondary { background: transparent; color: var(--lp-primary); border:1px solid var(--lp-primary); }
.lp-btn--lg { padding: 16px 28px; font-size: 1.05rem; }
.lp-btn--block { display:block; width:100%; text-align:center; }
.lp-btn:hover { transform: translateY(-1px); opacity:.92; }

.lp-section__sub { color: rgba(0,0,0,.55); margin-bottom: 2em; }
.lp-features__grid { display:grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.lp-features--cols-2 .lp-features__grid { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
.lp-features--cols-4 .lp-features__grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.lp-feature { padding: 20px; border-radius: 10px; background: rgba(0,0,0,.02); }
.lp-feature__icon { font-size: 2rem; margin-bottom: .5em; }

.lp-cta { text-align:center; background: rgba(99,102,241,.06); border-radius: 16px; max-width: 1100px; }

.lp-form { display:grid; gap: 12px; max-width: 480px; }
.lp-form__row { display:grid; gap: 4px; }
.lp-form input, .lp-form textarea, .lp-form select {
  width:100%; padding: 10px 12px; border:1px solid rgba(0,0,0,.18); border-radius: 8px; font: inherit;
}
.lp-form__status { padding: 10px 12px; border-radius: 8px; }
.lp-form__status[data-state="ok"] { background: rgba(34,197,94,.12); color: #14532d; }
.lp-form__status[data-state="error"] { background: rgba(239,68,68,.12); color: #7f1d1d; }

.lp-footer { padding: 48px 24px; background: rgba(0,0,0,.03); }
.lp-footer__cols { display:grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); max-width: 1200px; margin: 0 auto; }
.lp-footer__col h4 { font-size: .85rem; letter-spacing:.06em; text-transform: uppercase; opacity:.65; }
.lp-footer__col ul { list-style:none; padding:0; margin:0; }
.lp-footer__col li { margin: 4px 0; }
.lp-footer__col a { color: inherit; text-decoration: none; opacity:.8; }
.lp-footer__col a:hover { opacity:1; }
.lp-footer__copy { text-align:center; opacity:.55; margin-top: 32px; font-size:.85rem; }

@media (max-width: 720px) {
  section { padding: 48px 18px; }
  .lp-hero { padding: 80px 18px; }
}
`;
}

// ── track.js generator ──────────────────────────────────────

function generateTrackJs(opts: {
  gatewayUrl: string;
  siteId: string;
  pageId: string;
  pageSlug: string;
}): string {
  const cfg = JSON.stringify(opts);
  return `(function(){
  var CFG = ${cfg};
  var sessId = (function(){
    try { var k='lp_sid'; var s=sessionStorage.getItem(k); if(!s){ s=Math.random().toString(36).slice(2)+Date.now().toString(36); sessionStorage.setItem(k,s);} return s; } catch(_) { return 'anon'; }
  })();
  var queue = [];
  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    try {
      var body = JSON.stringify({ siteId: CFG.siteId, pageId: CFG.pageId, pageSlug: CFG.pageSlug, sessId: sessId, events: batch });
      if (navigator.sendBeacon) { navigator.sendBeacon(CFG.gatewayUrl + '/api/pages/track', new Blob([body], {type:'application/json'})); }
      else { fetch(CFG.gatewayUrl + '/api/pages/track', { method:'POST', body: body, headers:{'Content-Type':'application/json'}, keepalive:true }).catch(function(){}); }
    } catch(_) {}
  }
  function track(name, props) { queue.push({ name: name, props: props||{}, t: Date.now() }); if (queue.length >= 8) flush(); }
  document.addEventListener('DOMContentLoaded', function(){
    track('pageview', { ref: document.referrer, path: location.pathname, search: location.search });
    document.querySelectorAll('[data-track]').forEach(function(el){
      el.addEventListener('click', function(){ track('click', { id: el.getAttribute('data-track'), text: (el.textContent||'').trim().slice(0,80) }); flush(); });
    });
    document.querySelectorAll('form.lp-form').forEach(function(form){
      var started = false;
      form.querySelectorAll('input,textarea,select').forEach(function(inp){
        inp.addEventListener('focus', function(){ if(!started){ started=true; track('form_start', { formId: form.getAttribute('data-form-id') }); } });
      });
      form.addEventListener('submit', function(ev){
        ev.preventDefault();
        // honeypot guard
        var hp = form.querySelector('input[name="company_url"]'); if (hp && hp.value) { return; }
        var data = {};
        form.querySelectorAll('input,textarea,select').forEach(function(inp){ if(inp.name && inp.name !== 'company_url') data[inp.name] = inp.value; });
        var statusEl = form.querySelector('.lp-form__status');
        if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Sending...'; statusEl.removeAttribute('data-state'); }
        track('form_submit_attempt', { formId: form.getAttribute('data-form-id') });
        fetch(CFG.gatewayUrl + '/api/pages/' + CFG.siteId + '/forms/' + form.getAttribute('data-form-id') + '/submit', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pageId: CFG.pageId, data: data })
        }).then(function(r){ return r.ok ? r.json() : Promise.reject(r); }).then(function(){
          if (statusEl) { statusEl.setAttribute('data-state','ok'); statusEl.textContent = form.getAttribute('data-success') || 'Thanks — we\\'ll be in touch.'; }
          form.reset();
          track('form_submit_ok', { formId: form.getAttribute('data-form-id') }); flush();
        }).catch(function(){
          if (statusEl) { statusEl.setAttribute('data-state','error'); statusEl.textContent = 'Submission failed. Please try again.'; }
          track('form_submit_err', { formId: form.getAttribute('data-form-id') }); flush();
        });
      });
    });
    var depths = { 25:false, 50:false, 75:false, 100:false };
    window.addEventListener('scroll', function(){
      var p = (window.scrollY + window.innerHeight) / document.body.scrollHeight * 100;
      [25,50,75,100].forEach(function(d){ if(!depths[d] && p>=d){ depths[d]=true; track('scroll_depth', { depth:d }); } });
    });
    setInterval(flush, 5000);
    window.addEventListener('beforeunload', flush);
  });
})();
`;
}

// ── Render to directory ─────────────────────────────────────

export interface RenderOptions {
  page: LandingPage;
  outDir: string;
  /** Public gateway URL the analytics + form snippets will call back to. */
  gatewayUrl: string;
}

export async function renderPageToDirectory(
  opts: RenderOptions,
): Promise<{ outDir: string; html: string }> {
  const { page, outDir, gatewayUrl } = opts;
  const orderedComponents = (page.components || []).slice().sort((a, b) => a.order - b.order);
  const ctx = { siteId: page.communityId, pageId: page.id };
  const body = orderedComponents.map((c) => renderComponent(c, ctx)).join("\n");

  // Resolve effective settings: page-explicit values win, then business branding fallback.
  const biz = getBusinessBranding(page.communityId);
  const projection = biz ? projectBrandingToPageSettings(biz) : null;
  const effectiveSettings = {
    ...page.settings,
    title: page.settings.title || projection?.title || page.name,
    description: page.settings.description || projection?.description,
    ogImage: page.settings.ogImage || projection?.ogImage,
    favicon: page.settings.favicon || projection?.favicon,
    colors: { ...projection?.colors, ...page.settings.colors },
    fonts: { ...projection?.fonts, ...page.settings.fonts },
  };

  const title = escapeHtml(effectiveSettings.title || page.name);
  const description = effectiveSettings.description
    ? `<meta name="description" content="${escapeAttr(effectiveSettings.description)}" />`
    : "";
  const ogImg = effectiveSettings.ogImage
    ? `<meta property="og:image" content="${escapeAttr(effectiveSettings.ogImage)}" />`
    : "";
  const favicon = effectiveSettings.favicon
    ? `<link rel="icon" href="${escapeAttr(effectiveSettings.favicon)}" />`
    : "";
  const customHead = page.settings.customHead || "";
  const customCss = page.settings.customCss ? `<style>${page.settings.customCss}</style>` : "";
  const customJs = page.settings.customJs ? `<script>${page.settings.customJs}</script>` : "";
  // Inject business CSS custom properties as a top-level :root rule so any inline custom HTML
  // (or future shared component CSS) can read --g-primary / --g-fontFamily / etc.
  const brandVars = biz ? `<style>${buildBrandingCssVars(biz)}</style>` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
${description}
${ogImg}
${favicon}
<link rel="stylesheet" href="styles.css" />
${brandVars}
${customCss}
${customHead}
</head>
<body>
${body}
${customJs}
<script src="track.js" defer></script>
</body>
</html>
`;

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "index.html"), html, "utf-8");
  await fs.writeFile(path.join(outDir, "styles.css"), generateCss(effectiveSettings), "utf-8");
  await fs.writeFile(
    path.join(outDir, "track.js"),
    generateTrackJs({ gatewayUrl, siteId: page.communityId, pageId: page.id, pageSlug: page.slug }),
    "utf-8",
  );
  // Sitemap stub for SEO
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>`;
  await fs.writeFile(path.join(outDir, "sitemap.xml"), sitemap, "utf-8");
  return { outDir, html };
}
