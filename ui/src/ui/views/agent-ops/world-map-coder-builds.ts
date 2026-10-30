/**
 * World-Map Coder Build Layer
 * ───────────────────────────
 * Marks every running coder sub-agent (claude_coder / codex / opencode runs
 * from `subagents.list`) on the agent world map as a "build agent": a ground
 * ring under its sprite plus a floating build tag (task, backend, current tool
 * call, progress). On completion the tag flips to BUILD COMPLETE / BUILD FAILED,
 * lingers briefly, then clears.
 *
 * The sprite itself is the engine's normal agent node (spawned by the bridge's
 * `agent.spawn`, walked between tool sectors by `routeAgentToToolSector`); this
 * layer only anchors DOM chrome to it via `ActivityMap.agentWorldPos`, the
 * same point the FX layers read. It renders as a DOM sibling of the Pixi canvas
 * inside the viz `.host`, like the pinboard / breakdown HUD panels.
 *
 * Data flow: AgencyDataBridge (subagents.list reconcile + subagent.* lifecycle
 * events) → agency-world-viz.applyBatch → `upsert()` / `finish()` here.
 */

import type { MeshAgent } from "./activity-map";
import { rafLoop, type SchedulerHandle } from "../../perf/visibility-scheduler";
import { providerLogoFor, providerLogoUrl } from "./provider-logos";


type Backend = NonNullable<MeshAgent["coderBackend"]>;
type BuildState = "running" | "done" | "failed";

/** Full tags shown before the rest collapse to compact pills. */
const MAX_FULL_TAGS = 5;
/** Tags (full + compact) shown before the remainder fold into a "+N" chip. */
const MAX_VISIBLE_TAGS = 12;
const DONE_LINGER_MS = 4500;
const FAILED_LINGER_MS = 7000;
const LEAVE_MS = 520;
/** Gap between the sprite anchor and the bottom of its tag. */
const TAG_LIFT_PX = 44;
const EDGE_PAD = 8;

const BACKEND_NAME: Record<Backend, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

interface Entry {
  key: string;
  agent: MeshAgent;
  state: BuildState;
  message?: string;
  finishedAt: number;
  leaving: boolean;
  lastPos: { x: number; y: number } | null;
  tag: HTMLDivElement;
  ring: HTMLDivElement;
  leader: HTMLDivElement;
  titleEl: HTMLSpanElement;
  pctEl: HTMLSpanElement;
  subEl: HTMLSpanElement;
  barEl: HTMLSpanElement;
  monoEl: HTMLImageElement;
  rendered: string;
}

/** True when a mesh agent is a coder sub-agent run that should read as a build. */
export function isCoderBuild(agent: Partial<MeshAgent> | undefined): boolean {
  if (!agent) return false;
  if (agent.isBuild) return true;
  const key = agent.sessionKey || "";
  return !!agent.coderBackend && key.includes(":subagent:");
}

/** subagents.list reports 0–100; some producers send 0–1. Normalize to 0–1. */
function progressFraction(p: number | undefined): number {
  const n = Number(p) || 0;
  if (n <= 0) return 0;
  return Math.min(1, n > 1 ? n / 100 : n);
}

/** Strip the "Claude Coder: " style backend prefix the spawners put on labels. */
function cleanTitle(agent: MeshAgent): string {
  const raw = (agent.label && agent.label !== agent.sessionKey ? agent.label : agent.currentTask) || agent.runId || "Build";
  return raw.replace(/^(Claude Coder|OpenCode|Codex|Gemini)\s*[:·-]\s*/i, "").trim() || raw;
}

