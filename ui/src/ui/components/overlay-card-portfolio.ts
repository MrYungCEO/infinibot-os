/**
 * overlay-card-portfolio.ts — portfolio grid overlay.
 *
 * A wide gold-glass card showing a filterable grid of project "tiles" hydrated
 * from `kanban.projects.list` (each enriched with `kanban.tasks.list` counts on
 * demand). Tiles show a cover thumbnail, status badge, and progress; hovering a
 * tile lifts it and reveals a quick-stats overlay; clicking one spawns a
 * `project` overlay card (via `ui.overlay.spawn`) so the detail modal opens.
 *
 * Filters: status, project type, and assigned agent/instance — driven off the
 * live data so only present values render as chips.
 *
 * Payload (all optional): `{ status?, type?, agent?, title? }` to pre-seed the
 * active filters, e.g. `ui.modals.openPortfolio { data: { status: "In progress" } }`.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";

type ProjectRow = {
  id: string;
  name?: string;
  status?: string;
  priority?: string;
  type?: string[];
  progress?: number;
  taskCount?: number;
  coverUrl?: string;
  assignedInstances?: string[];
  parentProjectId?: string | null;
};

// Status → accent colour. Falls back to a neutral grey for unknown values so a
// new Notion status never renders an empty swatch.
const STATUS_TONE: Record<string, string> = {
  "not started": "#71717a",
  "in progress": "var(--g-primary, #fbbf24)",
  updating: "#38bdf8",
  reviewing: "#a855f7",
  "awaiting client": "#f59e0b",
  paused: "#94a3b8",
  completed: "#34d399",
  cancelled: "#f87171",
};

function toneFor(status?: string): string {
  return STATUS_TONE[(status ?? "").toLowerCase()] ?? "#71717a";
}

@customElement("overlay-card-portfolio")
export class OverlayCardPortfolio extends OverlayCardBase {
  @state() private projects: ProjectRow[] = [];
  @state() private loading = true;
  @state() private err: string | null = null;
  @state() private fStatus = "";
  @state() private fType = "";
  @state() private fAgent = "";

  protected accent = "#fbbf24";

  protected get cardIcon() {
    return "▦";
  }
  protected get cardTitle() {
    return (this.payload.title as string) || "Portfolio";
  }
  protected headerMeta() {
    return `${this.filtered.length}/${this.projects.length}`;
  }

  override firstUpdated() {
    super.firstUpdated();
    this.fStatus = (this.payload.status as string) || "";
    this.fType = (this.payload.type as string) || "";
    this.fAgent = (this.payload.agent as string) || "";
    void this.hydrate();
  }

  private async hydrate() {
    if (!this.gateway) {
      this.loading = false;
      return;
    }
    try {
      const res = (await this.gateway.request("kanban.projects.list", {})) as
        | { projects?: ProjectRow[] }
        | ProjectRow[]
        | null;
      const list = Array.isArray(res) ? res : res?.projects ?? [];
      // Hide sub-projects at the top level so the grid reads as a portfolio of
      // top-line initiatives, not every leaf.
      this.projects = list.filter((p) => !p.parentProjectId);
      this.err = null;
    } catch (e) {
      this.err = String((e as Error)?.message ?? e);
    } finally {
      this.loading = false;
    }
  }

  // ── filter option sets (derived from live data) ─────────────────────────
  private get statuses(): string[] {
    return [...new Set(this.projects.map((p) => p.status).filter(Boolean) as string[])];
  }
  private get types(): string[] {
    const s = new Set<string>();
    for (const p of this.projects) for (const t of p.type ?? []) if (t) s.add(t);
    return [...s];
  }
  private get agents(): string[] {
    const s = new Set<string>();
    for (const p of this.projects) for (const a of p.assignedInstances ?? []) if (a) s.add(a);
    return [...s];
  }

  private get filtered(): ProjectRow[] {
    return this.projects.filter((p) => {
      if (this.fStatus && p.status !== this.fStatus) return false;
      if (this.fType && !(p.type ?? []).includes(this.fType)) return false;
      if (this.fAgent && !(p.assignedInstances ?? []).includes(this.fAgent)) return false;
      return true;
    });
  }

  /** Open the full project detail modal for a tile. */
  private openProject(p: ProjectRow) {
    const payload = { id: p.id, name: p.name, status: p.status };
    if (this.gateway) {
      void this.gateway
        .request("ui.overlay.spawn", { type: "project", payload })
        .catch(() => this.devSpawn(payload));
    } else {
      this.devSpawn(payload);
    }
  }

  private devSpawn(payload: Record<string, unknown>) {
    window.dispatchEvent(
      new CustomEvent("overlay.spawn", { detail: { type: "project", payload } }),
    );
  }

  private progressOf(p: ProjectRow): number {
    if (typeof p.progress === "number" && Number.isFinite(p.progress)) {
      return Math.max(0, Math.min(100, p.progress <= 1 ? p.progress * 100 : p.progress));
    }
    return p.status?.toLowerCase() === "completed" ? 100 : 0;
  }

  private renderChips(
    label: string,
    options: string[],
    value: string,
    set: (v: string) => void,
  ) {
    if (!options.length) return nothing;
    return html`
      <div class="filter">
        <span class="flabel">${label}</span>
        <button class=${`chip ${value === "" ? "on" : ""}`} @click=${() => set("")}>All</button>
        ${options.map(
          (o) => html`<button
            class=${`chip ${value === o ? "on" : ""}`}
            @click=${() => set(value === o ? "" : o)}
            title=${o}
          >
            ${o}
          </button>`,
        )}
      </div>
    `;
  }

  protected renderBody() {
    if (this.loading) return html`<div class="muted">Loading portfolio…</div>`;
    if (this.err) return html`<div class="err">${this.err}</div>`;
    if (!this.projects.length) return html`<div class="muted">No projects yet.</div>`;

    const items = this.filtered;
    return html`
      <div class="filters">
        ${this.renderChips("Status", this.statuses, this.fStatus, (v) => (this.fStatus = v))}
        ${this.renderChips("Type", this.types, this.fType, (v) => (this.fType = v))}
        ${this.renderChips("Agent", this.agents, this.fAgent, (v) => (this.fAgent = v))}
      </div>
      ${items.length
        ? html`<div class="grid">
            ${items.map((p) => {
              const tone = toneFor(p.status);
              const pct = this.progressOf(p);
              return html`
                <button class="tile" @click=${() => this.openProject(p)} title=${p.name ?? ""}>
                  <div class="thumb">
                    ${p.coverUrl
                      ? html`<img src=${p.coverUrl} alt="" loading="lazy" />`
                      : html`<span class="ph">${(p.name ?? "?").slice(0, 1)}</span>`}
                    <span class="badge" style=${`--tone:${tone}`}>${p.status ?? "—"}</span>
                    <div class="hoverStats">
                      <span>${p.taskCount ?? 0} tasks</span>
                      <span>${pct}% done</span>
                      ${p.priority ? html`<span>${p.priority}</span>` : nothing}
                    </div>
                  </div>
                  <div class="tname">${p.name ?? "(untitled)"}</div>
                  <div class="bar"><i style=${`width:${pct}%;background:${tone}`}></i></div>
                </button>
              `;
            })}
          </div>`
        : html`<div class="muted">No projects match these filters.</div>`}
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      :host {
        width: 640px;
      }
      .muted {
        font-size: 12px;
        color: var(--g-fg-faint, #71717a);
        padding: 8px 2px;
      }
      .err {
        font-size: 11px;
        color: #ef4444;
        word-break: break-word;
      }
      .filters {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
      }
      .filter {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
      }
      .flabel {
        font-size: 9px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
        width: 46px;
        flex: 0 0 auto;
      }
      .chip {
        font-size: 10px;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.16));
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.04));
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
        cursor: pointer;
        font-family: inherit;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          color 120ms ease;
      }
      .chip:hover {
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.3));
      }
      .chip.on {
        background: var(--g-primary-soft, rgba(251, 191, 36, 0.14));
        border-color: var(--g-primary, #fbbf24);
        color: var(--g-primary, #fbbf24);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 10px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 0;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        border-radius: 12px;
        background: var(--g-surface, rgba(255, 255, 255, 0.03));
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        overflow: hidden;
        transition:
          transform 140ms ease,
          border-color 140ms ease,
          box-shadow 140ms ease;
      }
      .tile:hover {
        transform: translateY(-3px);
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.35));
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
      }
      .thumb {
        position: relative;
        aspect-ratio: 16 / 9;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
        display: grid;
        place-items: center;
        overflow: hidden;
      }
      .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb .ph {
        font-size: 28px;
        font-weight: 800;
        color: var(--g-primary, #fbbf24);
        opacity: 0.55;
      }
      .badge {
        position: absolute;
        top: 6px;
        left: 6px;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 2px 7px;
        border-radius: 999px;
        color: var(--tone, #fbbf24);
        background: color-mix(in srgb, var(--tone, #fbbf24) 16%, rgba(0, 0, 0, 0.5));
        border: 1px solid color-mix(in srgb, var(--tone, #fbbf24) 45%, transparent);
        max-width: 88%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hoverStats {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        background: rgba(9, 9, 11, 0.72);
        opacity: 0;
        transition: opacity 140ms ease;
        font-size: 10px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--g-fg, #f4f4f5);
      }
      .tile:hover .hoverStats {
        opacity: 1;
      }
      .tname {
        font-size: 11px;
        font-weight: 600;
        color: var(--g-fg, #f4f4f5);
        padding: 0 8px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .bar {
        height: 4px;
        margin: 0 8px 8px;
        border-radius: 4px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
        overflow: hidden;
      }
      .bar > i {
        display: block;
        height: 100%;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-portfolio": OverlayCardPortfolio;
  }
}
