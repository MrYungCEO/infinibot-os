/**
 * Screenshot the workspace loader in every phase against mock-fleet.mjs, at
 * 1440 and 390 wide, and record a cold first load.
 *
 *   node ui/src/ui/cloud/verify/shoot-loader.mjs [outDir] [origin]
 *
 * Each shot also records what the loader says (phase, tone, headline, steps),
 * any element that overflows the viewport, and page errors. ONLY=cold limits
 * the scenarios; WIDTHS=390 limits the widths; NO_VIDEO=1 skips the recording.
 */
import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [out = path.join(here, "shots"), origin = "http://127.0.0.1:4810"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const WIDTHS = (process.env.WIDTHS ?? "1440,390").split(",").map(Number);
const only = process.env.ONLY?.split(",");
const want = (name) => !only || only.includes(name);

/** Runs in the page before any script: a signed-in Clerk stub and a skewable clock. */
function boot(token, opts) {
  const realNow = Date.now.bind(Date);
  window.__skew = 0;
  Date.now = () => realNow() + window.__skew;
  try {
    if (opts.known) localStorage.setItem("infinibot.cloud.workspace-known:user_stub", "1");
  } catch {}
  if (opts.reducedMotion) window.__reduced = true;
  window.Clerk = {
    loaded: true,
    load: () => new Promise((r) => setTimeout(r, opts.clerkMs ?? 0)),
    user: { id: "user_stub", fullName: "Mock Member", firstName: "Mock", primaryEmailAddress: { emailAddress: "member@example.com" } },
    session: { id: "sess_stub", getToken: async () => token },
    addListener: () => () => {}, redirectToSignIn: async () => {}, signOut: async () => {},
  };
}

const browser = await puppeteer.launch({ executablePath: "/opt/google/chrome/chrome", headless: "new", args: ["--no-sandbox"] });
const report = { shots: [], problems: [], video: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nonce = 0;

async function open(scenario, width, opts = {}) {
  // A fresh profile per run: "this browser has seen a ready workspace" is in localStorage.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const mobile = width < 600;
  await page.setViewport({ width, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  if (opts.reducedMotion) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.__errs = errs;
  await page.evaluateOnNewDocument(boot, `${scenario}.${Date.now()}-${nonce++}`, opts);
  if (opts.blockResolve) {
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("/fleet/resolve") ? r.abort("connectionrefused") : r.continue()));
  }
  await page.goto(`${origin}/app/`, { waitUntil: "domcontentloaded" });
  return page;
}

const read = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".wl[data-workspace-loader]");
    if (!el) return { variant: "hidden" };
    const vw = document.documentElement.clientWidth;
    const overflow = [...el.querySelectorAll("*")]
      .filter((n) => !n.closest(".sob-ground, .wl-trace"))
      .filter((n) => { const b = n.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.left < -1); })
      .map((n) => String(n.className).slice(0, 40));
    return {
      variant: el.dataset.workspaceLoader,
      phase: el.dataset.phase,
      tone: el.dataset.tone,
      eyebrow: el.querySelector(".wl-eyebrow")?.textContent.trim(),
      headline: (el.querySelector(".wl-headline") ?? el.querySelector(".wl-compact__text"))?.textContent.trim(),
      explanation: el.querySelector(".wl-sub")?.textContent.trim(),
      steps: [...el.querySelectorAll(".wl-step")].map((s) => `${s.className.replace("wl-step wl-step--", "")}: ${s.querySelector(".wl-step__label").textContent.trim()}`),
      meta: el.querySelector(".wl-meta")?.textContent.replace(/\s+/g, " ").trim(),
      slow: el.querySelector(".wl-slow__title")?.textContent.trim() ?? null,
      actions: [...el.querySelectorAll(".wl-btn")].map((b) => b.textContent.trim()),
      offline: !!el.querySelector(".wl-offline") ,
      announce: document.querySelector(".wl-sr")?.textContent.trim(),
      focus: document.activeElement?.className || document.activeElement?.tagName,
      appInert: document.querySelector("infinibot-app")?.hasAttribute("inert") ?? null,
      overflow: [...new Set(overflow)],
    };
  });

/** Wait until the loader matches, then shoot. `expect` keys are compared to read(). */
async function shoot(page, name, expect = {}, timeout = 30000, settle = 350) {
  const start = Date.now();
  let state;
  for (;;) {
    state = await read(page);
    if (Object.entries(expect).every(([k, v]) => state[k] === v)) break;
    if (Date.now() - start > timeout) {
      report.problems.push({ name, problem: "state never reached", expect, got: state });
      break;
    }
    await sleep(100);
  }
  await sleep(settle); // let the entry fade settle
  state = await read(page);
  const file = path.join(out, `${name}-${page.viewport().width}.png`);
  await page.screenshot({ path: file });
  const entry = { file, ...state, errors: page.__errs.splice(0) };
  report.shots.push(entry);
  if (state.overflow?.length || entry.errors.length) report.problems.push({ name, overflow: state.overflow, errors: entry.errors });
  return entry;
}

const skew = (page, ms) => page.evaluate((d) => { window.__skew += d; }, ms);
const full = { variant: "full" };

