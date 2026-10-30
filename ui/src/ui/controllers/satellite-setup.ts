/**
 * Satellite Setup Controller
 *
 * Drives the "this gateway joins an existing federation as a satellite" flow
 * used by the main setup wizard. Handles LAN scanning, manual URL entry,
 * pre-flight probing, the actual connect, and post-connect status with
 * categorized errors so the wizard can surface actionable diagnostics
 * instead of a raw stack trace.
 *
 * Phases (one-way, with explicit `failed` state for retry):
 *
 *   idle → scanning → scanned     (when user clicked "Scan LAN")
 *   idle → probing                (when user typed URL + clicked "Test")
 *   probing → probed | failed
 *   probed → connecting → connected | failed
 *   connected → (terminal, user advances wizard)
 *
 * The controller subscribes to gateway `federation.event` broadcasts so the
 * `connected` flag reflects the live satellite state, not just the result
 * of the initial connect RPC.
 */

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.js";

// ── Types ────────────────────────────────────────────────────

export type SatellitePhase =
  | "idle"
  | "scanning"
  | "scanned"
  | "probing"
  | "probed"
  | "connecting"
  | "connected"
  | "failed";

export interface ScannedMaster {
  wsUrl: string;
  httpsUrl?: string | null;
  hostname?: string | null;
  dnsName?: string | null;
  ip?: string | null;
  likelyMaster: boolean;
  reason?: string | null;
}

export interface MasterProbeResult {
  reachable: boolean;
  nodeId?: string | null;
  version?: string | null;
  url: string;
}

/**
 * One-bucket-per-cause categorization. Anything we can't classify falls
 * through to "unknown" and shows the raw message — but most realistic
 * failures land in one of the named buckets so the UI can offer a fix.
 */
export type SatelliteErrorKind =
  | "timeout"
  | "unauthorized"
  | "protocol-mismatch"
  | "network"
  | "config"
  | "unknown";

export interface SatelliteError {
  kind: SatelliteErrorKind;
  message: string;
  /** What the user can do about it. Plain English, one sentence. */
  fix: string;
}

export interface SatelliteSetupState {
  phase: SatellitePhase;
  /** User-typed URL or selected scan result. */
  masterUrl: string;
  /** Optional friendly name for this satellite. */
  nodeName: string;
  /** Optional auth token if the master requires one. */
  authToken: string;
  /** Results of `federation.scan`. Empty until user clicks scan. */
  scanResults: ScannedMaster[];
  /** Result of last probe. */
  probe: MasterProbeResult | null;
  /** Master id / version returned after a successful connect. */
  connected: { nodeId?: string; version?: string; latency?: number } | null;
  error: SatelliteError | null;
  /** True while a long-running RPC is in flight; mainly for disabling buttons. */
  busy: boolean;
  /** Set by the gateway-event subscriber so the wizard can show drift. */
  liveState: string | null;
  /**
   * Tracks whether we've fired the one-shot auto-scan that runs the first
   * time the user lands on the satellite role. Without this flag the
   * wizard would re-scan on every render. Reset by `resetSatelliteSetup`.
   */
  autoScanFired: boolean;
  /** When true the UI is on the invite-paste branch instead of URL/scan. */
  inviteMode: boolean;
  /** Base64 invite bundle pasted by the user. Decoded via decodeInvite(). */
  inviteText: string;
}

export function createSatelliteSetupState(): SatelliteSetupState {
  return {
    phase: "idle",
    masterUrl: "",
    nodeName: "",
    authToken: "",
    scanResults: [],
    probe: null,
    connected: null,
    error: null,
    busy: false,
    liveState: null,
    autoScanFired: false,
    inviteMode: false,
    inviteText: "",
  };
}

// ── Invite-bundle decoder ────────────────────────────────────

export interface DecodedInvite {
  hubUrl: string;
  hubName: string;
  expiresAt: number | null;
  minutesLeft: number | null;
}

/**
 * Decode a v1 base64 invite bundle. Returns null when the input is empty,
 * not valid base64 JSON, or doesn't match the v1 shape. Mirrors the decode
 * in `federation-modals.ts` so the setup wizard and post-setup modal agree
 * on what counts as a valid invite.
 */
