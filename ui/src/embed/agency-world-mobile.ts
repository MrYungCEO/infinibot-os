/**
 * Agency World — mobile WebView embed entry.
 *
 * This boots the EXACT same PixiJS ActivityMap engine that the desktop UI
 * mounts inside `<agency-world-viz>`, but as a standalone single-file HTML
 * that the React-Native WebView in mobile/src/screens/agency-world loads.
 * The result is a true 1:1 rendering of the isometric office — no Canvas2D
 * reimplementation.
 *
 * Message protocol matches AgencyWorldView.js (mobile/src/screens/agency-world):
 *   host → embed  : { type:'sync',   nodes, agents, tasks }            (full baseline)
 *                   { type:'events', events: WorldEvent[] }            (incremental)
 *                   { type:'theme',  theme:'galactic'|'cyberpunk'|... }
 *                   { type:'zoom',   action:'in'|'out'|'fit' }
 *   embed → host  : { type:'agentTap', sessionKey }
 *                   { type:'nodeTap',  nodeId }
 *                   { type:'ready' }
 *
 * `WorldEvent` is the same union produced by ui/src/ui/controllers/agency-data-bridge.ts
 * and by mobile/src/screens/agency-world/world-bridge.js — the engine consumes
 * them identically.
 */

// Inline the per-backend robot-ninja PNGs as data URIs so the bundle is
// fully self-contained. The web app fetches /agent-sprites/*.png from the
// gateway; the mobile WebView has no server, so we ship the bytes inside
// the HTML and patch AGENT_SPRITE_SRC before the engine bakes textures.
import claudeSprite from "../../public/agent-sprites/claude.png?inline";
import codexSprite from "../../public/agent-sprites/codex.png?inline";
import defaultSprite from "../../public/agent-sprites/default.png?inline";
import geminiSprite from "../../public/agent-sprites/gemini.png?inline";
import opencodeSprite from "../../public/agent-sprites/opencode.png?inline";
import { AGENT_SPRITE_SRC } from "../ui/views/agent-ops/agent-sprites";
AGENT_SPRITE_SRC.claude = claudeSprite as unknown as string;
AGENT_SPRITE_SRC.codex = codexSprite as unknown as string;
AGENT_SPRITE_SRC.default = defaultSprite as unknown as string;
AGENT_SPRITE_SRC.gemini = geminiSprite as unknown as string;
AGENT_SPRITE_SRC.opencode = opencodeSprite as unknown as string;

import { ActivityMap, type MeshAgent, type MeshNode } from "../ui/views/agent-ops/activity-map";
import type { WorldEvent } from "../ui/controllers/agency-data-bridge";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (msg: string) => void };
  }
}

// ── Mount host ───────────────────────────────────────────────────────
const host = document.getElementById("host") as HTMLDivElement;
if (!host) throw new Error("missing #host");

// Local mirrors so embed → host event payloads carry the original record,
// not just the minimal MeshAgent slice the engine holds.
const agents = new Map<string, MeshAgent>();
const nodes = new Map<string, MeshNode>();

function postToHost(payload: unknown): void {
  try {
    const msg = JSON.stringify(payload);
    window.ReactNativeWebView?.postMessage(msg);
  } catch {
    /* no host (browser test) — ignore */
  }
}

// ── Engine ───────────────────────────────────────────────────────────
// An agent counts as "live" for the auto-director / tap payload unless it has
// reached a terminal/idle state. Sleeping (idle) and finished agents must still
// be tappable — the host decides what to show — so this flag is informational
// only and never gates the tap itself.
function isAgentActive(a: MeshAgent): boolean {
  const s = String(a.status || "").toLowerCase();
  return s !== "idle" && s !== "completed" && s !== "failed";
}

const engine = new ActivityMap(host, {
  worldTheme: "galactic",
  onAgentClick: (a) => {
    // Tap → fly-to + zoom-in (auto-director), then hand the tap to the host so
    // it can open the centralized agent sheet. Fires for EVERY agent, sleeping
    // or running — the host opens the modal regardless of `isActive`.
    focusTappedAgent();
    postToHost({
      type: "agentTap",
      sessionKey: a.sessionKey,
      agentId: a.agentId,
      isActive: isAgentActive(a),
    });
  },
  onNodeClick: (n) => postToHost({ type: "nodeTap", nodeId: n.id }),
});
(engine as unknown as { applyThemeFromCss?: () => void }).applyThemeFromCss?.();

