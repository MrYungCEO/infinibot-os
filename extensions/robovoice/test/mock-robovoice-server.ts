/**
 * Mock Robovoice deployment for tests and the isolated side-gateway check.
 * Implements the HTTP surface the plugin uses, with Robovoice's real shapes
 * (Robovoice-Prod frontend/app/api/**). NEVER point tests at the live stack.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LOCATION_CHARACTER_FIELDS, LOCATION_DEFAULT_FIELDS } from "../src/pipeline.js";

export type MockCharacter = {
  id: string;
  name: string;
  description?: string;
  tts_provider?: string;
  /** TTS voice id surfaced by /api/call/pipeline. */
  voice?: string;
  /** Private (never on the public roster). */
  system_prompt?: string;
  language?: string;
  agent_location_id?: string;
  agent_location_name?: string;
};

export type MockRobovoiceOptions = {
  characters?: MockCharacter[];
  /**
   * What the PUBLIC, unauthenticated /api/call/characters answers: on a real
   * Robovoice that is the deployment owner's roster (RoboPark's Magnus & co.),
   * NOT the linked org's. Default: the org roster (older tests).
   */
  publicCharacters?: MockCharacter[];
  /**
   * Model Robovoice's InfiniBot link enforcement on /api/connection-details
   * (fix/link-enforce): a request marked `x-robovoice-client: infinibot` must
   * come from a live InfiniBot link's device with its key and name one of the
   * org's characters; a non-InfiniBot anonymous request falls back to the
   * public (owner) roster like the real route. Default true.
   */
  enforceInfinibotLink?: boolean;
  /** Require this edge token (Bearer) on connection-details + /api/edge/me. */
  edgeToken?: string;
  /** Wallet reported by /api/edge/me; null = endpoint omits wallet. */
  wallet?: { balance_usd: number; held_usd: number; available_usd: number; month_minutes?: number } | null;
  /** Force 402 insufficient_balance on connection-details (a credit gate turned back on). */
  insufficientBalance?: boolean;
  /** Force 429 cloud_voice_busy on connection-details (Robovoice's fair-use daily limit). */
  cloudVoiceBusy?: boolean;
  livekitUrl?: string;
  health?: "ok" | "degraded";
  /** Device-code login: approve automatically after this many token polls (default 1; 0 = never). */
  approveAfterPolls?: number;
  /** Org the mock signs everyone into. */
  org?: { id: string; name: string };
  /** Pretend this org is the deployment owner (MCP bindings allowed). Default true. */
  ownerOrg?: boolean;
  /** Robovoice Desktop devices online in the org (for mode=local calls). */
  desktops?: Array<{ device_id: string; name: string; hostname: string }>;
  /** Call lifecycle per room in GET /calls polls: [waitingPolls, livePolls]. Default [1, 2]. */
  callScript?: [number, number];
  /** Seconds billed per finished call. Default 42. */
  callSeconds?: number;
  /** Starting spendable wallet credits. Default 2450 (0 = wallet empty). */
  walletCredits?: number;
};

export type MockLinkState = {
  installId: string;
  locationId: string;
  deviceId: string;
  unlinkedAt: string | null;
  agents: Record<string, { robot_id: string; persona_id: string | null; character_id: string; name: string; linked_character: boolean; synced_at: string }>;
  mcp: Record<string, unknown>;
};

export type MockEdgeState = {
  tokens: Set<string>;
  authRequests: Map<string, { userCode: string; status: "pending" | "approved" | "denied" | "consumed"; polls: number }>;
  locations: Array<{ id: string; name: string; slug: string }>;
  devices: Map<string, { device_id: string; name: string; location_id: string; revoked: boolean; key: string; client_version?: string; hostname?: string }>;
  links: Map<string, MockLinkState>;
  roster: MockCharacter[];
  mcpRegistry: Array<Record<string, unknown>>;
  characterMcp: Record<string, string[]>;
  calls: Map<string, { polls: number; startedAt: string; settled: boolean; mode: string; command?: Record<string, unknown> }>;
  walletCredits: number;
  commands: Array<{ device_id: string; kind: string; character_id?: string }>;
  /** Org-level pipeline (settings.json / org doc pipeline fields). */
  orgPipeline: Record<string, unknown>;
  /** location_configs.json: { <locId>: { defaults, characters, updated_at } } */
  locationConfigs: Record<string, { defaults: Record<string, unknown>; characters: Record<string, Record<string, unknown>>; updated_at?: string }>;
  /** Per-character pipeline fields (llm_provider / llm_model / stt_* …) set by sync. */
  characterPipeline: Record<string, Record<string, unknown>>;
  /** Voice-LLM callback binding per location (PROPOSED Robovoice-side store). */
  voiceLlm: Record<string, { base_url: string; token: string; agents: string[] }>;
  /** Result of the last simulated voice turn (/__mock/voice-turn). */
  lastTurn?: Record<string, unknown>;
};

