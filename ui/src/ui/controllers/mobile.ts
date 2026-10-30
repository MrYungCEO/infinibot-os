/**
 * Mobile controller — drives the dashboard's `/mobile` page.
 *
 * Flows:
 *   • **Android APK** — the published APK (scripts/mobile-apk-publish.mjs)
 *     served by the gateway at /api/mobile/apk*; a signed short-lived link
 *     + QR lets a phone download it without a session.
 *   • **Dev client (Metro)** — `mobile.expo.start` spins up Metro, captures
 *     the `exp://...` URL and the InfiniBot dev-client build loads JS from
 *     it. Expo Go cannot run the app (native modules: LiveKit, WebRTC,
 *     expo-dev-client). Pre-bakes gateway URL + token into `.env.local`.
 *   • **Build the app** — runs `eas build` (Android APK / iOS IPA). Polls
 *     `mobile.eas.builds` for progress.
 */

import type { GatewayBrowserClient } from "../gateway";
import { ensureGatewaySession, gatewayHttpBase, gatewayHttpOrigin } from "../gateway-http-auth";

// ── Types ────────────────────────────────────────────────────

export type ExpoStatus = "stopped" | "starting" | "ready" | "exited" | "error";
export type ExpoMode = "tunnel" | "lan" | "localhost" | "tailscale";

export interface ExpoState {
  status: ExpoStatus;
  url: string | null;
  devUrl: string | null;
  mode: ExpoMode;
  pid: number | null;
  log: string[];
  startedAt: number | null;
  exitCode: number | null;
  error: string | null;
  projectDir: string;
  /** Setup hint from the runner (e.g. "log this computer in to Expo"). */
  notice?: string | null;
  /** True when expo-cli runs with EXPO_OFFLINE=1 (unsigned manifest). */
  offline?: boolean;
}

export interface MobileConfig {
  projectDir?: string;
  defaultMode?: ExpoMode;
  gatewayUrlOverride?: string;
  appleTeamId?: string;
  iosDeviceUdid?: string;
  expoOffline?: "auto" | boolean;
}

export interface MobileSuggested {
  gatewayUrl: string;
  gatewayToken: string | null;
  lanAddress: string | null;
  tailscaleAddress: string | null;
  tailnetHostname: string | null;
}

export interface EasWhoami {
  loggedIn: boolean;
  username?: string;
  error?: string;
}

export interface EasDevice {
  id: string;
  name?: string;
  udid: string;
  platform?: string;
  appleTeamId?: string;
  status?: string;
}

export interface EasBuild {
  id: string;
  platform: "ios" | "android" | "all";
  profile: "development" | "preview" | "production";
  status:
    | "new"
    | "queued"
    | "in-progress"
    | "finished"
    | "errored"
    | "canceled"
    | "unknown";
  artifactUrl?: string;
  buildUrl?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type MobileTab = "expo" | "build" | "web";

export interface MobileApkManifest {
  available: boolean;
  version?: string;
  versionCode?: number;
  buildDate?: string;
  size?: number;
  sha256?: string;
  file?: string;
  package?: string;
  minSdk?: number;
  notes?: string;
}

export interface MobileApkLink {
  url: string;
  expiresAt: number;
  qrSvg: string | null;
  baseUrl: string;
}

/** Which address the phone should use to reach this gateway. */
export type ApkLinkTarget = "lan" | "tailscale" | "origin";

export interface ApkLinkOption {
  id: ApkLinkTarget;
  label: string;
  /** http(s) origin, e.g. http://192.168.1.20:18789 */
  origin: string;
}

export interface MobileState {
  loading: boolean;
  error: string | null;
  success: string | null;
  tab: MobileTab;

  config: MobileConfig | null;
  suggested: MobileSuggested | null;

  expo: ExpoState | null;
  starting: boolean;
  stopping: boolean;
  /** Selected mode in the Expo controls. */
  mode: ExpoMode;
  /** Optional LAN/tunnel override the user types. */
  gatewayUrlOverride: string;

  whoami: EasWhoami | null;
  devices: EasDevice[];
  devicesLoading: boolean;
  appleTeamId: string;
  iosDeviceUdid: string;
  builds: EasBuild[];
  buildKicking: boolean;
  /** Active polling interval id, so we can clear on tab change. */
  pollHandle: number | null;

