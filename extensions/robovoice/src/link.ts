/**
 * InfiniBot ↔ Robovoice SaaS linkage.
 *
 *   login   device-code sign-in (same flow as the `robovoice` CLI / Robovoice
 *           Desktop) → an org-scoped `rve_` token, stored encrypted.
 *   link    the install becomes a Robovoice LOCATION "InfiniBot · <hostname>"
 *           (create-or-reuse, keyed by the install id) with InfiniBot's edge
 *           device registered there (HMAC device key, stored encrypted).
 *   sync    each linked InfiniBot agent → a Robovoice character at that
 *           location (persona from the agent identity, voice + language from
 *           overrides), or attached to an existing character; optional
 *           per-agent MCP binding back to this gateway with a scoped token.
 *   call    a web call link (cloud pipeline) or a start_call to Robovoice
 *           Desktop (local engines), then watch it and report credits used.
 *
 * One org per install; everything here is install-wide (not per profile).
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCredits, type RobovoiceCredits } from "./client.js";
import {
  EdgeApiError,
  RobovoiceEdgeApi,
  type AgentSyncInput,
  type CallStart,
  type CallStatus,
  type DeviceCodeStart,
  type LinkStatus,
  type SyncResult,
  type TokenResult,
} from "./edge-api.js";
import { linkState, ORG_SCOPED_CLEAR } from "./link-guard.js";
import { INFINIBOT_LLM_PROVIDER, infinibotLlmModel } from "./pipeline.js";
import type { AgentVoiceOverride, LinkedCharacter, RobovoiceSettings, RobovoiceSettingsStore } from "./settings.js";
import { VOICE_LLM_BASE_PATH } from "./voice-llm.js";

export const DEFAULT_ROBOVOICE_API = "https://robovoice.io";
export const MCP_ROUTE = "/plugins/robovoice/agent-mcp";

export type AgentPersonaLike = { id: string; name: string; description?: string; emoji?: string };

export type LinkServiceDeps = {
  store: RobovoiceSettingsStore;
  /** InfiniBot agents on this install (id, name, role line). */
  personas: () => AgentPersonaLike[];
  fetchImpl?: typeof fetch;
  version?: string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  /** Robovoice Desktop presence probe (overridable in tests). */
  detectDesktop?: () => DesktopPresence;
};

export type DesktopPresence = { installed: boolean; running: boolean; detail?: string };

export type PendingLogin = {
  apiBase: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  status: "pending" | "linking" | "linked" | "error";
  error?: string;
  startedAt: number;
};

export type LinkSummary = {
  linked: boolean;
  apiBase: string;
  installId?: string;
  org?: { id: string; name: string };
  userEmail?: string;
  location?: { id?: string; name?: string; dashboardUrl?: string };
  device?: { id?: string; name?: string; state?: string; lastSeenAt?: string | null };
  unlinkedAt?: string;
  agents: Array<{ agentId: string; name: string; characterId?: string; managed: boolean; error?: string }>;
  credits?: RobovoiceCredits;
  mcp?: { status?: string; url?: string | null; agents?: string[]; error?: string };
  remoteError?: string;
  /**
   * Where the Robovoice-side fields (org, location, device, credits, mcp) came
   * from: fetchedAt = when Robovoice answered; stale = Robovoice didn't answer
   * just now and these are the last real answer (never older than
   * REMOTE_STALE_MAX_MS). Absent = no Robovoice answer to show.
   */
  remote?: { fetchedAt: string; stale: boolean };
  secretsEncrypted: boolean;
  signedIn: boolean;
};

/** Reuse a Robovoice link-status answer this long (the page and its widgets ask together). */
export const REMOTE_FRESH_MS = 10_000;
/** Show the last real answer (marked stale, with its age) this long when Robovoice doesn't answer. */
export const REMOTE_STALE_MAX_MS = 10 * 60_000;

