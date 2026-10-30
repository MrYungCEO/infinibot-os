// Drive the Robovoice-only Voice page on the side gateway from voice-page-e2e.sh
// (mock Robovoice) and screenshot every state, desktop + 390px, dark + light.
//
//   node extensions/robovoice/scripts/voice-page-shots.mjs
//
// Flow: unlinked connect → Connect (device code shown) → mock approves → linked
// console → pipeline edit (Apply live) → voice agent model/voice/language →
// wallet empty (mock balance 0) → start a call → end → unlink (relink state).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
const puppeteer = createRequire(join(REPO, "ui/package.json"))("puppeteer");
const BASE = process.env.BASE ?? "http://127.0.0.1:19041";
const TOKEN = process.env.TOKEN ?? "rv-vpg-token";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:19042";
const DIR = process.env.RV_VPG_DIR ?? "/tmp/rv-voice-page";
const OUT = process.env.OUT ?? "/tmp/voice-robovoice-only-shots";
const NODE = process.env.NODE_BIN ?? `${process.env.HOME}/.nvm/versions/node/v22.23.1/bin/node`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { steps: [], errors: [], shots: [], rpcs: [] };
const log = (k, v) => {
  R.steps.push({ step: k, ...v });
  console.log(k, JSON.stringify(v));
};