  apk: MobileApkManifest | null;
  apkLoading: boolean;
  apkError: string | null;
  apkDownloading: boolean;
  apkLinkTarget: ApkLinkTarget | null;
  apkLink: MobileApkLink | null;
  apkLinkLoading: boolean;
  apkLinkError: string | null;
  apkCopied: boolean;
  /** 1 s ticker driving the link expiry countdown. */
  apkTicker: number | null;
}

export function createInitialMobileState(): MobileState {
  return {
    loading: false,
    error: null,
    success: null,
    tab: "expo",
    config: null,
    suggested: null,
    expo: null,
    starting: false,
    stopping: false,
    mode: "tunnel",
    gatewayUrlOverride: "",
    whoami: null,
    devices: [],
    devicesLoading: false,
    appleTeamId: "",
    iosDeviceUdid: "",
    builds: [],
    buildKicking: false,
    pollHandle: null,
    apk: null,
    apkLoading: false,
    apkError: null,
    apkDownloading: false,
    apkLinkTarget: null,
    apkLink: null,
    apkLinkLoading: false,
    apkLinkError: null,
    apkCopied: false,
    apkTicker: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function flash(state: { mobile: MobileState; requestUpdate?: () => void }, kind: "error" | "success", value: string | null, ms = 3000) {
  state.mobile[kind] = value;
  if (value) {
    setTimeout(() => {
      if (state.mobile[kind] === value) state.mobile[kind] = null;
      state.requestUpdate?.();
    }, ms);
  }
}

// ── API actions ──────────────────────────────────────────────

export async function loadMobileConfig(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  state.mobile.loading = true;
  state.mobile.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("mobile.config.get", {})) as {
      config: MobileConfig;
      suggested: MobileSuggested;
    };
    state.mobile.config = res.config ?? {};
    state.mobile.suggested = res.suggested ?? null;
    state.mobile.mode = res.config?.defaultMode ?? "tunnel";
    state.mobile.gatewayUrlOverride = res.config?.gatewayUrlOverride ?? "";
    state.mobile.appleTeamId = res.config?.appleTeamId ?? "";
    state.mobile.iosDeviceUdid = res.config?.iosDeviceUdid ?? "";
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.mobile.loading = false;
    state.requestUpdate?.();
  }
}

export async function saveMobileConfig(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  patch: Partial<MobileConfig>,
): Promise<void> {
  try {
    const res = (await client.request("mobile.config.set", patch)) as { config: MobileConfig };
    state.mobile.config = res.config ?? {};
    state.mobile.appleTeamId = res.config?.appleTeamId ?? "";
    state.mobile.iosDeviceUdid = res.config?.iosDeviceUdid ?? "";
    flash(state, "success", "Saved");
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function refreshExpoStatus(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const res = (await client.request("mobile.expo.status", {})) as { state: ExpoState };
    state.mobile.expo = res.state;
    state.requestUpdate?.();
  } catch {
    /* swallow — polling is best-effort */
  }
}

/**
 * Derive a gateway WebSocket URL from the mode + suggested addresses when
 * the user hasn't set an explicit override.
 */
function computeSuggestedGateway(s: MobileState): string | undefined {
  const sug = s.suggested;
  if (!sug) return undefined;
  const port = 18789;
  if (s.mode === "tailscale") {
    if (sug.tailnetHostname) return `ws://${sug.tailnetHostname}:${port}`;
    if (sug.tailscaleAddress) return `ws://${sug.tailscaleAddress}:${port}`;
  }
  if (s.mode === "lan" && sug.lanAddress) {
    return `ws://${sug.lanAddress}:${port}`;
  }
  if (s.mode === "localhost") {
    return `ws://127.0.0.1:${port}`;
  }
  return undefined;
}

export async function startExpo(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  state.mobile.starting = true;
  state.mobile.error = null;
  state.requestUpdate?.();
  try {
    const params: Record<string, unknown> = { mode: state.mobile.mode };
    // Use explicit override if set, otherwise auto-fill from suggested
    // (tailnet hostname or tailscale / LAN IP).
    const gw = state.mobile.gatewayUrlOverride.trim() || computeSuggestedGateway(state.mobile);
    if (gw) {
      params.gatewayUrl = gw;
    }
    const res = (await client.request("mobile.expo.start", params)) as { state: ExpoState };
    state.mobile.expo = res.state;
    flash(state, "success", "Expo dev server starting…");
    // Begin polling until the URL appears or it errors.
    if (state.mobile.pollHandle == null) {
      state.mobile.pollHandle = window.setInterval(() => {
        void refreshExpoStatus(state, client);
        if (state.mobile.expo?.url || state.mobile.expo?.status === "error" || state.mobile.expo?.status === "stopped") {
          // Slow down once we have a URL — keep a heartbeat for log updates.
        }
      }, 1500) as unknown as number;
    }
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.mobile.starting = false;
    state.requestUpdate?.();
  }
}

export async function stopExpo(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  state.mobile.stopping = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("mobile.expo.stop", {})) as { state: ExpoState };
    state.mobile.expo = res.state;
    if (state.mobile.pollHandle != null) {
      clearInterval(state.mobile.pollHandle);
      state.mobile.pollHandle = null;
    }
    flash(state, "success", "Expo stopped");
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.mobile.stopping = false;
    state.requestUpdate?.();
  }
}