/** Robovoice's allowed providers per stage (frontend/lib/location-config.ts) + the proposed "infinibot" LLM. */
export const MOCK_PROVIDERS = {
  stt: [
    { id: "speaches", label: "Speaches (self-hosted Whisper)", local: true, available: true },
    { id: "groq", label: "Groq Whisper", available: true },
    { id: "fal", label: "fal", available: false, hint: "no organization API key" },
  ],
  llm: [
    { id: "groq", label: "Groq", available: true },
    { id: "openrouter", label: "OpenRouter", available: true },
    { id: "ollama", label: "Ollama", local: true, available: true },
    { id: "gemini", label: "Gemini", available: false, hint: "no organization API key" },
    { id: "infinibot", label: "InfiniBot", available: true, hint: "answers via the linked InfiniBot gateway" },
  ],
  tts: [
    { id: "kokoro", label: "Kokoro", local: true, available: true },
    { id: "elevenlabs", label: "ElevenLabs", available: true },
    { id: "piper", label: "Piper", local: true, available: true },
  ],
};

export const MOCK_OPTIONS = {
  stt: {
    speaches: [{ id: "Systran/faster-whisper-small" }, { id: "deepdml/faster-whisper-large-v3-turbo-ct2" }],
    groq: [{ id: "whisper-large-v3" }, { id: "whisper-large-v3-turbo" }],
  },
  llm: {
    groq: [{ id: "llama-3.3-70b-versatile" }, { id: "openai/gpt-oss-120b" }],
    openrouter: [{ id: "google/gemini-2.5-flash" }, { id: "anthropic/claude-haiku-4.5" }],
    ollama: [{ id: "qwen3:8b" }],
  },
  tts: {
    kokoro: [{ id: "af_heart", name: "Heart (US F)" }, { id: "am_puck", name: "Puck (US M)" }, { id: "bf_emma", name: "Emma (UK F)" }],
    elevenlabs: [{ id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" }, { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" }],
    piper: [{ id: "en_US-amy-medium", name: "Amy" }],
  },
};

// Same allowlists as Robovoice (mirrored in src/pipeline.ts).
const DEFAULT_ALLOWED = [...LOCATION_DEFAULT_FIELDS];
const CHARACTER_ALLOWED = [...LOCATION_CHARACTER_FIELDS];

export const DEFAULT_MOCK_CHARACTERS: MockCharacter[] = [
  { id: "char-ash", name: "Ash", description: "Operator assistant", tts_provider: "elevenlabs", voice: "onwK4e9ZLuTAKqWW03F9" },
  { id: "char-kate", name: "Kate Mint", description: "Front desk", tts_provider: "kokoro", voice: "af_heart" },
  { id: "char-lab", name: "Lab Piper", description: "Self-host test voice", tts_provider: "piper", voice: "en_US-lessac-medium" },
];

export type MockRobovoice = {
  url: string;
  close: () => Promise<void>;
  /** Every request seen, for assertions. */
  requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown; auth?: string }>;
  options: MockRobovoiceOptions;
  edge: MockEdgeState;
};

function b64url(s: string) {
  return Buffer.from(s).toString("base64url");
}