export function decodeInvite(invite: string): DecodedInvite | null {
  if (!invite || !invite.trim()) return null;
  try {
    const decoded =
      typeof atob === "function"
        ? atob(invite.trim())
        : Buffer.from(invite.trim(), "base64").toString("utf8");
    const b = JSON.parse(decoded) as {
      v?: number;
      hubUrl?: string;
      hubName?: string;
      expiresAt?: number;
    };
    if (b.v !== 1 || !b.hubUrl) return null;
    const minutesLeft = b.expiresAt
      ? Math.max(0, Math.round((b.expiresAt - Date.now()) / 60_000))
      : null;
    return {
      hubUrl: b.hubUrl,
      hubName: b.hubName ?? "Hub",
      expiresAt: b.expiresAt ?? null,
      minutesLeft,
    };
  } catch {
    return null;
  }
}

// ── URL helpers ──────────────────────────────────────────────

/** Normalise user input into a federation WebSocket URL. */
export function normalizeMasterUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;
  // Strip surrounding whitespace and a trailing slash for consistency.
  url = url.replace(/\s+/g, "");
  if (url.startsWith("http://")) url = "ws://" + url.slice("http://".length);
  else if (url.startsWith("https://")) url = "wss://" + url.slice("https://".length);
  else if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    // Bare host:port → assume ws:// for LAN, wss:// for anything with a TLD.
    const looksRemote = /\./.test(url) && !url.startsWith("192.168.") && !url.startsWith("10.") && !url.startsWith("127.");
    url = (looksRemote ? "wss://" : "ws://") + url;
  }
  if (!/\/federation\/?$/.test(url)) {
    url = url.replace(/\/?$/, "/federation");
  }
  return url;
}

export function isValidMasterUrl(input: string): boolean {
  const normalized = normalizeMasterUrl(input);
  try {
    const u = new URL(normalized);
    return u.protocol === "ws:" || u.protocol === "wss:";
  } catch {
    return false;
  }
}

// ── Error categorization ─────────────────────────────────────

/**
 * Map a raw error message to a categorized error with an actionable hint.
 * The mapping is deliberately heuristic — federation errors arrive as
 * stringified messages from various layers and there's no single error-code
 * type, so we sniff for known phrases.
 */
export function categorizeError(raw: string | undefined): SatelliteError {
  const message = (raw ?? "").trim() || "unknown error";
  const lower = message.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      kind: "timeout",
      message,
      fix: "The master didn't respond in time. Check the URL, confirm the master gateway is running, and verify your network reaches it.",
    };
  }
  if (lower.includes("unauthorized") || lower.includes("invalid token") || lower.includes("auth")) {
    return {
      kind: "unauthorized",
      message,
      fix: "The master rejected the authentication token. Get a fresh token from the master operator (federation settings) and paste it below.",
    };
  }
  if (lower.includes("protocol") && lower.includes("mismatch")) {
    return {
      kind: "protocol-mismatch",
      message,
      fix: "The satellite and master are running incompatible versions. Update the older side so both run the same major version.",
    };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("network") ||
    lower.includes("websocket")
  ) {
    return {
      kind: "network",
      message,
      fix: "The address is reachable but no federation service is listening, or it's blocked. Confirm the master gateway is started and exposed on that URL.",
    };
  }
  if (lower.includes("invalid url") || lower.includes("must start with")) {
    return {
      kind: "config",
      message,
      fix: "The URL isn't a valid WebSocket address. Use ws://host:port or wss://host:port — the wizard will append /federation automatically.",
    };
  }
  return {
    kind: "unknown",
    message,
    fix: "Try probing the URL again. If it keeps failing, copy the message and check the gateway logs on either side.",
  };
}

// ── Actions ──────────────────────────────────────────────────

function setPhase(s: SatelliteSetupState, phase: SatellitePhase) {
  s.phase = phase;
}

function setError(s: SatelliteSetupState, err: SatelliteError | null) {
  s.error = err;
  if (err) s.phase = "failed";
}

/**
 * Run a LAN/Tailscale scan for federation masters. Populates `scanResults`.
 * Empty result is fine — the user can still type a URL manually.
 */