export class RobovoiceLinkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RobovoiceLinkError";
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A short voice persona from the agent's identity (the text-chat system prompt is not for speech). */
export function voicePrompt(p: AgentPersonaLike, opts: { tools: boolean }): string {
  const role = p.description ? ` ${p.description.replace(/\s+/g, " ").trim()}` : "";
  return [
    `You are ${p.name}, an InfiniBot agent speaking with the operator by voice through Robovoice.${role}`,
    "Talk naturally and keep answers short — one to three sentences — with no markdown, lists or code; " +
      "ask a quick follow-up when it helps.",
    opts.tools
      ? "When a request needs real work (notes, tasks, research, starting a coding agent), use your InfiniBot tools, " +
        "then say in one sentence what you did. Never claim you did something you did not."
      : "You cannot take actions from this call; if the operator asks for real work, tell them to ask you in InfiniBot chat.",
  ].join(" ");
}

export function detectRobovoiceDesktop(env: NodeJS.ProcessEnv = process.env): DesktopPresence {
  const home = env.HOME || os.homedir();
  const dirs =
    process.platform === "darwin"
      ? [path.join(home, "Library", "Application Support", "Robovoice")]
      : process.platform === "win32"
        ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Robovoice")]
        : [path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Robovoice")];
  const installed = dirs.some((d) => fs.existsSync(d));
  let running = false;
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("pgrep", ["-if", "(^|/)robovoice-desktop( |$)|/Robovoice\\.app/|/Robovoice[^/ ]*\\.AppImage( |$)"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      running = out.trim().length > 0;
    } catch {
      running = false;
    }
  }
  return { installed, running, detail: installed ? dirs.find((d) => fs.existsSync(d)) : undefined };
}

/** Open a URL in the desktop browser (best effort; never throws). */
export function openInBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function applyRemote(out: LinkSummary, r: LinkStatus, at: number, stale: boolean): LinkSummary {
  out.org = { id: r.org.id, name: r.org.name };
  out.credits = parseCredits({ org: r.org, credits: r.credits });
  out.mcp = r.mcp;
  if (r.location) out.location = { id: r.location.id, name: r.location.name, dashboardUrl: r.location.dashboard_url ?? undefined };
  if (r.device)
    out.device = { id: r.device.device_id, name: r.device.name, state: r.device.state, lastSeenAt: r.device.last_seen_at };
  // Linked = Robovoice says so AND this install still holds the org token, device key and location.
  out.linked = r.linked && out.linked;
  if (r.unlinked_at) out.unlinkedAt = r.unlinked_at;
  if (r.location_missing) out.remoteError = "The linked location was deleted in Robovoice — run `infinibot robovoice login` to recreate it.";
  out.remote = { fetchedAt: new Date(at).toISOString(), stale };
  return out;
}

export class RobovoiceLinkService {
  private lastRemote: { at: number; key: string; status: LinkStatus } | null = null;
  private remoteInflight: { key: string; promise: Promise<LinkStatus> } | null = null;
  private pending: (PendingLogin & { deviceCode: string; interval: number; abort: AbortController }) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: LinkServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get store(): RobovoiceSettingsStore {
    return this.deps.store;
  }

  /** Where the SaaS lives: the linked apiBase, else a cloud baseUrl, else ROBOVOICE_API, else robovoice.io. */
  apiBase(override?: string): string {
    if (override?.trim()) return normalizeBase(override);
    const s = this.store.get();
    if (s.link?.apiBase) return s.link.apiBase;
    if (s.deployment === "cloud" && s.baseUrl) return s.baseUrl;
    return normalizeBase((this.deps.env ?? process.env).ROBOVOICE_API || DEFAULT_ROBOVOICE_API);
  }

  api(apiBase = this.apiBase(), token: string | null = this.store.secrets().edgeToken ?? null): RobovoiceEdgeApi {
    return new RobovoiceEdgeApi(apiBase, token, { fetchImpl: this.deps.fetchImpl, version: this.deps.version });
  }

  private requireToken(): string {
    const t = this.store.secrets().edgeToken;
    if (!t) throw new RobovoiceLinkError("Not signed in to Robovoice — run `infinibot robovoice login`", "not_signed_in", 401);
    return t;
  }

  private installId(): string {
    return this.store.ensureInstallId();
  }

  // --- login ---------------------------------------------------------------------

  async startLogin(apiBase?: string): Promise<{ apiBase: string; start: DeviceCodeStart }> {
    const base = this.apiBase(apiBase);
    const start = await this.api(base, null).startLogin();
    return { apiBase: base, start };
  }

  /** Poll until the code is approved (or denied / expired / aborted). */
  async waitForLogin(apiBase: string, start: DeviceCodeStart, signal?: AbortSignal): Promise<TokenResult> {
    const api = this.api(apiBase, null);
    const deadline = Date.now() + start.expires_in * 1000;
    let interval = Math.max(2, start.interval || 3) * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new RobovoiceLinkError("Sign-in cancelled", "cancelled");
      await this.sleep(interval);
      const r = await api.pollLogin(start.device_code).catch((e) => {
        if (e instanceof EdgeApiError && e.status === 400 && e.code === "slow_down") {
          interval += 2000;
          return null;
        }
        throw e;
      });
      if (r) return r;
    }
    throw new RobovoiceLinkError("The sign-in code expired — run login again", "expired_token");
  }

  /** Store the token and link the install (location + device + agents). */
  async completeLogin(apiBase: string, token: TokenResult): Promise<LinkSummary> {
    this.lastRemote = null;
    const s = this.store.get();
    // A different org invalidates the old device key and character map (both per org).
    if (s.link && s.link.orgId !== token.org.id) {
      this.store.update({ link: undefined, ...ORG_SCOPED_CLEAR });
      this.store.setSecrets({ deviceKey: null });
      this.store.revokeMcpTokens();
      this.store.revokeVoiceLlmTokens();
    }
    this.store.setSecrets({ edgeToken: token.access_token });
    this.store.update({
      link: {
        ...(this.store.get().link ?? { linkedAt: new Date().toISOString() }),
        apiBase,
        orgId: token.org.id,
        orgName: token.org.name,
        userEmail: token.user?.email ?? undefined,
      },
    });
    return this.link();
  }

  /**
   * Gateway/UI flavour: start the device-code flow and finish it in the
   * background. Poll `pendingLogin()` for progress.
   */
  async beginLogin(apiBase?: string): Promise<PendingLogin> {
    this.pending?.abort.abort();
    const { apiBase: base, start } = await this.startLogin(apiBase);
    const abort = new AbortController();
    const pending: PendingLogin & { deviceCode: string; interval: number; abort: AbortController } = {
      apiBase: base,
      userCode: start.user_code,
      verificationUri: start.verification_uri,
      verificationUriComplete: start.verification_uri_complete,
      expiresAt: Date.now() + start.expires_in * 1000,
      status: "pending",
      startedAt: Date.now(),
      deviceCode: start.device_code,
      interval: start.interval,
      abort,
    };
    this.pending = pending;
    void this.waitForLogin(base, start, abort.signal)
      .then(async (token) => {
        if (this.pending !== pending) return;
        pending.status = "linking";
        await this.completeLogin(base, token);
        pending.status = "linked";
      })
      .catch((e) => {
        if (this.pending !== pending) return;
        pending.status = "error";
        pending.error = errMsg(e);
      });
    return this.pendingLogin()!;
  }

  pendingLogin(): PendingLogin | null {
    if (!this.pending) return null;
    const { deviceCode: _d, interval: _i, abort: _a, ...pub } = this.pending;
    return { ...pub };
  }

  cancelLogin(): void {
    this.pending?.abort.abort();
    this.pending = null;
  }

  // --- link / sync / unlink --------------------------------------------------------

  async link(): Promise<LinkSummary> {
    this.lastRemote = null;
    this.requireToken();
    const installId = this.installId();
    const api = this.api();
    const r = await api.link(installId);
    const prev = this.store.get();
    this.store.update({
      deployment: "cloud",
      baseUrl: api.apiBase,
      deviceId: r.device.device_id,
      locationId: r.location.id,
      link: {
        ...(prev.link ?? { linkedAt: new Date().toISOString() }),
        apiBase: api.apiBase,
        orgId: r.org.id,
        orgName: r.org.name,
        locationId: r.location.id,
        locationName: r.location.name,
        locationSlug: r.location.slug ?? undefined,
        dashboardUrl: r.location.dashboard_url ?? undefined,
        deviceId: r.device.device_id,
        deviceName: r.device.name,
        linkedAt: new Date().toISOString(),
        unlinkedAt: undefined,
      },
      linkedAgents: prev.linkedAgents ?? ["main"],
    });
    this.store.setSecrets({ deviceKey: r.device.device_key });
    try {
      await this.sync();
    } catch (e) {
      // The link itself stands; agent sync can be retried with `sync`.
      return { ...(await this.status({ remote: false })), remoteError: `agent sync failed: ${errMsg(e)}` };
    }
    return this.status({ remote: true });
  }

  /** True when the agent's LLM step is InfiniBot (default) and Robovoice can reach the callback. */
  static answersViaInfinibot(agentId: string, s: RobovoiceSettings): boolean {
    return Boolean(s.mcpPublicUrl) && (s.agentOverrides[agentId]?.llm ?? "infinibot") === "infinibot";
  }

  /** The sync payload for one agent. */
  agentInput(agentId: string, s: RobovoiceSettings, tools: boolean): AgentSyncInput {
    const persona = this.deps.personas().find((p) => p.id === agentId) ?? { id: agentId, name: agentId };
    const o: AgentVoiceOverride = s.agentOverrides[agentId] ?? {};
    const linked: LinkedCharacter | undefined = s.linkedCharacters[agentId];
    const name = o.name ?? persona.name;
    const input: AgentSyncInput = {
      agent_id: agentId,
      name,
      // Only what the owner picked: no invented language (Robovoice keeps / decides its own).
      ...(o.language ? { language: o.language } : {}),
    };
    // LLM step = InfiniBot: Robovoice's voice agent calls the location's
    // voice_llm binding with model "infinibot:<agent>" (see voice-llm.ts).
    const llm = RobovoiceLinkService.answersViaInfinibot(agentId, s)
      ? { llm_provider: INFINIBOT_LLM_PROVIDER, llm_model: infinibotLlmModel(agentId) }
      : {};
    if (linked && !linked.managed && linked.characterId) {
      input.character_id = linked.characterId;
      return { ...input, ...llm };
    }
    // Only the owner's pick: without one, Robovoice applies its own voice default.
    const provider = o.ttsProvider;
    return {
      ...input,
      ...llm,
      description: persona.description ? `InfiniBot · ${persona.description}`.slice(0, 400) : `InfiniBot agent ${agentId}`,
      system_prompt: o.prompt ?? voicePrompt({ ...persona, name }, { tools }),
      greeting: o.greeting ?? `Hi, it's ${name}. What can I do for you?`,
      ...(provider ? { tts_provider: provider } : {}),
      ...(provider && o.voice ? (provider === "elevenlabs" ? { tts_voice_elevenlabs: o.voice } : { tts_voice_kokoro: o.voice }) : {}),
    };
  }

  async sync(opts: { remove?: string[] } = {}): Promise<SyncResult> {
    this.lastRemote = null;
    this.requireToken();
    const s = this.store.get();
    if (!s.link || s.link.unlinkedAt) throw new RobovoiceLinkError("Not linked — run `infinibot robovoice login`", "not_linked", 409);
    const known = new Set(this.deps.personas().map((p) => p.id));
    const agents = (s.linkedAgents ?? ["main"]).filter((id) => known.has(id) || s.linkedCharacters[id]);
    const tools = Boolean(s.mcpPublicUrl);
    const mcp = tools
      ? {
          url: `${s.mcpPublicUrl}${MCP_ROUTE}`,
          tokens: Object.fromEntries(agents.map((id) => [id, this.store.ensureMcpToken(id)])),
        }
      : undefined;
    const voiceLlm =
      s.mcpPublicUrl && s.link.locationId && agents.some((id) => RobovoiceLinkService.answersViaInfinibot(id, s))
        ? {
            base_url: `${s.mcpPublicUrl}${VOICE_LLM_BASE_PATH}`,
            token: this.store.ensureVoiceLlmToken(s.link.locationId),
            location_id: s.link.locationId,
          }
        : undefined;
    const r = await this.api().syncAgents(
      this.installId(),
      agents.map((id) => this.agentInput(id, s, tools)),
      { remove: opts.remove, mcp, voiceLlm },
    );
    const fresh = this.store.get();
    const characterMap = { ...fresh.characterMap };
    const linkedCharacters = { ...fresh.linkedCharacters };
    for (const res of r.results) {
      const row = r.agents[res.agent_id];
      linkedCharacters[res.agent_id] = {
        characterId: res.character_id ?? row?.character_id ?? undefined,
        robotId: row?.robot_id,
        managed: row ? !row.linked_character : (linkedCharacters[res.agent_id]?.managed ?? true),
        syncedAt: new Date().toISOString(),
        error: res.ok ? undefined : res.error,
      };
      if (res.ok && res.character_id) characterMap[res.agent_id] = res.character_id;
    }
    for (const id of r.removed) {
      delete linkedCharacters[id];
      delete characterMap[id];
    }
    this.store.update({ characterMap, linkedCharacters });
    return r;
  }

  /** `link <agent> [--character <id> | --create]`: add an agent to the location and sync. */
  async linkAgent(
    agentId: string,
    opts: { characterId?: string; create?: boolean; override?: AgentVoiceOverride } = {},
  ): Promise<SyncResult> {
    const known = this.deps.personas().some((p) => p.id === agentId);
    if (!known) throw new RobovoiceLinkError(`Unknown InfiniBot agent "${agentId}" — see \`infinibot robovoice agents\``, "unknown_agent", 404);
    const s = this.store.get();
    const linkedAgents = [...new Set([...(s.linkedAgents ?? ["main"]), agentId])];
    const linkedCharacters = { ...s.linkedCharacters };
    if (opts.characterId) linkedCharacters[agentId] = { characterId: opts.characterId, managed: false };
    else if (opts.create || !linkedCharacters[agentId]) {
      const prev = linkedCharacters[agentId];
      linkedCharacters[agentId] = prev?.managed ? prev : { managed: true };
    }
    const agentOverrides = { ...s.agentOverrides };
    if (opts.override && Object.values(opts.override).some((v) => v !== undefined)) {
      agentOverrides[agentId] = { ...(agentOverrides[agentId] ?? {}), ...stripUndefined(opts.override) };
    }
    this.store.update({ linkedAgents, linkedCharacters, agentOverrides });
    return this.sync();
  }

  /** Detach an agent: its fleet agent is removed from the location (the character stays in Robovoice). */
  async unlinkAgent(agentId: string): Promise<SyncResult> {
    const s = this.store.get();
    this.store.update({ linkedAgents: (s.linkedAgents ?? ["main"]).filter((id) => id !== agentId) });
    const r = await this.sync({ remove: [agentId] });
    const after = this.store.get();
    const characterMap = { ...after.characterMap };
    const linkedCharacters = { ...after.linkedCharacters };
    delete characterMap[agentId];
    delete linkedCharacters[agentId];
    this.store.update({ characterMap, linkedCharacters });
    this.store.revokeMcpTokens([agentId]);
    return r;
  }

  /** Retire this install's device (location + agents stay in the org). */
  async unlink(): Promise<{ ok: boolean; locationKept?: string | null; deviceRevoked?: string | null }> {
    this.lastRemote = null;
    this.requireToken();
    const r = await this.api().unlink(this.installId());
    const s = this.store.get();
    // Org-scoped config never outlives the link: no mapping, default character,
    // device or location of that org may steer a later call.
    this.store.update({ ...ORG_SCOPED_CLEAR, ...(s.link ? { link: { ...s.link, unlinkedAt: new Date().toISOString() } } : {}) });
    this.store.setSecrets({ deviceKey: null });
    this.store.revokeMcpTokens();
    this.store.revokeVoiceLlmTokens();
    return { ok: r.ok, locationKept: r.location_kept ?? s.link?.locationId ?? null, deviceRevoked: r.device_revoked ?? s.link?.deviceId ?? null };
  }

  /** Forget the sign-in: unlink the device (unless keepDevice), revoke the token, drop local secrets. */
  async logout(opts: { keepDevice?: boolean } = {}): Promise<{ ok: boolean; unlinked: boolean; tokenRevoked: boolean; error?: string }> {
    this.lastRemote = null;
    const token = this.store.secrets().edgeToken;
    let unlinked = false;
    let tokenRevoked = false;
    let error: string | undefined;
    if (token) {
      const s = this.store.get();
      if (!opts.keepDevice && s.link && !s.link.unlinkedAt) {
        await this.unlink().then(
          () => (unlinked = true),
          (e) => (error = `unlink: ${errMsg(e)}`),
        );
      }
      await this.api().logout().then(
        () => (tokenRevoked = true),
        (e) => (error = [error, `logout: ${errMsg(e)}`].filter(Boolean).join("; ")),
      );
    }
    this.store.clearSecrets();
    const s = this.store.get();
    this.store.update({
      ...ORG_SCOPED_CLEAR,
      ...(s.link ? { link: { ...s.link, unlinkedAt: s.link.unlinkedAt ?? new Date().toISOString() } } : {}),
    });
    this.cancelLogin();
    return { ok: !error, unlinked, tokenRevoked, error };
  }

  // --- status ------------------------------------------------------------------------

  async status(opts: { remote?: boolean } = {}): Promise<LinkSummary> {
    const s = this.store.get();
    const secrets = this.store.secrets();
    const personas = new Map(this.deps.personas().map((p) => [p.id, p]));
    const agents = (s.linkedAgents ?? (s.link ? ["main"] : [])).map((id) => ({
      agentId: id,
      name: s.agentOverrides[id]?.name ?? personas.get(id)?.name ?? id,
      characterId: s.linkedCharacters[id]?.characterId ?? s.characterMap[id],
      managed: s.linkedCharacters[id]?.managed ?? true,
      error: s.linkedCharacters[id]?.error,
    }));
    const out: LinkSummary = {
      linked: linkState(this.store).linked,
      apiBase: this.apiBase(),
      installId: s.installId,
      org: s.link ? { id: s.link.orgId, name: s.link.orgName } : undefined,
      userEmail: s.link?.userEmail,
      location: s.link?.locationId
        ? { id: s.link.locationId, name: s.link.locationName, dashboardUrl: s.link.dashboardUrl }
        : undefined,
      device: s.link?.deviceId ? { id: s.link.deviceId, name: s.link.deviceName } : undefined,
      unlinkedAt: s.link?.unlinkedAt,
      agents,
      secretsEncrypted: this.store.secretsEncrypted(),
      signedIn: Boolean(secrets.edgeToken),
    };
    if (!opts.remote || !secrets.edgeToken) return out;
    const key = `${out.apiBase}\n${this.installId()}\n${secrets.edgeToken}`;
    const last = this.lastRemote?.key === key ? this.lastRemote : null;
    const now = Date.now();
    if (last && now - last.at < REMOTE_FRESH_MS) return applyRemote(out, last.status, last.at, false);
    try {
      const r = await this.fetchRemote(key);
      this.lastRemote = { at: Date.now(), key, status: r };
      return applyRemote(out, r, this.lastRemote.at, false);
    } catch (e) {
      out.remoteError = errMsg(e);
      // Robovoice didn't answer: its last real answer, marked stale with its age.
      if (last && now - last.at < REMOTE_STALE_MAX_MS) return applyRemote(out, last.status, last.at, true);
      return out;
    }
  }

  /** One Robovoice link-status request at a time per install (page + widgets share it). */
  private fetchRemote(key: string): Promise<LinkStatus> {
    if (this.remoteInflight?.key === key) return this.remoteInflight.promise;
    const promise = this.api()
      .linkStatus(this.installId())
      .finally(() => {
        if (this.remoteInflight?.promise === promise) this.remoteInflight = null;
      });
    this.remoteInflight = { key, promise };
    return promise;
  }

  // --- calls ---------------------------------------------------------------------------

  desktop(): DesktopPresence {
    return (this.deps.detectDesktop ?? (() => detectRobovoiceDesktop(this.deps.env)))();
  }

  /** Start a call for an agent. mode "auto": Robovoice Desktop when it's running here, else cloud. */
  async startCall(agentId: string, opts: { mode?: "cloud" | "local" | "auto" } = {}): Promise<CallStart & { fellBackToCloud?: boolean }> {
    this.requireToken();
    const s = this.store.get();
    const st = linkState(this.store);
    if (!st.linked) throw new RobovoiceLinkError(st.message, "not_linked", 409);
    const mapped = s.linkedCharacters[agentId]?.characterId ?? s.characterMap[agentId];
    const wantLocal = opts.mode === "local" || (opts.mode === "auto" && this.desktop().running);
    const req = mapped && !s.linkedCharacters[agentId] ? { characterId: mapped } : { agentId };
    const api = this.api();
    const installId = this.installId();
    if (!wantLocal) return api.startCall(installId, { ...req, mode: "cloud" });
    try {
      return await api.startCall(installId, { ...req, mode: "local" });
    } catch (e) {
      if (opts.mode === "auto" && e instanceof EdgeApiError && e.status === 409) {
        return { ...(await api.startCall(installId, { ...req, mode: "cloud" })), fellBackToCloud: true };
      }
      throw e;
    }
  }

  callStatus(room: string, since?: string): Promise<CallStatus> {
    this.requireToken();
    return this.api().callStatus(room, since);
  }

  endCall(room: string) {
    this.requireToken();
    return this.api().endCall(room);
  }

  /**
   * Watch a call: wait for it to go live (connectTimeoutMs), then for it to end,
   * then for the usage to settle. Returns the final status with credits used.
   */
  async waitForCall(
    call: Pick<CallStart, "room" | "started_at">,
    opts: {
      pollMs?: number;
      connectTimeoutMs?: number;
      maxMs?: number;
      settleMs?: number;
      signal?: AbortSignal;
      onUpdate?: (st: CallStatus, phase: "waiting" | "live" | "ended") => void;
    } = {},
  ): Promise<{ status: CallStatus; connected: boolean; durationMs: number }> {
    const poll = opts.pollMs ?? 3000;
    const t0 = Date.now();
    let connected = false;
    let liveSince = 0;
    let last = await this.callStatus(call.room, call.started_at);
    const baseline = last.usage.sessions;
    opts.onUpdate?.(last, last.live ? "live" : "waiting");
    while (!opts.signal?.aborted) {
      if (last.live && !connected) {
        connected = true;
        liveSince = Date.now();
      }
      if (connected && !last.live) break;
      if (!connected && Date.now() - t0 > (opts.connectTimeoutMs ?? 180_000)) break;
      if (Date.now() - t0 > (opts.maxMs ?? 4 * 3600_000)) break;
      await this.sleep(poll);
      last = await this.callStatus(call.room, call.started_at);
      opts.onUpdate?.(last, last.live ? "live" : connected ? "ended" : "waiting");
    }
    // The voice agent settles usage as it leaves; give the session row a moment.
    const settleUntil = Date.now() + (opts.settleMs ?? 20_000);
    while (connected && last.usage.sessions <= baseline && Date.now() < settleUntil && !opts.signal?.aborted) {
      await this.sleep(poll);
      last = await this.callStatus(call.room, call.started_at);
    }
    opts.onUpdate?.(last, "ended");
    return { status: last, connected, durationMs: connected ? Date.now() - liveSince : 0 };
  }
}

function normalizeBase(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new RobovoiceLinkError(`Not a URL: ${v}`, "bad_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new RobovoiceLinkError("Robovoice URL must be http(s)", "bad_url");
  return `${u.protocol}//${u.host}`;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
