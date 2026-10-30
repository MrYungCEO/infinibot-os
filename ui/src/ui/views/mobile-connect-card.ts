/**
 * Mobile page › "Connect phone" — a pairing QR the InfiniBot app scans
 * (Connect › Self-hosted gateway › Scan pairing QR). It encodes JSON
 * {gatewayUrl, password|token} (see ../mobile-pairing.ts), so it carries the
 * gateway secret: it stays blurred until the user clicks Reveal, hides itself
 * again after two minutes, and is rendered locally (never via a QR web API).
 */
import { html, nothing } from "lit";
import { sgIcon } from "./system-glass";
import { buildMobilePairingPayload, pickPairingGatewayUrl } from "../mobile-pairing";
import { renderQrSvg } from "../qr-svg";
import type { MobileState } from "../controllers/mobile";

const REVEAL_MS = 120_000;

type ConnectHost = {
  mobile?: MobileState;
  requestUpdate?: () => void;
  password?: string;
  settings?: { token?: string; password?: string };
};

let revealedUntil = 0;
let hideTimer: number | null = null;
let serveUrl: string | null = null;
let serveChecked = false;
let qrCache: { payload: string; svg: string } | null = null;

/** The secret this browser used to sign in to the gateway (password wins). */
function currentSecret(host: ConnectHost): { password: string | null; token: string | null } {
  const password = host.password?.trim() || host.settings?.password?.trim() || host.mobile?.suggested?.gatewayToken?.trim() || "";
  const token = host.settings?.token?.trim() || "";
  return { password: password || null, token: password ? null : token || null };
}

function checkServe(host: ConnectHost, secret: string | null) {
  if (serveChecked) return;
  serveChecked = true;
  // Best effort: is this gateway behind Tailscale Serve (https at "/")? Then
  // the phone should use wss://<magicdns> on 443.
  void fetch("/api/pairing/info", { headers: secret ? { Authorization: `Bearer ${secret}` } : {} })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { tailnetUrl?: string | null } | null) => {
      if (j?.tailnetUrl && /^https:\/\//i.test(j.tailnetUrl)) {
        serveUrl = j.tailnetUrl;
        host.requestUpdate?.();
      }
    })
    .catch(() => {});
}

function gatewayPort(ms: MobileState | undefined): number {
  const m = /:(\d+)(?:\/|$)/.exec(ms?.suggested?.gatewayUrl ?? "");
  return m ? Number(m[1]) : 18789;
}

export function renderConnectPhoneCard(host: ConnectHost) {
  const ms = host.mobile;
  const { password, token } = currentSecret(host);
  checkServe(host, password || token);
  const gatewayUrl = pickPairingGatewayUrl({
    override: ms?.config?.gatewayUrlOverride ?? null,
    serveUrl,
    tailnetHostname: ms?.suggested?.tailnetHostname ?? null,
    tailscaleAddress: ms?.suggested?.tailscaleAddress ?? null,
    gatewayUrl: ms?.suggested?.gatewayUrl ?? null,
    port: gatewayPort(ms),
  });
  const kind = password ? "password" : token ? "token" : null;
  const revealed = revealedUntil > Date.now();
  const payload = gatewayUrl && kind ? buildMobilePairingPayload({ gatewayUrl, password, token }) : "";
  if (payload && revealed && qrCache?.payload !== payload) {
    try {
      qrCache = { payload, svg: renderQrSvg(payload) };
    } catch {
      qrCache = null;
    }
  }

  const setRevealed = (on: boolean) => {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = null;
    revealedUntil = on ? Date.now() + REVEAL_MS : 0;
    if (on) {
      hideTimer = window.setTimeout(() => {
        revealedUntil = 0;
        host.requestUpdate?.();
      }, REVEAL_MS);
    }
    host.requestUpdate?.();
  };

  return html`
    <section class="sg-panel mob-card mob-pair" data-learn-id="mobile-connect-phone">
      <div class="mob-apk-head">
        <div class="mob-intro-icon">${sgIcon("phone", 22)}</div>
        <div class="mob-apk-title">
          <h3>Connect phone</h3>
          <p class="mob-card-sub">
            In the InfiniBot app choose <b>Self-hosted gateway › Scan pairing QR</b>. The code holds this gateway's address and
            ${kind ?? "password"}, so the phone connects without typing anything.
          </p>
        </div>
      </div>
      <div class="mob-pair-body">
        <div class="mob-pair-qr ${revealed && qrCache ? "" : "is-hidden"}" data-testid="pair-qr">
          ${revealed && qrCache
            ? html`<img alt="Pairing QR: gateway address and ${kind}" src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCache.svg)}`} />`
            : html`<div class="mob-pair-veil">${sgIcon("lock", 22)}<span>${payload ? "Hidden — contains your gateway " + kind : "Not available"}</span></div>`}
        </div>
        <div class="mob-pair-side">
          <div class="mob-pair-row">
            <span class="mob-pair-k">Gateway</span>
            ${gatewayUrl
              ? html`<span class="mob-cmd"><code data-testid="pair-url">${gatewayUrl}</code></span>`
              : html`<span class="mob-pair-v">Detecting…</span>`}
          </div>
          <div class="mob-pair-row">
            <span class="mob-pair-k">Sign-in</span>
            <span class="mob-pair-v">${kind ? `Gateway ${kind} (from this browser's login)` : "None — this browser signed in another way"}</span>
          </div>
          ${!kind
            ? html`<p class="mob-help">No password or token is saved in this browser, so there is nothing to put in the QR. Enter the gateway's password in the app by hand.</p>`
            : nothing}
          <div class="mob-actions">
            ${revealed
              ? html`<button class="sg-btn mob-btn" data-testid="pair-hide" @click=${() => setRevealed(false)}>${sgIcon("eye", 14)} Hide QR</button>`
              : html`<button class="sg-btn sg-btn--primary mob-btn" data-testid="pair-reveal" ?disabled=${!payload}
                  @click=${() => setRevealed(true)}>${sgIcon("eye", 14)} Reveal pairing QR</button>`}
          </div>
          <p class="mob-help">
            The QR hides itself after 2 minutes. If the phone says <b>Wrong gateway password</b>, tap
            <b>Edit connection</b> there, or scan this code again.
          </p>
        </div>
      </div>
    </section>
  `;
}

export const MOBILE_CONNECT_CARD_CSS = `
.mob-pair-body { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px; align-items: start; margin-top: 14px; }
.mob-pair-qr { width: 232px; aspect-ratio: 1; border-radius: 14px; display: grid; place-items: center; overflow: hidden;
  background: rgba(255,255,255,0.04); border: 1px solid var(--sg-line, rgba(212,175,55,0.25)); }
.mob-pair-qr img { display: block; width: 100%; height: 100%; background: #fff; padding: 8px; box-sizing: border-box; image-rendering: pixelated; }
.mob-pair-veil { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--sg-fg-3, #999); font-size: 12.5px; text-align: center; padding: 16px; }
.mob-pair-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.mob-pair-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.mob-pair-k { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--sg-fg-3, #999); min-width: 64px; }
.mob-pair-v { color: var(--sg-fg-2, #ccc); font-size: 13px; }
.mob-pair code { word-break: break-all; }
@media (max-width: 640px) {
  .mob-pair-body { grid-template-columns: minmax(0, 1fr); justify-items: center; }
  .mob-pair-side { align-items: stretch; width: 100%; }
}
`;