for (const width of WIDTHS) {
  if (want("signin")) {
    const page = await open("warm", width, { clerkMs: 4000 });
    await shoot(page, "01-signing-in", { ...full, phase: "signing-in" });
    await page.close();
  }
  if (want("cold")) {
    // First provision: 409s for 20 s, then the gateway boots and loads.
    const page = await open("cold", width);
    await shoot(page, "03-first-run-reserve", { ...full, phase: "provisioning" });
    await skew(page, 40_000);
    await sleep(400);
    await shoot(page, "04-first-run-storage", { ...full, phase: "provisioning" });
    await skew(page, 40_000);
    await sleep(400);
    await shoot(page, "05-first-run-boot", { ...full, phase: "provisioning" });
    await shoot(page, "06-starting", { ...full, phase: "starting" });
    await shoot(page, "07-loading", { ...full, phase: "loading" });
    await shoot(page, "08-ready", { ...full, phase: "ready" }, 15000, 60);
    await sleep(1500);
    const after = await shoot(page, "09-app", { variant: "hidden" }, 8000);
    after.known = await page.evaluate(() => localStorage.getItem("infinibot.cloud.workspace-known:user_stub"));
    await page.close();
  }
  if (want("wake")) {
    let page = await open("wake", width, { known: true });
    await shoot(page, "10-wake-409", { ...full, phase: "waking" });
    await page.close();
    page = await open("hold", width, { known: true });
    await shoot(page, "02-finding", { ...full, phase: "finding" }, 4000);
    await shoot(page, "11-wake-held-resolve", { ...full, phase: "waking" });
    await page.close();
  }
  if (want("slow")) {
    const page = await open("slow", width, { known: true });
    await skew(page, 21_000);
    await shoot(page, "12-returning-rebuild", { ...full, phase: "provisioning" });
    await skew(page, 185_000);
    const s = await shoot(page, "13-slow", { ...full, tone: "slow" });
    await page.evaluate(() => { document.querySelector(".wl-detail").open = true; });
    await shoot(page, "14-slow-detail", { ...full, tone: "slow" });
    // Keyboard: Tab reaches the summary, then Retry.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    s.keyboardReachesRetry = await page.evaluate(() => document.activeElement?.dataset?.action ?? null);
    await page.close();
  }
  if (want("upgrade")) {
    const page = await open("upgrade", width);
    const s = await shoot(page, "15-upgrade-402", { ...full, tone: "upgrade" });
    s.plansHref = await page.evaluate(() => document.querySelector("a.wl-btn")?.href);
    await page.close();
  }
  if (want("error")) {
    let page = await open("flaky", width);
    const s = await shoot(page, "16-error-500", { ...full, tone: "error" });
    // Keyboard Retry: the primary button has focus, Enter retries, the second call answers 200.
    await page.keyboard.press("Enter");
    const r = await shoot(page, "17-error-retried", { ...full, tone: "ok" }, 8000);
    s.retryWorked = r.tone === "ok";
    await page.close();
    page = await open("warm", width, { blockResolve: true });
    await shoot(page, "18-network-error", { ...full, tone: "error" });
    await page.setOfflineMode(true);
    await shoot(page, "19-offline", { ...full, offline: true });
    await page.close();
  }
  if (want("reconnect")) {
    const page = await open("warm", width, { known: true });
    await page.waitForFunction(() => document.querySelector("infinibot-app")?.connected === true, { timeout: 20000 });
    await sleep(4000);
    await shoot(page, "20-app-loaded", { variant: "hidden" });
    await fetch(`${origin}/__mock/drop?ms=14000`, { method: "POST" });
    await shoot(page, "21-reconnect-compact", { variant: "compact" }, 8000);
    await shoot(page, "22-reconnect-full", { ...full }, 16000);
    await shoot(page, "23-reconnected", { variant: "hidden" }, 40000);
    // The sleep flow's one call, then the resolve it runs.
    await page.evaluate(() => window.__INFINIBOT_WORKSPACE_LOADER__.show({ phase: "waking", reason: "sleep" }));
    await shoot(page, "24-sleep-wake-compact", { variant: "compact", phase: "waking" });
    await page.evaluate(() => window.__INFINIBOT_WORKSPACE_LOADER__.show({ phase: "waking", reason: "sleep", variant: "full" }));
    await shoot(page, "25-sleep-wake-full", { ...full, phase: "waking" });
    await page.evaluate(() => window.__INFINIBOT_WORKSPACE_LOADER__.hide());
    await page.close();
  }
  if (want("reduced")) {
    const page = await open("cold", width, { reducedMotion: true });
    const s = await shoot(page, "26-reduced-motion", { ...full, phase: "provisioning" });
    s.runningAnimations = await page.evaluate(() =>
      document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations === Infinity).length);
    await page.close();
  }
}

if (!process.env.NO_VIDEO && want("cold")) {
  const page = await open("cold", 1440);
  const file = path.join(out, "cold-first-load.webm");
  const rec = await page.screencast({ path: file });
  await page.waitForFunction(() => document.querySelector("infinibot-app")?.connected === true, { timeout: 60000 }).catch(() => {});
  await sleep(6000);
  await rec.stop();
  report.video = file;
  await page.close();
}

await browser.close();
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`${report.shots.length} shots, ${report.problems.length} problems -> ${out}`);
for (const p of report.problems) console.log("PROBLEM", JSON.stringify(p));
