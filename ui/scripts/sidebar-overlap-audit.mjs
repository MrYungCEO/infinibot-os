#!/usr/bin/env node
// Sidebar overlap audit for the control UI.
//
// Visits every sidebar tab and every merged-host sub-tab (TAB_GROUPS +
// HOST_SUBVIEWS in src/ui/navigation.ts) with the sidebar expanded and
// collapsed, at several widths, and flags any visible element outside the
// sidebar whose (ancestor-clipped) rect intersects the sidebar's rect, plus
// horizontal page overflow.
//
// Usage (against a preview of a build, e.g. `vite preview` or any static
// SPA server over dist/control-ui; the gateway is only a data source):
//   node ui/scripts/sidebar-overlap-audit.mjs --url http://localhost:4173 \
//     --gateway ws://localhost:18789 --out /tmp/sidebar-audit
// Options: --widths 1920,1440,1280,1100,1024,768,390  --states expanded,collapsed
//          --only mesh,grid  --concurrency 2  --settle 1500  --no-shots
//          --keep-transitions (use with --concurrency 1)  --recycle 25
// Auth: password/token are read from ~/.infinibot/infinibot.json when present
// (override with --password / --token). Exit code 1 when overlaps are found.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};

const BASE = String(arg("url", "http://localhost:4173")).replace(/\/$/, "");
const GATEWAY = String(arg("gateway", "ws://localhost:18789"));
const OUT = path.resolve(String(arg("out", "/tmp/sidebar-overlap-audit")));
const WIDTHS = String(arg("widths", "1920,1440,1280,1100,1024,768,390")).split(",").map(Number);
const STATES = String(arg("states", "expanded,collapsed")).split(",");
const ONLY = arg("only", "") ? String(arg("only")).split(",") : null;
const CONCURRENCY = Number(arg("concurrency", 2));
const SETTLE = Number(arg("settle", 1500));
const SHOTS = !arg("no-shots", false);
const CHROME = String(arg("chrome", existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : ""));

let cfg = {};
try { cfg = JSON.parse(readFileSync(path.join(homedir(), ".infinibot/infinibot.json"), "utf8")); } catch {}
const PASSWORD = String(arg("password", cfg?.gateway?.auth?.password ?? ""));
const TOKEN = String(arg("token", cfg?.gateway?.auth?.token ?? ""));