function rpc(method, params = {}) {
  const out = execFileSync(NODE, [`${DIR}/rpc.mjs`, method, JSON.stringify(params)], {
    cwd: DIR,
    env: { HOME: `${DIR}/home`, PATH: `${dirname(NODE)}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return JSON.parse(out);
}
async function mock(path, body) {
  const res = await fetch(`${MOCK}${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  return res.json();
}
function theme(mode) {
  rpc("branding.set", { theme: { mode, paletteId: mode === "light" ? "porcelain" : "infinibot-gold" } });
}

// Everything the console shows lives in <voice-robovoice-console>'s shadow root.
const C = `document.querySelector("voice-robovoice-console")`;
const deepAll = `(function deepAll(root, sel, out=[]){ out.push(...(root.querySelectorAll?.(sel) ?? [])); for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); return out; })`;
const HIDE = `for (const el of ${deepAll}(document, 'proactive-overlay-host, infinibot-proactive-overlays, learn-missions-panel, first-run-popover, .toast, .toasts')) el.style.setProperty('display','none','important');`;

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const VPS = { desk: { w: 1440, h: 900 }, m390: { w: 390, h: 844 } };

async function open(vp) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, isMobile: vp.w < 500, hasTouch: vp.w < 500 });
  page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 200)));
  // The approval page would open in a new tab and background this one (rAF stops): record it instead.
  await page.evaluateOnNewDocument(() => {
    window.open = (url) => ((window.__opened = [...(window.__opened ?? []), String(url)]), null);
  });
  await page.goto(`${BASE}/voice?token=${TOKEN}`, { waitUntil: "load" });
  await page.waitForFunction(`!!${C}?.shadowRoot?.querySelector('[data-testid="voice-console"]')`, { timeout: 60000, polling: 500 });
  return page;
}
const phase = (page) => page.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-console"]').dataset.phase`);
async function waitPhase(page, want, ms = 90000) {
  await page.waitForFunction(`${C}?.shadowRoot?.querySelector('[data-testid="voice-console"]')?.dataset.phase === ${JSON.stringify(want)}`, { timeout: ms, polling: 500 });
}
async function shot(page, name) {
  await page.evaluate(HIDE).catch(() => {});
  await sleep(400);
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false });
  R.shots.push(p);
}
async function scrollTo(page, sel) {
  await page.evaluate(`${C}.shadowRoot.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:"start"})`);
  await sleep(300);
}
const click = (page, sel) => page.evaluate(`(() => { const b = ${C}.shadowRoot.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
const tab = (page, id) => click(page, `.tabs button[data-section="${id}"]`);
const text = (page, sel) => page.evaluate(`${C}.shadowRoot.querySelector(${JSON.stringify(sel)})?.textContent?.replace(/\\s+/g," ").trim() ?? null`);

async function bothViewports(name, prep, themes = ["dark"]) {
  for (const t of themes) {
    theme(t);
    for (const [vn, vp] of Object.entries(VPS)) {
      const page = await open(vp);
      await sleep(2500);
      if (prep) await prep(page, vn);
      await shot(page, `${name}-${vn}-${t}`);
      await page.close();
    }
  }
}

try {
  // 1 ── unlinked: the single Connect Robovoice state
  const st0 = rpc("robovoice.link.status", { remote: false });
  log("unlinked", { linked: st0.linked, signedIn: st0.signedIn });
  await bothViewports("01-connect", async (page) => {
    await waitPhase(page, "unlinked");
    log("connect-phase", { phase: await phase(page), hasConnect: !!(await text(page, '[data-testid="voice-connect-btn"]')) });
  }, ["dark", "light"]);
  theme("dark");

  // 2 ── link via code
  let page = await open(VPS.desk);
  await waitPhase(page, "unlinked");
  await click(page, '[data-testid="voice-connect-btn"]');
  await waitPhase(page, "linking", 30000);
  const code = await text(page, '[data-testid="voice-link-code"]');
  log("linking", { code, windowOpen: await page.evaluate(() => window.__opened ?? []), openHref: await page.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-link-open"]')?.href`) });
  await shot(page, "02-linking-code-desk-dark");
  const m = await open(VPS.m390);
  await sleep(2000);
  await shot(m, "02-linking-code-m390-dark");
  await m.close();
  await waitPhase(page, "linked", 120000);
  await sleep(4000);
  log("linked", { org: await text(page, '[data-testid="voice-org"]'), location: await text(page, '[data-testid="voice-location"]'), wallet: await text(page, '[data-testid="voice-wallet"]') });
  await page.close();

  // 3 ── linked console (Call section)
  await bothViewports("03-linked-console", null, ["dark", "light"]);
  theme("dark");

  // 4 ── edit the location pipeline (STT provider → Groq, Apply live)
  page = await open(VPS.desk);
  await waitPhase(page, "linked");
  await tab(page, "pipeline");
  await page.waitForFunction(`!!${C}.shadowRoot.querySelector("rv-pipeline-editor")?.shadowRoot?.querySelector('select[aria-label="Speech-to-Text provider"]')`, { timeout: 60000, polling: 500 });
  const edited = await page.evaluate(`(() => {
    const ed = ${C}.shadowRoot.querySelector("rv-pipeline-editor").shadowRoot;
    const sel = ed.querySelector('select[aria-label="Speech-to-Text provider"]');
    sel.value = "groq"; sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  await sleep(600);
  await page.evaluate(`${C}.shadowRoot.querySelector("rv-pipeline-editor").shadowRoot.querySelector("#rv-apply")?.click()`);
  await sleep(4000);
  const cfg = rpc("robovoice.pipeline.config.get");
  const ms = await mock("/__mock/state");
  log("pipeline", { edited, effectiveStt: cfg.effective?.location?.stt, mockLocationDefaults: Object.values(ms.locationConfigs ?? {})[0]?.defaults });
  await shot(page, "04-pipeline-edited-desk-dark");
  await page.close();
  await bothViewports("04-pipeline", async (p) => { await tab(p, "pipeline"); await sleep(3500); }, ["light"]);
  theme("dark");

  // 5 ── voice agent: main → Claude Code CLI backend, Puck voice, Hebrew; coder on
  page = await open(VPS.desk);
  await waitPhase(page, "linked");
  await tab(page, "agents");
  await page.waitForFunction(`${C}.shadowRoot.querySelectorAll("robovoice-agent-voice").length >= 2`, { timeout: 30000, polling: 500 });
  const setSel = (agent, label, value) =>
    page.evaluate(`(() => {
      const row = [...${C}.shadowRoot.querySelectorAll("robovoice-agent-voice")].find((e) => e.getAttribute("agent-id") === ${JSON.stringify(agent)});
      const s = row.shadowRoot.querySelector('select[aria-label="${label} for ${agent}"]');
      if (!s) return null; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); return s.value;
    })()`);
  const r1 = await setSel("main", "LLM backend", "claude-code");
  await sleep(2500);
  const r2 = await setSel("main", "Voice", "am_puck");
  await sleep(2500);
  const r3 = await setSel("main", "Language", "he");
  await sleep(2500);
  await page.evaluate(`(() => { const row = [...${C}.shadowRoot.querySelectorAll("robovoice-agent-voice")].find((e) => e.getAttribute("agent-id") === "coder"); const cb = row.shadowRoot.querySelector('input[type="checkbox"]'); if (!cb.checked) cb.click(); })()`);
  await sleep(4000);
  const va = rpc("robovoice.voiceAgents.list");
  const main = va.agents.find((a) => a.id === "main");
  const coder = va.agents.find((a) => a.id === "coder");
  const ms2 = await mock("/__mock/state");
  log("voice-agent", { set: [r1, r2, r3], main: { llmBackend: main.llmBackend, voice: main.voice, language: main.language, characterId: main.characterId }, coder: { voiceAgent: coder.voiceAgent, characterId: coder.characterId }, mockCharacterPipeline: ms2.characterPipeline?.[main.characterId] });
  await shot(page, "05-voice-agents-desk-dark");
  await page.close();
  await bothViewports("05-voice-agents", async (p) => { await tab(p, "agents"); await sleep(2500); }, ["light"]);
  await bothViewports("05b-characters", async (p) => { await tab(p, "characters"); await sleep(2000); }, ["dark"]);
  await bothViewports("05c-voice-llm", async (p) => { await tab(p, "llm"); await sleep(2000); }, ["dark"]);
  await bothViewports("05d-account", async (p) => { await tab(p, "account"); await sleep(1500); }, ["dark"]);

  // 6 ── wallet empty (mock balance 0): warning + Start call blocked
  await mock("/__mock/wallet", { credits: 0 });
  await bothViewports("06-wallet-empty", async (p, vn) => {
    await waitPhase(p, "linked");
    await sleep(1500);
    if (vn === "desk") {
      log("wallet-empty", {
        wallet: await p.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-wallet"]').dataset.wallet`),
        banner: await text(p, '[data-testid="voice-wallet-empty"]'),
        topUp: await p.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-topup"]')?.href`),
        startDisabled: await p.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-call-start"]')?.disabled`),
      });
    }
  }, ["dark", "light"]);
  theme("dark");
  await mock("/__mock/wallet", { credits: 2450 });

  // 7 ── start a (mock) call
  page = await open(VPS.desk);
  await waitPhase(page, "linked");
  await sleep(2500);
  await page.evaluate(`(() => { const s = ${C}.shadowRoot.querySelector('[data-testid="voice-call-agent"]'); if (s) { s.value = "main"; s.dispatchEvent(new Event("change")); } })()`);
  const started = await click(page, '[data-testid="voice-call-start"]');
  await page.waitForFunction(`${C}.shadowRoot.querySelector('[data-testid="voice-call"]')?.dataset.callPhase === "active"`, { timeout: 45000, polling: 500 }).catch(() => {});
  await sleep(4500);
  log("call", {
    started,
    phase: await page.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-call"]')?.dataset.callPhase`),
    label: await text(page, '[data-testid="voice-call-phase"]'),
    media: await text(page, '[data-testid="voice-call-media-error"]'),
    mockCalls: (await mock("/__mock/state")).links?.length,
    status: (() => { try { return rpc("robovoice.call.status", { room: "robopark-" + rpc("robovoice.link.status", { remote: false }).device.id }); } catch (e) { return String(e.message).slice(0, 120); } })(),
  });
  await shot(page, "07-call-active-desk-dark");
  // topbar pill + return pill while on another page
  await page.evaluate(() => (window.history.pushState({}, "", "/agents"), window.dispatchEvent(new PopStateEvent("popstate"))));
  await sleep(2500);
  log("call-elsewhere", { returnPill: await page.evaluate(`!!${deepAll}(document, '[data-testid="rv-call-return"]').length`) });
  await page.screenshot({ path: `${OUT}/07b-call-return-pill-desk-dark.png` });
  R.shots.push(`${OUT}/07b-call-return-pill-desk-dark.png`);
  await page.close();
  // A second tab opens while the first holds the call: it shows Ready — shoot the 390 call view in a fresh call.
  const m2 = await open(VPS.m390);
  await waitPhase(m2, "linked");
  await sleep(2000);
  await click(m2, '[data-testid="voice-call-start"]');
  await m2.waitForFunction(`${C}.shadowRoot.querySelector('[data-testid="voice-call"]')?.dataset.callPhase === "active"`, { timeout: 45000, polling: 500 }).catch(() => {});
  await sleep(3500);
  await shot(m2, "07-call-active-m390-dark");
  theme("light");
  await m2.reload({ waitUntil: "load" });
  await m2.waitForFunction(`!!${C}?.shadowRoot?.querySelector('[data-testid="voice-console"]')`, { timeout: 60000 });
  await sleep(2500);
  await click(m2, '[data-testid="voice-call-start"]');
  await sleep(6000);
  await shot(m2, "07-call-active-m390-light");
  await click(m2, '[data-testid="voice-call-end"]');
  await sleep(2500);
  log("call-end", { phase: await m2.evaluate(`${C}.shadowRoot.querySelector('[data-testid="voice-call"]')?.dataset.callPhase`), endRequests: (await mock("/__mock/state")) ? "ok" : "" });
  await shot(m2, "07c-call-ended-m390-light");
  await m2.close();
  page = await open(VPS.desk);
  await waitPhase(page, "linked");
  await sleep(2000);
  await click(page, '[data-testid="voice-call-start"]');
  await sleep(6000);
  await shot(page, "07-call-active-desk-light");
  await click(page, '[data-testid="voice-call-end"]');
  await sleep(2000);
  await page.close();
  theme("dark");

  // 8 ── Setup › Voice points at the Voice page
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/setup?token=${TOKEN}`, { waitUntil: "load" });
  await sleep(5000);
  await page.evaluate(`(() => { const n = ${deepAll}(document, '[data-ib-target="section:setup/voice"]')[0]; n?.click(); })()`);
  await sleep(2500);
  log("setup-voice", { card: await page.evaluate(`!!${deepAll}(document, '[data-testid="setup-voice-robovoice"]').length`), wizard: await page.evaluate(`${deepAll}(document, 'voice-setup-wizard').length`) });
  await page.evaluate(HIDE).catch(() => {});
  await page.screenshot({ path: `${OUT}/08-setup-voice-desk-dark.png` });
  R.shots.push(`${OUT}/08-setup-voice-desk-dark.png`);
  await page.close();

  // 9 ── unlink → relink state
  page = await open(VPS.desk);
  await waitPhase(page, "linked");
  page.on("dialog", (d) => d.accept());
  await tab(page, "account");
  await sleep(500);
  await click(page, '[data-testid="voice-unlink"]');
  await waitPhase(page, "unlinked", 30000).catch(() => {});
  await sleep(1500);
  log("unlinked-again", { phase: await phase(page), btn: await text(page, '[data-testid="voice-connect-btn"]') });
  await shot(page, "09-relink-desk-dark");
  await page.close();
} catch (e) {
  R.errors.push(`FATAL ${e.stack ?? e}`);
  console.error(e);
} finally {
  await browser.close();
  writeFileSync(`${OUT}/side-gateway-report.json`, JSON.stringify(R, null, 1));
}
console.log(`shots: ${R.shots.length}, page errors: ${R.errors.length}`);
