// Drive the Voice page's audio controls in a real (headless) Chrome with fake
// media devices, against the side gateway from voice-latency-e2e.sh:
//
//   speaker list → pick a speaker → volume → "Play test sound" (energy of the
//   tone is measured on the element that plays it, and its sinkId is checked)
//   → reload: the choice is remembered → a saved speaker that is gone falls
//   back to the default with a note → in-call panels (turn diagnostics, the
//   "no voice audio" fault) rendered from injected call state.
//
//   node extensions/robovoice/scripts/voice-audio-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../..");
const puppeteer = createRequire(join(REPO, "ui/package.json"))("puppeteer");
const BASE = process.env.BASE ?? "http://127.0.0.1:19071";
const TOKEN = process.env.TOKEN ?? "rv-lat-token";
const OUT = process.env.OUT ?? "/tmp/ibvf/shots";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { checks: [], errors: [], shots: [] };
let fails = 0;
const check = (name, ok, detail = {}) => {
  if (!ok) fails++;
  R.checks.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

const C = `document.querySelector("voice-robovoice-console")`;
const S = `${C}.shadowRoot.querySelector("voice-session-view")`;
const deepAll = `(function deepAll(root, sel, out=[]){ out.push(...(root.querySelectorAll?.(sel) ?? [])); for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) if (el.shadowRoot) deepAll(el.shadowRoot, sel, out); return out; })`;
const HIDE = `for (const el of ${deepAll}(document, 'proactive-overlay-host, infinibot-proactive-overlays, learn-missions-panel, first-run-popover, .toast, .toasts')) el.style.setProperty('display','none','important');`;
const q = (sel) => `${S}.shadowRoot.querySelector(${JSON.stringify(sel)})`;

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.CHROME_PATH ?? process.env.CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function open(vp, storage = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1, isMobile: vp.w < 500, hasTouch: vp.w < 500 });
  page.on("pageerror", (e) => R.errors.push(String(e.message).slice(0, 200)));
  await page.evaluateOnNewDocument((seed) => {
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    window.open = () => null;
    // Record where audio is routed and measure the test tone on the element that plays it.
    window.__sink = [];
    const setSink = HTMLMediaElement.prototype.setSinkId;
    HTMLMediaElement.prototype.setSinkId = function (id) {
      window.__sink.push({ id, tone: this.dataset.voiceTestTone === "1" });
      return setSink.call(this, id);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.dataset.voiceTestTone === "1" && this.srcObject) {
        const el = this;
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        ctx.createMediaStreamSource(el.srcObject).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tone = (window.__tone = { peak: 0, rmsMax: 0, samples: 0, sinkId: null, volume: el.volume });
        const t = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) {
            sum += v * v;
            if (Math.abs(v) > tone.peak) tone.peak = Math.abs(v);
          }
          tone.rmsMax = Math.max(tone.rmsMax, Math.sqrt(sum / buf.length));
          tone.samples++;
          tone.sinkId = el.sinkId;
          if (!el.isConnected) {
            clearInterval(t);
            void ctx.close();
          }
        }, 40);
      }
      return play.call(this);
    };
  }, storage);
  await page.goto(`${BASE}/voice?token=${TOKEN}`, { waitUntil: "load" });
  await page.waitForFunction(`!!${C}?.shadowRoot?.querySelector("voice-session-view")?.shadowRoot?.querySelector('[data-testid="voice-output-module"]')`, { timeout: 90000, polling: 500 });
  // Labels and ids need microphone permission (granted by the fake-ui flag).
  await page.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await sleep(1200);
  return page;
}

async function shot(page, name, scrollSel) {
  await page.evaluate(HIDE).catch(() => {});
  if (scrollSel) await page.evaluate(`${q(scrollSel)}?.scrollIntoView({ block: "center" })`);
  await sleep(500);
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p });
  R.shots.push(p);
  return p;
}
const options = (page) => page.evaluate(`[...${q('[data-testid="voice-output-select"]')}.options].map((o) => ({ value: o.value, label: o.textContent.trim() }))`);
const pick = (page, testid, value) =>
  page.evaluate(`(() => { const el = ${q(`[data-testid="${testid}"]`)}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()`);
const ls = (page, k) => page.evaluate((key) => localStorage.getItem(key), k);
const text = (page, sel) => page.evaluate(`${q(sel)}?.textContent?.replace(/\\s+/g, " ").trim() ?? null`);