function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class WorldMapCoderBuilds {
  private readonly root: HTMLDivElement;
  private readonly moreChip: HTMLDivElement;
  private readonly entries = new Map<string, Entry>();
  private loop: SchedulerHandle | null = null;
  private destroyed = false;
  private paused = false;

  constructor(
    host: HTMLElement,
    private readonly getPos: (sessionKey: string) => { x: number; y: number } | null,
    /** Screen rects (host px) tags must keep clear of: floor signs, HUD chrome. */
    private readonly getObstacles: () => Array<{ x: number; y: number; w: number; h: number }> = () => [],
  ) {
    this.root = document.createElement("div");
    this.root.className = "wmcb-root";
    this.root.setAttribute("aria-label", "Running coder builds");
    const style = document.createElement("style");
    style.textContent = WMCB_CSS;
    this.root.appendChild(style);
    this.moreChip = document.createElement("div");
    this.moreChip.className = "wmcb-more";
    this.root.appendChild(this.moreChip);
    host.appendChild(this.root);
  }

  destroy(): void {
    this.destroyed = true;
    this.loop?.cancel();
    this.loop = null;
    this.entries.clear();
    this.root.remove();
  }

  /** Stop animating while the map is off screen (e.g. the 3D view is up); data still updates. */
  setPaused(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    if (on) {
      this.loop?.cancel();
      this.loop = null;
    } else if (this.entries.size) this.ensureLoop();
  }

  /** Number of builds currently drawn (running + finishing). */
  get size(): number {
    return this.entries.size;
  }

  /** Add or refresh a build from a spawn / progress patch. Non-builds are ignored. */
  upsert(agent: MeshAgent): void {
    if (this.destroyed || !isCoderBuild(agent)) return;
    const st = agent.status;
    let e = this.entries.get(agent.sessionKey);
    if (!e) {
      // A run first seen already finished is not a live build — skip it.
      if (st === "completed" || st === "failed") return;
      e = this.createEntry(agent);
      this.entries.set(agent.sessionKey, e);
    } else {
      e.agent = { ...e.agent, ...agent };
    }
    if (st === "completed") this.markFinished(e, "done");
    else if (st === "failed") this.markFinished(e, "failed");
    else if (e.state !== "running" && !e.leaving) {
      // Re-run of the same session — back to building.
      e.state = "running";
      e.message = undefined;
    }
    this.renderEntry(e);
    this.ensureLoop();
  }

  /** Apply a partial patch (agent.progress / agent.tool) to a tracked build. */
  patch(sessionKey: string, patch: Partial<MeshAgent>): void {
    const e = this.entries.get(sessionKey);
    if (e) {
      this.upsert({ ...e.agent, ...patch } as MeshAgent);
      return;
    }
    // A progress patch can promote an agent into a build once its backend is known.
    if (patch.sessionKey && isCoderBuild(patch)) this.upsert(patch as MeshAgent);
  }

  /** Terminal lifecycle event (subagent.complete / .error / .timeout / dropped from list). */
  finish(sessionKey: string, success: boolean, message?: string): void {
    const e = this.entries.get(sessionKey);
    if (!e) return;
    // A run already marked failed stays failed even if a later removal says "ok".
    const state: BuildState = e.state === "failed" ? "failed" : success ? "done" : "failed";
    if (message) e.message = message;
    this.markFinished(e, state);
    this.renderEntry(e);
    this.ensureLoop();
  }

  // ── internals ──────────────────────────────────────────────────────

  private markFinished(e: Entry, state: Exclude<BuildState, "running">): void {
    if (e.state === state && e.finishedAt) return;
    e.state = state;
    e.finishedAt = performance.now();
  }

  private createEntry(agent: MeshAgent): Entry {
    const ring = document.createElement("div");
    ring.className = "wmcb-ring";
    const leader = document.createElement("div");
    leader.className = "wmcb-leader";
    const tag = document.createElement("div");
    tag.className = "wmcb-tag";
    tag.setAttribute("role", "button");
    tag.tabIndex = -1;
    tag.innerHTML = `
      <div class="wmcb-head">
        <img class="wmcb-mono" alt="" draggable="false" />
        <span class="wmcb-title"></span>
        <span class="wmcb-pct"></span>
      </div>
      <span class="wmcb-sub"></span>
      <div class="wmcb-bar"><span></span></div>`;
    tag.addEventListener("click", () => this.openFocus(agent.sessionKey));
    this.root.insertBefore(ring, this.moreChip);
    this.root.insertBefore(leader, this.moreChip);
    this.root.insertBefore(tag, this.moreChip);
    return {
      key: agent.sessionKey,
      agent,
      state: "running",
      finishedAt: 0,
      leaving: false,
      lastPos: null,
      tag,
      ring,
      leader,
      titleEl: tag.querySelector(".wmcb-title") as HTMLSpanElement,
      pctEl: tag.querySelector(".wmcb-pct") as HTMLSpanElement,
      subEl: tag.querySelector(".wmcb-sub") as HTMLSpanElement,
      barEl: tag.querySelector(".wmcb-bar > span") as HTMLSpanElement,
      monoEl: tag.querySelector(".wmcb-mono") as HTMLImageElement,
      rendered: "",
    };
  }

  private openFocus(sessionKey: string): void {
    const e = this.entries.get(sessionKey);
    if (!e) return;
    const a = e.agent;
    window.dispatchEvent(
      new CustomEvent("infinibot:open-agent-focus", {
        detail: {
          agent: {
            runId: a.runId,
            sessionKey: a.sessionKey,
            label: a.label,
            task: a.currentTask,
            status: a.status,
            progress: a.progress,
            coderBackend: a.coderBackend,
          },
        },
      }),
    );
  }

  /** Write text/state into the entry's DOM only when something visible changed. */
  private renderEntry(e: Entry): void {
    const a = e.agent;
    const backend: Backend = a.coderBackend ?? "claude-code";
    const frac = progressFraction(a.progress);
    const pct = Math.round(frac * 100);
    const title = cleanTitle(a);
    let sub: string;
    if (e.state === "done") sub = "Build complete";
    else if (e.state === "failed") sub = e.message ? `Build failed · ${e.message}` : "Build failed";
    else sub = a.activityLabel || (a as { lastActivity?: { label?: string } }).lastActivity?.label || "Building";
    const sig = [backend, title, sub, e.state, pct].join("|");
    if (sig === e.rendered) return;
    e.rendered = sig;
    for (const el of [e.tag, e.ring, e.leader]) {
      el.dataset.backend = backend;
      el.dataset.state = e.state;
    }
    e.monoEl.src = providerLogoUrl(providerLogoFor(backend), true);
    e.monoEl.alt = BACKEND_NAME[backend];
    e.monoEl.title = BACKEND_NAME[backend];
    e.titleEl.textContent = title;
    // Name the CLI in text; the monogram badge is a neutral glyph, not a logo.
    e.subEl.textContent = `${BACKEND_NAME[backend]} · ${sub}`;
    const indeterminate = e.state === "running" && pct === 0;
    e.pctEl.textContent = e.state === "done" ? "100%" : e.state === "failed" ? "ERR" : indeterminate ? "" : `${pct}%`;
    e.tag.classList.toggle("wmcb-tag--indeterminate", indeterminate);
    e.barEl.style.width = e.state === "done" ? "100%" : indeterminate ? "" : `${Math.max(3, pct)}%`;
    e.tag.title = `${BACKEND_NAME[backend]} · ${a.currentTask || title}`;
  }

  private ensureLoop(): void {
    if (this.loop || this.destroyed || this.paused) return;
    this.loop = rafLoop(() => this.frame());
  }

  private removeEntry(e: Entry): void {
    e.tag.remove();
    e.ring.remove();
    e.leader.remove();
    this.entries.delete(e.key);
  }

  private frame(): void {
    if (this.destroyed) return;
    const now = performance.now();
    const W = this.root.clientWidth || 0;
    const H = this.root.clientHeight || 0;

    // 1. Lifecycle: finished builds linger, then leave, then drop.
    for (const e of Array.from(this.entries.values())) {
      if (e.state === "running") continue;
      const age = now - e.finishedAt;
      const linger = e.state === "failed" ? FAILED_LINGER_MS : DONE_LINGER_MS;
      if (age > linger + LEAVE_MS) {
        this.removeEntry(e);
      } else if (age > linger && !e.leaving) {
        e.leaving = true;
        for (const el of [e.tag, e.ring, e.leader]) el.classList.add("wmcb-leaving");
      }
    }
    if (this.entries.size === 0) {
      this.moreChip.classList.remove("wmcb-more--on");
      this.loop?.cancel();
      this.loop = null;
      return;
    }

    // 2. Anchor every build to its sprite (keep the last point once the engine
    //    has removed the sprite so the finish state stays where it happened).
    const list: Array<{ e: Entry; x: number; y: number }> = [];
    for (const e of this.entries.values()) {
      const p = this.getPos(e.key) ?? e.lastPos;
      // Sprite panned out of view: hide its chrome rather than pinning a tag
      // to the viewport edge where it would float over the HUD.
      const offscreen = !!p && (p.x < -30 || p.y < -30 || p.x > W + 30 || p.y > H + 30);
      if (!p || offscreen) {
        e.tag.style.display = e.ring.style.display = e.leader.style.display = "none";
        continue;
      }
      if (this.getPos(e.key)) e.lastPos = p;
      list.push({ e, x: p.x, y: p.y });
    }

    // 3. Priority: finishing builds first (the moment matters), then running by
    //    most progress. Top MAX_FULL_TAGS get full tags, then compact pills,
    //    then fold the rest into the "+N builds" chip.
    list.sort((a, b) => {
      const fa = a.e.state === "running" ? 1 : 0;
      const fb = b.e.state === "running" ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return progressFraction(b.e.agent.progress) - progressFraction(a.e.agent.progress);
    });

    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const obstacles = this.getObstacles();
    let hidden = 0;
    list.forEach((item, i) => {
      const { e } = item;
      e.ring.style.display = "";
      e.ring.style.transform = `translate(${item.x}px, ${item.y}px)`;
      if (i >= MAX_VISIBLE_TAGS) {
        hidden++;
        e.tag.style.display = e.leader.style.display = "none";
        return;
      }
      const compact = i >= MAX_FULL_TAGS;
      e.tag.classList.toggle("wmcb-tag--compact", compact);
      e.tag.style.display = e.leader.style.display = "";
      const w = e.tag.offsetWidth || (compact ? 70 : 200);
      const h = e.tag.offsetHeight || (compact ? 22 : 52);

      // Declutter: try straight above the sprite, then stacked higher, then
      // shifted left/right; first slot that clears every placed tag wins.
      const baseX = item.x - w / 2;
      const baseY = item.y - TAG_LIFT_PX - h;
      const step = h + 6;
      const candidates: Array<[number, number]> = [
        [0, 0], [0, -step], [w / 2 + 6, 0], [-(w / 2 + 6), 0],
        [0, -2 * step], [w / 2 + 6, -step], [-(w / 2 + 6), -step],
        [0, -3 * step], [w + 12, 0], [-(w + 12), 0], [0, step + TAG_LIFT_PX + 24],
      ];
      // First slot clear of every placed tag AND every sign / HUD rect; failing
      // that, the slot clear of tags with the least sign overlap.
      let rect = { x: baseX, y: baseY, w, h };
      let best = Infinity;
      for (const [dx, dy] of candidates) {
        const r = {
          x: Math.max(EDGE_PAD, Math.min(W - w - EDGE_PAD, baseX + dx)),
          y: Math.max(EDGE_PAD, Math.min(H - h - EDGE_PAD, baseY + dy)),
          w,
          h,
        };
        if (placed.some((p) => rectsOverlap(p, r))) continue;
        const cost = obstacles.reduce((sum, o) => sum + overlapArea(o, r), 0);
        if (cost < best) {
          best = cost;
          rect = r;
          if (cost === 0) break;
        }
      }
      placed.push({ x: rect.x - 3, y: rect.y - 3, w: rect.w + 6, h: rect.h + 6 });
      e.tag.style.transform = `translate(${Math.round(rect.x)}px, ${Math.round(rect.y)}px)`;

      // Leader: from the tag's nearest bottom edge point down to the sprite head.
      const lx = Math.max(rect.x + 10, Math.min(rect.x + rect.w - 10, item.x));
      const ly = rect.y + rect.h;
      const tx = item.x;
      const ty = item.y - 18;
      const dx = tx - lx;
      const dy = ty - ly;
      const len = Math.hypot(dx, dy);
      if (len < 4) {
        e.leader.style.display = "none";
      } else {
        e.leader.style.width = `${len}px`;
        e.leader.style.transform = `translate(${lx}px, ${ly}px) rotate(${Math.atan2(dy, dx)}rad)`;
      }
    });

    if (hidden > 0) {
      this.moreChip.textContent = `+${hidden} more build${hidden === 1 ? "" : "s"}`;
      this.moreChip.classList.add("wmcb-more--on");
    } else {
      this.moreChip.classList.remove("wmcb-more--on");
    }
  }
}

