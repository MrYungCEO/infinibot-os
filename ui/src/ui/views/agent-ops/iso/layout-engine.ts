/**
 * layout-engine.ts — Spacing + liveness system for the InfiniBot iso agent world.
 *
 * Solves two UX problems:
 *   1. CLUTTER  — agents from the same project cluster together with kind-based
 *                 sub-grouping; a grid guarantees hard minimum spacing between
 *                 any two home positions.
 *   2. STAGNANCY — per-agent sinusoidal idle bob and active orbit are composited
 *                  onto the SVG FX layer each frame so the world always feels alive.
 *
 * Composition hook in agency-world-viz.ts renderFx():
 *   runLayoutTick(this.agents, engine, svg, t0);   // ← line 1225 (after SVG clear)
 *
 * Performance: O(n) per tick. Cluster centroids cached in module-level Map.
 * No physics library — all math is ~120 lines inline.
 */

import type { MeshAgent } from "../activity-map";

// ── Exported tunables ────────────────────────────────────────────────────────

export const LAYOUT_CONFIG = {
  /** World-px radius of each project cluster's centroid ring. */
  clusterRadius: 400,
  /** Extra tangential spacing between kind-subgroups within a project (px). */
  subClusterPadding: 60,
  /** Hard minimum distance between any two agent home positions (1.4× ~60px sprite). */
  minAgentSpacing: 84,
  /** Peak amplitude of idle sinusoidal bob (world px). */
  idleAmplitude: 4,
  /** Orbit radius for active agents (last progress < 8 s, world px). */
  activeOrbitRadius: 8,
  /** Spring strength toward home (reserved for future force-directed mode). */
  returnSpringStrength: 0.08,
  /** Agent count above which compact mode activates. */
  compactThreshold: 60,
};

// ── Internal per-agent motion state ─────────────────────────────────────────

interface AgentMotionState {
  sessionKey: string;
  /** Unique per-agent X-axis idle phase (radians) derived from sessionKey hash. */
  idlePhaseX: number;
  /** Unique per-agent Y-axis idle phase (radians). */
  idlePhaseY: number;
  /** Unique per-agent orbit starting phase (radians). */
  orbitPhase: number;
  /** performance.now() of the last noteAgentActivity call; 0 = never. */
  lastActivityTs: number;
  /** performance.now() when completion anim started; 0 = inactive. */
  completionBorn: number;
  /** performance.now() when error shake started; 0 = inactive. */
  errorBorn: number;
  /** True when this agent is suppressed in compact mode. */
  fadedOut: boolean;
}

