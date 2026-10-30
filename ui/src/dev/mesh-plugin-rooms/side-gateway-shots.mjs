// Side-gateway verification: real gateway (:18977, worktree dist, 12 first-party
// plugins enabled) → /mesh page → plugin rooms from real plugins.list, live
// contribution toggle (mapRoom:<id>) dissolving/rebuilding a room, click → page.
// Also one read-only render of the same dist against the LIVE gateway (:18789)
// via ?gatewayUrl (no writes: plugins.list + subagents.list + sessions.list reads).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const puppeteer = createRequire(`${process.env.INFINIBOT_WORKTREE || "/tmp/ib-mesh-plugin-rooms"}/ui/package.json`)("puppeteer");
const OUT = "/tmp/mesh-plugin-rooms/shots";
const SIDE = process.env.SIDE_BASE || "http://127.0.0.1:18977";
const mode = process.argv[2] || "side";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deterministic framing: set the viewport straight from station+district bounds
// (zoomToFit animates and can be overridden by a concurrent camera fly-back).
const HARD_FIT = `(function(e){ const vp = e.viewport; const b = e.station.bounds; let minX = 800-900, maxX = 800+900, minY = b.minY, maxY = 600+480; const d = e.district && e.district.bounds(); if (d) { minX = Math.min(minX, d.minX-40); maxX = Math.max(maxX, d.maxX+40); minY = Math.min(minY, d.minY-20); maxY = Math.max(maxY, d.maxY+20); } const w = maxX-minX, h = maxY-minY; const sc = Math.min(vp.screenWidth/(w+100), vp.screenHeight/(h+80), 1); vp.plugins.remove('animate'); vp.setZoom(sc, true); vp.moveCenter(minX+w/2, minY+h/2); return [sc, minX+w/2, minY+h/2]; })`;

