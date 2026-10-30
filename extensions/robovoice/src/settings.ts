/**
 * Robovoice plugin settings + secrets.
 *
 * Both live in the INSTALL-WIDE plugin dir `<sharedDir>/plugin-data/robovoice/`
 * (never per user profile: one Robovoice org per InfiniBot install, shared by
 * every profile, like other provider credentials — see
 * feedback: multi-user isolation boundary).
 *
 *   settings.json  non-secret settings + the link state mirror (org, location,
 *                  device, which agent is which character), layered over the
 *                  declarative plugin config (`plugins.entries.robovoice.config`)
 *                  and — for migration — the legacy `voice.robovoiceUrl` /
 *                  `ROBOVOICE_URL`.
 *   secrets.json   mode 0600, every value AES-256-GCM encrypted with the
 *                  install key (the same store email accounts and per-agent
 *                  secrets use): the `rve_` org token, the device key, and the
 *                  per-agent MCP tokens. Never returned to the UI (masked hint
 *                  only). Env fallbacks ROBOVOICE_DEVICE_KEY / ROBOVOICE_EDGE_TOKEN.
 *                  Plaintext files from older versions are read and re-encrypted
 *                  on the next write.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * `<stateDir>/plugin-data/robovoice` — the host's per-plugin data dir, so
 * Setup › Plugins › Data sizes, exports, clears and (on uninstall) removes
 * settings + secrets. Builds before release/plugins-1 used
 * `<stateDir>/plugins/robovoice`; that dir is moved over once.
 */
export function robovoiceDataDir(stateDir: string): string {
  const dir = path.join(stateDir, "plugin-data", "robovoice");
  const legacy = path.join(stateDir, "plugins", "robovoice");
  if (fs.existsSync(legacy) && !fs.existsSync(dir)) {
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      fs.renameSync(legacy, dir);
    } catch {
      return legacy;
    }
  }
  return dir;
}

export type RobovoiceDeployment = "self-hosted" | "cloud";

/** What the SaaS link looks like from this install (mirrors the server's link row). */
export type RobovoiceLink = {
  apiBase: string;
  orgId: string;
  orgName: string;
  userEmail?: string;
  locationId?: string;
  locationName?: string;
  locationSlug?: string;
  dashboardUrl?: string;
  deviceId?: string;
  deviceName?: string;
  linkedAt: string;
  /** Set by unlink: the device is revoked, the location stays in the org. */
  unlinkedAt?: string;
};

/** One InfiniBot agent's Robovoice character, as last synced. */
export type LinkedCharacter = {
  characterId?: string;
  robotId?: string;
  /** true = InfiniBot created and owns the persona; false = linked to an existing character. */
  managed: boolean;
  syncedAt?: string;
  error?: string;
};

/** Per-agent voice persona overrides (CLI `link --voice/--language/--name`). */
export type AgentVoiceOverride = {
  name?: string;
  language?: string;
  ttsProvider?: string;
  voice?: string;
  greeting?: string;
  prompt?: string;
  /**
   * Who answers as the LLM step: "infinibot" (default — Robovoice calls back
   * into this gateway, see src/voice-llm.ts) or "robovoice" (the location's own
   * LLM from the pipeline).
   */
  llm?: "infinibot" | "robovoice";
  /** Backend for InfiniBot turns: the gateway agent or a CLI agent. */
  llmBackend?: VoiceLlmBackend;
};

/** Where an InfiniBot voice turn runs (mirrors core VOICE_LLM_BACKENDS). */
export const VOICE_LLM_BACKENDS = ["gateway", "claude-code", "codex", "opencode", "gemini", "grok"] as const;
export type VoiceLlmBackend = (typeof VOICE_LLM_BACKENDS)[number];
export function isVoiceLlmBackend(v: unknown): v is VoiceLlmBackend {
  return typeof v === "string" && (VOICE_LLM_BACKENDS as readonly string[]).includes(v);
}

