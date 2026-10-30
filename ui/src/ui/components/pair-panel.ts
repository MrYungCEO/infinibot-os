import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gatewayOrigin } from "../gateway-endpoint";

type PairingInfo = {
  tailnetUrl: string | null;
  tailnetDirectUrl: string | null;
  tailnetHostname: string | null;
  port: number;
};

@customElement("infinibot-pair-panel")
export class InfinibotPairPanel extends LitElement {
  @state() private info: PairingInfo | null = null;
  @state() private copied = false;
  @state() private showQr = false;

  static styles = css`
    :host {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 100;
      font-family: var(--g-font-family, 'Inter', sans-serif);
    }

    .pair-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: rgba(10,10,14,0.85);
      border: 1px solid rgba(212,175,55,0.35);
      border-radius: 999px;
      color: rgba(212,175,55,0.9);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      cursor: pointer;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .pair-toggle:hover {
      border-color: rgba(212,175,55,0.7);
      box-shadow: 0 4px 24px rgba(212,175,55,0.12);
    }
    .pair-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #d4af37;
      box-shadow: 0 0 6px #d4af37;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .pair-card {
      position: absolute;
      bottom: calc(100% + 10px);
      right: 0;
      width: 300px;
      background: rgba(10,10,14,0.95);
      border: 1px solid rgba(212,175,55,0.3);
      border-radius: 16px;
      padding: 20px;
      backdrop-filter: blur(20px);
      box-shadow: 0 16px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04);
    }
    .pair-card-head {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(212,175,55,0.7);
      margin-bottom: 14px;
    }

    .pair-section { margin-bottom: 16px; }
    .pair-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.35);
      margin-bottom: 6px;
    }
    .pair-url-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .pair-url {
      flex: 1;
      font-size: 11px;
      font-family: 'JetBrains Mono', 'Fira Mono', monospace;
      color: rgba(212,175,55,0.9);
      background: rgba(212,175,55,0.06);
      border: 1px solid rgba(212,175,55,0.18);
      border-radius: 6px;
      padding: 7px 9px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      user-select: all;
    }
    .pair-copy {
      flex-shrink: 0;
      padding: 7px 11px;
      background: rgba(212,175,55,0.1);
      border: 1px solid rgba(212,175,55,0.25);
      border-radius: 6px;
      color: rgba(212,175,55,0.85);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.12s;
      white-space: nowrap;
    }
    .pair-copy:hover { background: rgba(212,175,55,0.18); }
    .pair-copy--done { color: #10b981; border-color: rgba(16,185,129,0.3); }

    .pair-qr-toggle {
      width: 100%;
      padding: 8px;
      margin-top: 8px;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      color: rgba(255,255,255,0.45);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.06em;
      transition: border-color 0.12s, color 0.12s;
    }
    .pair-qr-toggle:hover { border-color: rgba(212,175,55,0.3); color: rgba(212,175,55,0.7); }

    .pair-qr {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .pair-qr img {
      width: 180px;
      height: 180px;
      border-radius: 8px;
      background: #0a0a0e;
    }
    .pair-qr-hint {
      font-size: 11px;
      color: rgba(255,255,255,0.35);
      text-align: center;
    }

    .pair-no-tailscale {
      font-size: 12px;
      color: rgba(255,255,255,0.4);
      line-height: 1.5;
    }
    .pair-no-tailscale a {
      color: rgba(212,175,55,0.8);
      text-decoration: none;
    }

    .pair-step {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
    }
    .pair-step-num {
      flex-shrink: 0;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: rgba(212,175,55,0.15);
      border: 1px solid rgba(212,175,55,0.3);
      color: rgba(212,175,55,0.8);
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pair-step-text {
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      line-height: 1.5;
      padding-top: 1px;
    }
    .pair-step-text code {
      background: rgba(212,175,55,0.08);
      color: rgba(212,175,55,0.8);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: monospace;
      font-size: 10px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._fetchInfo();
  }

  private async _fetchInfo() {
    try {
      const base = gatewayOrigin();
      const res = await fetch(`${base}/api/pairing/info`);
      if (res.ok) {
        const data = await res.json() as PairingInfo & { ok: boolean };
        if (data.ok) this.info = data;
      }
    } catch { /* gateway not up yet */ }
  }

  private _copyUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
    this.copied = true;
    setTimeout(() => { this.copied = false; }, 2000);
  }

  render() {
    const info = this.info;

    return html`
      ${this.showQr
        ? html`
          <div class="pair-card">
            <div class="pair-card-head">Pair a new device</div>

            ${info?.tailnetUrl
              ? html`
                <div class="pair-section">
                  <div class="pair-label">${info.tailnetUrl.startsWith('https://') ? '🔒 Secure Tailscale URL' : 'Tailscale URL'}</div>
                  <div class="pair-url-row">
                    <div class="pair-url" title=${info.tailnetUrl}>${info.tailnetUrl}</div>
                    <button
                      class="pair-copy ${this.copied ? 'pair-copy--done' : ''}"
                      @click=${() => this._copyUrl(info!.tailnetUrl!)}
                    >${this.copied ? '✓ Copied' : 'Copy'}</button>
                  </div>

                  <div class="pair-qr">
                    <img src="${gatewayOrigin()}/api/pairing/qr.svg" alt="QR code" />
                    <div class="pair-qr-hint">Scan with any device on your tailnet</div>
                  </div>
                </div>

                <div class="pair-section">
                  <div class="pair-label">Steps to pair a new device</div>
                  <div class="pair-step">
                    <span class="pair-step-num">1</span>
                    <span class="pair-step-text">Install Tailscale on the new device and sign in to the same Tailscale account as this machine</span>
                  </div>
                  <div class="pair-step">
                    <span class="pair-step-num">2</span>
                    <span class="pair-step-text">Open <code>${info.tailnetUrl}</code> or scan the QR code above</span>
                  </div>
                  <div class="pair-step">
                    <span class="pair-step-num">3</span>
                    <span class="pair-step-text">Enter your gateway password to connect — no additional setup needed</span>
                  </div>
                </div>
              `
              : html`
                <div class="pair-no-tailscale">
                  <p>Tailscale is not reachable from this machine right now. To pair over the local network use:</p>
                  <div class="pair-url-row" style="margin-top:8px">
                    <div class="pair-url">${gatewayOrigin()}</div>
                    <button
                      class="pair-copy ${this.copied ? 'pair-copy--done' : ''}"
                      @click=${() => this._copyUrl(gatewayOrigin())}
                    >${this.copied ? '✓ Copied' : 'Copy'}</button>
                  </div>
                </div>
              `}
          </div>
        `
        : nothing}

      <button class="pair-toggle" @click=${() => { this.showQr = !this.showQr; if (this.showQr && !this.info) this._fetchInfo(); }}>
        <span class="pair-dot"></span>
        ${this.showQr ? 'Close pairing' : 'Pair new device'}
      </button>
    `;
  }
}
