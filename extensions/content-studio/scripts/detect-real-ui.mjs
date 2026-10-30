#!/usr/bin/env node
// Drives the Posting tab like the owner, on a detect-e2e side gateway
// (run detect-e2e.mjs with REAL_ADB=1 KEEP=1 first): pick the phone in the
// dropdown (must NOT start anything), then press Detect accounts (Instagram)
// and screenshot progress + the result. Read-only on the phone.
// usage: SHOTS=/tmp/droid-detect-shots node detect-real-ui.mjs <deviceLabel> [desktop|mobile]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const REPO = process.env.REPO || path.resolve(import.meta.dirname, "../../..");
const require = createRequire(path.join(REPO, "package.json"));
const puppeteer = require("puppeteer");
const DIR = process.env.DET_E2E_DIR || "/tmp/droid-detect-e2e";
const OUT = process.env.SHOTS || "/tmp/droid-detect-shots";
const label = process.argv[2] || "true S1";
const vpName = process.argv[3] || "desktop";
const info = JSON.parse(fs.readFileSync(path.join(DIR, "info.json"), "utf8"));
const base = `http://127.0.0.1:${info.port}`;
fs.mkdirSync(OUT, { recursive: true });
const walkFn = `(pred) => { const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (pred(el)) return el; if (el.shadowRoot) { const h = walk(el.shadowRoot); if (h) return h; } } return null; }; return walk(document); }`;
// The RPC client reads config and STORES/CLEARS device tokens under HOME / the
// state dir: point it at the throwaway dir BEFORE importing it, never the
// owner's ~/.infinibot.
process.env.HOME = path.join(DIR, "home");
process.env.INFINIBOT_STATE_DIR = path.join(DIR, "state");
process.env.INFINIBOT_CONFIG_PATH = path.join(DIR, "state/infinibot.json");
delete process.env.INFINIBOT_GATEWAY_TOKEN;
delete process.env.INFINIBOT_GATEWAY_URL;
const { callGateway } = await import(path.join(REPO, "dist/gateway/call.js"));
const rpc = (method, params = {}, timeoutMs = 30_000) =>
  callGateway({ method, params, timeoutMs, url: `ws://127.0.0.1:${info.port}`, token: info.token });

const vp = vpName === "mobile" ? { width: 390, height: 844, mobile: true } : { width: 1440, height: 1000, mobile: false };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--use-gl=swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile });
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem("infinibot.reduceMotion", "1");
  } catch {}
});
await page.goto(`${base}/content-pages?token=${encodeURIComponent(info.token)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
const click = async (js, timeout = 60000) => {
  const h = await page.waitForFunction(`(() => { const el = (${walkFn})(${js}); if (el) el.click(); return Boolean(el); })()`, { timeout });
  await h.dispose();
};
const scrollToBinding = () =>
  page.evaluate(`(() => { const el = (${walkFn})((e) => e.getAttribute?.("data-learn-id") === "content-posting-binding"); el?.scrollIntoView({ block: "start" }); })()`);
const shot = async (name) => {
  await scrollToBinding();
  await new Promise((r) => setTimeout(r, 400));
  const file = path.join(OUT, `real-${name}-${vpName}.png`);
  await page.screenshot({ path: file });
  return file;
};
await click(`(el) => el.tagName === "BUTTON" && el.textContent?.trim() === "Channels"`).catch(() => {});
await click(`(el) => el.matches?.("button.card") && el.textContent?.includes("Brand Reels")`);
await click(`(el) => el.matches?.("button.detail-tab") && el.textContent?.trim() === "Posting"`, 30000);
await page.waitForSelector("pierce/[data-learn-id=content-posting-binding] select", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const result = { shots: [], errors };
// 1. Pick the phone in the dropdown — must start nothing.
const devs = (await rpc("content-studio.posting.devices", { refresh: true })).devices;
const dev = devs.find((d) => d.label === label);
if (!dev) throw new Error(`no device labelled ${label}: ${devs.map((d) => d.label).join(", ")}`);
result.online = dev.online;
result.summary = dev.presence?.summary;
const sel = await page.$("pierce/[data-learn-id=content-posting-binding] label.fld select");
await sel.select(dev.id);
await new Promise((r) => setTimeout(r, 3000));
const after = (await rpc("content-studio.posting.devices")).devices.find((d) => d.id === dev.id);
result.detectingAfterSelect = after.detecting ?? null;
result.shots.push(await shot("selected"));
// 2. Detect accounts (Instagram) — the only trigger.
await click(`(el) => el.tagName === "BUTTON" && el.textContent?.trim() === "Detect accounts" && el.closest?.(".plat")?.querySelector(".plat-name")?.textContent === "Instagram"`, 10000);
await new Promise((r) => setTimeout(r, 4500));
result.shots.push(await shot("detecting"));
for (let i = 0; i < 90; i++) {
  const d = (await rpc("content-studio.posting.devices")).devices.find((x) => x.id === dev.id);
  if (!d.detecting) {
    result.detection = d.detected?.instagram ?? null;
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
await new Promise((r) => setTimeout(r, 2500));
result.shots.push(await shot("result"));
await browser.close();
console.log(JSON.stringify(result, null, 2));
