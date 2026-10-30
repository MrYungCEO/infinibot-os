/**
 * Robovoice SaaS edge API (robovoice.io or a self-hosted Robovoice with the
 * edge routes): the same device-code login the `robovoice` CLI and Robovoice
 * Desktop use, plus the InfiniBot-install routes (Robovoice
 * frontend/app/api/edge/infinibot/**, branch feat/infinibot-link).
 *
 *   POST /api/edge/auth/start      → { device_code, user_code, verification_uri(_complete), expires_in, interval }
 *   POST /api/edge/auth/token      → { access_token: "rve_…", org, user } | 400 { error: authorization_pending|slow_down|access_denied|expired_token }
 *   POST /api/edge/auth/logout     (Bearer) revoke the token
 *   GET  /api/edge/me              (Bearer) org, credits, locations, agents
 *   GET|POST|DELETE /api/edge/infinibot/link    status / link / unlink
 *   POST /api/edge/infinibot/agents             sync agents → characters
 *   POST|GET|DELETE /api/edge/infinibot/calls   start / status / end
 *   GET|PATCH /api/edge/infinibot/pipeline?location=   location pipeline config
 *        (PROPOSED — Robovoice today serves this only at /api/location/[id]/config
 *        behind a Clerk session; see docs/plugins/robovoice/VOICE-PIPELINE.md)
 */

import os from "node:os";

export class EdgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "EdgeApiError";
  }
}

export type DeviceCodeStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type EdgeOrg = { id: string; name: string; slug?: string | null };

export type TokenResult = { access_token: string; org: EdgeOrg; user?: { email?: string | null } };

export type EdgeCredits = {
  credit_usd?: number;
  balance_credits?: number;
  available_credits?: number;
  held_credits?: number;
  balance_usd?: number;
  plan?: string;
  low_balance_state?: string;
  standard_credits_per_second?: number;
};

export type LinkedAgentRow = {
  robot_id: string;
  persona_id: string | null;
  character_id: string | null;
  name: string;
  linked_character: boolean;
  synced_at: string;
  error?: string;
};

export type LinkResult = {
  ok: true;
  org: EdgeOrg;
  install_id: string;
  location: { id: string; name: string; slug: string | null; created: boolean; dashboard_url: string | null };
  device: { device_id: string; device_key: string; name: string; kiosk_url: string; created: boolean; restored: boolean };
  agents: Record<string, LinkedAgentRow>;
  credits: EdgeCredits;
};

export type EdgeDeviceRow = {
  device_id: string;
  name: string;
  state: "online" | "offline" | "in_call" | "revoked";
  online: boolean;
  last_seen_at: string | null;
  location: { id: string; name: string | null; slug: string | null } | null;
  call: null | { room: string; pipeline?: string; started_at: string | null; est_credits_used: number | null };
};

export type LinkStatus = {
  linked: boolean;
  org: EdgeOrg;
  user?: { email?: string | null };
  install_id?: string;
  linked_at?: string;
  unlinked_at?: string | null;
  location?: { id: string; name: string; slug: string | null; dashboard_url: string | null } | null;
  location_missing?: boolean;
  device?: EdgeDeviceRow | null;
  agents?: Record<string, LinkedAgentRow>;
  mcp?: { status?: string; url?: string | null; agents?: string[]; error?: string };
  credits: EdgeCredits;
};

export type AgentSyncInput = {
  agent_id: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  greeting?: string;
  language?: string;
  tts_provider?: string;
  tts_voice_kokoro?: string;
  tts_voice_elevenlabs?: string;
  character_id?: string;
  /** "infinibot" → the LLM step calls back into this gateway (see voice_llm on the sync). */
  llm_provider?: string;
  llm_model?: string;
};

/** Voice-LLM callback binding for the install's location (OpenAI-compatible base URL + scoped token). */
export type VoiceLlmBinding = { base_url: string; token: string; location_id: string };

export type EdgeMe = {
  org: EdgeOrg;
  user?: { email?: string | null };
  credits?: EdgeCredits;
  locations: Array<{ id: string; name: string; slug?: string | null }>;
  agents?: Array<{ id: string; name: string }>;
};

export type PipelineProviderOption = { id: string; label: string; available?: boolean; hint?: string; local?: boolean };

