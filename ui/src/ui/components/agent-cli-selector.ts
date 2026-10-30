/**
 * <agent-cli-selector> — universal dropdown for every voice surface.
 *
 * One control, used everywhere voice is exposed. Lets the user point a voice
 * surface at:
 *   - the in-process gateway agent (default), OR
 *   - any installed CoderBackend (Claude Code, OpenCode, Codex CLI).
 *
 * Uninstalled backends render as disabled options with the backend's
 * `installHint` shown inline. Selection persists per surface via
 * `infinibot.voice.cli-selector.<surfaceId>` in localStorage.
 *
 * Loads the list from the gateway lazily — opens immediately with cached
 * defaults, then refreshes when the dropdown is opened (or whenever the
 * host calls refresh()).
 *
 * Emits a `change` CustomEvent with `detail: { kind, id }`:
 *   { kind: "gateway", id: "gateway" }
 *   { kind: "cli",     id: "claude-code" | "opencode" | "codex" }
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./provider-logo.js";
import {
  ALL_BACKEND_IDS,
  BACKEND_DISPLAY,
  type CoderBackendId,
} from "../lib/coder-backend-id.js";
import { computePopupPosition, containingBlockOffset } from "../lib/popup-position.js";

export type SelectorKind = "gateway" | "cli";
export interface SelectorValue {
  kind: SelectorKind;
  /** "gateway" when kind=gateway, CoderBackendId when kind=cli. */
  id: string;
}

interface BackendEntry {
  id: CoderBackendId;
  displayName: string;
  installed: boolean;
  version?: string;
  installHint?: string;
}

interface BackendsListResult {
  backends: Array<{
    id: CoderBackendId;
    displayName: string;
    capabilities?: { displayName?: string };
    install?: { installed: boolean; version?: string; installHint?: string };
  }>;
}

interface MinimalClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
}

function storageKey(surfaceId: string): string {
  return `infinibot.voice.cli-selector.${surfaceId}`;
}