// ---- routes from navigation.ts (parsed, so new tabs are picked up) --------
function loadRoutes() {
  const src = readFileSync(path.join(here, "../src/ui/navigation.ts"), "utf8");
  const groups = src.slice(src.indexOf("export const TAB_GROUPS"), src.indexOf("] as const;"));
  const tabs = [...groups.matchAll(/tabs:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const pathsSrc = src.slice(src.indexOf("const TAB_PATHS"));
  const paths = Object.fromEntries([...pathsSrc.slice(0, pathsSrc.indexOf("};")).matchAll(/^\s*"?([\w-]+)"?:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const hostSrc = src.slice(src.indexOf("export const HOST_SUBVIEWS"));
  const hostBody = hostSrc.slice(0, hostSrc.indexOf("\n};"));
  const routes = [];
  for (const t of tabs) routes.push({ id: t, path: paths[t] ?? `/${t}` });
  for (const m of hostBody.matchAll(/^\s{2}"?([\w-]+)"?:\s*\[([\s\S]*?)^\s{2}\],/gm)) {
    const host = m[1];
    const views = [...m[2].matchAll(/\{\s*id:\s*"([^"]+)"[^}]*\}/g)].map((v) => ({ id: v[1], hidden: /hidden:\s*true/.test(v[0]) }));
    views.slice(1).filter((v) => !v.hidden).forEach((v) => routes.push({ id: `${host}~${v.id}`, path: `${paths[host] ?? `/${host}`}?view=${v.id}` }));
  }
  return routes.filter((r) => !ONLY || ONLY.some((o) => r.id === o || r.id.startsWith(`${o}~`)));
}

// ---- in-page measurement ---------------------------------------------------
function measure() {
  const vw = innerWidth, vh = innerHeight;
  const nav = document.querySelector(".shell > .nav, aside.nav, .nav");
  const shell = document.querySelector(".shell");
  const main = document.querySelector("main.content");
  const r2 = (b) => ({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
  if (!nav) return { error: "no .nav" };
  const navCs = getComputedStyle(nav);
  const n = nav.getBoundingClientRect();
  const navHidden = navCs.display === "none" || navCs.visibility === "hidden" || n.width < 1 || n.height < 1 || Number(navCs.opacity) === 0;
  const parentOf = (e) => e.assignedSlot ?? e.parentElement ?? (e.parentNode instanceof ShadowRoot ? e.parentNode.host : null);
  const contains = (a, e) => { for (let x = e; x; x = parentOf(x)) if (x === a) return true; return false; };
  const all = [];
  const walk = (root) => { for (const e of root.querySelectorAll("*")) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
  walk(document);
  const makesCB = (cs) => cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" || /paint|layout|strict|content/.test(cs.contain);
  const clipCache = new Map();
  // Visible rect of e after clipping by overflow ancestors (respecting fixed).
  const clipped = (e, b) => {
    let L = b.left, T = b.top, R = b.right, B = b.bottom;
    let fixed = getComputedStyle(e).position === "fixed";
    for (let a = parentOf(e); a && a !== document.documentElement && a !== document.body; a = parentOf(a)) {
      let info = clipCache.get(a);
      if (!info) {
        const cs = getComputedStyle(a);
        info = { clipX: cs.overflowX !== "visible" || cs.contain.includes("paint"), clipY: cs.overflowY !== "visible" || cs.contain.includes("paint"), cb: makesCB(cs), fixed: cs.position === "fixed", rect: a.getBoundingClientRect(), opacity0: Number(cs.opacity) === 0, displayContents: cs.display === "contents" };
        clipCache.set(a, info);
      }
      if (info.opacity0) return null;
      if (info.displayContents) continue;
      if (fixed && !info.cb) { if (info.fixed) fixed = false; continue; }
      if (fixed && info.cb) fixed = false;
      if (info.clipX) { L = Math.max(L, info.rect.left); R = Math.min(R, info.rect.right); }
      if (info.clipY) { T = Math.max(T, info.rect.top); B = Math.min(B, info.rect.bottom); }
      if (R - L < 1 || B - T < 1) return null;
    }
    L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, vw); B = Math.min(B, vh);
    return R - L >= 1 && B - T >= 1 ? { left: L, top: T, right: R, bottom: B } : null;
  };
  const label = (e) => {
    const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
    let host = ""; const root = e.getRootNode(); if (root instanceof ShadowRoot) host = `${root.host.tagName.toLowerCase()} >>> `;
    return `${host}${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${cls ? `.${cls}` : ""}`;
  };
  const hits = new Set();
  const offenders = [];
  const exceptions = [];
  const exceptionEls = new Set();
  if (!navHidden) {
    for (const e of all) {
      if (e === nav || contains(nav, e) || contains(e, nav)) continue;
      if (/^(script|style|link|meta|template|slot|title|defs|clippath|lineargradient|radialgradient|stop|mask|filter)$/i.test(e.tagName)) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (b.right <= n.left + 1 || b.left >= n.right - 1 || b.bottom <= n.top + 1 || b.top >= n.bottom - 1) continue;
      const c = clipped(e, b);
      if (!c) continue;
      const ix = Math.min(c.right, n.right) - Math.max(c.left, n.left);
      const iy = Math.min(c.bottom, n.bottom) - Math.max(c.top, n.top);
      if (ix <= 1 || iy <= 1) continue;
      // Is anything actually painted? Empty wrappers with no bg/border/text
      // are skipped; their painted descendants get reported instead.
      const painted = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none" || parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth) + parseFloat(cs.borderBottomWidth) > 0 || cs.boxShadow !== "none" || cs.backdropFilter !== "none" && cs.backdropFilter !== undefined || /^(canvas|img|svg|video|iframe|input|textarea|select|button|path|rect|circle|text|line|polyline|polygon|ellipse|image|use|g)$/i.test(e.tagName) || [...e.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim());
      if (!painted) continue;
      const fullViewport = (cs.position === "fixed" || cs.position === "absolute") && b.left <= 1 && b.top <= 1 && b.width >= vw * 0.95 && b.height >= vh * 0.9;
      const rec = { el: label(e), rect: r2(b), visible: r2({ left: c.left, top: c.top, width: c.right - c.left, height: c.bottom - c.top }), overlap: [Math.round(ix), Math.round(iy)], pos: cs.position, z: cs.zIndex, pe: cs.pointerEvents };
      if (fullViewport) { exceptions.push({ ...rec, reason: "full-viewport fixed layer (modal/backdrop/decor)" }); exceptionEls.add(e); continue; }
      // Content of a full-viewport modal (its card, buttons) is part of the modal.
      let inModal = false;
      for (let a = parentOf(e); a && !inModal; a = parentOf(a)) inModal = exceptionEls.has(a);
      if (inModal) continue;
      hits.add(e);
      offenders.push({ ...rec, _e: e });
    }
  }
  // Keep only the outermost offenders (their descendants are noise).
  const outer = offenders.filter((o) => { for (let a = parentOf(o._e); a; a = parentOf(a)) if (hits.has(a)) return false; return true; });
  // Page-level horizontal scroll (documentElement is never zoomed, so this
  // stays in viewport px even with viewport-scale.css's body zoom).
  const de = document.documentElement;
  const overflowX = de.scrollWidth - de.clientWidth;
  const m = main ? main.getBoundingClientRect() : null;
  window.__overlapEls = outer.map((o) => o._e);
  return {
    nav: r2(n), navHidden, navCollapsed: nav.classList.contains("nav--collapsed"),
    shellCols: shell ? getComputedStyle(shell).gridTemplateColumns : null,
    main: m ? r2(m) : null, mainClass: main?.className ?? null,
    overflowX: overflowX > 1 ? overflowX : 0,
    offenders: outer.map(({ _e, ...o }) => o), offenderTotal: offenders.length, exceptions,
  };
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Skip the multi-profile "Who's using InfiniBot?" gate for this tab.
  await page.evaluate(() => sessionStorage.setItem("infinibot.profiles.gatePassed", "1"));
  await page.evaluate((pw, tk, gw) => localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({ ...(JSON.parse(localStorage.getItem("infinibot.control.settings.v1") || "{}")), password: pw, token: tk, gatewayUrl: gw })), PASSWORD, TOKEN, GATEWAY);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 80; i++) {
    const state = await page.evaluate(() => {
      if (document.querySelector("main.content")) return "ready";
      const deep = (root, out = []) => { for (const e of root.querySelectorAll("a,button")) out.push(e); for (const e of root.querySelectorAll("*")) if (e.shadowRoot) deep(e.shadowRoot, out); return out; };
      const e = deep(document).find((x) => /continue as/i.test(x.textContent || ""));
      if (e) { e.click(); return "clicked"; }
      return "wait";
    });
    if (state === "ready") break;
    await sleep(state === "clicked" ? 800 : 300);
  }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!document.querySelector("main.content"))) break; await sleep(500); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Geometry transitions are frozen by default: headless background tabs don't
// reliably tick CSS transitions, which would leave the grid mid-collapse.
// --keep-transitions measures the real transition end state (use with
// --concurrency 1 so the page stays in the foreground).
const FREEZE_CSS = `*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; } .shell, .shell > .nav, .shell > .content { animation: none !important; }`;
const KEEP_TRANSITIONS = Boolean(arg("keep-transitions", false));
const RECYCLE_EVERY = Number(arg("recycle", 25));

const viewportFor = (width) => ({ width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1 });

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport(viewportFor(WIDTHS[0]));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await login(page);
  if (!(await hasShell(page))) { await page.close().catch(() => {}); throw new Error("login failed: shell not rendered"); }
  if (!KEEP_TRANSITIONS) await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  return page;
}

const hasShell = (page) => page.evaluate(() => !!document.querySelector("infinibot-app > .shell")).catch(() => false);

async function setCollapsed(page, collapsed) {
  await page.evaluate((c) => { const app = document.querySelector("infinibot-app"); if (app && Boolean(app.settings?.navCollapsed) !== c) app.applySettings({ ...app.settings, navCollapsed: c }); }, collapsed);
  await sleep(KEEP_TRANSITIONS ? 450 : 120); // > --shell-focus-duration transition
}

async function measureCase(page, r, width, state) {
  const key = `${r.id}@${width}-${state}`;
  // Toggle away and back so we check the end state after a live toggle.
  await setCollapsed(page, state !== "collapsed");
  await setCollapsed(page, state === "collapsed");
  await sleep(150);
  if (!(await hasShell(page))) throw new Error("disconnected: shell not rendered");
  const m = await page.evaluate(measure);
  const url = await page.evaluate(() => location.pathname + location.search);
  const res = { key, route: r.id, path: r.path, landed: url, width, state, ...m };
  const failing = Boolean((m.offenders?.length ?? 0) > 0 || m.overflowX > 0 || m.error);
  if (failing && SHOTS) {
    await page.evaluate(() => { for (const e of window.__overlapEls || []) { e.style.outline = "2px solid #ff00aa"; e.style.outlineOffset = "-2px"; } });
    res.shot = path.join(OUT, `${r.id}@${width}-${state}.png`);
    await page.screenshot({ path: res.shot });
    await page.evaluate(() => { for (const e of window.__overlapEls || []) { e.style.outline = ""; e.style.outlineOffset = ""; } });
  }
  process.stdout.write(`${failing ? "✗" : "✓"} ${key} ${failing ? `offenders=${res.offenders?.length ?? "?"} overflowX=${res.overflowX}` : ""}\n`);
  return res;
}

// One route visit → every width × state (viewport resized in place): logins
// against a busy gateway are the slow part, so each worker logs in once.
async function auditRoute(page, r) {
  const out = [];
  await page.setViewport(viewportFor(WIDTHS[0]));
  await page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, r.path);
  await sleep(SETTLE);
  for (const width of WIDTHS) {
    await page.setViewport(viewportFor(width));
    await sleep(RESIZE_SETTLE);
    for (const state of STATES) out.push(await measureCase(page, r, width, state));
  }
  return out;
}

async function worker(browser, queue, results) {
  let page = null;
  let used = 0;
  while (queue.length) {
    const r = queue.shift();
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!page || used >= RECYCLE_EVERY || !(await hasShell(page))) {
          if (page) await page.close().catch(() => {});
          page = null;
          page = await openPage(browser);
          used = 0;
        }
        used++;
        results.push(...(await auditRoute(page, r)));
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (page) await page.close().catch(() => {});
        page = null;
      }
    }
    if (lastErr) {
      for (const width of WIDTHS) for (const state of STATES) results.push({ key: `${r.id}@${width}-${state}`, route: r.id, width, state, error: String(lastErr).slice(0, 300) });
      process.stdout.write(`! ${r.id} ${String(lastErr).slice(0, 120)}\n`);
    }
  }
  if (page) await page.close().catch(() => {});
}

const RESIZE_SETTLE = Number(arg("resize-settle", 400));
const routes = loadRoutes();
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: "new", ...(CHROME ? { executablePath: CHROME } : {}),
  // Keep background pages ticking rAF/timers (several workers share a browser).
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
  protocolTimeout: 180000,
});
const results = [];
const queue = [...routes];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, routes.length) }, () => worker(browser, queue, results)));
await browser.close();
results.sort((a, b) => a.key.localeCompare(b.key));
const failing = results.filter((r) => r.offenders?.length || r.overflowX || r.error);
const summary = {
  base: BASE, when: new Date().toISOString(), routes: routes.length, cases: results.length,
  failingCases: failing.length,
  overlapCases: results.filter((r) => r.offenders?.length).length,
  overlapElements: results.reduce((n, r) => n + (r.offenders?.length ?? 0), 0),
  overflowCases: results.filter((r) => r.overflowX).length,
  errorCases: results.filter((r) => r.error).length,
  exceptions: [...new Set(results.flatMap((r) => (r.exceptions ?? []).map((e) => e.el)))],
};
writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ summary, failing, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(failing.length ? 1 : 0);
