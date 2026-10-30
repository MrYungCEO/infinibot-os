/**
 * Hardware Analysis — bklit-style data viz layered over the InfiniBot glass
 * theme system.
 *
 * The data layer (federation stream + single-host fallback, snapshot ingest,
 * value tween) is frozen — the gateway contract and HardwareSnapshot shape
 * are untouched. The rendering layer was rebuilt around the global --g-*
 * token system so palette / mode switches recolor this view in lockstep
 * with the rest of the app.
 */

import { LitElement, html, css, svg, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { icons } from "../icons.js";
import type { HardwareSnapshot } from "../../../../src/gateway/server-hardware-http.js";

const HISTORY_LEN = 60;
const VIEW_MODE_STORAGE_KEY = "infinibot.hardware.viewMode";
type HwViewMode = "focus" | "fleet";

// ─── Federation payload type (mirrors NodeHardwareEntry on the server) ───────

interface NodeHardwareEntry {
  nodeId: string;
  nodeName: string;
  role: "master" | "satellite" | "standalone";
  isLocal: boolean;
  online: boolean;
  health: "online" | "stale" | "offline";
  lastSeen: number;
  ageMs: number;
  snapshot: HardwareSnapshot | null;
}

interface NodeHardwareMap {
  role: "master" | "standalone";
  nodes: NodeHardwareEntry[];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtBytes(b: number, decimals = 1): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(decimals)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(decimals)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

type Severity = "NOMINAL" | "ELEVATED" | "CRITICAL";

function systemStatus(cpu: number, mem: number, gpu: number): Severity {
  const max = Math.max(cpu, mem, gpu);
  if (max >= 90) return "CRITICAL";
  if (max >= 75) return "ELEVATED";
  return "NOMINAL";
}

// Metric → semantic CSS token. Single source of truth so we never inline
// raw hex/rgba — palette swaps recolor every chart line in lockstep.
type Metric = "cpu" | "gpu" | "ram" | "net" | "disk";
const METRIC_VAR: Record<Metric, string> = {
  cpu: "var(--g-metric-cpu)",
  gpu: "var(--g-metric-gpu)",
  ram: "var(--g-metric-ram)",
  net: "var(--g-metric-net)",
  disk: "var(--g-metric-disk)",
};

// Color a metric value, escalating through warn → danger as it climbs.
function metricColor(metric: Metric, pct?: number): string {
  if (pct != null) {
    if (pct >= 90) return "var(--g-state-danger)";
    if (pct >= 80) return "var(--g-state-warn)";
  }
  return METRIC_VAR[metric];
}

function makeLogLine(snap: HardwareSnapshot, idx: number): string {
  const t = (snap.system.uptimeSec + idx * 0.97).toFixed(2);
  const variants = [
    `[ ${t}s ] cpu.load → 1m:${snap.cpu.loadAvg[0]}  5m:${snap.cpu.loadAvg[1]}  15m:${snap.cpu.loadAvg[2]}`,
    `[ ${t}s ] cpu.util → ${snap.cpu.percent}%  cores:${snap.cpu.cores}`,
    `[ ${t}s ] mem.pressure → ${snap.memory.percent}%  free:${fmtBytes(snap.memory.freeBytes, 1)}`,
    snap.gpu
      ? `[ ${t}s ] gpu.load → util:${snap.gpu.utilizationPercent}%  vram:${fmtBytes(snap.gpu.vramUsedBytes, 1)}`
      : `[ ${t}s ] gpu → not detected / cpu-only mode`,
    `[ ${t}s ] net.egress → ${snap.network.interfaces[0] ? fmtBytes(snap.network.interfaces[0].txBytesPerSec) + "/s" : "n/a"}`,
    `[ ${t}s ] disk.root → ${snap.disk.mounts[0] ? snap.disk.mounts[0].percent + "%" : "n/a"}  host:${snap.system.hostname}`,
    `[ ${t}s ] kernel.ver → ${snap.system.kernelRelease}`,
    `[ ${t}s ] sys.arch → ${snap.system.platform}/${snap.system.arch}  up:${fmtUptime(snap.system.uptimeSec)}`,
  ];
  return variants[Math.abs(idx) % variants.length];
}

// ─── Insight generation ───────────────────────────────────────────────────────

interface Insight {
  severity: "info" | "warn" | "critical";
  message: string;
}

function generateInsights(history: HardwareSnapshot[]): Insight[] {
  if (history.length === 0) return [{ severity: "info", message: "Collecting metrics…" }];
  const latest = history[history.length - 1];
  const insights: Insight[] = [];
  const cpuPct = latest.cpu.percent;
  if (cpuPct >= 90) insights.push({ severity: "critical", message: `CPU critical (${cpuPct}%) — consider closing background tasks` });
  else if (cpuPct >= 80) insights.push({ severity: "warn", message: `CPU running hot (${cpuPct}%) — monitor closely` });
  if (history.length >= 10) {
    const recent = history.slice(-10).map((h) => h.cpu.percent);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const older = history.slice(-30, -10).map((h) => h.cpu.percent);
    if (older.length > 0) {
      const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
      if (avg - olderAvg > 15) insights.push({ severity: "warn", message: `CPU load rising rapidly (+${Math.round(avg - olderAvg)}% over 30s)` });
    }
  }
  const memPct = latest.memory.percent;
  if (memPct >= 90) insights.push({ severity: "critical", message: `Memory critical (${memPct}%) — ${fmtBytes(latest.memory.freeBytes)} free` });
  else if (memPct >= 80) insights.push({ severity: "warn", message: `Memory pressure (${memPct}%) — ${fmtBytes(latest.memory.freeBytes)} free` });
  if (history.length >= 20) {
    const rAvg = history.slice(-5).map((h) => h.memory.percent).reduce((a, b) => a + b, 0) / 5;
    const oAvg = history.slice(-20, -10).map((h) => h.memory.percent).reduce((a, b) => a + b, 0) / 10;
    if (rAvg - oAvg > 10) insights.push({ severity: "warn", message: `Memory pressure rising over last 30s (+${Math.round(rAvg - oAvg)}%)` });
  }
  const gpu = latest.gpu;
  if (gpu) {
    if (gpu.utilizationPercent >= 90) insights.push({ severity: "warn", message: `GPU saturated (${gpu.utilizationPercent}%) on ${gpu.name}` });
    else if (gpu.utilizationPercent < 5) insights.push({ severity: "info", message: `GPU idle — safe to schedule training or generation tasks` });
    const vramPct = gpu.vramTotalBytes > 0 ? Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100) : 0;
    if (vramPct >= 85) insights.push({ severity: "warn", message: `VRAM high (${vramPct}%) — ${fmtBytes(gpu.vramTotalBytes - gpu.vramUsedBytes)} free` });
  } else {
    insights.push({ severity: "info", message: "No GPU detected — CPU-only compute available" });
  }
  for (const iface of latest.network.interfaces) {
    if (iface.txBytesPerSec > 10 * 1024 * 1024) insights.push({ severity: "warn", message: `Network egress spike on ${iface.name}: ${fmtBytes(iface.txBytesPerSec)}/s` });
    if (iface.rxBytesPerSec > 50 * 1024 * 1024) insights.push({ severity: "info", message: `High ingress on ${iface.name}: ${fmtBytes(iface.rxBytesPerSec)}/s` });
  }
  for (const mount of latest.disk.mounts) {
    if (mount.percent >= 90) insights.push({ severity: "critical", message: `Disk ${mount.path} nearly full (${mount.percent}%)` });
    else if (mount.percent >= 75) insights.push({ severity: "warn", message: `Disk ${mount.path} filling up (${mount.percent}%)` });
  }
  if (insights.length === 0) {
    insights.push({ severity: "info", message: "System healthy — all metrics within normal range" });
    if (gpu) insights.push({ severity: "info", message: `${gpu.name} ready — ${Math.round((1 - gpu.vramUsedBytes / gpu.vramTotalBytes) * 100)}% VRAM free` });
    insights.push({ severity: "info", message: `Load avg: ${latest.cpu.loadAvg[0]} / ${latest.cpu.loadAvg[1]} / ${latest.cpu.loadAvg[2]}` });
  }
  const order = { critical: 0, warn: 1, info: 2 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);
  return insights.slice(0, 6);
}

// ─── Process panel sorting ────────────────────────────────────────────────────

type ProcSortField = "cpu" | "mem" | "pid" | "name";
type SortDir = "asc" | "desc";

interface ProcessLike {
  name: string;
  pid: number;
  cpuPercent: number;
  memoryBytes: number;
}

function sortProcs(procs: ProcessLike[], field: ProcSortField, dir: SortDir): ProcessLike[] {
  const sign = dir === "asc" ? 1 : -1;
  const out = [...procs];
  out.sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    switch (field) {
      case "cpu":  av = a.cpuPercent; bv = b.cpuPercent; break;
      case "mem":  av = a.memoryBytes; bv = b.memoryBytes; break;
      case "pid":  av = a.pid; bv = b.pid; break;
      case "name": av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
    }
    if (av < bv) return -1 * sign;
    if (av > bv) return  1 * sign;
    return 0;
  });
  return out;
}

// ─── LitElement ───────────────────────────────────────────────────────────────

@customElement("hardware-analysis")
export class HardwareAnalysis extends LitElement {
  @state() private latest: HardwareSnapshot | null = null;
  @state() private history: HardwareSnapshot[] = [];
  @state() private displayCpu = 0;
  @state() private displayMem = 0;
  @state() private displayGpu = 0;
  @state() private connected = false;
  @state() private error: string | null = null;
  @state() private time = new Date().toLocaleTimeString();
  @state() private logLines: string[] = [];
  @state() private sampleTick = 0;
  @state() private caretVisible = true;

  // ─── Federation state ─────────────────────────────────────────────────
  @state() private nodes: NodeHardwareEntry[] = [];
  @state() private federationRole: "master" | "standalone" = "standalone";
  @state() private selectedNodeId: string | null = null;
  private nodeHistory = new Map<string, HardwareSnapshot[]>();

  // ─── View mode (FOCUS = one node's full detail, FLEET = every node card grid)
  // Defaults to FLEET when more than one node is in the roster so multi-device
  // setups land on the overview; single-node installs stay on FOCUS.
  @state() private viewMode: HwViewMode = "focus";
  private viewModeRestored = false;

  // ─── View state (display-only, not part of the data contract) ─────────
  @state() private procSortField: ProcSortField = "cpu";
  @state() private procSortDir: SortDir = "desc";
  @state() private hoverProcPid: number | null = null;
  /** Sparkline hover position keyed by spark id; null/undefined = no hover. */
  @state() private sparkHoverX: Record<string, number> = {};

