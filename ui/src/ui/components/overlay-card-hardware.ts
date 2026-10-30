/**
 * overlay-card-hardware.ts — live CPU / GPU / RAM / disk / network.
 *
 * Data source: the SAME `/api/hardware/stream` SSE the /hardware page consumes
 * (`hardware-analysis.ts`), emitting a HardwareSnapshot every ~1 s. No new
 * gateway poll — we just open the existing telemetry stream.
 */
import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base.js";
import type { HardwareSnapshot } from "../../../../src/gateway/server-hardware-http.js";

function fmtBytes(n: number): string {
  if (!n) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${u[i]}`;
}

function fmtRate(bps: number): string {
  return `${fmtBytes(bps)}/s`;
}

@customElement("overlay-card-hardware")
export class OverlayCardHardware extends OverlayCardBase {
  @state() private snap: HardwareSnapshot | null = null;
  @state() private connected = false;

  private es: EventSource | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.startStream();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopStream();
  }

  private startStream() {
    this.stopStream();
    try {
      this.es = new EventSource("/api/hardware/stream");
      this.es.addEventListener("message", (e: MessageEvent) => {
        try {
          this.snap = JSON.parse(e.data as string) as HardwareSnapshot;
          this.connected = true;
        } catch {
          /* ignore malformed frame */
        }
      });
      this.es.addEventListener("error", () => {
        this.connected = false;
      });
    } catch {
      this.connected = false;
    }
  }

  private stopStream() {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  protected accent = "#22d3ee";

  protected cardTitle() {
    return this.snap?.system.hostname ? `HW · ${this.snap.system.hostname}` : "Hardware";
  }

  protected headerMeta() {
    return this.connected ? "live" : "…";
  }

  private bar(label: string, pct: number, sub?: string) {
    const p = Math.max(0, Math.min(100, pct));
    const color = p > 85 ? "#ef4444" : p > 60 ? "#f59e0b" : "#22d3ee";
    return html`
      <div class="metric">
        <div class="m-top">
          <span class="m-label">${label}</span>
          <span class="m-val">${p.toFixed(0)}%</span>
        </div>
        <div class="track"><div class="fill" style=${`width:${p}%;background:${color}`}></div></div>
        ${sub ? html`<div class="m-sub">${sub}</div>` : null}
      </div>
    `;
  }

  protected renderBody() {
    const s = this.snap;
    if (!s) return html`<div class="muted">Connecting to telemetry…</div>`;

    const gpu = s.gpu;
    const mounts = s.disk?.mounts ?? [];
    const rootMount = mounts.find((m) => m.path === "/" || m.path === "C:\\") ?? mounts[0];
    const ifaces = s.network?.interfaces ?? [];
    const totalRx = ifaces.reduce((a, i) => a + (i.rxBytesPerSec || 0), 0);
    const totalTx = ifaces.reduce((a, i) => a + (i.txBytesPerSec || 0), 0);

    return html`
      <div class="metrics">
        ${this.bar("CPU", s.cpu.percent, `${s.cpu.cores} cores · load ${s.cpu.loadAvg[0]?.toFixed(2) ?? "—"}`)}
        ${this.bar(
          "RAM",
          s.memory.percent,
          `${fmtBytes(s.memory.usedBytes)} / ${fmtBytes(s.memory.totalBytes)}`,
        )}
        ${gpu
          ? this.bar(
              "GPU",
              gpu.utilizationPercent,
              `${gpu.name || gpu.vendor} · ${fmtBytes(gpu.vramUsedBytes)}/${fmtBytes(gpu.vramTotalBytes)}`,
            )
          : html`<div class="metric"><div class="m-top"><span class="m-label">GPU</span><span class="m-val">n/a</span></div></div>`}
        ${rootMount
          ? this.bar(
              "DISK",
              rootMount.percent,
              `${rootMount.path} · ${fmtBytes(rootMount.usedBytes)}/${fmtBytes(rootMount.totalBytes)}`,
            )
          : null}
      </div>
      <div class="net">
        <span class="net-item">↓ ${fmtRate(totalRx)}</span>
        <span class="net-item">↑ ${fmtRate(totalTx)}</span>
        <span class="net-sub">${s.system.platform}/${s.system.arch}</span>
      </div>
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .muted { font-size: 11px; color: #71717a; }
      .metrics { display: flex; flex-direction: column; gap: 9px; min-width: 250px; }
      .metric { display: flex; flex-direction: column; gap: 3px; }
      .m-top { display: flex; justify-content: space-between; align-items: baseline; }
      .m-label {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: #a1a1aa;
      }
      .m-val { font-size: 11px; font-weight: 700; color: #e4e4e7; }
      .track {
        height: 5px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }
      .fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
      .m-sub { font-size: 8px; color: #71717a; }
      .net {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid color-mix(in srgb, #22d3ee 14%, transparent);
        font-size: 10px;
      }
      .net-item { color: #22d3ee; font-weight: 700; }
      .net-sub { margin-left: auto; color: #52525b; font-size: 8px; }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-hardware": OverlayCardHardware;
  }
}