/** Same shape as Robovoice's GET /api/location/[id]/config (key-free). */
export type LocationPipelineConfig = {
  locationId: string;
  locationName: string;
  permissions: { canEditPipeline: boolean; canEditPrompt?: boolean };
  providers: { stt: PipelineProviderOption[]; llm: PipelineProviderOption[]; tts: PipelineProviderOption[] };
  /** Org-level pipeline (the layer every location inherits). */
  org: Record<string, unknown>;
  /** Location defaults (only what the location overrides). */
  defaults: Record<string, unknown>;
  updatedAt?: string | null;
  characters: Array<{
    id: string;
    name: string;
    /** The character's own (org-level) fields. */
    own: Record<string, unknown>;
    /** Location × character override. */
    override: Record<string, unknown>;
    infinibot_agent_id?: string | null;
  }>;
  /** Model / voice choices per stage + provider. */
  options?: {
    stt?: Record<string, Array<{ id: string; name?: string }>>;
    llm?: Record<string, Array<{ id: string; name?: string }>>;
    tts?: Record<string, Array<{ id: string; name?: string }>>;
  };
  voiceLlm?: { status: "bound" | "off"; base_url?: string | null };
};

export type PipelineCatalogModel = {
  key: string;
  provider: string;
  model: string;
  name: string;
  note: string;
  family: string;
  tier: "standard" | "premium" | "expressive";
  patch: Record<string, unknown>;
};
export type PipelineCatalog = {
  stage: "stt" | "llm" | "tts";
  tiers: Array<{ tier: string; blurb: string; count: number; families: Array<{ family: string; models: PipelineCatalogModel[] }> }>;
  total: number;
  /** credits per conversation minute, per voice tier, on this org's plan. */
  prices: { standard: number; premium: number; expressive: number };
};

export type PipelinePatch = {
  defaults?: Record<string, unknown>;
  characters?: Record<string, Record<string, unknown> | null>;
};

export type SyncResult = {
  ok: boolean;
  location: { id: string; name: string; slug: string | null };
  results: Array<{ agent_id: string; ok: boolean; character_id?: string | null; created?: boolean; error?: string }>;
  removed: string[];
  agents: Record<string, LinkedAgentRow>;
  mcp: { status: string; url: string | null; agents: string[]; error?: string };
  voice_llm?: { status: string; base_url?: string | null; agents?: string[]; error?: string };
};

export type CallStart = {
  ok: true;
  mode: "cloud" | "local";
  character_id: string;
  room: string;
  started_at: string;
  url?: string;
  device?: { device_id: string; name: string; hostname: string | null };
  command?: { id: string; kind: string; character_id?: string };
  credits: EdgeCredits;
};

export type CallStatus = {
  room: string;
  live: boolean;
  participants: number | null;
  hold: { started_at: string; tier: string } | null;
  usage: { sessions: number; billable_seconds: number; credits_charged: number; last_ended_at: string | null };
  local: { calls: number; seconds: number; active: boolean } | null;
  credits: EdgeCredits;
};

export const CLIENT_NAME = "InfiniBot";

