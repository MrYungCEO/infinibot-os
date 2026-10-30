/**
 * Voice-LLM callback: InfiniBot as the LLM step of a Robovoice location's
 * pipeline.
 *
 *   POST /plugins/robovoice/voice-llm/v1/chat/completions   (OpenAI-compatible)
 *   Authorization: Bearer rvllm_…   (scoped to ONE Robovoice location, rotatable)
 *   { model: "infinibot:<agentId>", stream: true, messages: [...], user: "<room>",
 *     metadata?: { location_id?, room?, caller?: { role, email?, verified? } } }
 *
 * Robovoice's voice agent already speaks OpenAI chat-completions to InfiniBot
 * (its `moltbot` LLM provider → `<gateway>/v1`); this endpoint is the scoped
 * version: the token only works for voice agents synced into that location,
 * never grants the gateway password, and is declared in the manifest's
 * `selfAuthHttp` (served before the shared-secret gate, 401 without a valid
 * token).
 *
 * Each turn runs on the agent's chosen backend (gateway agent or a CLI agent)
 * through `api.runtime.host.voiceTurn`, streaming deltas straight into SSE so
 * TTS starts on the first phrase. Gateway turns default to the fast path
 * (settings.voiceLlmMode "auto"): conversation is one direct streaming model
 * call, tool work is handed to the full agent after a spoken acknowledgement.
 * Every turn logs one line with its timing breakdown and keeps it for the
 * Voice page's diagnostics (robovoice.voiceLlm.status → turns).
 * Callers are untrusted (W5) unless (a) Robovoice vouches for a signed-in
 * caller whose email is on the owner list (`ownerCallerEmails`; when that was
 * never set, the Robovoice account this install is linked with), or (b) the
 * call was started from this install by its operator and the turn names the
 * room the operator's page joined (see OperatorCalls).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { RunVoiceTurn, VoiceLlmTurnResult, VoiceTurnMessage, VoiceTurnTimings } from "infinibot/plugin-sdk";
import { agentFromInfinibotModel } from "./pipeline.js";
import type { RobovoiceSettings, RobovoiceSettingsStore, VoiceLlmBackend } from "./settings.js";

export const VOICE_LLM_BASE_PATH = "/plugins/robovoice/voice-llm/v1";
export const VOICE_LLM_ROUTE = `${VOICE_LLM_BASE_PATH}/chat/completions`;

export type VoiceLlmTurnStat = {
  at: string;
  agentId: string;
  locationId: string;
  backend: VoiceLlmBackend;
  trust: "owner" | "caller";
  ok: boolean;
  firstTokenMs: number | null;
  totalMs: number;
  chars: number;
  error?: string;
  /** fast | agent | fast+agent | cli — which path answered. */
  path?: VoiceTurnTimings["path"];
  /** Model of the fast step (`provider/model`). */
  model?: string;
  /** Until the model was asked. */
  prepMs?: number;
  /** Until the first complete sentence was streamed (what TTS starts on). */
  firstSentenceMs?: number | null;
  /** Full agent after a hand-off: its prep and its own first token. */
  agentPrepMs?: number | null;
  agentFirstTokenMs?: number | null;
  /** Why the fast step fell back to the full agent, if it did. */
  fastError?: string;
  /** Robovoice room / session the turn belonged to. */
  call?: string;
  /** Why the turn took its path ("prefilter: action request", "model: hand-off", "refusal guard"…). */
  routeReason?: string;
  /** Tools the full agent called during the turn. */
  toolCalls?: string[];
  /** Why the caller is (not) the owner. */
  trustReason?: string;
  /** The caller hung up or spoke again before the answer (not a failure). */
  cancelled?: boolean;
};

