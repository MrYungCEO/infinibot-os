/**
 * Renders a `QualifierFormConfig` to a self-contained public HTML
 * document served at `/f/<slug>`. No JS framework — vanilla client JS
 * handles multi-step navigation, client-side qualifying score
 * computation, and the submit POST that feeds the qualifier pipeline.
 *
 * Layouts are parameterised on `cfg.layout`:
 *   single-column   stacked card
 *   two-column      grid (collapses on mobile)
 *   multi-step      wizard with Next / Back and a progress bar
 *   long-form       hero + bullets + testimonials + video + form
 *   card-grid       (reserved — falls back to single-column for now)
 */

import type { FormField, QualifierFormConfig } from "./forms.js";

export function renderFormHtml(
  cfg: QualifierFormConfig,
  opts: { apiBaseUrl?: string } = {},
): string {
  // When `apiBaseUrl` is set (e.g. for a Netlify-deployed copy), the
  // submit + track endpoints become absolute and CORS-cross-origin to
  // the gateway. Without it, paths stay relative so the locally-served
  // copy works against the gateway's own HTTP listener.
  const base = (opts.apiBaseUrl ?? "").replace(/\/+$/, "");
  const submitUrl = `${base}/api/forms/lq/${encodeURIComponent(cfg.slug)}/submit`;
  const trackUrl = `${base}/api/forms/lq/${encodeURIComponent(cfg.slug)}/track`;
  const fields = ensureEmailField(cfg.fields);
  const honeypot = cfg.honeypotField || "company_url";
  const totalSteps = computeTotalSteps(fields);
  const fieldsJson = JSON.stringify(
    fields.map((f) => ({
      name: f.name,
      kind: f.kind,
      step: f.step ?? 1,
      required: !!f.required,
      options: f.options ?? [],
    })),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(cfg.content.title || cfg.name)}</title>
<meta property="og:title" content="${esc(cfg.content.title || cfg.name)}" />
<meta name="description" content="${esc(cfg.content.subheadline)}" />
${fontLinks(cfg)}
<style>${baseCss(cfg)}</style>
${cfg.style.customCss ? `<style>${cfg.style.customCss}</style>` : ""}
</head>
<body class="layout-${cfg.layout}">
  ${cfg.style.bgImageUrl ? `<div class="bg-image" style="background-image:url('${esc(cfg.style.bgImageUrl)}')"></div>` : ""}
  <main class="wrap">
    ${
      cfg.layout === "step-by-step"
        ? renderStepByStepBody(cfg, totalSteps, honeypot)
        : `${renderHero(cfg)}
         ${renderTestimonials(cfg)}
         <article class="card form-card">
           ${cfg.layout === "multi-step" ? renderStepProgress(totalSteps) : ""}
           <form id="form" novalidate data-total-steps="${totalSteps}">
             ${renderFields(fields, cfg.layout)}
             <input type="text" name="${esc(honeypot)}" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true" />
             ${
               cfg.layout === "multi-step"
                 ? `<div class="nav">
                     <button type="button" class="btn-secondary" id="prev" hidden>← Back</button>
                     <button type="button" class="btn-primary" id="next">Next →</button>
                     <button type="submit" class="btn-primary" id="submit" hidden>${esc(cfg.content.cta)}</button>
                   </div>`
                 : `<button type="submit" class="btn-primary" id="submit">${esc(cfg.content.cta)}</button>`
             }
             <p id="err" class="err" hidden></p>
           </form>
         </article>`
    }
    <div id="thanks" class="thanks" hidden>
      <h2>${esc(cfg.content.thankYouHeadline)}</h2>
      <p>${esc(cfg.content.thankYouBody)}</p>
      ${cfg.content.calendlyUrl ? `<iframe class="calendly" src="${esc(cfg.content.calendlyUrl)}" frameborder="0"></iframe>` : ""}
    </div>
    <footer><span>powered by InfiniBot</span></footer>
  </main>
  <script>${clientJs(submitUrl, trackUrl, fieldsJson, cfg)}</script>
</body>
</html>`;
}

/**
 * Step-by-step body: one full-screen "page" per step, each with its own
 * logo + headline + a single fieldset. The client JS treats this like
 * the existing multi-step flow (showStep, validateStep, Next/Back) —
 * the only difference is each step gets its own hero rendered inline.
 */
function renderStepByStepBody(
  cfg: QualifierFormConfig,
  totalSteps: number,
  honeypot: string,
): string {
  const fields = cfg.fields.filter((f) => f.kind !== "hidden");
  const hidden = cfg.fields.filter((f) => f.kind === "hidden");
  const groups = groupByStep(fields);
  // Synthesize at least one step even when no field is grouped.
  const steps = groups.length > 0 ? groups : [fields];
  const perStep = cfg.content.stepContent ?? [];
  return `
    <article class="card form-card sbs-shell">
      ${renderStepDots(totalSteps)}
      <form id="form" novalidate data-total-steps="${totalSteps}">
        ${steps
          .map((group, idx) => {
            const sc = perStep[idx] ?? {};
            const eyebrow = sc.eyebrow ?? (idx === 0 ? cfg.content.eyebrow : "");
            const headline = sc.headline ?? (idx === 0 ? cfg.content.headline : "");
            const sub = sc.subheadline ?? (idx === 0 ? cfg.content.subheadline : "");
            return `<fieldset class="step sbs-page" data-step="${idx + 1}" ${idx === 0 ? "" : "hidden"}>
              <div class="sbs-page-inner">
                ${renderLogoBlock(cfg)}
                ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}
                ${headline ? `<h1 class="sbs-headline">${esc(headline)}</h1>` : ""}
                ${sub ? `<p class="sbs-sub lede">${esc(sub)}</p>` : ""}
                <div class="sbs-fields">
                  ${group.map((f) => renderField(f, "step-by-step")).join("\n")}
                </div>
                <div class="sbs-step-meta">Step ${idx + 1} of ${totalSteps}</div>
              </div>
            </fieldset>`;
          })
          .join("\n")}
        ${hidden.map((f) => renderField(f, "step-by-step")).join("\n")}
        <input type="text" name="${esc(honeypot)}" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true" />
        <div class="nav sbs-nav">
          <button type="button" class="btn-secondary" id="prev" hidden>← Back</button>
          <button type="button" class="btn-primary" id="next">Next →</button>
          <button type="submit" class="btn-primary" id="submit" hidden>${esc(cfg.content.cta)}</button>
        </div>
        <p id="err" class="err" hidden></p>
      </form>
    </article>
  `;
}

/** Logo block respecting style.logoPosition + style.logoMaxWidth. */
function renderLogoBlock(cfg: QualifierFormConfig): string {
  const url = cfg.style.logoUrl;
  if (!url) return "";
  const pos = cfg.style.logoPosition ?? "center-top";
  if (pos === "hidden") return "";
  const maxW = typeof cfg.style.logoMaxWidth === "number" ? cfg.style.logoMaxWidth : 140;
  const style = `max-width:${Math.max(40, Math.min(400, maxW))}px;`;
  return `<div class="logo-block logo-${esc(pos)}"><img class="logo" src="${esc(url)}" alt="logo" style="${style}" /></div>`;
}

/** Step dots — a row of small circles indicating the active step. Pure CSS animated. */
function renderStepDots(total: number): string {
  return `<div class="sbs-dots" data-total="${total}">${Array.from(
    { length: total },
    (_, i) => `<span class="sbs-dot" data-step="${i + 1}"></span>`,
  ).join("")}</div>`;
}

// ── Hero / testimonials ───────────────────────────────────────

function renderHero(cfg: QualifierFormConfig): string {
  if (cfg.layout === "long-form") {
    return `<section class="hero hero-long">
      ${renderLogoBlock(cfg)}
      ${cfg.content.eyebrow ? `<div class="eyebrow">${esc(cfg.content.eyebrow)}</div>` : ""}
      <h1>${esc(cfg.content.headline)}</h1>
      ${cfg.content.subheadline ? `<p class="lede">${esc(cfg.content.subheadline)}</p>` : ""}
      ${cfg.content.videoUrl ? renderVideo(cfg.content.videoUrl) : ""}
      ${cfg.content.bullets.length ? `<ul class="bullets">${cfg.content.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    </section>`;
  }
  return `<section class="hero">
    ${renderLogoBlock(cfg)}
    ${cfg.content.eyebrow ? `<div class="eyebrow">${esc(cfg.content.eyebrow)}</div>` : ""}
    <h1>${esc(cfg.content.headline)}</h1>
    ${cfg.content.subheadline ? `<p class="lede">${esc(cfg.content.subheadline)}</p>` : ""}
    ${cfg.content.bullets.length ? `<ul class="bullets">${cfg.content.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function renderTestimonials(cfg: QualifierFormConfig): string {
  if (!cfg.content.testimonials.length) return "";
  return `<section class="testimonials">
    ${cfg.content.testimonials
      .map(
        (t) =>
          `<blockquote><p>${esc(t.quote)}</p><cite>${esc(t.author)}${t.role ? ` — ${esc(t.role)}` : ""}</cite></blockquote>`,
      )
      .join("")}
  </section>`;
}

function renderVideo(url: string): string {
  // Naive YT/Vimeo embed detection — fall back to a plain <video> tag.
  const yt = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/);
  if (yt) {
    return `<div class="video"><iframe src="https://www.youtube.com/embed/${esc(yt[1])}" frameborder="0" allowfullscreen></iframe></div>`;
  }
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) {
    return `<div class="video"><iframe src="https://player.vimeo.com/video/${esc(vimeo[1])}" frameborder="0" allowfullscreen></iframe></div>`;
  }
  return `<div class="video"><video controls src="${esc(url)}"></video></div>`;
}

