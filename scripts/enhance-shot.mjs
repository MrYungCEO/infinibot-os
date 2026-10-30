/**
 * Screenshot the 8 KIS surfaces from a locally-served control-ui build,
 * pointed at the LIVE gateway (seeded data) via __INFINIBOT_GATEWAY_URL__.
 *
 * usage: node scripts/enhance-shot.mjs <tag> [origin] [route,route,...]
 */
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const TAG = process.argv[2] || "before";
const ORIGIN = process.argv[3] || "http://127.0.0.1:18999";
const GW = "ws://127.0.0.1:18789";
const cfg = JSON.parse(readFileSync(homedir() + "/.infinibot/infinibot.json", "utf8"));
const pw = cfg?.gateway?.auth?.password ?? "";

const SURFACES = (process.argv[4]
  ? process.argv[4].split(",").map((r) => ({ route: r, name: r.replace(/\W+/g, "") || "root" }))
  : [
      { route: "/dashboard", name: "dashboard" },
      { route: "/ceo", name: "ceo" },
      { route: "/ops", name: "ops" },
      { route: "/products", name: "products" },
      { route: "/decisions", name: "decisions" },
      { route: "/risks", name: "risks" },
      { route: "/commitments", name: "commitments" },
      { route: "/people", name: "people" },
    ]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1600,1100"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1080, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 220)); });

// Seed settings BEFORE any app script runs, on every document.
await page.evaluateOnNewDocument((pw, gw) => {
  window.__INFINIBOT_GATEWAY_URL__ = gw;
  try {
    localStorage.setItem("infinibot.control.settings.v1", JSON.stringify({
      password: pw, gatewayUrl: gw, token: "", sessionKey: "main", theme: "hud",
    }));
  } catch {}
}, pw, GW);

const results = [];
for (const s of SURFACES) {
  errors.length = 0;
  await page.goto(ORIGIN + s.route, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  // dismiss the profile picker if it shows
  for (let i = 0; i < 25; i++) {
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll("a,button")].find((x) =>
        /continue as|continue →|enter$/i.test((x.textContent || "").trim()));
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) break;
    await sleep(250);
  }
  await sleep(6500); // let gateway data land + render
  // Dismiss app-level overlays (proactive missions card, CMO bubble) so the
  // screenshot shows the page under test, not the chrome on top of it.
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
  await sleep(600);
  const out = `/tmp/${process.env.SHOT_PREFIX || "enhance"}-${s.name}-${TAG}.png`;
  await page.screenshot({ path: out, fullPage: true }).catch((e) => console.error("shot fail", e.message));
  const info = await page.evaluate(() => {
    const de = document.scrollingElement || document.documentElement;
    const body = document.body;
    const txt = (body.innerText || "").replace(/\s+/g, " ").trim();
    // widest element overflowing the viewport
    let worst = null;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 4) {
        if (!worst || r.right > worst.right) worst = { tag: el.tagName.toLowerCase(), cls: (el.className || "").toString().slice(0, 60), right: Math.round(r.right) };
      }
    }
    return {
      scrollH: de.scrollHeight, scrollW: de.scrollWidth, innerW: window.innerWidth,
      hOverflow: de.scrollWidth > window.innerWidth + 2,
      worstOverflow: worst,
      textLen: txt.length,
      head: txt.slice(0, 180),
    };
  });
  results.push({ ...s, out, info, errors: [...new Set(errors)].slice(0, 4) });
  console.log(`[${s.name}] -> ${out}  h=${info.scrollH} overflowX=${info.hOverflow} textLen=${info.textLen}`);
  if (info.worstOverflow) console.log(`   OVERFLOW: ${JSON.stringify(info.worstOverflow)}`);
  if (results.at(-1).errors.length) console.log(`   ERR: ${results.at(-1).errors.join(" | ")}`);
  console.log(`   HEAD: ${info.head.slice(0, 140)}`);
}
await browser.close();
