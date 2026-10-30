/**
 * Discovery Docs — static HTML generator for Netlify Forms.
 *
 * Output:
 *   - One index.html per business (a landing page that lists each
 *     published template — one card per discovery form).
 *   - Per-template HTML file at /{slug}/index.html, containing the form
 *     with `data-netlify="true"` so Netlify Forms picks it up.
 *
 * Each form carries a hidden `form-name` field (Netlify convention) and
 * a honeypot field (`bot-field`) to filter spam. The "thank you" page
 * lives at `/{slug}/thanks` and is also auto-generated.
 *
 * Why static HTML and not a Netlify Function: keeps the public surface
 * minimal, no JS execution on Netlify, no secrets shipped to the edge.
 * The brain (AI, pipeline, actions) stays on the InfiniBot gateway and
 * polls Netlify's Submissions API for new entries.
 */

import type { DiscoveryDocTemplate } from "./types.js";

export interface BusinessSite {
  businessId: string;
  businessName: string;
  brandColor: string;
  accent: string;
  fontFamily: string;
  templates: DiscoveryDocTemplate[];
}

export interface GeneratedFile {
  /** Path relative to the site root, e.g. "index.html" or "discovery-audit/index.html". */
  path: string;
  contents: string;
}

export function generateBusinessSite(site: BusinessSite): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  out.push({ path: "index.html", contents: renderIndex(site) });
  out.push({ path: "_redirects", contents: redirectsFile(site) });
  out.push({ path: "robots.txt", contents: "User-agent: *\nAllow: /\n" });
  for (const tpl of site.templates) {
    out.push({
      path: `${slugFolder(tpl)}/index.html`,
      contents: renderTemplatePage(site, tpl),
    });
    out.push({
      path: `${slugFolder(tpl)}/thanks.html`,
      contents: renderThanksPage(site, tpl),
    });
  }
  return out;
}

function slugFolder(tpl: DiscoveryDocTemplate): string {
  return tpl.slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || tpl.id;
}

function redirectsFile(site: BusinessSite): string {
  // Map each template's slug to its index.html so the URL is clean
  // (`/{slug}` instead of `/{slug}/`). Netlify-style.
  return site.templates
    .map((t) => `/${slugFolder(t)}  /${slugFolder(t)}/index.html  200`)
    .join("\n");
}

function commonHead(site: BusinessSite, title: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} · ${escapeHtml(site.businessName)}</title>
  <style>
    :root {
      --brand: ${cssColor(site.brandColor)};
      --accent: ${cssColor(site.accent)};
      --fg: #0f172a;
      --fg-dim: #475569;
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --radius: 12px;
      --font: ${cssFont(site.fontFamily)};
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font);
      color: var(--fg);
      background: linear-gradient(180deg, color-mix(in srgb, var(--brand) 6%, var(--bg)) 0%, var(--bg) 320px);
      min-height: 100vh;
      line-height: 1.55;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
    header.site { display:flex; align-items:center; gap:12px; margin-bottom:32px; }
    .site-dot { width: 28px; height: 28px; border-radius: 8px; background: var(--brand); }
    .site-name { font-weight: 700; font-size: 18px; color: var(--fg); }
    h1 { font-size: 32px; line-height: 1.15; margin: 0 0 12px; letter-spacing: -0.02em; }
    p.lede { color: var(--fg-dim); font-size: 16px; margin: 0 0 32px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 28px;
      box-shadow: 0 8px 32px -16px rgba(15,23,42,0.08);
    }
    .field { margin-bottom: 18px; }
    .field label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; color: var(--fg); }
    .field .hint { font-size: 12px; color: var(--fg-dim); margin: 4px 0 0; }
    .field .req { color: var(--brand); }
    .field input, .field textarea, .field select {
      width: 100%;
      padding: 11px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: inherit;
      font-size: 15px;
      color: var(--fg);
      background: #fff;
      transition: border-color .15s, box-shadow .15s;
    }
    .field input:focus, .field textarea:focus, .field select:focus {
      outline: none;
      border-color: var(--brand);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 18%, transparent);
    }
    .field textarea { min-height: 110px; resize: vertical; }
    .check-row { display: flex; align-items: flex-start; gap: 10px; }
    .check-row input { width: auto; margin-top: 3px; }
    button.submit {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 22px;
      background: var(--brand);
      color: #fff;
      border: none;
      border-radius: 999px;
      font-family: inherit;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: transform .1s, box-shadow .15s;
      box-shadow: 0 6px 24px -10px color-mix(in srgb, var(--brand) 60%, transparent);
    }
    button.submit:hover { transform: translateY(-1px); }
    .honeypot { position: absolute; left: -9999px; }
    .footer { color: var(--fg-dim); font-size: 12px; text-align: center; margin-top: 24px; }
    .template-list { display: grid; gap: 14px; }
    .template-link {
      display: block;
      padding: 18px 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      text-decoration: none;
      color: var(--fg);
      transition: transform .12s, box-shadow .15s, border-color .15s;
    }
    .template-link:hover {
      transform: translateY(-1px);
      border-color: var(--brand);
      box-shadow: 0 8px 20px -10px color-mix(in srgb, var(--brand) 30%, transparent);
    }
    .template-link h3 { margin: 0 0 4px; font-size: 17px; }
    .template-link p { margin: 0; color: var(--fg-dim); font-size: 14px; }
    @media (max-width: 540px) {
      .container { padding: 32px 16px; }
      h1 { font-size: 26px; }
      .card { padding: 22px 18px; }
    }
  </style>