// ── Fields ────────────────────────────────────────────────────

function renderFields(fields: FormField[], layout: QualifierFormConfig["layout"]): string {
  if (layout === "multi-step") {
    const steps = groupByStep(fields);
    return steps
      .map(
        (step, idx) =>
          `<fieldset class="step" data-step="${idx + 1}" ${idx === 0 ? "" : "hidden"}>
            ${step.map((f) => renderField(f, layout)).join("\n")}
          </fieldset>`,
      )
      .join("\n");
  }
  return `<div class="fields ${layout === "two-column" ? "fields-grid" : ""}">
    ${fields.map((f) => renderField(f, layout)).join("\n")}
  </div>`;
}

function renderField(f: FormField, layout: QualifierFormConfig["layout"]): string {
  const id = `f_${f.name}`;
  const required = f.required ? "required" : "";
  const placeholder = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "";
  const help = f.helpText ? `<small class="help">${esc(f.helpText)}</small>` : "";
  const span =
    layout === "two-column"
      ? ` style="grid-column: span ${Math.max(1, Math.min(12, f.span ?? 6))}"`
      : "";
  const wrap = (inner: string) =>
    `<label class="field" for="${id}"${span}>
      <span class="field-label">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</span>
      ${inner}
      ${help}
    </label>`;

  switch (f.kind) {
    case "textarea":
      return wrap(
        `<textarea id="${id}" name="${esc(f.name)}" rows="4" ${required} ${placeholder}></textarea>`,
      );
    case "select":
      return wrap(
        `<select id="${id}" name="${esc(f.name)}" ${required}>
          <option value="" disabled selected>— select —</option>
          ${(f.options ?? [])
            .map(
              (o) =>
                `<option value="${esc(o.value)}" data-score="${o.score ?? 0}">${esc(o.label)}</option>`,
            )
            .join("")}
        </select>`,
      );
    case "radio":
      return `<fieldset class="field radio-group"${span}>
        <legend class="field-label">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</legend>
        ${(f.options ?? [])
          .map(
            (o, i) =>
              `<label class="radio"><input type="radio" name="${esc(f.name)}" value="${esc(o.value)}" data-score="${o.score ?? 0}" ${required && i === 0 ? "required" : ""} /> ${esc(o.label)}</label>`,
          )
          .join("")}
        ${help}
      </fieldset>`;
    case "checkbox-group":
      return `<fieldset class="field checkbox-group"${span}>
        <legend class="field-label">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</legend>
        ${(f.options ?? [])
          .map(
            (o) =>
              `<label class="check"><input type="checkbox" name="${esc(f.name)}[]" value="${esc(o.value)}" data-score="${o.score ?? 0}" /> ${esc(o.label)}</label>`,
          )
          .join("")}
        ${help}
      </fieldset>`;
    case "checkbox":
    case "consent":
      return `<label class="check"${span}>
        <input id="${id}" type="checkbox" name="${esc(f.name)}" value="1" ${required} />
        <span>${esc(f.label)}</span>
        ${help}
      </label>`;
    case "rating":
      return wrap(
        `<div class="rating" data-name="${esc(f.name)}" data-min="${f.min ?? 1}" data-max="${f.max ?? 5}">
          ${Array.from({ length: (f.max ?? 5) - (f.min ?? 1) + 1 }, (_, i) => i + (f.min ?? 1))
            .map((n) => `<button type="button" class="star" data-value="${n}">${n}</button>`)
            .join("")}
          <input type="hidden" name="${esc(f.name)}" ${required} />
        </div>`,
      );
    case "hidden":
      return `<input type="hidden" name="${esc(f.name)}" value="${esc(f.defaultValue ?? "")}" />`;
    case "number":
      return wrap(
        `<input id="${id}" name="${esc(f.name)}" type="number" ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} ${required} ${placeholder} />`,
      );
    case "date":
      return wrap(`<input id="${id}" name="${esc(f.name)}" type="date" ${required} />`);
    case "url":
      return wrap(
        `<input id="${id}" name="${esc(f.name)}" type="url" ${required} ${placeholder} ${f.pattern ? `pattern="${esc(f.pattern)}"` : ""} />`,
      );
    default:
      return wrap(
        `<input id="${id}" name="${esc(f.name)}" type="${f.kind}" ${required} ${placeholder} ${f.pattern ? `pattern="${esc(f.pattern)}"` : ""} />`,
      );
  }
}