// Palette: gold is the house accent (Claude Coder); the other backends reuse
// the map's theme-dot hues so each build reads distinctly without brand art.
const WMCB_CSS = `
.wmcb-root {
  position: absolute; inset: 0; pointer-events: none; z-index: 24; overflow: hidden;
  font-family: var(--font-mono, "JetBrains Mono", ui-monospace, monospace);
}
.wmcb-root [data-backend="claude-code"] { --cb: var(--gx-gold, #d4af37); --cb-rgb: 212,175,55; }
.wmcb-root [data-backend="codex"]       { --cb: #5ec8e0; --cb-rgb: 94,200,224; }
.wmcb-root [data-backend="opencode"]    { --cb: #a78bfa; --cb-rgb: 167,139,250; }
.wmcb-root [data-backend="gemini"]      { --cb: #4ade80; --cb-rgb: 74,222,128; }
.wmcb-root [data-backend="grok"]        { --cb: #f43f5e; --cb-rgb: 244,63,94; }
.wmcb-root [data-state="done"]   { --cb: #7ee2a8; --cb-rgb: 126,226,168; }
.wmcb-root [data-state="failed"] { --cb: #f87171; --cb-rgb: 248,113,113; }

@keyframes wmcb-ring-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(var(--cb-rgb),0.55), inset 0 0 10px rgba(var(--cb-rgb),0.35); }
  70%  { box-shadow: 0 0 0 10px rgba(var(--cb-rgb),0), inset 0 0 10px rgba(var(--cb-rgb),0.35); }
  100% { box-shadow: 0 0 0 0 rgba(var(--cb-rgb),0), inset 0 0 10px rgba(var(--cb-rgb),0.35); }
}
@keyframes wmcb-ring-spin { to { transform: rotate(360deg); } }
@keyframes wmcb-burst {
  from { opacity: 0.9; transform: translate(-50%,-50%) scale(1); }
  to   { opacity: 0;   transform: translate(-50%,-50%) scale(2.6); }
}
@keyframes wmcb-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes wmcb-sweep { from { left: -40%; } to { left: 100%; } }

/* Ground ring: an iso ellipse under the sprite's feet, dashed orbit inside. */
.wmcb-ring {
  position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform;
  animation: wmcb-in .35s ease-out both;
}
.wmcb-ring::before, .wmcb-ring::after {
  content: ""; position: absolute; left: 0; top: 0; border-radius: 50%;
}
.wmcb-ring::before {
  width: 46px; height: 20px; margin: -10px 0 0 -23px;
  border: 1.5px solid rgba(var(--cb-rgb),0.85);
  background: radial-gradient(ellipse at center, rgba(var(--cb-rgb),0.22), rgba(var(--cb-rgb),0) 70%);
  animation: wmcb-ring-pulse 1.8s ease-out infinite;
}
.wmcb-ring::after {
  width: 60px; height: 26px; margin: -13px 0 0 -30px;
  border: 1px dashed rgba(var(--cb-rgb),0.45);
}
.wmcb-ring[data-state="done"]::before,
.wmcb-ring[data-state="failed"]::before {
  animation: wmcb-burst 1.1s ease-out 2 both; margin: 0; left: 0; top: 0;
}

.wmcb-leader {
  position: absolute; left: 0; top: 0; height: 1px; transform-origin: 0 50%;
  background: linear-gradient(90deg, rgba(var(--cb-rgb),0.75), rgba(var(--cb-rgb),0.12));
  will-change: transform;
}

.wmcb-tag {
  position: absolute; left: 0; top: 0; box-sizing: border-box;
  width: 212px; padding: 6px 8px 7px;
  pointer-events: auto; cursor: pointer;
  background: linear-gradient(160deg, rgba(var(--cb-rgb),0.13), rgba(7,6,14,0.9) 55%);
  border: 1px solid rgba(var(--cb-rgb),0.5);
  border-left: 2px solid var(--cb);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.5), 0 0 16px rgba(var(--cb-rgb),0.14);
  color: #efe6cc; will-change: transform;
  animation: wmcb-in .35s ease-out both;
  transition: border-color .2s ease, width .2s ease, opacity .5s ease;
}
.wmcb-tag:hover { border-color: var(--cb); box-shadow: 0 6px 18px rgba(0,0,0,0.5), 0 0 22px rgba(var(--cb-rgb),0.3); }
.wmcb-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wmcb-mono {
  flex: none; width: 14px; height: 14px; object-fit: contain;
}
.wmcb-title {
  flex: 1; min-width: 0; font-size: 10.5px; font-weight: 700; letter-spacing: .02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f6edd2;
}
.wmcb-pct { flex: none; font-size: 10px; font-weight: 700; color: var(--cb); font-variant-numeric: tabular-nums; }
.wmcb-sub {
  display: block; margin: 3px 0 5px; font-size: 9px; letter-spacing: .03em;
  color: rgba(239,230,204,0.62); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wmcb-tag[data-state="done"] .wmcb-sub,
.wmcb-tag[data-state="failed"] .wmcb-sub { color: var(--cb); font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
.wmcb-bar { position: relative; height: 3px; border-radius: 2px; overflow: hidden; background: rgba(var(--cb-rgb),0.16); }
.wmcb-bar > span {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 2px;
  background: linear-gradient(90deg, rgba(var(--cb-rgb),0.55), var(--cb));
  box-shadow: 0 0 8px rgba(var(--cb-rgb),0.6); transition: width .6s ease;
}
.wmcb-tag--indeterminate .wmcb-bar > span { width: 40%; animation: wmcb-sweep 1.6s ease-in-out infinite; }

/* Compact pill for builds past the full-tag budget. */
.wmcb-tag--compact { width: auto; padding: 3px 6px; border-radius: 11px; }
.wmcb-tag--compact .wmcb-title, .wmcb-tag--compact .wmcb-sub, .wmcb-tag--compact .wmcb-bar { display: none; }

.wmcb-leaving { opacity: 0 !important; transition: opacity .5s ease; }

.wmcb-more {
  position: absolute; left: 50%; bottom: 58px; transform: translateX(-50%);
  display: none; padding: 4px 10px; border-radius: 11px; font-size: 10px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase; color: var(--gx-gold-lt, #e9c46a);
  background: rgba(7,6,14,0.85); border: 1px solid var(--gx-gold-15, rgba(212,175,55,0.3));
}
.wmcb-more--on { display: block; }
`;
