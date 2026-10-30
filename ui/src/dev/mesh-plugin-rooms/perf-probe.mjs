// Perf probe: ticker FPS + engine drawMs (window.__hudPerf) for three scenes on
// the harness — no plugin rooms, 12 rooms idle, 12 rooms + 30 agents — so the
// district's cost can be separated from the headless/swiftshader baseline.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const puppeteer = createRequire(`${process.env.INFINIBOT_WORKTREE || "/tmp/ib-mesh-plugin-rooms"}/ui/package.json`)("puppeteer");
const BASE = process.env.HARNESS_BASE || "http://127.0.0.1:5199/mesh-plugin-rooms-harness.html";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: "new", executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"] });
async function scene(name, query, agents) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await page.goto(BASE + query, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__fake && !!window.__fake.engine(), { timeout: 30000 });
  await sleep(1500);
  await page.evaluate(() => { const viz = window.__fake.viz(); viz.cameraDirector?.setEnabled?.(false); const e = window.__fake.engine(); e.cinematicCam?.stopAuto?.(); e.cinematicCam?.exitDroneMode?.(); e.zoomToFit?.(); });
  if (agents) {
    await page.evaluate(() => {
      const f = window.__fake;
      const plugins = ["infinitrade", "solatrix", "omniclinic", "robovoice", "flypic", "discipline", "content-studio", "products", "canvas-library", "business-agency", "infinicode", "whiteboard"];
      const tools = { infinitrade: "infinitrade_market", solatrix: "solana_market", omniclinic: "omniclinic_research", robovoice: "gateway:robovoice.status", flypic: "flypic_generate_image", discipline: "focus", "content-studio": "content_intel", products: "gateway:products.list", "canvas-library": "canvas_library", "business-agency": "lead_generation", infinicode: "gateway:infinicode.fleet.list", whiteboard: "excalidraw_create_element" };
      for (let i = 0; i < 30; i++) {
        const pid = plugins[i % plugins.length];
        f.spawn(i, i < 24 ? `${pid} worker ${i}` : `core task ${i}`, ["claude-code", "codex", "opencode", undefined][i % 4], "main", { currentTask: i < 24 ? `Working in ${pid}` : "refactor gateway websocket handler" });
        const t = i < 24 ? tools[pid] : ["bash", "read", "edit", "web_fetch"][i % 4];
        f.tool(i, t.startsWith("gateway:") ? "gateway" : t, t.startsWith("gateway:") ? t : undefined);
      }
    });
    await sleep(14000);
  } else {
    await sleep(3000);
  }
  // Measure real frame cadence with rAF timestamps (independent of the Pixi ticker).
  const raf = await page.evaluate(() => new Promise((res) => { const ts = []; const step = (t) => { ts.push(t); if (ts.length < 40) requestAnimationFrame(step); else res(ts); }; requestAnimationFrame(step); }));
  const deltas = raf.slice(1).map((t, i) => t - raf[i]);
  const frameMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const samples = [];
  for (let i = 0; i < 15; i++) { samples.push(await page.evaluate(() => ({ drawMs: window.__hudPerf?.drawMs ?? null, fps: window.__fake.engine().app?.ticker?.FPS ?? null }))); await sleep(120); }
  const ms = samples.map((s) => s.drawMs).filter((v) => typeof v === "number"), fps = samples.map((s) => s.fps).filter((v) => typeof v === "number");
  const rooms = await page.evaluate(() => window.__fake.rooms().length);
  const planned = await page.evaluate(() => Object.keys(window.__fake.plan()).length);
  const out = { scene: name, rooms, agents: planned, frameMsAvg: +frameMs.toFixed(1), fpsFromRaf: +(1000 / frameMs).toFixed(1), tickerFpsAvg: +(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1), drawMsAvg: +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2), drawMsMax: +Math.max(...ms).toFixed(2) };
  console.log(JSON.stringify(out));
  await page.close();
  return out;
}
const results = [];
results.push(await scene("no-rooms", "?plugins=none", false));
results.push(await scene("12-rooms-idle", "?plugins=all", false));
results.push(await scene("no-rooms-30-agents", "?plugins=none", true));
results.push(await scene("12-rooms-30-agents", "?plugins=all", true));
writeFileSync("/tmp/mesh-plugin-rooms/shots/report-perf.json", JSON.stringify(results, null, 2));
await browser.close();
console.log("DONE perf");