</head>`;
}

function renderIndex(site: BusinessSite): string {
  const cards = site.templates.length
    ? site.templates
        .map(
          (t) => `
        <a class="template-link" href="/${slugFolder(t)}">
          <h3>${escapeHtml(t.name)}</h3>
          <p>${escapeHtml(t.description || "Open this form to get started.")}</p>
        </a>`,
        )
        .join("")
    : `<p class="lede">No forms published yet.</p>`;

  return `${commonHead(site, "Get started")}
<body>
  <div class="container">
    <header class="site">
      <div class="site-dot"></div>
      <div class="site-name">${escapeHtml(site.businessName)}</div>
    </header>
    <h1>Let's start a conversation.</h1>
    <p class="lede">Pick a form below — we'll get back to you within 24 hours.</p>
    <div class="template-list">${cards}</div>
    <div class="footer">Powered by InfiniBot · Discovery Docs</div>
  </div>
</body>
</html>`;
}

function renderTemplatePage(site: BusinessSite, tpl: DiscoveryDocTemplate): string {
  const fields = tpl.inputFields.map(renderField).join("\n");
  const formName = tpl.netlify?.formName || `discovery-${tpl.slug}`;
  // Netlify Forms requires:
  //   1. `data-netlify="true"` (or `netlify` attribute) on the <form>
  //   2. A hidden `form-name` field with the form's name (for SPA-style
  //      submissions; harmless for static)
  //   3. A honeypot field named `bot-field` (Netlify's built-in spam filter)
  return `${commonHead(site, tpl.name)}
<body>
  <div class="container">
    <header class="site">
      <div class="site-dot"></div>
      <div class="site-name">${escapeHtml(site.businessName)}</div>
    </header>
    <h1>${escapeHtml(tpl.name)}</h1>
    ${tpl.description ? `<p class="lede">${escapeHtml(tpl.description)}</p>` : ""}
    <div class="card">
      <form
        name="${escapeHtml(formName)}"
        method="POST"
        data-netlify="true"
        data-netlify-honeypot="bot-field"
        action="/${slugFolder(tpl)}/thanks"
      >
        <input type="hidden" name="form-name" value="${escapeHtml(formName)}">
        <p class="honeypot">
          <label>Don't fill this out: <input name="bot-field"></label>
        </p>
${fields}
        <button class="submit" type="submit">Submit →</button>
      </form>
    </div>
    <div class="footer">Powered by InfiniBot · Discovery Docs</div>
  </div>
</body>
</html>`;
}

function renderThanksPage(site: BusinessSite, tpl: DiscoveryDocTemplate): string {
  return `${commonHead(site, "Thanks")}
<body>
  <div class="container">
    <header class="site">
      <div class="site-dot"></div>
      <div class="site-name">${escapeHtml(site.businessName)}</div>
    </header>
    <h1>Thanks — we've got it.</h1>
    <p class="lede">We'll review your submission for "${escapeHtml(tpl.name)}" and get back to you shortly. Check your email for the next steps.</p>
    <div class="card">
      <p style="margin:0;color:var(--fg-dim);font-size:14px;">If you don't hear from us within 24 hours, reply to this thread and we'll dig in.</p>
    </div>
    <div class="footer">Powered by InfiniBot · Discovery Docs</div>
  </div>
</body>
</html>`;
}

function renderField(f: DiscoveryDocTemplate["inputFields"][number]): string {
  const required = f.required ? " required" : "";
  const reqMark = f.required ? ' <span class="req">*</span>' : "";
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : "";
  const hint = f.helpText ? `<div class="hint">${escapeHtml(f.helpText)}</div>` : "";
  const label = escapeHtml(f.label);
  const name = escapeHtml(f.name);

  switch (f.type) {
    case "textarea":
      return `
        <div class="field">
          <label for="f-${name}">${label}${reqMark}</label>
          <textarea id="f-${name}" name="${name}"${placeholder}${required}></textarea>
          ${hint}
        </div>`;
    case "select": {
      const opts = (f.options ?? [])
        .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
        .join("");
      return `
        <div class="field">
          <label for="f-${name}">${label}${reqMark}</label>
          <select id="f-${name}" name="${name}"${required}>
            <option value="">— pick one —</option>
            ${opts}
          </select>
          ${hint}
        </div>`;
    }
    case "radio": {
      const opts = (f.options ?? [])
        .map(
          (o, i) => `
        <div class="check-row">
          <input type="radio" id="f-${name}-${i}" name="${name}" value="${escapeHtml(o)}"${i === 0 ? required : ""}>
          <label for="f-${name}-${i}" style="font-weight:normal;">${escapeHtml(o)}</label>
        </div>`,
        )
        .join("");
      return `
        <div class="field">
          <label>${label}${reqMark}</label>
          ${opts}
          ${hint}
        </div>`;
    }
    case "checkbox":
      return `
        <div class="field check-row">
          <input type="checkbox" id="f-${name}" name="${name}" value="yes"${required}>
          <label for="f-${name}" style="font-weight:normal;">${label}${reqMark}</label>
        </div>`;
    default: {
      const inputType =
        f.type === "email"
          ? "email"
          : f.type === "tel"
            ? "tel"
            : f.type === "url"
              ? "url"
              : f.type === "number"
                ? "number"
                : f.type === "date"
                  ? "date"
                  : "text";
      return `
        <div class="field">
          <label for="f-${name}">${label}${reqMark}</label>
          <input id="f-${name}" name="${name}" type="${inputType}"${placeholder}${required}>
          ${hint}
        </div>`;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cssColor(c: string): string {
  if (!c) return "#6366f1";
  // Bare hex / rgb / named colors flow through unchanged. Strip anything weird.
  return c.replace(/[^a-zA-Z0-9#(),.\s%-]/g, "") || "#6366f1";
}

function cssFont(f: string): string {
  if (!f) return "Inter, system-ui, sans-serif";
  return f.replace(/[<>"']/g, "");
}
