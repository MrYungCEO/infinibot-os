/**
 * HTTP client for a Robovoice deployment (self-hosted Docker stack or
 * Robovoice cloud). Only the documented, secret-free/public call surfaces plus
 * the edge-device auth are used:
 *
 *   GET  /api/health                         {status:'ok'|'degraded', agent}
 *   GET  /api/call/characters                {characters: SafeCharacter[], active_character_id, default_character_id}
 *   GET  /api/call/pipeline?character=&location=  public effective pipeline
 *   POST /api/connection-details?character=&device=&location=&expressive=
 *        body {device_id, device_key} → {serverUrl, roomName, participantName, participantToken}
 *        429 {error:"cloud_voice_busy"}  fair-use daily limit (Robovoice INFINIBOT_CLOUD_VOICE_DAILY_MINUTES)
 *        402 only if Robovoice turned its InfiniBot credit gate back on (INFINIBOT_CREDITS_GATE=on)
 *   GET  /api/edge/me  (Bearer rve_… edge token) → org + wallet (cloud credits)
 *
 * Robovoice source: the Robovoice repo, frontend/app/api/**.
 */

import { VoiceProviderError } from "infinibot/plugin-sdk";

/**
 * Cloud voice is free for InfiniBot (no credits). When Robovoice can't take a
 * call — its fair-use daily limit, or a credit gate an operator turned back
 * on — InfiniBot shows this and a one-click switch to local voice.
 */
export const CLOUD_VOICE_BUSY_CODE = "cloud_voice_busy";
export const CLOUD_VOICE_BUSY_MESSAGE = "Cloud voice is busy right now. Switch to local voice to keep talking.";

export type RobovoiceCharacter = {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  language?: string;
  tts_provider?: string;
  agent_location_id?: string;
  agent_location_name?: string;
};

export type RobovoiceRoster = {
  characters: RobovoiceCharacter[];
  active_character_id?: string | null;
  default_character_id?: string | null;
};

export type RobovoicePipelineStage = {
  provider?: string | null;
  model?: string | null;
  engine?: string | null;
  state?: "ready" | "warming" | "cold" | "unavailable" | null;
};

export type RobovoicePipeline = {
  character_id?: string | null;
  location_id?: string | null;
  mode?: "livekit" | "elevenlabs_agent";
  stt?: RobovoicePipelineStage;
  llm?: RobovoicePipelineStage;
  tts?: RobovoicePipelineStage;
  expressive?: boolean;
  resolved?: boolean;
};

export type RobovoiceConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

export type RobovoiceCredits =
  | {
      available: true;
      orgName?: string;
      balanceUsd: number;
      heldUsd: number;
      availableUsd: number;
      /** Spendable credits (balance − held). */
      availableCredits: number;
      balanceCredits?: number;
      heldCredits?: number;
      /** USD value of one credit on this deployment. */
      creditUsd?: number;
      /** Credits per second of standard voice. */
      creditsPerSecond?: number;
      plan?: string;
      monthMinutes?: number;
      monthChargeUsd?: number;
      lowBalance?: boolean;
    }
  | { available: false; reason: string };

