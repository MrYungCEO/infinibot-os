/**
 * Screenshot the KIS surfaces from a locally-served control-ui build, pointed at
 * the LIVE gateway (seeded data) via __INFINIBOT_GATEWAY_URL__.
 *
 * Unlike enhance-shot.mjs this expands the inner scroll container before the
 * capture, so `fullPage` actually reaches the bottom of the page instead of
 * stopping at the first viewport (the KIS views scroll inside `.kis`, not on
 * the document).
 *
 * usage: SHOT_PREFIX=enh2 node scripts/enhance-shot2.mjs <tag> [origin] [route,...]
 */
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const TAG = process.argv[2] || "r2";
const ORIGIN = process.argv[3] || "http://127.0.0.1:18999";
const PREFIX = process.env.SHOT_PREFIX || "enh2";
const WIDTH = Number(process.env.SHOT_WIDTH || 1600);
const GW = "ws://127.0.0.1:18789";
const cfg = JSON.parse(readFileSync(homedir() + "/.infinibot/infinibot.json", "utf8"));
const pw = cfg?.gateway?.auth?.password ?? "";

const ALL = [
  { route: "/dashboard", name: "dashboard" },
  { route: "/ceo", name: "ceo" },
  { route: "/ops", name: "ops" },
  { route: "/product-portfolio", name: "productportfolio" },
  { route: "/products", name: "products" },
  { route: "/decisions", name: "decisions" },
  { route: "/risks", name: "risks" },
  { route: "/commitments", name: "commitments" },
  { route: "/people", name: "people" },
];
const SURFACES = process.argv[4]
  ? process.argv[4].split(",").map((r) => ALL.find((s) => s.name === r || s.route === r) || { route: r, name: r.replace(/\W+/g, "") })
  : ALL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${WIDTH},1100`],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: 1080, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 220)); });

await page.evaluateOnNewDocument((pw, gw) => {
  window.__INFINIBOT_GATEWAY_URL__ = gw;
  try {
    localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({
      password: pw, gatewayUrl: gw, token: "", sessionKey: "main", theme: "hud",
    }));
    // Turn the profile gate off outright — it is app chrome, not a surface
    // under test, and clicking it is a race against Lit hydration.
    localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
    sessionStorage.setItem("infinibot.profiles.gatePassed", "1");
  } catch {}
}, pw, GW);

for (const s of SURFACES) {
  errors.length = 0;
  await page.goto(ORIGIN + s.route, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});

  // Dismiss the profile gate. Keep clicking until the gate text is gone —
  // never break early on "not rendered yet", which is indistinguishable from
  // "already dismissed" during the first few hundred ms.
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(() => {
      const gated = /pick a profile/i.test(document.body.innerText || "");
      if (!gated) return "clear";
      const el = [...document.querySelectorAll("a,button")].find((x) =>
        /continue as|continue →|^enter$/i.test((x.textContent || "").trim()));
      if (el) { el.click(); return "clicked"; }
      return "gated";
    }).catch(() => "gated");
    if (state === "clear" && i > 3) break;
    await sleep(250);
  }
  await sleep(11000); // let the gateway RPCs land and the views render

  // Hide app chrome overlays so the capture shows the page under test.
  await page.evaluate(() => {
    const kill = (root) => {
      for (const el of root.querySelectorAll("*")) {
        const n = el.tagName.toLowerCase();
        if (/proactive|overlay-host|cmo-chat|mission/.test(n)) el.style.display = "none";
        if (el.shadowRoot) kill(el.shadowRoot);
      }
    };
    kill(document);
  }).catch(() => {});

  // Measure the real (unexpanded) layout first, then expand every inner
  // scroller so fullPage reaches the bottom.
  const info = await page.evaluate(() => {
    const out = { overflowX: null, scrollers: [], contrastFails: [], emoji: [] };
    // Walk light DOM *and* every shadow root — the KIS views render inside
    // Lit components, so document.querySelectorAll("*") sees almost nothing.
    const all = [];
    (function walk(root) {
      for (const el of root.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(document);
    // horizontal overflow of the real layout
    let worst = null;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 4 && getComputedStyle(el).position !== "fixed") {
        if (!worst || r.right > worst.right) worst = { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 70), right: Math.round(r.right) };
      }
    }
    out.overflowX = worst;

    // emoji in the KIS chrome (design system says inline SVG only)
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    const kisRoots = all.filter((e) => String(e.className).split(/\s+/).includes("kis"));
    for (const scope of kisRoots.length ? kisRoots : []) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").trim();
        if (t && EMOJI.test(t)) out.emoji.push(t.slice(0, 40));
      }
    }
    out.kisFound = kisRoots.length;

    // Report the tallest inner scroller so the caller can re-render the real
    // layout at a viewport that fits it, rather than forcing overflow:visible
    // (which never grows a fixed-height app shell anyway).
    let need = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (String(el.className).split(/\s+/).includes("nav-categories")) continue; // sidebar
      if (el.scrollHeight > el.clientHeight + 8) {
        out.scrollers.push({ cls: String(el.className).slice(0, 50), sh: el.scrollHeight, ch: el.clientHeight });
        need = Math.max(need, el.scrollHeight - el.clientHeight);
      }
    }
    out.grow = need;
    return out;
  });

  // Grow the window so the whole surface is on screen at once, then let it
  // settle and re-measure (taller viewport can reflow multi-column grids).
  let grow = info.grow || 0;
  for (let pass = 0; pass < 3 && grow > 8; pass++) {
    await page.setViewport({ width: WIDTH, height: Math.min(1080 + grow + 80, 12000), deviceScaleFactor: 1 });
    await sleep(1200);
    grow = await page.evaluate(() => {
      const all = [];
      (function walk(root) { for (const el of root.querySelectorAll("*")) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } })(document);
      let need = 0;
      for (const el of all) {
        const cs = getComputedStyle(el);
        if (!/(auto|scroll)/.test(cs.overflowY)) continue;
        if (String(el.className).split(/\s+/).includes("nav-categories")) continue;
        if (el.scrollHeight > el.clientHeight + 8) need = Math.max(need, el.scrollHeight - el.clientHeight);
      }
      return need;
    });
  }

  await sleep(700);
  const out = `/tmp/${PREFIX}-${s.name}-${TAG}.png`;
  await page.screenshot({ path: out }).catch((e) => console.error("shot fail", e.message));
  await page.setViewport({ width: WIDTH, height: 1080, deviceScaleFactor: 1 });
  const after = await page.evaluate(() => ({
    h: window.innerHeight,
    textLen: (document.body.innerText || "").replace(/\s+/g, " ").trim().length,
  }));

  console.log(`[${s.name}] -> ${out}  h=${after.h} textLen=${after.textLen}`);
  if (info.overflowX) console.log(`   OVERFLOW-X: ${JSON.stringify(info.overflowX)}`);
  if (info.emoji.length) console.log(`   EMOJI: ${JSON.stringify([...new Set(info.emoji)].slice(0, 6))}`);
  if (info.scrollers.length) console.log(`   EXPANDED: ${JSON.stringify(info.scrollers.slice(0, 3))}`);
  const errs = [...new Set(errors)].filter((e) => !/WakeWord|NotAllowedError/.test(e)).slice(0, 3);
  if (errs.length) console.log(`   ERR: ${errs.join(" | ")}`);
}
await browser.close();