/** One line per turn: where the time went. */
export function formatTurnLine(t: VoiceLlmTurnStat): string {
  const ms = (v: number | null | undefined) => (typeof v === "number" ? `${v}ms` : "—");
  const parts = [
    `voice-llm ${t.agentId} via ${t.backend}`,
    `path=${t.path ?? "agent"}`,
    ...(t.model ? [`model=${t.model}`] : []),
    `(${t.trust}${t.trustReason ? `: ${t.trustReason}` : ""})`,
    ...(t.routeReason ? [`route "${t.routeReason}"`] : []),
    `prep ${ms(t.prepMs)}`,
    `first-token ${ms(t.firstTokenMs)}`,
    `first-sentence ${ms(t.firstSentenceMs)}`,
    ...(t.path === "fast+agent" ? [`agent-prep ${ms(t.agentPrepMs)}`, `agent-first-token ${ms(t.agentFirstTokenMs)}`] : []),
    `total ${t.totalMs}ms`,
    `chars ${t.chars}`,
    ...(t.toolCalls?.length ? [`tools ${t.toolCalls.slice(0, 12).join(",")}`] : []),
    ...(t.fastError ? [`fast-error "${t.fastError.slice(0, 120)}"`] : []),
    ...(t.cancelled ? ["cancelled (caller spoke again or hung up)"] : []),
    ...(t.error ? [`error "${t.error.slice(0, 160)}"`] : []),
  ];
  return parts.join(" ");
}

export function turnStat(
  base: Pick<VoiceLlmTurnStat, "agentId" | "locationId" | "backend" | "trust" | "call" | "trustReason">,
  result: VoiceLlmTurnResult | null,
  startedAt: number,
  error?: string,
): VoiceLlmTurnStat {
  const tm = result?.timings;
  return {
    at: new Date().toISOString(),
    ...base,
    ok: !error,
    firstTokenMs: result?.firstTokenMs ?? null,
    totalMs: result?.totalMs ?? Date.now() - startedAt,
    chars: result?.text.length ?? 0,
    error,
    path: tm?.path,
    model: tm?.model,
    prepMs: tm?.prepMs,
    firstSentenceMs: tm?.firstSentenceMs ?? null,
    agentPrepMs: tm?.agentPrepMs ?? null,
    agentFirstTokenMs: tm?.agentFirstTokenMs ?? null,
    fastError: tm?.fastError,
    routeReason: tm?.routeReason,
    toolCalls: tm?.toolCalls,
  };
}

/** Last turns (newest first) for the settings page. */
export class VoiceLlmStats {
  private readonly turns: VoiceLlmTurnStat[] = [];
  constructor(private readonly max = 25) {}
  add(t: VoiceLlmTurnStat) {
    this.turns.unshift(t);
    if (this.turns.length > this.max) this.turns.length = this.max;
  }
  list(): VoiceLlmTurnStat[] {
    return [...this.turns];
  }
  summary() {
    const ok = this.turns.filter((t) => t.ok && !t.cancelled && t.firstTokenMs !== null);
    const sorted = ok.map((t) => t.firstTokenMs!).sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    const paths: Record<string, number> = {};
    for (const t of this.turns) paths[t.path ?? "agent"] = (paths[t.path ?? "agent"] ?? 0) + 1;
    return { turns: this.turns.length, ok: ok.length, firstTokenP50Ms: p50, paths };
  }
}

type ChatMessage = { role?: unknown; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The call's turns as the provider sent them (user / assistant text only). */
export function conversationHistory(messages: unknown): VoiceTurnMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: VoiceTurnMessage[] = [];
  for (const raw of messages as ChatMessage[]) {
    if (!raw || (raw.role !== "user" && raw.role !== "assistant")) continue;
    const content = textOf(raw.content).trim();
    if (content) out.push({ role: raw.role, content });
  }
  return out;
}

/** The caller's latest utterance: the last user message. */
export function lastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    if (m && m.role === "user") {
      const t = textOf(m.content).trim();
      if (t) return t;
    }
  }
  return "";
}

export type VoiceAgentResolution =
  | { ok: true; agentId: string; backend: VoiceLlmBackend }
  | { ok: false; status: number; error: string };

/** Is `agentId` an InfiniBot-answered voice agent at this location? */
export function resolveVoiceAgent(s: RobovoiceSettings, agentId: string | null, locationId: string): VoiceAgentResolution {
  if (!agentId) return { ok: false, status: 400, error: 'model must be "infinibot:<agentId>"' };
  const linkedLocation = s.link && !s.link.unlinkedAt ? s.link.locationId : undefined;
  if (!linkedLocation || linkedLocation !== locationId) {
    return { ok: false, status: 403, error: "this token's location is not this install's linked location" };
  }
  if (!(s.linkedAgents ?? ["main"]).includes(agentId)) {
    return { ok: false, status: 403, error: `agent "${agentId}" is not a voice agent at this location` };
  }
  const o = s.agentOverrides[agentId] ?? {};
  if (o.llm === "robovoice") {
    return { ok: false, status: 403, error: `agent "${agentId}" uses the location's own LLM, not InfiniBot` };
  }
  return { ok: true, agentId, backend: o.llmBackend ?? "gateway" };
}