// Module-level persistent state — survives across frames.
const _motionStates = new Map<string, AgentMotionState>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getOrCreateMotion(agent: MeshAgent): AgentMotionState {
  const key = agent.sessionKey;
  let s = _motionStates.get(key);
  if (s) return s;
  const h = hashStr(key);
  const h2 = hashStr(key + "y");
  const h3 = hashStr(key + "orb");
  s = {
    sessionKey: key,
    idlePhaseX: ((h & 0xffff) / 0x10000) * Math.PI * 2,
    idlePhaseY: ((h2 & 0xffff) / 0x10000) * Math.PI * 2,
    orbitPhase: ((h3 & 0xffff) / 0x10000) * Math.PI * 2,
    lastActivityTs: 0,
    completionBorn: 0,
    errorBorn: 0,
    fadedOut: false,
  };
  _motionStates.set(key, s);
  return s;
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

// ── Event hooks — call from agency-world-viz applyBatch ──────────────────────

/** Mark an agent as recently active (drives orbit instead of idle bob). */
export function noteAgentActivity(sessionKey: string, now: number): void {
  let s = _motionStates.get(sessionKey);
  if (!s) {
    // Create a stub before the agent appears in computeLayout so the
    // activity timestamp is already set when getOrCreateMotion first runs.
    const h = hashStr(sessionKey);
    const h2 = hashStr(sessionKey + "y");
    const h3 = hashStr(sessionKey + "orb");
    s = {
      sessionKey,
      idlePhaseX: ((h & 0xffff) / 0x10000) * Math.PI * 2,
      idlePhaseY: ((h2 & 0xffff) / 0x10000) * Math.PI * 2,
      orbitPhase: ((h3 & 0xffff) / 0x10000) * Math.PI * 2,
      lastActivityTs: 0,
      completionBorn: 0,
      errorBorn: 0,
      fadedOut: false,
    };
    _motionStates.set(sessionKey, s);
  }
  s.lastActivityTs = now;
}

/** Trigger completion wobble (success) or error shake (failure). */
export function noteAgentCompletion(sessionKey: string, now: number, success: boolean): void {
  const s = _motionStates.get(sessionKey);
  if (!s) return;
  if (success) s.completionBorn = now;
  else s.errorBorn = now;
}

// ── LayoutEntry — pure output of computeLayout ───────────────────────────────

export interface LayoutEntry {
  sessionKey: string;
  /** Cluster identifier = agent.nodeId (proxy for kanban project). */
  projectId: string;
  /** Sub-cluster identifier = agent.coderBackend. */
  kind: string;
  /** Computed home X in abstract world space (2400 × 1800). */
  homeX: number;
  /** Computed home Y in abstract world space. */
  homeY: number;
  /** True if agent had a progress event within the last 8 s. */
  isActive: boolean;
}

// ── Pure layout computation ───────────────────────────────────────────────────

/**
 * Compute cluster-based home positions for every agent.
 *
 * Guarantees:
 *   • Same-projectId agents share a tight grid neighbourhood.
 *   • Within a project, agents are sorted by coderBackend (kind) so same-kind
 *     agents are adjacent rows in the grid — visual sub-clustering with zero
 *     extra centroid overhead.
 *   • Adjacent cells in the grid are exactly minAgentSpacing apart; the grid
 *     diagonal (√2 × spacing) is always > spacing, so the hard-minimum holds
 *     for every pair within a project.
 *   • Cross-project centroid distance (2R·sin(π/N)) is ≫ the project grid
 *     diagonal, so cross-project pairs also respect minAgentSpacing.
 *
 * Complexity: O(n) — one pass to group, one pass to assign grid slots.
 */
export function computeLayout(
  agents: Iterable<MeshAgent>,
  now: number,
): Map<string, LayoutEntry> {
  const agentList = Array.from(agents);
  const result = new Map<string, LayoutEntry>();
  if (agentList.length === 0) return result;

  const cfg = LAYOUT_CONFIG;

  // Group by projectId (nodeId)
  const byProject = new Map<string, MeshAgent[]>();
  for (const a of agentList) {
    const pid = a.nodeId || "local";
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid)!.push(a);
  }

  const projects = Array.from(byProject.keys());
  const N = projects.length;
  // World center of the 2400 × 1800 canvas.
  const CX = 1200;
  const CY = 900;

  projects.forEach((pid, pi) => {
    // Project centroid on a ring of radius clusterRadius.
    const pAngle = (pi / N) * Math.PI * 2 - Math.PI / 2;
    const pcx = CX + cfg.clusterRadius * Math.cos(pAngle);
    const pcy = CY + cfg.clusterRadius * Math.sin(pAngle);

    // Sort agents within this project by kind for visual sub-grouping.
    const projectAgents = byProject.get(pid)!.slice();
    projectAgents.sort((a, b) => {
      const ka = a.coderBackend ?? "default";
      const kb = b.coderBackend ?? "default";
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const n = projectAgents.length;
    // Square-root grid layout: adjacent cells are exactly minAgentSpacing apart.
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);

    projectAgents.forEach((agent, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);

      // Center the grid on the project centroid.
      const homeX = pcx + (col - (cols - 1) / 2) * cfg.minAgentSpacing;
      const homeY = pcy + (row - (rows - 1) / 2) * cfg.minAgentSpacing;

      const motion = getOrCreateMotion(agent);
      const isActive = motion.lastActivityTs > 0 && now - motion.lastActivityTs < 8000;

      result.set(agent.sessionKey, {
        sessionKey: agent.sessionKey,
        projectId: pid,
        kind: agent.coderBackend ?? "default",
        homeX,
        homeY,
        isActive,
      });
    });
  });

  return result;
}

