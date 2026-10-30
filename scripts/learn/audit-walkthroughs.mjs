#!/usr/bin/env node
/**
 * Guided Learn audit — runs EVERY available walkthrough end to end in headless
 * Chrome against a running gateway and proves each step's target resolves and
 * the step advances (the engine's auto mode performs click / type / toggle /
 * navigate actions; `practice: explain` steps are never performed).
 *
 * Point it at an ISOLATED side gateway: auto mode clicks real controls.
 *
 *   BASE=http://127.0.0.1:18964 PW=<password> OUT=/tmp/learn-audit \
 *     node scripts/learn/audit-walkthroughs.mjs [trackIdRegex]
 *
 * INJECT=<file,…> registers tracks into the page before auditing (no rebuild or
 * gateway restart needed while authoring): a core track module
 * (src/learn/guided/core/<id>.ts, exporting `track`) or a plugin learn.json
 * (plugin id read from the sibling infinibot.plugin.json). TS needs
 * `node --import tsx scripts/learn/audit-walkthroughs.mjs`.
 *
 * Env: WIDTH (default 1440), HEIGHT (900), THEME (dark|light), SURFACES
 * (comma list of surface ids to force on — r9 builds only), CHROME (binary).
 * Writes OUT/report.json + OUT/report.md (walkthrough → steps passed/total).
 * Exit code 1 when any step failed.
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const BASE = process.env.BASE ?? "http://127.0.0.1:18964";
const PW = process.env.PW ?? "";
const OUT = process.env.OUT ?? "/tmp/learn-audit";
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const THEME = process.env.THEME ?? "dark";
const FILTER = process.argv[2] ? new RegExp(process.argv[2]) : null;
const SHOTS = process.env.SHOTS === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (/:18789\b/.test(BASE)) {
  console.error("refusing to audit the live gateway (auto mode clicks real controls)");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/opt/google/chrome/chrome",
  headless: "new",
  protocolTimeout: 180000,
  userDataDir: path.join(OUT, `chrome-${WIDTH}`),
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, isMobile: WIDTH < 500, hasTouch: WIDTH < 500 },
});
let page;
const errors = [];
/** (Re)open the app on /learn, signed in and ready. A walkthrough that reloads
 *  the page or detaches the frame is recovered by calling this again. */
async function openPage() {
  if (page) await page.close().catch(() => {});
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 240)));
  await page.evaluateOnNewDocument((surfaces) => {
    // Proactive overlays / toasts sit over the page under test.
    const st = document.createElement("style");
    st.textContent =
      "proactive-overlay-host,proactive-presenter,proactive-modal,proactive-popups,proactive-toast,proactive-lightbox,cmo-chat{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(st));
    if (surfaces) {
      window.__learnSurfaces = Object.fromEntries(surfaces.split(",").filter(Boolean).map((s) => [s, true]));
    }
  }, process.env.SURFACES ?? "");

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(
    (pw, theme, narrow) => {
      const prev = JSON.parse(localStorage.getItem("infinibot.control.settings.v1") || "{}");
      localStorage.setItem(
        "infinibot.control.settings.v1",
        JSON.stringify({ ...prev, password: pw, token: "", theme, ...(narrow ? { navCollapsed: true } : {}) }),
      );
      // Keep first-run surfaces out of the way.
      localStorage.setItem("infinibot.learn.guided.v1", JSON.stringify({ prefs: { missionsDismissed: true, autoPopped: true } }));
    },
    PW,
    THEME,
    WIDTH < 800,
  );
  await page.goto(`${BASE}/learn`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(5000);
  for (let i = 0; i < 3; i++) {
    const txt = await page.evaluate(() => document.body.innerText);
    if (/Pick a profile/i.test(txt)) {
      await page.evaluate(() => [...document.querySelectorAll("button,a")].find((x) => /Continue as/i.test(x.textContent))?.click());
      await sleep(3000);
    }
  }
  await page.waitForFunction(() => window.__infinibotLearn && document.querySelector("infinibot-app")?.client?.connected, { timeout: 60000 });
  await page.waitForFunction(() => window.__infinibotLearn.catalog().loaded, { timeout: 60000 });
  await sleep(1500);
}
await openPage();