export async function startMockRobovoice(
  options: MockRobovoiceOptions = {},
  port = 0,
  host = "127.0.0.1",
): Promise<MockRobovoice> {
  const requests: MockRobovoice["requests"] = [];
  const opts = options;
  const org = opts.org ?? { id: "11111111-2222-4333-8444-555555555555", name: "Mock Org" };
  const edge: MockEdgeState = {
    tokens: new Set(opts.edgeToken ? [opts.edgeToken] : []),
    authRequests: new Map(),
    locations: [{ id: "loc-lobby", name: "Lobby", slug: "mock-lobby" }],
    devices: new Map(),
    links: new Map(),
    roster: [...(opts.characters ?? DEFAULT_MOCK_CHARACTERS)],
    mcpRegistry: [],
    characterMcp: {},
    calls: new Map(),
    walletCredits: opts.walletCredits ?? 2450,
    commands: [],
    orgPipeline: {
      stt_provider: "speaches",
      stt_language: "en",
      stt_model_speaches: "Systran/faster-whisper-small",
      stt_model_groq: "whisper-large-v3-turbo",
      llm_provider: "groq",
      groq_model: "llama-3.3-70b-versatile",
      openrouter_model: "google/gemini-2.5-flash",
      temperature: 0.7,
      tts_provider: "kokoro",
      tts_voice_kokoro: "af_heart",
      tts_voice_elevenlabs: "onwK4e9ZLuTAKqWW03F9",
    },
    locationConfigs: {},
    characterPipeline: {},
    voiceLlm: {},
  };
  for (const d of opts.desktops ?? []) {
    edge.devices.set(d.device_id, {
      device_id: d.device_id,
      name: d.name,
      location_id: "loc-lobby",
      revoked: false,
      key: "desktop-key",
      client_version: "desktop-0.3.0",
      hostname: d.hostname,
    });
  }
  const chars = () => edge.roster;
  const credits = () => ({
    credit_usd: 0.01,
    balance_credits: edge.walletCredits + 50,
    available_credits: edge.walletCredits,
    held_credits: 50,
    balance_usd: (edge.walletCredits + 50) * 0.01,
    plan: "prepaid",
    enforcement: "enforce",
    low_balance_state: edge.walletCredits <= 0 ? "empty" : edge.walletCredits < 300 ? "low" : "ok",
    standard_credits_per_second: 1,
  });
  const id = () => randomBytes(8).toString("hex");

  let listenUrl = "";
  const baseUrl = () => listenUrl;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://mock");
    let raw = "";
    for await (const c of req) raw += c;
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const auth = req.headers.authorization;
    requests.push({
      method: req.method ?? "GET",
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body,
      auth: typeof auth === "string" ? auth : undefined,
    });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    };
    const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
    const edgeOk = !opts.edgeToken || edge.tokens.has(bearer);
    const signedIn = edge.tokens.has(bearer);
    const b = (body ?? {}) as Record<string, unknown>;

    switch (u.pathname) {
      case "/api/health":
        return json(opts.health === "degraded" ? 503 : 200, {
          status: opts.health ?? "ok",
          agent: { status: "ok" },
          active_sessions: null,
        });
      case "/api/call/characters": {
        const pub = opts.publicCharacters ?? chars();
        return json(200, {
          characters: pub.map(({ voice: _v, system_prompt: _p, ...c }) => c),
          active_character_id: pub[0]?.id ?? null,
          default_character_id: pub[0]?.id ?? null,
          default_source: "global",
          registered_device: false,
        });
      }
      case "/api/call/pipeline": {
        const id = u.searchParams.get("character") ?? chars()[0]?.id;
        const c = chars().find((x) => x.id === id);
        if (!c) return json(200, { character_id: id, resolved: false });
        return json(200, {
          character_id: c.id,
          location_id: u.searchParams.get("location"),
          mode: "livekit",
          stt: { provider: "speaches", model: "Systran/faster-whisper-small", state: "ready" },
          llm: { provider: "groq", model: "llama-3.3-70b-versatile", state: "ready" },
          tts: { provider: c.tts_provider ?? "kokoro", model: c.voice ?? null, state: "ready" },
          expressive: false,
          resolved: true,
        });
      }
      case "/api/connection-details": {
        if (req.method !== "POST") return json(405, { error: "Method not allowed" });
        const devKey = (body as { device_id?: string; device_key?: string } | null) ?? {};
        const deviceOk = !!devKey.device_id && edge.devices.get(devKey.device_id)?.key === devKey.device_key && !edge.devices.get(devKey.device_id)?.revoked;
        const requested = u.searchParams.get("character");
        const fromInfinibot = req.headers["x-robovoice-client"] === "infinibot";
        let c: MockCharacter | undefined;
        let orgId: string | null = null;
        if (fromInfinibot && opts.enforceInfinibotLink !== false) {
          // Robovoice fix/link-enforce: InfiniBot calls need a live link device + an org character.
          const linkRow = [...edge.links.values()].find((l) => l.deviceId === devKey.device_id && !l.unlinkedAt);
          if (!deviceOk || !linkRow) {
            return json(401, { error: "infinibot_not_linked", message: "This InfiniBot install isn't linked to a Robovoice organization." });
          }
          c = chars().find((x) => x.id === requested);
          if (!c) return json(404, { error: "character_not_in_org", message: "That character is not one of this organization's agents." });
          orgId = org.id;
        } else {
          if (!edgeOk && !deviceOk) return json(401, { error: "unauthorized" });
          // The real route's anonymous fallback: requested → first of the deployment's roster.
          const pub = opts.publicCharacters ?? chars();
          c = pub.find((x) => x.id === requested) ?? pub[0];
        }
        if (opts.cloudVoiceBusy) {
          return json(429, { error: "cloud_voice_busy", message: "Cloud voice is busy right now. Switch to local voice to keep talking." });
        }
        if (opts.insufficientBalance) {
          return json(402, { error: "insufficient_balance", message: "This account is out of Robovoice credit.", available_usd: 0.03 });
        }
        if (!c) return json(503, { error: "No voice agents are configured" });
        const device =
          u.searchParams.get("device") ?? (body as { device_id?: string } | null)?.device_id ?? "anon-device";
        // Robovoice places the billing hold on this room (real: billing_holds.room);
        // GET /api/edge/infinibot/calls?room= then reports it live.
        if (!edge.calls.has(`robopark-${device}`)) {
          edge.calls.set(`robopark-${device}`, { polls: 0, startedAt: new Date().toISOString(), settled: false, mode: "cloud" });
        }
        const token = [
          b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
          b64url(JSON.stringify({ sub: "user", video: { room: `robopark-${device}` }, metadata: JSON.stringify({ character_id: c.id, device_id: device, ...(orgId ? { org_id: orgId, billing_hold_id: `hold-${device}` } : {}) }) })),
          "mock-signature",
        ].join(".");
        return json(200, {
          serverUrl: opts.livekitUrl ?? "wss://mock-livekit.robovoice.test",
          roomName: `robopark-${device}`,
          participantName: "user",
          participantToken: token,
        });
      }
      case "/api/edge/me": {
        if (!signedIn) return json(401, { error: "unauthorized" });
        return json(200, {
          org,
          user: { email: "owner@mock.test" },
          ...(opts.wallet === null ? {} : { credits: credits() }),
          locations: edge.locations,
          agents: chars().map((c) => ({ id: c.id, name: c.name })),
          devices: [...edge.devices.values()].filter((d) => !d.revoked).length,
        });
      }
      // Mock-only introspection for the side-gateway e2e (never on a real Robovoice).
      // Mock-only: set the wallet (side-gateway wallet-empty check).
      case "/__mock/wallet": {
        const n = Number((b as { credits?: unknown }).credits);
        if (!Number.isFinite(n)) return json(400, { error: "expected { credits }" });
        edge.walletCredits = Math.floor(n);
        return json(200, { ok: true, walletCredits: edge.walletCredits });
      }
      case "/__mock/state":
        return json(200, {
          locations: edge.locations,
          devices: [...edge.devices.values()].map(({ key: _k, ...d }) => d),
          links: [...edge.links.values()],
          mcpRegistry: edge.mcpRegistry,
          commands: edge.commands,
          walletCredits: edge.walletCredits,
          locationConfigs: edge.locationConfigs,
          characterPipeline: edge.characterPipeline,
          voiceLlm: Object.fromEntries(Object.entries(edge.voiceLlm).map(([k, v]) => [k, { base_url: v.base_url, agents: v.agents, token: `${v.token.slice(0, 8)}…` }])),
          lastTurn: edge.lastTurn ?? null,
        });
      // Test harness only: the full voice-LLM token the mock agent calls back with
      // (voice-latency-e2e.sh drives the callback itself to time each stage).
      case "/__mock/voice-llm-token":
        return json(200, Object.fromEntries(Object.entries(edge.voiceLlm).map(([k, v]) => [k, v.token])));
      // ── device-code login ────────────────────────────────────────────────
      case "/api/edge/auth/start": {
        const deviceCode = randomBytes(24).toString("base64url");
        const userCode = `MOCK-${randomBytes(2).toString("hex").toUpperCase()}`;
        edge.authRequests.set(deviceCode, { userCode, status: "pending", polls: 0 });
        const verification = `${baseUrl()}/edge/activate`;
        return json(200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verification,
          verification_uri_complete: `${verification}?code=${userCode}`,
          expires_in: 600,
          interval: 1,
        });
      }
      case "/api/edge/auth/approve": {
        for (const r of edge.authRequests.values())
          if (r.userCode === b.code && r.status === "pending") r.status = b.approve === false ? "denied" : "approved";
        return json(200, { ok: true });
      }
      case "/api/edge/auth/token": {
        const r = edge.authRequests.get(String(b.device_code ?? ""));
        if (!r) return json(400, { error: "invalid_grant" });
        r.polls += 1;
        const after = opts.approveAfterPolls ?? 1;
        if (r.status === "pending" && after > 0 && r.polls >= after) r.status = "approved";
        if (r.status === "denied") return json(400, { error: "access_denied" });
        if (r.status === "consumed") return json(400, { error: "expired_token" });
        if (r.status === "pending") return json(400, { error: "authorization_pending" });
        r.status = "consumed";
        const token = `rve_mock_${randomBytes(16).toString("hex")}`;
        edge.tokens.add(token);
        return json(200, { access_token: token, token_type: "bearer", org, user: { email: "owner@mock.test" } });
      }
      case "/api/edge/auth/logout": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        edge.tokens.delete(bearer);
        return json(200, { ok: true });
      }
      // ── InfiniBot installs ───────────────────────────────────────────────
      case "/api/edge/infinibot/link": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        const installId = String(b.install_id ?? u.searchParams.get("install_id") ?? "");
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(installId)) return json(400, { error: "install_id must be 8–80 letters, digits, - or _" });
        const link = edge.links.get(installId);
        if (req.method === "GET") {
          if (!link) return json(200, { linked: false, org, credits: credits(), user: { email: "owner@mock.test" } });
          const loc = edge.locations.find((l) => l.id === link.locationId) ?? null;
          const d = edge.devices.get(link.deviceId);
          return json(200, {
            linked: !link.unlinkedAt && !!loc,
            unlinked_at: link.unlinkedAt,
            org,
            user: { email: "owner@mock.test" },
            install_id: installId,
            location: loc ? { ...loc, dashboard_url: `${baseUrl()}/l/${loc.slug}/fleet` } : null,
            location_missing: !loc,
            device: d
              ? { device_id: d.device_id, name: d.name, state: d.revoked ? "revoked" : "online", online: !d.revoked, last_seen_at: null, location: loc, call: null }
              : null,
            agents: link.agents,
            mcp: link.mcp,
            credits: credits(),
          });
        }
        if (req.method === "DELETE") {
          if (!link) return json(200, { ok: true, already: true });
          const d = edge.devices.get(link.deviceId);
          if (d) d.revoked = true;
          link.unlinkedAt = new Date().toISOString();
          return json(200, { ok: true, device_revoked: link.deviceId, location_kept: link.locationId, agents_kept: Object.keys(link.agents) });
        }
        // POST: create-or-reuse location + device
        const hostname = typeof b.hostname === "string" ? b.hostname : "install";
        let loc = link ? edge.locations.find((l) => l.id === link.locationId) : undefined;
        let created = false;
        if (!loc) {
          let name = `InfiniBot · ${hostname}`;
          for (let i = 2; edge.locations.some((l) => l.name.toLowerCase() === name.toLowerCase()); i++) name = `InfiniBot · ${hostname} (${i})`;
          loc = { id: `loc-${id()}`, name, slug: `infinibot-${hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${edge.locations.length}` };
          edge.locations.push(loc);
          created = true;
        }
        const deviceId = `infinibot-${createHash("sha256").update(`${org.id}:${installId}`).digest("hex").slice(0, 16)}`;
        const prior = edge.devices.get(deviceId);
        const key = createHash("sha256").update(`devkey:${deviceId}`).digest("base64url").slice(0, 32);
        edge.devices.set(deviceId, { device_id: deviceId, name: `InfiniBot · ${hostname}`, location_id: loc.id, revoked: false, key, hostname });
        const next: MockLinkState = link ?? { installId, locationId: loc.id, deviceId, unlinkedAt: null, agents: {}, mcp: {} };
        next.locationId = loc.id;
        next.deviceId = deviceId;
        next.unlinkedAt = null;
        edge.links.set(installId, next);
        return json(200, {
          ok: true,
          org,
          install_id: installId,
          location: { ...loc, created, dashboard_url: `${baseUrl()}/l/${loc.slug}/fleet` },
          device: {
            device_id: deviceId,
            device_key: key,
            name: `InfiniBot · ${hostname}`,
            kiosk_url: `${baseUrl()}/call/${deviceId}?mode=voice&device_key=${key}`,
            created: !prior,
            restored: !!prior?.revoked,
          },
          agents: next.agents,
          credits: credits(),
        });
      }
      case "/api/edge/infinibot/agents": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        const link = edge.links.get(String(b.install_id ?? ""));
        if (!link || link.unlinkedAt) return json(409, { error: "This InfiniBot install is not linked — run `infinibot robovoice login`" });
        const loc = edge.locations.find((l) => l.id === link.locationId)!;
        const results: Array<Record<string, unknown>> = [];
        for (const a of (Array.isArray(b.agents) ? b.agents : []) as Array<Record<string, unknown>>) {
          const agentId = String(a.agent_id ?? "");
          const prior = link.agents[agentId];
          let characterId: string;
          let linkedChar = false;
          if (typeof a.character_id === "string" && a.character_id) {
            const c = edge.roster.find((x) => x.id === a.character_id);
            if (!c) {
              results.push({ agent_id: agentId, ok: false, error: `Character "${a.character_id}" is not in this organization` });
              continue;
            }
            characterId = c.id;
            linkedChar = true;
          } else {
            characterId = prior && !prior.linked_character ? prior.character_id : `ib${id()}`;
            const existing = edge.roster.find((x) => x.id === characterId);
            const next = {
              id: characterId,
              name: String(a.name ?? agentId),
              description: typeof a.description === "string" ? a.description : undefined,
              tts_provider: typeof a.tts_provider === "string" ? a.tts_provider : "kokoro",
              voice: typeof a.tts_voice_kokoro === "string" ? a.tts_voice_kokoro : "af_heart",
              system_prompt: typeof a.system_prompt === "string" ? a.system_prompt : undefined,
              language: typeof a.language === "string" ? a.language : undefined,
              agent_location_id: loc.id,
              agent_location_name: loc.name,
            } as MockCharacter;
            if (existing) Object.assign(existing, next);
            else edge.roster.push(next);
          }
          link.agents[agentId] = {
            robot_id: prior?.robot_id ?? `robot-${id()}`,
            persona_id: linkedChar ? null : characterId,
            character_id: characterId,
            name: String(a.name ?? agentId),
            linked_character: linkedChar,
            synced_at: new Date().toISOString(),
          };
          results.push({ agent_id: agentId, ok: true, character_id: characterId, created: !prior });
        }
        const removed: string[] = [];
        for (const r of (Array.isArray(b.remove) ? b.remove : []) as string[]) {
          if (link.agents[r]) {
            delete link.agents[r];
            removed.push(r);
          }
        }
        const m = b.mcp as { url?: string; tokens?: Record<string, string> } | undefined;
        let mcp: Record<string, unknown> = { status: "off", url: null, agents: [] };
        if (m?.url) {
          if (opts.ownerOrg === false) mcp = { status: "unsupported", url: m.url, agents: [], error: "owner organization only" };
          else {
            const bound: string[] = [];
            for (const [agentId, a] of Object.entries(link.agents)) {
              const token = m.tokens?.[agentId];
              if (!token) continue;
              const rid = `infinibot-${agentId}`;
              edge.mcpRegistry = edge.mcpRegistry.filter((x) => x.id !== rid);
              edge.mcpRegistry.push({ id: rid, url: `${m.url}?agent=${agentId}`, auth_token: token, transport: "streamable_http", enabled: true });
              edge.characterMcp[a.character_id] = [rid];
              bound.push(agentId);
            }
            mcp = { status: bound.length ? "bound" : "off", url: m.url, agents: bound };
          }
        }
        link.mcp = mcp;
        // Per-character LLM step (proposed): llm_provider "infinibot" + llm_model "infinibot:<agent>".
        for (const a of (Array.isArray(b.agents) ? b.agents : []) as Array<Record<string, unknown>>) {
          const row = link.agents[String(a.agent_id ?? "")];
          if (!row) continue;
          const cp = (edge.characterPipeline[row.character_id] ??= {});
          if (typeof a.llm_provider === "string" && a.llm_provider) {
            cp.llm_provider = a.llm_provider;
            cp.llm_model = a.llm_model;
          } else {
            delete cp.llm_provider;
            delete cp.llm_model;
          }
        }
        const vl = b.voice_llm as { base_url?: string; token?: string; location_id?: string } | undefined;
        let voiceLlm: Record<string, unknown> = { status: "off", base_url: null, agents: [] };
        if (vl?.base_url && vl.token) {
          const agents = Object.entries(link.agents)
            .filter(([, a]) => edge.characterPipeline[a.character_id]?.llm_provider === "infinibot")
            .map(([aid]) => aid);
          edge.voiceLlm[loc.id] = { base_url: vl.base_url, token: vl.token, agents };
          voiceLlm = { status: "bound", base_url: vl.base_url, agents };
        } else delete edge.voiceLlm[loc.id];
        return json(200, { ok: results.every((r) => r.ok), location: loc, results, removed, agents: link.agents, mcp, voice_llm: voiceLlm });
      }
      // Model catalog (GET /api/edge/infinibot/catalog?stage=): tiered choices + credits/min per tier.
      case "/api/edge/infinibot/catalog": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        const stage = u.searchParams.get("stage");
        if (stage !== "stt" && stage !== "llm" && stage !== "tts") return json(400, { error: "stage must be stt, llm or tts" });
        const tierOf = (provider: string) => (provider === "elevenlabs" ? "premium" : "standard");
        const models = Object.entries(MOCK_OPTIONS[stage] ?? {}).flatMap(([provider, list]) =>
          list.map((m) => ({ key: `${provider}:${m.id}`, provider, model: m.id, name: m.name ?? m.id, note: "", family: provider, tier: tierOf(provider), patch: {} })),
        );
        const tiers = (["standard", "premium", "expressive"] as const).map((tier) => {
          const inTier = models.filter((m) => m.tier === tier);
          return { tier, blurb: "", count: inTier.length, families: inTier.length ? [{ family: stage, models: inTier }] : [] };
        });
        return json(200, { stage, tiers, total: models.length, admin_only: [], prices: { standard: 60, premium: 120, expressive: 220 } });
      }
      // PROPOSED edge route: location pipeline config for an rve_ token holder
      // (same shape/semantics as Clerk-only GET|PATCH /api/location/[id]/config).
      case "/api/edge/infinibot/pipeline": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        const locId = u.searchParams.get("location") ?? "";
        const loc = edge.locations.find((l) => l.id === locId);
        if (!loc) return json(404, { error: "location not found" });
        const entry = (edge.locationConfigs[locId] ??= { defaults: {}, characters: {} });
        if (req.method === "PATCH") {
          const setOrClear = (target: Record<string, unknown>, patch: unknown, allowed: string[], scope: string) => {
            if (!patch || typeof patch !== "object") throw new Error(`${scope} must be an object`);
            for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
              if (!allowed.includes(k)) throw new Error(`${scope}: ${k} is not a location field`);
              if (k.endsWith("_provider") && v !== null && v !== "") {
                const stage = k.split("_")[0] as "stt" | "llm" | "tts";
                const prov = MOCK_PROVIDERS[stage]?.find((x) => x.id === v);
                if (!prov) throw new Error(`${scope}.${k}: unknown provider ${String(v)}`);
                if (!prov.available) throw new Error(`${scope}.${k}: ${prov.label} — no organization API key`);
                if (v === "infinibot" && !edge.voiceLlm[locId]) throw new Error(`${scope}.${k}: no InfiniBot voice-LLM binding at this location`);
              }
              if (v === null || v === "") delete target[k];
              else target[k] = v;
            }
          };
          try {
            if (b.defaults !== undefined) setOrClear(entry.defaults, b.defaults, DEFAULT_ALLOWED, "defaults");
            if (b.characters !== undefined) {
              for (const [cid, o] of Object.entries((b.characters ?? {}) as Record<string, unknown>)) {
                if (!edge.roster.some((c) => c.id === cid)) return json(409, { error: `character ${cid} is not in the roster` });
                if (o === null) {
                  delete entry.characters[cid];
                  continue;
                }
                const t = (entry.characters[cid] ??= {});
                setOrClear(t, o, CHARACTER_ALLOWED, `characters.${cid}`);
                if (Object.keys(t).length === 0) delete entry.characters[cid];
              }
            }
          } catch (err) {
            return json(400, { error: err instanceof Error ? err.message : String(err) });
          }
          entry.updated_at = new Date().toISOString();
          return json(200, { ok: true, defaults: entry.defaults, characters: entry.characters });
        }
        const atLocation = edge.roster.filter((c) => !c.agent_location_id || c.agent_location_id === locId);
        const agentIdByChar: Record<string, string> = {};
        for (const l of edge.links.values()) for (const [aid, a] of Object.entries(l.agents)) agentIdByChar[a.character_id] = aid;
        return json(200, {
          locationId: loc.id,
          locationName: loc.name,
          callable: true,
          permissions: { canEditPipeline: true, canEditPrompt: true },
          providers: MOCK_PROVIDERS,
          org: edge.orgPipeline,
          defaults: entry.defaults,
          updatedAt: entry.updated_at ?? null,
          characters: atLocation.map((c) => ({
            id: c.id,
            name: c.name,
            own: {
              tts_provider: c.tts_provider ?? "kokoro",
              [`tts_voice_${c.tts_provider ?? "kokoro"}`]: c.voice,
              language: c.language,
              ...(edge.characterPipeline[c.id] ?? {}),
            },
            override: entry.characters[c.id] ?? {},
            infinibot_agent_id: agentIdByChar[c.id] ?? null,
          })),
          options: MOCK_OPTIONS,
          voiceLlm: edge.voiceLlm[locId] ? { status: "bound", base_url: edge.voiceLlm[locId].base_url } : { status: "off", base_url: null },
        });
      }
      // Mock-only: what Robovoice's voice agent does for one turn when the
      // character's LLM step is InfiniBot (resolve pipeline → call the bound
      // OpenAI-compatible callback → read the SSE stream). Never on a real Robovoice.
      case "/__mock/voice-turn": {
        const charId = String(b.character_id ?? "");
        const text = String(b.text ?? "");
        const room = String(b.room ?? `robopark-mock-${id()}`);
        const c = edge.roster.find((x) => x.id === charId);
        if (!c) return json(404, { error: "no such character" });
        const locId = c.agent_location_id ?? "";
        const pipe = { ...edge.orgPipeline, ...(edge.locationConfigs[locId]?.defaults ?? {}), ...(edge.characterPipeline[c.id] ?? {}), ...(edge.locationConfigs[locId]?.characters[c.id] ?? {}) };
        if (pipe.llm_provider !== "infinibot") return json(200, { ok: true, llm: pipe.llm_provider, text: "(robovoice-side LLM — not simulated)" });
        const bind = edge.voiceLlm[locId];
        if (!bind) return json(409, { error: "no voice-LLM binding for the location" });
        const t0 = Date.now();
        let firstMs: number | null = null;
        let out = "";
        let chunks = 0;
        let timing: unknown = null;
        const r = await fetch(`${bind.base_url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bind.token}` },
          body: JSON.stringify({
            model: pipe.llm_model,
            stream: true,
            user: room,
            messages: [
              { role: "system", content: c.system_prompt ?? `You are ${c.name}.` },
              { role: "user", content: text },
            ],
            metadata: { location_id: locId, room, caller: b.caller ?? { role: "anonymous" } },
          }),
        });
        if (!r.ok || !r.body) return json(502, { error: `callback http ${r.status}`, body: await r.text() });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const ev = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (!ev.startsWith("data:")) continue;
            const data = ev.slice(5).trim();
            if (data === "[DONE]") continue;
            const o = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; infinibot?: unknown };
            const d = o.choices?.[0]?.delta?.content;
            if (d) {
              if (firstMs === null) firstMs = Date.now() - t0;
              out += d;
              chunks++;
            }
            if (o.infinibot) timing = o.infinibot;
          }
        }
        edge.lastTurn = { character_id: c.id, llm_model: pipe.llm_model, text: out, chunks, first_token_ms: firstMs, total_ms: Date.now() - t0, infinibot: timing };
        return json(200, { ok: true, ...edge.lastTurn });
      }
      case "/api/edge/infinibot/calls": {
        if (!signedIn) return json(401, { error: "unauthenticated" });
        if (req.method === "POST") {
          const link = edge.links.get(String(b.install_id ?? ""));
          if (!link || link.unlinkedAt) return json(409, { error: "not linked" });
          const characterId =
            typeof b.agent_id === "string" && b.agent_id ? link.agents[b.agent_id]?.character_id : (b.character_id as string | undefined);
          if (!characterId) return json(404, { error: `InfiniBot agent "${String(b.agent_id)}" is not linked to a character` });
          const startedAt = new Date().toISOString();
          if (b.mode === "local") {
            const d = [...edge.devices.values()].find((x) => !x.revoked && x.client_version?.startsWith("desktop-"));
            if (!d) return json(409, { error: "No Robovoice Desktop is online in this organization" });
            const room = `robopark-${d.device_id}`;
            const command = { id: id(), kind: "start_call", character_id: characterId };
            edge.commands.push({ device_id: d.device_id, kind: "start_call", character_id: characterId });
            edge.calls.set(room, { polls: 0, startedAt, settled: false, mode: "local", command });
            return json(200, { ok: true, mode: "local", character_id: characterId, device: { device_id: d.device_id, name: d.name, hostname: d.hostname ?? null }, room, command, started_at: startedAt, credits: credits() });
          }
          const room = `robopark-${characterId}`;
          edge.calls.set(room, { polls: 0, startedAt, settled: false, mode: "cloud" });
          const loc = link.locationId;
          return json(200, { ok: true, mode: "cloud", character_id: characterId, url: `${baseUrl()}/call/${characterId}?mode=voice&autostart=1&location=${loc}`, room, started_at: startedAt, credits: credits() });
        }
        const room = String(b.room ?? u.searchParams.get("room") ?? "");
        const call = edge.calls.get(room);
        if (!call) return json(404, { error: "Call not found" });
        if (req.method === "DELETE") {
          call.polls = 1e6;
          return json(200, { ok: true, ended: true, room });
        }
        const [waiting, live] = opts.callScript ?? [1, 2];
        call.polls += 1;
        const isLive = call.polls > waiting && call.polls <= waiting + live;
        const ended = call.polls > waiting + live;
        const seconds = opts.callSeconds ?? 42;
        if (ended && !call.settled && call.polls < 1e6) {
          call.settled = true;
          edge.walletCredits -= seconds;
        }
        return json(200, {
          room,
          live: isLive,
          participants: isLive ? 2 : 0,
          hold: isLive ? { started_at: call.startedAt, tier: "standard" } : null,
          usage: call.settled
            ? { sessions: 1, billable_seconds: seconds, credits_charged: seconds, last_ended_at: new Date().toISOString() }
            : { sessions: 0, billable_seconds: 0, credits_charged: 0, last_ended_at: null },
          local: call.mode === "local" ? { calls: 1, seconds: call.settled ? seconds : 0, active: isLive } : null,
          credits: credits(),
        });
      }
      default:
        return json(404, { error: "not found" });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address() as AddressInfo;
  listenUrl = `http://${host}:${addr.port}`;
  return {
    url: listenUrl,
    requests,
    options: opts,
    edge,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
