/**
 * Robovoice on InfiniBot Cloud: LiveKit sessions from the hosted voice broker.
 *
 * On a fleet tenant Machine (SAAS_MODE + FLEET_TENANT_ID, the same test as
 * src/saas/fleet-plugins.ts) there is no Robovoice link and no owner key. When
 * the orchestrator has handed the Machine FLEET_VOICE_BROKER_URL, the plugin's
 * connection route forwards the member's own Clerk session (the Bearer the
 * cloud UI already sends to its gateway) to `<broker>/api/voice/*`, which
 * resolves the tenant, checks plan + credits, meters the call and mints a
 * per-tenant LiveKit token. The tenant is never chosen here.
 *
 * Anywhere else (`cloudBrokerUrl()` → null) the plugin keeps its local path
 * (Robovoice link / device key) exactly as before.
 */

import { VoiceProviderError } from "infinibot/plugin-sdk";

const on = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? "");

/** Broker base URL when this process is a fleet tenant Machine with the broker turned on; else null. */
export function cloudBrokerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!on(env.SAAS_MODE) || !env.FLEET_TENANT_ID?.trim()) return null;
  const raw = env.FLEET_VOICE_BROKER_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    if (u.protocol !== "https:" && !local) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The Clerk session JWT from an `Authorization: Bearer …` header, or null. */
export function bearerFrom(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(h?.trim() ?? "");
  return m?.[1] ?? null;
}

export type BrokerConnection = {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  participantName: string;
  characterId: string | null;
  grantedSeconds?: number;
  expiresAt?: string;
};

type Opts = { brokerUrl: string; bearer: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function call(opts: Opts, path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${opts.brokerUrl}/api/voice${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new VoiceProviderError(
      `InfiniBot Cloud voice unreachable: ${err instanceof Error ? err.message : String(err)}`,
      503,
      "voice_broker_unreachable",
    );
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    const v = text ? (JSON.parse(text) as unknown) : null;
    body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** A metered LiveKit session for this tenant from the broker. Errors keep the broker's status + code. */
export async function brokerConnectionDetails(
  opts: Opts & { agentId?: string; characterId?: string },
): Promise<BrokerConnection> {
  const q = new URLSearchParams();
  if (opts.agentId) q.set("agent", opts.agentId);
  if (opts.characterId) q.set("character", opts.characterId);
  const { status, body } = await call(opts, `/connection-details?${q}`, { method: "POST" });
  if (status !== 200 || !body) {
    const code = typeof body?.code === "string" ? body.code : "voice_broker_error";
    const msg = typeof body?.error === "string" ? body.error : `http ${status}`;
    throw new VoiceProviderError(msg, status >= 400 && status < 600 ? status : 502, code);
  }
  const out: BrokerConnection = {
    serverUrl: String(body.serverUrl ?? ""),
    participantToken: String(body.participantToken ?? ""),
    roomName: String(body.roomName ?? ""),
    participantName: String(body.participantName ?? "user"),
    characterId: typeof body.characterId === "string" ? body.characterId : null,
    grantedSeconds: typeof body.grantedSeconds === "number" ? body.grantedSeconds : undefined,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
  };
  if (!out.serverUrl || !out.participantToken || !out.roomName) {
    throw new VoiceProviderError("InfiniBot Cloud voice returned no LiveKit URL/token", 502, "voice_broker_error");
  }
  return out;
}

export type BrokerStage = { provider: string; model: string };
export type BrokerPipeline = {
  resolved: boolean;
  editable: false;
  stt?: BrokerStage;
  llm?: BrokerStage;
  tts?: BrokerStage;
  reason?: string;
};

const stageOf = (v: unknown): BrokerStage | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const { provider, model } = v as Record<string, unknown>;
  return typeof provider === "string" && provider ? { provider, model: typeof model === "string" ? model : "" } : undefined;
};

/**
 * The STT → LLM → TTS every tenant call runs on the shared hosted voice agent
 * (broker GET /api/voice/pipeline). Display only and the same for every tenant,
 * so it needs no member session.
 */
export async function brokerPipeline(opts: Omit<Opts, "bearer">): Promise<BrokerPipeline> {
  const { status, body } = await call({ ...opts, bearer: "" }, "/pipeline", { method: "GET" });
  if (status !== 200 || !body) {
    throw new VoiceProviderError(
      typeof body?.error === "string" ? body.error : `InfiniBot Cloud voice pipeline unavailable (http ${status})`,
      status >= 400 && status < 600 ? status : 502,
      typeof body?.code === "string" ? body.code : "voice_broker_error",
    );
  }
  const stt = stageOf(body.stt);
  const llm = stageOf(body.llm);
  const tts = stageOf(body.tts);
  const resolved = body.resolved === true && Boolean(stt && llm && tts);
  return resolved
    ? { resolved, editable: false, stt, llm, tts }
    : { resolved: false, editable: false, reason: typeof body.reason === "string" ? body.reason : "not published" };
}

/** Close + bill a call on the broker (idempotent there; scoped to the caller's tenant). */
export async function brokerEndSession(opts: Opts & { room: string }): Promise<Record<string, unknown>> {
  const { status, body } = await call(opts, "/sessions/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: opts.room }),
  });
  if (status !== 200 || !body) {
    throw new VoiceProviderError(
      typeof body?.error === "string" ? body.error : `voice session end failed (http ${status})`,
      status >= 400 && status < 600 ? status : 502,
      typeof body?.code === "string" ? body.code : "voice_broker_error",
    );
  }
  return body;
}

/**
 * robovoice.link.status for a cloud tenant: the Voice page's "linked" console,
 * backed by the broker instead of a Robovoice account. Credits are read with
 * the member's session on the page, not here (RPCs carry no Clerk session).
 */
export function cloudLinkStatus(brokerUrl: string, agents: Array<{ agentId: string; name: string }>) {
  return {
    linked: true,
    signedIn: true,
    apiBase: brokerUrl,
    org: { id: "infinibot-cloud", name: "InfiniBot Cloud" },
    location: { name: "InfiniBot Cloud voice" },
    agents: agents.map((a) => ({ agentId: a.agentId, name: a.name, characterId: a.agentId, managed: false })),
    credits: { available: false as const, reason: "Voice minutes and credits are on your InfiniBot Cloud account." },
    pending: null,
    cloud: true,
  };
}