function renderStepProgress(total: number): string {
  return `<div class="progress">
    ${Array.from({ length: total }, (_, i) => `<span class="dot" data-step="${i + 1}" ${i === 0 ? 'class="dot active"' : ""}></span>`).join("")}
  </div>`;
}

// ── Client JS ─────────────────────────────────────────────────

function clientJs(
  submitUrl: string,
  trackUrl: string,
  fieldsJson: string,
  cfg: QualifierFormConfig,
): string {
  // ESLint-free: this is rendered straight to the wire.
  return `(function(){
  const FIELDS=${fieldsJson};
  const SUBMIT=${JSON.stringify(submitUrl)};
  const TRACK=${JSON.stringify(trackUrl)};
  const THRESHOLD=${cfg.qualifier.scoreThreshold};
  const REDIRECT=${JSON.stringify(cfg.content.thankYouUrl || "")};
  const FORMID=${JSON.stringify(cfg.id)};

  // Anonymous viewer id stored in sessionStorage so events stitch within a page visit.
  let vid=null;
  try{vid=sessionStorage.getItem('infinibot-vid')||null;}catch(e){}
  if(!vid){vid=Math.random().toString(36).slice(2)+Date.now().toString(36);try{sessionStorage.setItem('infinibot-vid',vid);}catch(e){}}

  const utm={};
  try{
    const sp=new URLSearchParams(location.search);
    sp.forEach(function(v,k){if(k.indexOf('utm_')===0)utm[k]=v;});
  }catch(e){}

  function track(kind,extra){
    const ev={ts:Date.now(),vid:vid,kind:kind,ref:document.referrer||'',utm:utm};
    if(extra)Object.assign(ev,extra);
    try{
      navigator.sendBeacon&&navigator.sendBeacon(TRACK,new Blob([JSON.stringify(ev)],{type:'application/json'}))
        ||fetch(TRACK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ev),keepalive:true}).catch(function(){});
    }catch(e){}
  }
  track('view');

  const form=document.getElementById('form');
  const submit=document.getElementById('submit');
  const err=document.getElementById('err');
  const thanks=document.getElementById('thanks');
  const formCard=form.closest('.form-card');

  // Rating widgets — turn the buttons into a hidden-input writer.
  document.querySelectorAll('.rating').forEach(function(r){
    const hidden=r.querySelector('input[type=hidden]');
    r.querySelectorAll('.star').forEach(function(btn){
      btn.addEventListener('click',function(){
        const v=btn.getAttribute('data-value');
        hidden.value=v;
        r.querySelectorAll('.star').forEach(function(b){b.classList.toggle('active',Number(b.getAttribute('data-value'))<=Number(v));});
      });
    });
  });

  let started=false;
  form.addEventListener('focusin',function(e){
    if(!started){started=true;track('start');}
    if(e.target&&e.target.name)track('field-focus',{field:e.target.name});
  });
  form.addEventListener('change',function(e){
    if(e.target&&e.target.name)track('field-complete',{field:e.target.name});
  });

  // Multi-step nav
  const totalSteps=Number(form.getAttribute('data-total-steps')||'1');
  let currentStep=1;
  const prevBtn=document.getElementById('prev');
  const nextBtn=document.getElementById('next');
  function showStep(n){
    currentStep=n;
    form.querySelectorAll('.step').forEach(function(fs){
      fs.hidden=Number(fs.getAttribute('data-step'))!==n;
    });
    document.querySelectorAll('.progress .dot').forEach(function(d){
      d.classList.toggle('active',Number(d.getAttribute('data-step'))<=n);
    });
    // step-by-step layout uses .sbs-dot for the same indicator role.
    document.querySelectorAll('.sbs-dot').forEach(function(d){
      const sn=Number(d.getAttribute('data-step'));
      d.classList.toggle('active',sn===n);
      d.classList.toggle('done',sn<n);
    });
    // Scroll the active page into the top of the viewport on small screens.
    const active=form.querySelector('.step[data-step="'+n+'"]');
    if(active&&active.scrollIntoView)active.scrollIntoView({behavior:'smooth',block:'start'});
    if(prevBtn)prevBtn.hidden=n===1;
    if(nextBtn)nextBtn.hidden=n>=totalSteps;
    if(submit)submit.hidden=n<totalSteps;
  }
  function validateStep(n){
    const step=form.querySelector('.step[data-step="'+n+'"]');
    if(!step)return true;
    const required=step.querySelectorAll('[required]');
    for(let i=0;i<required.length;i++){
      const el=required[i];
      if(el.type==='checkbox'&&!el.checked){el.focus();return false;}
      if(el.value==null||el.value===''){el.focus();return false;}
    }
    return true;
  }
  if(nextBtn)nextBtn.addEventListener('click',function(){
    if(!validateStep(currentStep)){err.hidden=false;err.textContent='Please complete the highlighted fields.';return;}
    err.hidden=true;
    track('step-advance',{step:currentStep});
    showStep(currentStep+1);
  });
  if(prevBtn)prevBtn.addEventListener('click',function(){showStep(currentStep-1);});

  function collectData(){
    const data={};
    let score=0;
    // Walk inputs in DOM order so multi-value (checkbox-group) arrays preserve.
    for(const el of form.elements){
      if(!el.name)continue;
      if(el.type==='checkbox'){
        if(el.name.endsWith('[]')){
          const key=el.name.slice(0,-2);
          if(!data[key])data[key]=[];
          if(el.checked){data[key].push(el.value);score+=Number(el.getAttribute('data-score')||0);}
        }else{
          data[el.name]=el.checked;
        }
      }else if(el.type==='radio'){
        if(el.checked){data[el.name]=el.value;score+=Number(el.getAttribute('data-score')||0);}
      }else if(el.tagName==='SELECT'){
        data[el.name]=el.value;
        const opt=el.options[el.selectedIndex];
        if(opt)score+=Number(opt.getAttribute('data-score')||0);
      }else{
        data[el.name]=el.value;
      }
    }
    return {data:data,score:score};
  }

  form.addEventListener('submit',async function(e){
    e.preventDefault();
    err.hidden=true;
    submit.disabled=true;submit.textContent='Sending…';
    const collected=collectData();
    track('submit-attempt');
    try{
      const r=await fetch(SUBMIT,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({formId:FORMID,vid:vid,utm:utm,score:collected.score,data:collected.data})
      });
      if(!r.ok){throw new Error('Submission failed ('+r.status+')');}
      const out=await r.json().catch(function(){return{};});
      track('submit-success',{leadId:out.leadId,qualified:!!out.qualified});
      if(REDIRECT){window.location.href=REDIRECT;return;}
      if(formCard)formCard.hidden=true;thanks.hidden=false;
    }catch(ex){
      track('submit-error');
      err.hidden=false;err.textContent=(ex&&ex.message)||'Could not submit';
      submit.disabled=false;submit.textContent=${JSON.stringify(cfg.content.cta)};
    }
  });
})();`;
}

