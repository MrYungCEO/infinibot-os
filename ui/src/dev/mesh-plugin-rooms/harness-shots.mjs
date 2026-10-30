// Screenshot driver for the mesh-plugin-rooms harness (vite dev on :5199).
import { createRequire } from "node:module";
const puppeteer = createRequire(`${process.env.INFINIBOT_WORKTREE || "/tmp/ib-mesh-plugin-rooms"}/ui/package.json`)("puppeteer");
import { writeFileSync } from "node:fs";

const BASE = process.env.HARNESS_BASE || "http://127.0.0.1:5199/mesh-plugin-rooms-harness.html";
const OUT = "/tmp/mesh-plugin-rooms/shots";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deterministic framing: set the viewport straight from station+district bounds
// (zoomToFit animates and can be overridden by a concurrent camera fly-back).
const HARD_FIT = `(function(e){ const vp = e.viewport; const b = e.station.bounds; let minX = 800-900, maxX = 800+900, minY = b.minY, maxY = 600+480; const d = e.district && e.district.bounds(); if (d) { minX = Math.min(minX, d.minX-40); maxX = Math.max(maxX, d.maxX+40); minY = Math.min(minY, d.minY-20); maxY = Math.max(maxY, d.maxY+20); } const w = maxX-minX, h = maxY-minY; const sc = Math.min(vp.screenWidth/(w+100), vp.screenHeight/(h+80), 1); vp.plugins.remove('animate'); vp.setZoom(sc, true); vp.moveCenter(minX+w/2, minY+h/2); return [sc, minX+w/2, minY+h/2]; })`;

const only = process.argv[2] || "all";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"],
});
const errors = [];
async function open(url, { width = 1600, height = 1000, dpr = 1 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dpr });
  page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__fake && !!window.__fake.engine(), { timeout: 30000 });
  await sleep(1500);
  // Pin the camera: the default-on auto-focus director and the cinematic drone
  // would otherwise fly away from a manually framed room between move and shot.
  await page.evaluate(() => {
    const viz = window.__fake.viz();
    viz.cameraDirector?.setEnabled?.(false);
    const e = window.__fake.engine();
    e.cinematicCam?.stopAuto?.();      // no auto drone orbit after 30s of quiet
    e.cinematicCam?.exitDroneMode?.();
  });
  return page;
}
async function fit(page) { await page.evaluate((hf) => eval(hf)(window.__fake.engine()), HARD_FIT); await sleep(700); }
function roomsInfo(page) {
  return page.evaluate(() => {
    const eng = window.__fake.engine();
    return { rooms: eng.pluginRooms().map((r) => r.id), sectors: (window.__worldSectors || []).filter((s) => s.id.startsWith("plugin:")).map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })) };
  });
}
async function zoomTo(page, sectorId, scale) {
  // Use the engine viewport: center on the room's world center at a given scale.
  await page.evaluate(({ sectorId, scale }) => {
    const eng = window.__fake.engine();
    const vp = eng.viewport;
    const room = eng.district?.room(sectorId);
    if (!room) throw new Error("no room " + sectorId);
    vp.plugins.remove("animate");
    vp.setZoom(scale, true);
    vp.moveCenter(room.center.x, room.center.y + 10);
  }, { sectorId, scale });
  await sleep(400);
}
const report = {};