// ── Fix #1: suppress the engine's in-canvas zoom HUD ─────────────────
// ActivityMap draws its own Pixi +/−/⊡ buttons (UIControls). The mobile host
// (AgencyWorldView) renders the single, authoritative RN zoom/AUTO cluster on
// top via postMessage, so the in-canvas buttons are a confusing duplicate.
// Hide them from the embed side — without touching desktop ActivityMap, which
// keeps its HUD. The container is created during async engine boot, so retry a
// few times until it exists, then keep it hidden across resizes.
function hideEngineZoomHud(): void {
  const eng = engine as unknown as { uiControls?: { container?: { visible: boolean } } };
  const c = eng.uiControls?.container;
  if (c) c.visible = false;
}
for (const delay of [0, 60, 200, 600, 1200]) setTimeout(hideEngineZoomHud, delay);

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  engine.resize(w, h);
  hideEngineZoomHud(); // resize() rebuilds/repositions the HUD — re-hide it.
  if (directorActive()) engine.zoomToFit();
}
window.addEventListener("resize", resize);
setTimeout(resize, 0);
setTimeout(() => {
  if (directorActive()) engine.zoomToFit();
}, 900);

// ── Fix #2: Auto-director (desktop-parity camera) ────────────────────
// Mirrors the behaviour of the desktop ActivityMap camera director using only
// the engine's PUBLIC camera API (getCamera/applyCamera/zoomToFit/cameraFlyTo
// — no ActivityMap internals are touched):
//   • visible-agent set changes        → ease to frame all agents (debounced)
//   • a single agent spawns/completes   → brief zoom-in pulse, then ease out
//   • an agent is tapped                → fly toward it and zoom in
//   • suppressed for a short window after a mirrored web camera arrives so the
//     two camera sources never fight, and fully disabled when AUTO is off.
const AUTO_FIT_DEBOUNCE_MS = 250; // desktop debounce for set-change re-frame
const SPAWN_PULSE_ZOOM = 1.5; // momentary zoom-in factor on a single change
const SPAWN_PULSE_HOLD_MS = 1100; // dwell before easing back out to fit
const SPAWN_PULSE_IN_MS = 420; // ease-in duration of the pulse
const TAP_ZOOM_FACTOR = 1.7; // zoom-in multiplier when an agent is tapped
const TAP_FLY_MS = 600; // ease duration for the tap fly-to
const MAX_DIRECTOR_ZOOM = 1.8; // never punch in past this

let autoDirector = true; // AUTO pill — on by default (host can toggle)
let mirrorActiveUntil = 0;
let lastAgentCount = -1;
let autoFitTimer: ReturnType<typeof setTimeout> | null = null;
let spawnPulseTimer: ReturnType<typeof setTimeout> | null = null;

// The director may move the camera only when AUTO is on AND no web-driven
// mirror beat is currently steering the viewport.
function directorActive(): boolean {
  return autoDirector && Date.now() >= mirrorActiveUntil;
}

function cancelDirectorTimers(): void {
  if (autoFitTimer) {
    clearTimeout(autoFitTimer);
    autoFitTimer = null;
  }
  if (spawnPulseTimer) {
    clearTimeout(spawnPulseTimer);
    spawnPulseTimer = null;
  }
}

// Brief zoom-in pulse around the current framing centre, then ease back out to
// frame everyone — the cinematic the desktop plays on a single spawn/complete.
function spawnPulse(): void {
  const cam = engine.getCamera?.();
  if (cam) {
    engine.applyCamera(
      Math.min(cam.zoom * SPAWN_PULSE_ZOOM, MAX_DIRECTOR_ZOOM),
      cam.centerX,
      cam.centerY,
      SPAWN_PULSE_IN_MS,
    );
  }
  if (spawnPulseTimer) clearTimeout(spawnPulseTimer);
  spawnPulseTimer = setTimeout(() => {
    spawnPulseTimer = null;
    if (directorActive()) engine.zoomToFit();
  }, SPAWN_PULSE_HOLD_MS);
}

function maybeAutoFit(): void {
  if (agents.size === lastAgentCount) return;
  const delta = agents.size - lastAgentCount;
  const prevCount = lastAgentCount;
  lastAgentCount = agents.size;
  if (!directorActive()) return;
  if (autoFitTimer) clearTimeout(autoFitTimer);
  // Exactly one agent appeared/left an already-populated world → pulse.
  if (Math.abs(delta) === 1 && prevCount >= 1) {
    spawnPulse();
    return;
  }
  // Bulk change (or first agents) → debounced ease-to-fit-all.
  autoFitTimer = setTimeout(() => {
    autoFitTimer = null;
    if (directorActive()) engine.zoomToFit();
  }, AUTO_FIT_DEBOUNCE_MS);
}