export function machineInfo(version?: string) {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()}-${os.arch()}`,
    version: version ?? "infinibot",
  };
}

/** Per-request timeout for Robovoice edge calls. */
export const EDGE_TIMEOUT_MS = 30_000;

export class RobovoiceEdgeApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly token: string | null = null,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number; version?: string } = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // robovoice.io's edge endpoints answer in 1–13 s (serverless + Neon round
    // trips; /api/edge/infinibot/link is the slowest). 15 s aborted real reads.
    this.timeoutMs = opts.timeoutMs ?? EDGE_TIMEOUT_MS;
    this.version = opts.version;
  }
  private readonly timeoutMs: number;
  private readonly version?: string;

  get apiBase() {
    return this.base;
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | undefined>; auth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "infinibot-robovoice-plugin" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth !== false) {
      if (!this.token) throw new EdgeApiError("Not linked to Robovoice — run `infinibot robovoice login`", 401, "not_signed_in");
      headers.authorization = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new EdgeApiError(
        `Cannot reach Robovoice at ${this.base} (${err instanceof Error ? err.message : String(err)})`,
        0,
        "network",
      );
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { error: text.slice(0, 200) };
    }
    if (!res.ok) {
      const msg = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
      const code = typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : null;
      throw new EdgeApiError(msg, res.status, code);
    }
    return data as T;
  }

  // --- device-code login ---------------------------------------------------------

  startLogin(): Promise<DeviceCodeStart> {
    return this.request("/api/edge/auth/start", {
      method: "POST",
      auth: false,
      body: { client_name: `${CLIENT_NAME} (${os.hostname()})`, ...machineInfo(this.version) },
    });
  }

  /** One poll. Resolves with the token, or null while the code is still pending. */
  async pollLogin(deviceCode: string): Promise<TokenResult | null> {
    try {
      return await this.request<TokenResult>("/api/edge/auth/token", {
        method: "POST",
        auth: false,
        body: { device_code: deviceCode },
      });
    } catch (e) {
      if (e instanceof EdgeApiError && (e.code === "authorization_pending" || e.code === "slow_down")) return null;
      if (e instanceof EdgeApiError && e.code === "access_denied")
        throw new EdgeApiError("Sign-in was declined in the browser", 403, "access_denied");
      if (e instanceof EdgeApiError && e.code === "expired_token")
        throw new EdgeApiError("The sign-in code expired — start again", 400, "expired_token");
      if (e instanceof EdgeApiError && e.code === "network") return null;
      throw e;
    }
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("/api/edge/auth/logout", { method: "POST", body: {} });
  }

  me(): Promise<Record<string, unknown>> {
    return this.request("/api/edge/me");
  }

  // --- InfiniBot install ------------------------------------------------------------

  link(installId: string, extra: { locationName?: string; timezone?: string } = {}): Promise<LinkResult> {
    return this.request("/api/edge/infinibot/link", {
      method: "POST",
      body: {
        install_id: installId,
        location_name: extra.locationName,
        timezone: extra.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...machineInfo(this.version),
      },
    });
  }

  linkStatus(installId: string): Promise<LinkStatus> {
    return this.request("/api/edge/infinibot/link", { query: { install_id: installId } });
  }

  unlink(installId: string): Promise<{ ok: boolean; already?: boolean; location_kept?: string | null; device_revoked?: string | null }> {
    return this.request("/api/edge/infinibot/link", { method: "DELETE", body: { install_id: installId } });
  }

  syncAgents(
    installId: string,
    agents: AgentSyncInput[],
    opts: {
      remove?: string[];
      mcp?: { url: string; tokens: Record<string, string> };
      voiceLlm?: VoiceLlmBinding;
    } = {},
  ): Promise<SyncResult> {
    return this.request("/api/edge/infinibot/agents", {
      method: "POST",
      body: { install_id: installId, agents, remove: opts.remove, mcp: opts.mcp, voice_llm: opts.voiceLlm },
    });
  }

  meFull(): Promise<EdgeMe> {
    return this.request("/api/edge/me");
  }

  pipelineGet(locationId: string): Promise<LocationPipelineConfig> {
    return this.request("/api/edge/infinibot/pipeline", { query: { location: locationId } });
  }

  /**
   * The organization's tiered model catalog for one stage (read-only): the
   * choices + tier of every model and the credits/min each tier bills.
   */
  catalog(stage: "stt" | "llm" | "tts"): Promise<PipelineCatalog> {
    return this.request("/api/edge/infinibot/catalog", { query: { stage } });
  }

  pipelinePatch(locationId: string, patch: PipelinePatch): Promise<{ ok: boolean; defaults: Record<string, unknown>; characters: Record<string, Record<string, unknown>> }> {
    return this.request("/api/edge/infinibot/pipeline", { method: "PATCH", query: { location: locationId }, body: patch });
  }

  startCall(installId: string, p: { agentId?: string; characterId?: string; mode: "cloud" | "local" }): Promise<CallStart> {
    return this.request("/api/edge/infinibot/calls", {
      method: "POST",
      body: { install_id: installId, agent_id: p.agentId, character_id: p.characterId, mode: p.mode, hostname: os.hostname() },
    });
  }

  callStatus(room: string, since?: string): Promise<CallStatus> {
    return this.request("/api/edge/infinibot/calls", { query: { room, since } });
  }

  endCall(room: string): Promise<{ ok: boolean; ended: boolean; room: string }> {
    return this.request("/api/edge/infinibot/calls", { method: "DELETE", body: { room } });
  }
}
