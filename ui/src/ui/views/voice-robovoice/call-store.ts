/**
 * The one voice call of this browser tab. Module-level so a call survives
 * navigation: the Voice page console subscribes while mounted, the app shell
 * shows a "call live" pill elsewhere, and wake words start calls from any tab.
 *
 * Two engines behind one API (`robovoiceCall`, name kept for its callers):
 *   local      the default — InfiniBot's built-in voice on this machine
 *              (local-call-session.ts: VAD → local STT → voice turn → local TTS)
 *   robovoice  opt-in cloud voice (call-session.ts: a Robovoice LiveKit call),
 *              used only when voice settings say "Cloud voice (Robovoice)"
 */

import { isCloudBuild } from "../../cloud/cloud-env.js";
import { awaitGatewayClient, getGatewayClient } from "../../gateway-client.js";
import { gatewayHttpBase } from "../../gateway-http-auth.js";
import { RobovoiceCallSession, SILENT_ROOM, fetchRobovoiceConnection, joinLivekitRoom, loadLivekit, primeCallAudio, type RoomLevels, type RvCallStart } from "./call-session.js";
import { resolveCallTarget } from "./call-target.js";
import { isCloudVoiceActive } from "../../controllers/voice-provider.js";
import { LocalVoiceCallSession, browserLocalCallDeps } from "./local-call-session.js";
import { IDLE_CALL, callInProgress, type CallState } from "./console-state.js";

type Listener = (state: CallState, start: RvCallStart | null) => void;

const listeners = new Set<Listener>();
let current: CallState = IDLE_CALL;
let currentStart: RvCallStart | null = null;
type AnySession = RobovoiceCallSession | LocalVoiceCallSession;
let session: AnySession | null = null;
let sessionKind: "local" | "robovoice" | null = null;

export const RV_CALL_EVENT = "infinibot:robovoice-call";

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const client = getGatewayClient() ?? (await awaitGatewayClient(15_000));
  if (!client) throw new Error("gateway not connected");
  return client.request<T>(method, params);
}

function emit(state: CallState, start: RvCallStart | null): void {
  current = state;
  currentStart = start;
  for (const l of listeners) l(state, start);
  try {
    window.dispatchEvent(
      new CustomEvent(RV_CALL_EVENT, {
        detail: {
          phase: state.phase,
          agentId: state.agentId,
          sessionKey: state.sessionKey,
          error: state.error,
        },
      }),
    );
  } catch {
    /* non-browser */
  }
}

/**
 * InfiniBot Cloud: close + bill the hosted voice broker's session for a
 * broker room (`tenant-…`). The gateway fetch wrapper adds the member's Clerk
 * Bearer. Best-effort: LiveKit webhooks / the broker's timeout close it anyway.
 */
export function endBrokerSession(room: string, base = gatewayHttpBase(), fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!room.startsWith("tenant-")) return Promise.resolve();
  return fetchImpl(`${base}/plugins/robovoice/sessions/end`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room }),
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** Which engine the next call uses: local unless cloud voice (Robovoice) is selected. */
export function voiceCallEngine(): "local" | "robovoice" {
  return isCloudVoiceActive() ? "robovoice" : "local";
}

function ensureSession(kind: "local" | "robovoice" = sessionKind ?? voiceCallEngine()): AnySession {
  if (session && sessionKind === kind) return session;
  // Switching engines only between calls: drop the idle one.
  if (session && callInProgress(current)) return session;
  session?.dispose();
  sessionKind = kind;
  session =
    kind === "local"
      ? new LocalVoiceCallSession(browserLocalCallDeps(emit))
      : new RobovoiceCallSession({
          // InfiniBot Cloud: also close + bill the hosted broker session.
          rpc: <T>(method: string, params: Record<string, unknown> = {}) => {
            if (method === "robovoice.call.end" && isCloudBuild()) void endBrokerSession(String(params.room ?? ""));
            return rpc<T>(method, params);
          },
          fetchConnection: (agentId, sessionKey) => fetchRobovoiceConnection(agentId, gatewayHttpBase(), sessionKey),
          joinRoom: joinLivekitRoom,
          onChange: emit,
        });
  return session;
}