export type RobovoiceSettings = {
  deployment: RobovoiceDeployment;
  /** Robovoice dashboard origin, e.g. http://<lan-host>:3011 or https://robovoice.io */
  baseUrl: string;
  /** Registered edge-device id InfiniBot calls as (Robovoice strict device policy). */
  deviceId?: string;
  /** Robovoice location (pipeline overrides layer per location). */
  locationId?: string;
  /** Expressive (premium) voice tier for sessions. */
  expressive?: boolean;
  /** Character used when an agent has no mapping (else Robovoice resolves). */
  defaultCharacterId?: string;
  /** InfiniBot agent id → Robovoice character id. */
  characterMap: Record<string, string>;
  /** Wake word the Robovoice stack is configured with (for the safety label). */
  wakeWord?: { engine?: string; model?: string };
  /** InfiniBot tools exposed to Robovoice over the MCP endpoints. */
  mcpTools?: string[];
  /** Stable id of this InfiniBot install (keys its Robovoice location). */
  installId?: string;
  /** SaaS link state (robovoice.io device-code login). */
  link?: RobovoiceLink;
  /** Agents synced into the linked location (default: ["main"]). */
  linkedAgents?: string[];
  linkedCharacters: Record<string, LinkedCharacter>;
  agentOverrides: Record<string, AgentVoiceOverride>;
  /**
   * Public base URL Robovoice's voice agent can reach this gateway on (tunnel /
   * Tailscale Funnel). When set, each linked agent gets an MCP binding to
   * `<url>/plugins/robovoice/agent-mcp` with its own scoped token.
   */
  mcpPublicUrl?: string;
  /** Location whose pipeline the editor shows (default: the linked location). */
  pipelineLocationId?: string;
  /**
   * Caller emails Robovoice may vouch for as the owner (signed-in callers).
   * Everyone else on a voice line is an untrusted caller (W5).
   */
  ownerCallerEmails?: string[];
  /**
   * How gateway-backend voice turns run. "auto" (default): one direct streaming
   * model call for conversation, the full agent only for tool work (after a
   * spoken acknowledgement). "agent": every turn is a full agent run.
   */
  voiceLlmMode?: "auto" | "agent";
  /** `provider/model` for the fast conversational step (default: the agent's model, or its faster sibling). */
  voiceLlmFastModel?: string;
  /** Tools the fast voice step may call for the owner (default: the gateway's voice allowlist). */
  voiceTools?: string[];
  /**
   * Tool budgets, delegation to the main agent and spoken-progress pacing of
   * owner calls (gateway defaults: fast tools 6 s, slow tools 25 s, progress at
   * most every 18 s, delegation on, a call idle for 120 s has ended).
   */
  voiceTiming?: VoiceTimingSettings;
};

export type VoiceTimingSettings = {
  fastToolTimeoutMs?: number;
  slowToolTimeoutMs?: number;
  slowTools?: string[];
  progressIntervalMs?: number;
  delegate?: boolean;
  callIdleMs?: number;
};

/** Settings JSON → timing overrides (the gateway clamps the ranges). */
export function normalizeVoiceTiming(v: unknown): VoiceTimingSettings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : undefined);
  const out: VoiceTimingSettings = {
    fastToolTimeoutMs: num(o.fastToolTimeoutMs),
    slowToolTimeoutMs: num(o.slowToolTimeoutMs),
    slowTools: Array.isArray(o.slowTools)
      ? o.slowTools.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim())
      : undefined,
    progressIntervalMs: num(o.progressIntervalMs),
    delegate: typeof o.delegate === "boolean" ? o.delegate : undefined,
    callIdleMs: num(o.callIdleMs),
  };
  for (const k of Object.keys(out) as Array<keyof VoiceTimingSettings>) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

