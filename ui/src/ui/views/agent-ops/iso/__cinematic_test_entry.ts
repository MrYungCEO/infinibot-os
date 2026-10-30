// Test harness entry for cinematic-camera.ts — bundled by esbuild for __test.html.
// Renders a fake iso world on a canvas, drives it with CinematicCamera, and
// exposes hooks so puppeteer can trigger shots / recording and screenshot.
import { CinematicCamera, type CinematicTarget, type WorldBounds } from "./cinematic-camera";

const W = 960;
const H = 600;
const canvas = document.getElementById("world") as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d")!;

// ── Fake world model ──────────────────────────────────────────────────────────
const bounds: WorldBounds = { minX: 0, minY: 0, maxX: 1600, maxY: 1000 };
const sectors = [
  { id: "build", x: 300, y: 250 },
  { id: "deploy", x: 1200, y: 300 },
  { id: "research", x: 800, y: 750 },
];
const agents: CinematicTarget[] = [
  { id: "a1", x: 360, y: 280 },
  { id: "a2", x: 420, y: 230 },
  { id: "a3", x: 1180, y: 320 },
  { id: "a4", x: 820, y: 720 },
  { id: "a5", x: 760, y: 790 },
];

// Camera state (center + scale) the engine "renders" through.
const cam = { x: 800, y: 500, scale: 0.7, tx: 800, ty: 500, ts: 0.7, t: 0 };
let lastActivity = performance.now();

function flyTo(x: number, y: number, scale: number, timeMs: number) {
  cam.tx = x; cam.ty = y; cam.ts = scale; cam.t = timeMs;
  (window as any).__lastFly = { x, y, scale, timeMs };
}

// ── Render loop (the "engine") ────────────────────────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function render() {
  // Ease camera toward target (simple, just for the visual).
  cam.x = lerp(cam.x, cam.tx, 0.12);
  cam.y = lerp(cam.y, cam.ty, 0.12);
  cam.scale = lerp(cam.scale, cam.ts, 0.12);

  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, W, H);
  const s = cam.scale;
  const ox = W / 2 - cam.x * s;
  const oy = H / 2 - cam.y * s;
  const toS = (wx: number, wy: number) => ({ x: wx * s + ox, y: wy * s + oy });

  // world frame
  ctx.strokeStyle = "rgba(232,192,96,0.25)";
  const tl = toS(bounds.minX, bounds.minY); const br = toS(bounds.maxX, bounds.maxY);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  for (const sec of sectors) {
    const p = toS(sec.x, sec.y);
    ctx.fillStyle = "rgba(232,192,96,0.12)";
    ctx.strokeStyle = "rgba(232,192,96,0.4)";
    ctx.fillRect(p.x - 60 * s, p.y - 60 * s, 120 * s, 120 * s);
    ctx.strokeRect(p.x - 60 * s, p.y - 60 * s, 120 * s, 120 * s);
    ctx.fillStyle = "rgba(232,192,96,0.7)";
    ctx.font = "12px monospace";
    ctx.fillText(sec.id, p.x - 24, p.y - 66 * s);
  }
  for (const a of agents) {
    const p = toS(a.x, a.y);
    ctx.fillStyle = "#6ee7a8";
    ctx.shadowColor = "#6ee7a8"; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(p.x, p.y, 7 * s + 3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
  // HUD
  ctx.fillStyle = "#e8c060";
  ctx.font = "13px monospace";
  ctx.fillText(`cam(${cam.x.toFixed(0)},${cam.y.toFixed(0)}) s=${cam.scale.toFixed(2)}  drone=${(window as any).cinematicCamera?.isDroneMode?.()}`, 12, 22);
  requestAnimationFrame(render);
}
render();

// ── Cinematic camera wired to the fake engine ─────────────────────────────────
const cinematic = new CinematicCamera({
  now: () => performance.now(),
  flyTo,
  worldBounds: () => bounds,
  agentPositions: () => agents,
  lastActivityAt: () => lastActivity,
  recordElement: () => canvas,
  director: { setUserOverride() {}, setEnabled() {}, isEnabled: () => false },
}, { quietMs: 1500, pollMs: 500 });
cinematic.install();
(window as any).__cinematic = cinematic;
(window as any).__bumpActivity = () => { lastActivity = performance.now(); };