const DESK = { w: 1440, h: 900 };
const PHONE = { w: 390, h: 844 };

try {
  // 1 ── device list + selection + volume + test tone
  let page = await open(DESK);
  const opts = await options(page);
  check("speaker list has the system default plus labelled devices", opts.length >= 2 && opts[0].value === "" && opts.slice(1).every((o) => o.label), { options: opts.map((o) => o.label) });
  const mics = await page.evaluate(`[...${q('[data-testid="voice-mic-select"]')}.options].map((o) => o.textContent.trim())`);
  check("microphone list is labelled", mics.length >= 1 && mics.every(Boolean), { mics });
  await shot(page, "01-output-default-desk", '[data-testid="voice-output-module"]');

  const chosen = opts[opts.length - 1];
  await pick(page, "voice-output-select", chosen.value);
  await pick(page, "voice-output-volume", "60");
  await sleep(300);
  check("choice is saved in this browser", (await ls(page, "infinibot.voice.outputDeviceId")) === chosen.value && (await ls(page, "infinibot.voice.outputVolume")) === "0.6", {
    device: chosen.label,
    volume: await ls(page, "infinibot.voice.outputVolume"),
  });

  await page.evaluate(`${q('[data-testid="voice-output-test"]')}.click()`);
  await sleep(500);
  await shot(page, "02-test-sound-playing-desk", '[data-testid="voice-output-module"]');
  await page.waitForFunction(`/did you hear/i.test(${q('[data-testid="voice-output-test"]')}.textContent)`, { timeout: 8000, polling: 100 }).catch(() => {});
  const tone = await page.evaluate(() => window.__tone ?? null);
  const btn = await text(page, '[data-testid="voice-output-test"]');
  check("test sound really produced audio (non-silent) at the chosen volume", !!tone && tone.peak > 0.05 && tone.rmsMax > 0.02 && Math.abs(tone.volume - 0.6) < 0.01, { tone, button: btn });
  check("test sound was routed to the chosen speaker (setSinkId)", !!tone && tone.sinkId === chosen.value, { sinkId: tone?.sinkId?.slice(0, 12), chosen: chosen.value.slice(0, 12) });
  await shot(page, "03-test-sound-played-desk", '[data-testid="voice-output-module"]');
  const logs = await page.evaluate(`[...${S}.shadowRoot.querySelectorAll(".log-entry .log-text")].map((e) => e.textContent.trim())`);
  check("System log says where the test sound played", logs.some((l) => l.startsWith("Test sound played on")), { log: logs.filter((l) => /Test sound|Speaker|Found/.test(l)) });
  await page.close();

  // 2 ── remembered after reload
  page = await open(DESK);
  const remembered = await page.evaluate(`({ speaker: ${q('[data-testid="voice-output-select"]')}.value, volume: ${q('[data-testid="voice-output-volume"]')}.value })`);
  check("speaker and volume are remembered after a reload", remembered.speaker === chosen.value && remembered.volume === "60", remembered);
  await page.close();

  // 3 ── saved speaker is gone → default + a visible note; test sound still plays
  page = await open(DESK, { "infinibot.voice.outputDeviceId": "unplugged-headset-id", "infinibot.voice.outputVolume": "0.8" });
  const missing = await text(page, '[data-testid="voice-output-missing"]');
  const selNow = await page.evaluate(`${q('[data-testid="voice-output-select"]')}.value`);
  check("a saved speaker that is gone falls back to the system default with a note", /not connected/i.test(missing ?? "") && selNow === "", { note: missing, select: selNow || "System default" });
  await page.evaluate(`${q('[data-testid="voice-output-test"]')}.click()`);
  await page.waitForFunction(`/did you hear/i.test(${q('[data-testid="voice-output-test"]')}.textContent)`, { timeout: 8000, polling: 100 }).catch(() => {});
  const tone2 = await page.evaluate(() => window.__tone ?? null);
  check("test sound still plays on the default after the fallback", !!tone2 && tone2.peak > 0.05, { peak: tone2?.peak, sinkId: tone2?.sinkId });
  check("the saved choice is kept for when the speaker comes back", (await ls(page, "infinibot.voice.outputDeviceId")) === "unplugged-headset-id");
  await shot(page, "04-speaker-missing-desk", '[data-testid="voice-output-module"]');
  await page.close();

  // 4 ── in-call panels from injected call state (no real call: diagnostics + the silent-reply fault)
  const callState = (over) => ({
    phase: "active", agentId: "main", room: "robopark-demo", mode: "cloud", startedAt: new Date(Date.now() - 42000).toISOString(), desktopName: null,
    media: "connected", mediaError: null, live: true, participants: 2,
    transcript: [
      { id: "1", who: "you", text: "Hey, how are you doing today?", final: true, at: Date.now() - 9000 },
      { id: "2", who: "agent", text: "I'm doing well, thanks. How can I help you today?", final: true, at: Date.now() - 7000 },
    ],
    latency: [{ at: Date.now() - 7000, totalMs: 1840, sttToLlmMs: 910, llmToTtsMs: 420 }],
    creditsCharged: 3, billableSeconds: 40, error: null, agentState: "listening", tool: null, language: null,
    playback: "playing", audioIn: true, output: { deviceId: "", routed: "applied" }, silentReplies: 0, ttsFault: null, ...over,
  });
  const turns = [{ at: new Date().toISOString(), agentId: "main", backend: "gateway", trust: "caller", ok: true, firstTokenMs: 812, totalMs: 1004, path: "fast", model: "ollama-cloud/gpt-oss:120b", prepMs: 1, firstSentenceMs: 961, call: "robopark-demo" }];
  for (const [vn, vp] of Object.entries({ desk: DESK, m390: PHONE })) {
    page = await open(vp);
    const inject = async (state, t) => {
      await page.evaluate(`(() => { const v = ${S}; v.pipeline = { stt: { provider: "groq", model: "whisper-large-v3-turbo" }, llm: { provider: "infinibot", model: "infinibot:main" }, tts: { provider: "elevenlabs", model: "George" } }; v.pipelineLoaded = true; v.turns = ${JSON.stringify(t)}; v.call = ${JSON.stringify(state)}; })()`);
      await sleep(600);
    };
    await inject(callState({}), turns);
    const diag = {
      total: await text(page, '[data-testid="voice-diag-total"]'),
      path: await text(page, '[data-testid="voice-diag-path"]'),
      firstToken: await text(page, '[data-testid="voice-diag-first-token"]'),
      audioIn: await text(page, '[data-testid="voice-audio-in"]'),
      playback: await text(page, '[data-testid="voice-playback"]'),
    };
    check(`[${vn}] turn diagnostics show the timing breakdown and the path`, diag.total === "1840 ms" && diag.path === "FAST" && diag.firstToken === "812 ms" && diag.audioIn === "RECEIVING" && diag.playback === "PLAYING", diag);
    if (vn === "desk") await shot(page, `05-diagnostics-${vn}`, '[data-testid="voice-diagnostics"]');

    await inject(callState({ audioIn: false, playback: null, silentReplies: 1, ttsFault: { at: Date.now(), text: "I'm doing well, thanks.", fallback: true } }), turns);
    const fault = await text(page, '[data-testid="voice-session-tts-fault"]');
    const box = await page.evaluate(`(() => { const r = ${q('[data-testid="voice-session-tts-fault"]')}?.getBoundingClientRect(); return r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: innerWidth } : null; })()`);
    check(`[${vn}] a reply with no voice audio shows a visible fault naming the speech step`, /No voice audio from Robovoice/i.test(fault ?? "") && /ElevenLabs/i.test(fault ?? "") && /fallback voice/i.test(fault ?? "") && !!box && box.left >= 0 && box.right <= box.width, { fault, box });
    await shot(page, `06-tts-fault-${vn}`);
    if (vn === "desk") {
      const silent = { audioIn: await text(page, '[data-testid="voice-audio-in"]'), silent: await text(page, '[data-testid="voice-diag-silent"]') };
      check("[desk] System panel: agent audio NONE — TEXT ONLY, silent replies counted", silent.audioIn === "NONE — TEXT ONLY" && silent.silent === "1", silent);
      await shot(page, `07-tts-fault-panel-${vn}`, '[data-testid="voice-output-module"]');
    }
    await page.close();
  }
} catch (err) {
  fails++;
  R.errors.push(String(err?.stack ?? err).slice(0, 600));
  console.error(err);
} finally {
  await browser.close();
}
R.fails = fails;
writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 1));
console.log(`SUMMARY fails=${fails} pageErrors=${R.errors.length} shots=${R.shots.length} → ${OUT}`);
process.exit(fails ? 1 : 0);