/**
 * Emails Robovoice may vouch for as the owner. An explicit list (even an empty
 * one) is final; when it was never set, the Robovoice account this install was
 * linked with (device-code login) is the owner.
 */
export function ownerCallerEmails(s: RobovoiceSettings): string[] {
  if (s.ownerCallerEmails) return s.ownerCallerEmails;
  const linked = s.link && !s.link.unlinkedAt ? s.link.userEmail?.trim().toLowerCase() : undefined;
  return linked ? [linked] : [];
}

/** Owner only when Robovoice vouches for a verified, signed-in caller on the owner list. */
export function callerIsOwner(s: RobovoiceSettings, metadata: unknown): boolean {
  const caller = (metadata && typeof metadata === "object" ? (metadata as { caller?: unknown }).caller : undefined) as
    | { email?: unknown; verified?: unknown }
    | undefined;
  if (!caller || caller.verified !== true || typeof caller.email !== "string") return false;
  return ownerCallerEmails(s).includes(caller.email.trim().toLowerCase());
}

/**
 * Rooms of calls the operator of this install started. Two authenticated paths
 * record them:
 *   - robovoice.call.start (gateway RPC): the room Robovoice returns. For a
 *     local call that is the Desktop's device room, which the Desktop joins.
 *     For a cloud call it is only a status handle (`robopark-<characterId>`):
 *     the page joins a different room, so it is recorded as the call's alias.
 *   - /plugins/robovoice/connection-details (behind the gateway auth gate):
 *     the LiveKit room the operator's page actually joins, minted by Robovoice
 *     for this install's device key (`robopark-<install device id>`).
 * The voice agent names that room on every turn (x-robovoice-session = the
 * room), so a turn is the owner's when its room is an exact match. No suffix /
 * prefix matching: room names are caller-influenced on open Robovoice stacks.
 *
 * Entries survive a gateway restart (persisted to plugin-data) and end with
 * robovoice.call.end (by either room) or after `ttlMs`.
 */
export type OperatorCall = {
  room: string;
  expiresAt: number;
  /** The robovoice.call.start room this joined room belongs to (cloud calls). */
  startRoom?: string;
  agentId?: string;
  /** Character the operator's session was issued for; a turn naming another one is not this call. */
  characterId?: string;
  /** Chat session the operator started the call from: its turns run on (and reply into) it. */
  sessionKey?: string;
  source: "call.start" | "connection";
};

export class OperatorCalls {
  private readonly calls = new Map<string, OperatorCall>();
  /** Recent call.start per agent, so the page's connection inherits its start room. */
  private readonly pendingStarts = new Map<string, { room: string; at: number; sessionKey?: string }>();
  constructor(
    private readonly ttlMs = 2 * 3600_000,
    private readonly now: () => number = Date.now,
    private readonly persist?: { load: () => unknown; save: (calls: OperatorCall[]) => void },
  ) {
    try {
      const raw = persist?.load();
      if (Array.isArray(raw)) {
        for (const c of raw as OperatorCall[]) {
          if (c && typeof c.room === "string" && typeof c.expiresAt === "number" && c.expiresAt > this.now())
            this.calls.set(c.room, c);
        }
      }
    } catch {
      // unreadable file: start empty
    }
  }

  private save() {
    try {
      this.persist?.save([...this.calls.values()]);
    } catch {
      // best effort: trust still works in memory
    }
  }

  private prune() {
    const t = this.now();
    let changed = false;
    for (const [room, c] of this.calls) {
      if (c.expiresAt <= t) {
        this.calls.delete(room);
        changed = true;
      }
    }
    while (this.calls.size > 50) {
      this.calls.delete(this.calls.keys().next().value!);
      changed = true;
    }
    return changed;
  }

  /** robovoice.call.start answered with `room` (mode = where the call runs). */
  start(
    room: string | undefined | null,
    opts: { agentId?: string; characterId?: string; mode?: "cloud" | "local"; sessionKey?: string } = {},
  ) {
    if (!room) return;
    const sessionKey = cleanSessionKey(opts.sessionKey, opts.agentId);
    if (opts.agentId) this.pendingStarts.set(opts.agentId, { room, at: this.now(), sessionKey });
    // A cloud start room is only a handle: nobody's turns arrive under it.
    if (opts.mode === "cloud") return;
    this.record({ room, agentId: opts.agentId, characterId: opts.characterId, sessionKey, source: "call.start" });
  }