const browser = await puppeteer.launch({ headless: "new", executablePath: (process.env.CHROME_PATH || undefined),
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"] });
const errors = [];
const deepFind = `(function deep(root, sel){ const hit = root.querySelector?.(sel); if (hit) return hit; const all = root.querySelectorAll ? root.querySelectorAll('*') : []; for (const el of all) { if (el.shadowRoot) { const r = deep(el.shadowRoot, sel); if (r) return r; } } return null; })`;
async function openMesh(url, vp = { width: 1600, height: 1000, dpr: 1 }) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
  page.on("pageerror", (e) => { errors.push(e.message); if (errors.length <= 3) console.log(`[pageerror phase=${globalThis.__phase ?? "?"}]`, String(e.stack || e.message).split("\n").slice(0, 5).join(" | ").slice(0, 600)); });
  page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
  try { await page.goto(url, { waitUntil: "load" }); }
  catch (e) { throw new Error(`goto failed for ${url.split("?")[0]}: ${String(e.message || e).split(" at ")[0]}`); }
  await page.waitForFunction(`${deepFind}(document, 'agency-world-viz')`, { timeout: 60000 });
  await page.waitForFunction(() => Array.isArray(window.__worldSectors) && window.__worldSectors.length > 0, { timeout: 60000 });
  await sleep(2500);
  await page.evaluate((df) => {
    const viz = eval(df)(document, "agency-world-viz");
    viz.cameraDirector?.setEnabled?.(false);
    viz.engine?.cinematicCam?.stopAuto?.();
    viz.engine?.cinematicCam?.exitDroneMode?.();
  }, deepFind);
  await sleep(1500); // let the drone-exit fly-back settle before any manual framing
  return page;
}
const sectors = (page) => page.evaluate(() => (window.__worldSectors || []).filter((s) => s.id.startsWith("plugin:")).map((s) => s.id));
const fit = async (page) => { await page.evaluate((df, hf) => eval(hf)(eval(df)(document, "agency-world-viz").engine), deepFind, HARD_FIT); await sleep(900); };
const report = { errors };

if (mode === "side") {
  const page = await openMesh(`${SIDE}/mesh?password=mesh-rooms`);
  globalThis.__phase = "fit"; await fit(page);
  report.rooms = await sectors(page);
  console.log("side rooms:", report.rooms.length, report.rooms.join(","));
  const pl = await page.evaluate(async () => {
    const c = window.__infinibotGatewayClient; const r = await c.request("plugins.list", {});
    return (r.plugins || []).filter((p) => p.manifestVersion === 2).map((p) => [p.id, p.status, p.contributes?.mapRoom?.theme ?? null, (p.rosterAgentIds || []).length]);
  });
  report.pluginsList = pl; console.log("plugins.list:", JSON.stringify(pl));
  await page.screenshot({ path: `${OUT}/20-side-gateway-mesh-page.png` });
  globalThis.__phase = "toggle-off";
  // Live contribution toggle: switch the Solatrix room off → dissolves (no restart).
  const toggled = await page.evaluate(async (df) => {
    const c = window.__infinibotGatewayClient;
    const r = await c.request("plugins.contributions.set", { id: "solatrix", key: "mapRoom:solatrix", enabled: false });
    await eval(df)(document, "agency-world-viz").refreshPluginRooms();
    return r;
  }, deepFind);
  console.log("contributions.set:", JSON.stringify(toggled).slice(0, 200));
  await sleep(300);
  await page.screenshot({ path: `${OUT}/21-side-solatrix-room-dissolving.png` });
  await sleep(1500);
  report.roomsAfterOff = await sectors(page);
  console.log("rooms after mapRoom:solatrix off:", report.roomsAfterOff.length, report.roomsAfterOff.includes("plugin:solatrix") ? "STILL PRESENT" : "gone");
  await page.screenshot({ path: `${OUT}/22-side-solatrix-room-off.png` });
  globalThis.__phase = "toggle-on";
  await page.evaluate(async (df) => {
    await window.__infinibotGatewayClient.request("plugins.contributions.set", { id: "solatrix", key: "mapRoom:solatrix", enabled: true });
    await eval(df)(document, "agency-world-viz").refreshPluginRooms();
  }, deepFind);
  await sleep(1500);
  report.roomsAfterOn = await sectors(page);
  console.log("rooms after back on:", report.roomsAfterOn.length);
  await page.screenshot({ path: `${OUT}/23-side-solatrix-room-back.png` });
  globalThis.__phase = "hover-click";
  // Click the Infinitrade room → the app navigates to /infinitrade.
  const s = await page.evaluate(() => (window.__worldSectors || []).find((x) => x.id === "plugin:infinitrade"));
  if (s) {
    const box = await page.evaluate((df) => { const r = eval(df)(document, "agency-world-viz").getBoundingClientRect(); return { x: r.x, y: r.y }; }, deepFind);
    await page.mouse.move(box.x + s.x, box.y + s.y); await sleep(500);
    await page.screenshot({ path: `${OUT}/24-side-hover-infinitrade.png` });
    await page.mouse.click(box.x + s.x, box.y + s.y);
    await sleep(2500);
    report.clickPath = await page.evaluate(() => location.pathname);
    console.log("after click path:", report.clickPath);
    await page.screenshot({ path: `${OUT}/25-side-click-opens-infinitrade.png` });
  }
  await page.close();
}

if (mode === "synthetic") {
  // Real /mesh page on the side gateway + SYNTHETIC activity: 30 agents
  // (24 firing plugin tools/RPCs, 6 on core tools) pushed straight into the
  // world-viz batch path, so the routing (activity → plugin room) and the
  // 12-rooms + 30-agents perf are proven on the real page, not the harness.
  const page = await openMesh(`${SIDE}/mesh?password=mesh-rooms`);
  globalThis.__phase = "synthetic"; await fit(page);
  report.rooms = await sectors(page);
  await page.evaluate((df) => {
    const viz = eval(df)(document, "agency-world-viz");
    const plugins = ["infinitrade", "solatrix", "omniclinic", "robovoice", "flypic", "discipline", "content-studio", "products", "canvas-library", "business-agency", "infinicode", "whiteboard"];
    const tools = {
      infinitrade: ["infinitrade_market", "infinitrade_order"], solatrix: ["solana_market", "solana_portfolio"], omniclinic: ["omniclinic_research"],
      robovoice: ["gateway:robovoice.status"], flypic: ["flypic_generate_image"], discipline: ["focus", "discipline"], "content-studio": ["content_intel", "script"],
      products: ["gateway:products.list"], "canvas-library": ["canvas_library"], "business-agency": ["lead_generation", "client_contacts"], infinicode: ["gateway:infinicode.fleet.list"], whiteboard: ["excalidraw_create_element"],
    };
    const backends = ["claude-code", "codex", "opencode", undefined];
    const events = [];
    for (let i = 0; i < 30; i++) {
      const pid = plugins[i % plugins.length];
      const core = i >= 24;
      events.push({ kind: "agent.spawn", agent: { sessionKey: `agent:main:subagent:syn-${i}`, agentId: "main", label: core ? `core task ${i}` : `${pid} worker ${i}`, nodeId: "local", status: "running", progress: 0.3, currentTask: core ? "refactor gateway websocket handler" : `Working in ${pid}`, ...(backends[i % 4] ? { coderBackend: backends[i % 4] } : {}) } });
    }
    viz.applyBatch(events);
    const toolEvents = [];
    for (let i = 0; i < 30; i++) {
      const pid = plugins[i % plugins.length];
      const t = i >= 24 ? ["bash", "read", "edit", "web_fetch"][i % 4] : tools[pid][i % tools[pid].length];
      const kind = t.startsWith("gateway:") ? "gateway" : t;
      toolEvents.push({ kind: "agent.tool", sessionKey: `agent:main:subagent:syn-${i}`, tool: { kind, label: t } });
    }
    viz.applyBatch(toolEvents);
  }, deepFind);
  await sleep(16000);
  await fit(page);
  const plan = await page.evaluate((df) => Object.fromEntries(eval(df)(document, "agency-world-viz").engine.spreadPlan()), deepFind);
  const inRooms = Object.entries(plan).filter(([, a]) => a.sectorId.startsWith("plugin:"));
  report.synthetic = { agents: Object.keys(plan).length, inPluginRooms: inRooms.length, byRoom: inRooms.reduce((m, [, a]) => ((m[a.sectorId] = (m[a.sectorId] ?? 0) + 1), m), {}) };
  console.log("synthetic: agents planned", report.synthetic.agents, "in plugin rooms", report.synthetic.inPluginRooms, JSON.stringify(report.synthetic.byRoom));
  const samples = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await page.evaluate((df) => ({ drawMs: window.__hudPerf?.drawMs ?? null, fps: eval(df)(document, "agency-world-viz").engine.app?.ticker?.FPS ?? null }), deepFind));
    await sleep(150);
  }
  const ms = samples.map((x) => x.drawMs).filter((v) => typeof v === "number"), fps = samples.map((x) => x.fps).filter((v) => typeof v === "number");
  report.perf = { rooms: report.rooms.length, agents: report.synthetic.agents, drawMsAvg: ms.reduce((a, b) => a + b, 0) / ms.length, drawMsMax: Math.max(...ms), fpsAvg: fps.reduce((a, b) => a + b, 0) / fps.length, fpsMin: Math.min(...fps), samples };
  console.log("perf:", JSON.stringify({ rooms: report.perf.rooms, agents: report.perf.agents, drawMsAvg: report.perf.drawMsAvg.toFixed(1), drawMsMax: report.perf.drawMsMax.toFixed(1), fpsAvg: report.perf.fpsAvg.toFixed(1), fpsMin: report.perf.fpsMin.toFixed(1) }));
  await page.screenshot({ path: `${OUT}/26-side-30-agents-in-rooms.png` });
  // Hover a room that has agents → tooltip lists them.
  const busy = Object.keys(report.synthetic.byRoom)[0];
  const s = await page.evaluate((id) => (window.__worldSectors || []).find((x) => x.id === id), busy);
  if (s) {
    const box = await page.evaluate((df) => { const r = eval(df)(document, "agency-world-viz").getBoundingClientRect(); return { x: r.x, y: r.y }; }, deepFind);
    await page.mouse.move(box.x + s.x, box.y + s.y); await sleep(700);
    report.hoverRoom = { id: busy, occupants: await page.evaluate((df, id) => eval(df)(document, "agency-world-viz").engine.pluginRoomOccupants(id), deepFind, busy) };
    console.log("hover", busy, "occupants:", report.hoverRoom.occupants.length);
    await page.screenshot({ path: `${OUT}/27-side-hover-room-with-agents.png` });
  }
  await page.close();
}

