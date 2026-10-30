/**
 * <ib-secure-toggle> — the reusable Secure Mode switch.
 *
 *   mode="global" (default)  reflects + flips the gateway-wide toggle
 *                            (secure.set). Inline error when the OS keyring
 *                            key is unreachable.
 *   mode="custom"            the host owns the state (`.on`, `.busy`,
 *                            `.error`); a click emits `secure-toggle`
 *                            `{ on: boolean }` (bubbles, composed). Used by
 *                            chat composers where "on" means "this session is
 *                            in the secure lane".
 *
 * `compact` drops the hint line (it moves to the tooltip) for composers.
 * Renders nothing against a gateway that does not serve secure.*.
 *
 * <ib-secure-badge> — the top-bar indicator: "Secure Mode · local only" while
 * the lane is open, "Secure session locked" when the chat on screen is a
 * secure session but Secure Mode is off. Click opens a small panel with the
 * global toggle.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { getAccessMe } from "../access/access-session";
import { isSecureSessionKey } from "./session-key";
import { SecureModeController, loadSecureStatus, secureActive, secureRequest, setSecureMode } from "./store";
import { ensureSecureGlobalStyles, secureBaseStyles } from "./styles";
import "./secure-model";
import "./secure-research";

export const SECURE_HINT = "Local models · encrypted · offline tools";

@customElement("ib-secure-toggle")
export class SecureToggle extends LitElement {
  @property() mode: "global" | "custom" = "global";
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) on = false;
  @property({ type: Boolean }) busy = false;
  @property({ type: Boolean }) disabled = false;
  @property() error: string | null = null;
  @property() label = "Secure Mode";
  @property() hint = SECURE_HINT;
  /** Extra tooltip line (e.g. why it is disabled). */
  @property() note: string | null = null;

  private secure = new SecureModeController(this);

  connectedCallback(): void {
    super.connectedCallback();
    ensureSecureGlobalStyles();
  }

  private get isOn(): boolean {
    return this.mode === "custom" ? this.on : secureActive(this.secure.state);
  }

  private get isBusy(): boolean {
    return this.mode === "custom" ? this.busy : this.secure.state.busy;
  }

  private get err(): string | null {
    return this.mode === "custom" ? this.error : this.secure.state.error;
  }

  private async onClick() {
    if (this.disabled || this.isBusy) return;
    const next = !this.isOn;
    if (this.mode === "custom") {
      this.dispatchEvent(new CustomEvent("secure-toggle", { detail: { on: next }, bubbles: true, composed: true }));
      return;
    }
    const ok = await setSecureMode(next);
    this.dispatchEvent(new CustomEvent("secure-change", { detail: { enabled: next, ok }, bubbles: true, composed: true }));
  }

  render() {
    if (this.secure.state.supported === false) return nothing;
    // Workspace users (auth.multiUser) without the Secure Mode allowance never see it.
    if (secureHiddenForWorkspaceUser()) return nothing;
    const on = this.isOn;
    const busy = this.isBusy;
    const err = this.err;
    const title = [
      on ? `${this.label} is on` : `Turn on ${this.label}`,
      this.hint,
      this.note ?? "",
    ]
      .filter(Boolean)
      .join(" — ");
    return html`
      <div class="st ${on ? "st--on" : ""} ${this.compact ? "st--compact" : ""}">
        <button
          type="button"
          class="st-btn"
          data-secure-toggle
          aria-pressed=${on ? "true" : "false"}
          aria-label=${`${this.label}${on ? " on" : " off"}`}
          title=${title}
          ?disabled=${this.disabled || busy}
          aria-busy=${busy ? "true" : "false"}
          @click=${() => void this.onClick()}
        >
          <span class="st-ico">${on ? icons.lock : icons.unlock}</span>
          <span class="st-label">${this.label}</span>
          <span class="st-switch" aria-hidden="true"><span class="st-knob"></span></span>
        </button>
        ${this.compact ? nothing : html`<span class="st-hint">${this.hint}</span>`}
        ${err ? html`<span class="st-err" role="alert">${err}</span>` : nothing}
      </div>
    `;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: inline-flex; min-width: 0; }
      .st { position: relative; display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .st-btn {
        display: inline-flex; align-items: center; gap: 8px;
        min-height: 32px; padding: 0 6px 0 10px; border-radius: 999px;
        border: 1px solid var(--sm-border);
        background: color-mix(in srgb, currentColor 5%, transparent);
        cursor: pointer; font-size: 12.5px; font-weight: 600; white-space: nowrap;
        transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
      }
      .st-btn:hover:not(:disabled) { border-color: var(--sm-ring); }
      .st-btn:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 2px; }
      .st-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      .st--on .st-btn { color: var(--sm-accent); border-color: var(--sm-ring); background: var(--sm-soft); box-shadow: var(--ib-secure-glow, none); }
      .st-ico { display: inline-flex; }
      .st-ico svg { width: 14px; height: 14px; }
      .st-switch {
        position: relative; width: 30px; height: 18px; border-radius: 999px; flex: none;
        background: color-mix(in srgb, currentColor 18%, transparent);
        transition: background 0.18s ease;
      }
      .st-knob {
        position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
        background: var(--glass-fg, #fff); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        transition: transform 0.18s ease;
      }
      .st--on .st-switch { background: var(--sm-accent); }
      .st--on .st-knob { transform: translateX(12px); background: var(--sm-ink); }
      .st-btn[aria-busy="true"] .st-knob { animation: st-pulse 0.9s ease-in-out infinite; }
      @keyframes st-pulse { 50% { opacity: 0.4; } }
      .st-hint { font-size: 11.5px; color: var(--sm-muted); white-space: nowrap; }
      /* Phones: the hint stays in the tooltip/aria label instead of truncating. */
      @media (max-width: 640px) { .st-hint { display: none; } }
      .st-err { flex-basis: 100%; font-size: 12px; color: #f87171; line-height: 1.35; max-width: 420px; white-space: normal; }
      .st--compact .st-btn { min-height: 30px; padding: 0 5px 0 8px; gap: 6px; font-size: 12px; }
      .st--compact .st-switch { width: 26px; height: 16px; }
      .st--compact .st-knob { width: 12px; height: 12px; }
      .st--compact.st--on .st-knob { transform: translateX(10px); }
      .st--compact .st-err {
        position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: max-content; max-width: 320px;
        padding: 8px 10px; border-radius: 10px; background: var(--sm-surface-2); border: 1px solid rgba(248, 113, 113, 0.45);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      }
      @media (prefers-reduced-motion: reduce) { .st-btn, .st-knob, .st-switch { transition: none; } }
    `,
  ];
}

@customElement("ib-secure-badge")
export class SecureBadge extends LitElement {
  /** Chat session on screen; falls back to the store's chat session. */
  @property() sessionKey: string | null = null;
  @state() private open = false;
  @state() private pos: { top: number; right: number } = { top: 48, right: 12 };

  private secure = new SecureModeController(this);

  private onDoc = (e: MouseEvent) => {
    if (!this.open) return;
    if (!e.composedPath().includes(this)) this.open = false;
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open) this.open = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    ensureSecureGlobalStyles();
    document.addEventListener("click", this.onDoc, true);
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onDoc, true);
    window.removeEventListener("keydown", this.onKey);
  }

  @state() private savingApproval = false;
  @state() private approvalError: string | null = null;

  private async setApproval(value: string) {
    if (value !== "ask" && value !== "auto-sanitized") return;
    this.savingApproval = true;
    this.approvalError = null;
    try {
      await secureRequest("secure.research.approval.set", { approval: value });
      await loadSecureStatus();
    } catch (err) {
      this.approvalError = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.savingApproval = false;
    }
  }

  private toggle(e: Event) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.pos = { top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) };
    this.open = !this.open;
  }

  render() {
    const s = this.secure.state;
    if (s.supported === false) return nothing;
    if (secureHiddenForWorkspaceUser()) return nothing;
    const active = secureActive(s);
    const key = this.sessionKey ?? s.chatSessionKey;
    const sessionSecure = isSecureSessionKey(key);
    const enabledLocked = Boolean(s.status?.enabled && !s.status.unlocked);
    if (!active && !sessionSecure && !enabledLocked) return nothing;
    const locked = !active;
    const title = active ? "Secure Mode" : enabledLocked ? "Secure Mode locked" : "Secure session locked";
    const sub = active ? "local only" : enabledLocked ? "key unavailable" : "turn on to use";
    const c = s.status?.counts;
    return html`
      <button
        type="button"
        class="sb ${locked ? "sb--locked" : ""}"
        data-secure-badge
        aria-label=${title}
        aria-haspopup="dialog"
        aria-expanded=${this.open ? "true" : "false"}
        title=${active ? `Secure Mode is on — local models only, encrypted storage, network tools off` : title}
        @click=${(e: Event) => this.toggle(e)}
      >
        <span class="sb-ico">${active ? icons.shieldCheck : icons.lock}</span>
        <span class="sb-title">${title}</span>
        <span class="sb-sub">${sub}</span>
      </button>
      ${this.open
        ? html`<div class="sb-pop" role="dialog" aria-label="Secure Mode" style="top:${this.pos.top}px;right:${this.pos.right}px">
            <div class="sb-pop-head">${icons.shield}<strong>Secure Mode</strong></div>
            <p class="sm-muted">
              Secure chats, the secure board, documents and graph run on local models only, are encrypted at rest with
              your OS keyring key, and never get network tools.
            </p>
            <ib-secure-toggle></ib-secure-toggle>
            ${active ? html`<ib-secure-model-picker></ib-secure-model-picker>` : nothing}
            ${active && s.status?.research?.enabled
              ? html`<div class="sb-research">
                  <div class="sb-research-head">
                    ${icons.search}<strong>Secure research</strong>
                    <span class="grow"></span>
                    <label class="sb-approval" title="How outbound search queries are approved">
                      <select
                        class="sm-input"
                        aria-label="Research approval"
                        .value=${s.status.research.approval}
                        ?disabled=${this.savingApproval}
                        @change=${(e: Event) => void this.setApproval((e.target as HTMLSelectElement).value)}
                      >
                        <option value="ask">Ask me each time</option>
                        <option value="auto-sanitized">Send when sanitized</option>
                      </select>
                    </label>
                  </div>
                  ${this.approvalError ? html`<div class="sm-error">${this.approvalError}</div>` : nothing}
                  <ib-secure-research-card all></ib-secure-research-card>
                  <ib-secure-research-log limit="20"></ib-secure-research-log>
                </div>`
              : nothing}
            ${s.status
              ? html`<dl class="sb-meta">
                  <dt>Key</dt><dd>${s.status.unlocked ? (s.status.keySource ?? "keyring") : "locked"}${s.status.keyAccount ? html` · <span class="mono">${s.status.keyAccount}</span>` : nothing}</dd>
                  ${c
                    ? html`<dt>Lane</dt><dd>${c.projects} projects · ${c.tasks} tasks · ${c.docs} docs · ${c.nodes} nodes · ${c.sessions} chats</dd>`
                    : nothing}
                  ${s.status.allowedTools.length
                    ? html`<dt>Tools</dt><dd>${s.status.allowedTools.slice(0, 8).join(", ")}${s.status.allowedTools.length > 8 ? "…" : ""}</dd>`
                    : nothing}
                </dl>`
              : nothing}
          </div>`
        : nothing}
    `;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: inline-flex; }
      .sb {
        display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px;
        color: var(--sm-accent); background: var(--sm-soft); border: 1px solid var(--sm-ring);
        box-shadow: var(--ib-secure-glow, none); cursor: pointer; white-space: nowrap; font-size: 12px;
      }
      .sb:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 2px; }
      .sb-ico { display: inline-flex; }
      .sb-ico svg { width: 14px; height: 14px; }
      .sb-title { font-weight: 700; letter-spacing: 0.01em; }
      .sb-sub { font-size: 11px; opacity: 0.8; font-weight: 500; }
      .sb-sub::before { content: "·"; margin-right: 6px; opacity: 0.7; }
      .sb--locked { background: transparent; border-style: dashed; box-shadow: none; }
      .sb-pop {
        position: fixed; z-index: 10050; width: min(400px, calc(100vw - 16px));
        max-height: calc(100vh - 80px); overflow: auto;
        display: flex; flex-direction: column; gap: 10px; padding: 14px;
        border-radius: var(--sm-radius); background: var(--glass-solid, var(--sm-surface-2));
        border: 1px solid var(--sm-ring); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
      }
      .sb-pop-head { display: flex; align-items: center; gap: 8px; color: var(--sm-accent); }
      .sb-pop p { margin: 0; line-height: 1.45; }
      .sb-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; font-size: 12px; }
      .sb-meta dt { color: var(--sm-muted); }
      .sb-meta dd { margin: 0; overflow-wrap: anywhere; }
      .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; }
      .sb-research { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--sm-border); }
      .sb-research-head { display: flex; align-items: center; gap: 8px; color: var(--sm-accent); font-size: 13px; }
      .sb-research-head .grow { flex: 1; }
      .sb-approval select { min-height: 28px; font-size: 12px; padding: 0 6px; color: var(--glass-fg, inherit); }
      @media (max-width: 720px) { .sb-sub { display: none; } }
      /* Phones: the top bar's centred clock leaves room for an icon only. */
      @media (max-width: 640px) {
        .sb-title { display: none; }
        .sb { padding-inline: 6px; gap: 0; }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-toggle": SecureToggle;
    "ib-secure-badge": SecureBadge;
  }
}

function secureHiddenForWorkspaceUser(): boolean {
  const me = getAccessMe();
  return !!me && me.owner === false && !me.features.secure;
}