  /** The operator's page got a LiveKit session for `room` (the room it joins). */
  joined(
    room: string | undefined | null,
    opts: { agentId?: string; characterId?: string; sessionKey?: string } = {},
  ) {
    if (!room) return;
    const pending = opts.agentId ? this.pendingStarts.get(opts.agentId) : undefined;
    const fresh = pending && this.now() - pending.at < 10 * 60_000 ? pending : undefined;
    const startRoom = fresh?.room;
    // The page names its session on the connection; else the call.start that preceded it did.
    const sessionKey = cleanSessionKey(opts.sessionKey, opts.agentId) ?? fresh?.sessionKey;
    this.record({ room, agentId: opts.agentId, characterId: opts.characterId, startRoom, sessionKey, source: "connection" });
  }

  private record(c: Omit<OperatorCall, "expiresAt">) {
    this.calls.delete(c.room);
    this.calls.set(c.room, { ...c, expiresAt: this.now() + this.ttlMs });
    this.prune();
    this.save();
  }

  /** End by the joined room or by the robovoice.call.start room. */
  end(room: string | undefined | null) {
    if (!room) return;
    let changed = false;
    for (const [key, c] of this.calls) {
      if (key === room || c.startRoom === room) {
        this.calls.delete(key);
        changed = true;
      }
    }
    for (const [agent, p] of this.pendingStarts) if (p.room === room) this.pendingStarts.delete(agent);
    if (changed) this.save();
  }

  /** The active operator call a turn's room belongs to (exact room match). */
  get(room: string | undefined | null, characterId?: string | null): OperatorCall | undefined {
    if (this.prune()) this.save();
    if (!room) return undefined;
    const c = this.calls.get(room);
    if (!c) return undefined;
    if (characterId && c.characterId && characterId !== c.characterId) return undefined;
    return c;
  }

  has(room: string | undefined | null, characterId?: string | null): boolean {
    return !!this.get(room, characterId);
  }

  /** Active operator-call rooms (not secret: LiveKit room names), for the turn log line. */
  rooms(): string[] {
    if (this.prune()) this.save();
    return [...this.calls.keys()];
  }
}

/** A chat session key of this agent (`agent:<agentId>:…`), else undefined. */
export function cleanSessionKey(raw: unknown, agentId?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  if (!key || key.length > 200 || /[\s\u0000-\u001f]/.test(key)) return undefined;
  if (!key.startsWith("agent:")) return undefined;
  if (agentId && !key.startsWith(`agent:${agentId}:`)) return undefined;
  return key;
}

/** Who is on the line, and why we think so (the reason goes into the turn's log line). */
export function resolveCallerTrust(
  s: RobovoiceSettings,
  metadata: unknown,
  room: string,
  operatorCalls?: OperatorCalls,
): { owner: boolean; reason: string } {
  if (callerIsOwner(s, metadata)) return { owner: true, reason: "verified owner email" };
  const meta = metadata && typeof metadata === "object" ? (metadata as { caller?: unknown; character_id?: unknown }) : {};
  const characterId = typeof meta.character_id === "string" ? meta.character_id : null;
  if (operatorCalls?.has(room, characterId)) return { owner: true, reason: "call started from this install" };
  const caller = meta.caller as { verified?: unknown } | undefined;
  const who = caller?.verified === true ? "signed-in, not on the owner list" : "anonymous";
  // Diagnostic, no secrets: which room the turn named and which operator calls exist.
  const active = operatorCalls?.rooms() ?? [];
  const where = active.length
    ? `room ${room} is not an operator call (active: ${active.slice(0, 4).join(", ")})`
    : `room ${room}, no operator call active`;
  return { owner: false, reason: `${who}; ${where}` };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

async function readJson(req: IncomingMessage, max = 1_000_000): Promise<unknown | undefined> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) return undefined;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function oaiError(res: ServerResponse, status: number, message: string, type = "invalid_request_error") {
  sendJson(res, status, { error: { message, type } });
}