// ── Engine adapter — minimal interface avoids importing Pixi ─────────────────

/** Subset of ActivityMap that the layout tick requires. */
export interface LayoutEngineAdapter {
  agentWorldPos(key: string): { x: number; y: number } | null;
  getViewport(): { toScreen(x: number, y: number): { x: number; y: number } } | null;
}

// ── Motion constants ──────────────────────────────────────────────────────────

const IDLE_HZ = 0.35;        // 2.9 s period — slow and calming
const ACTIVE_PERIOD_S = 4.0; // one orbit every 4 s

// ── Per-frame overlay tick ────────────────────────────────────────────────────

/**
 * Apply per-frame layout overlays to the SVG FX layer.
 *
 * Each agent gets a small motion halo that bobs (idle) or orbits (active),
 * making the world feel alive without touching Pixi containers or conflicting
 * with existing GSAP walk animations.
 *
 * Returns true while agents exist (signals renderFx to keep the loop alive).
 *
 * Composition hook location:
 *   agency-world-viz.ts renderFx(), line 1225 — after SVG clear, before pulses.
 */
export function runLayoutTick(
  agents: Map<string, MeshAgent>,
  engine: LayoutEngineAdapter | null,
  svg: SVGSVGElement | null,
  now: number,
): boolean {
  if (!svg || !engine) return false;
  if (agents.size === 0) return false;

  const vp = engine.getViewport?.();
  if (!vp) return false;

  const svgNS = "http://www.w3.org/2000/svg";
  const amp = prefersReducedMotion() ? 0.05 : 1.0; // clamp to near-zero for reduce-motion
  const nowSec = now / 1000;
  const cfg = LAYOUT_CONFIG;

  // ── Prune stale motion states ─────────────────────────────────────────────
  for (const key of _motionStates.keys()) {
    if (!agents.has(key)) _motionStates.delete(key);
  }

  // ── Compact mode: suppress less-recent agents past the threshold ──────────
  const agentList = Array.from(agents.values());
  const compact = agentList.length > cfg.compactThreshold;

  if (compact) {
    const sorted = agentList.slice().sort((a, b) => {
      const ta = _motionStates.get(a.sessionKey)?.lastActivityTs ?? 0;
      const tb = _motionStates.get(b.sessionKey)?.lastActivityTs ?? 0;
      return tb - ta; // most-recent first
    });
    sorted.forEach((a, i) => {
      const s = _motionStates.get(a.sessionKey);
      if (s) s.fadedOut = i >= cfg.compactThreshold;
    });
  } else {
    for (const s of _motionStates.values()) s.fadedOut = false;
  }

  // ── Per-agent overlays ────────────────────────────────────────────────────
  let compactCount = 0;
  let compactSumX = 0;
  let compactSumY = 0;

  for (const agent of agentList) {
    const motion = getOrCreateMotion(agent);
    const isActive = motion.lastActivityTs > 0 && now - motion.lastActivityTs < 8000;

    const pos = engine.agentWorldPos(agent.sessionKey);
    if (!pos) continue;

    // Compact-mode: draw a dim dot, accumulate centroid for "+N more" label.
    if (motion.fadedOut) {
      compactCount++;
      compactSumX += pos.x;
      compactSumY += pos.y;
      const s = vp.toScreen(pos.x, pos.y);
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", String(Math.round(s.x)));
      dot.setAttribute("cy", String(Math.round(s.y)));
      dot.setAttribute("r", "5");
      dot.setAttribute("fill", "#475569");
      dot.setAttribute("opacity", "0.35");
      svg.appendChild(dot);
      continue;
    }

    // ── Animated screen offset (idle bob or active orbit) ─────────────────
    let dx = 0;
    let dy = 0;

    if (isActive) {
      // Elliptical orbit around world-pos: different phase per agent prevents sync.
      const orbitAngle =
        (nowSec * Math.PI * 2) / ACTIVE_PERIOD_S + motion.orbitPhase;
      dx = cfg.activeOrbitRadius * amp * Math.cos(orbitAngle);
      dy = cfg.activeOrbitRadius * 0.55 * amp * Math.sin(orbitAngle);
    } else {
      // Sinusoidal breathing — independent X / Y phases → figure-8 lissajous feel.
      const t = nowSec * IDLE_HZ * Math.PI * 2;
      dx = cfg.idleAmplitude * amp * Math.sin(t + motion.idlePhaseX);
      dy = cfg.idleAmplitude * 0.6 * amp * Math.sin(t + motion.idlePhaseY);
    }

    const screenBase = vp.toScreen(pos.x, pos.y);

    // ── Completion wobble (600 ms) ────────────────────────────────────────
    if (motion.completionBorn > 0 && now - motion.completionBorn < 600) {
      const t = (now - motion.completionBorn) / 600;
      const wobble = Math.sin(t * Math.PI * 8) * 6 * (1 - t);
      const glow = document.createElementNS(svgNS, "circle");
      glow.setAttribute("cx", String(Math.round(screenBase.x + wobble)));
      glow.setAttribute("cy", String(Math.round(screenBase.y)));
      glow.setAttribute("r", String(Math.round(20 + 15 * (1 - t))));
      glow.setAttribute("fill", "#fbbf24");
      glow.setAttribute("opacity", String((0.5 * (1 - t)).toFixed(3)));
      svg.appendChild(glow);
    }

    // ── Error shake (400 ms) ──────────────────────────────────────────────
    if (motion.errorBorn > 0 && now - motion.errorBorn < 400) {
      const t = (now - motion.errorBorn) / 400;
      const shake = Math.sin(t * Math.PI * 12) * 8 * (1 - t);
      const errRing = document.createElementNS(svgNS, "circle");
      errRing.setAttribute("cx", String(Math.round(screenBase.x + shake)));
      errRing.setAttribute("cy", String(Math.round(screenBase.y)));
      errRing.setAttribute("r", "15");
      errRing.setAttribute("fill", "none");
      errRing.setAttribute("stroke", "#ef4444");
      errRing.setAttribute("stroke-width", "2");
      errRing.setAttribute("opacity", String((0.8 * (1 - t)).toFixed(3)));
      svg.appendChild(errRing);
    }

    // ── Motion halo (idle: soft blue bob; active: gold orbit) ────────────
    // Ambient underglow only: radius held at ~50% of its former size (idle 9→4.5,
    // active 13→6.5) and alpha trimmed so the halo sits beneath the agent sprite
    // as a subtle glow the character reads on top of. The completion wobble and
    // error-shake bursts above are event-driven and left untouched.
    const sx = Math.round(screenBase.x + dx);
    const sy = Math.round(screenBase.y + dy);
    const haloColor = isActive ? "#fbbf24" : "#7dd3fc";
    const haloAlpha = isActive ? 0.20 : 0.10;
    const haloR = isActive ? 6.5 : 4.5;

    const halo = document.createElementNS(svgNS, "circle");
    halo.setAttribute("cx", String(sx));
    halo.setAttribute("cy", String(sy));
    halo.setAttribute("r", String(haloR));
    halo.setAttribute("fill", haloColor);
    halo.setAttribute("opacity", String(haloAlpha));
    svg.appendChild(halo);
  }

  // ── Compact "+N more" tile at faded-agent centroid ────────────────────────
  if (compact && compactCount > 0) {
    const s = vp.toScreen(compactSumX / compactCount, compactSumY / compactCount);
    const bg = document.createElementNS(svgNS, "rect");
    bg.setAttribute("x", String(Math.round(s.x - 34)));
    bg.setAttribute("y", String(Math.round(s.y - 12)));
    bg.setAttribute("width", "68");
    bg.setAttribute("height", "24");
    bg.setAttribute("rx", "4");
    bg.setAttribute("fill", "#1e293b");
    bg.setAttribute("opacity", "0.9");
    svg.appendChild(bg);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", String(Math.round(s.x)));
    label.setAttribute("y", String(Math.round(s.y + 5)));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#94a3b8");
    label.setAttribute("font-size", "11");
    label.setAttribute("font-family", "monospace");
    label.textContent = `+${compactCount} more`;
    svg.appendChild(label);
  }

  return true; // keep renderFx loop alive while agents exist
}
