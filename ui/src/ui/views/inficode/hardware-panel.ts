/**
 * InfiCode — HARDWARE panel (streaming).
 *
 * Self-contained custom element that mirrors the EventSource pattern in
 * views/hardware-analysis.ts: probe GET /api/hardware/nodes, then stream via
 * GET /api/hardware/nodes/stream (federation) with a fallback to the single-host
 * GET /api/hardware/stream. Shows cpu/gpu/mem/disk as monospace bar meters for
 * the SELECTED device (defaults to the local/hub node).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import type { HardwareSnapshot } from "../../../../../src/gateway/server-hardware-http.js";
import { INFICODE_STYLES } from "./styles.js";
import { barMeter, meterColor } from "./helpers.js";

interface NodeHwEntry {
  nodeId: string;
  nodeName: string;
  isLocal: boolean;
  snapshot: HardwareSnapshot | null;
}
interface NodeHwMap {
  role: "master" | "standalone";
  nodes: NodeHwEntry[];
}

@customElement("inficode-hardware")
export class InfiCodeHardware extends LitElement {
  static styles = INFICODE_STYLES;

  /** Node id to display. Falls back to local/hub when unset or absent. */
  @property({ type: String }) selectedNodeId: string | null = null;

  @state() private snapshot: HardwareSnapshot | null = null;
  @state() private hostName = "";
  @state() private nodes: NodeHwEntry[] = [];
  @state() private connected = false;

  private es: EventSource | null = null;
  private nodesEs: EventSource | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.probeAndStart();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stop();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("selectedNodeId")) this.pickSnapshot();
  }

  private stop(): void {
    this.es?.close();
    this.es = null;
    this.nodesEs?.close();
    this.nodesEs = null;
  }

  private async probeAndStart(): Promise<void> {
    try {
      const res = await fetch("/api/hardware/nodes");
      if (res.ok) {
        this.ingestNodeMap((await res.json()) as NodeHwMap);
        this.startNodesStream();
        return;
      }
    } catch {
      /* fall through to single-host stream */
    }
    this.startStream();
  }

  private startStream(): void {
    this.es = new EventSource("/api/hardware/stream");
    this.es.addEventListener("message", (e: MessageEvent) => {
      try {
        this.snapshot = JSON.parse(e.data as string) as HardwareSnapshot;
        this.hostName = this.snapshot.system.hostname;
        this.connected = true;
      } catch {
        /* ignore malformed frame */
      }
    });
    this.es.addEventListener("error", () => {
      this.connected = false;
    });
  }

  private startNodesStream(): void {
    this.nodesEs = new EventSource("/api/hardware/nodes/stream");
    this.nodesEs.addEventListener("message", (e: MessageEvent) => {
      try {
        this.ingestNodeMap(JSON.parse(e.data as string) as NodeHwMap);
        this.connected = true;
      } catch {
        /* ignore */
      }
    });
    this.nodesEs.addEventListener("error", () => {
      this.connected = false;
    });
  }

  private ingestNodeMap(map: NodeHwMap): void {
    this.nodes = Array.isArray(map?.nodes) ? map.nodes : [];
    this.pickSnapshot();
  }

  private pickSnapshot(): void {
    if (this.nodes.length === 0) return;
    const wanted =
      (this.selectedNodeId && this.nodes.find((n) => n.nodeId === this.selectedNodeId)) ||
      this.nodes.find((n) => n.isLocal) ||
      this.nodes[0];
    if (wanted?.snapshot) {
      this.snapshot = wanted.snapshot;
      this.hostName = wanted.nodeName || wanted.snapshot.system.hostname;
    }
  }

  private meter(label: string, pct: number, valueLabel: string) {
    return html`
      <div class="ic-meter-row">
        <span class="ic-meter-label">${label}</span>
        <span class="ic-meter-bar" style="color:${meterColor(pct)}">${barMeter(pct, 20)}</span>
        <span class="ic-meter-val" style="color:${meterColor(pct)}">${valueLabel}</span>
      </div>
    `;
  }

  override render() {
    const s = this.snapshot;
    return html`
      <div class="ic-panel">
        <div class="ic-panel-head">
          <span class="ic-corner">┼</span>
          <span class="ic-title">HARDWARE</span>
          <span class="ic-meta"><span>${this.connected ? "◉ live" : "○ …"}</span></span>
        </div>
        <div class="ic-panel-body">
          ${!s
            ? html`<div class="ic-dim">connecting to /api/hardware/stream…</div>`
            : html`
                <div class="ic-hw-host">host · ${this.hostName || s.system.hostname}</div>
                ${this.meter("CPU", s.cpu.percent, `${s.cpu.percent}%`)}
                ${this.meter("MEM", s.memory.percent, `${s.memory.percent}%`)}
                ${s.gpu
                  ? this.meter("GPU", s.gpu.utilizationPercent, `${s.gpu.utilizationPercent}%`)
                  : html`<div class="ic-meter-row">
                      <span class="ic-meter-label">GPU</span>
                      <span class="ic-meter-bar ic-dim">${barMeter(0, 20)}</span>
                      <span class="ic-meter-val ic-dim">n/a</span>
                    </div>`}
                ${s.disk?.mounts?.[0]
                  ? this.meter("DISK", s.disk.mounts[0].percent, `${s.disk.mounts[0].percent}%`)
                  : nothing}
              `}
        </div>
      </div>
    `;
  }
}
