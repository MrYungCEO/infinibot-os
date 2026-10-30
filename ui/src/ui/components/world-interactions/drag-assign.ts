/**
 * drag-assign.ts — drag an idle agent onto a sector building to spawn a task
 * assigned to that sector.
 *
 * Lifecycle (driven by <world-interactions> pointer routing):
 *   begin(agent, x, y) → move(x, y)* → end(x, y)
 *
 * On drop over a valid sector we fire `sessions.spawn` with a tiny pre-fill
 * ("assigned via drag to <sector>"). Visuals: a ghost agent follows the cursor,
 * valid drop zones glow gold, the hovered zone pulses, and an invalid drop
 * (anywhere with no sector) shows a brief red reject flash.
 */
import { html, svg, type TemplateResult } from "lit";
import type { FxAgent, InteractionHost, WorldSector } from "./types.js";
import {
  agentLabel,
  callRpc,
  hitTestSector,
  readSectors,
} from "./world-state.js";

interface DragState {
  agent: FxAgent;
  /** Current ghost position (host-relative px). */
  x: number;
  y: number;
  hovered: WorldSector | null;
}

export class DragAssignController {
  private drag: DragState | null = null;
  /** Set briefly on an invalid drop to flash a reject marker. */
  private reject: { x: number; y: number; t: number } | null = null;

  constructor(private readonly host: InteractionHost) {}

  get active(): boolean {
    return this.drag !== null;
  }

  begin(agent: FxAgent, x: number, y: number): void {
    this.drag = { agent, x, y, hovered: null };
    this.reject = null;
    this.host.requestUpdate();
  }

  move(x: number, y: number): void {
    if (!this.drag) return;
    this.drag.x = x;
    this.drag.y = y;
    this.drag.hovered = hitTestSector(readSectors(), x, y);
    this.host.requestUpdate();
  }

  end(x: number, y: number): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const sector = hitTestSector(readSectors(), x, y);
    if (sector) {
      void this.assign(d.agent, sector);
    } else {
      this.reject = { x, y, t: 1 };
      this.host.toast("No drop zone here", "err");
      // Clear the reject flash after the CSS animation window.
      window.setTimeout(() => {
        this.reject = null;
        this.host.requestUpdate();
      }, 520);
    }
    this.host.requestUpdate();
  }

  cancel(): void {
    if (!this.drag) return;
    this.drag = null;
    this.host.requestUpdate();
  }

  private async assign(agent: FxAgent, sector: WorldSector): Promise<void> {
    const label = agentLabel(agent);
    const task = `Assigned via drag to ${sector.name}. Continue ${label}'s work in this area.`;
    this.host.toast(`Assigning to ${sector.name}…`);
    const out = await callRpc("sessions.spawn", {
      task,
      label: `${sector.name} · ${label}`,
    });
    this.host.toast(
      out.ok ? `Spawned in ${sector.name}` : `Spawn failed: ${out.error ?? "error"}`,
      out.ok ? "ok" : "err",
    );
  }

  /** Overlay markup: drop-zone highlights, the cursor ghost, reject flash. */
  render(): TemplateResult {
    const d = this.drag;
    const sectors = d ? readSectors() : [];
    return html`
      ${d
        ? svg`
            <svg class="wi-svg" aria-hidden="true">
              ${sectors.map((s) => {
                const hw = s.w ?? 44;
                const hh = s.h ?? 44;
                const hot = d.hovered?.id === s.id;
                return svg`
                  <rect
                    class="wi-dropzone ${hot ? "hot" : ""}"
                    x=${s.x - hw}
                    y=${s.y - hh}
                    width=${hw * 2}
                    height=${hh * 2}
                    rx="10"
                  ></rect>
                  <text
                    class="wi-dropzone-label ${hot ? "hot" : ""}"
                    x=${s.x}
                    y=${s.y - hh - 8}
                    text-anchor="middle"
                  >${s.name}</text>
                `;
              })}
            </svg>`
        : ""}
      ${d
        ? html`<div
            class="wi-ghost"
            style="left:${d.x}px;top:${d.y}px"
            aria-hidden="true"
          >
            <span class="wi-ghost-dot"></span>
            <span class="wi-ghost-label">${agentLabel(d.agent)}</span>
          </div>`
        : ""}
      ${this.reject
        ? html`<div
            class="wi-reject"
            style="left:${this.reject.x}px;top:${this.reject.y}px"
            aria-hidden="true"
          >
            ✕
          </div>`
        : ""}
    `;
  }
}