// ── 1. Full map, all plugins, no agents ───────────────────────────────
if (only === "all" || only === "full") {
  const page = await open(BASE + "?plugins=all");
  await sleep(2500);
  // Quiet worlds auto-engage the cinematic drone orbit; pin the camera for the overview.
  await fit(page);
  report.full = await roomsInfo(page);
  report.placement = await page.evaluate(() => window.__fake.engine().district.list().map((r) => [r.spec.pluginId, r.placed.side, r.placed.c, r.placed.r, r.spec.size]));
  console.log("placement:", JSON.stringify(report.placement));
  console.log("rooms:", report.full.rooms.length, report.full.rooms.join(","));
  await page.screenshot({ path: `${OUT}/01-full-map-plugin-district.png` });
  // Spawn 30 agents working across plugins + core, then fire tools.
  await page.evaluate(() => {
    const f = window.__fake;
    const plugins = ["infinitrade", "solatrix", "omniclinic", "robovoice", "flypic", "discipline", "content-studio", "products", "canvas-library", "business-agency", "infinicode", "whiteboard"];
    const tools = {
      infinitrade: ["infinitrade_market", "infinitrade_order"], solatrix: ["solana_market", "solana_portfolio"], omniclinic: ["omniclinic_research"],
      robovoice: ["gateway:robovoice.status"], flypic: ["flypic_generate_image"], discipline: ["focus", "discipline"], "content-studio": ["content_intel", "script"],
      products: ["gateway:products.list"], "canvas-library": ["canvas_library"], "business-agency": ["lead_generation", "client_contacts"], infinicode: ["gateway:infinicode.fleet.list"], whiteboard: ["excalidraw_create_element"],
    };
    const backends = ["claude-code", "codex", "opencode", undefined];
    for (let i = 0; i < 30; i++) {
      const pid = plugins[i % plugins.length];
      if (i < 24) f.spawn(i, `${pid} worker ${i}`, backends[i % 4], "main", { currentTask: `Working in ${pid}` });
      else f.spawn(i, `core task ${i}`, backends[i % 4], "main", { currentTask: "refactor gateway websocket handler" });
    }
    for (let i = 0; i < 24; i++) {
      const pid = plugins[i % plugins.length];
      const t = tools[pid][i % tools[pid].length];
      const name = t.startsWith("gateway:") ? "gateway" : t;
      f.tool(i, name, t.startsWith("gateway:") ? t : undefined);
    }
    for (let i = 24; i < 30; i++) f.tool(i, ["bash", "read", "edit", "web_fetch"][i % 4]);
  });
  await sleep(16000);
  await fit(page);
  const plan = await page.evaluate(() => window.__fake.plan());
  const inRooms = Object.values(plan).filter((a) => a.sectorId.startsWith("plugin:")).length;
  report.agentsInRooms = inRooms;
  report.plan = plan;
  console.log("agents planned into plugin rooms:", inRooms, "/", Object.keys(plan).length);
  // Perf with 12 rooms + 30 agents: per-frame draw cost from the engine's
  // window.__hudPerf hook and the Pixi ticker FPS (swiftshader, headless).
  const perfSamples = [];
  for (let i = 0; i < 20; i++) {
    perfSamples.push(await page.evaluate(() => ({ drawMs: window.__fake.perf()?.drawMs ?? null, fps: window.__fake.engine().app?.ticker?.FPS ?? null, agents: window.__fake.perf()?.agents ?? null })));
    await sleep(150);
  }
  const ms = perfSamples.map((s) => s.drawMs).filter((v) => typeof v === "number");
  const fps = perfSamples.map((s) => s.fps).filter((v) => typeof v === "number");
  report.perf = { samples: perfSamples, drawMsAvg: ms.reduce((a, b) => a + b, 0) / ms.length, drawMsMax: Math.max(...ms), fpsAvg: fps.reduce((a, b) => a + b, 0) / fps.length, fpsMin: Math.min(...fps), rooms: report.full.rooms.length, agents: Object.keys(plan).length };
  console.log("perf:", JSON.stringify({ drawMsAvg: report.perf.drawMsAvg.toFixed(1), drawMsMax: report.perf.drawMsMax.toFixed(1), fpsAvg: report.perf.fpsAvg.toFixed(1), fpsMin: report.perf.fpsMin.toFixed(1), rooms: report.perf.rooms, agents: report.perf.agents }));
  await page.screenshot({ path: `${OUT}/02-full-map-30-agents.png` });
  await page.close();
}

