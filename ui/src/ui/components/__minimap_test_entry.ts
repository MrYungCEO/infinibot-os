// Test harness entry for world-minimap.ts — bundled by esbuild for __test.html.
import "./world-minimap";
import type { WorldMinimap } from "./world-minimap";

const bounds = { minX: 0, minY: 0, maxX: 1600, maxY: 1000 };
const sectors = [
  { id: "build", x: 300, y: 250 },
  { id: "deploy", x: 1200, y: 300 },
  { id: "research", x: 800, y: 750 },
  { id: "comms", x: 1350, y: 820 },
];
const statuses = ["active", "working", "idle", "error", "alert", "idle", "working", "active"];
const agents = Array.from({ length: 18 }, (_, i) => ({
  id: "a" + i,
  x: 80 + ((i * 137) % 1500),
  y: 60 + ((i * 271) % 900),
  status: statuses[i % statuses.length],
  activity: ((i * 7) % 10) / 10,
}));

// Camera viewport rect in world coords (center + size).
const camera = { x: 700, y: 450, width: 600, height: 380 };

const mm = document.createElement("world-minimap") as WorldMinimap;
mm.source = {
  worldBounds: () => bounds,
  sectors: () => sectors,
  agents: () => agents,
  camera: () => camera,
  flyTo: (x, y) => { (window as any).__lastNav = { x, y }; },
};
document.body.appendChild(mm);
(window as any).__minimap = mm;

// Let puppeteer move the viewport to prove the rect tracks.
(window as any).__moveCamera = (x: number, y: number, w?: number, h?: number) => {
  camera.x = x; camera.y = y;
  if (w) camera.width = w; if (h) camera.height = h;
};
