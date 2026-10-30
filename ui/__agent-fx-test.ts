// Visual test harness for <agent-fx-layer>. 8 fake agents: some orbit (moving →
// trails), some stay put; statuses cycle every 2s (→ bursts + ring colour swaps).
import "./src/ui/components/agent-fx-layer.ts";
import type { FxAgent } from "./src/ui/components/agent-fx-layer/types.js";

const STATUSES = ["running", "idle", "failed", "completed", "blocked"];
const BACKENDS = ["claude-code", "opencode", "codex", "gemini"];

const stage = document.getElementById("stage")!;
const layer = document.createElement("agent-fx-layer");
stage.appendChild(layer);

interface Fake {
  id: string;
  backend: string;
  cx: number;
  cy: number;
  r: number;
  speed: number; // radians/sec; 0 = stationary
  phase: number;
  statusIdx: number;
  dot: HTMLDivElement;
}

const W = window.innerWidth;
const H = window.innerHeight;
const fakes: Fake[] = [];
for (let i = 0; i < 8; i++) {
  const moving = i < 4; // first four orbit (covering all 4 backends), last four still
  const dot = document.createElement("div");
  dot.className = "agent-dot";
  stage.appendChild(dot);
  fakes.push({
    id: `agent-${i}`,
    backend: BACKENDS[i % BACKENDS.length],
    cx: W * (0.18 + 0.16 * (i % 4)),
    cy: H * (0.32 + 0.3 * Math.floor(i / 4)),
    r: moving ? 70 + (i % 3) * 22 : 0,
    speed: moving ? 0.7 + i * 0.12 : 0,
    phase: i * 0.8,
    statusIdx: i % STATUSES.length,
    dot,
  });
}

// Status churn — staggered per agent so bursts are individually legible.
setInterval(() => {
  // Rotate ~half the fleet each tick on a rolling offset.
  const base = Math.floor(performance.now() / 1000);
  for (let i = 0; i < fakes.length; i++) {
    if ((i + base) % 2 === 0) fakes[i].statusIdx = (fakes[i].statusIdx + 1) % STATUSES.length;
  }
}, 1000);

let t0 = 0;
function frame(t: number) {
  if (!t0) t0 = t;
  const s = (t - t0) / 1000;
  const agents: FxAgent[] = fakes.map((f) => {
    const x = f.cx + Math.cos(s * f.speed + f.phase) * f.r;
    const y = f.cy + Math.sin(s * f.speed + f.phase) * f.r;
    f.dot.style.left = x + "px";
    f.dot.style.top = y + "px";
    return { id: f.id, x, y, status: STATUSES[f.statusIdx], backend: f.backend };
  });
  window.__agentFxState = agents;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for puppeteer assertions.
(window as any).__fxLayer = layer;