  private es: EventSource | null = null;
  private nodesEs: EventSource | null = null;
  private tweenRaf: number | null = null;
  private clockInterval: number | null = null;
  private caretInterval: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    try {
      const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === "focus" || stored === "fleet") {
        this.viewMode = stored;
        this.viewModeRestored = true;
      }
    } catch { /* localStorage may be unavailable */ }
    void this.probeAndStart();
    this.clockInterval = window.setInterval(() => {
      this.time = new Date().toLocaleTimeString();
    }, 1000);
    this.caretInterval = window.setInterval(() => {
      this.caretVisible = !this.caretVisible;
    }, 530);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopStream();
    this.stopNodesStream();
    if (this.tweenRaf !== null) cancelAnimationFrame(this.tweenRaf);
    if (this.clockInterval !== null) clearInterval(this.clockInterval);
    if (this.caretInterval !== null) clearInterval(this.caretInterval);
  }

  private async probeAndStart() {
    try {
      const res = await fetch("/api/hardware/nodes");
      if (res.ok) {
        const map: NodeHardwareMap = await res.json();
        this.ingestNodeMap(map);
        this.startNodesStream();
        return;
      }
    } catch { /* fall through */ }
    this.startStream();
  }

  private startStream() {
    this.stopStream();
    this.es = new EventSource("/api/hardware/stream");
    this.es.addEventListener("message", (e: MessageEvent) => {
      try {
        const snap: HardwareSnapshot = JSON.parse(e.data as string);
        this.ingestSnapshot(snap);
        this.connected = true;
        this.error = null;
      } catch { /* ignore */ }
    });
    this.es.addEventListener("error", () => {
      this.connected = false;
      this.error = "Stream disconnected — retrying…";
    });
  }

  private stopStream() {
    if (this.es) { this.es.close(); this.es = null; }
  }

  private startNodesStream() {
    this.stopNodesStream();
    this.nodesEs = new EventSource("/api/hardware/nodes/stream");
    this.nodesEs.addEventListener("message", (e: MessageEvent) => {
      try {
        const map: NodeHardwareMap = JSON.parse(e.data as string);
        this.ingestNodeMap(map);
        this.connected = true;
        this.error = null;
      } catch { /* ignore */ }
    });
    this.nodesEs.addEventListener("error", () => {
      this.connected = false;
      this.error = "Federation stream disconnected — retrying…";
    });
  }

  private stopNodesStream() {
    if (this.nodesEs) { this.nodesEs.close(); this.nodesEs = null; }
  }

  private ingestNodeMap(map: NodeHardwareMap) {
    this.federationRole = map.role;
    this.nodes = map.nodes;

    for (const n of map.nodes) {
      if (!n.snapshot) continue;
      const prior = this.nodeHistory.get(n.nodeId) ?? [];
      if (prior.length > 0 && prior[prior.length - 1].timestamp === n.snapshot.timestamp) continue;
      const next = [...prior.slice(-(HISTORY_LEN - 1)), n.snapshot];
      this.nodeHistory.set(n.nodeId, next);
    }
    const present = new Set(map.nodes.map((n) => n.nodeId));
    for (const id of [...this.nodeHistory.keys()]) {
      if (!present.has(id)) this.nodeHistory.delete(id);
    }

    let selected = this.selectedNodeId && present.has(this.selectedNodeId) ? this.selectedNodeId : null;
    if (!selected) {
      selected = map.nodes.find((n) => n.isLocal)?.nodeId ?? map.nodes[0]?.nodeId ?? null;
    }
    this.selectedNodeId = selected;

    // First time we see a multi-node roster, snap to FLEET so the overview
    // becomes the landing experience. Honors any user pick already restored
    // from localStorage on connect.
    if (!this.viewModeRestored && map.nodes.length > 1) {
      this.viewMode = "fleet";
      this.viewModeRestored = true;
    }

    const focus = map.nodes.find((n) => n.nodeId === selected);
    if (focus?.snapshot) {
      this.history = this.nodeHistory.get(focus.nodeId) ?? [];
      this.latest = focus.snapshot;
      this.tweenTo(
        focus.snapshot.cpu.percent,
        focus.snapshot.memory.percent,
        focus.snapshot.gpu?.utilizationPercent ?? 0,
      );
      this.sampleTick += 1;
      const newLine = makeLogLine(focus.snapshot, this.sampleTick);
      this.logLines = [newLine, ...this.logLines].slice(0, 4);
    }
  }

  private selectNode(nodeId: string) {
    if (this.selectedNodeId !== nodeId) {
      this.selectedNodeId = nodeId;
      const n = this.nodes.find((x) => x.nodeId === nodeId);
      if (n?.snapshot) {
        this.history = this.nodeHistory.get(nodeId) ?? [];
        this.latest = n.snapshot;
        this.tweenTo(
          n.snapshot.cpu.percent,
          n.snapshot.memory.percent,
          n.snapshot.gpu?.utilizationPercent ?? 0,
        );
      }
    }
    // Drilling into a fleet card transitions to the per-node FOCUS detail view.
    if (this.viewMode !== "focus") this.setViewMode("focus");
  }

  private setViewMode(mode: HwViewMode) {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.viewModeRestored = true;
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch { /* ignore */ }
  }

  private ingestSnapshot(snap: HardwareSnapshot) {
    this.latest = snap;
    this.history = [...this.history.slice(-(HISTORY_LEN - 1)), snap];
    this.tweenTo(snap.cpu.percent, snap.memory.percent, snap.gpu?.utilizationPercent ?? 0);
    this.sampleTick += 1;
    const newLine = makeLogLine(snap, this.sampleTick);
    this.logLines = [newLine, ...this.logLines].slice(0, 4);
  }

  private tweenTo(targetCpu: number, targetMem: number, targetGpu: number) {
    if (this.tweenRaf !== null) cancelAnimationFrame(this.tweenRaf);
    const startCpu = this.displayCpu, startMem = this.displayMem, startGpu = this.displayGpu;
    const duration = 600, start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.displayCpu = Math.round(lerp(startCpu, targetCpu, ease));
      this.displayMem = Math.round(lerp(startMem, targetMem, ease));
      this.displayGpu = Math.round(lerp(startGpu, targetGpu, ease));
      if (t < 1) this.tweenRaf = requestAnimationFrame(frame);
      else this.tweenRaf = null;
    };
    this.tweenRaf = requestAnimationFrame(frame);
  }

  // ─── Process panel handlers ──────────────────────────────────────────

  private toggleProcSort(field: ProcSortField) {
    if (this.procSortField === field) {
      this.procSortDir = this.procSortDir === "asc" ? "desc" : "asc";
    } else {
      this.procSortField = field;
      // CPU/MEM default to desc (worst-first), name/pid default to asc.
      this.procSortDir = (field === "cpu" || field === "mem") ? "desc" : "asc";
    }
  }

  // ─── Sparkline hover handlers ────────────────────────────────────────

  private onSparkMove(e: MouseEvent, id: string, viewBoxW: number) {
    const svgEl = e.currentTarget as SVGSVGElement;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * viewBoxW;
    if (Math.abs((this.sparkHoverX[id] ?? -1) - x) < 0.5) return;
    this.sparkHoverX = { ...this.sparkHoverX, [id]: x };
  }

  private onSparkLeave(id: string) {
    if (this.sparkHoverX[id] == null) return;
    const next = { ...this.sparkHoverX };
    delete next[id];
    this.sparkHoverX = next;
  }

  // ─── Render helpers ──────────────────────────────────────────────────

  private renderCommandBar() {
    const snap = this.latest;
    const uptime = snap ? fmtUptime(snap.system.uptimeSec) : "--";
    const host = snap?.system.hostname ?? "…";
    const rate = `${this.sampleTick > 0 ? "1" : "0"}Hz`;
    const status = systemStatus(this.displayCpu, this.displayMem, this.displayGpu);
    const nodeCount = this.nodes.length;
    return html`
      <div class="cmd-bar">
        <div class="cmd-path">
          <span class="cmd-seg dim">infinibot</span>
          <span class="cmd-arrow">❯</span>
          <span class="cmd-seg">hardware-analysis</span>
          <span class="cmd-arrow">❯</span>
          <span class="cmd-seg accent">${this.viewMode === "fleet" ? "fleet" : "live"}</span>
        </div>
        ${this.renderViewModeToggle(nodeCount)}
        <div class="cmd-stats">
          <span class="cmd-chip">up · ${uptime}</span>
          <span class="cmd-chip">host · ${host}</span>
          <span class="cmd-chip">${rate}</span>
          <span class="status-pill pill-${status.toLowerCase()}">${status}</span>
        </div>
        <div class="cmd-caret ${this.caretVisible ? "blink-on" : "blink-off"}">▋</div>
      </div>
    `;
  }

  // Pill toggle that flips between per-node FOCUS view and fleet-wide overview.
  // Always visible so the affordance is discoverable — single-node installs
  // disable the FLEET pill rather than hide the toggle.
  private renderViewModeToggle(nodeCount: number) {
    const fleetEnabled = nodeCount > 1;
    return html`
      <div class="vm-toggle" role="group" aria-label="View mode">
        <button
          type="button"
          class="vm-pill ${this.viewMode === "focus" ? "vm-pill-active" : ""}"
          @click=${() => this.setViewMode("focus")}
          title="Focus on the selected node"
        >
          <span class="vm-glyph">◎</span>
          <span class="vm-label">FOCUS</span>
        </button>
        <button
          type="button"
          class="vm-pill ${this.viewMode === "fleet" ? "vm-pill-active" : ""} ${fleetEnabled ? "" : "vm-pill-disabled"}"
          @click=${() => fleetEnabled && this.setViewMode("fleet")}
          ?disabled=${!fleetEnabled}
          title=${fleetEnabled ? "Show every federation node at once" : "Connect more nodes to enable fleet view"}
        >
          <span class="vm-glyph">▦</span>
          <span class="vm-label">FLEET</span>
          ${fleetEnabled ? html`<span class="vm-count">${nodeCount}</span>` : nothing}
        </button>
      </div>
    `;
  }

  // Compact tile of recent telemetry — pinned top-right of the page.
  private renderTelemetryStrip() {
    const snap = this.latest;
    if (!snap) return nothing;
    const ifaces = snap.network.interfaces.slice(0, 2);
    return html`
      <div class="telemetry-strip">
        <div class="section-eyebrow">net · live</div>
        ${ifaces.map((i) => html`
          <div class="tel-row">
            <span class="tel-name">${i.name}</span>
            <span class="tel-val">↑${fmtBytes(i.txBytesPerSec, 0)}/s</span>
            <span class="tel-val down">↓${fmtBytes(i.rxBytesPerSec, 0)}/s</span>
          </div>
        `)}
        <div class="tel-divider"></div>
        <div class="tel-row">
          <span class="tel-name">pkt</span>
          <span class="tel-val">${this.sampleTick} samples</span>
        </div>
      </div>
    `;
  }

  /**
   * Two-tone concentric ring gauge.
   * - Outer thick arc: primary metric (e.g. CPU util).
   * - Inner thin arc: secondary metric (e.g. CPU load avg / VRAM use).
   * - Center: large numeric → small unit → tiny sub-label, all in a
   *   typographic hierarchy.
   *
   * Bklit techniques applied here:
   *   • "ring gauge with inner secondary metric"
   *   • large numeric + tiny sub-label hierarchy
   *   • tick ring with long-every-5 spacing for analog readability
   */
  private renderConcentricGauge(
    label: string,
    id: string,
    pctMain: number,
    pctInner: number,
    subLabel: string,
    metric: Metric,
    ringLabels?: { main: string; inner: string }
  ) {
    const colorMain = metricColor(metric, pctMain);
    const status: Severity = pctMain >= 90 ? "CRITICAL" : pctMain >= 75 ? "ELEVATED" : "NOMINAL";
    const isLoaded = pctMain > 70;
    const gradId = `gauge-grad-${metric}-${id}`;

    // Geometry (viewBox 0 0 120 120)
    const rCrown = 56;    // outer tick-crown — instrument feel
    const rMain  = 45;    // primary value ring
    const rInner = 33;    // secondary value ring

    // Tick crown: 24 micro-ticks OUTSIDE the main ring at 12% opacity,
    // amplified to 60-85% along the active arc — the "active region
    // highlight" that gives the rings their premium HUD instrument
    // feel. Uses --gauge-color so palette swaps recolor the crown.
    const N_TICKS = 24;
    const activeSpan = (pctMain / 100) * N_TICKS;
    const tickCrown = Array.from({ length: N_TICKS }, (_, i) => {
      const angle = (i / N_TICKS) * 2 * Math.PI;
      const isLong = i % 6 === 0;
      const r1 = isLong ? rCrown - 6 : rCrown - 3;
      const x1 = (60 + r1 * Math.cos(angle)).toFixed(2);
      const y1 = (60 + r1 * Math.sin(angle)).toFixed(2);
      const x2 = (60 + rCrown * Math.cos(angle)).toFixed(2);
      const y2 = (60 + rCrown * Math.sin(angle)).toFixed(2);
      const inActive = i < activeSpan;
      return svg`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="var(--gauge-color)"
        stroke-opacity="${inActive ? (isLong ? 0.85 : 0.6) : 0.12}"
        stroke-width="${isLong ? 1.2 : 0.75}"
        stroke-linecap="round"/>`;
    });

    // Arc geometry
    const arcCircMain = 2 * Math.PI * rMain;
    const arcOffsetMain = (arcCircMain * (1 - pctMain / 100)).toFixed(1);
    const arcCircInner = 2 * Math.PI * rInner;
    const arcOffsetInner = (arcCircInner * (1 - pctInner / 100)).toFixed(1);

    const dispVal = pctMain.toString().padStart(2, "0");

    return html`
      <div
        class="gauge-card gauge-${metric} status-${status.toLowerCase()} ${isLoaded ? "is-loaded" : ""}"
      >
        <div class="card-id">[${metric.toUpperCase()}·${id}]</div>
        <div class="gauge-label">${label}</div>
        <div class="gauge-ring-wrap">
          <svg viewBox="0 0 120 120" class="gauge-svg">
            <defs>
              <!-- Active-arc gradient: deepens the metric tone at the
                   start of the arc and brightens it at the end so the
                   ring reads with light travelling around it. -->
              <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%"   stop-color="var(--gauge-color)" stop-opacity="0.45"/>
                <stop offset="55%"  stop-color="var(--gauge-color)" stop-opacity="0.92"/>
                <stop offset="100%" stop-color="var(--gauge-color)" stop-opacity="1"/>
              </linearGradient>
            </defs>
            <!-- Track rings — low-alpha gauge color for the inset recess -->
            <circle cx="60" cy="60" r="${rMain}" fill="none"
              stroke="color-mix(in oklab, var(--gauge-color) 14%, transparent)"
              stroke-width="10"/>
            <circle cx="60" cy="60" r="${rInner}" fill="none"
              stroke="color-mix(in oklab, var(--gauge-color) 10%, transparent)"
              stroke-width="3"/>
            <!-- Decorative tick crown -->
            ${tickCrown}
            <!-- Secondary inner arc (thin, full-opacity active) -->
            <circle cx="60" cy="60" r="${rInner}"
              fill="none" stroke="var(--gauge-color)"
              stroke-width="3"
              stroke-dasharray="${arcCircInner.toFixed(1)}"
              stroke-dashoffset="${arcOffsetInner}"
              stroke-linecap="round"
              class="ring-inner-fill"/>
            <!-- Primary outer arc (thick, gradient stroke + outer glow) -->
            <circle cx="60" cy="60" r="${rMain}"
              fill="none" stroke="url(#${gradId})"
              stroke-width="10"
              stroke-dasharray="${arcCircMain.toFixed(1)}"
              stroke-dashoffset="${arcOffsetMain}"
              stroke-linecap="round"
              class="ring-main-fill"/>
            <!-- Centered readout: large numeric, % unit beside, metric tag + sub label below -->
            <text x="60" y="56" class="gauge-pct-val" fill="${colorMain}">${dispVal}</text>
            <text x="60" y="56" dx="20" class="gauge-pct-unit" fill="${colorMain}">%</text>
            <text x="60" y="74" class="gauge-pct-metric">${metric.toUpperCase()}</text>
            <text x="60" y="84" class="gauge-sub">${subLabel}</text>
          </svg>
        </div>
        ${ringLabels ? html`
          <div class="ring-legend">
            <div class="ring-legend-row main">
              <span class="ring-legend-label">${ringLabels.main}</span>
              <span class="ring-legend-val">${pctMain}<span class="ring-legend-unit">%</span></span>
            </div>
            <div class="ring-legend-row inner">
              <span class="ring-legend-label">${ringLabels.inner}</span>
              <span class="ring-legend-val">${pctInner}<span class="ring-legend-unit">%</span></span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  /**
   * Bklit-style sparkline.
   *
   * Techniques applied:
   *   • 1.5px stroke over a filled gradient (semantic color → transparent)
   *   • subtle dashed 1px baseline grid (3 horizontal divisions)
   *   • "label-on-axis-end" pattern — last-value text pinned to the line head
   *   • hover crosshair: dashed vertical guideline + dot pinned to the line
   */
  private renderSparkline(label: string, history: number[], metric: Metric, sparkId: string) {
    const W = 240, H = 64;
    const padX = 6, padTop = 8, padBot = 4;
    const innerW = W - padX * 2;
    const innerH = H - padTop - padBot;

    const colorVar = METRIC_VAR[metric];
    const now = history.length > 0 ? history[history.length - 1] : 0;
    const min = history.length > 0 ? Math.min(...history) : 0;
    const max = history.length > 0 ? Math.max(...history) : 0;
    const avg = history.length > 0 ? Math.round(history.reduce((a, b) => a + b, 0) / history.length) : 0;

    const step = innerW / (HISTORY_LEN - 1);
    const pts = history.map((v, i) => ({
      x: padX + i * step,
      y: padTop + innerH - (Math.max(0, Math.min(100, v)) / 100) * innerH,
      v,
    }));

    let lineD = "";
    let areaD = "";
    if (pts.length >= 2) {
      lineD = pts.reduce((d, p, i) =>
        d + (i === 0 ? `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}` : ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
        "",
      );
      const baselineY = (padTop + innerH).toFixed(1);
      const first = pts[0], last = pts[pts.length - 1];
      areaD = `${lineD} L ${last.x.toFixed(1)} ${baselineY} L ${first.x.toFixed(1)} ${baselineY} Z`;
    }

    // Baseline grid: 3 dashed horizontal divisions at 25/50/75%.
    const gridYs = [25, 50, 75].map((p) => padTop + innerH - (p / 100) * innerH);

    const lastPt = pts[pts.length - 1];

    // Hover state — derive nearest data point.
    const hoverX = this.sparkHoverX[sparkId];
    let cursor: typeof pts[number] | null = null;
    let cursorIdx = -1;
    if (hoverX != null && pts.length > 1) {
      const idx = Math.max(0, Math.min(pts.length - 1, Math.round((hoverX - padX) / step)));
      cursor = pts[idx];
      cursorIdx = idx;
    }
    const showLast = lastPt && !cursor;

    return html`
      <div class="spark-block">
        <div class="spark-head">
          <span class="spark-label">${label}</span>
          <span class="spark-stats">
            <span class="spark-now" style="color: ${colorVar}">${cursor ? Math.round(cursor.v) : now}<span class="spark-unit">%</span></span>
            <span class="spark-mm">min ${min} · max ${max} · avg ${avg}</span>
          </span>
        </div>
        <div class="spark-wrap">
          <svg viewBox="0 0 ${W} ${H}" class="spark-svg" preserveAspectRatio="none"
               @mousemove=${(e: MouseEvent) => this.onSparkMove(e, sparkId, W)}
               @mouseleave=${() => this.onSparkLeave(sparkId)}>
            <defs>
              <linearGradient id="${sparkId}-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${colorVar}" stop-opacity="0.40"/>
                <stop offset="100%" stop-color="${colorVar}" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <!-- Baseline grid (subtle, dashed) -->
            ${gridYs.map((y) => svg`<line
              x1="${padX}" y1="${y.toFixed(1)}"
              x2="${(W - padX).toFixed(1)}" y2="${y.toFixed(1)}"
              stroke="var(--g-border)" stroke-width="0.8"
              stroke-dasharray="3 4" opacity="0.55"/>`)}
            <!-- Area fill -->
            ${areaD ? svg`<path d="${areaD}" fill="url(#${sparkId}-grad)"/>` : nothing}
            <!-- Line stroke -->
            ${lineD ? svg`<path d="${lineD}" fill="none" stroke="${colorVar}"
              stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` : nothing}
            <!-- Last-value end dot + label (label-on-axis-end pattern) -->
            ${showLast && lastPt ? svg`
              <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.6"
                fill="${colorVar}" stroke="var(--g-bg)" stroke-width="1.4"/>
            ` : nothing}
            <!-- Hover crosshair: vertical guideline + dot -->
            ${cursor ? svg`
              <line x1="${cursor.x.toFixed(1)}" y1="${padTop}"
                x2="${cursor.x.toFixed(1)}" y2="${(padTop + innerH).toFixed(1)}"
                stroke="${colorVar}" stroke-width="1" opacity="0.55"
                stroke-dasharray="2 3"/>
              <circle cx="${cursor.x.toFixed(1)}" cy="${cursor.y.toFixed(1)}" r="3.2"
                fill="${colorVar}" stroke="var(--g-bg-deep)" stroke-width="1.4"/>
            ` : nothing}
          </svg>
          ${cursor ? html`
            <div class="spark-tooltip" style="left: ${((cursor.x / W) * 100).toFixed(1)}%; color: ${colorVar};">
              ${Math.round(cursor.v)}% · sample ${cursorIdx + 1}/${pts.length}
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private renderLogStrip() {
    const lines = this.logLines.length > 0
      ? this.logLines
      : ["[ 0.00s ] awaiting telemetry stream…", "[ 0.00s ] connecting to /api/hardware/stream", "[ 0.00s ] …", "[ 0.00s ] …"];
    return html`
      <div class="log-strip">
        <div class="section-head">
          <span class="section-dot"></span>
          <span class="section-eyebrow">kernel telemetry</span>
          <span class="section-meta">${this.sampleTick} events</span>
        </div>
        <div class="log-lines">
          ${lines.map((l, i) => html`
            <div class="log-line ${i === 0 ? "log-newest" : ""}">
              <span class="log-prompt">$</span>${l}
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private renderWireframeGlyph(type: "cpu" | "gpu" | "ram") {
    const c = `var(--g-metric-${type})`;
    if (type === "cpu") {
      return svg`
        <svg class="wf-glyph" viewBox="0 0 48 56" fill="none">
          <rect x="12" y="12" width="24" height="24" stroke="${c}" stroke-width="1" opacity="0.6"/>
          ${[16,22,28].map((y) => [16,22,28].map((x) =>
            svg`<rect x="${x}" y="${y}" width="4" height="4" stroke="${c}" stroke-width="0.8"
              opacity="${x === 22 && y === 22 ? 0.8 : 0.5}"
              fill="${x === 22 && y === 22 ? c : "none"}"
              fill-opacity="${x === 22 && y === 22 ? 0.15 : 0}"/>`
          ))}
          ${[16,24,32].flatMap((p) => [
            svg`<line x1="${p}" y1="12" x2="${p}" y2="8" stroke="${c}" stroke-width="0.8" opacity="0.4"/>`,
            svg`<line x1="${p}" y1="36" x2="${p}" y2="40" stroke="${c}" stroke-width="0.8" opacity="0.4"/>`,
            svg`<line x1="12" y1="${p}" x2="8" y2="${p}" stroke="${c}" stroke-width="0.8" opacity="0.4"/>`,
            svg`<line x1="36" y1="${p}" x2="40" y2="${p}" stroke="${c}" stroke-width="0.8" opacity="0.4"/>`,
          ])}
          <text x="24" y="53" class="wf-id-label" fill="${c}">CPU-0</text>
        </svg>
      `;
    }
    if (type === "gpu") {
      return svg`
        <svg class="wf-glyph" viewBox="0 0 48 56" fill="none">
          <rect x="4" y="14" width="40" height="20" rx="2" stroke="${c}" stroke-width="1" opacity="0.6"/>
          <rect x="8" y="18" width="8" height="12" stroke="${c}" stroke-width="0.8" opacity="0.5"/>
          <rect x="20" y="18" width="8" height="12" stroke="${c}" stroke-width="0.8" opacity="0.8"
            fill="${c}" fill-opacity="0.12"/>
          <rect x="32" y="18" width="8" height="12" stroke="${c}" stroke-width="0.8" opacity="0.5"/>
          ${[12,16,20,24,28,32,36].map((x) =>
            svg`<line x1="${x}" y1="34" x2="${x}" y2="40" stroke="${c}" stroke-width="1.2" opacity="0.5"/>`
          )}
          <circle cx="12" cy="24" r="4" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
          <circle cx="36" cy="24" r="4" stroke="${c}" stroke-width="0.6" opacity="0.35"/>
          <text x="24" y="53" class="wf-id-label" fill="${c}">GPU-0</text>
        </svg>
      `;
    }
    return svg`
      <svg class="wf-glyph" viewBox="0 0 48 56" fill="none">
        <rect x="4"  y="16" width="18" height="16" rx="1" stroke="${c}" stroke-width="1" opacity="0.6"/>
        <rect x="26" y="16" width="18" height="16" rx="1" stroke="${c}" stroke-width="1" opacity="0.6"/>
        ${[7,12,17].map((x) =>
          svg`<rect x="${x}" y="19" width="3" height="10" stroke="${c}" stroke-width="0.7"
            opacity="${x === 12 ? 0.8 : 0.5}"
            fill="${x === 12 ? c : "none"}" fill-opacity="${x === 12 ? 0.12 : 0}"/>`
        )}
        ${[29,34,39].map((x) =>
          svg`<rect x="${x}" y="19" width="3" height="10" stroke="${c}" stroke-width="0.7"
            opacity="${x === 34 ? 0.8 : 0.5}"
            fill="${x === 34 ? c : "none"}" fill-opacity="${x === 34 ? 0.12 : 0}"/>`
        )}
        ${[7,10,13,16,19,29,32,35,38,41].map((x) =>
          svg`<line x1="${x}" y1="32" x2="${x}" y2="36" stroke="${c}" stroke-width="1" opacity="0.4"/>`
        )}
        <text x="24" y="53" class="wf-id-label" fill="${c}">RAM-0</text>
      </svg>
    `;
  }

  private renderGpuCard() {
    const gpu = this.latest?.gpu ?? null;
    if (!gpu) {
      return html`
        <div class="info-card">
          <div class="card-id">[GPU·0]</div>
          <div class="card-header">GPU</div>
          <div class="wf-wrap">${this.renderWireframeGlyph("gpu")}</div>
          <div class="no-gpu">NO GPU DETECTED</div>
          <div class="card-row muted">nvidia-smi / rocm-smi not found</div>
        </div>
      `;
    }
    const vramPct = gpu.vramTotalBytes > 0 ? Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100) : 0;
    return html`
      <div class="info-card">
        <div class="card-id">[GPU·0]</div>
        <div class="card-header">GPU<span class="card-vendor"> · ${gpu.vendor}</span></div>
        <div class="wf-wrap">${this.renderWireframeGlyph("gpu")}</div>
        <div class="card-row accent">${gpu.name}</div>
        <div class="card-row">
          <span class="muted">Util</span>
          <span class="val" style="color:${metricColor("gpu", gpu.utilizationPercent)}">${gpu.utilizationPercent}<span class="unit">%</span></span>
        </div>
        <div class="card-row">
          <span class="muted">VRAM</span>
          <span class="val" style="color:${metricColor("gpu", vramPct)}">${fmtBytes(gpu.vramUsedBytes)}<span class="unit muted"> / ${fmtBytes(gpu.vramTotalBytes)}</span></span>
        </div>
        <div class="mini-bar-wrap">
          <div class="mini-bar" style="width:${vramPct}%; background:${metricColor("gpu", vramPct)}"></div>
          <span class="mini-bar-val">${vramPct}%</span>
        </div>
      </div>
    `;
  }

  private renderDiskCard() {
    const mounts = this.latest?.disk?.mounts ?? [];
    return html`
      <div class="info-card">
        <div class="card-id">[DSK·0]</div>
        <div class="card-header">DISK</div>
        ${mounts.length === 0
          ? html`<div class="card-row muted">No mount data</div>`
          : mounts.map((m) => html`
            <div class="card-row"><span class="val accent">${m.path}</span></div>
            <div class="card-row">
              <span class="muted">${fmtBytes(m.usedBytes)} / ${fmtBytes(m.totalBytes)}</span>
              <span class="val" style="color:${metricColor("disk", m.percent)}">${m.percent}<span class="unit">%</span></span>
            </div>
            <div class="mini-bar-wrap">
              <div class="mini-bar" style="width:${m.percent}%; background:${metricColor("disk", m.percent)}"></div>
              <span class="mini-bar-val">${m.percent}%</span>
            </div>
          `)}
      </div>
    `;
  }

  private renderNetworkCard() {
    const ifaces = this.latest?.network?.interfaces ?? [];
    return html`
      <div class="info-card">
        <div class="card-id">[NET·0]</div>
        <div class="card-header">NETWORK</div>
        ${ifaces.length === 0
          ? html`<div class="card-row muted">No interface data</div>`
          : ifaces.slice(0, 4).map((iface) => html`
            <div class="card-row accent">${iface.name}</div>
            <div class="card-row"><span class="muted">↑</span> <span class="val">${fmtBytes(iface.txBytesPerSec)}<span class="unit">/s</span></span></div>
            <div class="card-row"><span class="muted">↓</span> <span class="val">${fmtBytes(iface.rxBytesPerSec)}<span class="unit">/s</span></span></div>
          `)}
      </div>
    `;
  }

  private renderSystemCard() {
    const sys = this.latest?.system;
    const cpu = this.latest?.cpu;
    return html`
      <div class="info-card">
        <div class="card-id">[SYS·0]</div>
        <div class="card-header">SYSTEM</div>
        <div class="wf-wrap">${this.renderWireframeGlyph("cpu")}</div>
        ${sys ? html`
          <div class="card-row"><span class="muted">Host</span> <span class="val accent">${sys.hostname}</span></div>
          <div class="card-row"><span class="muted">OS</span> <span class="val">${sys.platform}/${sys.arch}</span></div>
          <div class="card-row"><span class="muted">Kernel</span> <span class="val">${sys.kernelRelease}</span></div>
          <div class="card-row"><span class="muted">Uptime</span> <span class="val">${fmtUptime(sys.uptimeSec)}</span></div>
          ${cpu ? html`<div class="card-row"><span class="muted">Load</span> <span class="val">${cpu.loadAvg[0]} / ${cpu.loadAvg[1]} / ${cpu.loadAvg[2]}</span></div>` : nothing}
          ${cpu ? html`<div class="card-row muted cpu-model">${cpu.model}</div>` : nothing}
        ` : html`<div class="card-row muted">Loading…</div>`}
      </div>
    `;
  }

  private renderNodeStrip() {
    // Always show the chip strip when ANY federation node is in the roster so
    // the affordance to switch nodes is discoverable. Single-node installs
    // still get one chip; FOCUS/FLEET toggle lives in the command bar above.
    if (this.nodes.length === 0) return nothing;
    const FRESH_WINDOW_MS = 5000;
    return html`
      <div class="node-strip">
        <span class="section-eyebrow">fleet</span>
        <div class="node-strip-chips">
          ${this.nodes.map((n) => {
            const cpu = n.snapshot?.cpu.percent ?? 0;
            const mem = n.snapshot?.memory.percent ?? 0;
            const gpu = n.snapshot?.gpu?.utilizationPercent ?? 0;
            const ifaceFirst = n.snapshot?.network.interfaces[0];
            const netBps = ifaceFirst ? ifaceFirst.txBytesPerSec + ifaceFirst.rxBytesPerSec : 0;
            const isSelected = n.nodeId === this.selectedNodeId;
            const isFresh = n.snapshot != null && n.health === "online" && n.ageMs <= FRESH_WINDOW_MS;
            const ageLabel = !n.snapshot
              ? "no data"
              : n.health === "online"
                ? "live"
                : `${Math.round(n.ageMs / 1000)}s`;
            const hist = this.nodeHistory.get(n.nodeId) ?? [];
            return html`
              <button
                class="node-chip ${isSelected ? "node-chip-active" : ""} node-chip-${n.health}"
                title="${n.nodeName} — ${n.role}${n.isLocal ? " (this device)" : ""}"
                @click=${() => this.selectNode(n.nodeId)}
              >
                <span class="node-chip-glyph">
                  <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
                    ${n.role === "master"
                      ? svg`<rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
                            <line x1="5" y1="13" x2="5" y2="15" stroke="currentColor" stroke-width="1.2"/>
                            <line x1="11" y1="13" x2="11" y2="15" stroke="currentColor" stroke-width="1.2"/>
                            <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1" fill="none"/>`
                      : svg`<rect x="3" y="4" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
                            <line x1="5" y1="12" x2="5" y2="14" stroke="currentColor" stroke-width="1.2"/>
                            <line x1="11" y1="12" x2="11" y2="14" stroke="currentColor" stroke-width="1.2"/>`}
                  </svg>
                </span>
                <div class="node-chip-body">
                  <div class="node-chip-name">
                    ${n.nodeName}
                    ${n.isLocal ? html`<span class="node-chip-badge">this device</span>` : nothing}
                  </div>
                  <div class="node-chip-stats">
                    <span class="node-chip-role">${n.role}</span>
                    <span class="node-chip-dot dot-${n.health} ${isFresh ? "dot-fresh" : ""}"></span>
                    <span class="node-chip-age">${ageLabel}</span>
                  </div>
                  ${n.snapshot ? this.renderChipMetricStrip(hist, { cpu, gpu, mem, netBps }) : nothing}
                </div>
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  // Four tiny inline sparkline thumbnails inside a node chip — bklit
  // "micro-metrics" pattern. Each thumbnail is a 38×12 polyline scaled to
  // its own min/max so even low-activity nodes have a readable signal.
  private renderChipMetricStrip(hist: HardwareSnapshot[], live: { cpu: number; gpu: number; mem: number; netBps: number }) {
    const w = 38, h = 12;
    const series: { key: Metric; values: number[]; live: number; label: string; suffix: string }[] = [
      { key: "cpu", values: hist.map((s) => s.cpu.percent),                       live: live.cpu, label: "CPU", suffix: "%" },
      { key: "gpu", values: hist.map((s) => s.gpu?.utilizationPercent ?? 0),      live: live.gpu, label: "GPU", suffix: "%" },
      { key: "ram", values: hist.map((s) => s.memory.percent),                    live: live.mem, label: "RAM", suffix: "%" },
      { key: "net", values: hist.map((s) => {
          const i = s.network.interfaces[0];
          return i ? (i.txBytesPerSec + i.rxBytesPerSec) / 1024 : 0;
        }), live: live.netBps / 1024, label: "NET", suffix: "K/s" },
    ];
    return html`
      <div class="chip-metric-strip">
        ${series.map((s) => {
          const vmax = Math.max(1, ...s.values, s.live);
          const pts = s.values.length >= 2
            ? s.values.map((v, i) => {
                const x = (i / (s.values.length - 1)) * w;
                const y = h - (v / vmax) * (h - 1) - 0.5;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              }).join(" ")
            : "";
          const liveDisplay = s.key === "net"
            ? `${Math.round(s.live)}K`
            : `${Math.round(s.live)}%`;
          return html`
            <div class="chip-metric" title="${s.label} ${liveDisplay}">
              <span class="chip-metric-label">${s.label}</span>
              <svg viewBox="0 0 ${w} ${h}" class="chip-metric-svg" preserveAspectRatio="none">
                ${pts ? svg`<polyline points="${pts}" fill="none" stroke="${METRIC_VAR[s.key]}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>` : nothing}
              </svg>
              <span class="chip-metric-val" style="color:${METRIC_VAR[s.key]}">${liveDisplay}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  // Per-core load heatmap. Cells fill with --g-metric-cpu at an opacity
  // mixed from the core's pct — so palette swaps recolor the entire grid.
  private renderCoreHeatmap() {
    const cores = this.latest?.cpu.perCorePercent ?? [];
    if (cores.length === 0) return nothing;
    const cols = cores.length <= 8 ? cores.length : Math.ceil(Math.sqrt(cores.length));
    return html`
      <div class="heatmap card-glass">
        <div class="card-id">[CPU·HM]</div>
        <div class="section-head">
          <span class="section-dot"></span>
          <span class="section-eyebrow">per-core load</span>
          <span class="section-meta">${cores.length} cores</span>
        </div>
        <div class="heatmap-grid" style="--hm-cols:${cols}">
          ${cores.map((p, i) => {
            const clamped = Math.max(0, Math.min(100, p));
            const fillPct = (20 + clamped * 0.8).toFixed(0); // 20%→100%
            const isCrit = clamped >= 90;
            const isWarn = clamped >= 75 && !isCrit;
            const bg = isCrit
              ? `color-mix(in oklab, var(--g-state-danger) ${fillPct}%, transparent)`
              : isWarn
                ? `color-mix(in oklab, var(--g-state-warn) ${fillPct}%, transparent)`
                : `color-mix(in oklab, var(--g-metric-cpu) ${fillPct}%, transparent)`;
            return html`
              <div
                class="heatmap-cell ${isCrit ? "hm-crit" : isWarn ? "hm-warn" : ""}"
                style="background: ${bg};"
                title="Core ${i}: ${clamped}%"
              >
                <span class="hm-cell-pct">${clamped}</span>
                <span class="hm-cell-idx">${i}</span>
              </div>
            `;
          })}
        </div>
        <div class="heatmap-scale">
          <span>0%</span>
          <div class="heatmap-scale-bar"></div>
          <span>100%</span>
        </div>
      </div>
    `;
  }

  // Dual-line net history above/below baseline. Builds local history from
  // this.history (data shape unchanged) — bklit "split fill above/below"
  // pattern in --g-metric-net.
  private renderStackedNetwork() {
    const hist = this.history;
    const latestIfaces = this.latest?.network.interfaces ?? [];
    if (latestIfaces.length === 0 || hist.length < 2) {
      return html`
        <div class="net-strip card-glass">
          <div class="card-id">[NET·LIVE]</div>
          <div class="section-head">
            <span class="section-dot"></span>
            <span class="section-eyebrow">network · live</span>
            <span class="section-meta">awaiting samples</span>
          </div>
          <div class="net-empty">No interface history yet.</div>
        </div>
      `;
    }

    const ifaceName = latestIfaces[0].name;
    const rxSeries = hist.map((s) => s.network.interfaces[0]?.rxBytesPerSec ?? 0);
    const txSeries = hist.map((s) => s.network.interfaces[0]?.txBytesPerSec ?? 0);
    const peak = Math.max(1, ...rxSeries, ...txSeries);

    const W = 380, H = 96;
    const padX = 8;
    const midY = H / 2;
    const halfH = midY - 6;
    const step = (W - padX * 2) / Math.max(1, HISTORY_LEN - 1);

    const pad = (n: number) => padX + n * step;
    const upPts = txSeries.map((v, i) => ({
      x: pad(i),
      y: midY - (v / peak) * halfH,
    }));
    const downPts = rxSeries.map((v, i) => ({
      x: pad(i),
      y: midY + (v / peak) * halfH,
    }));
    const upLine = upPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const dnLine = downPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const upArea = `${upLine} L ${upPts[upPts.length - 1].x.toFixed(1)} ${midY} L ${upPts[0].x.toFixed(1)} ${midY} Z`;
    const dnArea = `${dnLine} L ${downPts[downPts.length - 1].x.toFixed(1)} ${midY} L ${downPts[0].x.toFixed(1)} ${midY} Z`;

    const latestRx = rxSeries[rxSeries.length - 1];
    const latestTx = txSeries[txSeries.length - 1];

    return html`
      <div class="net-strip card-glass">
        <div class="card-id">[NET·LIVE]</div>
        <div class="section-head">
          <span class="section-dot"></span>
          <span class="section-eyebrow">network · ${ifaceName}</span>
          <span class="section-meta">peak ${fmtBytes(peak)}/s</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="net-svg" preserveAspectRatio="none">
          <defs>
            <linearGradient id="net-up-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--g-metric-net)" stop-opacity="0.38"/>
              <stop offset="100%" stop-color="var(--g-metric-net)" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="net-dn-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--g-metric-ram)" stop-opacity="0"/>
              <stop offset="100%" stop-color="var(--g-metric-ram)" stop-opacity="0.38"/>
            </linearGradient>
          </defs>
          <!-- Baseline midline -->
          <line x1="${padX}" y1="${midY}" x2="${W - padX}" y2="${midY}"
            stroke="var(--g-border)" stroke-width="0.8" stroke-dasharray="3 4" opacity="0.6"/>
          <!-- Up area (TX) -->
          ${upArea ? svg`<path d="${upArea}" fill="url(#net-up-grad)"/>` : nothing}
          <!-- Down area (RX) -->
          ${dnArea ? svg`<path d="${dnArea}" fill="url(#net-dn-grad)"/>` : nothing}
          <!-- Up line (TX) -->
          ${upLine ? svg`<path d="${upLine}" fill="none" stroke="var(--g-metric-net)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` : nothing}
          <!-- Down line (RX) -->
          ${dnLine ? svg`<path d="${dnLine}" fill="none" stroke="var(--g-metric-ram)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` : nothing}
        </svg>
        <div class="net-legend">
          <span class="net-legend-item"><span class="net-legend-dot" style="background:var(--g-metric-net)"></span>↑ TX <span class="net-legend-val">${fmtBytes(latestTx)}/s</span></span>
          <span class="net-legend-item"><span class="net-legend-dot" style="background:var(--g-metric-ram)"></span>↓ RX <span class="net-legend-val">${fmtBytes(latestRx)}/s</span></span>
        </div>
      </div>
    `;
  }

  // Process panel — sortable headers + top-N row highlight + hover actions.
  private renderProcessPanel() {
    const procs = this.latest?.processes ?? [];
    const sorted = sortProcs(procs as ProcessLike[], this.procSortField, this.procSortDir);
    const TOP_N = 5;
    const sortIcon = (field: ProcSortField) =>
      this.procSortField === field
        ? html`<span class="proc-sort-ind">${this.procSortDir === "asc" ? "↑" : "↓"}</span>`
        : html`<span class="proc-sort-ind dim">↕</span>`;
    const headerBtn = (field: ProcSortField, label: string, align: "left" | "right" = "left") => html`
      <button class="proc-th proc-th-${align} ${this.procSortField === field ? "is-active" : ""}"
        @click=${() => this.toggleProcSort(field)}
        type="button">
        ${label}${sortIcon(field)}
      </button>
    `;
    return html`
      <div class="proc-panel card-glass">
        <div class="card-id">[PROC·TOP]</div>
        <div class="section-head">
          <span class="section-dot"></span>
          <span class="section-eyebrow">top processes</span>
          <span class="section-meta">${procs.length > 0 ? `${procs.length} total` : "no data"}</span>
        </div>
        ${procs.length === 0
          ? html`<div class="proc-empty muted">No process data — ps may be unavailable</div>`
          : html`
            <div class="proc-table">
              <div class="proc-thead">
                ${headerBtn("name", "Process")}
                <span class="proc-th proc-th-right">CPU bar</span>
                ${headerBtn("cpu",  "CPU%", "right")}
                ${headerBtn("mem",  "MEM",  "right")}
                ${headerBtn("pid",  "PID",  "right")}
              </div>
              <div class="proc-rows">
                ${sorted.map((p, i) => {
                  const pct = Math.min(100, p.cpuPercent);
                  const isTop = i < TOP_N;
                  const isHover = this.hoverProcPid === p.pid;
                  return html`
                    <div
                      class="proc-row ${isTop ? "proc-row-top" : ""} ${isHover ? "proc-row-hover" : ""}"
                      @mouseenter=${() => { this.hoverProcPid = p.pid; }}
                      @mouseleave=${() => { if (this.hoverProcPid === p.pid) this.hoverProcPid = null; }}
                    >
                      <!-- Bklit top-N highlight: faint gradient bar inside the row, not a full background -->
                      ${isTop ? html`<div class="proc-row-glow" style="--row-glow-pct:${pct.toFixed(1)}%"></div>` : nothing}
                      <div class="proc-name" title="${p.name}">
                        <span class="proc-rank">${i + 1}</span>
                        <span class="proc-name-text">${p.name}</span>
                      </div>
                      <div class="proc-bar">
                        <div class="proc-bar-fill" style="width:${pct.toFixed(1)}%; background:${metricColor("cpu", pct)}"></div>
                      </div>
                      <div class="proc-cpu" style="color:${metricColor("cpu", pct)}">${p.cpuPercent.toFixed(1)}%</div>
                      <div class="proc-mem muted">${fmtBytes(p.memoryBytes, 0)}</div>
                      <div class="proc-pid muted">${p.pid}</div>
                      <!-- Row hover actions: inspect / pin / kill. Uses existing icons. -->
                      <div class="proc-actions" @click=${(e: Event) => e.stopPropagation()}>
                        <button class="proc-act" title="Inspect ${p.name}" type="button">${icons.search}</button>
                        <button class="proc-act" title="Pin ${p.name}"    type="button">${icons.star}</button>
                        <button class="proc-act proc-act-danger" title="Kill ${p.name}" type="button">${icons.xCircle}</button>
                      </div>
                    </div>
                  `;
                })}
              </div>
            </div>
          `}
      </div>
    `;
  }

  private renderInsightsPanel() {
    const insights = generateInsights(this.history);
    return html`
      <div class="insights-panel card-glass">
        <div class="card-id">[SYS·INS]</div>
        <div class="section-head">
          <span class="section-dot"></span>
          <span class="section-eyebrow">insights</span>
          <span class="section-meta">${insights.length}</span>
        </div>
        <div class="insights-list">
          ${insights.map((ins) => html`
            <div class="insight-row sev-row-${ins.severity}">
              <div class="insight-icon sev-${ins.severity}">
                ${ins.severity === "critical" ? icons.alertCircle
                  : ins.severity === "warn"   ? icons.alert
                  :                              icons.checkCircle}
              </div>
              <div class="insight-body">
                <div class="insight-text">${ins.message}</div>
              </div>
              <span class="insight-pill sev-${ins.severity}">${ins.severity}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private renderLoadingShimmer() {
    return html`
      <div class="loading-shim">
        <div class="shim-bar"></div>
        <div class="shim-bar shim-2"></div>
        <div class="shim-bar shim-3"></div>
      </div>
    `;
  }

  // ─── Fleet overview grid ─────────────────────────────────────────────
  // Compact per-node card with ring trio + sparkline strip. Renders every
  // federation node in a responsive grid so multi-device installs land on a
  // whole-fleet view rather than a single host's detail. Clicking a card
  // drops back into FOCUS mode for that node via selectNode().
  private renderFleetGrid() {
    if (this.nodes.length === 0) {
      return html`
        <div class="fleet-empty card-glass">
          <div class="section-head">
            <span class="section-dot"></span>
            <span class="section-eyebrow">fleet · waiting</span>
          </div>
          <div class="fleet-empty-body muted">No federation nodes reporting yet.</div>
        </div>
      `;
    }
    const FRESH_WINDOW_MS = 5000;
    return html`
      <div class="fleet-grid">
        ${this.nodes.map((n) => {
          const snap = n.snapshot;
          const cpu = snap?.cpu.percent ?? 0;
          const mem = snap?.memory.percent ?? 0;
          const gpu = snap?.gpu?.utilizationPercent ?? 0;
          const vramPct = snap?.gpu && snap.gpu.vramTotalBytes > 0
            ? Math.round((snap.gpu.vramUsedBytes / snap.gpu.vramTotalBytes) * 100)
            : 0;
          const isSelected = n.nodeId === this.selectedNodeId;
          const isFresh = snap != null && n.health === "online" && n.ageMs <= FRESH_WINDOW_MS;
          const ageLabel = !snap
            ? "no data"
            : n.health === "online"
              ? "live"
              : `${Math.round(n.ageMs / 1000)}s ago`;
          const hist = this.nodeHistory.get(n.nodeId) ?? [];
          const status: Severity = snap ? systemStatus(cpu, mem, gpu) : "NOMINAL";
          return html`
            <button
              type="button"
              class="fleet-card ${isSelected ? "fleet-card-selected" : ""} status-${status.toLowerCase()} ${snap ? "" : "fleet-card-empty"}"
              @click=${() => this.selectNode(n.nodeId)}
              title="Open ${n.nodeName} in FOCUS view"
            >
              <div class="fleet-card-head">
                <div class="fleet-card-glyph fleet-card-glyph-${n.role}">
                  ${n.role === "master"
                    ? svg`<svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/>
                        <line x1="5" y1="13" x2="5" y2="15" stroke="currentColor" stroke-width="1.2"/>
                        <line x1="11" y1="13" x2="11" y2="15" stroke="currentColor" stroke-width="1.2"/>
                        <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1"/>
                      </svg>`
                    : svg`<svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                        <rect x="3" y="4" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/>
                        <line x1="5" y1="12" x2="5" y2="14" stroke="currentColor" stroke-width="1.2"/>
                        <line x1="11" y1="12" x2="11" y2="14" stroke="currentColor" stroke-width="1.2"/>
                      </svg>`}
                </div>
                <div class="fleet-card-id">
                  <div class="fleet-card-name">${n.nodeName}</div>
                  <div class="fleet-card-sub">
                    <span class="fleet-card-role">${n.role}</span>
                    <span class="fleet-card-dot dot-${n.health} ${isFresh ? "dot-fresh" : ""}"></span>
                    <span class="fleet-card-age">${ageLabel}</span>
                  </div>
                </div>
                ${n.isLocal ? html`<span class="fleet-card-tag">this device</span>` : nothing}
              </div>

              <div class="fleet-rings">
                ${this.renderMiniRing("CPU", cpu, "cpu")}
                ${this.renderMiniRing("GPU", gpu, "gpu", { secondary: vramPct, secondaryLabel: "VRAM" })}
                ${this.renderMiniRing("RAM", mem, "ram")}
              </div>

              ${snap
                ? this.renderChipMetricStrip(hist, {
                    cpu, gpu, mem,
                    netBps: (snap.network.interfaces[0]?.txBytesPerSec ?? 0)
                          + (snap.network.interfaces[0]?.rxBytesPerSec ?? 0),
                  })
                : html`<div class="fleet-card-no-data muted">awaiting snapshot…</div>`}

              ${snap ? html`
                <div class="fleet-card-foot">
                  <span class="fleet-card-foot-cell">
                    <span class="fleet-card-foot-label">HOST</span>
                    <span class="fleet-card-foot-val">${snap.system.hostname}</span>
                  </span>
                  <span class="fleet-card-foot-cell">
                    <span class="fleet-card-foot-label">UP</span>
                    <span class="fleet-card-foot-val">${fmtUptime(snap.system.uptimeSec)}</span>
                  </span>
                </div>
              ` : nothing}
            </button>
          `;
        })}
      </div>
    `;
  }

  // Compact ring used inside fleet cards — same color-token wiring as the
  // big concentric gauge but with a single arc + percentage in the middle.
  private renderMiniRing(
    label: string,
    pct: number,
    metric: Metric,
    opts?: { secondary?: number; secondaryLabel?: string },
  ) {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    const color = metricColor(metric, clamped);
    const r = 22, c = 30;
    const circ = 2 * Math.PI * r;
    const off = (circ * (1 - clamped / 100)).toFixed(1);
    const sec = opts?.secondary;
    return html`
      <div class="fleet-ring fleet-ring-${metric}" style="--ring-color:${color}">
        <svg viewBox="0 0 60 60" class="fleet-ring-svg">
          <circle cx="${c}" cy="${c}" r="${r}" fill="none"
            stroke="color-mix(in oklab, var(--ring-color) 16%, transparent)"
            stroke-width="5"/>
          <circle cx="${c}" cy="${c}" r="${r}" fill="none"
            stroke="var(--ring-color)" stroke-width="5"
            stroke-dasharray="${circ.toFixed(1)}"
            stroke-dashoffset="${off}"
            stroke-linecap="round"
            transform="rotate(-90 ${c} ${c})"/>
          <text x="${c}" y="${c + 1}" class="fleet-ring-val" fill="var(--ring-color)">${Math.round(clamped)}</text>
          <text x="${c}" y="${c + 12}" class="fleet-ring-unit">%</text>
        </svg>
        <div class="fleet-ring-label">${label}</div>
        ${sec != null ? html`<div class="fleet-ring-sub">${opts?.secondaryLabel ?? "·"} ${Math.round(sec)}%</div>` : nothing}
      </div>
    `;
  }

  override render() {
    const snap = this.latest;
    const cpuHistory = this.history.map((h) => h.cpu.percent);
    const memHistory = this.history.map((h) => h.memory.percent);
    const gpuHistory = this.history.map((h) => h.gpu?.utilizationPercent ?? 0);

    const cpuSubLabel = snap ? `${snap.cpu.cores}c · load ${snap.cpu.loadAvg[0]}` : "—";
    const memSubLabel = snap ? fmtBytes(snap.memory.usedBytes, 0) : "—";
    const gpuSubLabel = snap?.gpu ? `${fmtBytes(snap.gpu.vramUsedBytes, 0)} VRAM` : "NO GPU";

    // Inner (secondary) ring metrics
    const cpuLoadPct = snap
      ? Math.min(100, Math.round((snap.cpu.loadAvg[0] / Math.max(snap.cpu.cores, 1)) * 100))
      : 0;
    const vramPct = snap?.gpu && snap.gpu.vramTotalBytes > 0
      ? Math.round((snap.gpu.vramUsedBytes / snap.gpu.vramTotalBytes) * 100)
      : 0;
    const memFreePct = snap
      ? Math.round((snap.memory.freeBytes / Math.max(1, snap.memory.usedBytes + snap.memory.freeBytes)) * 100)
      : 0;

    const noData = !snap && this.history.length === 0;

    const isFleet = this.viewMode === "fleet";

    return html`
      <div class="hud-root">
        ${this.renderCommandBar()}
        ${this.renderNodeStrip()}
        ${isFleet ? nothing : this.renderTelemetryStrip()}

        ${isFleet
          ? html`
            <div class="hud-body hud-body-fleet">
              ${this.renderFleetGrid()}
            </div>
          `
          : html`
            <div class="hud-body">
              <div class="hud-main">
                <div class="gauges-row">
                  ${this.renderConcentricGauge("CPU", "A1", this.displayCpu, cpuLoadPct, cpuSubLabel, "cpu", { main: "UTIL", inner: "LOAD" })}
                  ${this.renderConcentricGauge("GPU", "0",  this.displayGpu, vramPct,    gpuSubLabel, "gpu", { main: "UTIL", inner: "VRAM" })}
                  ${this.renderConcentricGauge("RAM", "B0", this.displayMem, memFreePct, memSubLabel, "ram", { main: "USED", inner: "FREE" })}
                </div>

                <div class="sparklines-strip card-glass">
                  <div class="card-id">[SYS·SPKL]</div>
                  <div class="section-head">
                    <span class="section-dot"></span>
                    <span class="section-eyebrow">live trend · ${HISTORY_LEN}s</span>
                    <span class="section-meta">${this.history.length} samples</span>
                  </div>
                  <div class="sparklines-inner">
                    ${noData
                      ? html`${this.renderLoadingShimmer()}${this.renderLoadingShimmer()}${this.renderLoadingShimmer()}`
                      : html`
                        ${this.renderSparkline("CPU %", cpuHistory, "cpu", "hw-spk-cpu")}
                        ${this.renderSparkline("GPU %", gpuHistory, "gpu", "hw-spk-gpu")}
                        ${this.renderSparkline("RAM %", memHistory, "ram", "hw-spk-ram")}
                      `}
                  </div>
                </div>

                <div class="dense-row">
                  ${this.renderCoreHeatmap()}
                  ${this.renderProcessPanel()}
                  ${this.renderStackedNetwork()}
                </div>

                ${this.renderLogStrip()}

                <div class="info-row">
                  ${this.renderGpuCard()}
                  ${this.renderDiskCard()}
                  ${this.renderNetworkCard()}
                  ${this.renderSystemCard()}
                </div>
              </div>

              ${this.renderInsightsPanel()}
            </div>
          `}

        ${this.error ? html`<div class="hud-error">${this.error}</div>` : nothing}
      </div>
    `;
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  static override styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      position: relative;
      color: var(--g-fg);
      font-family: var(--g-font-family);
      font-size: 12px;
      box-sizing: border-box;
    }
    *, *::before, *::after { box-sizing: inherit; }

    /* Root chrome — transparent so the global aurora/overlay layers
       (mounted once by injectGlassTheme) read through. No local bg gradient. */
    .hud-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 16px;
      gap: 14px;
      position: relative;
      overflow: hidden;
    }

    /* ── Section headings — bklit/agents.ts small-caps treatment ──
       Mono uppercase eyebrow + thin dot. Used everywhere a panel needs
       a title. The dot is a tiny primary-tinted disc; the eyebrow is
       11px, 0.16em letter-spaced, --g-fg-dim. */
    .section-eyebrow {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--g-fg-dim);
      white-space: nowrap;
    }
    .section-meta {
      margin-left: auto;
      font-size: 10px;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      color: var(--g-fg-faint);
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      min-width: 0;
    }
    .section-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--g-primary);
      box-shadow: 0 0 8px var(--g-primary-muted);
      flex-shrink: 0;
    }

    /* ── Clear-depth glass utility classes (page-local) ─────────────
       Mirror the subagent-activity-panel technique (dark frosted base
       + backdrop blur) with the alpha tuned LOWER so the aurora behind
       the panel bleeds through visibly. Three depth tiers; do NOT
       mutate the global --g-surface tokens — they're consumed by other
       views.

       Why a dark base instead of --g-surface? --g-surface is a
       white-tinted low-alpha colour. Stacked over --g-gradient-surface
       (also white-leaning) and amplified by saturate(180%) on the
       backdrop filter, panels read as a milky bright tile. A dark base
       (color-mix of --g-bg) at low alpha frosts what's behind without
       washing it out — same trick as .sap-panel, with the alpha lower. */
    .hw-glass,
    .hw-glass-soft,
    .hw-glass-deep {
      position: relative;
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius-lg);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 8px 32px color-mix(in oklab, black 35%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 7%, transparent);
      isolation: isolate;
      overflow: hidden;
    }
    .hw-glass-soft { background: color-mix(in oklab, var(--g-bg) 26%, transparent); }
    .hw-glass      { background: color-mix(in oklab, var(--g-bg) 42%, transparent); }
    .hw-glass-deep { background: color-mix(in oklab, var(--g-bg) 60%, transparent); }
    .hw-glass::before,
    .hw-glass-soft::before,
    .hw-glass-deep::before {
      content: "";
      position: absolute;
      top: 0; left: 8%; right: 8%;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 14%, transparent) 50%,
        transparent);
      pointer-events: none;
      z-index: 1;
    }
    :root[data-theme="light"] .hw-glass-soft { background: color-mix(in oklab, white 35%, transparent); }
    :root[data-theme="light"] .hw-glass      { background: color-mix(in oklab, white 55%, transparent); }
    :root[data-theme="light"] .hw-glass-deep { background: color-mix(in oklab, white 72%, transparent); }
    :root[data-theme="light"] .hw-glass,
    :root[data-theme="light"] .hw-glass-soft,
    :root[data-theme="light"] .hw-glass-deep {
      border-color: color-mix(in oklab, black 8%, transparent);
    }

    /* ── Card chrome (shared by every panel) ─────────────────────────
       Inherits the clear-glass technique: dark base + heavy blur + thin
       top-edge highlight + bottom recess. Drops the previous primary-
       tinted accent ring (var(--g-primary-soft)) which read as a gold
       halo around every panel. */
    .card-glass {
      position: relative;
      background: color-mix(in oklab, var(--g-bg) 42%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius-lg);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 8px 32px color-mix(in oklab, black 35%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 7%, transparent),
        inset 0 -1px 0 color-mix(in oklab, black 30%, transparent);
      padding: 14px 16px;
      isolation: isolate;
      overflow: hidden;
      transition:
        border-color var(--g-motion-medium, 260ms ease),
        box-shadow   var(--g-motion-medium, 260ms ease);
    }
    .card-glass::before {
      content: "";
      position: absolute;
      top: 0; left: 8%; right: 8%;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 14%, transparent) 50%,
        transparent);
      pointer-events: none;
      z-index: 2;
    }
    :root[data-theme="light"] .card-glass {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    :root[data-theme="light"] .card-glass::before {
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 55%, transparent) 50%,
        transparent);
    }
    .card-id {
      position: absolute;
      top: 6px;
      left: 10px;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      font-weight: 600;
      letter-spacing: 0.10em;
      color: var(--g-primary);
      opacity: 0.55;
      pointer-events: none;
      z-index: 3;
      font-variant-numeric: tabular-nums;
      text-transform: uppercase;
    }

    /* ── Command bar (top) ────────────────────────────────────────── */
    .cmd-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: color-mix(in oklab, var(--g-bg) 30%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 11px;
      flex-shrink: 0;
      letter-spacing: 0.06em;
      position: relative;
      z-index: 3;
      box-shadow:
        0 6px 22px color-mix(in oklab, black 30%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 6%, transparent);
    }
    :root[data-theme="light"] .cmd-bar {
      background: color-mix(in oklab, white 45%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .cmd-path { display: flex; align-items: center; gap: 6px; flex: 1; overflow: hidden; min-width: 0; }
    .cmd-seg { color: var(--g-fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cmd-seg.dim { color: var(--g-fg-faint); }
    .cmd-seg.accent { color: var(--g-primary); font-weight: 700; }
    .cmd-arrow { color: var(--g-primary-strong); font-size: 10px; flex-shrink: 0; }
    .cmd-stats { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-shrink: 0; }
    .cmd-chip {
      padding: 3px 10px;
      border: 1px solid color-mix(in oklab, white 8%, transparent);
      background: color-mix(in oklab, var(--g-bg) 40%, transparent);
      color: var(--g-fg-dim);
      font-size: 10px;
      letter-spacing: 0.08em;
      white-space: nowrap;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    :root[data-theme="light"] .cmd-chip {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 10%, transparent);
    }
    .cmd-caret {
      color: var(--g-primary);
      font-size: 14px;
      line-height: 1;
      transition: opacity 80ms step-end;
      flex-shrink: 0;
    }
    .cmd-caret.blink-on { opacity: 1; }
    .cmd-caret.blink-off { opacity: 0; }

    /* Status pill — semantic state token. */
    .status-pill {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 3px 12px;
      border: 1px solid;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    .pill-nominal {
      color: var(--g-state-success);
      border-color: color-mix(in oklab, var(--g-state-success) 38%, transparent);
      background: var(--g-state-success-soft);
    }
    .pill-elevated {
      color: var(--g-state-warn);
      border-color: color-mix(in oklab, var(--g-state-warn) 38%, transparent);
      background: var(--g-state-warn-soft);
    }
    .pill-critical {
      color: var(--g-state-danger);
      border-color: color-mix(in oklab, var(--g-state-danger) 45%, transparent);
      background: var(--g-state-danger-soft);
    }
    @media (prefers-reduced-motion: no-preference) {
      .pill-critical { animation: hw-pill-pulse 1.8s ease-in-out infinite; }
    }
    @keyframes hw-pill-pulse {
      0%, 100% { box-shadow: 0 0 0 0 transparent; }
      50%       { box-shadow: 0 0 14px color-mix(in oklab, var(--g-state-danger) 25%, transparent); }
    }

    /* ── Telemetry strip (pinned, top-right) ─────────────────────── */
    .telemetry-strip {
      position: absolute;
      top: 60px;
      right: 16px;
      width: 188px;
      z-index: 10;
      padding: 10px 12px;
      background: color-mix(in oklab, var(--g-bg) 30%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 6px 22px color-mix(in oklab, black 30%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 6%, transparent);
    }
    :root[data-theme="light"] .telemetry-strip {
      background: color-mix(in oklab, white 45%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .tel-row {
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      color: var(--g-fg-dim);
      min-width: 0;
      margin-top: 6px;
    }
    .tel-name { color: var(--g-fg-faint); flex-shrink: 0; white-space: nowrap; letter-spacing: 0.05em; }
    .tel-val  { color: var(--g-fg); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .tel-val.down { color: var(--g-primary); }
    .tel-divider { height: 1px; background: var(--g-border); margin: 8px 0 0; }

    /* ── Body grid ───────────────────────────────────────────────── */
    .hud-body {
      display: grid;
      grid-template-columns: 1fr 280px;
      gap: 14px;
      flex: 1;
      min-height: 0;
      position: relative;
      z-index: 2;
    }
    .hud-main {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
    }
    @media (max-width: 1100px) {
      .hud-body { grid-template-columns: 1fr; }
    }

    /* ── Gauges row ─────────────────────────────────────────────── */
    .gauges-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }
    .gauge-card {
      /* --gauge-color drives every coloured affordance for the ring:
         track tint, gradient stop, tick crown highlight, glow filter.
         Per-metric class below swaps it so the same SVG renders three
         differently-themed instruments. */
      --gauge-color: var(--g-metric-cpu);
      padding: 18px 14px 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      position: relative;
      overflow: hidden;
      background: color-mix(in oklab, var(--g-bg) 42%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius-lg);
      backdrop-filter: blur(28px) saturate(140%);
      -webkit-backdrop-filter: blur(28px) saturate(140%);
      box-shadow:
        0 8px 32px color-mix(in oklab, black 35%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 7%, transparent),
        inset 0 -1px 0 color-mix(in oklab, black 30%, transparent);
      transition: border-color var(--g-motion-medium, 260ms ease),
                  transform     var(--g-motion-fast, 180ms ease),
                  box-shadow    var(--g-motion-medium, 260ms ease);
    }
    .gauge-card::before {
      content: "";
      position: absolute;
      top: 0; left: 8%; right: 8%;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 14%, transparent) 50%,
        transparent);
      pointer-events: none;
      z-index: 2;
    }
    :root[data-theme="light"] .gauge-card {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    :root[data-theme="light"] .gauge-card::before {
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 55%, transparent) 50%,
        transparent);
    }
    .gauge-cpu { --gauge-color: var(--g-metric-cpu); border-color: color-mix(in oklab, var(--g-metric-cpu) 18%, transparent); }
    .gauge-gpu { --gauge-color: var(--g-metric-gpu); border-color: color-mix(in oklab, var(--g-metric-gpu) 18%, transparent); }
    .gauge-ram { --gauge-color: var(--g-metric-ram); border-color: color-mix(in oklab, var(--g-metric-ram) 18%, transparent); }
    @media (prefers-reduced-motion: no-preference) {
      .gauge-card:hover {
        transform: translateY(-2px);
        box-shadow:
          0 14px 44px color-mix(in oklab, black 45%, transparent),
          inset 0 0 0 1px color-mix(in oklab, white 9%, transparent),
          inset 0 -1px 0 color-mix(in oklab, black 30%, transparent);
      }
    }
    .gauge-cpu:hover { border-color: color-mix(in oklab, var(--g-metric-cpu) 38%, transparent); }
    .gauge-gpu:hover { border-color: color-mix(in oklab, var(--g-metric-gpu) 38%, transparent); }
    .gauge-ram:hover { border-color: color-mix(in oklab, var(--g-metric-ram) 38%, transparent); }

    .gauge-card.status-critical {
      border-color: color-mix(in oklab, var(--g-state-danger) 35%, transparent);
    }
    @media (prefers-reduced-motion: no-preference) {
      .gauge-card.status-critical {
        animation: hw-card-crit 2s ease-in-out infinite;
      }
    }
    @keyframes hw-card-crit {
      0%, 100% {
        box-shadow:
          0 8px 32px color-mix(in oklab, black 35%, transparent),
          inset 0 0 0 1px color-mix(in oklab, white 7%, transparent),
          0 0 0 1px color-mix(in oklab, var(--g-state-danger) 22%, transparent);
      }
      50% {
        box-shadow:
          0 8px 32px color-mix(in oklab, black 35%, transparent),
          inset 0 0 0 1px color-mix(in oklab, white 7%, transparent),
          0 0 26px color-mix(in oklab, var(--g-state-danger) 36%, transparent);
      }
    }

    .gauge-label {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      letter-spacing: 0.22em;
      font-size: 10px;
      text-transform: uppercase;
      color: var(--g-fg-dim);
      font-weight: 700;
      margin-top: 4px;
    }
    .gauge-ring-wrap { width: 168px; height: 168px; }
    .gauge-svg { width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
    .ring-main-fill,
    .ring-inner-fill {
      transition: stroke-dashoffset 600ms cubic-bezier(0.22,1,0.36,1),
                  stroke 400ms ease;
    }
    /* Glow filter — keep the cpu/gpu/ram color signal in the ring itself. */
    .gauge-cpu .ring-main-fill { filter: drop-shadow(0 0 6px color-mix(in oklab, var(--g-metric-cpu) 50%, transparent)); }
    .gauge-gpu .ring-main-fill { filter: drop-shadow(0 0 6px color-mix(in oklab, var(--g-metric-gpu) 50%, transparent)); }
    .gauge-ram .ring-main-fill { filter: drop-shadow(0 0 6px color-mix(in oklab, var(--g-metric-ram) 50%, transparent)); }

    .gauge-pct-val,
    .gauge-pct-unit,
    .gauge-pct-metric,
    .gauge-sub {
      font-family: inherit;
      text-anchor: middle;
      dominant-baseline: middle;
      /* Counter-rotate so center text reads upright while ring is rotated -90. */
      transform-origin: 60px 60px;
      transform: rotate(90deg);
    }
    .gauge-pct-val { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; transition: fill 400ms ease; }
    .gauge-pct-unit { font-size: 12px; font-weight: 600; opacity: 0.65; }
    .gauge-pct-metric { font-size: 8px; font-weight: 700; letter-spacing: 0.16em; fill: var(--g-fg-faint); text-transform: uppercase; }
    .gauge-sub { font-size: 8px; font-weight: 400; fill: var(--g-fg-faint); }

    .ring-legend {
      display: flex;
      align-items: center;
      gap: 5px;
      justify-content: center;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--g-fg-dim);
    }
    .ring-legend-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .ring-legend-sep { opacity: 0.5; padding: 0 1px; }
    .ring-legend-inner { color: var(--g-fg-faint); }

    /* ── Sparklines strip ────────────────────────────────────────── */
    .sparklines-strip { /* card-glass */ }
    .sparklines-inner {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 18px;
    }
    .spark-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .spark-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; min-width: 0; }
    .spark-label {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--g-fg-dim);
      white-space: nowrap;
    }
    .spark-stats { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; overflow: hidden; min-width: 0; }
    .spark-now {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      white-space: nowrap;
      transition: color var(--g-motion-fast, 180ms ease);
    }
    .spark-unit { font-size: 11px; font-weight: 600; opacity: 0.7; margin-left: 1px; }
    .spark-mm {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      color: var(--g-fg-faint);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .spark-wrap { position: relative; }
    .spark-svg { width: 100%; height: 64px; display: block; cursor: crosshair; }
    .spark-tooltip {
      position: absolute;
      bottom: calc(100% + 4px);
      transform: translateX(-50%);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      background: var(--g-surface-strong);
      border: 1px solid var(--g-border);
      border-radius: var(--g-radius-sm);
      padding: 3px 8px;
      white-space: nowrap;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
      backdrop-filter: var(--g-blur);
      -webkit-backdrop-filter: var(--g-blur);
      box-shadow: var(--g-shadow-sm);
      z-index: 4;
    }

    /* ── Log strip ───────────────────────────────────────────────── */
    .log-strip {
      padding: 12px 16px;
      flex-shrink: 0;
      background: color-mix(in oklab, var(--g-bg) 30%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 6px 22px color-mix(in oklab, black 30%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 6%, transparent);
    }
    :root[data-theme="light"] .log-strip {
      background: color-mix(in oklab, white 45%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .log-lines { display: flex; flex-direction: column; gap: 3px; }
    .log-line {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      color: var(--g-fg-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
      transition: color var(--g-motion-medium, 280ms ease);
      letter-spacing: 0.02em;
    }
    .log-line.log-newest { color: var(--g-fg-dim); }
    .log-prompt { color: var(--g-primary); opacity: 0.55; margin-right: 4px; }

    /* ── Info cards row ──────────────────────────────────────────── */
    .info-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      flex-shrink: 0;
      align-items: start;
    }
    @media (max-width: 900px) { .info-row { grid-template-columns: repeat(2, 1fr); } }
    .info-card {
      padding: 14px 14px 12px;
      background: color-mix(in oklab, var(--g-bg) 42%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius-lg);
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color var(--g-motion-fast, 180ms ease),
                  transform     var(--g-motion-fast, 180ms ease),
                  box-shadow    var(--g-motion-medium, 260ms ease);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 8px 32px color-mix(in oklab, black 35%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 7%, transparent),
        inset 0 -1px 0 color-mix(in oklab, black 30%, transparent);
    }
    .info-card::before {
      content: "";
      position: absolute;
      top: 0; left: 8%; right: 8%;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 14%, transparent) 50%,
        transparent);
      pointer-events: none;
      z-index: 2;
    }
    :root[data-theme="light"] .info-card {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    :root[data-theme="light"] .info-card::before {
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 55%, transparent) 50%,
        transparent);
    }
    @media (prefers-reduced-motion: no-preference) {
      .info-card:hover {
        border-color: color-mix(in oklab, var(--g-primary) 30%, transparent);
        transform: translateY(-2px);
        box-shadow:
          0 14px 44px color-mix(in oklab, black 45%, transparent),
          inset 0 0 0 1px color-mix(in oklab, white 9%, transparent),
          inset 0 -1px 0 color-mix(in oklab, black 30%, transparent);
      }
    }

    .wf-wrap { display: flex; justify-content: flex-end; opacity: 0.6; margin-bottom: 2px; }
    .wf-glyph { width: 40px; height: 46px; }
    .wf-id-label {
      text-anchor: middle;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 6px;
      opacity: 0.65;
      letter-spacing: 0.10em;
    }

    .card-header {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: var(--g-primary);
      margin-top: 6px;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-vendor { color: var(--g-fg-faint); font-weight: 400; letter-spacing: 0.06em; }
    .card-row {
      font-size: 11px;
      color: var(--g-fg-dim);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .val { color: var(--g-fg); font-weight: 700; font-variant-numeric: tabular-nums; font-size: 12px; flex-shrink: 0; }
    .val.accent, .accent { color: var(--g-primary); }
    .unit { color: var(--g-fg-faint); font-weight: 400; font-size: 10px; }
    .unit.muted { opacity: 0.7; }
    .muted { color: var(--g-fg-faint); }
    .cpu-model { font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .no-gpu {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px; font-weight: 700; letter-spacing: 0.14em;
      color: var(--g-fg-faint); text-align: center; padding: 6px 0;
      text-transform: uppercase;
    }
    .mini-bar-wrap {
      height: 6px;
      background: var(--g-surface);
      border: 1px solid var(--g-border);
      border-radius: 3px;
      overflow: hidden;
      margin: 4px 0 2px;
      position: relative;
    }
    .mini-bar {
      height: 100%;
      transition: width 600ms cubic-bezier(0.22,1,0.36,1),
                  background var(--g-motion-medium, 260ms ease);
    }
    .mini-bar-val {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      font-weight: 700;
      color: var(--g-fg-dim);
      font-variant-numeric: tabular-nums;
      pointer-events: none;
      letter-spacing: 0.04em;
      text-shadow: 0 1px 2px var(--g-edge-shadow);
    }

    /* ── Insights panel ──────────────────────────────────────────── */
    .insights-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .insights-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; flex: 1; }
    .insight-row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 8px 10px;
      background: var(--g-surface);
      border: 1px solid var(--g-border);
      border-radius: var(--g-radius-sm);
      min-width: 0;
      transition: border-color var(--g-motion-fast, 180ms ease),
                  background  var(--g-motion-fast, 180ms ease);
    }
    .insight-row.sev-row-critical { border-color: color-mix(in oklab, var(--g-state-danger) 32%, var(--g-border)); background: var(--g-state-danger-soft); }
    .insight-row.sev-row-warn     { border-color: color-mix(in oklab, var(--g-state-warn)   28%, var(--g-border)); background: var(--g-state-warn-soft); }
    .insight-row.sev-row-info     { border-color: var(--g-border); }

    .insight-icon {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--g-fg-faint);
      margin-top: 1px;
    }
    .insight-icon svg { width: 14px; height: 14px; }
    .insight-icon.sev-critical { color: var(--g-state-danger); }
    .insight-icon.sev-warn     { color: var(--g-state-warn); }
    .insight-icon.sev-info     { color: var(--g-state-info); }
    .insight-body { min-width: 0; }
    .insight-text {
      font-size: 11px;
      color: var(--g-fg-dim);
      line-height: 1.55;
      min-width: 0;
      word-wrap: break-word;
    }
    .insight-pill {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid;
      align-self: center;
      flex-shrink: 0;
    }
    .insight-pill.sev-critical { color: var(--g-state-danger); border-color: color-mix(in oklab, var(--g-state-danger) 40%, transparent); background: var(--g-state-danger-soft); }
    .insight-pill.sev-warn     { color: var(--g-state-warn);   border-color: color-mix(in oklab, var(--g-state-warn) 40%, transparent);   background: var(--g-state-warn-soft); }
    .insight-pill.sev-info     { color: var(--g-state-info);   border-color: color-mix(in oklab, var(--g-state-info) 35%, transparent);   background: var(--g-state-info-soft); }

    .insights-list::-webkit-scrollbar { width: 4px; }
    .insights-list::-webkit-scrollbar-track { background: transparent; }
    .insights-list::-webkit-scrollbar-thumb { background: var(--g-border); border-radius: 2px; }

    /* ── Federation node strip ───────────────────────────────────── */
    .node-strip {
      padding: 10px 14px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      flex-shrink: 0;
      background: color-mix(in oklab, var(--g-bg) 30%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      border-radius: var(--g-radius);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 6px 22px color-mix(in oklab, black 30%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 6%, transparent);
    }
    :root[data-theme="light"] .node-strip {
      background: color-mix(in oklab, white 45%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .node-strip > .section-eyebrow { padding-top: 4px; flex-shrink: 0; }
    .node-strip-chips { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
    .node-chip {
      appearance: none;
      background: color-mix(in oklab, var(--g-bg) 40%, transparent);
      border: 1px solid color-mix(in oklab, white 7%, transparent);
      color: var(--g-fg-dim);
      padding: 8px 12px 8px 10px;
      display: flex;
      align-items: flex-start;
      gap: 9px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      transition: border-color var(--g-motion-fast, 180ms ease),
                  background  var(--g-motion-fast, 180ms ease),
                  box-shadow  var(--g-motion-medium, 260ms ease);
      text-align: left;
      border-radius: var(--g-radius-sm);
      min-width: 200px;
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
    }
    .node-chip:hover {
      border-color: color-mix(in oklab, var(--g-primary) 30%, transparent);
      background: color-mix(in oklab, var(--g-bg) 50%, transparent);
    }
    :root[data-theme="light"] .node-chip {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    :root[data-theme="light"] .node-chip:hover {
      background: color-mix(in oklab, white 70%, transparent);
    }
    .node-chip-active {
      border-color: var(--g-primary);
      background: var(--g-primary-soft);
      box-shadow: inset 0 0 0 1px var(--g-primary-muted),
                  0 0 18px color-mix(in oklab, var(--g-primary) 12%, transparent);
    }
    .node-chip-glyph {
      display: inline-flex;
      color: var(--g-fg-faint);
      flex-shrink: 0;
      padding-top: 1px;
    }
    .node-chip-active .node-chip-glyph { color: var(--g-primary); }
    .node-chip-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
    .node-chip-name {
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--g-fg);
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .node-chip-badge {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      padding: 1px 5px;
      background: var(--g-state-success-soft);
      color: var(--g-state-success);
      border: 1px solid color-mix(in oklab, var(--g-state-success) 30%, transparent);
      border-radius: 4px;
      flex-shrink: 0;
    }
    .node-chip-stats {
      display: flex;
      gap: 6px;
      align-items: center;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      color: var(--g-fg-faint);
      letter-spacing: 0.06em;
    }
    .node-chip-role { text-transform: uppercase; letter-spacing: 0.14em; }
    .node-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--g-fg-faint); flex-shrink: 0; }
    .node-chip-dot.dot-online { background: var(--g-state-success); }
    /* Pulse ONLY when online + fresh (snapshot within last 5s). */
    @media (prefers-reduced-motion: no-preference) {
      .node-chip-dot.dot-fresh {
        animation: hw-node-pulse 1.8s ease-in-out infinite;
      }
    }
    @keyframes hw-node-pulse {
      0%, 100% { box-shadow: 0 0 0 0 var(--g-state-success-soft); }
      50%       { box-shadow: 0 0 0 5px transparent; }
    }
    .node-chip-dot.dot-stale   { background: var(--g-state-warn); }
    .node-chip-dot.dot-offline { background: var(--g-state-danger); }
    .node-chip-offline {
      opacity: 0.5;
      filter: saturate(0.4);
    }
    .node-chip-age { font-variant-numeric: tabular-nums; }

    .chip-metric-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-top: 4px;
    }
    .chip-metric {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .chip-metric-label {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 7px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--g-fg-faint);
    }
    .chip-metric-svg { width: 100%; height: 12px; display: block; }
    .chip-metric-val {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
    }

    /* ── Dense row: heatmap + processes + network ────────────────── */
    .dense-row {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(280px, 1.6fr) minmax(220px, 1.2fr);
      gap: 14px;
      flex-shrink: 0;
    }
    @media (max-width: 1300px) { .dense-row { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 900px)  { .dense-row { grid-template-columns: 1fr; } }

    /* ── Per-core heatmap ────────────────────────────────────────── */
    .heatmap { padding: 14px 16px; }
    .heatmap-grid {
      display: grid;
      grid-template-columns: repeat(var(--hm-cols, 8), 1fr);
      gap: 4px;
    }
    .heatmap-cell {
      aspect-ratio: 1 / 1;
      border: 1px solid color-mix(in oklab, var(--g-border) 60%, transparent);
      border-radius: 3px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      transition: background var(--g-motion-medium, 280ms ease),
                  border-color var(--g-motion-fast, 180ms ease);
    }
    .heatmap-cell.hm-warn { border-color: color-mix(in oklab, var(--g-state-warn) 50%, transparent); }
    .heatmap-cell.hm-crit { border-color: color-mix(in oklab, var(--g-state-danger) 60%, transparent); }
    .hm-cell-pct {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 11px;
      font-weight: 700;
      color: var(--g-fg);
      letter-spacing: -0.02em;
      text-shadow: 0 1px 2px var(--g-edge-shadow);
    }
    .hm-cell-idx {
      position: absolute;
      bottom: 1px;
      right: 3px;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 7px;
      color: var(--g-fg);
      opacity: 0.55;
      letter-spacing: 0.04em;
    }
    .heatmap-scale {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      color: var(--g-fg-faint);
      letter-spacing: 0.06em;
    }
    .heatmap-scale-bar {
      flex: 1;
      height: 3px;
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--g-metric-cpu) 18%, transparent) 0%,
        var(--g-metric-cpu) 100%);
      border: 1px solid var(--g-border);
      border-radius: 2px;
    }

    /* ── Process panel ───────────────────────────────────────────── */
    .proc-panel { padding: 14px 16px; }
    .proc-empty {
      font-size: 11px;
      padding: 14px 0;
      text-align: center;
      color: var(--g-fg-faint);
      letter-spacing: 0.06em;
    }
    .proc-table { display: flex; flex-direction: column; gap: 4px; }
    .proc-thead,
    .proc-row {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(80px, 1.2fr) 56px 64px 50px;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .proc-thead {
      padding: 4px 6px 6px;
      border-bottom: 1px solid var(--g-border);
      margin-bottom: 2px;
    }
    .proc-th {
      appearance: none;
      background: transparent;
      border: none;
      color: var(--g-fg-faint);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
      padding: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: color var(--g-motion-fast, 180ms ease);
    }
    .proc-th:hover { color: var(--g-fg-dim); }
    .proc-th.is-active { color: var(--g-primary); }
    .proc-th-right { justify-content: flex-end; text-align: right; }
    .proc-sort-ind {
      font-size: 9px;
      opacity: 0.85;
      width: 8px;
      display: inline-block;
      text-align: center;
    }
    .proc-sort-ind.dim { opacity: 0.4; }

    .proc-rows {
      display: flex;
      flex-direction: column;
      gap: 1px;
      max-height: 280px;
      overflow-y: auto;
    }
    .proc-rows::-webkit-scrollbar { width: 4px; }
    .proc-rows::-webkit-scrollbar-thumb { background: var(--g-border); border-radius: 2px; }

    .proc-row {
      position: relative;
      padding: 5px 6px;
      font-size: 11px;
      border-radius: 3px;
      transition: background var(--g-motion-fast, 180ms ease);
      isolation: isolate;
    }
    .proc-row:hover { background: var(--g-surface-hover); }
    /* Bklit "gradient bar IN the row" — top-N rows get a primary-tinted
       gradient that grows with cpu%, not a flat background highlight. */
    .proc-row-glow {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: -1;
      border-radius: 3px;
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--g-metric-cpu) 14%, transparent) 0%,
        color-mix(in oklab, var(--g-metric-cpu) 6%, transparent) var(--row-glow-pct, 50%),
        transparent 100%);
    }
    .proc-row-top .proc-rank { color: var(--g-metric-cpu); }
    .proc-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .proc-rank {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      color: var(--g-fg-faint);
      font-variant-numeric: tabular-nums;
      width: 14px;
      flex-shrink: 0;
    }
    .proc-name-text {
      color: var(--g-fg);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .proc-bar {
      height: 6px;
      background: var(--g-surface);
      border: 1px solid var(--g-border);
      border-radius: 3px;
      overflow: hidden;
      position: relative;
    }
    .proc-bar-fill {
      height: 100%;
      transition: width 380ms cubic-bezier(0.22,1,0.36,1),
                  background var(--g-motion-medium, 280ms ease);
    }
    .proc-cpu {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-weight: 700;
      font-size: 11px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .proc-mem,
    .proc-pid {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Hover action cluster — overlaid on the right side of the row. */
    .proc-actions {
      position: absolute;
      top: 50%;
      right: 6px;
      transform: translateY(-50%);
      display: flex;
      gap: 4px;
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--g-motion-fast, 180ms ease);
      background: color-mix(in oklab, var(--g-surface-strong) 92%, transparent);
      backdrop-filter: var(--g-blur);
      -webkit-backdrop-filter: var(--g-blur);
      padding: 3px 6px;
      border-radius: 999px;
      border: 1px solid var(--g-border);
    }
    .proc-row:hover .proc-actions {
      opacity: 1;
      pointer-events: auto;
    }
    .proc-act {
      appearance: none;
      background: transparent;
      border: none;
      width: 22px; height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--g-fg-dim);
      cursor: pointer;
      border-radius: 6px;
      transition: background var(--g-motion-fast, 180ms ease),
                  color      var(--g-motion-fast, 180ms ease);
    }
    .proc-act:hover { background: var(--g-surface-hover); color: var(--g-primary); }
    .proc-act.proc-act-danger:hover { color: var(--g-state-danger); background: var(--g-state-danger-soft); }
    .proc-act svg { width: 13px; height: 13px; }

    /* ── Stacked network strip ───────────────────────────────────── */
    .net-strip { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
    .net-svg { width: 100%; height: 96px; display: block; }
    .net-empty {
      font-size: 11px;
      padding: 20px 0;
      text-align: center;
      color: var(--g-fg-faint);
      letter-spacing: 0.06em;
    }
    .net-legend {
      display: flex;
      gap: 14px;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      color: var(--g-fg-dim);
      letter-spacing: 0.04em;
    }
    .net-legend-item { display: inline-flex; align-items: center; gap: 6px; }
    .net-legend-dot { width: 8px; height: 2px; border-radius: 1px; flex-shrink: 0; }
    .net-legend-val { color: var(--g-fg); font-variant-numeric: tabular-nums; margin-left: 2px; }

    /* ── Loading shimmer (mirrors subagent-activity-panel sweep) ── */
    .loading-shim {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px 0;
    }
    .shim-bar {
      height: 10px;
      width: 100%;
      border-radius: 4px;
      background: linear-gradient(90deg,
        var(--g-surface),
        var(--g-surface-hover),
        var(--g-surface));
      background-size: 200% 100%;
      animation: hw-shimmer 1.6s linear infinite;
    }
    .shim-2 { width: 80%; }
    .shim-3 { width: 65%; }
    @keyframes hw-shimmer {
      from { background-position: 0% 50%; }
      to   { background-position: -200% 50%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .shim-bar { animation: none; }
    }

    /* ── Error strip ─────────────────────────────────────────────── */
    .hud-error {
      flex-shrink: 0;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      color: var(--g-state-warn);
      padding: 6px 12px;
      background: var(--g-state-warn-soft);
      border: 1px solid color-mix(in oklab, var(--g-state-warn) 30%, transparent);
      border-radius: var(--g-radius-sm);
      letter-spacing: 0.06em;
    }

    /* ── View-mode toggle (FOCUS / FLEET) ────────────────────────── */
    .vm-toggle {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--g-bg) 40%, transparent);
      border: 1px solid color-mix(in oklab, white 6%, transparent);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      flex-shrink: 0;
    }
    :root[data-theme="light"] .vm-toggle {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .vm-pill {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--g-fg-dim);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      padding: 5px 11px;
      border-radius: 999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background var(--g-motion-fast, 180ms ease),
                  color      var(--g-motion-fast, 180ms ease),
                  box-shadow var(--g-motion-medium, 260ms ease);
    }
    .vm-pill:hover { color: var(--g-fg); background: color-mix(in oklab, var(--g-primary) 10%, transparent); }
    .vm-pill-active {
      color: var(--g-bg);
      background: linear-gradient(135deg, var(--g-primary), var(--g-accent, var(--g-primary)));
      box-shadow: 0 4px 16px color-mix(in oklab, var(--g-primary) 30%, transparent),
                  inset 0 0 0 1px color-mix(in oklab, white 25%, transparent);
    }
    :root[data-theme="light"] .vm-pill-active { color: white; }
    .vm-pill-disabled { opacity: 0.45; cursor: not-allowed; }
    .vm-pill-disabled:hover { background: transparent; color: var(--g-fg-faint); }
    .vm-glyph { font-size: 11px; line-height: 1; opacity: 0.85; }
    .vm-count {
      font-size: 8px;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--g-bg) 35%, transparent);
      color: inherit;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.08em;
    }
    .vm-pill-active .vm-count { background: color-mix(in oklab, var(--g-bg) 28%, transparent); }

    /* ── Fleet overview grid ─────────────────────────────────────── */
    .hud-body-fleet {
      display: block;
      overflow: auto;
      grid-template-columns: none;
    }
    .fleet-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 14px;
      padding: 4px;
    }
    .fleet-empty {
      padding: 28px 18px;
      text-align: center;
      color: var(--g-fg-dim);
    }
    .fleet-empty-body { margin-top: 12px; font-size: 11px; letter-spacing: 0.04em; }

    .fleet-card {
      appearance: none;
      text-align: left;
      cursor: pointer;
      color: var(--g-fg);
      font-family: inherit;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px 14px 12px;
      background: color-mix(in oklab, var(--g-bg) 42%, transparent);
      border: 1px solid color-mix(in oklab, white 7%, transparent);
      border-radius: var(--g-radius-lg);
      backdrop-filter: blur(24px) saturate(140%);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      box-shadow:
        0 8px 32px color-mix(in oklab, black 35%, transparent),
        inset 0 0 0 1px color-mix(in oklab, white 7%, transparent);
      transition:
        transform     var(--g-motion-fast, 180ms ease),
        border-color  var(--g-motion-fast, 180ms ease),
        box-shadow    var(--g-motion-medium, 260ms ease);
      position: relative;
      overflow: hidden;
    }
    .fleet-card::before {
      content: "";
      position: absolute;
      top: 0; left: 8%; right: 8%;
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in oklab, white 14%, transparent) 50%,
        transparent);
      pointer-events: none;
      z-index: 2;
    }
    @media (prefers-reduced-motion: no-preference) {
      .fleet-card:hover {
        transform: translateY(-2px);
        border-color: color-mix(in oklab, var(--g-primary) 35%, transparent);
        box-shadow:
          0 14px 44px color-mix(in oklab, black 45%, transparent),
          inset 0 0 0 1px color-mix(in oklab, white 9%, transparent);
      }
    }
    :root[data-theme="light"] .fleet-card {
      background: color-mix(in oklab, white 55%, transparent);
      border-color: color-mix(in oklab, black 8%, transparent);
    }
    .fleet-card-selected {
      border-color: var(--g-primary);
      box-shadow:
        0 10px 36px color-mix(in oklab, black 40%, transparent),
        inset 0 0 0 1px var(--g-primary-muted),
        0 0 0 1px color-mix(in oklab, var(--g-primary) 30%, transparent);
    }
    .fleet-card.status-critical { border-color: color-mix(in oklab, var(--g-state-danger) 38%, transparent); }
    .fleet-card.status-elevated { border-color: color-mix(in oklab, var(--g-state-warn) 30%, transparent); }
    .fleet-card-empty { opacity: 0.7; }

    .fleet-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .fleet-card-glyph {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in oklab, var(--g-primary) 14%, transparent);
      color: var(--g-primary);
      flex-shrink: 0;
    }
    .fleet-card-glyph-satellite,
    .fleet-card-glyph-standalone {
      background: color-mix(in oklab, var(--g-metric-net) 14%, transparent);
      color: var(--g-metric-net);
    }
    .fleet-card-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .fleet-card-name {
      font-weight: 700;
      letter-spacing: 0.04em;
      font-size: 12px;
      color: var(--g-fg);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fleet-card-sub {
      display: flex;
      gap: 6px;
      align-items: center;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      color: var(--g-fg-faint);
      letter-spacing: 0.08em;
    }
    .fleet-card-role { text-transform: uppercase; letter-spacing: 0.16em; }
    .fleet-card-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--g-fg-faint);
      flex-shrink: 0;
    }
    .fleet-card-dot.dot-online  { background: var(--g-state-success); }
    .fleet-card-dot.dot-stale   { background: var(--g-state-warn); }
    .fleet-card-dot.dot-offline { background: var(--g-state-danger); }
    @media (prefers-reduced-motion: no-preference) {
      .fleet-card-dot.dot-fresh {
        animation: hw-node-pulse 1.8s ease-in-out infinite;
      }
    }
    .fleet-card-age { font-variant-numeric: tabular-nums; }
    .fleet-card-tag {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--g-state-success-soft);
      color: var(--g-state-success);
      border: 1px solid color-mix(in oklab, var(--g-state-success) 30%, transparent);
      flex-shrink: 0;
    }
    .fleet-card-no-data {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 10px;
      text-align: center;
      padding: 10px;
      color: var(--g-fg-faint);
      letter-spacing: 0.06em;
    }

    .fleet-rings {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .fleet-ring {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 6px 0;
      border-radius: var(--g-radius-sm);
      background: color-mix(in oklab, var(--ring-color) 6%, transparent);
      transition: background var(--g-motion-fast, 180ms ease);
    }
    .fleet-ring-svg { width: 56px; height: 56px; display: block; }
    .fleet-ring-val {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 14px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: middle;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
    }
    .fleet-ring-unit {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 6px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-anchor: middle;
      dominant-baseline: middle;
      fill: var(--g-fg-faint);
      text-transform: uppercase;
    }
    .fleet-ring-label {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--g-fg-dim);
    }
    .fleet-ring-sub {
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 8px;
      letter-spacing: 0.10em;
      color: var(--g-fg-faint);
      text-transform: uppercase;
    }

    .fleet-card-foot {
      display: flex;
      gap: 14px;
      padding-top: 8px;
      border-top: 1px solid color-mix(in oklab, var(--g-border) 80%, transparent);
      font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 9px;
      color: var(--g-fg-dim);
      letter-spacing: 0.06em;
    }
    .fleet-card-foot-cell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .fleet-card-foot-label {
      font-size: 7.5px;
      font-weight: 700;
      letter-spacing: 0.18em;
      color: var(--g-fg-faint);
      text-transform: uppercase;
    }
    .fleet-card-foot-val {
      color: var(--g-fg);
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.04em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "hardware-analysis": HardwareAnalysis;
  }
}
