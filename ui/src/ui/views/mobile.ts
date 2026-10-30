/**
 * /mobile page — install the Android APK this gateway serves (top card),
 * run the InfiniBot dev client against Metro, or build the app via EAS /
 * Gradle. (Expo Go cannot run the app: it uses native modules.)
 *
 * The page is split into two tabs and the explanations are written for
 * a beginner who has never opened a terminal. Every sentence assumes
 * "you'll do this on your phone" or "you'll do this on this computer"
 * and labels each step explicitly.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  ensureSystemGlass,
  sgAurora,
  sgHero,
  sgIcon,
  sgLed,
  type SgStat,
  type SgTone,
} from "./system-glass";
import {
  type MobileState,
  type ExpoMode,
  type MobileTab,
  createInitialMobileState,
  loadMobileConfig,
  saveMobileConfig,
  refreshExpoStatus,
  startExpo,
  stopExpo,
  loadEasWhoami,
  loadEasDevices,
  loadEasBuilds,
  kickEasBuild,
  cancelEasBuild,
  setMobileTab,
  setMobileMode,
  setMobileUrlOverride,
  setMobileAppleTeamId,
  setMobileIosDeviceUdid,
  loadMobileApk,
  downloadMobileApk,
  createMobileApkLink,
  copyMobileApkSha,
  apkLinkOptions,
} from "../controllers/mobile";
import { renderConnectPhoneCard, MOBILE_CONNECT_CARD_CSS } from "./mobile-connect-card";

interface MobileHost {
  mobile?: MobileState;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}

export function ensureMobileState<T extends MobileHost>(state: T): MobileState {
  if (!state.mobile) state.mobile = createInitialMobileState();
  return state.mobile;
}

let _autoLoaded = false;
let _apkAutoLinked = false;

/** The Mobile page's own Expo / Build / Web switch is its host sub-view (?view=). */
type MobileRouteHost = { tab?: string; hostView?: Partial<Record<string, string>>; setHostView?: (view: string) => void };

export function renderMobile<T extends MobileHost>(state: T, client: GatewayBrowserClient) {
  const ms = ensureMobileState(state);
  const route = state as unknown as MobileRouteHost;
  const routed = route.tab === "mobile" && typeof route.setHostView === "function";
  const want = route.hostView?.mobile as MobileTab | undefined;
  if (routed && want && ms.tab !== want) ms.tab = want;
  const selectTab = (tab: MobileTab) =>
    routed ? route.setHostView!(tab) : setMobileTab(state as never, tab);
  if (!_autoLoaded) {
    _autoLoaded = true;
    void loadMobileConfig(state as never, client);
    void refreshExpoStatus(state as never, client);
    void loadEasWhoami(state as never, client);
    void loadEasDevices(state as never, client);
    void loadEasBuilds(state as never, client);
    void loadMobileApk(state as never);
  }
  // First QR as soon as both the manifest and the LAN/Tailscale suggestions are in.
  if (!_apkAutoLinked && ms.apk?.available && ms.suggested && !ms.apkLink && !ms.apkLinkLoading) {
    _apkAutoLinked = true;
    void createMobileApkLink(state as never);
  }

  ensureSystemGlass();
  injectStyles();

  const apk = ms.apk;
  const expo = ms.expo;
  const activeBuilds = ms.builds.filter((b) => b.status === "in-progress" || b.status === "queued" || b.status === "new").length;
  const heroStatus: { tone: SgTone; label: string } = ms.apkError && !apk
    ? { tone: "bad", label: "APK check failed" }
    : !apk
      ? { tone: "off", label: "Checking APK" }
      : apk.available
        ? { tone: "ok", label: `APK v${apk.version ?? "?"} ready` }
        : { tone: "warn", label: "No APK published" };
  const stats: SgStat[] = [
    {
      icon: "android",
      label: "Android APK",
      value: apk?.available ? `v${apk.version ?? "?"}` : apk ? "None" : "—",
      foot: apk?.available ? `${formatBytes(apk.size)} · ${formatDate(apk.buildDate)}` : apk ? "Publish one to install" : "Checking…",
      tone: apk?.available ? "gold" : undefined,
    },
    {
      icon: "play",
      label: "Metro",
      value: expo?.status === "ready" ? "Running" : ms.starting || expo?.status === "starting" ? "Starting" : expo?.status === "error" ? "Error" : "Stopped",
      foot: expo?.status === "ready" ? `${expo.mode} mode` : "Dev client server",
      tone: expo?.status === "ready" ? "ok" : expo?.status === "error" ? "bad" : undefined,
    },
    {
      icon: "user",
      label: "EAS account",
      value: !ms.whoami ? "—" : ms.whoami.loggedIn ? (ms.whoami.username ?? "Signed in") : "Signed out",
      foot: !ms.whoami ? "Checking…" : ms.whoami.loggedIn ? "Cloud builds ready" : "Run eas login",
      tone: ms.whoami?.loggedIn ? "ok" : ms.whoami ? "warn" : undefined,
    },
    {
      icon: "layers",
      label: "Builds",
      value: ms.builds.length,
      foot: activeBuilds ? `${activeBuilds} in progress` : `${ms.devices.length} registered iOS device${ms.devices.length === 1 ? "" : "s"}`,
    },
  ];

  return html`
    <div class="mob-page sg-page sg-mobile">
      ${sgAurora()}
      <div class="mob-header" data-learn-id="mobile-header">
        ${sgHero({
          eyebrow: "Devices",
          title: "Mobile",
          accent: "app",
          icon: "phone",
          sub: "Get InfiniBot on your phone. Install the Android app below, run a development build against Metro, or build and sign the app yourself.",
          status: heroStatus,
          stats,
        })}
      </div>

      <div class="mob-tabs sg-seg" role="tablist" data-learn-id="mobile-tabs">
        <button
          class="mob-tab ${ms.tab === "expo" ? "active" : ""}"
          role="tab"
          aria-selected=${ms.tab === "expo" ? "true" : "false"}
          data-learn-id="mobile-tab-expo"
          @click=${() => selectTab("expo")}
        >${sgIcon("play", 14)} Dev client (Metro)</button>
        <button
          class="mob-tab ${ms.tab === "build" ? "active" : ""}"
          role="tab"
          aria-selected=${ms.tab === "build" ? "true" : "false"}
          data-learn-id="mobile-tab-build"
          @click=${() => selectTab("build")}
        >${sgIcon("layers", 14)} Build the app</button>
        <button
          class="mob-tab ${ms.tab === "web" ? "active" : ""}"
          role="tab"
          aria-selected=${ms.tab === "web" ? "true" : "false"}
          data-learn-id="mobile-tab-web"
          @click=${() => selectTab("web")}
        >${sgIcon("globe", 14)} Web Preview</button>
      </div>

      ${ms.error ? html`<div class="mob-banner mob-banner-error" role="alert">${sgIcon("alert", 16)}<span>${ms.error}</span></div>` : nothing}
      ${ms.success ? html`<div class="mob-banner mob-banner-success" role="status">${sgIcon("check", 16)}<span>${ms.success}</span></div>` : nothing}

      ${renderConnectPhoneCard(state as never)}

      ${renderApkCard(state)}

      ${ms.tab === "expo" ? renderExpoTab(state, client) : ms.tab === "build" ? renderBuildTab(state, client) : renderWebTab()}
    </div>
  `;
}