// Dev injection: register local track files into the running page.
const injected = [];
for (const file of (process.env.INJECT ?? "").split(",").map((f) => f.trim()).filter(Boolean)) {
  const abs = path.resolve(file);
  let tracks = [];
  let pluginId;
  if (abs.endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    tracks = Array.isArray(raw) ? raw : raw.tracks ?? [raw];
    const manifest = path.join(path.dirname(abs), "infinibot.plugin.json");
    if (fs.existsSync(manifest)) pluginId = JSON.parse(fs.readFileSync(manifest, "utf8")).id;
  } else {
    const mod = await import(`${abs}?t=${Date.now()}`);
    const t = mod.track ?? mod.default ?? mod.CORE_TRACKS;
    tracks = Array.isArray(t) ? t : t ? [t] : [];
  }
  for (const t of tracks) {
    const err = await page.evaluate((track, pid) => window.__infinibotLearn.register(track, pid ? { pluginId: pid } : {}), t, pluginId ?? null);
    injected.push({ file, id: t.id, error: err });
    console.log(err ? `INJECT FAIL ${t.id}: ${err}` : `injected ${t.id}${pluginId ? ` (plugin ${pluginId})` : ""}`);
  }
}
if (injected.some((i) => i.error)) process.exitCode = 1;
const injectedIds = new Set(injected.filter((i) => !i.error).map((i) => i.id));

const catalog = await page.evaluate(() => {
  const s = window.__infinibotLearn.catalog();
  return { source: s.source, tracks: s.tracks.map((t) => ({ id: t.id, pluginId: t.pluginId ?? null, walkthroughs: t.walkthroughs.map((w) => ({ id: w.id, title: w.title, steps: w.steps.length })) })) };
});
console.log(`catalog source=${catalog.source} tracks=${catalog.tracks.length}`);

const rows = [];
for (const t of catalog.tracks) {
  if (FILTER && !FILTER.test(t.id)) continue;
  if (injectedIds.size && process.env.ONLY_INJECTED !== "0" && !injectedIds.has(t.id)) continue;
  for (const w of t.walkthroughs) {
    // Start every walkthrough from a neutral page so route navigation is exercised.
    const toNeutral = () =>
      page.evaluate(() => {
        if (!window.__infinibotLearn) throw new Error("learn runtime missing");
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    try {
      await toNeutral();
    } catch (e) {
      console.log(`  (recovering page: ${String(e?.message ?? e).slice(0, 80)})`);
      await openPage();
      await toNeutral();
    }
    await sleep(600);
    const shotHook = SHOTS
      ? setTimeout(async () => {
          try {
            await page.screenshot({ path: path.join(OUT, `mid-${t.id}-${w.id}.png`) });
          } catch {}
        }, 2500)
      : null;
    const t0 = Date.now();
    const rep = await page.evaluate((tid, wid) => window.__infinibotLearn.audit(tid, wid, 150000), t.id, w.id).catch((e) => ({
      trackId: t.id,
      walkthroughId: w.id,
      steps: w.steps,
      passed: 0,
      results: [],
      finished: false,
      error: String(e?.message ?? e).slice(0, 200),
    }));
    if (shotHook) clearTimeout(shotHook);
    const failed = rep.results.filter((r) => !r.ok);
    rows.push({ ...rep, pluginId: t.pluginId, title: w.title, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    console.log(
      `${failed.length ? "FAIL" : "ok  "} ${t.id}/${w.id}  ${rep.passed}/${rep.steps}${failed.length ? "  ← " + failed.map((f) => `${f.stepId}(${f.reason})`).join(", ") : ""}`,
    );
  }
}

const totalSteps = rows.reduce((n, r) => n + r.steps, 0);
const passedSteps = rows.reduce((n, r) => n + r.passed, 0);
const report = {
  base: BASE,
  width: WIDTH,
  theme: THEME,
  at: new Date().toISOString(),
  catalogSource: catalog.source,
  walkthroughs: rows.length,
  walkthroughsPassed: rows.filter((r) => r.passed === r.steps && r.finished).length,
  steps: totalSteps,
  stepsPassed: passedSteps,
  pageErrors: [...new Set(errors)].slice(0, 40),
  rows,
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
const md = [
  `# Guided Learn audit — ${report.at}`,
  "",
  `Gateway ${BASE} · ${WIDTH}px · ${THEME} · catalog from ${catalog.source}`,
  "",
  `**${report.walkthroughsPassed}/${report.walkthroughs} walkthroughs fully passed · ${passedSteps}/${totalSteps} steps**`,
  "",
  "| Track | Walkthrough | Steps passed | Finished | Failures |",
  "|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.trackId}${r.pluginId ? ` (${r.pluginId})` : ""} | ${r.title} | ${r.passed}/${r.steps} | ${r.finished ? "yes" : "no"} | ${r.results
        .filter((x) => !x.ok)
        .map((x) => `${x.stepId}: ${x.reason}`)
        .join("; ") || "—"} |`,
  ),
  "",
].join("\n");
fs.writeFileSync(path.join(OUT, "report.md"), md);
console.log(`\n${report.walkthroughsPassed}/${report.walkthroughs} walkthroughs, ${passedSteps}/${totalSteps} steps → ${OUT}/report.md`);
await browser.close();
process.exit(passedSteps === totalSteps && report.walkthroughsPassed === report.walkthroughs ? 0 : 1);