export type RobovoiceSecrets = {
  deviceKey?: string;
  edgeToken?: string;
  /** agent id → scoped MCP token (`rvib_…`) */
  mcpTokens?: Record<string, string>;
  /** Robovoice location id → scoped voice-LLM callback token (`rvllm_…`). */
  voiceLlmTokens?: Record<string, string>;
};

export type SecretState = { set: boolean; source?: "stored" | "config" | "env"; hint?: string };

/** Curated default — same list the legacy scripts/infinibot-mcp-http.mjs bridge exposes. */
export const DEFAULT_MCP_TOOLS = [
  "notes",
  "kanban",
  "research",
  "workflows",
  "focus",
  "discipline",
  "sessions_list",
  "agents_list",
  "vault",
  "sessions_spawn",
  "claude_coder",
  "sessions_send",
];

/**
 * Tools a voice call may NEVER reach, whatever the allowlist says: `gateway`
 * restarts / reconfigures the gateway; the others hand a voice caller shell or
 * config access.
 */
export const NEVER_MCP_TOOLS = new Set(["gateway", "exec", "process", "bash", "apply_patch", "infinibot_terminal"]);

export const MCP_TOKEN_PREFIX = "rvib_";
export const VOICE_LLM_TOKEN_PREFIX = "rvllm_";

export type SecretCipher = {
  encrypt(plain: string): string | null;
  decrypt(blob: string): string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function strMap<T>(v: unknown, pick: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const key = k.trim();
    const val = pick(x);
    if (key && val !== undefined) out[key] = val;
  }
  return out;
}

function normalizeLink(v: unknown): RobovoiceLink | undefined {
  if (!isRecord(v)) return undefined;
  const apiBase = str(v.apiBase);
  const orgId = str(v.orgId);
  if (!apiBase || !orgId) return undefined;
  return {
    apiBase: apiBase.replace(/\/+$/, ""),
    orgId,
    orgName: str(v.orgName) ?? orgId,
    userEmail: str(v.userEmail),
    locationId: str(v.locationId),
    locationName: str(v.locationName),
    locationSlug: str(v.locationSlug),
    dashboardUrl: str(v.dashboardUrl),
    deviceId: str(v.deviceId),
    deviceName: str(v.deviceName),
    linkedAt: str(v.linkedAt) ?? new Date(0).toISOString(),
    unlinkedAt: str(v.unlinkedAt),
  };
}

export function normalizeSettings(raw: unknown, fallbackBaseUrl?: string): RobovoiceSettings {
  const o = isRecord(raw) ? raw : {};
  const ww = isRecord(o.wakeWord) ? o.wakeWord : undefined;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.map((t) => str(t)).filter((t): t is string => Boolean(t)) : undefined;
  return {
    deployment: o.deployment === "cloud" ? "cloud" : "self-hosted",
    baseUrl: (str(o.baseUrl) ?? fallbackBaseUrl ?? "").replace(/\/+$/, ""),
    deviceId: str(o.deviceId),
    locationId: str(o.locationId),
    expressive: typeof o.expressive === "boolean" ? o.expressive : undefined,
    defaultCharacterId: str(o.defaultCharacterId),
    characterMap: strMap(o.characterMap, str),
    wakeWord: ww ? { engine: str(ww.engine), model: str(ww.model) } : undefined,
    mcpTools: list(o.mcpTools),
    installId: str(o.installId),
    link: normalizeLink(o.link),
    linkedAgents: list(o.linkedAgents),
    linkedCharacters: strMap(o.linkedCharacters, (x) =>
      isRecord(x)
        ? {
            characterId: str(x.characterId),
            robotId: str(x.robotId),
            managed: x.managed !== false,
            syncedAt: str(x.syncedAt),
            error: str(x.error),
          }
        : undefined,
    ),
    agentOverrides: strMap(o.agentOverrides, (x) =>
      isRecord(x)
        ? {
            name: str(x.name),
            language: str(x.language),
            ttsProvider: str(x.ttsProvider),
            voice: str(x.voice),
            greeting: str(x.greeting),
            prompt: str(x.prompt),
            llm: x.llm === "robovoice" ? ("robovoice" as const) : x.llm === "infinibot" ? ("infinibot" as const) : undefined,
            llmBackend: isVoiceLlmBackend(x.llmBackend) ? x.llmBackend : undefined,
          }
        : undefined,
    ),
    mcpPublicUrl: str(o.mcpPublicUrl)?.replace(/\/+$/, ""),
    pipelineLocationId: str(o.pipelineLocationId),
    ownerCallerEmails: list(o.ownerCallerEmails)?.map((e) => e.toLowerCase()),
    voiceLlmMode: o.voiceLlmMode === "agent" ? "agent" : o.voiceLlmMode === "auto" ? "auto" : undefined,
    voiceLlmFastModel: str(o.voiceLlmFastModel),
    voiceTools: list(o.voiceTools),
    voiceTiming: normalizeVoiceTiming(o.voiceTiming),
  };
}