// Tap → fly toward the agent and zoom in. ActivityMap exposes no per-agent
// world-position getter, so (without refactoring it) we zoom in around the
// current framing centre — a clear "punch in" cue that pairs with the host
// opening the agent sheet. The pulse eases back out shortly after.
function focusTappedAgent(): void {
  if (!directorActive()) return;
  const cam = engine.getCamera?.();
  if (!cam) return;
  engine.applyCamera(
    Math.min(cam.zoom * TAP_ZOOM_FACTOR, MAX_DIRECTOR_ZOOM),
    cam.centerX,
    cam.centerY,
    TAP_FLY_MS,
  );
}

// Double-tap → fit. WebViews don't reliably synthesize `dblclick` from touch,
// so detect the double-tap manually off pointerup timing/position too.
host.addEventListener("dblclick", () => engine.zoomToFit());
let lastTapAt = 0;
let lastTapX = 0;
let lastTapY = 0;
host.addEventListener(
  "pointerup",
  (e: PointerEvent) => {
    const now = Date.now();
    const dt = now - lastTapAt;
    const near = Math.abs(e.clientX - lastTapX) < 32 && Math.abs(e.clientY - lastTapY) < 32;
    if (dt > 0 && dt < 320 && near) {
      engine.zoomToFit();
      lastTapAt = 0;
    } else {
      lastTapAt = now;
      lastTapX = e.clientX;
      lastTapY = e.clientY;
    }
  },
  true,
);

// ── Event router ─────────────────────────────────────────────────────
function remotePeer(fromNodeId: string, toNodeId: string): string {
  if (toNodeId && toNodeId !== "local") return toNodeId;
  if (fromNodeId && fromNodeId !== "local") return fromNodeId;
  return toNodeId || fromNodeId || "local";
}

