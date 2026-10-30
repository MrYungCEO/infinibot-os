/**
 * <chat-mode-switcher> — the chat composer's Agent | CLI switch.
 *
 * Desktop: a segmented pill next to Send. "Agent" talks to the InfiniBot
 * gateway agent; "CLI" talks to a coding CLI (Claude Code / Codex / OpenCode /
 * Gemini CLI). The caret on the active segment opens a panel with the agent
 * list, the CLIs (brand mark + status dot: ready / needs sign-in / not
 * installed), and in CLI mode the working folder and model.
 *
 * Narrow (`compact`): one icon button showing the current target; the same
 * panel opens as a bottom sheet.
 *
 * `openPalette()` (Ctrl/Cmd+K in the chat) opens the panel focused on the
 * first entry so the arrows + Enter, or a digit, switch target.
 *
 * Emits:
 *   route-change  { route: ChatRoute }
 *   agent-change  { agentId: string }
 */

import { LitElement, adoptStyles, css, html, nothing, render as litRender, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import {
  CLI_LABELS,
  CLI_MODEL_CHOICES,
  folderName,
  type ChatRoute,
  type CliBackendId,
  type CliBackendInfo,
} from "../chat/chat-route";
import { cliLogo } from "../chat/cli-logos";
import { icons } from "../icons";

export type SwitcherAgent = { id: string; name: string };
export type SwitcherFolder = { path: string; label?: string; kind: "repo" | "recent" | "home" };

const STATUS_TEXT: Record<CliBackendInfo["status"], string> = {
  ready: "Ready",
  login: "Needs sign-in",
  unavailable: "Not installed",
};

@customElement("chat-mode-switcher")
export class ChatModeSwitcher extends LitElement {
  @property({ attribute: false }) route: ChatRoute = { mode: "agent" };
  @property({ attribute: false }) agents: SwitcherAgent[] = [];
  @property({ type: String }) agentId = "main";
  @property({ attribute: false }) backends: CliBackendInfo[] = [];
  @property({ attribute: false }) folders: SwitcherFolder[] = [];
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) disabled = false;
  /** Agent picking is locked (e.g. an existing agent thread). */
  @property({ type: Boolean }) agentLocked = false;

  @state() private open = false;
  @state() private customFolder = "";
  @state() private editingFolder = false;
  @state() private allAgents = false;
  /** Popover opens upward (above the composer) unless there's clearly more room below. */
  @state() private dropDown = false;
  /**
   * The narrow-width bottom sheet renders into a host on <body>: the composer
   * has backdrop-filter, which would trap a position:fixed sheet inside it.
   */
  private sheetHost: HTMLElement | null = null;
  private onDocDown = (e: Event) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (!path.includes(this) && !(this.sheetHost && path.includes(this.sheetHost))) this.close();
  };

  /** Where the panel's options live (the sheet host's shadow root when portaled). */
  private panelRoot(): ParentNode {
    return this.sheetHost?.shadowRoot ?? this.renderRoot;
  }

  private syncSheet() {
    const want = this.compact && this.open;
    if (!want) {
      if (this.sheetHost) {
        litRender(nothing, this.sheetHost.shadowRoot!, { host: this });
        this.sheetHost.remove();
        this.sheetHost = null;
      }
      return;
    }
    if (!this.sheetHost) {
      const host = document.createElement("div");
      host.setAttribute("data-mode-switcher-sheet", "");
      host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:1000;";
      const root = host.attachShadow({ mode: "open" });
      adoptStyles(root, [ChatModeSwitcher.styles]);
      document.body.appendChild(host);
      this.sheetHost = host;
    }
    litRender(this.renderPanel(), this.sheetHost.shadowRoot!, { host: this });
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.onDocDown, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.onDocDown, true);
    this.open = false;
    this.syncSheet();
  }

  /** Open the panel with keyboard focus on the first target (Ctrl/Cmd+K). */
  openPalette(): void {
    this.fitPanel();
    this.open = true;
    void this.updateComplete.then(() => {
      const root = this.panelRoot();
      const first =
        root.querySelector<HTMLElement>(".ms-opt--on") ?? root.querySelector<HTMLElement>(".ms-opt:not([disabled])");
      first?.focus();
    });
  }

  /** Desktop popover height: whatever fits between the top bar and the trigger. */
  private fitPanel() {
    if (this.compact) return;
    const r = this.getBoundingClientRect();
    // Anchor to the composer box (not the pill) so the panel never covers the text box.
    const box = (this.closest(".wc-composer") as HTMLElement | null)?.getBoundingClientRect() ?? r;
    const above = box.top - 72;
    const below = window.innerHeight - box.bottom - 16;
    this.dropDown = above < 340 && below > above;
    this.style.setProperty("--ms-gap-up", `${Math.max(0, r.top - box.top) + 12}px`);
    this.style.setProperty("--ms-gap-down", `${Math.max(0, box.bottom - r.bottom) + 8}px`);
    const room = this.dropDown ? below : above;
    this.style.setProperty("--ms-max-h", `${Math.max(220, Math.min(620, room))}px`);
  }



  /** Current agent first, then the rest: 6 chips until "+N more" is tapped. */
  private agentList(): SwitcherAgent[] {
    if (this.agentLocked) return this.agents.filter((a) => a.id === this.agentId);
    const cur = this.agents.filter((a) => a.id === this.agentId);
    return [...cur, ...this.agents.filter((a) => a.id !== this.agentId)];
  }

  private visibleAgents(): SwitcherAgent[] {
    const all = this.agentList();
    return this.allAgents ? all : all.slice(0, 6);
  }

  private hiddenAgentCount(): number {
    return this.agentList().length - this.visibleAgents().length;
  }

  close(): void {
    this.open = false;
    this.editingFolder = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  protected updated(changed: PropertyValues): void {
    this.syncSheet();
    if (changed.has("open")) {
      this.dispatchEvent(new CustomEvent("switcher-toggle", { detail: { open: this.open }, bubbles: true, composed: true }));
    }
  }

  private emitRoute(route: ChatRoute) {
    this.dispatchEvent(new CustomEvent("route-change", { detail: { route }, bubbles: true, composed: true }));
  }

  private pickAgent(id: string) {
    if (this.route.mode !== "agent") this.emitRoute({ mode: "agent" });
    if (id !== this.agentId) {
      this.dispatchEvent(new CustomEvent("agent-change", { detail: { agentId: id }, bubbles: true, composed: true }));
    }
    this.close();
  }

  private pickBackend(b: CliBackendInfo) {
    if (b.status === "unavailable" || b.needsUpdate) return;
    const prev = this.route.mode === "cli" ? this.route : null;
    this.emitRoute({
      mode: "cli",
      backend: b.id,
      ...(prev?.cwd ? { cwd: prev.cwd } : {}),
      // A model name is backend-specific: keep it only on the same backend.
      ...(prev?.backend === b.id && prev.model ? { model: prev.model } : {}),
    });
    // Stay open on first pick so the folder is visible; close on re-pick.
    if (prev) this.close();
  }

  private setFolder(path: string) {
    if (this.route.mode !== "cli") return;
    const p = path.trim();
    this.emitRoute({ ...this.route, cwd: p || undefined });
    this.editingFolder = false;
    this.customFolder = "";
  }

  private setModel(model: string) {
    if (this.route.mode !== "cli") return;
    const m = model.trim();
    const next: ChatRoute = { mode: "cli", backend: this.route.backend, ...(this.route.cwd ? { cwd: this.route.cwd } : {}) };
    if (m) next.model = m;
    this.emitRoute(next);
  }

  private onSegment(mode: "agent" | "cli") {
    if (this.disabled) return;
    if (mode === "agent") {
      if (this.route.mode === "agent") {
        this.fitPanel();
        this.open = !this.open;
      }
      else this.emitRoute({ mode: "agent" });
      return;
    }
    if (this.route.mode === "cli") {
      this.fitPanel();
      this.open = !this.open;
      return;
    }
    // Switch to the last CLI if the host remembered one, else open the list.
    this.dispatchEvent(new CustomEvent("cli-requested", { bubbles: true, composed: true }));
  }

  private onPanelKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    const opts = [...this.panelRoot().querySelectorAll<HTMLElement>(".ms-opt:not([disabled])")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = opts.indexOf(target);
      const next = e.key === "ArrowDown" ? opts[(i + 1) % opts.length] : opts[(i - 1 + opts.length) % opts.length];
      next?.focus();
    } else if (/^[1-9]$/.test(e.key)) {
      const all = [...this.panelRoot().querySelectorAll<HTMLElement>(".ms-opt")];
      const hit = all[Number(e.key) - 1];
      if (hit && !hit.hasAttribute("disabled")) {
        e.preventDefault();
        hit.click();
      }
    }
  }

  // ── render ──

  private renderTrigger() {
    const r = this.route;
    const agentName = this.agents.find((a) => a.id === this.agentId)?.name ?? this.agentId;
    if (this.compact) {
      return html`<button
        class="ms-icon ${r.mode === "cli" ? "ms-icon--cli" : ""}"
        title=${r.mode === "cli" ? `Chatting with ${CLI_LABELS[r.backend]} · tap to switch` : `Chatting with ${agentName} · tap to switch`}
        aria-label="Switch between agent and CLI"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? "true" : "false"}
        ?disabled=${this.disabled}
        data-mode-switcher-trigger
        @click=${() => (this.open = !this.open)}
      >
        ${r.mode === "cli" ? cliLogo(r.backend, 16) : icons.bot}
        <span class="ms-icon-dot ${r.mode === "cli" ? "ms-icon-dot--cli" : ""}"></span>
      </button>`;
    }
    return html`<div class="ms-seg" role="group" aria-label="Chat target" data-mode-switcher-trigger>
      <button
        class="ms-seg-btn ${r.mode === "agent" ? "ms-seg-btn--on" : ""}"
        aria-pressed=${r.mode === "agent" ? "true" : "false"}
        title=${r.mode === "agent" ? "InfiniBot agent · click for agents" : "Switch to the InfiniBot agent"}
        ?disabled=${this.disabled}
        @click=${() => this.onSegment("agent")}
      >
        <span class="ms-seg-ico">${icons.bot}</span>
        <span class="ms-seg-lbl">${r.mode === "agent" ? agentName : "Agent"}</span>
        ${r.mode === "agent" ? html`<span class="ms-caret">${icons.chevronDown}</span>` : nothing}
      </button>
      <button
        class="ms-seg-btn ${r.mode === "cli" ? "ms-seg-btn--on ms-seg-btn--cli" : ""}"
        aria-pressed=${r.mode === "cli" ? "true" : "false"}
        title=${r.mode === "cli" ? `${CLI_LABELS[r.backend]} in ${r.cwd ?? "home"} · click to change` : "Chat with a coding CLI (Ctrl+K)"}
        ?disabled=${this.disabled}
        data-mode-cli
        @click=${() => this.onSegment("cli")}
      >
        <span class="ms-seg-ico">${r.mode === "cli" ? cliLogo(r.backend, 14) : icons.terminal}</span>
        <span class="ms-seg-lbl">${r.mode === "cli" ? CLI_LABELS[r.backend] : "CLI"}</span>
        ${r.mode === "cli" ? html`<span class="ms-caret">${icons.chevronDown}</span>` : nothing}
      </button>
    </div>`;
  }

  private renderPanel() {
    const r = this.route;
    let n = 0;
    // Every option takes the next digit (the palette's 1–9 keys), shown only where it can be used.
    const num = (show: boolean) => {
      n += 1;
      return show && n <= 9 ? html`<kbd class="ms-num">${n}</kbd>` : nothing;
    };
    return html`
      ${this.compact ? html`<div class="ms-backdrop" @click=${() => this.close()}></div>` : nothing}
      <div
        class="ms-panel ${this.compact ? "ms-panel--sheet" : ""} ${this.dropDown && !this.compact ? "ms-panel--down" : ""}"
        role="dialog"
        aria-label="Choose who this chat talks to"
        data-mode-switcher-panel
        @keydown=${(e: KeyboardEvent) => this.onPanelKey(e)}
      >
        ${this.compact ? html`<div class="ms-grab" aria-hidden="true"></div>` : nothing}
        <div class="ms-cols">
        <div class="ms-col">
        <div class="ms-sec-h">Coding CLI <span class="ms-sec-note">runs on this machine</span></div>
        <div class="ms-list">
          ${this.backends.map((b) => {
            const on = r.mode === "cli" && r.backend === b.id;
            const blocked = b.status === "unavailable" || Boolean(b.needsUpdate);
            const tone = b.needsUpdate ? "update" : b.status;
            const statusText = b.needsUpdate ? "After gateway update" : STATUS_TEXT[b.status];
            return html`<button
              class="ms-opt ${on ? "ms-opt--on" : ""}"
              data-route="cli:${b.id}"
              ?disabled=${blocked}
              title=${b.needsUpdate
                ? `${b.label} chat needs the gateway update (restart) to run`
                : b.status === "login"
                  ? `${b.label} is installed but not signed in — sign in from Setup › Coders`
                  : b.status === "unavailable"
                    ? `${b.label} is not installed on this machine`
                    : `${b.label}${b.version ? ` ${b.version}` : ""}`}
              @click=${() => this.pickBackend(b)}
            >
              <span class="ms-opt-ico ms-opt-ico--brand">${cliLogo(b.id, 16)}</span>
              <span class="ms-opt-main">
                <span class="ms-opt-name">${on ? b.label : `Switch to ${b.label}`}</span>
                <span class="ms-opt-sub"><i class="ms-dot ms-dot--${tone}"></i>${statusText}${b.version ? html` · v${b.version}` : nothing}</span>
              </span>
              ${on ? html`${num(false)}<span class="ms-check">${icons.check}</span>` : num(!blocked)}
            </button>`;
          })}
          ${this.backends.length === 0 ? html`<div class="ms-empty">Checking installed CLIs…</div>` : nothing}
        </div>
        </div>
        <div class="ms-col">
        ${r.mode === "cli" ? this.renderCliSettings(r) : nothing}
        <div class="ms-sec-h">InfiniBot agent${this.agentLocked ? html`<span class="ms-sec-note">this chat's agent</span>` : nothing}</div>
        <div class="ms-chips">
          ${this.visibleAgents().map((a) => {
            const on = r.mode === "agent" && a.id === this.agentId;
            return html`<button
              class="ms-opt ms-opt--chip ${on ? "ms-opt--on" : ""}"
              data-route="agent:${a.id}"
              title=${on ? `Talking to ${a.name}` : `Switch to ${a.name} (${a.id})`}
              @click=${() => this.pickAgent(a.id)}
            >
              <span class="ms-opt-ico">${icons.bot}</span><span class="ms-chip-name">${a.name}</span>${num(false)}
            </button>`;
          })}
          ${this.hiddenAgentCount() > 0
            ? html`<button class="ms-opt ms-opt--chip ms-more" data-more-agents @click=${() => (this.allAgents = true)}>
                <span class="ms-chip-name">+${this.hiddenAgentCount()} more</span>
              </button>`
            : nothing}
        </div>
        </div>
        </div>
        <div class="ms-foot">
          <span><kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> switch</span>
          <span><code>/cli codex</code> · <code>/agent</code></span>
        </div>
      </div>
    `;
  }

  private renderCliSettings(r: Extract<ChatRoute, { mode: "cli" }>) {
    const choices = CLI_MODEL_CHOICES[r.backend];
    const listId = `ms-models-${r.backend}`;
    const def = this.backends.find((b) => b.id === r.backend)?.defaultModel;
    const known = new Set(this.folders.map((f) => f.path));
    const current = r.cwd ?? "";
    return html`<div class="ms-cli">
      <label class="ms-field">
        <span class="ms-field-lbl">${icons.folder} Folder</span>
        ${this.editingFolder
          ? html`<span class="ms-folder-edit">
              <input
                class="ms-input"
                placeholder="/path/to/project or ~/project"
                .value=${this.customFolder || current}
                @input=${(e: Event) => (this.customFolder = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    this.setFolder(this.customFolder || current);
                  }
                }}
              />
              <button class="ms-mini" @click=${() => this.setFolder(this.customFolder || current)}>Use</button>
            </span>`
          : html`<select
              class="ms-select"
              data-cli-folder
              .value=${current}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === "__custom") {
                  this.editingFolder = true;
                  this.customFolder = current;
                } else this.setFolder(v);
              }}
            >
              <option value="" ?selected=${!current}>Home folder</option>
              ${current && !known.has(current) ? html`<option value=${current} selected>${folderName(current)} — ${current}</option>` : nothing}
              ${this.folders.some((f) => f.kind === "repo")
                ? html`<optgroup label="Repos">
                    ${this.folders.filter((f) => f.kind === "repo").map(
                      (f) => html`<option value=${f.path} ?selected=${f.path === current}>${f.label ?? folderName(f.path)} — ${f.path}</option>`,
                    )}
                  </optgroup>`
                : nothing}
              ${this.folders.some((f) => f.kind === "recent")
                ? html`<optgroup label="Recent">
                    ${this.folders.filter((f) => f.kind === "recent").map(
                      (f) => html`<option value=${f.path} ?selected=${f.path === current}>${folderName(f.path)} — ${f.path}</option>`,
                    )}
                  </optgroup>`
                : nothing}
              <option value="__custom">Other folder…</option>
            </select>`}
      </label>
      <label class="ms-field">
        <span class="ms-field-lbl">${icons.sparkles} Model</span>
        <input
          class="ms-input"
          list=${listId}
          data-cli-model
          placeholder=${def ? `CLI default (${def})` : "CLI default"}
          .value=${r.model ?? ""}
          @change=${(e: Event) => this.setModel((e.target as HTMLInputElement).value)}
        />
        <datalist id=${listId}>${choices.map((m) => html`<option value=${m}></option>`)}</datalist>
      </label>
    </div>`;
  }

  render() {
    return html`${this.renderTrigger()}${this.open && !this.compact ? this.renderPanel() : nothing}`;
  }

  static styles = css`
    :host {
      position: relative;
      display: inline-flex;
      align-items: center;
      font: inherit;
      color: var(--text, #e6e8ed);
      --ms-border: var(--g-border, var(--border, rgba(255, 255, 255, 0.12)));
      --ms-surface: var(--g-surface-strong, var(--bg-elevated, #16181d));
      --ms-accent: var(--g-primary, var(--accent, #d4af37));
      --ms-muted: var(--muted, rgba(230, 232, 237, 0.6));
    }
    button { font: inherit; color: inherit; }
    .ms-seg {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      border: 1px solid var(--ms-border);
      background: color-mix(in srgb, var(--text, #fff) 4%, transparent);
    }
    .ms-seg-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      max-width: 180px;
      padding: 0 10px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--ms-muted);
      font-size: 12.5px;
      font-weight: 550;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .ms-seg-btn:hover:not([disabled]) { color: var(--text, #fff); background: color-mix(in srgb, var(--text, #fff) 7%, transparent); }
    .ms-seg-btn--on {
      color: var(--text, #fff);
      background: color-mix(in srgb, var(--ms-accent) 18%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ms-accent) 45%, transparent);
    }
    .ms-seg-btn[disabled] { opacity: 0.5; cursor: default; }
    .ms-seg-ico, .ms-caret, .ms-opt-ico, .ms-check { display: inline-flex; align-items: center; }
    .ms-seg-ico svg, .ms-opt-ico svg { width: 14px; height: 14px; }
    .ms-caret svg { width: 12px; height: 12px; opacity: 0.7; }
    .ms-seg-lbl { overflow: hidden; text-overflow: ellipsis; }

    .ms-icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      border: 1px solid var(--ms-border);
      background: color-mix(in srgb, var(--text, #fff) 4%, transparent);
      cursor: pointer;
    }
    .ms-icon--cli { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ms-accent) 50%, transparent); }
    .ms-icon-dot {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--ms-muted);
      border: 2px solid var(--ms-surface);
    }
    .ms-icon-dot--cli { background: var(--ms-accent); }

    .ms-panel {
      position: absolute;
      right: 0;
      bottom: calc(100% + var(--ms-gap-up, 8px));
      z-index: 60;
      width: 330px;
      max-height: var(--ms-max-h, min(70vh, 560px));
      overflow: auto;
      padding: 8px;
      border-radius: 14px;
      border: 1px solid var(--ms-border);
      background: var(--glass-solid, var(--ms-surface));
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(18px);
    }
    .ms-panel--down { bottom: auto; top: calc(100% + var(--ms-gap-down, 8px)); }
    .ms-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 10px; }
    .ms-panel:not(.ms-panel--sheet) { width: 600px; max-width: calc(100vw - 32px); }
    .ms-panel--sheet .ms-cols { display: block; }
    .ms-col { min-width: 0; }
    .ms-col > .ms-cli:first-child { margin-top: 8px; }
    .ms-more { padding-left: 10px; color: var(--ms-muted); }
    .ms-panel { scrollbar-width: thin; }
    .ms-backdrop {
      position: fixed;
      inset: 0;
      z-index: 59;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(2px);
    }
    .ms-panel--sheet {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      max-height: 82vh;
      border-radius: 18px 18px 0 0;
      padding: 6px 12px calc(14px + env(safe-area-inset-bottom, 0px));
      animation: ms-up 0.2s cubic-bezier(0.22, 1, 0.36, 1);
    }
    @keyframes ms-up { from { transform: translateY(24px); opacity: 0; } to { transform: none; opacity: 1; } }
    .ms-grab { width: 40px; height: 4px; border-radius: 2px; margin: 4px auto 8px; background: var(--ms-border); }
    .ms-sec-h {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 8px 8px 4px;
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ms-muted);
    }
    .ms-sec-note { text-transform: none; letter-spacing: 0; font-weight: 450; opacity: 0.8; }
    .ms-list { display: flex; flex-direction: column; gap: 2px; }
    .ms-opt {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 44px;
      padding: 6px 8px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .ms-opt:hover:not([disabled]), .ms-opt:focus-visible { background: color-mix(in srgb, var(--text, #fff) 7%, transparent); outline: none; }
    .ms-opt--on { background: color-mix(in srgb, var(--ms-accent) 14%, transparent); }
    .ms-opt[disabled] { opacity: 0.5; cursor: not-allowed; }
    .ms-opt-ico {
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--text, #fff) 6%, transparent);
    }
    .ms-opt-ico--brand svg { width: 16px; height: 16px; }
    .ms-opt-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .ms-opt-name { font-size: 13.5px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ms-opt-sub { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ms-muted); }
    .ms-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .ms-dot--ready { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
    .ms-dot--login { background: #fbbf24; }
    .ms-dot--unavailable { background: #6b7280; }
    .ms-dot--update { background: #60a5fa; }
    .ms-check svg { width: 15px; height: 15px; color: var(--ms-accent); }
    .ms-num {
      font: 600 10.5px/1 var(--font-mono, ui-monospace, monospace);
      padding: 3px 5px;
      border-radius: 5px;
      border: 1px solid var(--ms-border);
      color: var(--ms-muted);
    }
    .ms-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 6px 4px; }
    .ms-opt.ms-opt--chip {
      width: auto;
      min-height: 32px;
      padding: 3px 10px 3px 4px;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid var(--ms-border);
    }
    .ms-opt--chip .ms-opt-ico { width: 24px; height: 24px; flex-basis: 24px; border-radius: 50%; }
    .ms-chip-name { font-size: 12.5px; font-weight: 550; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ms-opt--chip.ms-opt--on { border-color: color-mix(in srgb, var(--ms-accent) 55%, transparent); }
    .ms-empty { padding: 10px; font-size: 12.5px; color: var(--ms-muted); }
    .ms-cli {
      display: grid;
      gap: 8px;
      margin: 8px 4px 2px;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--ms-border);
      background: color-mix(in srgb, var(--text, #fff) 3%, transparent);
    }
    .ms-field { display: grid; gap: 5px; }
    .ms-field-lbl { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--ms-muted); }
    .ms-field-lbl svg { width: 13px; height: 13px; }
    .ms-select, .ms-input {
      width: 100%;
      box-sizing: border-box;
      min-height: 34px;
      padding: 6px 10px;
      border-radius: 9px;
      border: 1px solid var(--ms-border);
      background: var(--ms-surface);
      color: inherit;
      font: inherit;
      font-size: 13px;
    }
    .ms-select { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; padding-right: 30px; }
    .ms-folder-edit { display: flex; gap: 6px; }
    .ms-mini {
      padding: 0 12px;
      border-radius: 9px;
      border: 1px solid color-mix(in srgb, var(--ms-accent) 50%, transparent);
      background: color-mix(in srgb, var(--ms-accent) 16%, transparent);
      cursor: pointer;
    }
    .ms-foot {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      padding: 8px 8px 2px;
      font-size: 11px;
      color: var(--ms-muted);
    }
    .ms-foot kbd {
      font: 600 10px/1 var(--font-mono, ui-monospace, monospace);
      padding: 2px 4px;
      border-radius: 4px;
      border: 1px solid var(--ms-border);
    }
    .ms-foot code { font-size: 10.5px; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-mode-switcher": ChatModeSwitcher;
  }
}