export function maskSecret(v: string): string {
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest();

/** Settings keys that hold objects/maps and must never be persisted as `{}` noise. */
const MAP_KEYS = new Set(["characterMap", "linkedCharacters", "agentOverrides"]);

export class RobovoiceSettingsStore {
  constructor(
    private readonly dir: string,
    /** Plugin config from infinibot.json (declarative defaults). */
    private readonly pluginConfig: Record<string, unknown> = {},
    /** Legacy voice.robovoiceUrl / ROBOVOICE_URL. */
    private readonly legacyUrl?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Encrypts secrets at rest; null = plaintext (tests / hosts without the install key). */
    private readonly cipher: SecretCipher | null = null,
  ) {}

  get directory(): string {
    return this.dir;
  }

  private file(name: string) {
    return path.join(this.dir, name);
  }

  private readJson(name: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), "utf-8"));
    } catch {
      return undefined;
    }
  }

  private writeJson(name: string, value: unknown, mode?: number) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(name)}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: mode ?? 0o644 });
    fs.renameSync(tmp, this.file(name));
  }

  get(): RobovoiceSettings {
    const stored = this.readJson("settings.json");
    const merged = { ...this.pluginConfig, ...(isRecord(stored) ? stored : {}) };
    return normalizeSettings(merged, this.legacyUrl);
  }

  /** Shallow-merge a patch (maps and lists replace wholesale when present; `undefined` clears). */
  update(patch: Partial<RobovoiceSettings>): RobovoiceSettings {
    const stored = this.readJson("settings.json");
    // Persist only what was set explicitly (keeps config/legacy fallbacks
    // live), normalised so garbage never reaches disk.
    const merged: Record<string, unknown> = { ...(isRecord(stored) ? stored : {}), ...patch };
    const clean = normalizeSettings(merged) as unknown as Record<string, unknown>;
    const persisted: Record<string, unknown> = {};
    for (const key of Object.keys(merged)) {
      const v = clean[key];
      if (v === undefined) continue;
      if (key === "baseUrl" && !v) continue;
      if (MAP_KEYS.has(key) && isRecord(v) && Object.keys(v).length === 0 && !(key in patch)) continue;
      persisted[key] = v;
    }
    this.writeJson("settings.json", persisted);
    return this.get();
  }

  /** The install id, minted once and kept forever (relinks reuse the same location). */
  ensureInstallId(): string {
    const cur = this.get().installId;
    if (cur) return cur;
    const id = `ib_${randomBytes(16).toString("base64url")}`;
    this.update({ installId: id });
    return id;
  }

  // --- secrets ---------------------------------------------------------------

  /** Decrypted secret values as stored (no env fallback). */
  private readSecrets(): RobovoiceSecrets {
    const raw = this.readJson("secrets.json");
    const o = isRecord(raw) ? raw : {};
    const dec = (v: unknown): string | undefined => {
      if (typeof v !== "string" || !v) return undefined;
      if (!v.startsWith("enc:")) return str(v); // legacy plaintext
      if (!this.cipher) return undefined;
      return str(this.cipher.decrypt(v.slice(4)) ?? undefined);
    };
    const decMap = (m: unknown): Record<string, string> | undefined => {
      const out: Record<string, string> = {};
      if (isRecord(m)) {
        for (const [k, v] of Object.entries(m)) {
          const t = dec(v);
          if (t) out[k] = t;
        }
      }
      return Object.keys(out).length ? out : undefined;
    };
    return {
      deviceKey: dec(o.deviceKey),
      edgeToken: dec(o.edgeToken),
      mcpTokens: decMap(o.mcpTokens),
      voiceLlmTokens: decMap(o.voiceLlmTokens),
    };
  }

  private writeSecrets(next: RobovoiceSecrets) {
    const enc = (v: string | undefined) => {
      if (!v) return undefined;
      const c = this.cipher?.encrypt(v);
      return c ? `enc:${c}` : v;
    };
    const out: Record<string, unknown> = { v: 2 };
    if (next.deviceKey) out.deviceKey = enc(next.deviceKey);
    if (next.edgeToken) out.edgeToken = enc(next.edgeToken);
    if (next.mcpTokens && Object.keys(next.mcpTokens).length) {
      out.mcpTokens = Object.fromEntries(Object.entries(next.mcpTokens).map(([k, v]) => [k, enc(v)]));
    }
    if (next.voiceLlmTokens && Object.keys(next.voiceLlmTokens).length) {
      out.voiceLlmTokens = Object.fromEntries(Object.entries(next.voiceLlmTokens).map(([k, v]) => [k, enc(v)]));
    }
    this.writeJson("secrets.json", out, 0o600);
    try {
      fs.chmodSync(this.file("secrets.json"), 0o600);
    } catch {
      // non-POSIX filesystem
    }
  }

  secrets(): RobovoiceSecrets {
    const s = this.readSecrets();
    return {
      // stored > write-only plugin config (Setup › Plugins › Settings) > env
      deviceKey:
        s.deviceKey ?? str(this.pluginConfig.deviceKey) ?? str(this.env.ROBOVOICE_DEVICE_KEY),
      edgeToken:
        s.edgeToken ?? str(this.pluginConfig.edgeToken) ?? str(this.env.ROBOVOICE_EDGE_TOKEN),
      mcpTokens: s.mcpTokens,
      voiceLlmTokens: s.voiceLlmTokens,
    };
  }

  /** True when every stored secret is encrypted at rest. */
  secretsEncrypted(): boolean {
    const raw = this.readJson("secrets.json");
    if (!isRecord(raw)) return true;
    const vals: unknown[] = [
      raw.deviceKey,
      raw.edgeToken,
      ...(isRecord(raw.mcpTokens) ? Object.values(raw.mcpTokens) : []),
      ...(isRecord(raw.voiceLlmTokens) ? Object.values(raw.voiceLlmTokens) : []),
    ];
    return vals.every((v) => v === undefined || (typeof v === "string" && v.startsWith("enc:")));
  }

  secretState(): Record<"deviceKey" | "edgeToken", SecretState> {
    const s = this.readSecrets();
    const one = (key: "deviceKey" | "edgeToken", envName: string): SecretState => {
      const stored = s[key];
      if (stored) return { set: true, source: "stored", hint: maskSecret(stored) };
      // Setup › Plugins › Settings writes write-only secrets into the plugin config.
      const configured = str(this.pluginConfig[key]);
      if (configured) return { set: true, source: "config", hint: maskSecret(configured) };
      const env = str(this.env[envName]);
      if (env) return { set: true, source: "env", hint: maskSecret(env) };
      return { set: false };
    };
    return {
      deviceKey: one("deviceKey", "ROBOVOICE_DEVICE_KEY"),
      edgeToken: one("edgeToken", "ROBOVOICE_EDGE_TOKEN"),
    };
  }

  /** Set (string) or clear (null) secrets; undefined leaves a secret untouched. */
  setSecrets(patch: { deviceKey?: string | null; edgeToken?: string | null }): void {
    const next = this.readSecrets();
    for (const key of ["deviceKey", "edgeToken"] as const) {
      const v = patch[key];
      if (v === null || v === "") delete next[key];
      else if (typeof v === "string") next[key] = v.trim();
    }
    this.writeSecrets(next);
  }

  // --- per-agent MCP tokens -----------------------------------------------------

  /** The agent's scoped MCP token, minted on first use. */
  ensureMcpToken(agentId: string): string {
    const s = this.readSecrets();
    const cur = s.mcpTokens?.[agentId];
    if (cur) return cur;
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.writeSecrets({ ...s, mcpTokens: { ...(s.mcpTokens ?? {}), [agentId]: token } });
    return token;
  }

  /** Forget agents' MCP tokens (all when `agentIds` is omitted). Rotates on next sync. */
  revokeMcpTokens(agentIds?: string[]): void {
    const s = this.readSecrets();
    if (!s.mcpTokens) return;
    const tokens = { ...s.mcpTokens };
    for (const id of agentIds ?? Object.keys(tokens)) delete tokens[id];
    this.writeSecrets({ ...s, mcpTokens: tokens });
  }

  /** Which agent a presented MCP token belongs to (constant-time compare), or null. */
  agentForMcpToken(presented: string | undefined | null): string | null {
    if (!presented || !presented.startsWith(MCP_TOKEN_PREFIX)) return null;
    const want = hashToken(presented);
    let hit: string | null = null;
    for (const [agentId, token] of Object.entries(this.readSecrets().mcpTokens ?? {})) {
      if (timingSafeEqual(hashToken(token), want)) hit = agentId;
    }
    return hit;
  }

  // --- per-location voice-LLM callback tokens ---------------------------------

  /** The location's voice-LLM token, minted on first use. */
  ensureVoiceLlmToken(locationId: string): string {
    const s = this.readSecrets();
    const cur = s.voiceLlmTokens?.[locationId];
    if (cur) return cur;
    return this.rotateVoiceLlmToken(locationId);
  }

  /** Mint a fresh token for the location (the old one stops working immediately). */
  rotateVoiceLlmToken(locationId: string): string {
    const s = this.readSecrets();
    const token = `${VOICE_LLM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.writeSecrets({ ...s, voiceLlmTokens: { ...(s.voiceLlmTokens ?? {}), [locationId]: token } });
    return token;
  }

  /** Forget locations' voice-LLM tokens (all when omitted). */
  revokeVoiceLlmTokens(locationIds?: string[]): void {
    const s = this.readSecrets();
    if (!s.voiceLlmTokens) return;
    const tokens = { ...s.voiceLlmTokens };
    for (const id of locationIds ?? Object.keys(tokens)) delete tokens[id];
    this.writeSecrets({ ...s, voiceLlmTokens: tokens });
  }

  /** Masked hint per location (for the UI; never the token). */
  voiceLlmTokenState(): Record<string, { hint: string }> {
    return Object.fromEntries(
      Object.entries(this.readSecrets().voiceLlmTokens ?? {}).map(([k, v]) => [k, { hint: maskSecret(v) }]),
    );
  }

  /** Which location a presented voice-LLM token belongs to (constant-time compare), or null. */
  locationForVoiceLlmToken(presented: string | undefined | null): string | null {
    if (!presented || !presented.startsWith(VOICE_LLM_TOKEN_PREFIX)) return null;
    const want = hashToken(presented);
    let hit: string | null = null;
    for (const [loc, token] of Object.entries(this.readSecrets().voiceLlmTokens ?? {})) {
      if (timingSafeEqual(hashToken(token), want)) hit = loc;
    }
    return hit;
  }

  /** Drop every secret (logout). */
  clearSecrets(): void {
    this.writeSecrets({});
  }
}