// ── Copyable command / value blocks ─────────────────────────

function flashCopied(btn: HTMLElement | null) {
  if (!btn) return;
  btn.dataset.copied = "1";
  window.setTimeout(() => { delete btn.dataset.copied; }, 1400);
}

function copyText(text: string, e: Event) {
  const btn = e.currentTarget as HTMLElement | null;
  const done = () => flashCopied(btn);
  try {
    void navigator.clipboard?.writeText(text).then(done, () => {});
  } catch { /* clipboard unavailable */ }
}

function copyBtn(text: string, label = "Copy") {
  return html`<button class="mob-copy" type="button" title="Copy to clipboard" aria-label="${label}"
    @click=${(e: Event) => copyText(text, e)}>${sgIcon("copy", 13)}<span class="mob-copy__ok">${sgIcon("check", 13)}</span></button>`;
}

/** Recessed glass command block with a copy button. */
function codeBlock(cmd: string) {
  return html`<div class="mob-code-wrap"><pre class="mob-code">${cmd}</pre>${copyBtn(cmd, "Copy command")}</div>`;
}

/** Inline command chip with a copy button. */
function cmd(text: string) {
  return html`<span class="mob-cmd"><code>${text}</code>${copyBtn(text, "Copy command")}</span>`;
}

// ── Android APK card ────────────────────────────────────────

const ANDROID_RELEASE: Record<number, string> = {
  21: "5.0", 22: "5.1", 23: "6", 24: "7", 25: "7.1", 26: "8", 27: "8.1", 28: "9",
  29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
};

