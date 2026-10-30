/**
 * Standalone harness for <telemetry-overlay>: wires the real engine primitives
 * (SimulationLoop + Quadtree + ErrorBudget) to a few simulated subsystems —
 * one of which throws on purpose so we can eyeball degradation + the error HUD.
 *
 * Served via vite at /__telemetry-overlay-test.html for visual verification.
 */

import { SimulationLoop } from "./simulation-loop";
import { Quadtree, type QuadtreeItem } from "./quadtree";
import { ErrorBudget } from "./error-budget";
import { Rng } from "./determinism";
import {
  TelemetryOverlay,
  type TelemetrySnapshot,
} from "./telemetry-overlay";
import "./telemetry-overlay";

interface Agent extends QuadtreeItem {
  id: number;
  vx: number;
  vy: number;
}

const WORLD = { x: 0, y: 0, w: 1000, h: 1000 };
const rng = new Rng(0xbeef);
const agents: Agent[] = Array.from({ length: 850 }, (_, id) => ({
  id,
  x: rng.range(0, 1000),
  y: rng.range(0, 1000),
  vx: rng.range(-30, 30),
  vy: rng.range(-30, 30),
}));

const qt = new Quadtree<Agent>(WORLD, { capacity: 8 });
for (const a of agents) qt.insert(a);

const budget = new ErrorBudget({ maxErrors: 5, windowMs: 4000 });

// Visualise the agents on a canvas so the overlay sits over a "real" world.
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
}
resize();
addEventListener("resize", resize);

const loop = new SimulationLoop({ hz: 60 });
let flockBrokenTicks = 0;

loop.register({
  update: (dt) => {
    // ── physics: move + bounce ──────────────────────────────────────────
    budget.runProtected("physics", () => {
      for (const a of agents) {
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        if (a.x < 0 || a.x > 1000) a.vx *= -1;
        if (a.y < 0 || a.y > 1000) a.vy *= -1;
        a.x = Math.max(0, Math.min(1000, a.x));
        a.y = Math.max(0, Math.min(1000, a.y));
      }
      qt.rebuild();
    });

    // ── flocking: a deliberately BROKEN subsystem (throws every tick) ────
    budget.runProtected("flocking", () => {
      flockBrokenTicks++;
      throw new Error(`null neighbour at tick ${flockBrokenTicks}`);
    });

    // ── neighbour queries via quadtree (healthy) ─────────────────────────
    budget.runProtected("proximity", () => {
      const sample = agents[0];
      qt.queryCircle(sample.x, sample.y, 80);
    });
  },
  render: () => {
    budget.runProtected("render", () => {
      const sx = canvas.width / 1000;
      const sy = canvas.height / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#1e293b";
      for (const a of agents) {
        ctx.fillRect(a.x * sx - 2, a.y * sy - 2, 3, 3);
      }
    });
  },
});

// Feed the overlay from the live engine each frame.
const overlay = document.querySelector("telemetry-overlay") as TelemetryOverlay;
overlay.provider = (): TelemetrySnapshot => {
  const m = loop.getMetrics();
  const subs = budget.snapshot();
  const last = budget.lastError();
  return {
    fps: m.fps,
    tickRate: m.tickRate,
    agentsAlive: agents.length,
    quadtreeSize: qt.size,
    subsystems: subs.map((s) => ({
      name: s.name,
      errorCount: s.errorCount,
      degraded: s.degraded,
    })),
    lastError: last ? { subsystem: last.subsystem, message: last.message } : null,
  };
};

overlay.show(); // reveal immediately for the harness (hotkey ` still toggles)
loop.start();

// Expose for puppeteer assertions / manual poking.
(window as unknown as Record<string, unknown>).__engine = { loop, qt, budget, agents };