export async function loadEasWhoami(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const res = (await client.request("mobile.eas.whoami", {})) as EasWhoami;
    state.mobile.whoami = res;
    state.requestUpdate?.();
  } catch (err) {
    state.mobile.whoami = { loggedIn: false, error: err instanceof Error ? err.message : String(err) };
    state.requestUpdate?.();
  }
}

export async function loadEasDevices(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  state.mobile.devicesLoading = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("mobile.eas.devices", {})) as { devices: EasDevice[] };
    state.mobile.devices = res.devices ?? [];
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.mobile.devicesLoading = false;
    state.requestUpdate?.();
  }
}

export async function loadEasBuilds(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const res = (await client.request("mobile.eas.builds", { limit: 8 })) as { builds: EasBuild[] };
    state.mobile.builds = res.builds ?? [];
    state.requestUpdate?.();
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function kickEasBuild(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  opts: { profile?: "preview" | "production"; platform?: "ios" | "android"; clearCache?: boolean } = {},
): Promise<void> {
  state.mobile.buildKicking = true;
  state.mobile.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("mobile.eas.build", {
      profile: opts.profile ?? "preview",
      platform: opts.platform ?? "ios",
      clearCache: opts.clearCache ?? false,
      iosDeviceUdid: opts.platform === "android" ? undefined : state.mobile.iosDeviceUdid.trim() || undefined,
    })) as { ok: boolean; jobId?: string; buildUrl?: string; error?: string; log?: string[] };
    if (res.ok) {
      flash(state, "success", `Build queued${res.jobId ? ` (${res.jobId.slice(0, 8)}…)` : ""}`);
      await loadEasBuilds(state, client);
    } else {
      flash(state, "error", res.error || "Build failed to queue");
    }
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.mobile.buildKicking = false;
    state.requestUpdate?.();
  }
}