export function readPersisted(surfaceId: string): SelectorValue | null {
  try {
    const raw = localStorage.getItem(storageKey(surfaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SelectorValue>;
    if (parsed && (parsed.kind === "gateway" || parsed.kind === "cli") && typeof parsed.id === "string") {
      return { kind: parsed.kind, id: parsed.id };
    }
  } catch { /* noop */ }
  return null;
}

const DEFAULT_SURFACE = "default";

/** "grok 0.1.42" / "2.1.195 (Claude Code)" → the x.y.z part. */
function shortVersion(raw: string): string {
  return raw.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? raw;
}

export function readSelectorValue(surfaceId: string): SelectorValue {
  return readPersisted(surfaceId) ?? readPersisted(DEFAULT_SURFACE) ?? { kind: "gateway", id: "gateway" };
}

function writePersisted(surfaceId: string, value: SelectorValue): void {
  try {
    localStorage.setItem(storageKey(surfaceId), JSON.stringify(value));
  } catch { /* noop */ }
}

const DEFAULT_BACKENDS: BackendEntry[] = ALL_BACKEND_IDS.map((id) => ({
  id,
  displayName: BACKEND_DISPLAY[id],
  installed: false,
}));

@customElement("agent-cli-selector")
export class AgentCliSelector extends LitElement {
  /** Identifier so each surface remembers its own selection. */
  @property({ type: String }) surfaceId = "default";

  /** Gateway client used to fetch the live backend list. */
  @property({ attribute: false }) client: MinimalClient | null = null;

  /**
   * Optional starting value. If omitted, the persisted value is used,
   * falling back to gateway-agent.
   */
  @property({ attribute: false }) value: SelectorValue | null = null;

  /** Set true to render a compact one-line variant (for tight panels). */
  @property({ type: Boolean }) compact = false;

  @state() private _backends: BackendEntry[] = DEFAULT_BACKENDS;
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
      font-size: 12.5px;
      letter-spacing: 0.04em;
    }
    .trigger .caret {
      font-size: 10px;
      opacity: 0.7;
    }
    :host([compact]) .trigger { padding: 4px 8px; }

    .menu {
      position: fixed;
      min-width: 260px;
      max-width: 360px;
      padding: 6px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #bfc4cb) 28%, transparent);
      /* Solid base so the menu never reads as see-through over the busy HUD,
         with the glass blur layered on top where supported. */
      background: var(--g-bg, #0a0b13);
      background: color-mix(in srgb, var(--g-bg, #0a0b13) 98%, #000);
      backdrop-filter: blur(22px) saturate(170%);
      -webkit-backdrop-filter: blur(22px) saturate(170%);
      box-shadow: 0 22px 40px -16px rgba(0, 0, 0, 0.65);
      overflow-y: auto;
      overscroll-behavior: contain;
      z-index: 9700; /* above the floating-controls host (9600) */
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
      gap: 4px 10px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      transition: background 140ms ease, border-color 140ms ease;
    }
    button.opt:hover:not(:disabled) {
      background: color-mix(in srgb, var(--g-primary, #bfc4cb) 8%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 18%, transparent);
    }
    button.opt[aria-selected="true"] {
      background: color-mix(in srgb, var(--g-primary, #bfc4cb) 14%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #bfc4cb) 38%, transparent);
    }
    button.opt:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .opt-name { font-size: 13px; display: inline-flex; align-items: center; gap: 8px; }
    .opt-meta { font-size: 10.5px; letter-spacing: 0.04em; opacity: 0.7; }
    .opt-hint {
      grid-column: 1 / -1;
      font-size: 10.5px;
      opacity: 0.7;
      padding-top: 2px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .loading {
      padding: 6px 10px;
      font-size: 10.5px;
      opacity: 0.6;
      letter-spacing: 0.06em;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.value) {
      this.value = readSelectorValue(this.surfaceId);
    }
    document.addEventListener("click", this._onDocClick, true);
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this._onDocClick, true);
  }

  /** Called by hosts that want to force a refresh (e.g. after install). */
  public async refresh(): Promise<void> {
    if (!this.client) return;
    this._loading = true;
    try {
      const res = (await this.client.request("coder.backends.list", {})) as
        | BackendsListResult
        | undefined;
      if (res && Array.isArray(res.backends)) {
        this._backends = res.backends.map((b) => ({
          id: b.id,
          displayName: b.displayName ?? b.capabilities?.displayName ?? BACKEND_DISPLAY[b.id] ?? b.id,
          installed: !!b.install?.installed,
          version: b.install?.version,
          installHint: b.install?.installHint,
        }));
      }
    } catch {
      // Fall back to HTTP route if the RPC isn't registered yet.
      try {
        const r = await fetch("/api/coder/backends");
        if (r.ok) {
          const json = (await r.json()) as BackendsListResult;
          if (json && Array.isArray(json.backends)) {
            this._backends = json.backends.map((b) => ({
              id: b.id,
              displayName: b.displayName ?? BACKEND_DISPLAY[b.id] ?? b.id,
              installed: !!b.install?.installed,
              version: b.install?.version,
              installHint: b.install?.installHint,
            }));
          }
        }
      } catch { /* keep defaults */ }
    } finally {
      this._loading = false;
    }
  }

  private _onDocClick = (e: MouseEvent) => {
    if (!this._open) return;
    const path = e.composedPath();
    if (path.includes(this)) return;
    this._open = false;
  };

  private _toggle = async () => {
    this._open = !this._open;
    if (this._open) {
      const trigger = this.shadowRoot?.querySelector(".trigger") as HTMLElement | null;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        // Estimate height from option count (gateway + each backend ~ 40px,
        // plus group headers/padding). Refined after the menu actually renders.
        const estHeight = 96 + this._backends.length * 42;
        const pos = computePopupPosition(rect, { width: 260, height: estHeight });
        const off = containingBlockOffset(this);
        this._menuPos = { top: pos.top - off.dy, left: pos.left - off.dx, maxHeight: pos.maxHeight };
      }
      await this.refresh();
      // Re-measure once the menu is in the DOM so a tall list flips correctly.
      await this.updateComplete;
      this._reposition();
    }
  };

  /** Re-measure the rendered menu and flip up/down to keep it on-screen. */
  private _reposition() {
    if (!this._open) return;
    const trigger = this.shadowRoot?.querySelector(".trigger") as HTMLElement | null;
    const menu = this.shadowRoot?.querySelector(".menu") as HTMLElement | null;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const measured = menu?.scrollHeight ?? 280;
    const pos = computePopupPosition(rect, { width: 260, height: measured });
    const off = containingBlockOffset(this);
    this._menuPos = { top: pos.top - off.dy, left: pos.left - off.dx, maxHeight: pos.maxHeight };
    // _menuPos is a plain field: without this the menu kept the first rough
    // estimate and clipped the last backend (5 CLIs + install hints > estimate).
    this.requestUpdate();
  }

  private _pick(next: SelectorValue) {
    this.value = next;
    writePersisted(this.surfaceId, next);
    this._open = false;
    this.dispatchEvent(
      new CustomEvent<SelectorValue>("change", { detail: next, bubbles: true, composed: true }),
    );
  }

  private _activeLabel(): string {
    const v = this.value ?? { kind: "gateway", id: "gateway" };
    if (v.kind === "gateway") return "Gateway agent";
    const b = this._backends.find((x) => x.id === v.id);
    if (b) return b.displayName;
    return BACKEND_DISPLAY[v.id as CoderBackendId] ?? v.id;
  }

  render() {
    const v = this.value ?? { kind: "gateway", id: "gateway" };
    return html`
      <button
        class="trigger"
        type="button"
        aria-expanded=${this._open ? "true" : "false"}
        @click=${this._toggle}
        title="Choose which agent handles voice input on this surface"
      >
        <span class="label">${this._activeLabel()}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      ${this._open
        ? html`
            <div class="menu" role="listbox" style="top:${this._menuPos.top}px;left:${this._menuPos.left}px;max-height:${this._menuPos.maxHeight}px;">
              <div class="group-label">Gateway agent</div>
              <button
                class="opt"
                role="option"
                aria-selected=${v.kind === "gateway" ? "true" : "false"}
                @click=${() => this._pick({ kind: "gateway", id: "gateway" })}
              >
                <span class="opt-name">In-process gateway agent</span>
                <span class="opt-meta">default</span>
              </button>

              <div class="group-label">CLI agents (live)</div>
              ${this._loading
                ? html`<div class="loading">Loading backends…</div>`
                : this._backends.map((b) => {
                    const selected = v.kind === "cli" && v.id === b.id;
                    return html`
                      <button
                        class="opt"
                        role="option"
                        aria-selected=${selected ? "true" : "false"}
                        ?disabled=${!b.installed}
                        @click=${() =>
                          b.installed
                            ? this._pick({ kind: "cli", id: b.id })
                            : undefined}
                      >
                        <span class="opt-name"><ib-provider-logo provider=${b.id} label=${b.displayName} size="20"></ib-provider-logo>${b.displayName}</span>
                        <span class="opt-meta">
                          ${b.installed ? (b.version ? `v${shortVersion(b.version)}` : "ready") : "not installed"}
                        </span>
                        ${!b.installed && b.installHint
                          ? html`<span class="opt-hint">${b.installHint}</span>`
                          : null}
                      </button>
                    `;
                  })}
            </div>
          `
        : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-cli-selector": AgentCliSelector;
  }
}