export type VoiceLlmHttpDeps = {
  store: RobovoiceSettingsStore;
  voiceTurn: RunVoiceTurn;
  stats: VoiceLlmStats;
  /** Rooms of calls the operator started from this install (owner trust). */
  operatorCalls?: OperatorCalls;
  log?: { info: (m: string) => void; warn: (m: string) => void };
};

/** How often the voice agent should poll for updates (it may poll less often). */
export const UPDATE_POLL_BUSY_MS = 4_000;
export const UPDATE_POLL_IDLE_MS = 15_000;

/** SSE comment sent while a turn works silently: keeps proxies and the voice agent's read timeout from cutting the stream. */
export const KEEPALIVE_MS = 8_000;

export async function handleVoiceLlmHttp(req: IncomingMessage, res: ServerResponse, deps: VoiceLlmHttpDeps): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const locationId = deps.store.locationForVoiceLlmToken(bearer(req));
  if (!locationId) {
    res.setHeader("www-authenticate", 'Bearer realm="robovoice-voice-llm"');
    oaiError(res, 401, "missing or invalid voice-LLM token", "authentication_error");
    return;
  }
  const body = (await readJson(req)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    oaiError(res, 400, "invalid JSON body");
    return;
  }
  const s = deps.store.get();
  const headerAgent = typeof req.headers["x-infinibot-agent"] === "string" ? req.headers["x-infinibot-agent"] : null;
  const agent = resolveVoiceAgent(s, agentFromInfinibotModel(body.model) ?? headerAgent, locationId);
  if (!agent.ok) {
    oaiError(res, agent.status, agent.error, agent.status === 403 ? "permission_error" : "invalid_request_error");
    return;
  }
  const meta0 = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  // Warm-up at call connect (no user message): resolve the model, persona and
  // tools and open the provider's connection pool, so turn one pays for none of it.
  if (meta0.warmup === true || req.headers["x-robovoice-warmup"] === "1") {
    const sessionHeader0 = req.headers["x-robovoice-session"];
    const room0 =
      (typeof sessionHeader0 === "string" && sessionHeader0) || (typeof body.user === "string" && body.user) || "default";
    const trust0 = resolveCallerTrust(s, meta0, room0, deps.operatorCalls);
    const started0 = Date.now();
    try {
      const r = await deps.voiceTurn({
        agentId: agent.agentId,
        backend: agent.backend,
        message: "",
        warmup: true,
        callKey: `${locationId}:${room0}`,
        provider: "robovoice",
        callerIsOwner: trust0.owner,
        fastModel: s.voiceLlmFastModel,
        voiceTools: s.voiceTools,
        voiceTiming: s.voiceTiming,
        sessionKey: trust0.owner ? deps.operatorCalls?.get(room0)?.sessionKey : undefined,
        onDelta: () => {},
      });
      deps.log?.info(`voice-llm warm-up ${agent.agentId} (${trust0.owner ? "owner" : "caller"}) ${Date.now() - started0}ms model=${r.timings?.model ?? "—"}`);
      sendJson(res, 200, { ok: true, warm_ms: Date.now() - started0, model: r.timings?.model ?? null });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  // Update poll while the line is quiet (progress / results of background
  // work to speak now), and the hang-up notice. Same token, same trust rules.
  if (meta0.poll_updates === true || meta0.call_ended === true) {
    const sessionHeaderP = req.headers["x-robovoice-session"];
    const roomP =
      (typeof sessionHeaderP === "string" && sessionHeaderP) ||
      (typeof body.user === "string" && body.user) ||
      (typeof meta0.room === "string" && meta0.room) ||
      "default";
    const trustP = resolveCallerTrust(s, meta0, roomP, deps.operatorCalls);
    if (!trustP.owner) {
      // Guests never start background work: nothing to report.
      sendJson(res, 200, { ok: true, updates: [], running: 0, next_poll_ms: UPDATE_POLL_IDLE_MS });
      return;
    }
    try {
      const characterP = typeof meta0.character_id === "string" ? meta0.character_id : null;
      const r = await deps.voiceTurn({
        agentId: agent.agentId,
        backend: agent.backend,
        message: "",
        pollUpdates: meta0.poll_updates === true,
        callEnded: meta0.call_ended === true,
        callKey: `${locationId}:${roomP}`,
        provider: "robovoice",
        callerIsOwner: true,
        voiceTiming: s.voiceTiming,
        sessionKey: deps.operatorCalls?.get(roomP, characterP)?.sessionKey,
        onDelta: () => {},
      });
      const updates = r.updates ?? [];
      if (updates.length) deps.log?.info(`voice-llm updates ${agent.agentId} room ${roomP}: ${updates.length} spoken`);
      sendJson(res, 200, {
        ok: true,
        updates,
        running: r.running ?? 0,
        next_poll_ms: (r.running ?? 0) > 0 ? UPDATE_POLL_BUSY_MS : UPDATE_POLL_IDLE_MS,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, updates: [], error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const message = lastUserMessage(body.messages);
  if (!message) {
    oaiError(res, 400, "no user message in `messages`");
    return;
  }
  const meta = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  const sessionHeader = req.headers["x-robovoice-session"];
  const callKey =
    (typeof sessionHeader === "string" && sessionHeader) ||
    (typeof body.user === "string" && body.user) ||
    (typeof meta.room === "string" && meta.room) ||
    "default";
  const trust = resolveCallerTrust(s, meta, callKey, deps.operatorCalls);
  const owner = trust.owner;
  const locationName = s.link?.locationName;
  const stream = body.stream === true;
  const id = `chatcmpl-rv-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = `infinibot:${agent.agentId}`;
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

  let keepalive: ReturnType<typeof setInterval> | null = null;
  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    res.write(chunk({ role: "assistant" }));
    keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, KEEPALIVE_MS);
    keepalive.unref?.();
  }
  // A call the operator started from a chat session runs on that session.
  const boundSession = owner ? deps.operatorCalls?.get(callKey, typeof meta.character_id === "string" ? meta.character_id : null)?.sessionKey : undefined;

  let result: VoiceLlmTurnResult | null = null;
  let error: string | undefined;
  let cancelled = false;
  const started = Date.now();
  try {
    result = await deps.voiceTurn({
      agentId: agent.agentId,
      backend: agent.backend,
      message,
      callKey: `${locationId}:${callKey}`,
      provider: "robovoice",
      callerIsOwner: owner,
      mode: s.voiceLlmMode ?? "auto",
      fastModel: s.voiceLlmFastModel,
      voiceTools: s.voiceTools,
      voiceTiming: s.voiceTiming,
      sessionKey: boundSession,
      history: conversationHistory(body.messages),
      context: locationName ? `The call reached you through the Robovoice location "${locationName}".` : undefined,
      signal: abort.signal,
      onDelta: (t) => {
        if (stream && !res.writableEnded) res.write(chunk({ content: t }));
      },
    });
  } catch (err) {
    // The voice agent drops the request when the caller speaks again or hangs
    // up: that turn was superseded, it did not fail.
    cancelled = abort.signal.aborted;
    if (!cancelled) {
      error = err instanceof Error ? err.message : String(err);
      deps.log?.warn(`voice-llm turn failed (agent ${agent.agentId}, ${agent.backend}): ${error}`);
    }
  } finally {
    if (keepalive) clearInterval(keepalive);
  }

  const stat: VoiceLlmTurnStat = {
    ...turnStat(
      {
        agentId: agent.agentId,
        locationId,
        backend: agent.backend,
        trust: owner ? "owner" : "caller",
        trustReason: trust.reason,
        call: callKey,
      },
      result,
      started,
      error,
    ),
    ...(cancelled ? { cancelled: true } : {}),
  };
  deps.stats.add(stat);
  deps.log?.info(formatTurnLine(stat));
  const timing = {
    infinibot: {
      backend: agent.backend,
      agent: agent.agentId,
      trust: stat.trust,
      path: stat.path ?? null,
      model: stat.model ?? null,
      prep_ms: stat.prepMs ?? null,
      first_token_ms: stat.firstTokenMs,
      first_sentence_ms: stat.firstSentenceMs ?? null,
      total_ms: stat.totalMs,
      route_reason: stat.routeReason ?? null,
      tool_calls: stat.toolCalls ?? [],
    },
  };

  if (stream) {
    if (res.writableEnded || cancelled) return;
    if (error && !result?.text) res.write(chunk({ content: "Sorry, I couldn't get to that just now. Could you say it again?" }));
    res.write(chunk({}, "stop", timing));
    res.end("data: [DONE]\n\n");
    return;
  }
  if (cancelled) return;
  if (error) {
    oaiError(res, 502, error, "api_error");
    return;
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: result!.text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ...timing,
  });
}