function applyEvents(events: WorldEvent[]): void {
  if (!events.length) return;
  const touchedNodes = new Set<string>();
  const eng = engine as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const e of events) {
    switch (e.kind) {
      case "node.upsert": {
        const had = nodes.has(e.node.id);
        nodes.set(e.node.id, e.node);
        if (!had) engine.addNode(e.node);
        engine.updateNode(e.node.id, e.node);
        touchedNodes.add(e.node.id);
        break;
      }
      case "node.remove": {
        nodes.delete(e.nodeId);
        engine.removeNode(e.nodeId);
        break;
      }
      case "agent.spawn": {
        const seen = agents.has(e.agent.sessionKey);
        agents.set(e.agent.sessionKey, e.agent);
        if (!seen) engine.addAgent(e.agent);
        else engine.updateAgent(e.agent.sessionKey, e.agent);
        touchedNodes.add(e.agent.nodeId);
        break;
      }
      case "agent.progress": {
        const prev = agents.get(e.sessionKey);
        if (prev) agents.set(e.sessionKey, { ...prev, ...e.patch });
        engine.updateAgent(e.sessionKey, e.patch);
        break;
      }
      case "agent.tool": {
        const patch = {
          lastActivityKind: e.tool.kind,
          lastActivity: { kind: e.tool.kind, label: e.tool.label },
        } as Partial<MeshAgent>;
        const prev = agents.get(e.sessionKey);
        if (prev) agents.set(e.sessionKey, { ...prev, ...patch });
        engine.updateAgent(e.sessionKey, patch);
        eng.showToolBubble?.(e.sessionKey, e.tool.kind, e.tool.label);
        eng.pulseToolAtRoom?.(e.sessionKey, e.tool.kind);
        eng.routeAgentToToolSector?.(e.sessionKey, e.tool.kind);
        break;
      }
      case "agent.message": {
        engine.showMessage({
          id: `${e.from}>${e.to}:${Date.now()}`,
          from: e.from,
          to: e.to,
          type: e.type,
          timestamp: Date.now(),
        });
        break;
      }
      case "agent.complete": {
        const status: MeshAgent["status"] = e.success ? "completed" : "failed";
        const prev = agents.get(e.sessionKey);
        if (prev) {
          agents.set(e.sessionKey, { ...prev, status });
          touchedNodes.add(prev.nodeId);
        }
        engine.updateAgent(e.sessionKey, { status });
        eng.burstCompletion?.(e.sessionKey, e.success);
        break;
      }
      case "task.ingest": {
        eng.pushTask?.(e.title, 0xfbbf24, e.nodeId);
        eng.routeTaskTrip?.(e.nodeId, e.id);
        break;
      }
      case "period.tick":
        break;
      case "fed.peer.connect": {
        eng.ensureFederationConduit?.(e.peerNodeId, {
          displayName: nodes.get(e.peerNodeId)?.name,
        });
        eng.surgeAtrium?.(1);
        break;
      }
      case "fed.peer.disconnect": {
        eng.releaseFederationConduit?.(e.peerNodeId);
        break;
      }
      case "fed.msg.send": {
        const peerId = remotePeer(e.fromNodeId, e.toNodeId);
        eng.ensureFederationConduit?.(peerId, { displayName: nodes.get(peerId)?.name });
        eng.pulseConduit?.(peerId, "send", { text: e.messageType });
        eng.surgeAtrium?.(1);
        break;
      }
      case "fed.msg.ack": {
        const peerId = remotePeer(e.fromNodeId, e.toNodeId);
        eng.ensureFederationConduit?.(peerId, { displayName: nodes.get(peerId)?.name });
        eng.pulseConduit?.(peerId, "ack", { text: "OK" });
        eng.surgeAtrium?.(0.8);
        break;
      }
      case "fed.msg.fail": {
        const peerId = remotePeer(e.fromNodeId, e.toNodeId);
        eng.ensureFederationConduit?.(peerId, { displayName: nodes.get(peerId)?.name });
        eng.pulseConduit?.(peerId, "fail", { text: e.reason });
        break;
      }
      case "ssh.connection.opened":
      case "ssh.open":
        eng.ensureSshConduit?.(e.deviceId, e.host);
        break;
      case "ssh.connection.closed":
      case "ssh.close":
        eng.releaseSshConduit?.(e.deviceId);
        break;
      case "ssh.command.executed":
      case "ssh.exec": {
        eng.ensureSshConduit?.(e.deviceId, e.host);
        eng.pulseConduit?.(e.deviceId, "command", { text: e.command });
        eng.pulseConduit?.(e.deviceId, "ack", { text: e.exitCode === 0 ? "OK" : String(e.exitCode) });
        eng.surgeAtrium?.(1);
        break;
      }
      case "ssh.connection.error":
      case "ssh.error":
        eng.ensureSshConduit?.(e.deviceId, e.host);
        eng.pulseConduit?.(e.deviceId, "fail", { text: e.error });
        break;
    }
  }

  // Auto-fit when the live agent set grows/shrinks (camera-controls parity).
  maybeAutoFit();

  // Per-node agent counts (same recomputation agency-world-viz does).
  if (touchedNodes.size || events.some((e) => e.kind === "agent.spawn")) {
    const counts = new Map<string, number>();
    for (const a of agents.values()) counts.set(a.nodeId, (counts.get(a.nodeId) || 0) + 1);
    for (const [id, node] of nodes) {
      const count = counts.get(id) || 0;
      if (node.agentCount !== count) {
        node.agentCount = count;
        engine.updateNode(id, { ...node, agentCount: count });
      }
    }
  }
}

function applySyncBaseline(payload: {
  nodes?: MeshNode[];
  agents?: MeshAgent[];
  tasks?: Array<{ id?: string; title: string; nodeId?: string }>;
}): void {
  // Reset local mirrors. The engine itself stays mounted; we rebuild its
  // nodes/agents through normal add/update so the cinematic + station stay
  // alive across reconnects.
  agents.clear();
  nodes.clear();
  const events: WorldEvent[] = [];
  for (const n of payload.nodes ?? []) events.push({ kind: "node.upsert", node: n });
  for (const a of payload.agents ?? []) events.push({ kind: "agent.spawn", agent: a });
  applyEvents(events);
  // Tasks (optional) — push into the ingest pile if the engine supports it.
  const eng = engine as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const t of payload.tasks ?? []) {
    eng.pushTask?.(t.title, 0xfbbf24, t.nodeId ?? "local");
  }
}

