#!/usr/bin/env node
/**
 * Probe a control-UI route for walkthrough targets: lists visible headings,
 * buttons, inputs, tabs and every [data-learn-id] (piercing shadow roots) with
 * a selector that works with the guided engine's deep resolver.
 *
 *   BASE=http://127.0.0.1:18964 PW=<pw> node scripts/learn/probe-route.mjs /infinitrade/journal [/other ...]
 *   TEST='["learn:foo", ".bar"]' … probe-route.mjs /route   → also reports whether each target resolves
 *
 * Env: WIDTH (1440), WAIT (ms after navigation, default 3500), SHOT=1 saves a PNG to /tmp/learn-probe,
 * CLICK='sel,…' clicks those (deep) selectors first (e.g. to open a dialog or tab).
 */

import fs from "node:fs";
import puppeteer from "puppeteer";

const BASE = process.env.BASE ?? "http://127.0.0.1:18964";
const PW = process.env.PW ?? "";
const WIDTH = Number(process.env.WIDTH ?? 1440);
const WAIT = Number(process.env.WAIT ?? 3500);
const routes = process.argv.slice(2);
if (/:18789\b/.test(BASE)) {
  console.error("refusing the live gateway");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = process.env.TEST ? JSON.parse(process.env.TEST) : [];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/opt/google/chrome/chrome",
  headless: "new",
  userDataDir: `/tmp/learn-probe/chrome-${WIDTH}-${process.pid}`,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: WIDTH, height: WIDTH < 500 ? 844 : 900, isMobile: WIDTH < 500, hasTouch: WIDTH < 500 },
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  const st = document.createElement("style");
  st.textContent = "proactive-overlay-host,proactive-toast,proactive-popups,cmo-chat{display:none!important}";
  document.addEventListener("DOMContentLoaded", () => document.head.appendChild(st));
});
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.evaluate((pw) => {
  const prev = JSON.parse(localStorage.getItem("infinibot.control.settings.v1") || "{}");
  localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({ ...prev, password: pw, token: "" }));
  localStorage.setItem("infinibot.learn.guided.v1", JSON.stringify({ prefs: { missionsDismissed: true, autoPopped: true } }));
}, PW);
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("infinibot-app")?.client?.connected, { timeout: 60000 });
fs.mkdirSync("/tmp/learn-probe", { recursive: true });

for (const route of routes) {
  await page.evaluate((r) => {
    window.history.pushState({}, "", r);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, route);
  await sleep(WAIT);
  // CLICK='sel1,sel2' clicks each (deep) selector in order before probing.
  for (const c of (process.env.CLICK ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const ok = await page.evaluate((q) => {
      const all = [document];
      const walk = (root) => {
        const tw = document.createTreeWalker(root instanceof Document ? root.documentElement : root, NodeFilter.SHOW_ELEMENT);
        let n = tw.currentNode;
        while (n) {
          if (n.shadowRoot) { all.push(n.shadowRoot); walk(n.shadowRoot); }
          n = tw.nextNode();
        }
      };
      walk(document);
      const sel = q.startsWith("learn:") ? `[data-learn-id="${q.slice(6)}"]` : q;
      for (const r of all) {
        const el = r.querySelector(sel);
        if (el) { el.click(); return true; }
      }
      return false;
    }, c);
    console.log(`-- click ${c}: ${ok ? "ok" : "NOT FOUND"}`);
    await sleep(1500);
  }
  const out = await page.evaluate((tests) => {
    const roots = [document];
    const walk = (root) => {
      const tw = document.createTreeWalker(root instanceof Document ? root.documentElement : root, NodeFilter.SHOW_ELEMENT);
      let n = tw.currentNode;
      while (n) {
        if (n.shadowRoot) {
          roots.push(n.shadowRoot);
          walk(n.shadowRoot);
        }
        n = tw.nextNode();
      }
    };
    walk(document);
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right < 0 || r.left > innerWidth) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    };
    const sel = (el) => {
      if (el.dataset.learnId) return `learn:${el.dataset.learnId}`;
      const attrs = [...el.attributes].filter((a) => /^data-|^aria-label$|^role$|^name$|^placeholder$/.test(a.name) && a.value && a.value.length < 50);
      const cls = [...el.classList].filter((c) => !/active|on|is-|hover|focus|open|selected|done/.test(c)).slice(0, 2);
      const host = el.getRootNode()?.host?.tagName?.toLowerCase();
      const base = el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "") + (attrs[0] ? `[${attrs[0].name}="${attrs[0].value}"]` : "");
      return host ? `${base}   (in <${host}>)` : base;
    };
    const pick = (q) => {
      const seen = new Set();
      const res = [];
      for (const r of roots) for (const el of r.querySelectorAll(q)) if (!seen.has(el) && vis(el)) { seen.add(el); res.push(el); }
      return res;
    };
    const text = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const resolveT = (t) => {
      const list = (Array.isArray(t) ? t : [t]).map((x) => (x.startsWith("learn:") ? `[data-learn-id="${x.slice(6)}"]` : x));
      for (const q of list) {
        for (const r of roots) {
          try {
            const hit = [...r.querySelectorAll(q)].find(vis);
            if (hit) return q;
          } catch { return `INVALID ${q}`; }
        }
      }
      return null;
    };
    return {
      path: location.pathname + location.search,
      learnIds: pick("[data-learn-id]").map((e) => `learn:${e.dataset.learnId}  "${text(e)}"`),
      headings: pick("h1,h2,h3").slice(0, 25).map((e) => `${sel(e)}  "${text(e)}"`),
      tabs: pick('[role="tab"],[data-tab],[data-view],[data-section]').slice(0, 30).map((e) => `${sel(e)}  "${text(e)}"`),
      buttons: pick("button,a[href]").filter((e) => text(e)).slice(0, 60).map((e) => `${sel(e)}  "${text(e)}"`),
      inputs: pick("input,textarea,select,[contenteditable=true],[role=switch]").slice(0, 25).map((e) => `${sel(e)}  "${text(e)}"`),
      tests: tests.map((t) => ({ target: t, resolvedBy: resolveT(t) })),
    };
  }, tests);
  console.log(`\n=== ${route} → ${out.path}`);
  for (const k of ["learnIds", "headings", "tabs", "inputs", "buttons"]) {
    if (!out[k].length) continue;
    console.log(`-- ${k}`);
    for (const l of out[k]) console.log("   " + l);
  }
  if (out.tests.length) {
    console.log("-- target tests");
    for (const t of out.tests) console.log(`   ${t.resolvedBy ? "OK " : "MISSING"} ${JSON.stringify(t.target)}${t.resolvedBy ? "  via " + t.resolvedBy : ""}`);
  }
  if (process.env.SHOT === "1") {
    const f = `/tmp/learn-probe/${route.replace(/[^a-z0-9]+/gi, "_")}-${WIDTH}.png`;
    await page.screenshot({ path: f });
    console.log(`-- shot ${f}`);
  }
}
await browser.close();
