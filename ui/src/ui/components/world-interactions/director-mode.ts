/**
 * director-mode.ts — paint-select multiple agents, then issue group commands.
 *
 * Enter with hotkey D (or the toolbar button). Drag a rectangle to paint-select
 * agents; Shift-click toggles individual agents. A top action bar exposes Group
 * Stop / Group Respawn / Group Send Message / Tag as Crew. Esc exits.
 *
 * Pointer routing is owned by <world-interactions>; this controller holds the
 * selection model + group-action logic and renders the tint, selection rect,
 * selection halos, and action bar.
 */
import { html, svg, type TemplateResult } from "lit";
import type { FxAgent, InteractionHost } from "./types.js";
import {
  agentLabel,
  agentRpcTarget,
  agentsInRect,
  callRpc,
  readAgents,
} from "./world-state.js";

interface RectState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class DirectorModeController {
  private _active = false;
  private rect: RectState | null = null;
  private selected = new Set<string>();

  constructor(private readonly host: InteractionHost) {}

  get active(): boolean {
    return this._active;
  }

  get selecting(): boolean {
    return this.rect !== null;
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  enter(): void {
    this._active = true;
    this.host.requestUpdate();
  }

  exit(): void {
    this._active = false;
    this.rect = null;
    this.selected.clear();
    this.host.requestUpdate();
  }

  toggle(): void {
    this._active ? this.exit() : this.enter();
  }

  /** Shift-click an agent to add/remove it from the selection. */
  toggleAgent(agent: FxAgent): void {
    if (this.selected.has(agent.id)) this.selected.delete(agent.id);
    else this.selected.add(agent.id);
    this.host.requestUpdate();
  }

  beginRect(x: number, y: number): void {
    this.rect = { x0: x, y0: y, x1: x, y1: y };
    this.host.requestUpdate();
  }

  moveRect(x: number, y: number): void {
    if (!this.rect) return;
    this.rect.x1 = x;
    this.rect.y1 = y;
    // Live preview of what falls inside the rect.
    const hit = agentsInRect(readAgents(), this.rect.x0, this.rect.y0, x, y);
    this.selected = new Set(hit.map((a) => a.id));
    this.host.requestUpdate();
  }

  endRect(): void {
    this.rect = null;
    this.host.requestUpdate();
  }

  private selectedAgents(): FxAgent[] {
    return readAgents().filter((a) => this.selected.has(a.id));
  }

  private async groupRpc(method: string, verb: string): Promise<void> {
    const agents = this.selectedAgents();
    if (!agents.length) return;
    this.host.toast(`${verb} ${agents.length} agents…`);
    const results = await Promise.all(
      agents.map((a) =>
        method === "subagents.respawn"
          ? callRpc(method, { runId: agentRpcTarget(a).runId })
          : callRpc(method, agentRpcTarget(a)),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    this.host.toast(`${verb}: ${ok}/${agents.length} ok`, ok === agents.length ? "ok" : "err");
  }

  private groupStop = () => void this.groupRpc("sessions.pause", "Stopping");
  private groupRespawn = () => void this.groupRpc("subagents.respawn", "Respawning");

  private groupSend = (): void => {
    const agents = this.selectedAgents();
    if (!agents.length) return;
    this.host.openPrompt({
      title: `Broadcast to ${agents.length} agents`,
      placeholder: "Message to send to every selected agent…",
      confirmLabel: "Broadcast",
      onSubmit: (message) => {
        if (!message.trim()) return;
        this.host.toast(`Broadcasting to ${agents.length}…`);
        void Promise.all(
          agents.map((a) => callRpc("sessions.send", { ...agentRpcTarget(a), message })),
        ).then((rs) => {
          const ok = rs.filter((r) => r.ok).length;
          this.host.toast(`Broadcast: ${ok}/${agents.length} ok`, ok === agents.length ? "ok" : "err");
        });
      },
    });
  };

  private tagCrew = (): void => {
    const agents = this.selectedAgents();
    if (!agents.length) return;
    window.dispatchEvent(
      new CustomEvent("world-interaction:tag-crew", {
        detail: { agents: agents.map((a) => agentRpcTarget(a)) },
      }),
    );
    this.host.toast(`Tagged ${agents.length} as crew`, "ok");
  };

  /** Tint, live selection rect, selection halos, and the group action bar. */
  render(): TemplateResult | string {
    if (!this._active) return "";
    const r = this.rect;
    const sel = this.selectedAgents();
    const count = this.selected.size;
    return html`
      <div class="wi-director-tint" aria-hidden="true"></div>
      <svg class="wi-svg" aria-hidden="true">
        ${sel.map(
          (a) => svg`<circle class="wi-sel-halo" cx=${a.x} cy=${a.y} r="16"></circle>`,
        )}
        ${r
          ? svg`<rect
              class="wi-sel-rect"
              x=${Math.min(r.x0, r.x1)}
              y=${Math.min(r.y0, r.y1)}
              width=${Math.abs(r.x1 - r.x0)}
              height=${Math.abs(r.y1 - r.y0)}
            ></rect>`
          : ""}
      </svg>
      <div class="wi-director-bar" role="toolbar" aria-label="Director group actions">
        <span class="wi-director-title">DIRECTOR</span>
        <span class="wi-director-count">${count} selected</span>
        <button class="wi-bar-btn danger" ?disabled=${count === 0} @click=${this.groupStop}>
          Group Stop
        </button>
        <button class="wi-bar-btn" ?disabled=${count === 0} @click=${this.groupRespawn}>
          Group Respawn
        </button>
        <button class="wi-bar-btn" ?disabled=${count === 0} @click=${this.groupSend}>
          Group Send
        </button>
        <button class="wi-bar-btn" ?disabled=${count === 0} @click=${this.tagCrew}>
          Tag as Crew
        </button>
        <button class="wi-bar-btn ghost" @click=${() => this.exit()} title="Exit (Esc)">
          Exit
        </button>
      </div>
    `;
  }
}