export async function scanForMasters(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  setPhase(state, "scanning");
  state.error = null;
  onChange?.();
  try {
    const res = (await client.request("federation.scan", {})) as {
      success?: boolean;
      candidates?: ScannedMaster[];
      error?: string;
    };
    if (res.success === false) {
      setError(state, categorizeError(res.error));
      return;
    }
    state.scanResults = res.candidates ?? [];
    setPhase(state, "scanned");
  } catch (e) {
    setError(state, categorizeError((e as Error).message));
  } finally {
    state.busy = false;
    onChange?.();
  }
}

/**
 * Probe the master URL without committing config. Uses
 * `federation.node.add` which already does a probe-only path on the master
 * side, but for satellite-side we manually probe to avoid mutating config.
 *
 * We treat probe as "did the federation websocket reachable? does it
 * respond to our handshake?". On success we transition to `probed`. The
 * actual connect only happens when the user confirms.
 */
export async function probeMaster(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): Promise<void> {
  if (state.busy) return;
  const url = normalizeMasterUrl(state.masterUrl);
  if (!isValidMasterUrl(url)) {
    setError(state, categorizeError("invalid url"));
    onChange?.();
    return;
  }
  state.masterUrl = url;
  state.busy = true;
  state.error = null;
  setPhase(state, "probing");
  onChange?.();

  // Strategy: open a transient browser-side WebSocket for ~5s. If it opens,
  // master is reachable; we then close. We deliberately do NOT call
  // federation.connect here — that would commit config and start a real
  // session. Probe-only keeps the wizard reversible.
  await new Promise<void>((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      setError(state, categorizeError("probe timed out after 5s"));
      onChange?.();
      resolve();
    }, 5000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timeout);
      resolved = true;
      setError(state, categorizeError(`invalid url: ${(e as Error).message}`));
      onChange?.();
      resolve();
      return;
    }

    ws.onopen = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      // Master is reachable on the wire. We don't try to register here —
      // that's reserved for the actual connect. Just record the probe.
      state.probe = { reachable: true, url };
      setPhase(state, "probed");
      try { ws.close(); } catch {}
      onChange?.();
      resolve();
    };

    ws.onerror = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      setError(state, categorizeError("websocket connection error — master unreachable or wrong URL"));
      onChange?.();
      resolve();
    };
  });

  state.busy = false;
  onChange?.();
}

/**
 * Persist federation.mode = "satellite" in config and call
 * `federation.node.add`, which both connects and remembers the config.
 *
 * We then rely on the gateway event subscriber to flip `phase` to
 * `connected` when the master sends `node.connected`. If the connect call
 * resolves but no event arrives within ~6s, we still mark connected as a
 * fallback — some setups don't broadcast the event quickly.
 */
export async function connectAsSatellite(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): Promise<void> {
  if (state.busy) return;
  if (state.phase !== "probed" && state.phase !== "scanned" && state.phase !== "idle") {
    // Allow retry from failed state
    if (state.phase !== "failed") return;
  }
  const url = normalizeMasterUrl(state.masterUrl);
  if (!isValidMasterUrl(url)) {
    setError(state, categorizeError("invalid url"));
    onChange?.();
    return;
  }
  state.busy = true;
  state.error = null;
  setPhase(state, "connecting");
  onChange?.();

  try {
    const res = (await client.request("federation.node.add", {
      url,
      name: state.nodeName.trim() || undefined,
    })) as {
      success?: boolean;
      connected?: boolean;
      error?: string;
      node?: { id?: string; name?: string; status?: string; version?: string };
    };
    if (res.success === false) {
      setError(state, categorizeError(res.error));
      return;
    }
    state.connected = {
      nodeId: res.node?.id,
      version: res.node?.version,
    };
    // If federation.node.add already reported connected=true, we're done.
    // Otherwise wait briefly for the live event to confirm; if none arrives,
    // fall back to the RPC's status string.
    if (res.connected) {
      setPhase(state, "connected");
    } else {
      // Give event subscriber up to 6s to flip us to connected.
      const settled = await waitForLiveConnected(state, 6000);
      if (settled) {
        setPhase(state, "connected");
      } else if (res.node?.status === "connected") {
        setPhase(state, "connected");
      } else {
        setError(state, categorizeError(
          `connect call returned but satellite status is "${res.node?.status ?? "unknown"}" — try retrying`,
        ));
      }
    }
  } catch (e) {
    setError(state, categorizeError((e as Error).message));
  } finally {
    state.busy = false;
    onChange?.();
  }
}

