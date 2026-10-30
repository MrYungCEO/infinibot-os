/**
 * <agent-employee-selector> — dropdown for choosing which configured
 * AI employee / named agent drives the voice conversation.
 *
 * Sibling to <agent-cli-selector> (which picks the *backend*) and
 * <voice-session-selector> (which picks a *running session*). This one picks
 * *which named AI employee* — i.e. an entry from `config.agents.list[]`, surfaced
 * over the gateway RPC `agents.list`. Each agent carries an id and an optional
 * display name / identity (name + emoji); the default agent is marked.
 *
 * Loads the list lazily from the gateway — opens immediately with whatever it
 * has, then refreshes when the dropdown is opened (or when the host calls
 * refresh()). Falls back gracefully to just the default agent when the list is
 * empty or the RPC is unavailable.
 *
 * Selection persists per surface via
 * `infinibot.voice.employee-selector.<surfaceId>` in localStorage.
 *
 * Emits a `change` CustomEvent with `detail: { agentId }` when the user picks.
 */

import { sanitizeIdentityEmoji } from "../../../../src/shared/identity-emoji.js";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { computePopupPosition, containingBlockOffset } from "../lib/popup-position.js";

export interface AgentEmployee {
  id: string;
  /** Display name (config `agents.list[].name` or identity.name), if any. */
  name?: string;
  emoji?: string;
}

interface AgentsListResult {
  defaultId?: string;
  mainKey?: string;
  agents?: Array<{
    id: string;
    name?: string;
    identity?: { name?: string; emoji?: string };
  }>;
}

interface MinimalClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
}

function storageKey(surfaceId: string): string {
  return `infinibot.voice.employee-selector.${surfaceId}`;
}

export function readEmployeeSelection(surfaceId: string): string | null {
  try {
    const raw = localStorage.getItem(storageKey(surfaceId));
    if (raw && typeof raw === "string") return raw;
  } catch {
    /* noop */
  }
  return null;
}

function writeEmployeeSelection(surfaceId: string, agentId: string): void {
  try {
    localStorage.setItem(storageKey(surfaceId), agentId);
  } catch {
    /* noop */
  }
}

@customElement("agent-employee-selector")
export class AgentEmployeeSelector extends LitElement {
  /** Identifier so each surface remembers its own selection. */
  @property({ type: String }) surfaceId = "default";

  /** Gateway client used to fetch the live agents list. */
  @property({ attribute: false }) client: MinimalClient | null = null;

  /** Currently-selected agent id. Falls back to persisted / default. */
  @property({ type: String }) value: string | null = null;

  @state() private _agents: AgentEmployee[] = [];
  @state() private _defaultId: string | null = null;
  @state() private _open = false;
  @state() private _loading = false;
  private _menuPos = { top: 0, left: 0, maxHeight: 280 };

  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      font: inherit;
      color: var(--g-fg, #e6e8ed);
    }

