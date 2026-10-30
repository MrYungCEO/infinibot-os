/**
 * Public funnel-page renderer.
 *
 * Compiles a `PageConfig` into a self-contained HTML document the
 * gateway serves at `/p/funnels/<slug>`. No JS framework — just enough
 * client JS to POST the form back to `/api/funnels/<slug>/submit` and
 * either redirect or swap in the inline thank-you. Theme tokens read
 * from the config so each funnel renders with its own brand.
 *
 * Submission HTML form posts go to the same gateway, get processed by
 * the public HTTP layer, drop a row into the funnel's submissions log,
 * and create a lead in the entry stage of the funnel.
 */

import type { PageConfig } from "./workspace.js";

// ── Public API ───────────────────────────────────────────────

export function renderPageHtml(cfg: PageConfig, funnelId: string): string {
  const submitUrl = `/api/funnels/${encodeURIComponent(cfg.slug)}/submit`;
  const fields = ensureEmailField(cfg.fields);
  const honeypot = cfg.honeypotField ?? "company_url";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(cfg.title)}</title>
<meta property="og:title" content="${esc(cfg.title)}" />
<meta name="description" content="${esc(cfg.subheadline)}" />
<style>${baseCss(cfg)}</style>
</head>
<body>
  <main class="wrap">
    <article class="card">
      ${cfg.theme.logoAsset ? `<img class="logo" src="${assetUrl(funnelId, cfg.theme.logoAsset)}" alt="logo" />` : ""}
      <h1>${esc(cfg.headline)}</h1>
      ${cfg.subheadline ? `<p class="lede">${esc(cfg.subheadline)}</p>` : ""}
      ${cfg.bullets.length ? `<ul class="bullets">${cfg.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}

      <form id="form" novalidate>
        ${fields.map((f) => renderField(f)).join("\n        ")}
        <input type="text" name="${esc(honeypot)}" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true" />
        <button type="submit" id="submit">${esc(cfg.cta)}</button>
        <p id="err" class="err" hidden></p>
      </form>

      <div id="thanks" class="thanks" hidden>
        <h2>${esc(cfg.thankYouHeadline)}</h2>
        <p>${esc(cfg.thankYouBody)}</p>
      </div>
    </article>
    <footer><span>powered by InfiniBot</span></footer>
  </main>

  <script>${clientJs(cfg, submitUrl)}</script>
</body>
</html>`;
}

// ── Field rendering ──────────────────────────────────────────

function renderField(f: NonNullable<PageConfig["fields"]>[number]): string {
  const id = `f_${f.id}`;
  const required = f.required ? "required" : "";
  const placeholder = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "";
  switch (f.kind) {
    case "textarea":
      return `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>
        <textarea id="${id}" name="${esc(f.id)}" rows="4" ${required} ${placeholder}></textarea>`;
    case "select":
      return `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>
        <select id="${id}" name="${esc(f.id)}" ${required}>
          ${(f.options ?? []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}
        </select>`;
    case "checkbox":
      return `<label class="check"><input id="${id}" type="checkbox" name="${esc(f.id)}" value="1" ${required} /> ${esc(f.label)}</label>`;
    case "hidden":
      return `<input type="hidden" name="${esc(f.id)}" value="${esc(f.defaultValue ?? "")}" />`;
    default:
      return `<label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>
        <input id="${id}" name="${esc(f.id)}" type="${f.kind}" ${required} ${placeholder} />`;
  }
}

function ensureEmailField(fields: PageConfig["fields"]): PageConfig["fields"] {
  if (fields.some((f) => f.id === "email")) return fields;
  return [
    ...fields,
    { id: "email", label: "Email", kind: "email", required: true, placeholder: "you@company.com" },
  ];
}

function assetUrl(funnelId: string, asset: string): string {
  return `/api/funnels/${encodeURIComponent(funnelId)}/asset/${encodeURIComponent(asset)}`;
}

// ── Inline JS — POST + redirect/swap-in thank-you ────────────

function clientJs(cfg: PageConfig, submitUrl: string): string {
  // Single-purpose script: collect form fields, POST as JSON, handle
  // success (redirect or swap-in) and error (show message). No
  // dependencies, no framework — runs anywhere a browser does.
  return `(function(){
  const form=document.getElementById('form');
  const submit=document.getElementById('submit');
  const err=document.getElementById('err');
  const thanks=document.getElementById('thanks');
  form.addEventListener('submit',async function(e){
    e.preventDefault();
    err.hidden=true;
    submit.disabled=true;submit.textContent='Sending…';
    const data={};
    for(const el of form.elements){
      if(!el.name)continue;
      if(el.type==='checkbox')data[el.name]=el.checked;else data[el.name]=el.value;
    }
    try{
      const r=await fetch(${JSON.stringify(submitUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      if(!r.ok){throw new Error('Submission failed ('+r.status+')');}
      ${cfg.thankYouUrl ? `window.location.href=${JSON.stringify(cfg.thankYouUrl)};` : `form.hidden=true;thanks.hidden=false;`}
    }catch(ex){
      err.hidden=false;err.textContent=(ex&&ex.message)||'Could not submit';
      submit.disabled=false;submit.textContent=${JSON.stringify(cfg.cta)};
    }
  });
})();`;
}

// ── CSS ──────────────────────────────────────────────────────

function baseCss(cfg: PageConfig): string {
  const t = cfg.theme;
  return `
:root{--fg:${t.textColor};--bg:${t.bgColor};--p:${t.primaryColor};--font:${t.fontStack};}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--font);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{width:min(560px,100%);display:flex;flex-direction:column;gap:18px}
.card{padding:36px;border-radius:14px;background:color-mix(in srgb,var(--fg) 4%, transparent);border:1px solid color-mix(in srgb,var(--fg) 10%, transparent)}
.logo{max-height:56px;margin-bottom:12px}
h1{margin:0 0 8px;font-size:32px;font-weight:700;line-height:1.15}
.lede{margin:0 0 18px;color:color-mix(in srgb,var(--fg) 65%, transparent);font-size:15px;line-height:1.5}
.bullets{margin:0 0 18px;padding-left:20px}
.bullets li{margin-bottom:6px;color:color-mix(in srgb,var(--fg) 75%, transparent)}
form{display:flex;flex-direction:column;gap:10px}
label{font-size:12.5px;color:color-mix(in srgb,var(--fg) 70%, transparent);display:flex;flex-direction:column;gap:4px}
label.check{flex-direction:row;align-items:center;gap:8px;color:var(--fg)}
input,textarea,select{padding:10px 12px;border-radius:7px;border:1px solid color-mix(in srgb,var(--fg) 18%, transparent);background:color-mix(in srgb,var(--bg) 60%, transparent);color:var(--fg);font:inherit;font-size:14px}
input:focus,textarea:focus,select:focus{outline:2px solid var(--p);outline-offset:1px}
.hp{position:absolute;left:-10000px;width:1px;height:1px;opacity:0}
button{margin-top:6px;padding:12px 20px;border:none;border-radius:8px;background:var(--p);color:#000;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:0.6;cursor:progress}
.err{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,#dc2626 18%, transparent);color:#fca5a5;font-size:13px}
.thanks{text-align:center;padding:30px 16px}
.thanks h2{margin:0 0 8px;font-size:24px}
footer{text-align:center;color:color-mix(in srgb,var(--fg) 35%, transparent);font-size:11px}
@media(max-width:480px){.card{padding:24px}h1{font-size:26px}}
`;
}

// ── Escape ───────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