/** Reset back to idle so the user can re-enter a different URL. */
export function resetSatelliteSetup(state: SatelliteSetupState, onChange?: () => void): void {
  state.phase = "idle";
  state.error = null;
  state.connected = null;
  state.probe = null;
  state.busy = false;
  // Reset the auto-scan latch too so re-entering the satellite step
  // re-scans the LAN with whatever's reachable now.
  state.autoScanFired = false;
  state.inviteMode = false;
  state.inviteText = "";
  onChange?.();
}

/**
 * Connect using an invite-bundle pasted by the user instead of a manual URL.
 * The gateway's `federation.connect` decodes the bundle, persists the master
 * URL + auth token, and runs the normal satellite connect. We mirror the
 * busy/phase/error handling of `connectAsSatellite`.
 */
export async function connectAsSatelliteWithInvite(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): Promise<void> {
  if (state.busy) return;
  const decoded = decodeInvite(state.inviteText);
  if (!decoded) {
    setError(state, categorizeError("invite is empty or malformed"));
    onChange?.();
    return;
  }
  state.busy = true;
  state.error = null;
  setPhase(state, "connecting");
  onChange?.();

  try {
    const res = (await client.request("federation.connect", {
      invite: state.inviteText.trim(),
    })) as { success?: boolean; error?: string; masterUrl?: string };
    if (res.success === false) {
      setError(state, categorizeError(res.error));
      return;
    }
    // Reflect the resolved master URL back into the form so the connected
    // summary has something to display. The gateway has already persisted
    // the satellite config (mode + masterUrl + auth token).
    state.masterUrl = res.masterUrl ?? decoded.hubUrl;
    state.connected = {};
    // federation.connect resolves before the live `node.connected` event
    // arrives. Give the event subscriber a brief window to flip phase,
    // then accept the RPC success as authoritative.
    const settled = await waitForLiveConnected(state, 6000);
    if (!settled) setPhase(state, "connected");
  } catch (e) {
    setError(state, categorizeError((e as Error).message));
  } finally {
    state.busy = false;
    onChange?.();
  }
}

export async function disconnectSatellite(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  onChange?.();
  try {
    await client.request("federation.disconnect", {}).catch(() => null);
    resetSatelliteSetup(state, onChange);
  } finally {
    state.busy = false;
    onChange?.();
  }
}

// ── Live event subscription ──────────────────────────────────

/**
 * Subscribe to gateway `federation.event` broadcasts. Returns an
 * unsubscribe function. Call once per wizard mount; the subscriber updates
 * `state.liveState` and flips `phase` to `connected` if a positive event
 * arrives.
 *
 * Safe to call before connect — the subscription just records events as
 * they appear.
 */
export function subscribeToFederationEvents(
  state: SatelliteSetupState,
  client: GatewayBrowserClient,
  onChange?: () => void,
): () => void {
  return client.subscribe((evt: GatewayEventFrame) => {
    if (evt.event !== "federation.event") return;
    const payload = evt.payload as { event?: { type?: string; payload?: Record<string, unknown> } } | undefined;
    const type = payload?.event?.type;
    if (!type) return;
    state.liveState = type;
    if (type === "node.connected" || type === "satellite.connected" || type === "master.connected") {
      // We're now genuinely connected — promote phase if we were waiting.
      if (state.phase === "connecting") setPhase(state, "connected");
      onChange?.();
    } else if (type === "node.disconnected" || type === "satellite.disconnected") {
      // If disconnect happened during the wizard, surface it.
      if (state.phase === "connected" || state.phase === "connecting") {
        setError(state, categorizeError("master connection dropped"));
        onChange?.();
      }
    }
  });
}

/** Internal — poll state.phase up to timeoutMs waiting for the event. */
function waitForLiveConnected(state: SatelliteSetupState, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (state.phase === "connected") return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(poll, 200);
    };
    poll();
  });
}