// ── WebView message bridge ───────────────────────────────────────────
function handleHostMessage(raw: string): void {
  let msg: { type?: string; [k: string]: unknown } | null = null;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "sync":
      applySyncBaseline(msg as Parameters<typeof applySyncBaseline>[0]);
      break;
    case "events":
      applyEvents(((msg as { events?: WorldEvent[] }).events) ?? []);
      break;
    case "zoom": {
      const action = (msg as { action?: string }).action;
      if (action === "in") engine.zoomIn();
      else if (action === "out") engine.zoomOut();
      else engine.zoomToFit();
      break;
    }
    case "camera": {
      // Cross-device mirror: the web camera (or its auto-fit) settled and the
      // RN host forwarded it. Ease our viewport to match, and hold off local
      // auto-fit for a few seconds so it doesn't immediately override.
      const m = msg as {
        zoom?: number;
        centerX?: number;
        centerY?: number;
        easeMs?: number;
      };
      if (
        typeof m.zoom === "number" &&
        typeof m.centerX === "number" &&
        typeof m.centerY === "number"
      ) {
        const ease = typeof m.easeMs === "number" ? m.easeMs : 600;
        mirrorActiveUntil = Date.now() + Math.max(2500, ease + 1500);
        engine.applyCamera(m.zoom, m.centerX, m.centerY, ease);
      }
      break;
    }
    case "autoDirector": {
      // Host toggled the AUTO pill. When enabled, immediately frame everyone;
      // when disabled, cancel any pending/in-flight auto camera moves so the
      // user keeps full manual control.
      const on = (msg as { on?: boolean }).on !== false;
      autoDirector = on;
      if (!on) {
        cancelDirectorTimers();
      } else {
        lastAgentCount = -1; // force a re-frame on the next set change
        engine.zoomToFit();
      }
      postToHost({ type: "autoDirectorState", on });
      break;
    }
    case "theme":
      (engine as unknown as { applyThemeFromCss?: () => void }).applyThemeFromCss?.();
      break;
    case "ar": {
      const on = (msg as { on?: boolean }).on;
      void setArMode(on !== false);
      break;
    }
  }
}

// ── Phase 4 §WebXR/AR phone-tilt ──────────────────────────────────────────────
// Tilt the device to look around the world as if it were a hologram on the desk.
// Implemented as a CSS 3D perspective tilt of the world host driven by the device
// orientation sensor (the achievable "AR" on a 2D iso world without a full WebXR
// session). iOS 13+ gates the sensor behind a permission grant, requested on
// enable. A gentle low-pass keeps the parallax smooth; disabling restores flat.
let arEnabled = false;
let arTiltX = 0;
let arTiltY = 0;
let arRaf = 0;

function applyArTransform(): void {
  // Map device tilt (deg) → a small camera-ish rotation, clamped so the world
  // never flips away. perspective gives the holographic depth parallax.
  const rx = Math.max(-14, Math.min(14, -arTiltX));
  const ry = Math.max(-14, Math.min(14, arTiltY));
  host.style.transformOrigin = "50% 55%";
  host.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
}

const onDeviceOrientation = (e: DeviceOrientationEvent): void => {
  if (!arEnabled) return;
  // beta = front/back tilt (-180..180), gamma = left/right tilt (-90..90).
  const beta = typeof e.beta === "number" ? e.beta : 0;
  const gamma = typeof e.gamma === "number" ? e.gamma : 0;
  // Reference "holding the phone up at ~45°" as neutral; low-pass for smoothness.
  const targetX = (beta - 45) * 0.5;
  const targetY = gamma * 0.5;
  arTiltX += (targetX - arTiltX) * 0.12;
  arTiltY += (targetY - arTiltY) * 0.12;
  if (!arRaf) {
    arRaf = requestAnimationFrame(() => {
      arRaf = 0;
      applyArTransform();
    });
  }
};

async function setArMode(on: boolean): Promise<void> {
  if (on === arEnabled) {
    if (!on) return;
  }
  if (on) {
    // iOS 13+ requires an explicit permission grant (must be user-gesture driven;
    // the RN host triggers this message from a tap).
    try {
      const DOE = (window as unknown as {
        DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      }).DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission();
        if (res !== "granted") {
          postToHost({ type: "arDenied" });
          return;
        }
      }
    } catch {
      /* permission API unavailable — fall through and try listening anyway */
    }
    arEnabled = true;
    window.addEventListener("deviceorientation", onDeviceOrientation, true);
    postToHost({ type: "arEnabled" });
  } else {
    arEnabled = false;
    window.removeEventListener("deviceorientation", onDeviceOrientation, true);
    if (arRaf) {
      cancelAnimationFrame(arRaf);
      arRaf = 0;
    }
    arTiltX = 0;
    arTiltY = 0;
    host.style.transform = "";
    postToHost({ type: "arDisabled" });
  }
}

// React-Native WebView posts strings via the `message` event on `window`
// (iOS) or `document` (Android). Listen on both for portability.
window.addEventListener("message", (e: MessageEvent) => {
  if (typeof e.data === "string") handleHostMessage(e.data);
});
document.addEventListener("message", (e: Event) => {
  const data = (e as MessageEvent).data;
  if (typeof data === "string") handleHostMessage(data);
});

postToHost({ type: "ready" });