if (mode === "live") {
  // Read-only: my dist's control UI (served by the side gateway) talking to the
  // LIVE gateway's WS over ?gatewayUrl. Password read locally from the owner's
  // config; never logged.
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.infinibot/infinibot.json`, "utf8"));
  const pw = cfg?.gateway?.auth?.password || ""; const tok = cfg?.gateway?.auth?.token || "";
  const q = pw ? `password=${encodeURIComponent(pw)}` : tok ? `token=${encodeURIComponent(tok)}` : "";
  const page = process.env.LIVE_PROXY
    ? await openMesh(`${process.env.LIVE_PROXY}/mesh?${q}`)   // same-origin proxy → live gateway
    : await openMesh(`${SIDE}/mesh?gatewayUrl=${encodeURIComponent("ws://127.0.0.1:18789")}&${q}`);
  await fit(page);
  report.liveRooms = await sectors(page);
  report.liveAgents = await page.evaluate(() => (window.__agentFxState || []).length);
  console.log("LIVE rooms:", report.liveRooms.length, report.liveRooms.join(","), "agents on map:", report.liveAgents);
  await page.screenshot({ path: `${OUT}/30-live-data-readonly-mesh.png` });
  await page.close();
}
writeFileSync(`${OUT}/report-side-${mode}.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log("DONE", mode, "errors:", errors.length);