// ── 2. Room close-ups at dpr 2, with agents inside ───────────────────
if (only === "all" || only === "rooms") {
  const page = await open(BASE + "?plugins=all", { width: 1200, height: 800, dpr: 2 });
  await sleep(2000);
  await page.evaluate(() => {
    const f = window.__fake;
    const tools = { infinitrade: "infinitrade_market", solatrix: "solana_market", omniclinic: "omniclinic_research", robovoice: "gateway:robovoice.status", flypic: "flypic_generate_image", discipline: "focus", "content-studio": "content_intel", products: "gateway:products.list", "canvas-library": "canvas_library", "business-agency": "lead_generation", infinicode: "gateway:infinicode.fleet.list", whiteboard: "excalidraw_create_element" };
    let i = 0;
    for (const [pid, t] of Object.entries(tools)) {
      for (let k = 0; k < 2; k++) {
        f.spawn(i, `${pid} ${k ? "analyst" : "builder"}`, k ? "codex" : "claude-code", "main", { currentTask: `Working in ${pid}` });
        f.tool(i, t.startsWith("gateway:") ? "gateway" : t, t.startsWith("gateway:") ? t : undefined);
        i++;
      }
    }
  });
  await sleep(17000);
  const ids = await page.evaluate(() => window.__fake.rooms().map((r) => r.id));
  for (const id of ids) {
    await zoomTo(page, id, 1.6);
    await page.screenshot({ path: `${OUT}/room-${id.replace("plugin:", "")}.png` });
  }
  // Agents inside Infinitrade / Solatrix
  await zoomTo(page, "plugin:infinitrade", 2.0);
  await page.screenshot({ path: `${OUT}/03-agent-inside-infinitrade.png` });
  await zoomTo(page, "plugin:solatrix", 2.0);
  await page.screenshot({ path: `${OUT}/04-agent-inside-solatrix.png` });
  // Hover tooltip on the Infinitrade room
  await zoomTo(page, "plugin:infinitrade", 1.4);
  const s = (await roomsInfo(page)).sectors.find((x) => x.id === "plugin:infinitrade");
  if (s) { await page.mouse.move(s.x, s.y); await sleep(600); await page.screenshot({ path: `${OUT}/05-hover-infinitrade.png` }); }
  report.roomShots = ids;
  await page.close();
}

// ── 3. Rooms disappear when a plugin is disabled ─────────────────────
if (only === "all" || only === "disable") {
  const page = await open(BASE + "?plugins=all");
  await sleep(2000);
  await fit(page);
  const before = await roomsInfo(page);
  await page.evaluate(() => { window.__fake.spawn(0, "solatrix scout", "claude-code", "main", { currentTask: "Solatrix launches sweep" }); window.__fake.tool(0, "solana_market"); });
  await sleep(6000);
  await page.screenshot({ path: `${OUT}/06-before-disable.png` });
  await page.evaluate(() => window.__fake.setPlugin("solatrix", false));
  await sleep(250);
  await page.screenshot({ path: `${OUT}/07-disable-solatrix-dissolving.png` });
  await sleep(1500);
  await page.evaluate(() => window.__fake.setPlugin("infinitrade", false));
  await page.evaluate(() => window.__fake.setRoom("flypic", false));
  await sleep(1800);
  const after = await roomsInfo(page);
  report.disable = { before: before.rooms, after: after.rooms };
  console.log("rooms before/after disable:", before.rooms.length, after.rooms.length);
  await page.screenshot({ path: `${OUT}/08-after-disable-solatrix-infinitrade-flypic.png` });
  // Re-enable → room builds back in
  await page.evaluate(() => window.__fake.setPlugin("solatrix", true));
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/09-reenabled-solatrix.png` });
  await page.close();
}

// ── 4. 390px mobile viewport ──────────────────────────────────────────
if (only === "all" || only === "mobile") {
  const page = await open(BASE + "?plugins=all", { width: 390, height: 844, dpr: 2 });
  await sleep(2500);
  await fit(page);
  await page.evaluate(() => { const f = window.__fake; f.spawn(0, "trader", "claude-code"); f.tool(0, "infinitrade_market"); f.spawn(1, "scout", "codex"); f.tool(1, "solana_market"); });
  await sleep(7000);
  await fit(page);
  await page.screenshot({ path: `${OUT}/10-mobile-390.png` });
  await page.close();
}

// ── 5. No plugins enabled → plain core map, no district ───────────────
if (only === "all" || only === "none") {
  const page = await open(BASE + "?plugins=none");
  await sleep(2000);
  await fit(page);
  report.none = await roomsInfo(page);
  await page.screenshot({ path: `${OUT}/11-no-plugins.png` });
  await page.close();
}

// ── 6. Read-only render of a captured LIVE snapshot (?live=1) ─────────
if (only === "live") {
  const page = await open(BASE + "?live=1");
  await sleep(3000);
  await fit(page);
  report.live = await page.evaluate(() => ({ dump: window.__liveDump ?? null, rooms: window.__fake.rooms().map((r) => r.id), agents: (window.__agentFxState || []).length, plan: window.__fake.plan() }));
  console.log("LIVE snapshot:", JSON.stringify(report.live.dump), "rooms:", report.live.rooms.length, "agents on map:", report.live.agents);
  await page.screenshot({ path: `${OUT}/30-live-data-readonly-mesh.png` });
  await page.close();
}

report.pageErrors = errors;
writeFileSync(`${OUT}/report-${only}.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log("DONE", JSON.stringify({ errors: errors.length }));