    .trigger {
      appearance: none;
      cursor: pointer;
      font: inherit;
      color: inherit;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #bfc4cb) 24%, transparent);
      background: color-mix(in srgb, var(--g-bg, #0a0b13) 70%, transparent);
      backdrop-filter: blur(14px) saturate(150%);
      -webkit-backdrop-filter: blur(14px) saturate(150%);
      transition: border-color 160ms ease, background 160ms ease;
    }
    .trigger:hover {
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 52%, transparent);
    }
    .trigger[aria-expanded="true"] {
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 80%, transparent);
    }
    .trigger .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
      letter-spacing: 0.03em;
    }
    .trigger .caret {
      font-size: 10px;
      opacity: 0.7;
    }

    .menu {
      position: fixed;
      min-width: 240px;
      max-width: 360px;
      padding: 6px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #bfc4cb) 28%, transparent);
      background: var(--g-bg, #0a0b13);
      background: color-mix(in srgb, var(--g-bg, #0a0b13) 98%, #000);
      backdrop-filter: blur(22px) saturate(170%);
      -webkit-backdrop-filter: blur(22px) saturate(170%);
      box-shadow: 0 22px 40px -16px rgba(0, 0, 0, 0.65);
      overflow-y: auto;
      overscroll-behavior: contain;
      z-index: 9700;
    }

    .group-label {
      padding: 6px 8px 4px;
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.5);
    }

    button.opt {
      appearance: none;
      cursor: pointer;
      width: 100%;
      text-align: left;
      font: inherit;
      color: inherit;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 2px 10px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      transition: background 140ms ease, border-color 140ms ease;
    }
    button.opt:hover {
      background: color-mix(in srgb, var(--g-primary, #bfc4cb) 8%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 18%, transparent);
    }
    button.opt[aria-selected="true"] {
      background: color-mix(in srgb, var(--g-primary, #bfc4cb) 14%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 38%, transparent);
    }
    .opt-name {
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .opt-meta {
      font-size: 10.5px;
      letter-spacing: 0.04em;
      opacity: 0.7;
    }
    .empty,
    .loading {
      padding: 8px 10px;
      font-size: 11px;
      opacity: 0.6;
      letter-spacing: 0.04em;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.value) {
      this.value = readEmployeeSelection(this.surfaceId);
    }
    document.addEventListener("click", this._onDocClick, true);
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick, true);
  }

  /** Called by hosts that want to force a refresh. */
  public async refresh(): Promise<void> {
    if (!this.client) return;
    this._loading = true;
    try {
      const res = (await this.client.request("agents.list", {})) as AgentsListResult | undefined;
      if (res && Array.isArray(res.agents)) {
        this._agents = res.agents.map((a) => ({
          id: a.id,
          name: (a.name?.trim() || a.identity?.name?.trim()) || undefined,
          emoji: sanitizeIdentityEmoji(a.identity?.emoji),
        }));
        this._defaultId = res.defaultId ?? null;
        // Adopt the default when nothing is persisted so the active label is
        // meaningful on first render.
        if (!this.value) this.value = this._defaultId;
      }
    } catch {
      /* keep whatever we have */
    } finally {
      this._loading = false;
    }
  }

  private _onDocClick = (e: MouseEvent) => {
    if (!this._open) return;
    if (e.composedPath().includes(this)) return;
    this._open = false;
  };

  private _toggle = async () => {
    this._open = !this._open;
    if (this._open) {
      const trigger = this.shadowRoot?.querySelector(".trigger") as HTMLElement | null;
      if (trigger) {
        const estHeight = 56 + Math.max(1, this._agents.length) * 44;
        const pos = computePopupPosition(trigger.getBoundingClientRect(), {
          width: 260,
          height: estHeight,
        });
        const off = containingBlockOffset(this);
        this._menuPos = { top: pos.top - off.dy, left: pos.left - off.dx, maxHeight: pos.maxHeight };
      }
      await this.refresh();
      await this.updateComplete;
      this._reposition();
    }
  };

  private _reposition() {
    if (!this._open) return;
    const trigger = this.shadowRoot?.querySelector(".trigger") as HTMLElement | null;
    const menu = this.shadowRoot?.querySelector(".menu") as HTMLElement | null;
    if (!trigger) return;
    const pos = computePopupPosition(trigger.getBoundingClientRect(), {
      width: 260,
      height: menu?.scrollHeight ?? 280,
    });
    const off = containingBlockOffset(this);
    this._menuPos = { top: pos.top - off.dy, left: pos.left - off.dx, maxHeight: pos.maxHeight };
  }

  private _pick(agentId: string) {
    this.value = agentId;
    writeEmployeeSelection(this.surfaceId, agentId);
    this._open = false;
    this.dispatchEvent(
      new CustomEvent("change", { detail: { agentId }, bubbles: true, composed: true }),
    );
  }

  private _label(a: AgentEmployee): string {
    const base = a.name || a.id;
    return a.emoji ? `${a.emoji} ${base}` : base;
  }

  private _activeLabel(): string {
    const active = this._agents.find((a) => a.id === this.value);
    if (active) return this._label(active);
    if (this.value) return this.value;
    if (this._agents.length === 0) return "Default agent";
    return "Pick an agent";
  }

  render() {
    return html`
      <button
        class="trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded=${this._open ? "true" : "false"}
        @click=${this._toggle}
        title="Choose which AI employee / agent drives this voice conversation"
      >
        <span class="label">${this._activeLabel()}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      ${this._open
        ? html`
            <div
              class="menu"
              role="listbox"
              aria-label="AI employees"
              style="top:${this._menuPos.top}px;left:${this._menuPos.left}px;max-height:${this._menuPos.maxHeight}px;"
            >
              <div class="group-label">AI employees</div>
              ${this._loading && this._agents.length === 0
                ? html`<div class="loading">Loading agents…</div>`
                : this._agents.length === 0
                  ? html`<div class="empty">No configured agents</div>`
                  : this._agents.map((a) => {
                      const selected = a.id === this.value;
                      const isDefault = a.id === this._defaultId;
                      return html`
                        <button
                          class="opt"
                          role="option"
                          aria-selected=${selected ? "true" : "false"}
                          @click=${() => this._pick(a.id)}
                        >
                          <span class="opt-name">${this._label(a)}</span>
                          <span class="opt-meta">${isDefault ? "default" : a.id}</span>
                        </button>
                      `;
                    })}
            </div>
          `
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-employee-selector": AgentEmployeeSelector;
  }
}