// ── CSS ───────────────────────────────────────────────────────

const GFONT_SPECS: Record<string, string> = {
  "Playfair Display": "Playfair+Display:ital,wght@0,400;0,700;0,800;1,400",
  Merriweather: "Merriweather:wght@400;700;900",
  "Cormorant Garamond": "Cormorant+Garamond:ital,wght@0,400;0,600;1,400",
  "Plus Jakarta Sans": "Plus+Jakarta+Sans:wght@400;600;800",
  "DM Sans": "DM+Sans:wght@400;500;700",
  Raleway: "Raleway:wght@400;600;800",
};

function fontLinks(cfg: QualifierFormConfig): string {
  const fonts = [cfg.style.fontStack, cfg.style.headingFontStack ?? ""].join(",");
  const links: string[] = [];
  for (const [name, spec] of Object.entries(GFONT_SPECS)) {
    if (fonts.includes(name)) {
      links.push(
        `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${spec}&display=swap" />`,
      );
    }
  }
  return links.filter((l, i, a) => a.indexOf(l) === i).join("\n");
}

function baseCss(cfg: QualifierFormConfig): string {
  const s = cfg.style;
  const headingFont = s.headingFontStack ?? s.fontStack;
  const density = s.density ?? "comfortable";
  const buttonStyle = s.buttonStyle ?? "gradient";
  const surfaceStyle = s.surfaceStyle ?? "raised";
  const shadowLevel = Math.min(3, Math.max(0, s.shadowLevel ?? 1)) as 0 | 1 | 2 | 3;
  const inputStyle = s.inputStyle ?? "outline";
  const motionLevel = s.motionLevel ?? "subtle";

  // Density → padding multipliers
  const fpv = density === "compact" ? 9 : density === "spacious" ? 15 : 12;
  const fph = density === "compact" ? 11 : density === "spacious" ? 17 : 14;
  const bpv = density === "compact" ? 11 : density === "spacious" ? 18 : 14;
  const bph = density === "compact" ? 18 : density === "spacious" ? 30 : 24;
  const cpd = density === "compact" ? 22 : density === "spacious" ? 42 : 32;

  // Shadow
  const shadowMap: Record<number, string> = {
    0: "none",
    1: "0 4px 16px rgba(0,0,0,0.12)",
    2: "0 16px 50px rgba(0,0,0,0.25)",
    3: "0 32px 80px rgba(0,0,0,0.45)",
  };
  const cardShadow = shadowMap[shadowLevel] ?? shadowMap[2];

  // Motion
  const td = motionLevel === "off" ? "0s" : motionLevel === "full" ? "0.25s" : "0.15s";
  const btnTransform = motionLevel === "off" ? "" : "transform 0.1s,";

  // Button
  let btnRule: string;
  let btnHoverRule: string;
  switch (buttonStyle) {
    case "outline":
      btnRule = `background:transparent;border:1px solid var(--p);color:var(--p)`;
      btnHoverRule = `background:color-mix(in srgb,var(--p) 12%,transparent)`;
      break;
    case "glass":
      btnRule = `background:color-mix(in srgb,var(--p) 14%,transparent);border:1px solid color-mix(in srgb,var(--p) 40%,transparent);color:var(--p);backdrop-filter:blur(10px)`;
      btnHoverRule = `background:color-mix(in srgb,var(--p) 22%,transparent)`;
      break;
    case "neon":
      btnRule = `background:transparent;border:1px solid var(--p);color:var(--p);box-shadow:0 0 12px color-mix(in srgb,var(--p) 40%,transparent),inset 0 0 12px color-mix(in srgb,var(--p) 8%,transparent)`;
      btnHoverRule = `box-shadow:0 0 24px color-mix(in srgb,var(--p) 70%,transparent),inset 0 0 20px color-mix(in srgb,var(--p) 14%,transparent)`;
      break;
    case "solid":
      btnRule = `background:var(--p);border:0;color:#000`;
      btnHoverRule = `opacity:0.88`;
      break;
    default: // gradient
      btnRule = `background:linear-gradient(135deg,var(--p),color-mix(in srgb,var(--p) 65%,var(--a)));border:0;color:#0a0700;box-shadow:0 8px 24px color-mix(in srgb,var(--p) 35%,transparent)`;
      btnHoverRule = `${btnTransform}box-shadow:0 12px 32px color-mix(in srgb,var(--p) 50%,transparent)`;
  }

  // Input
  let inputRule: string;
  let inputFocusRule: string;
  switch (inputStyle) {
    case "underline":
      inputRule = `background:transparent;border:0;border-bottom:1px solid color-mix(in srgb,var(--fg) 28%,transparent);border-radius:0;padding-left:0;padding-right:0`;
      inputFocusRule = `border-bottom-color:var(--p);box-shadow:none;outline:none`;
      break;
    case "filled":
      inputRule = `background:color-mix(in srgb,var(--fg) 8%,transparent);border:1px solid transparent`;
      inputFocusRule = `outline:none;border-color:var(--p);box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 16%,transparent)`;
      break;
    case "glass":
      inputRule = `background:color-mix(in srgb,var(--fg) 4%,rgba(255,255,255,0.03));border:1px solid color-mix(in srgb,var(--fg) 11%,rgba(255,255,255,0.08));backdrop-filter:blur(8px)`;
      inputFocusRule = `outline:none;border-color:color-mix(in srgb,var(--p) 55%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 12%,transparent)`;
      break;
    default: // outline
      inputRule = `background:color-mix(in srgb,var(--bg) 70%,transparent);border:1px solid color-mix(in srgb,var(--fg) 18%,transparent)`;
      inputFocusRule = `outline:none;border-color:var(--p);box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 22%,transparent)`;
  }

  // Card surface
  let cardBgRule = "var(--card)";
  switch (surfaceStyle) {
    case "glass":
      cardBgRule = "color-mix(in srgb,var(--card) 70%,rgba(255,255,255,0.02))";
      break;
    case "gradient":
      cardBgRule = "linear-gradient(135deg,color-mix(in srgb,var(--p) 5%,var(--card)),var(--card))";
      break;
    case "noise":
      cardBgRule = "var(--card)";
      break;
  }

  return `
:root{
  --p:${s.primaryColor};
  --a:${s.accentColor};
  --bg:${s.bgColor};
  --fg:${s.textColor};
  --card:${s.cardColor ?? "transparent"};
  --font:${s.fontStack};
  --hfont:${headingFont};
  --radius:${s.radius}px;
}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{
  background:var(--bg);
  color:var(--fg);
  font-family:var(--font);
  min-height:100vh;
  display:flex;align-items:flex-start;justify-content:center;
  padding:32px 18px;
  position:relative;
}
.bg-image{position:fixed;inset:0;background-size:cover;background-position:center;opacity:0.25;pointer-events:none;z-index:-1}
.wrap{width:min(720px,100%);display:flex;flex-direction:column;gap:24px}
.layout-long-form .wrap{width:min(860px,100%)}
.hero{text-align:center;padding:8px 0}
.hero-long{padding:36px 0 24px;text-align:left}
.logo{max-height:56px;margin-bottom:16px}
.eyebrow{
  display:inline-block;
  padding:5px 12px;
  font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;
  color:var(--p);background:color-mix(in srgb,var(--p) 12%, transparent);
  border:1px solid color-mix(in srgb,var(--p) 30%, transparent);
  border-radius:99px;margin-bottom:14px;
}
h1{margin:0 0 12px;font-size:38px;font-weight:800;line-height:1.1;letter-spacing:-0.01em;font-family:var(--hfont)}
.layout-long-form h1{font-size:48px}
.lede{margin:0 0 24px;color:color-mix(in srgb,var(--fg) 70%, transparent);font-size:18px;line-height:1.55;max-width:60ch}
.bullets{display:flex;flex-direction:column;gap:6px;margin:0;padding-left:0;list-style:none}
.bullets li{padding-left:26px;position:relative;color:color-mix(in srgb,var(--fg) 85%, transparent);font-size:15px;line-height:1.5}
.bullets li::before{content:"✓";position:absolute;left:0;top:0;color:var(--p);font-weight:800}
.testimonials{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.testimonials blockquote{
  margin:0;padding:18px 20px;background:color-mix(in srgb,var(--fg) 5%, transparent);
  border-left:3px solid var(--a);border-radius:var(--radius);
}
.testimonials p{margin:0 0 8px;font-size:14px;line-height:1.55;color:color-mix(in srgb,var(--fg) 85%, transparent)}
.testimonials cite{font-size:12px;color:color-mix(in srgb,var(--fg) 60%, transparent);font-style:normal}
.video{margin:18px 0;aspect-ratio:16/9;border-radius:var(--radius);overflow:hidden;background:#000}
.video iframe,.video video{width:100%;height:100%;border:0;display:block}
.card{
  padding:${cpd}px;border-radius:calc(var(--radius) + 4px);
  background:${cardBgRule};
  border:1px solid color-mix(in srgb,var(--fg) 10%, transparent);
  box-shadow:${cardShadow};
}
form{display:flex;flex-direction:column;gap:14px}
.fields{display:flex;flex-direction:column;gap:14px}
.fields-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.step{border:0;padding:0;margin:0}
.field{display:flex;flex-direction:column;gap:6px}
.field-label{font-size:13px;font-weight:600;color:color-mix(in srgb,var(--fg) 80%, transparent)}
.req{color:var(--a)}
.help{font-size:11px;color:color-mix(in srgb,var(--fg) 50%, transparent);margin-top:2px}
input,textarea,select{
  width:100%;padding:${fpv}px ${fph}px;border-radius:var(--radius);
  ${inputRule};
  color:var(--fg);font:inherit;font-size:15px;
  transition:border-color ${td}, box-shadow ${td};
}
input:focus,textarea:focus,select:focus{
  ${inputFocusRule};
}
textarea{min-height:96px;resize:vertical}
.check{display:flex;align-items:flex-start;gap:8px;font-size:14px;color:color-mix(in srgb,var(--fg) 85%, transparent);cursor:pointer}
.check input{width:auto;margin-top:3px}
.radio-group,.checkbox-group{display:flex;flex-direction:column;gap:6px;border:0;padding:0;margin:0}
.radio{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--radius);background:color-mix(in srgb,var(--fg) 4%, transparent);cursor:pointer;font-size:14px}
.radio input{width:auto}
.rating{display:flex;gap:6px;flex-wrap:wrap}
.star{
  width:44px;height:44px;border-radius:50%;border:1px solid color-mix(in srgb,var(--fg) 22%, transparent);
  background:transparent;color:color-mix(in srgb,var(--fg) 80%, transparent);font-weight:700;cursor:pointer;
  transition:all ${td};
}
.star.active,.star:hover{background:var(--p);color:#000;border-color:var(--p)}
.btn-primary{
  padding:${bpv}px ${bph}px;border-radius:var(--radius);
  ${btnRule};
  font:inherit;font-size:16px;font-weight:700;letter-spacing:0.01em;
  cursor:pointer;
  transition:${btnTransform}box-shadow ${td},opacity ${td};
}
.btn-primary:hover{${btnHoverRule}}
.btn-primary:disabled{opacity:0.6;cursor:progress}
.btn-secondary{
  padding:${bpv}px ${bph}px;border:1px solid color-mix(in srgb,var(--fg) 22%, transparent);
  border-radius:var(--radius);background:transparent;color:var(--fg);
  font:inherit;font-size:15px;cursor:pointer;
}
.nav{display:flex;justify-content:space-between;gap:12px;margin-top:6px}
.progress{display:flex;gap:8px;margin-bottom:20px}
.progress .dot{flex:1;height:6px;border-radius:99px;background:color-mix(in srgb,var(--fg) 12%, transparent);transition:background ${td}}
.progress .dot.active{background:var(--p)}
.hp{position:absolute;left:-10000px;width:1px;height:1px;opacity:0}
.err{margin:6px 0 0;padding:10px 12px;border-radius:var(--radius);background:color-mix(in srgb,#dc2626 22%, transparent);color:#fca5a5;font-size:13px}
.thanks{padding:36px 28px;background:var(--card);border-radius:calc(var(--radius) + 4px);text-align:center;border:1px solid color-mix(in srgb,var(--fg) 10%, transparent)}
.thanks h2{margin:0 0 10px;font-size:28px}
.thanks p{margin:0;color:color-mix(in srgb,var(--fg) 70%, transparent);font-size:15px}
.calendly{width:100%;height:600px;margin-top:20px;border-radius:var(--radius)}
footer{text-align:center;color:color-mix(in srgb,var(--fg) 35%, transparent);font-size:11px;padding-top:8px}
@media(max-width:640px){
  body{padding:18px 14px}
  .card{padding:22px}
  h1{font-size:28px}
  .layout-long-form h1{font-size:32px}
  .fields-grid{grid-template-columns:1fr}
  .fields-grid .field{grid-column:1/-1 !important}
}

/* ── Logo positioning ──────────────────────────────────────── */
.logo-block{display:flex;width:100%;margin-bottom:18px}
.logo-block .logo{height:auto;display:block}
.logo-center-top{justify-content:center}
.logo-top-left{justify-content:flex-start}
.logo-block.logo-center-top .logo{margin:0 auto}

/* ── Step-by-step layout (typeform-style) ──────────────────── */
body.layout-step-by-step{
  align-items:center;
  background:
    radial-gradient(ellipse 70% 50% at 50% 0%, color-mix(in srgb, var(--p) 14%, transparent), transparent 60%),
    radial-gradient(ellipse 60% 40% at 50% 100%, color-mix(in srgb, var(--a) 10%, transparent), transparent 60%),
    var(--bg);
  min-height:100vh;
  padding:0;
}
.layout-step-by-step .wrap{width:min(640px,100%);padding:24px 18px}
.layout-step-by-step .form-card.sbs-shell{
  padding:0;
  background:transparent;
  border:0;
  box-shadow:none;
}
.layout-step-by-step .sbs-dots{
  display:flex;justify-content:center;gap:6px;margin:0 0 24px;
}
.layout-step-by-step .sbs-dot{
  width:8px;height:8px;border-radius:99px;
  background:color-mix(in srgb,var(--fg) 14%, transparent);
  transition:background 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease, width 0.25s ease;
}
.layout-step-by-step .sbs-dot.done{background:color-mix(in srgb,var(--p) 55%, transparent)}
.layout-step-by-step .sbs-dot.active{
  background:var(--p);
  width:24px;
  box-shadow:0 0 12px color-mix(in srgb,var(--p) 45%, transparent);
}
.layout-step-by-step .sbs-page{
  background:
    linear-gradient(155deg,
      color-mix(in srgb, var(--p) 6%, color-mix(in srgb,var(--fg) 4%, transparent)) 0%,
      color-mix(in srgb,var(--fg) 4%, transparent) 60%,
      color-mix(in srgb, var(--a) 5%, color-mix(in srgb,var(--fg) 4%, transparent)) 100%);
  border:1px solid color-mix(in srgb,var(--fg) 12%, transparent);
  border-radius:calc(var(--radius) + 8px);
  padding:0;
  margin:0;
  min-height:420px;
  backdrop-filter:blur(20px) saturate(140%);
  -webkit-backdrop-filter:blur(20px) saturate(140%);
  box-shadow:${cardShadow};
  animation:sbs-page-fade 0.35s cubic-bezier(0.2,0.8,0.2,1);
}
@keyframes sbs-page-fade{
  from{opacity:0;transform:translateY(8px) scale(0.99)}
  to{opacity:1;transform:translateY(0) scale(1)}
}
.layout-step-by-step .sbs-page-inner{
  display:flex;
  flex-direction:column;
  align-items:stretch;
  text-align:center;
  padding:42px 36px 36px;
  gap:14px;
}
.layout-step-by-step .sbs-page-inner > .logo-block{margin-bottom:6px}
.layout-step-by-step .sbs-headline{
  font-size:30px;
  margin:0;
  letter-spacing:-0.01em;
  font-family:var(--hfont);
  text-shadow:0 0 24px color-mix(in srgb,var(--p) 18%, transparent);
}
.layout-step-by-step .sbs-sub{
  margin:0 auto;
  max-width:46ch;
  font-size:16px;
  color:color-mix(in srgb,var(--fg) 70%, transparent);
}
.layout-step-by-step .sbs-fields{
  display:flex;flex-direction:column;gap:14px;
  text-align:left;
  margin-top:14px;
}
.layout-step-by-step .field-label{
  font-size:14px;
  text-align:left;
}
.layout-step-by-step .sbs-step-meta{
  margin-top:auto;
  padding-top:18px;
  font-size:11px;
  letter-spacing:1.5px;
  text-transform:uppercase;
  color:color-mix(in srgb,var(--fg) 40%, transparent);
}
.layout-step-by-step .sbs-nav{
  margin-top:18px;
  padding:0;
}
.layout-step-by-step .sbs-nav .btn-primary{
  flex:1;
  background:linear-gradient(135deg, var(--p) 0%, var(--a) 100%);
  box-shadow:0 10px 28px color-mix(in srgb,var(--p) 35%, transparent);
}
.layout-step-by-step .sbs-nav .btn-secondary{
  flex:0 0 auto;
  padding:${bpv}px 18px;
}
@media(max-width:640px){
  .layout-step-by-step .sbs-page-inner{padding:30px 22px 26px}
  .layout-step-by-step .sbs-headline{font-size:24px}
  .layout-step-by-step .sbs-sub{font-size:14px}
}
`;
}

// ── helpers ───────────────────────────────────────────────────

function ensureEmailField(fields: FormField[]): FormField[] {
  if (fields.some((f) => f.name === "email")) return fields;
  return [
    ...fields,
    {
      id: "email",
      name: "email",
      label: "Email",
      kind: "email",
      required: true,
      placeholder: "you@example.com",
    },
  ];
}

function groupByStep(fields: FormField[]): FormField[][] {
  const steps = new Map<number, FormField[]>();
  for (const f of fields) {
    const s = f.step ?? 1;
    if (!steps.has(s)) steps.set(s, []);
    steps.get(s)!.push(f);
  }
  return Array.from(steps.keys())
    .sort((a, b) => a - b)
    .map((k) => steps.get(k)!);
}

function computeTotalSteps(fields: FormField[]): number {
  let max = 1;
  for (const f of fields) if ((f.step ?? 1) > max) max = f.step ?? 1;
  return max;
}

function esc(s: string): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