export type RobovoiceClientOptions = {
  baseUrl: string;
  /** Registered edge-device id + HMAC device key (strict device policy). */
  deviceId?: string;
  deviceKey?: string;
  /** Org-scoped edge token (`rve_…`) from `robovoice login` (cloud). */
  edgeToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export class RobovoiceClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RobovoiceClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    // Public call endpoints answer in ~1–5 s on robovoice.io; 8 s aborted real reads.
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.auth && this.opts.edgeToken) headers.authorization = `Bearer ${this.opts.edgeToken}`;
    if (init.auth && this.opts.deviceKey) headers["x-device-key"] = this.opts.deviceKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new VoiceProviderError(
        `Robovoice unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
        503,
        "robovoice_unreachable",
      );
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // plain-text error bodies are kept as strings
    }
    return { status: res.status, body };
  }

  async health(): Promise<{ ok: boolean; status: string; agent?: unknown }> {
    const { status, body } = await this.request("/api/health");
    const s = isRecord(body) && typeof body.status === "string" ? body.status : `http ${status}`;
    return { ok: status === 200 && s === "ok", status: s, agent: isRecord(body) ? body.agent : undefined };
  }

  async characters(): Promise<RobovoiceRoster> {
    const { status, body } = await this.request("/api/call/characters");
    if (status !== 200 || !isRecord(body)) {
      throw new VoiceProviderError(`Robovoice character roster failed (http ${status})`, 502);
    }
    const list = Array.isArray(body.characters) ? body.characters : [];
    return {
      characters: list
        .filter((c): c is Record<string, unknown> => isRecord(c) && typeof c.id === "string")
        .map((c) => ({
          id: String(c.id),
          name: typeof c.name === "string" ? c.name : String(c.id),
          description: typeof c.description === "string" ? c.description : undefined,
          avatar: typeof c.avatar === "string" ? c.avatar : undefined,
          language: typeof c.language === "string" ? c.language : undefined,
          tts_provider: typeof c.tts_provider === "string" ? c.tts_provider : undefined,
          agent_location_id: typeof c.agent_location_id === "string" ? c.agent_location_id : undefined,
          agent_location_name:
            typeof c.agent_location_name === "string" ? c.agent_location_name : undefined,
        })),
      active_character_id: typeof body.active_character_id === "string" ? body.active_character_id : null,
      default_character_id:
        typeof body.default_character_id === "string" ? body.default_character_id : null,
    };
  }

  async pipeline(characterId?: string, locationId?: string): Promise<RobovoicePipeline> {
    const q = new URLSearchParams();
    if (characterId) q.set("character", characterId);
    if (locationId) q.set("location", locationId);
    const { status, body } = await this.request(`/api/call/pipeline?${q}`);
    if (status !== 200 || !isRecord(body)) {
      throw new VoiceProviderError(`Robovoice pipeline lookup failed (http ${status})`, 502);
    }
    return body as RobovoicePipeline;
  }

  async connectionDetails(params: {
    characterId?: string;
    locationId?: string;
    expressive?: boolean;
  }): Promise<RobovoiceConnectionDetails> {
    // Only ever as this install's linked device: an anonymous connection-details
    // is served from the deployment owner's default agent and wallet.
    if (!this.opts.deviceId || !this.opts.deviceKey || !params.characterId) {
      throw new VoiceProviderError(
        "Robovoice call refused: no linked device or character (connect Robovoice first).",
        409,
        "robovoice_not_linked",
      );
    }
    const q = new URLSearchParams();
    q.set("character", params.characterId);
    q.set("device", this.opts.deviceId);
    if (params.locationId) q.set("location", params.locationId);
    if (params.expressive !== undefined) q.set("expressive", params.expressive ? "1" : "0");
    const { status, body } = await this.request(`/api/connection-details?${q}`, {
      method: "POST",
      auth: true,
      // Tells Robovoice this is an InfiniBot install: it then requires a live
      // link (device of an InfiniBot link + its org's character) and never
      // falls back to the deployment default agent or an unmetered call.
      headers: { "content-type": "application/json", "x-robovoice-client": "infinibot" },
      body: JSON.stringify({
        ...(this.opts.deviceId ? { device_id: this.opts.deviceId } : {}),
        ...(this.opts.deviceKey ? { device_key: this.opts.deviceKey } : {}),
      }),
    });
    if (status === 429 || status === 402) {
      throw new VoiceProviderError(CLOUD_VOICE_BUSY_MESSAGE, 429, CLOUD_VOICE_BUSY_CODE);
    }
    if (status !== 200 || !isRecord(body)) {
      const msg = isRecord(body) && typeof body.error === "string" ? body.error : `http ${status}`;
      const code = isRecord(body) && typeof body.error === "string" && /^[a-z_]+$/.test(body.error) ? body.error : undefined;
      const message = isRecord(body) && typeof body.message === "string" ? body.message : msg;
      // Robovoice's link enforcement answers 401/403/404/409 (not linked, foreign character): keep them.
      const keep = status === 401 || status === 403 || status === 404 || status === 409 || status === 503;
      throw new VoiceProviderError(`Robovoice connection-details failed: ${message}`, keep ? status : 502, code ?? "voice_provider_error");
    }
    const out = {
      serverUrl: String(body.serverUrl ?? ""),
      roomName: String(body.roomName ?? ""),
      participantName: String(body.participantName ?? "user"),
      participantToken: String(body.participantToken ?? ""),
    };
    if (!out.serverUrl || !out.participantToken) {
      throw new VoiceProviderError("Robovoice connection-details returned no LiveKit URL/token", 502);
    }
    return out;
  }

  /**
   * Credit balance from `GET /api/edge/me` (edge token). Robovoice answers
   * `credits: { balance_credits, available_credits, held_credits, credit_usd,
   * balance_usd, low_balance_state, standard_credits_per_second, … }`
   * (lib/edge/devices.ts walletCredits); an older `wallet` USD shape is still read.
   */
  async credits(): Promise<RobovoiceCredits> {
    if (!this.opts.edgeToken) {
      return { available: false, reason: "Link InfiniBot to Robovoice (infinibot robovoice login) to see credits." };
    }
    const { status, body } = await this.request("/api/edge/me", { auth: true });
    if (status === 401 || status === 403) return { available: false, reason: "Robovoice sign-in rejected — run infinibot robovoice login." };
    if (status !== 200 || !isRecord(body)) {
      return { available: false, reason: `Robovoice /api/edge/me failed (http ${status}).` };
    }
    return parseCredits(body);
  }
}

/**
 * Normalise Robovoice's credits (or legacy wallet) block. Only what Robovoice
 * reported: a missing balance or credit value is "not available", never a
 * guessed 0 or a guessed credit price.
 */
export function parseCredits(body: Record<string, unknown>): RobovoiceCredits {
  const orgName = isRecord(body.org) && typeof body.org.name === "string" ? body.org.name : undefined;
  const c = isRecord(body.credits) ? body.credits : null;
  if (c) {
    const creditUsd = num(c.credit_usd);
    const available = num(c.available_credits);
    if (creditUsd === undefined || available === undefined) {
      return { available: false, reason: "Robovoice didn't report this org's credit balance." };
    }
    const availableCredits = Math.floor(available);
    const balanceCredits = num(c.balance_credits);
    const heldCredits = num(c.held_credits);
    return {
      available: true,
      orgName,
      creditUsd,
      // balance = spendable + held (Robovoice's definition) when only credits are sent
      balanceUsd: num(c.balance_usd) ?? (balanceCredits ?? availableCredits + (heldCredits ?? 0)) * creditUsd,
      heldUsd: (heldCredits ?? 0) * creditUsd,
      availableUsd: availableCredits * creditUsd,
      availableCredits,
      balanceCredits: balanceCredits !== undefined ? Math.floor(balanceCredits) : undefined,
      heldCredits: heldCredits !== undefined ? Math.floor(heldCredits) : undefined,
      creditsPerSecond: num(c.standard_credits_per_second),
      plan: typeof c.plan === "string" ? c.plan : undefined,
      lowBalance: typeof c.low_balance_state === "string" ? c.low_balance_state !== "ok" : undefined,
    };
  }
  const wallet = isRecord(body.wallet) ? body.wallet : null;
  const availableUsd = wallet ? num(wallet.available_usd) : undefined;
  if (!wallet || availableUsd === undefined) {
    return { available: false, reason: "This Robovoice deployment doesn't report credits to edge clients yet." };
  }
  // Legacy USD-only wallet: it has no credit unit, so no credit count is made up.
  return {
    available: false,
    reason: `This Robovoice deployment reports only a USD wallet ($${availableUsd.toFixed(2)} available), not credits.`,
  };
}
