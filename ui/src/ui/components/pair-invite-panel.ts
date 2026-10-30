/**
 * <pair-invite-panel> — generate a one-time invite link for pairing a new
 * device without sharing the gateway password.
 *
 * Usage: drop the element anywhere inside the authenticated UI. It calls
 * `pairing.createInvite` via the gateway RPC, then shows a QR code and a
 * copyable URL with a live countdown timer.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { awaitGatewayClient } from "../gateway-client.js";
import { gatewayHttpBase } from "../gateway-endpoint";

type InviteResult = {
  token: string;
  expiresAt: number;
  url: string;
};

@customElement("pair-invite-panel")
export class PairInvitePanel extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .pip-card {
      background: rgba(10, 10, 14, 0.7);
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 14px;
      padding: 1.25rem;
      backdrop-filter: blur(16px);
    }

    .pip-title {
      font-size: 0.85rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #d4af37;
      text-transform: uppercase;
      margin: 0 0 0.5rem 0;
    }

    .pip-desc {
      font-size: 0.78rem;
      color: rgba(255, 255, 255, 0.5);
      margin: 0 0 1rem 0;
      line-height: 1.5;
    }

    .pip-generate-btn {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.65rem 1.1rem;
      background: linear-gradient(135deg, #d4af37 0%, #daa520 100%);
      border: 1px solid #c9951d;
      border-radius: 8px;
      color: #000;
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.15s;
    }

    .pip-generate-btn:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
    }

    .pip-generate-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .pip-result {
      margin-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .pip-qr {
      width: 160px;
      height: 160px;
      border-radius: 8px;
      background: #0a0a0e;
      align-self: center;
    }

    .pip-qr img {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 8px;
    }

    .pip-url-row {
      display: flex;
      gap: 0.4rem;
    }

    .pip-url-input {
      flex: 1;
      min-width: 0;
      padding: 0.5rem 0.75rem;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 6px;
      color: #fff;
      font-size: 0.78rem;
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pip-copy-btn {
      padding: 0.5rem 0.75rem;
      background: rgba(212, 175, 55, 0.1);
      border: 1px solid rgba(212, 175, 55, 0.3);
      border-radius: 6px;
      color: #d4af37;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }

    .pip-copy-btn:hover {
      background: rgba(212, 175, 55, 0.2);
    }

    .pip-copy-btn.pip-copy-btn--copied {
      background: rgba(34, 197, 94, 0.15);
      border-color: rgba(34, 197, 94, 0.4);
      color: #22c55e;
    }

    .pip-countdown {
      font-size: 0.75rem;
      color: rgba(255, 255, 255, 0.45);
      text-align: center;
    }

    .pip-countdown--warn {
      color: #f59e0b;
    }

    .pip-countdown--expired {
      color: #f87171;
    }

    .pip-regen-row {
      display: flex;
      justify-content: center;
    }

    .pip-regen-btn {
      padding: 0.4rem 0.75rem;
      background: none;
      border: 1px dashed rgba(212, 175, 55, 0.3);
      border-radius: 6px;
      color: rgba(212, 175, 55, 0.7);
      font-size: 0.75rem;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
    }

    .pip-regen-btn:hover {
      border-color: rgba(212, 175, 55, 0.6);
      color: #d4af37;
    }

    .pip-error {
      font-size: 0.78rem;
      color: #f87171;
      margin-top: 0.5rem;
    }
  `;

  @state() private _invite: InviteResult | null = null;
  @state() private _loading = false;
  @state() private _error: string | null = null;
  @state() private _copied = false;
  @state() private _remaining: number = 0;

  private _countdownTimer: ReturnType<typeof setInterval> | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopCountdown();
  }

  private _stopCountdown() {
    if (this._countdownTimer !== null) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  private _startCountdown() {
    this._stopCountdown();
    if (!this._invite) return;
    const tick = () => {
      const rem = Math.max(0, (this._invite?.expiresAt ?? 0) - Date.now());
      this._remaining = rem;
      if (rem === 0) this._stopCountdown();
    };
    tick();
    this._countdownTimer = setInterval(tick, 1000);
  }

  private async _generate() {
    this._loading = true;
    this._error = null;
    this._invite = null;
    this._stopCountdown();
    try {
      const client = await awaitGatewayClient(5000);
      const result = await client.request<{ ok: boolean; token: string; expiresAt: number; url: string }>(
        "pairing.createInvite",
        {},
      );
      if (!result.ok) throw new Error("Gateway returned not-ok");
      this._invite = { token: result.token, expiresAt: result.expiresAt, url: result.url };
      this._startCountdown();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  private async _copy() {
    if (!this._invite) return;
    try {
      await navigator.clipboard.writeText(this._invite.url);
      this._copied = true;
      setTimeout(() => { this._copied = false; }, 2000);
    } catch {
      // fallback: select the input
    }
  }

  private _formatRemaining(ms: number): string {
    if (ms <= 0) return "Expired";
    const totalSec = Math.ceil(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `Expires in ${min}:${sec.toString().padStart(2, "0")}`;
  }

  render() {
    return html`
      <div class="pip-card">
        <p class="pip-title">Pair New Device</p>
        <p class="pip-desc">
          Generate a one-time link that lets a new device connect without entering the gateway password.
          The link expires after 15 minutes and can only be used once.
        </p>

        <button
          class="pip-generate-btn"
          ?disabled=${this._loading}
          @click=${this._generate}
        >
          ${this._loading
            ? html`<span style="opacity:.7">Generating…</span>`
            : this._invite
            ? html`<span>Regenerate Link</span>`
            : html`<span>Generate Invite Link</span>`}
        </button>

        ${this._error ? html`<p class="pip-error">${this._error}</p>` : nothing}

        ${this._invite ? html`
          <div class="pip-result">
            <div class="pip-qr">
              <img
                src="${gatewayHttpBase()}/api/pairing/qr-invite.svg?token=${encodeURIComponent(this._invite.token)}"
                alt="QR code for invite link"
              />
            </div>

            <div class="pip-url-row">
              <input
                class="pip-url-input"
                type="text"
                readonly
                .value=${this._invite.url}
              />
              <button
                class="pip-copy-btn ${this._copied ? "pip-copy-btn--copied" : ""}"
                @click=${this._copy}
              >
                ${this._copied ? "Copied!" : "Copy"}
              </button>
            </div>

            <p class=${`pip-countdown ${
              this._remaining <= 0
                ? "pip-countdown--expired"
                : this._remaining < 120_000
                ? "pip-countdown--warn"
                : ""
            }`}>
              ${this._formatRemaining(this._remaining)}
            </p>

            <div class="pip-regen-row">
              <button class="pip-regen-btn" @click=${this._generate}>
                New link
              </button>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "pair-invite-panel": PairInvitePanel;
  }
}