function formatBytes(n?: number): string {
  if (!n || n < 0) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toWsUrl(origin: string): string {
  return origin.replace(/^http(s?):\/\//i, "ws$1://").replace(/\/$/, "");
}

function renderApkCard<T extends MobileHost>(state: T) {
  const ms = ensureMobileState(state);
  const apk = ms.apk;
  const head = html`
    <div class="mob-apk-head">
      <div class="mob-intro-icon">${sgIcon("android", 22)}</div>
      <div class="mob-apk-title">
        <h3>Android app (APK)</h3>
        <p class="mob-card-sub">Install InfiniBot on an Android phone straight from this gateway. No Play Store needed.</p>
      </div>
      ${apk?.available && apk.version ? html`<span class="sg-chip sg-chip--gold mob-tag mob-apk-ver">v${apk.version}</span>` : nothing}
    </div>
  `;

  if (!apk) {
    return html`
      <section class="sg-panel mob-card mob-apk" data-learn-id="mobile-apk">
        ${head}
        ${ms.apkError
          ? html`<div class="mob-banner mob-banner-error" role="alert">${sgIcon("alert", 16)}<span>Could not load the APK status: ${ms.apkError}</span></div>
              <div class="mob-actions"><button class="sg-btn mob-btn" @click=${() => void loadMobileApk(state as never)}>Retry</button></div>`
          : html`<div class="mob-empty mob-empty-compact">Checking for a published APK…</div>`}
      </section>
    `;
  }

  if (!apk.available) {
    return html`
      <section class="sg-panel mob-card mob-apk" data-learn-id="mobile-apk">
        ${head}
        <div class="mob-apk-empty">
          <p><b>No APK published on this gateway yet.</b> Build one, then publish it:</p>
          ${codeBlock("node scripts/mobile-apk-publish.mjs <path-to.apk>")}
          <p>
            The script reads the version from the APK, copies it into this gateway's state directory and it
            appears here with a download button and a QR code.
          </p>
          <p>
            No APK yet? Build one in Expo's cloud from <code>mobile/</code> with the owner's
            <code>.env.owner</code> loaded:
          </p>
          ${codeBlock("cd mobile && eas build -p android --profile preview")}
          <p class="mob-help">Or build locally with Gradle — see the "Build the app" tab.</p>
        </div>
        <div class="mob-actions">
          <button class="sg-btn mob-btn" ?disabled=${ms.apkLoading} @click=${() => void loadMobileApk(state as never)}>
            ${ms.apkLoading ? "Checking…" : "Check again"}
          </button>
        </div>
      </section>
    `;
  }

  const options = apkLinkOptions(ms);
  const selected = options.find((o) => o.id === ms.apkLinkTarget) ?? options[0];
  const link = ms.apkLink;
  const remainingMs = link ? link.expiresAt - Date.now() : 0;
  const expired = Boolean(link) && remainingMs <= 0;
  const mm = Math.floor(Math.max(0, remainingMs) / 60_000);
  const ss = Math.floor((Math.max(0, remainingMs) % 60_000) / 1000);
  const gatewayWs = selected
    ? toWsUrl(selected.origin)
    : (ms.suggested?.gatewayUrl ?? toWsUrl(location.origin));
  const minAndroid = apk.minSdk ? ANDROID_RELEASE[apk.minSdk] : undefined;

  return html`
    <section class="sg-panel mob-card mob-apk" data-learn-id="mobile-apk">
      ${head}
      ${ms.apkError ? html`<div class="mob-banner mob-banner-error" role="alert">${sgIcon("alert", 16)}<span>${ms.apkError}</span></div>` : nothing}
      <div class="mob-apk-grid">
        <div class="mob-apk-main">
          <dl class="mob-apk-meta">
            <div><dt>Version</dt><dd>${apk.version}${apk.versionCode != null ? html` <span class="mob-apk-dim">(${apk.versionCode})</span>` : nothing}</dd></div>
            <div><dt>Built</dt><dd>${formatDate(apk.buildDate)}</dd></div>
            <div><dt>Size</dt><dd>${formatBytes(apk.size)}</dd></div>
            ${minAndroid ? html`<div><dt>Requires</dt><dd>Android ${minAndroid}+</dd></div>` : nothing}
          </dl>
          <div class="mob-apk-sha">
            <span class="mob-apk-label">SHA-256</span>
            <code class="mob-apk-hash">${apk.sha256}</code>
            <button class="sg-btn sg-btn--sm mob-btn" title="Copy SHA-256" @click=${() => void copyMobileApkSha(state as never)}>
              ${sgIcon("copy", 14)} ${ms.apkCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <div class="mob-actions">
            <button class="sg-btn sg-btn--primary mob-btn" ?disabled=${ms.apkDownloading} @click=${() => void downloadMobileApk(state as never)}>
              ${sgIcon("download", 15)} ${ms.apkDownloading ? "Starting download…" : `Download APK (${formatBytes(apk.size)})`}
            </button>
            <button class="sg-btn mob-btn" ?disabled=${ms.apkLoading} @click=${() => void loadMobileApk(state as never)}>
              ${ms.apkLoading ? "Checking…" : "Check for update"}
            </button>
          </div>
          <h4 class="mob-apk-steps-title">Install on your phone</h4>
          <ol class="mob-steps mob-apk-steps">
            <li>Scan the QR code with your phone (or download here and copy the file over). The APK downloads in your browser.</li>
            <li>
              When Android asks, allow <b>Install unknown apps</b> for that browser
              (<i>Settings → Apps → Special app access → Install unknown apps</i>).
            </li>
            <li>Open the downloaded <code>${apk.file}</code> and tap <b>Install</b>.</li>
            <li>
              Open InfiniBot and choose <b>Self-hosted gateway</b>: enter
              <span class="mob-cmd"><code class="mob-apk-url">${gatewayWs}</code>${copyBtn(gatewayWs, "Copy gateway URL")}</span> and this gateway's password.
              Or choose <b>InfiniBot Cloud</b> and sign in.
            </li>
          </ol>
        </div>

        <div class="mob-apk-qrcol">
          <div class="mob-apk-qr-head">
            <h4>Download on your phone</h4>
            ${options.length > 1
              ? html`
                  <div class="sg-seg mob-seg" role="group" aria-label="Address the phone uses">
                    ${options.map((o) => html`
                      <button
                        class="mob-seg-btn ${selected?.id === o.id ? "active" : ""}"
                        ?disabled=${ms.apkLinkLoading}
                        @click=${() => void createMobileApkLink(state as never, o.id)}
                      >${o.label}</button>
                    `)}
                  </div>
                `
              : nothing}
          </div>
          <div class="mob-apk-qr ${expired ? "is-expired" : ""}">
            ${link?.qrSvg
              ? html`<img alt="QR code: signed APK download link" src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(link.qrSvg)}`} />`
              : html`<div class="mob-apk-qr-empty">${ms.apkLinkLoading ? "Creating link…" : ms.apkLinkError ? "No link" : "—"}</div>`}
          </div>
          ${ms.apkLinkError ? html`<p class="mob-help mob-apk-err">${ms.apkLinkError}</p>` : nothing}
          ${link
            ? html`
                <p class="mob-help mob-apk-origin">${selected ? html`Phone must reach <code>${selected.origin}</code>` : nothing}</p>
                <p class="mob-help ${expired ? "mob-apk-err" : ""}">
                  ${expired
                    ? "Link expired — create a new one."
                    : `Link expires in ${mm}:${String(ss).padStart(2, "0")} · single APK, no password needed`}
                </p>
              `
            : nothing}
          <div class="mob-actions mob-apk-qr-actions">
            <button class="sg-btn sg-btn--sm mob-btn" ?disabled=${ms.apkLinkLoading} @click=${() => void createMobileApkLink(state as never)}>
              ${ms.apkLinkLoading ? "Creating…" : "New link"}
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

// ── Expo Go tab ─────────────────────────────────────────────

function renderExpoTab<T extends MobileHost>(state: T, client: GatewayBrowserClient) {
  const ms = ensureMobileState(state);
  const expo = ms.expo;
  const ready = expo?.status === "ready" && expo.url;
  const starting = ms.starting || expo?.status === "starting";

  return html`
    <section class="mob-tab-body">
      ${renderExpoIntro()}

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">1</span>
          <div>
            <h3>Pick a connection mode</h3>
            <p class="mob-card-sub">Tunnel works anywhere. LAN is faster but only on the same Wi-Fi. Tailscale works over your tailnet.</p>
          </div>
        </div>
        <div class="mob-mode-row" data-learn-id="mobile-connection-mode">
          ${(["tunnel", "lan", "localhost", "tailscale"] as ExpoMode[]).map((m) => html`
            <button
              class="mob-mode ${ms.mode === m ? "active" : ""}"
              @click=${() => setMobileMode(state as never, m)}
              ?disabled=${starting || ready}
            >
              <span class="mob-mode-name">${m === "tunnel" ? "Tunnel" : m === "lan" ? "LAN" : m === "localhost" ? "Localhost" : "Tailscale"}</span>
              <span class="mob-mode-desc">${
                m === "tunnel"
                  ? "Works across networks. Slower."
                  : m === "lan"
                    ? "Same Wi-Fi only. Fast."
                    : m === "localhost"
                      ? "Same machine only. Simulator/web."
                      : "Same tailnet. Tailscale IP."
              }</span>
            </button>
          `)}
        </div>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">2</span>
          <div>
            <h3>Gateway URL the phone will connect to</h3>
            <p class="mob-card-sub">
              Pre-filled from your active WebSocket bind. If your phone is on a different network, paste a public URL (Cloudflare Tunnel, Tailscale Serve, etc.).
            </p>
          </div>
        </div>
        <div class="mob-field" data-learn-id="mobile-gateway-url">
          <input
            class="sg-input"
            type="text"
            placeholder=${ms.suggested?.gatewayUrl ?? "ws://192.168.1.x:18789"}
            .value=${ms.gatewayUrlOverride}
            @input=${(e: Event) => setMobileUrlOverride(state as never, (e.target as HTMLInputElement).value)}
            ?disabled=${starting || ready}
          />
          <button
            class="sg-btn mob-btn"
            @click=${() => void saveMobileConfig(state as never, client, { gatewayUrlOverride: ms.gatewayUrlOverride.trim() || undefined })}
            ?disabled=${starting || ready}
          >Save default</button>
        </div>
        <p class="mob-help">
          Detected LAN: <code>${ms.suggested?.lanAddress ?? "(none)"}</code>
          ${ms.suggested?.tailnetHostname
            ? html` &middot; Tailscale: <code>${ms.suggested.tailnetHostname}</code>`
            : ms.suggested?.tailscaleAddress
              ? html` &middot; Tailscale IP: <code>${ms.suggested.tailscaleAddress}</code>`
              : nothing}
        </p>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">3</span>
          <div>
            <h3>Start Metro and scan the QR</h3>
            <p class="mob-card-sub">
              Open the <b>InfiniBot dev client</b> on your phone and scan the QR from its launcher (on iOS the
              camera works too). Expo Go from the stores will not load this app.
            </p>
          </div>
        </div>

        ${!ready
          ? html`
              <div class="mob-actions" data-learn-id="mobile-start-metro">
                <button
                  class="sg-btn sg-btn--primary mob-btn"
                  ?disabled=${starting}
                  @click=${() => void startExpo(state as never, client)}
                >
                  ${starting ? "Starting Metro…" : "Start Expo dev server"}
                </button>
                ${expo?.status === "error"
                  ? html`<span class="sg-chip sg-chip--bad mob-tag">${expo.error ?? "error"}</span>`
                  : expo?.status === "starting"
                    ? html`<span class="sg-chip mob-tag">starting…</span>`
                    : nothing}
              </div>
            `
          : html`
              <div class="mob-qr-grid">
                ${renderQr(expo!.url!)}
                <div class="mob-qr-side">
                  <p class="mob-help"><b>URL:</b> <span class="mob-cmd"><code>${expo!.url}</code>${copyBtn(expo!.url!, "Copy Metro URL")}</span></p>
                  ${expo!.devUrl ? html`<p class="mob-help"><b>Dev tools:</b> <a href="${expo!.devUrl}" target="_blank" rel="noreferrer">${expo!.devUrl}</a></p>` : nothing}
                  <p class="mob-help"><b>Mode:</b> ${expo!.mode}</p>
                  <p class="mob-help"><b>Project dir:</b> <code>${expo!.projectDir}</code></p>
                  <div class="mob-actions">
                    <button class="sg-btn sg-btn--danger mob-btn" @click=${() => void stopExpo(state as never, client)} ?disabled=${ms.stopping}>
                      ${ms.stopping ? "Stopping…" : "Stop"}
                    </button>
                    <button class="sg-btn mob-btn" @click=${() => void refreshExpoStatus(state as never, client)}>
                      Refresh
                    </button>
                  </div>
                </div>
              </div>
            `}

        ${expo?.notice
          ? html`<p class="mob-help" role="status" data-testid="expo-notice"><span class="sg-chip sg-chip--bad mob-tag">Expo login</span> ${expo.notice}</p>`
          : nothing}

        ${expo && expo.log.length > 0
          ? html`
              <details class="mob-log">
                <summary>Metro log (last ${expo.log.length} lines)</summary>
                <pre>${expo.log.slice(-30).join("\n")}</pre>
              </details>
            `
          : nothing}
      </div>

      ${renderExpoLimits()}
    </section>
  `;
}

function renderExpoIntro() {
  return html`
    <div class="mob-intro sg-enter">
      <div class="mob-intro-icon">${sgIcon("bolt", 22)}</div>
      <div>
        <h3>Dev client + Metro</h3>
        <p>
          The InfiniBot app uses native modules (LiveKit voice, WebRTC, <code>expo-dev-client</code>), so it
          cannot run inside Expo Go. Install the InfiniBot <b>development build</b> once
          (<code>eas build -p android --profile development</code>, or a local Gradle debug build). Metro,
          started here, then serves the JavaScript to it so code changes reload live on your phone.
        </p>
        <p class="mob-intro-when">
          <b>Use this when:</b> you are working on the mobile app itself. For everyday use, install the
          Android APK above instead.
        </p>
      </div>
    </div>
  `;
}

function renderExpoLimits() {
  return html`
    <div class="sg-panel mob-card mob-card-soft">
      <h4>Before you scan</h4>
      <ul class="mob-list">
        <li>The phone needs the InfiniBot <b>development build</b> installed. Expo Go and the regular APK cannot load Metro bundles.</li>
        <li>The phone must reach both Metro and the gateway (Tunnel for cellular, LAN for the same Wi-Fi, Tailscale over your tailnet).</li>
        <li>JavaScript reloads live; changes to native modules or <code>app.json</code> need a new development build.</li>
        <li>Stopping Metro here leaves the dev client with nothing to load — use the APK for a standalone app.</li>
      </ul>
      <p class="mob-help">Need a signed standalone app? See "Build the app" — Android APK via Gradle or EAS, iOS IPA via EAS.</p>
    </div>
  `;
}

// ── Build (EAS) tab ─────────────────────────────────────────

function renderBuildTab<T extends MobileHost>(state: T, client: GatewayBrowserClient) {
  const ms = ensureMobileState(state);

  return html`
    <section class="mob-tab-body">
      <div class="mob-intro sg-enter" data-learn-id="mobile-build-intro">
        <div class="mob-intro-icon">${sgIcon("bolt", 22)}</div>
        <div>
          <h3>Build the app yourself</h3>
          <p>
            <b>Android APK:</b> build locally with Gradle
            or in Expo's cloud with EAS, then publish the APK so it shows up in the Android card above:
          </p>
          ${codeBlock("cd mobile && npx expo prebuild -p android && cd android && ./gradlew assembleRelease")}
          ${codeBlock("eas build -p android --profile preview")}
          ${codeBlock("node scripts/mobile-apk-publish.mjs <file.apk>")}
          <p>
            <b>iOS IPA:</b> EAS Build signs an IPA with your Apple credentials and sends a download link in
            ~15-25 minutes. It installs like any TestFlight build.
          </p>
          <p class="mob-intro-when">
            <b>Use this when:</b> you want push notifications, the InfiniBot icon on your home screen, or to
            hand a build to someone else.
          </p>
        </div>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">1</span>
          <div>
            <h3>One-time EAS setup (do this once, then never again)</h3>
            <p class="mob-card-sub">Each step is one terminal command on this computer. Android-only builds skip the Apple step.</p>
          </div>
        </div>
        <ol class="mob-steps">
          <li>
            <b>Sign up for an Apple Developer account</b> at
            <a href="https://developer.apple.com/programs/" target="_blank" rel="noreferrer">developer.apple.com/programs</a>.
            $99/year. Apple takes 24-48 hours to approve. There is no way around this if you want to install on your own iPhone.
          </li>
          <li>
            <b>Sign up for Expo</b> at <a href="https://expo.dev" target="_blank" rel="noreferrer">expo.dev</a> (free).
          </li>
          <li>
            <b>Install the EAS CLI</b>: open a terminal on this computer and run ${cmd("npm install -g eas-cli")}.
          </li>
          <li>
            <b>Log in</b>: ${cmd("eas login")} — paste your Expo credentials when prompted.
          </li>
          <li>
            <b>Set up signing credentials</b>: ${cmd("eas credentials")} — pick "iOS", "Use existing or create new",
            and follow the prompts. EAS will auto-fetch certificates and provisioning profiles using your Apple ID.
          </li>
        </ol>
        <div class="mob-status-row">
          <span class="mob-help">Login status:</span>
          ${renderWhoamiBadge(state)}
          <button class="sg-btn mob-btn" @click=${() => void loadEasWhoami(state as never, client)}>Re-check</button>
        </div>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">2</span>
          <div>
            <h3>Choose the iPhone or iPad for IPA installs</h3>
            <p class="mob-card-sub">
              Internal iOS builds are signed for specific Apple device UDIDs. Pick a registered device here and the build refreshes the ad hoc profile automatically.
            </p>
          </div>
        </div>
        <div class="mob-field mob-field-wrap">
          <input
            class="sg-input"
            type="text"
            placeholder="Apple Team ID (optional)"
            .value=${ms.appleTeamId}
            @input=${(e: Event) => setMobileAppleTeamId(state as never, (e.target as HTMLInputElement).value)}
          />
          <button
            class="sg-btn mob-btn"
            @click=${() => void saveMobileConfig(state as never, client, { appleTeamId: ms.appleTeamId.trim() || undefined })}
          >Save team</button>
        </div>
        <div class="mob-field mob-field-wrap mob-field-top">
          <input
            class="sg-input"
            type="text"
            placeholder="Paste iPhone/iPad UDID"
            .value=${ms.iosDeviceUdid}
            @input=${(e: Event) => setMobileIosDeviceUdid(state as never, (e.target as HTMLInputElement).value)}
          />
          <button
            class="sg-btn sg-btn--primary mob-btn"
            @click=${() => void saveMobileConfig(state as never, client, {
              appleTeamId: ms.appleTeamId.trim() || undefined,
              iosDeviceUdid: ms.iosDeviceUdid.trim() || undefined,
            })}
          >Save device</button>
          <button class="sg-btn mob-btn" @click=${() => void loadEasDevices(state as never, client)} ?disabled=${ms.devicesLoading}>
            ${ms.devicesLoading ? "Refreshing..." : "Refresh devices"}
          </button>
        </div>
        ${renderEasDevices(state)}
        <p class="mob-help">
          Need the UDID? Run ${cmd("eas device:create")} on this computer and follow Expo's device registration link, then come back and refresh.
        </p>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">3</span>
          <div>
            <h3>Kick a build</h3>
            <p class="mob-card-sub">
              "Preview" is the recommended profile — installable IPA, no App Store review.
              "Production" is what you'd ship to TestFlight / the App Store.
            </p>
          </div>
        </div>
        <div class="mob-actions">
          <button
            class="sg-btn sg-btn--primary mob-btn"
            ?disabled=${ms.buildKicking || ms.whoami?.loggedIn === false}
            @click=${() => void kickEasBuild(state as never, client, { profile: "preview", platform: "ios" })}
          >
            ${ms.buildKicking ? "Queueing…" : "Build iOS Preview"}
          </button>
          <button
            class="sg-btn mob-btn"
            ?disabled=${ms.buildKicking || ms.whoami?.loggedIn === false}
            @click=${() => void kickEasBuild(state as never, client, { profile: "production", platform: "ios" })}
          >
            Build iOS Production
          </button>
          <button
            class="sg-btn mob-btn"
            ?disabled=${ms.buildKicking || ms.whoami?.loggedIn === false}
            @click=${() => void kickEasBuild(state as never, client, { profile: "preview", platform: "android" })}
          >
            Build Android APK (preview)
          </button>
        </div>
      </div>

      <div class="sg-panel mob-card">
        <div class="mob-card-head">
          <span class="mob-card-num">4</span>
          <div>
            <h3>Recent builds</h3>
            <p class="mob-card-sub">A finished build's "Download" link installs on the phone (Safari for iOS, the browser for Android APKs).</p>
          </div>
        </div>
        ${ms.builds.length === 0
          ? html`<div class="mob-empty">No builds yet — kick one above.</div>`
          : html`
              <div class="mob-table-wrap"><table class="sg-table mob-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Platform</th>
                    <th>Profile</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${ms.builds.map((b) => html`
                    <tr>
                      <td>${b.startedAt ? new Date(b.startedAt).toLocaleString() : "—"}</td>
                      <td>${b.platform}</td>
                      <td>${b.profile}</td>
                      <td>${buildChip(b.status)}</td>
                      <td>
                        ${b.artifactUrl
                          ? html`<a href="${b.artifactUrl}" target="_blank" rel="noreferrer">Download</a>`
                          : b.buildUrl
                            ? html`<a href="${b.buildUrl}" target="_blank" rel="noreferrer">Track on expo.dev</a>`
                            : nothing}
                        ${b.status === "in-progress" || b.status === "queued"
                          ? html`<button class="mob-btn-link" @click=${() => void cancelEasBuild(state as never, client, b.id)}>cancel</button>`
                          : nothing}
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table></div>
            `}
        <div class="mob-actions">
          <button class="sg-btn mob-btn" @click=${() => void loadEasBuilds(state as never, client)}>Refresh</button>
        </div>
      </div>

      <div class="sg-panel mob-card mob-card-soft">
        <h4>Installing the IPA on your iPhone</h4>
        <ol class="mob-list">
          <li>When the build finishes, EAS sends an email with a QR code. Scan that QR code on your iPhone.</li>
          <li>Safari opens a page with an "Install" button. Tap it.</li>
          <li>If Apple says "Untrusted Developer", open <i>Settings → General → VPN &amp; Device Management</i>,
            tap your developer profile, tap "Trust".</li>
          <li>The InfiniBot icon appears on your home screen. Open it and choose <b>Self-hosted gateway</b>
            (enter this gateway's URL and password) or <b>InfiniBot Cloud</b> (sign in).</li>
        </ol>
      </div>
    </section>
  `;
}

function renderEasDevices<T extends MobileHost>(state: T) {
  const ms = ensureMobileState(state);
  if (ms.devices.length === 0) {
    return html`<div class="mob-empty mob-empty-compact">No registered EAS devices found yet.</div>`;
  }
  return html`
    <div class="mob-device-list">
      ${ms.devices.map((d) => {
        const active = ms.iosDeviceUdid.trim().toUpperCase() === d.udid.toUpperCase();
        return html`
          <button
            class="mob-device ${active ? "active" : ""}"
            @click=${() => setMobileIosDeviceUdid(state as never, d.udid)}
          >
            <span class="mob-device-name">${d.name || "Unnamed device"}</span>
            <span class="mob-device-id">${d.udid}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function buildChip(status: string) {
  const tone = status === "finished" ? "ok" : status === "errored" ? "bad" : status === "in-progress" || status === "queued" || status === "new" ? "gold" : "";
  const led: SgTone = tone === "" ? "off" : (tone as SgTone);
  return html`<span class="sg-chip ${tone ? `sg-chip--${tone}` : ""} mob-status mob-status-${status}">${sgLed(led)}${status}</span>`;
}

function renderWhoamiBadge<T extends MobileHost>(state: T) {
  const ms = ensureMobileState(state);
  if (!ms.whoami) return html`<span class="sg-chip mob-tag">${sgLed("off")}checking…</span>`;
  if (ms.whoami.loggedIn) return html`<span class="sg-chip sg-chip--ok mob-tag">${sgLed("ok")}logged in as ${ms.whoami.username ?? "unknown"}</span>`;
  return html`<span class="sg-chip sg-chip--bad mob-tag">${sgLed("bad")}not logged in — run <code>eas login</code></span>`;
}

// ── Web Preview tab ─────────────────────────────────────────
// Default to the bundled static export served by the gateway at
// `/mobile-web/` (built via `pnpm mobile:web:build`). Fall back to a
// running Metro dev server on :8081 for hot-reload during development.
const EXPO_WEB_BUNDLED_URL = "/mobile-web/";
const EXPO_WEB_DEV_URL = "http://localhost:8081";

function resolveMobileWebSrc(): string {
  // The bundled export is same-origin, so loading it as a relative URL
  // works whether the operator is on the local gateway, a tailnet
  // tailscale-serve URL, or a satellite-mirroring-master setup.
  return EXPO_WEB_BUNDLED_URL;
}

function renderWebTab() {
  const src = resolveMobileWebSrc();
  return html`
    <section class="mob-tab-body">
      <div class="mob-intro sg-enter">
        <div class="mob-intro-icon">${sgIcon("phone", 22)}</div>
        <div>
          <h3>Web Preview</h3>
          <p>
            Embeds the bundled <code>mobile/</code> Expo web build shipped with this
            install. For live reload during development, run
            <code>npm run web</code> inside <code>mobile/</code> and switch the
            iframe to <code>${EXPO_WEB_DEV_URL}</code>.
          </p>
          <p class="mob-intro-when">
            <b>Bundled:</b> <a href="${src}" target="_blank" rel="noreferrer">${src}</a>
            &nbsp;·&nbsp;
            <b>Dev:</b> <a href="${EXPO_WEB_DEV_URL}" target="_blank" rel="noreferrer">${EXPO_WEB_DEV_URL}</a>
          </p>
        </div>
      </div>
      <div class="mob-web-frame-wrap" data-learn-id="mobile-web-preview">
        <iframe
          src="${src}"
          class="mob-web-frame"
          title="InfiniBot mobile web preview"
          allow="camera; microphone; clipboard-read; clipboard-write"
        ></iframe>
      </div>
    </section>
  `;
}

// ── QR rendering ────────────────────────────────────────────

function renderQr(data: string) {
  // Use a small public QR image generator. The encoded value is a
  // local exp:// URL — non-sensitive (no token included). For the
  // tunnel mode the URL is auto-generated by Expo and rotates per
  // session; for LAN it's just a private IP. We deliberately skip
  // bundling a JS QR library to keep the dashboard payload small.
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&qzone=2&data=${encodeURIComponent(data)}`;
  return html`
    <div class="mob-qr-wrap">
      <img src=${src} alt="Expo Go QR — ${data}" width="320" height="320" />
      <p class="mob-help">Scan with the camera (iOS) or Expo Go's "Scan QR code" button (Android).</p>
    </div>
  `;
}


// ── Styles ──────────────────────────────────────────────────
// Page layer on top of the system-glass kit (ensureSystemGlass).

const MOBILE_STYLE_ID = "mob-glass-styles";
function injectStyles() {
  if (typeof document === "undefined" || document.getElementById(MOBILE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = MOBILE_STYLE_ID;
  style.textContent = MOBILE_CSS + MOBILE_CONNECT_CARD_CSS;
  document.head.appendChild(style);
}

const MOBILE_CSS = `
.sg-mobile { padding: clamp(14px, 2vw, 24px); max-width: 1180px; }
.mob-header { display: block; min-width: 0; }
.mob-tabs { align-self: flex-start; }
.mob-tab svg { flex: none; }

/* Banners → glass callouts */
.mob-banner {
  --tone: var(--sg-gold);
  position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px 11px 16px;
  border-radius: var(--sg-radius-sm); font-size: 13px; line-height: 1.5; color: var(--sg-fg);
  background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 13%, transparent), transparent 75%), var(--glass-3);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent), var(--glass-specular, none);
}
.mob-banner::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 3px; background: var(--tone); box-shadow: 0 0 10px var(--tone); }
.mob-banner > svg { flex: none; margin-top: 2px; color: var(--tone); }
.mob-banner > span { min-width: 0; overflow-wrap: anywhere; }
.mob-banner-error { --tone: var(--sg-bad); }
.mob-banner-success { --tone: var(--sg-ok); }

.mob-tab-body { display: flex; flex-direction: column; gap: 18px; }

/* Intro callout */
.mob-intro {
  position: relative; display: flex; gap: 16px; padding: 20px; border-radius: var(--sg-radius);
  background: radial-gradient(120% 160% at 0% 0%, var(--glass-gold-a10), transparent 55%), var(--glass-3);
  box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-specular, none), var(--glass-elev-1, none);
}
.mob-intro-icon { flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; color: var(--sg-gold); background: var(--glass-gold-tint, var(--glass-gold-a10)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24), var(--glass-glow-soft, none); }
.mob-intro > div:last-child { min-width: 0; flex: 1; }
.mob-intro h3 { margin: 0 0 6px; color: var(--sg-fg); font-size: 16px; font-weight: 640; letter-spacing: -0.012em; }
.mob-intro p { margin: 0 0 10px; color: var(--sg-fg-2); font-size: 13.5px; line-height: 1.6; }
.mob-intro p:last-child { margin-bottom: 0; }
.mob-intro-when { color: var(--sg-fg) !important; }
.mob-intro a, .mob-steps a, .mob-qr-side a { color: var(--sg-gold); text-decoration: none; }
.mob-intro a:hover, .mob-steps a:hover, .mob-qr-side a:hover { text-decoration: underline; }

/* Cards (sg-panel) */
.mob-card { display: block; }
.mob-card-soft { background: var(--glass-sheen, none), var(--glass-1, var(--glass-2)); }
.mob-card-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 16px; }
.mob-card-head > div { min-width: 0; }
.mob-card-num {
  flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 13px;
  background: linear-gradient(160deg, var(--glass-gold-a16), var(--glass-gold-a06));
  box-shadow: inset 0 0 0 1px var(--glass-gold-a24), inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 8px 20px -10px var(--glass-gold-a40);
  font: 700 20px/1 var(--font-ui-display, var(--glass-font, system-ui)); letter-spacing: -0.04em; font-variant-numeric: tabular-nums;
  color: var(--sg-gold);
}
.mob-card-head h3, .mob-apk-title h3 { margin: 0 0 4px; color: var(--sg-fg); font-size: 15.5px; font-weight: 640; letter-spacing: -0.012em; }
.mob-card-sub { margin: 0; font-size: 12.5px; color: var(--sg-fg-2); line-height: 1.5; }
.mob-card h4 { margin: 0 0 10px; color: var(--sg-fg); font-size: 14px; font-weight: 640; }

/* Connection mode tiles */
.mob-mode-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.mob-mode {
  display: flex; flex-direction: column; gap: 4px; padding: 13px 14px; text-align: left; border: 0; border-radius: var(--sg-radius-sm); cursor: pointer;
  color: var(--sg-fg); font: inherit; background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke);
  transition: box-shadow var(--sg-dur) var(--sg-ease), background var(--sg-dur) var(--sg-ease), transform var(--glass-dur-fast, 140ms) var(--sg-ease);
}
.mob-mode:hover:not(:disabled) { box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); background: var(--glass-gold-a06); }
.mob-mode:active:not(:disabled) { transform: scale(0.985); }
.mob-mode:disabled { cursor: not-allowed; opacity: 0.6; }
.mob-mode.active { background: linear-gradient(180deg, var(--glass-gold-a16), var(--glass-gold-a06)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 8px 22px -12px var(--glass-gold-a40); opacity: 1; }
.mob-mode-name { font-weight: 640; font-size: 13.5px; }
.mob-mode.active .mob-mode-name { color: var(--sg-gold); }
.mob-mode-desc { font-size: 11.5px; color: var(--sg-fg-3); }

/* Fields */
.mob-field { display: flex; gap: 8px; align-items: center; }
.mob-field-wrap { flex-wrap: wrap; }
.mob-field-top { margin-top: 10px; }
.mob-field .sg-input { flex: 1 1 240px; min-width: 0; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12.5px; }
.mob-help { font-size: 12px; color: var(--sg-fg-3); margin: 8px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.mob-help b { color: var(--sg-fg-2); }
.mob-help code, .mob-steps code, .mob-list code, .mob-intro code, .mob-apk-empty code {
  padding: 1px 6px; border-radius: 6px; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 0.9em; color: var(--sg-fg);
  background: color-mix(in srgb, var(--glass-base, #07070a) 40%, transparent); box-shadow: inset 0 0 0 1px var(--glass-stroke);
  overflow-wrap: anywhere;
}
:root[data-theme="light"] .mob-help code, :root[data-theme="light"] .mob-steps code, :root[data-theme="light"] .mob-list code,
:root[data-theme="light"] .mob-intro code, :root[data-theme="light"] .mob-apk-empty code { background: rgba(255, 255, 255, 0.65); }
.mob-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.mob-btn svg { flex: none; }
.mob-btn-link { background: none; border: none; color: var(--sg-gold); cursor: pointer; font: inherit; font-size: 12px; padding: 0 6px; }
.mob-btn-link:hover { text-decoration: underline; }
.mob-tag code { background: none; box-shadow: none; padding: 0; }

/* Recessed command blocks + copy */
.mob-code-wrap { position: relative; margin: 0 0 10px; }
.mob-code {
  margin: 0; padding: 11px 46px 11px 14px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12.5px; line-height: 1.5; color: var(--sg-fg);
  background: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
  box-shadow: inset 0 0 0 1px var(--glass-stroke), inset 0 2px 6px rgba(0, 0, 0, 0.28);
}
:root[data-theme="light"] .mob-code { background: rgba(255, 255, 255, 0.7); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong), inset 0 1px 3px rgba(60, 45, 20, 0.08); }
.mob-code::before { content: "$ "; color: var(--sg-gold); opacity: 0.8; }
.mob-copy {
  position: relative; display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; cursor: pointer;
  color: var(--sg-fg-3); background: var(--glass-3); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
  transition: color var(--sg-dur) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease);
}
.mob-copy:hover { color: var(--sg-gold); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none); }
.mob-copy__ok { position: absolute; inset: 0; display: grid; place-items: center; border-radius: inherit; color: var(--sg-ok); background: var(--glass-3); opacity: 0; transition: opacity var(--sg-dur) var(--sg-ease); }
.mob-copy[data-copied] .mob-copy__ok { opacity: 1; }
.mob-code-wrap > .mob-copy { position: absolute; top: 7px; right: 7px; }
.mob-cmd { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; vertical-align: middle; }
.mob-cmd code { min-width: 0; }
.mob-cmd .mob-copy { width: 24px; height: 24px; border-radius: 7px; }

/* Expo QR */
.mob-qr-grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 20px; align-items: start; }
.mob-qr-wrap, .mob-apk-qr {
  padding: 12px; border-radius: 18px;
  background: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
  box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), inset 0 2px 10px rgba(0, 0, 0, 0.3), var(--glass-glow-soft, none);
}
:root[data-theme="light"] .mob-qr-wrap, :root[data-theme="light"] .mob-apk-qr { background: rgba(255, 255, 255, 0.6); }
.mob-qr-wrap img { display: block; width: min(280px, 100%); height: auto; aspect-ratio: 1; border-radius: 10px; background: #fff; padding: 6px; }
.mob-qr-wrap .mob-help { max-width: 280px; text-align: center; }
.mob-qr-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mob-log { margin-top: 14px; }
.mob-log summary { cursor: pointer; font-size: 12px; color: var(--sg-fg-3); }
.mob-log summary:hover { color: var(--sg-gold); }
.mob-log pre { margin: 8px 0 0; padding: 12px; border-radius: 12px; font: 11px/1.5 var(--glass-font-mono, ui-monospace, monospace); color: var(--sg-fg-2); max-height: 260px; overflow: auto; background: color-mix(in srgb, var(--glass-base, #07070a) 60%, transparent); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
:root[data-theme="light"] .mob-log pre { background: rgba(255, 255, 255, 0.7); }

/* Lists */
.mob-list { margin: 6px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: var(--sg-fg-2); }
.mob-list li { margin-bottom: 6px; }
.mob-list li::marker, .mob-steps li::marker { color: var(--sg-gold); font-weight: 700; }
.mob-steps { margin: 0; padding-left: 22px; font-size: 13px; line-height: 1.65; color: var(--sg-fg-2); }
.mob-steps li { margin-bottom: 9px; padding-left: 4px; }
.mob-steps b, .mob-list b { color: var(--sg-fg); }
.mob-status-row { display: flex; gap: 10px; align-items: center; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--glass-stroke); flex-wrap: wrap; }
.mob-status-row .mob-help { margin: 0; }

/* Builds table */
.mob-table-wrap { overflow-x: auto; margin-bottom: 10px; }
.mob-table a { color: var(--sg-gold); text-decoration: none; }
.mob-table a:hover { text-decoration: underline; }
.mob-status { text-transform: capitalize; }

/* Empty + devices */
.mob-empty { display: grid; justify-items: center; gap: 8px; padding: 26px 16px; text-align: center; color: var(--sg-fg-3); font-size: 13px; border-radius: var(--sg-radius-sm); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); margin-bottom: 10px; }
.mob-empty-compact { display: block; padding: 11px 14px; text-align: left; margin: 10px 0 0; }
.mob-device-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 12px; }
.mob-device { display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 11px 13px; border: 0; border-radius: var(--sg-radius-sm); color: var(--sg-fg); font: inherit; cursor: pointer; background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); transition: box-shadow var(--sg-dur) var(--sg-ease), background var(--sg-dur) var(--sg-ease); }
.mob-device:hover { box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.mob-device.active { background: linear-gradient(180deg, var(--glass-gold-a16), var(--glass-gold-a06)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold); }
.mob-device-name { font-size: 12.5px; font-weight: 640; }
.mob-device-id { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--sg-fg-3); overflow-wrap: anywhere; }

/* APK card */
.mob-apk { display: flex; flex-direction: column; gap: 16px; }
.mob-apk-head { display: flex; gap: 14px; align-items: flex-start; }
.mob-apk-title { flex: 1; min-width: 0; }
.mob-apk-ver { flex: none; font-family: var(--glass-font-mono, ui-monospace, monospace); }
.mob-apk-grid { display: grid; grid-template-columns: minmax(0, 1fr) 272px; gap: 22px; align-items: start; }
.mob-apk-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.mob-apk-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 0; }
.mob-apk-meta > div { padding: 10px 12px; border-radius: var(--sg-radius-sm); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); min-width: 0; }
.mob-apk-meta dt, .mob-apk-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--sg-fg-3); font-weight: 700; }
.mob-apk-meta dd { margin: 4px 0 0; font-size: 13.5px; font-weight: 640; color: var(--sg-fg); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.mob-apk-dim { color: var(--sg-fg-3); font-weight: 400; }
.mob-apk-sha { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 10px 9px 14px; border-radius: 12px; background: color-mix(in srgb, var(--glass-base, #07070a) 50%, transparent); box-shadow: inset 0 0 0 1px var(--glass-stroke), inset 0 2px 6px rgba(0, 0, 0, 0.25); }
:root[data-theme="light"] .mob-apk-sha { background: rgba(255, 255, 255, 0.65); }
.mob-apk-hash { flex: 1 1 220px; min-width: 0; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 11.5px; color: var(--sg-fg-2); word-break: break-all; user-select: all; }
.mob-apk-steps-title { margin: 6px 0 0 !important; }
.mob-apk-url { overflow-wrap: anywhere; }
.mob-apk-qrcol { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.mob-apk-qr-head { display: flex; flex-direction: column; gap: 8px; }
.mob-apk-qr-head h4 { margin: 0 !important; }
.mob-seg { align-self: flex-start; }
.mob-seg-btn:disabled { cursor: progress; }
.mob-apk-qr { width: 100%; max-width: 272px; aspect-ratio: 1; display: grid; place-items: center; }
.mob-apk-qr img { display: block; width: 100%; height: 100%; border-radius: 10px; background: #fff; padding: 8px; image-rendering: pixelated; }
.mob-apk-qr.is-expired img { opacity: 0.18; filter: blur(2px); }
.mob-apk-qr-empty { color: var(--sg-fg-3); font-size: 12.5px; }
.mob-apk-origin code { overflow-wrap: anywhere; }
.mob-apk-err { color: var(--sg-bad) !important; }
.mob-apk-empty p { margin: 0 0 10px; font-size: 13px; line-height: 1.6; color: var(--sg-fg-2); }
.mob-apk-empty p b { color: var(--sg-fg); }

/* Web preview */
.mob-web-frame-wrap { position: relative; border-radius: var(--sg-radius); overflow: hidden; background: #fff; height: calc(100vh - 260px); min-height: 480px; box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-elev-2, none); }
.mob-web-frame { width: 100%; height: 100%; border: none; display: block; }

@media (max-width: 1000px) {
  .mob-mode-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .mob-apk-grid { grid-template-columns: minmax(0, 1fr); }
  .mob-apk-qrcol { align-items: center; text-align: center; }
  .mob-apk-qr-head { align-items: center; }
  .mob-seg { align-self: center; }
  .mob-qr-grid { grid-template-columns: minmax(0, 1fr); justify-items: center; }
}
@media (max-width: 520px) {
  .sg-mobile { padding: 12px; }
  .mob-tabs { display: flex; flex-wrap: wrap; width: 100%; }
  .mob-tabs > .mob-tab { flex: 1 1 auto; justify-content: center; }
  .mob-intro { flex-direction: column; gap: 12px; padding: 16px; }
  .mob-card-head { gap: 12px; }
  .mob-card-num { width: 34px; height: 34px; font-size: 17px; border-radius: 11px; }
  .mob-mode-row { grid-template-columns: minmax(0, 1fr); }
  .mob-apk-head .mob-intro-icon { display: none; }
  .mob-apk-meta { grid-template-columns: 1fr 1fr; }
  .mob-actions > .mob-btn { flex: 1 1 auto; }
  .mob-field > .mob-btn { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .mob-mode, .mob-device, .mob-copy, .mob-copy__ok { transition: none; }
}
`;