export async function cancelEasBuild(
  state: { mobile: MobileState; requestUpdate?: () => void },
  client: GatewayBrowserClient,
  jobId: string,
): Promise<void> {
  if (!confirm("Cancel this build?")) return;
  try {
    await client.request("mobile.eas.cancel", { id: jobId });
    flash(state, "success", "Build cancelled");
    await loadEasBuilds(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

// ── Local state mutators ────────────────────────────────────

export function setMobileTab(state: { mobile: MobileState; requestUpdate?: () => void }, tab: MobileTab): void {
  state.mobile.tab = tab;
  state.requestUpdate?.();
}

export function setMobileMode(state: { mobile: MobileState; requestUpdate?: () => void }, mode: ExpoMode): void {
  state.mobile.mode = mode;
  // Auto-fill gateway URL when switching to tailscale mode so the input
  // shows the right address immediately (and Start sends it correctly).
  if (mode === "tailscale") {
    const gw = computeSuggestedGateway(state.mobile);
    if (gw) {
      state.mobile.gatewayUrlOverride = gw;
    }
  }
  state.requestUpdate?.();
}

export function setMobileUrlOverride(state: { mobile: MobileState; requestUpdate?: () => void }, value: string): void {
  state.mobile.gatewayUrlOverride = value;
  state.requestUpdate?.();
}

export function setMobileAppleTeamId(state: { mobile: MobileState; requestUpdate?: () => void }, value: string): void {
  state.mobile.appleTeamId = value;
  state.requestUpdate?.();
}

export function setMobileIosDeviceUdid(state: { mobile: MobileState; requestUpdate?: () => void }, value: string): void {
  state.mobile.iosDeviceUdid = value;
  state.requestUpdate?.();
}

// ── Android APK ─────────────────────────────────────────────

type Host = { mobile: MobileState; requestUpdate?: () => void };

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const e = body?.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export async function loadMobileApk(state: Host): Promise<void> {
  state.mobile.apkLoading = true;
  state.mobile.apkError = null;
  state.requestUpdate?.();
  try {
    const res = await fetch(`${gatewayHttpBase()}/api/mobile/apk`, { cache: "no-store" });
    if (!res.ok) throw new Error(await readError(res));
    state.mobile.apk = (await res.json()) as MobileApkManifest;
  } catch (err) {
    state.mobile.apkError = err instanceof Error ? err.message : String(err);
  } finally {
    state.mobile.apkLoading = false;
    state.requestUpdate?.();
  }
}

/**
 * Stream the APK through the browser's own download manager: mint the
 * httpOnly session cookie first (a plain link cannot carry the Bearer
 * header), then navigate an anchor at the gated route. No blob buffering of
 * a ~100 MB file.
 */
export async function downloadMobileApk(state: Host): Promise<void> {
  state.mobile.apkDownloading = true;
  state.mobile.apkError = null;
  state.requestUpdate?.();
  try {
    await ensureGatewaySession();
    const url = `${gatewayHttpBase()}/api/mobile/apk/download`;
    const head = await fetch(url, { method: "HEAD", credentials: "include", cache: "no-store" });
    if (!head.ok) throw new Error(head.status === 401 ? "Not signed in to this gateway" : `HTTP ${head.status}`);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.mobile.apk?.file ?? "infinibot.apk";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    state.mobile.apkError = err instanceof Error ? err.message : String(err);
  } finally {
    state.mobile.apkDownloading = false;
    state.requestUpdate?.();
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/** The gateway's HTTP port as seen from a phone. */
function gatewayPort(s: MobileState): string {
  try {
    const o = new URL(gatewayHttpOrigin());
    if (o.port) return o.port;
  } catch {
    // fall through
  }
  const m = /:(\d+)(?:\/|$)/.exec(s.suggested?.gatewayUrl ?? "");
  return m?.[1] ?? "18789";
}

/** Addresses a phone can use to reach this gateway, best first. */
export function apkLinkOptions(s: MobileState): ApkLinkOption[] {
  const out: ApkLinkOption[] = [];
  const port = gatewayPort(s);
  let page: URL | null = null;
  try {
    page = new URL(gatewayHttpOrigin());
  } catch {
    page = null;
  }
  const sug = s.suggested;
  if (sug?.lanAddress) out.push({ id: "lan", label: "LAN", origin: `http://${sug.lanAddress}:${port}` });
  if (page && page.hostname.endsWith(".ts.net")) {
    out.push({ id: "tailscale", label: "Tailscale", origin: page.origin });
  } else if (sug?.tailnetHostname || sug?.tailscaleAddress) {
    out.push({
      id: "tailscale",
      label: "Tailscale",
      origin: `http://${sug.tailnetHostname ?? sug.tailscaleAddress}:${port}`,
    });
  }
  if (page && !isLoopbackHost(page.hostname) && !out.some((o) => o.origin === page!.origin)) {
    out.push({ id: "origin", label: "This address", origin: page.origin });
  }
  return out;
}

function stopApkTicker(state: Host): void {
  if (state.mobile.apkTicker != null) {
    clearInterval(state.mobile.apkTicker);
    state.mobile.apkTicker = null;
  }
}

function startApkTicker(state: Host): void {
  stopApkTicker(state);
  state.mobile.apkTicker = window.setInterval(() => {
    const link = state.mobile.apkLink;
    if (!link || link.expiresAt <= Date.now()) stopApkTicker(state);
    state.requestUpdate?.();
  }, 1000) as unknown as number;
}

export async function createMobileApkLink(state: Host, target?: ApkLinkTarget): Promise<void> {
  const options = apkLinkOptions(state.mobile);
  const pick =
    options.find((o) => o.id === (target ?? state.mobile.apkLinkTarget)) ?? options[0] ?? null;
  state.mobile.apkLinkTarget = pick?.id ?? null;
  state.mobile.apkLinkLoading = true;
  state.mobile.apkLinkError = null;
  state.requestUpdate?.();
  try {
    const baseUrl = pick?.origin ?? gatewayHttpOrigin();
    const res = await fetch(`${gatewayHttpBase()}/api/mobile/apk/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as { url: string; expiresAt: number; qrSvg: string | null };
    state.mobile.apkLink = { url: body.url, expiresAt: body.expiresAt, qrSvg: body.qrSvg, baseUrl };
    startApkTicker(state);
  } catch (err) {
    state.mobile.apkLink = null;
    state.mobile.apkLinkError = err instanceof Error ? err.message : String(err);
  } finally {
    state.mobile.apkLinkLoading = false;
    state.requestUpdate?.();
  }
}

export async function copyMobileApkSha(state: Host): Promise<void> {
  const sha = state.mobile.apk?.sha256;
  if (!sha) return;
  try {
    await navigator.clipboard.writeText(sha);
    state.mobile.apkCopied = true;
    state.requestUpdate?.();
    setTimeout(() => {
      state.mobile.apkCopied = false;
      state.requestUpdate?.();
    }, 1500);
  } catch {
    flash(state, "error", "Clipboard unavailable — select the hash and copy it manually");
  }
}
