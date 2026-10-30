#!/usr/bin/env node
// Screenshots of Content Studio › Posting (Phone & account) on the detect-e2e
// side gateway. usage: SHOTS=/tmp/droid-detect-shots node detect-shoot.mjs <label> [all|viewport]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const REPO = process.env.REPO || path.resolve(import.meta.dirname, "../../..");
const require = createRequire(path.join(REPO, "package.json"));
const puppeteer = require("puppeteer");
const DIR = process.env.DET_E2E_DIR || "/tmp/droid-detect-e2e";
const OUT = process.env.SHOTS || "/tmp/droid-detect-shots";
const label = process.argv[2] || "shot";
const mode = process.argv[3] || "all";
const info = JSON.parse(fs.readFileSync(path.join(DIR, "info.json"), "utf8"));
const base = `http://127.0.0.1:${info.port}`;
fs.mkdirSync(OUT, { recursive: true });

const walkFn = `(pred) => { const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (pred(el)) return el; if (el.shadowRoot) { const h = walk(el.shadowRoot); if (h) return h; } } return null; }; return walk(document); }`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader"],
});
const errors = [];
const shots = [];
const vps = [
  { name: "desktop", width: 1440, height: 1000, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
  ...(mode === "all"
    ? [
        { name: "desktop-panel", width: 1440, height: 2400, mobile: false, full: true },
        { name: "mobile-panel", width: 390, height: 3200, mobile: true, full: true },
      ]
    : []),
];
for (const vp of vps) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`${vp.name}: ${e.message}`));
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("infinibot.reduceMotion", "1");
    } catch {}
  });
  await page.goto(`${base}/content-pages?token=${encodeURIComponent(info.token)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const click = async (js, timeout = 60000) => {
    const h = await page.waitForFunction(
      `(() => { const el = (${walkFn})(${js}); if (el) el.click(); return Boolean(el); })()`,
      { timeout },
    );
    await h.dispose();
  };
  await click(`(el) => el.tagName === "BUTTON" && el.textContent?.trim() === "Channels"`).catch(() => {});
  await click(`(el) => el.matches?.("button.card") && el.textContent?.includes("Brand Reels")`);
  await click(`(el) => el.matches?.("button.detail-tab") && el.textContent?.trim() === "Posting"`, 30000);
  await page.waitForSelector("pierce/.posting", { timeout: 30000 }).catch(() => {});
  await page.waitForSelector("pierce/[data-learn-id=content-posting-binding] .plat", { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2200));
  await page.evaluate(`(() => { const el = (${walkFn})((e) => e.getAttribute?.("data-learn-id") === "content-posting-binding"); el?.scrollIntoView({ block: "start" }); })()`);
  await new Promise((r) => setTimeout(r, 500));
  const file = path.join(OUT, `${label}-${vp.name}.png`);
  if (vp.full) {
    const el = await page.$("pierce/content-posting-panel");
    if (el) await el.screenshot({ path: file });
    else await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file });
  }
  shots.push(file);
  await page.close();
}
await browser.close();
console.log(JSON.stringify({ shots, errors }));