export const robovoiceCall = {
  get state(): CallState {
    return current;
  },
  get start(): RvCallStart | null {
    return currentStart;
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    l(current, currentStart);
    return () => listeners.delete(l);
  },
  /** `opts.sessionKey` binds the call to a chat session (its turns + transcript land there). */
  begin(agentId: string, opts: { sessionKey?: string | null } = {}): Promise<void> {
    return ensureSession(voiceCallEngine()).begin(agentId, opts);
  },
  /** Which engine the next call (or the current one) runs on. */
  get engine(): "local" | "robovoice" {
    return callInProgress(current) && sessionKind ? sessionKind : voiceCallEngine();
  },
  /** Fetch the call library before the Connect tap (the Voice page does this on open). */
  preload(): void {
    if (voiceCallEngine() === "robovoice") void loadLivekit().catch(() => undefined);
    else void import("@ricky0123/vad-web").catch(() => undefined);
  },
  /** Call synchronously in the Connect tap, before begin(): lets the browser play the agent. */
  primeAudio(): void {
    if (voiceCallEngine() === "robovoice") primeCallAudio();
    else void ensureSession("local").startAudio();
  },
  /** "Tap to enable audio" — call synchronously in that tap. */
  enableAudio(): Promise<void> {
    return session?.startAudio() ?? Promise.resolve();
  },
  end(): Promise<void> {
    return session?.end() ?? Promise.resolve();
  },
  setMuted(muted: boolean): Promise<void> {
    return session?.setMuted(muted) ?? Promise.resolve();
  },
  /** Speaker ("" = system default) + volume (0..1) for the agent's voice, applied live. */
  setOutput(deviceId: string, volume: number): Promise<void> {
    return session?.setOutput(deviceId, volume) ?? Promise.resolve();
  },
  setMicDevice(deviceId: string): Promise<void> {
    return session?.setMicDevice(deviceId) ?? Promise.resolve();
  },
  /** Live mic / agent audio levels (silent when no call audio is joined). */
  levels(): RoomLevels {
    return session?.levels() ?? SILENT_ROOM;
  },
  reset(): void {
    session?.reset();
  },
  inProgress(): boolean {
    return callInProgress(current);
  },
};

/**
 * Is this install linked to a Robovoice organization? (robovoice.link.status,
 * local only.) Cached briefly so every chat's call button can show "Connect
 * Robovoice" without a request per render; null = couldn't tell (gateway down,
 * plugin off). Every answer is broadcast as `infinibot:robovoice-link`.
 */
export const RV_LINK_EVENT = "infinibot:robovoice-link";
let linkCache: { at: number; linked: boolean } | null = null;
let linkInflight: Promise<boolean | null> | null = null;

function noteLinked(linked: boolean): void {
  const changed = linkCache?.linked !== linked;
  linkCache = { at: Date.now(), linked };
  if (!changed) return;
  try {
    window.dispatchEvent(new CustomEvent(RV_LINK_EVENT, { detail: { linked } }));
  } catch {
    /* non-browser */
  }
}

export function robovoiceLinked(maxAgeMs = 15_000): Promise<boolean | null> {
  if (linkCache && Date.now() - linkCache.at < maxAgeMs) return Promise.resolve(linkCache.linked);
  linkInflight ??= rpc<{ linked?: boolean; unlinkedAt?: string }>("robovoice.link.status", {
    remote: false,
  })
    .then((st) => {
      const linked = Boolean(st?.linked && !st.unlinkedAt);
      noteLinked(linked);
      return linked;
    })
    .catch(() => null)
    .finally(() => {
      linkInflight = null;
    });
  return linkInflight;
}

/**
 * Wake words / voice buttons: start a Robovoice call when this install is
 * linked (returns "calling"), otherwise report why so the caller can open the
 * Voice page's connect state.
 */
export async function startRobovoiceCallFromIntent(
  agentId?: string,
  sessionKey?: string,
): Promise<"calling" | "in-call" | "not-linked" | "unavailable"> {
  if (robovoiceCall.inProgress()) return "in-call";
  // Local voice (the default) needs no account: call straight away.
  if (voiceCallEngine() === "local") {
    const target = resolveCallTarget({ agentId, sessionKey });
    void robovoiceCall.begin(target.agentId, { sessionKey: target.sessionKey });
    return "calling";
  }
  let status: { linked?: boolean; unlinkedAt?: string } | null = null;
  try {
    status = await rpc("robovoice.link.status", { remote: false });
  } catch {
    return "unavailable";
  }
  if (!status?.linked || status.unlinkedAt) {
    noteLinked(false);
    return "not-linked";
  }
  noteLinked(true);
  const target = resolveCallTarget({ agentId, sessionKey });
  void robovoiceCall.begin(target.agentId, { sessionKey: target.sessionKey });
  return "calling";
}
