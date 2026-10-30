// Standalone visual-test entry for <world-overlays>. Bundled by esbuild.
import "./world-overlays.js";
import type { WorldOverlays } from "./world-overlays.js";
import type { MissionData, HeatmapWeights, UiAchievement, HeatmapMode } from "./types.js";

const stage = document.getElementById("stage")!;

// Mock world floor so the heatmap/mission read against something map-like.
const floor = document.createElement("div");
floor.setAttribute(
  "style",
  "position:absolute;inset:0;z-index:0;background:" +
    "radial-gradient(60% 50% at 50% 52%, #16203a 0%, #0a0e1a 70%, #06080f 100%)",
);
stage.appendChild(floor);

// A few faux "buildings" so the scene reads as a world, not a void.
const sectors = [
  { x: 0.28, y: 0.36, label: "Auth" },
  { x: 0.7, y: 0.34, label: "Billing" },
  { x: 0.5, y: 0.64, label: "Core" },
  { x: 0.8, y: 0.7, label: "Voice" },
];
for (const s of sectors) {
  const b = document.createElement("div");
  b.setAttribute(
    "style",
    `position:absolute;left:${s.x * 100}%;top:${s.y * 100}%;transform:translate(-50%,-50%);` +
      "width:54px;height:40px;border-radius:7px;background:rgba(40,52,84,.55);" +
      "border:1px solid rgba(120,150,210,.4);z-index:0",
  );
  floor.appendChild(b);
}

const wo = document.createElement("world-overlays") as WorldOverlays;
wo.setAttribute("style", "position:absolute;inset:0;z-index:3");
stage.appendChild(wo);

const W = 960;
const H = 560;

// Mock agents (screen px relative to the stage box).
const agentDefs = [
  { id: "a1", nx: 0.28, ny: 0.36, status: "active", backend: "claude" },
  { id: "a2", nx: 0.7, ny: 0.34, status: "active", backend: "codex" },
  { id: "a3", nx: 0.5, ny: 0.64, status: "working", backend: "claude" },
  { id: "a4", nx: 0.8, ny: 0.7, status: "idle", backend: "gemini" },
  { id: "a5", nx: 0.42, ny: 0.48, status: "active", backend: "opencode" },
  { id: "a6", nx: 0.6, ny: 0.52, status: "working", backend: "claude" },
];
(window as any).__agentFxState = agentDefs.map((a) => ({
  id: a.id,
  x: a.nx * W,
  y: a.ny * H,
  status: a.status,
  backend: a.backend,
}));

// Heatmap weights (burn + failure per agent).
const weights: HeatmapWeights = {
  burn: { a1: 90, a2: 30, a3: 70, a4: 10, a5: 50, a6: 22 },
  failure: { a1: 1, a2: 6, a3: 0, a4: 3, a5: 0, a6: 9 },
};
wo.setHeatmapWeights(weights);

// Mission data — a1/a3/a5 on critical path; Core + Auth sectors critical.
const mission: MissionData = {
  criticalAgentIds: ["a1", "a3", "a5"],
  criticalSectors: [
    { x: 0.5 * W, y: 0.64 * H, r: 46, label: "Core" },
    { x: 0.28 * W, y: 0.36 * H, r: 42, label: "Auth" },
  ],
};
wo.setMissionData(mission);

// Achievements list for the modal (mix of earned).
const earned: UiAchievement[] = [
  { id: "1", kind: "clean_shipment", label: "Clean Shipment", description: "Shipped a task with zero failed sub-agent runs.", icon: "📦", tier: "bronze", earnedAt: 1_750_000_000_000 },
  { id: "2", kind: "ten_shipments", label: "Ten Down", description: "Completed 10 shipments.", icon: "🔟", tier: "silver", earnedAt: 1_750_100_000_000 },
  { id: "3", kind: "federation_milestone", label: "Federation Online", description: "Grew the federation mesh to a new node milestone.", icon: "🛰️", tier: "gold", earnedAt: 1_750_200_000_000 },
  { id: "4", kind: "zero_failed_day", label: "Flawless Day", description: "Closed a full day with zero failed runs.", icon: "✨", tier: "gold", earnedAt: 1_750_300_000_000 },
];
wo.setAchievements(earned);

// Puppeteer control surface.
(window as any).__wo = {
  el: wo,
  mission(on: boolean) {
    wo.setMissionEnabled(on);
  },
  heat(mode: HeatmapMode | null) {
    wo.setHeatmapMode(mode);
  },
  popup() {
    wo.pushAchievement({
      id: "pop1",
      kind: "ship_streak_7day",
      label: "Seven-Day Streak",
      description: "Shipped clean work seven days in a row.",
      icon: "🔥",
      tier: "gold",
      earnedAt: Date.now(),
    });
  },
  modal() {
    wo.openAchievements();
  },
};
