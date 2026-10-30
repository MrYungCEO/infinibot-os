/**
 * RPCs behind the Robovoice page's voice-pipeline sections and the per-agent
 * Voice settings:
 *
 *   robovoice.account.get          (read)   org, signed-in user, locations, linked + selected location
 *   robovoice.location.select      (admin)  location whose pipeline the editor edits
 *   robovoice.pipeline.config.get  (read)   location pipeline (org → location → character → override)
 *                                           with the effective value + layer of every stage
 *   robovoice.pipeline.catalog.get (read)   the org's tiered model catalog for a stage + credits/min
 *                                           per voice tier (price labels, "What this pipeline bills")
 *   robovoice.pipeline.config.set  (admin)  edit one scope (location defaults or one character);
 *                                           Robovoice's decide(): equal-to-inherited clears the override
 *   robovoice.voiceAgents.list     (read)   InfiniBot agents + voice-agent state, LLM backend; with
 *                                           { remote: true } each voice agent's REAL Robovoice voice
 *                                           (TTS provider + voice, language, STT, LLM) from Robovoice
 *   robovoice.voiceAgent.set       (admin)  toggle an agent as a Robovoice location agent, pick its
 *                                           LLM (InfiniBot gateway/CLI or the location's) and voice
 *   robovoice.voiceLlm.status      (read)   callback URL, token hint, bound state, recent turn timings
 *   robovoice.voiceLlm.set         (admin)  { mode: "auto" | "agent", fastModel } — fast path for conversational turns
 *   robovoice.voiceLlm.rotate      (admin)  new rvllm_ token for the location, re-synced to Robovoice
 *   robovoice.voiceLlm.test        (admin)  run one voice turn locally (same path the callback uses)
 */

import type { GatewayRequestHandler, RunVoiceTurn } from "infinibot/plugin-sdk";

import type { LocationPipelineConfig } from "./edge-api.js";
import { brokerPipeline, type BrokerPipeline } from "./cloud-broker.js";
import { clientFor } from "./provider.js";
import type { AgentPersonaLike, RobovoiceLinkService } from "./link.js";
import {
  buildPatch,
  effectivePipeline,
  infinibotLlmModel,
  INFINIBOT_LLM_PROVIDER,
  isSet,
  LOCATION_CHARACTER_FIELD_KINDS,
  LOCATION_CHARACTER_FIELDS,
  LOCATION_DEFAULT_FIELD_KINDS,
  LOCATION_DEFAULT_FIELDS,
  LLM_MODEL_KEY,
  overlayCharacter,
  overlaySettings,
  sanitizePatch,
  STT_MODEL_KEY,
  type Fields,
} from "./pipeline.js";
import {
  isVoiceLlmBackend,
  normalizeVoiceTiming,
  type AgentVoiceOverride,
  type RobovoiceSettingsStore,
  type VoiceTimingSettings,
} from "./settings.js";
import { VOICE_LLM_BASE_PATH, conversationHistory, formatTurnLine, ownerCallerEmails, turnStat, type VoiceLlmStats } from "./voice-llm.js";

export type VoicePipelineRpcDeps = {
  register: (method: string, handler: GatewayRequestHandler) => void;
  store: RobovoiceSettingsStore;
  service: () => RobovoiceLinkService;
  personas: () => AgentPersonaLike[];
  stats: VoiceLlmStats;
  voiceTurn: RunVoiceTurn;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  /**
   * InfiniBot Cloud: the hosted voice broker's URL (cloud-broker.ts). There is
   * no Robovoice link there, so an agent is callable as its own character (the
   * broker names the room by it) and "main" is a voice agent by default.
   */
  cloudBrokerUrl?: string | null;
  /** Test seam for the broker's pipeline read. */
  fetchBrokerPipeline?: (brokerUrl: string) => Promise<BrokerPipeline>;
};

/** Read-only notice for every pipeline edit on InfiniBot Cloud (broker mode). */
export const CLOUD_PIPELINE_READ_ONLY =
  "On InfiniBot Cloud, calls run the hosted voice pipeline. It is read-only here.";

/**
 * robovoice.pipeline.config.get in broker mode: the hosted pipeline every tenant
 * call runs, in the editor view's shape (no location, no characters, nothing
 * editable). Stages the broker hasn't published stay null ("unavailable").
 */
export function cloudPipelineView(p: BrokerPipeline) {
  const stage = (s: { provider: string; model: string } | undefined) =>
    s ? { provider: s.provider, model: s.model, providerFrom: "org" as const, modelFrom: s.model ? ("org" as const) : null } : null;
  const location = p.resolved ? { stt: stage(p.stt), llm: stage(p.llm), tts: stage(p.tts) } : null;
  return {
    cloud: true,
    editable: false,
    readOnlyReason: CLOUD_PIPELINE_READ_ONLY,
    resolved: p.resolved,
    ...(p.reason ? { reason: p.reason } : {}),
    locationId: null,
    locationName: "InfiniBot Cloud voice",
    org: {},
    defaults: {},
    characters: [],
    permissions: { canEditPipeline: false },
    activeCharacterId: null,
    agentByCharacter: {},
    effective: { location, characters: {} },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Values a scope inherits when it overrides nothing (what "Reset to inherited" returns to). */
export function inheritedFor(cfg: LocationPipelineConfig, characterId?: string): Fields {
  const org = cfg.org ?? {};
  if (!characterId) return { ...org };
  const ch = cfg.characters.find((c) => c.id === characterId);
  if (!ch) throw new Error(`character "${characterId}" is not at this location`);
  // Character layer + location defaults, without the location × character override.
  const settings = overlaySettings(org, cfg.defaults);
  const base = overlayCharacter(org, ch.own ?? {}, cfg.defaults, {});
  const eff = effectivePipeline({ org, defaults: cfg.defaults, character: ch.own, override: {} });
  const out: Fields = {};
  for (const k of LOCATION_CHARACTER_FIELDS) out[k] = isSet(base[k]) ? base[k] : settings[k];
  out.stt_provider = eff.stt.provider;
  out.stt_model = eff.stt.model;
  out.llm_provider = eff.llm.provider;
  out.llm_model = eff.llm.model;
  out.tts_provider = eff.tts.provider;
  out[`tts_voice_${eff.tts.provider}`] = eff.tts.model;
  return out;
}

/**
 * The character the global view's Text-to-Speech card edits. Robovoice has no
 * location-wide voice lane — its location Pipeline page binds TTS to the org's
 * active character — and the edge view doesn't carry active_character_id, so
 * InfiniBot's pick is: the Default character set on the Voice page, else the
 * character of this install's main agent, else the first callable one.
 */
export function activeCharacterFor(
  cfg: LocationPipelineConfig,
  agentByCharacter: Record<string, string>,
  preferred?: string | null,
): string | null {
  const callable = cfg.characters.filter((c) => (c as { callable?: boolean }).callable !== false);
  if (preferred && callable.some((c) => c.id === preferred)) return preferred;
  const main = callable.find((c) => agentByCharacter[c.id] === "main" || c.infinibot_agent_id === "main");
  return main?.id ?? callable[0]?.id ?? null;
}

/** The editor view: raw layers + effective pipeline per scope. */
export function pipelineView(
  cfg: LocationPipelineConfig,
  agentByCharacter: Record<string, string>,
  preferredCharacterId?: string | null,
) {
  const org = cfg.org ?? {};
  const location = effectivePipeline({ org, defaults: cfg.defaults });
  return {
    ...cfg,
    fields: { defaults: LOCATION_DEFAULT_FIELDS, character: LOCATION_CHARACTER_FIELDS },
    fieldKinds: { defaults: LOCATION_DEFAULT_FIELD_KINDS, character: LOCATION_CHARACTER_FIELD_KINDS },
    activeCharacterId: activeCharacterFor(cfg, agentByCharacter, preferredCharacterId),
    modelKeys: { stt: STT_MODEL_KEY, llm: LLM_MODEL_KEY },
    effective: {
      location,
      characters: Object.fromEntries(
        cfg.characters.map((c) => [
          c.id,
          effectivePipeline({ org, defaults: cfg.defaults, character: c.own, override: c.override }),
        ]),
      ),
    },
    inherited: {
      defaults: inheritedFor(cfg),
      characters: Object.fromEntries(cfg.characters.map((c) => [c.id, inheritedFor(cfg, c.id)])),
    },
    agentByCharacter,
  };
}

export function registerVoicePipelineRpcs(deps: VoicePipelineRpcDeps): void {
  const { register, store } = deps;
  const rpc =
    (fn: (p: Record<string, unknown>) => Promise<unknown> | unknown): GatewayRequestHandler =>
    async ({ params, respond }) => {
      try {
        respond(true, await fn(isRecord(params) ? params : {}));
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        respond(false, undefined, {
          code: typeof code === "string" && code ? code : "robovoice_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

  const selectedLocation = (p?: Record<string, unknown>): string => {
    const s = store.get();
    const id = str(p?.locationId) ?? s.pipelineLocationId ?? s.link?.locationId ?? s.locationId;
    if (!id) throw Object.assign(new Error("No Robovoice location yet — link this install first."), { code: "no_location" });
    return id;
  };

  const agentByCharacter = (): Record<string, string> => {
    const s = store.get();
    const out: Record<string, string> = {};
    for (const [agentId, ch] of Object.entries(s.linkedCharacters)) if (ch.characterId) out[ch.characterId] = agentId;
    for (const [agentId, cid] of Object.entries(s.characterMap)) out[cid] ??= agentId;
    return out;
  };

  register(
    "robovoice.account.get",
    rpc(async () => {
      const s = store.get();
      const base = {
        linked: Boolean(s.link && !s.link.unlinkedAt),
        link: s.link ?? null,
        selectedLocationId: s.pipelineLocationId ?? s.link?.locationId ?? s.locationId ?? null,
      };
      if (!store.secrets().edgeToken) return { ...base, org: null, locations: [], error: "Not signed in to Robovoice." };
      try {
        const me = await deps.service().api().meFull();
        return { ...base, org: me.org, user: me.user ?? null, locations: me.locations ?? [], credits: me.credits ?? null };
      } catch (err) {
        return {
          ...base,
          org: s.link ? { id: s.link.orgId, name: s.link.orgName } : null,
          locations: s.link?.locationId ? [{ id: s.link.locationId, name: s.link.locationName ?? s.link.locationId }] : [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  register(
    "robovoice.location.select",
    rpc((p) => {
      const id = str(p.locationId);
      if (id && !/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new Error("bad location id");
      store.update({ pipelineLocationId: id });
      return { selectedLocationId: id ?? store.get().link?.locationId ?? null };
    }),
  );

  const loadView = async (locationId: string) => {
    const cfg = await deps.service().api().pipelineGet(locationId);
    return pipelineView(cfg, agentByCharacter(), store.get().defaultCharacterId ?? null);
  };

  // InfiniBot Cloud: no Robovoice location; the broker's hosted pipeline instead
  // (unless this install was also linked to a Robovoice location by hand).
  const brokerMode = (p?: Record<string, unknown>): boolean => {
    if (!deps.cloudBrokerUrl) return false;
    const s = store.get();
    return !(str(p?.locationId) ?? s.pipelineLocationId ?? s.link?.locationId ?? s.locationId);
  };
  let cloudCache: { at: number; view: ReturnType<typeof cloudPipelineView> } | null = null;
  const cloudView = async () => {
    if (cloudCache && Date.now() - cloudCache.at < 60_000) return cloudCache.view;
    const url = deps.cloudBrokerUrl!;
    const p = await (deps.fetchBrokerPipeline ?? ((brokerUrl: string) => brokerPipeline({ brokerUrl })))(url);
    const view = cloudPipelineView(p);
    cloudCache = { at: Date.now(), view };
    return view;
  };
  const readOnlyInCloud = (p: Record<string, unknown>) => {
    if (brokerMode(p)) throw Object.assign(new Error(CLOUD_PIPELINE_READ_ONLY), { code: "cloud_read_only" });
  };

  register(
    "robovoice.pipeline.config.get",
    rpc((p) => (brokerMode(p) ? cloudView() : loadView(selectedLocation(p)))),
  );

  register(
    "robovoice.pipeline.catalog.get",
    rpc(async (p) => {
      const stage = p.stage;
      if (stage !== "stt" && stage !== "llm" && stage !== "tts") throw new Error("expected { stage: 'stt' | 'llm' | 'tts' }");
      readOnlyInCloud(p);
      return deps.service().api().catalog(stage);
    }),
  );

  register(
    "robovoice.pipeline.config.set",
    rpc(async (p) => {
      readOnlyInCloud(p);
      const locationId = selectedLocation(p);
      const api = deps.service().api();
      const cfg = await api.pipelineGet(locationId);
      if (!cfg.permissions?.canEditPipeline) {
        throw Object.assign(new Error("Your Robovoice role can't edit this location's pipeline."), { code: "forbidden" });
      }
      const characterId = str(p.characterId);
      let patch: { defaults?: Fields; characters?: Record<string, Fields | null> };
      const scopedPatch = (cid: string | undefined, raw: unknown, reset: unknown): Fields => {
        const values = isRecord(raw) ? { ...raw } : {};
        for (const k of Array.isArray(reset) ? reset : []) if (typeof k === "string") values[k] = null;
        const fields = cid ? LOCATION_CHARACTER_FIELDS : LOCATION_DEFAULT_FIELDS;
        const stored = cid ? (cfg.characters.find((c) => c.id === cid)?.override ?? {}) : (cfg.defaults ?? {});
        return buildPatch({ fields, edited: values, inherited: inheritedFor(cfg, cid), stored });
      };
      if (p.resetAll === true) {
        patch = characterId
          ? { characters: { [characterId]: null } }
          : { defaults: Object.fromEntries(Object.keys(cfg.defaults ?? {}).map((k) => [k, null])) };
      } else {
        const scoped = scopedPatch(characterId, p.values, p.reset);
        patch = characterId ? { characters: { [characterId]: scoped } } : { defaults: scoped };
        // Robovoice's location Pipeline page edits the location defaults AND the
        // active agent's Text-to-Speech (location × character) in one "Apply live":
        // `characterValues: { <characterId>: { field: value } }` rides the same PATCH.
        if (!characterId && isRecord(p.characterValues)) {
          for (const [cid, raw] of Object.entries(p.characterValues)) {
            if (!cfg.characters.some((c) => c.id === cid)) throw new Error(`character "${cid}" is not at this location`);
            const cp = scopedPatch(cid, raw, isRecord(p.characterReset) ? p.characterReset[cid] : undefined);
            if (Object.keys(cp).length) (patch.characters ??= {})[cid] = cp;
          }
        }
      }
      const clean = sanitizePatch(patch);
      const empty =
        (!clean.defaults || Object.keys(clean.defaults).length === 0) &&
        (!clean.characters || Object.values(clean.characters).every((c) => c !== null && Object.keys(c).length === 0));
      if (!empty) await api.pipelinePatch(locationId, clean);
      return { changed: !empty, patch: clean, view: await loadView(locationId) };
    }),
  );

  const agentsView = () => {
    const s = store.get();
    const cloud = Boolean(deps.cloudBrokerUrl);
    const linked = new Set(s.linkedAgents ?? (s.link || cloud ? ["main"] : []));
    return {
      linked: cloud || Boolean(s.link && !s.link.unlinkedAt),
      location: cloud ? "InfiniBot Cloud voice" : (s.link?.locationName ?? null),
      publicUrl: s.mcpPublicUrl ?? null,
      agents: deps.personas().map((a) => {
        const o: AgentVoiceOverride = s.agentOverrides[a.id] ?? {};
        return {
          ...a,
          voiceAgent: linked.has(a.id),
          characterId: s.linkedCharacters[a.id]?.characterId ?? (cloud && linked.has(a.id) ? a.id : null),
          syncedAt: s.linkedCharacters[a.id]?.syncedAt ?? null,
          error: s.linkedCharacters[a.id]?.error ?? null,
          llm: o.llm ?? "infinibot",
          llmBackend: o.llmBackend ?? "gateway",
          // Only what the owner picked here; the voice Robovoice actually uses is `robovoice` (remote).
          ttsProvider: o.ttsProvider ?? null,
          voice: o.voice ?? null,
          language: o.language ?? null,
          llmModel: (o.llm ?? "infinibot") === "infinibot" ? infinibotLlmModel(a.id) : null,
        };
      }),
    };
  };

  /**
   * Each voice agent's voice as Robovoice runs it: the character's effective
   * pipeline at the location (public /api/call/pipeline) + its language from
   * the roster, fetched in parallel. Nothing is defaulted — a failed lookup is
   * `voicesError`, not a guessed voice.
   */
  const robovoiceVoices = async (view: ReturnType<typeof agentsView>) => {
    const withChar = view.agents.filter((a) => a.characterId);
    if (!withChar.length) return { agents: view.agents.map((a) => ({ ...a, robovoice: null })), voicesError: null };
    const client = clientFor(store);
    if (!client) return { agents: view.agents.map((a) => ({ ...a, robovoice: null })), voicesError: "Connect Robovoice to see your agents' voices." };
    const locationId = store.get().link?.locationId;
    const errors: string[] = [];
    // Names + languages from the linked org's own roster at its location (the
    // public /api/call/characters lists the deployment owner's agents instead).
    const [roster, ...pipes] = await Promise.all([
      (locationId ? deps.service().api().pipelineGet(locationId) : Promise.reject(new Error("no linked location")))
        .then((cfg) => ({
          characters: cfg.characters.map((c) => ({
            id: c.id,
            name: c.name,
            language: typeof c.own?.language === "string" ? c.own.language : undefined,
          })),
        }))
        .catch((e: unknown) => (errors.push(e instanceof Error ? e.message : String(e)), null)),
      ...withChar.map((a) =>
        client.pipeline(a.characterId!, locationId).catch((e: unknown) => (errors.push(e instanceof Error ? e.message : String(e)), null)),
      ),
    ]);
    const byChar = new Map(withChar.map((a, i) => [a.characterId!, pipes[i]]));
    const agents = view.agents.map((a) => {
      const pipe = a.characterId ? byChar.get(a.characterId) : null;
      if (!pipe) return { ...a, robovoice: null };
      const ch = roster?.characters.find((c) => c.id === a.characterId);
      return {
        ...a,
        robovoice: {
          stt: { provider: pipe.stt?.provider ?? null, model: pipe.stt?.model ?? null },
          llm: { provider: pipe.llm?.provider ?? null, model: pipe.llm?.model ?? null },
          tts: { provider: pipe.tts?.provider ?? null, voice: pipe.tts?.model ?? null },
          language: ch?.language ?? null,
          characterName: ch?.name ?? null,
        },
      };
    });
    return { agents, voicesError: errors.length ? [...new Set(errors)].join("; ") : null };
  };

  register(
    "robovoice.voiceAgents.list",
    rpc(async (p) => {
      const view = agentsView();
      // Cloud: voices are the platform's; there is no Robovoice account to read them from.
      if (deps.cloudBrokerUrl) return { ...view, agents: view.agents.map((a) => ({ ...a, robovoice: null })), voicesError: null };
      return p.remote === true ? { ...view, ...(await robovoiceVoices(view)) } : view;
    }),
  );

  register(
    "robovoice.voiceAgent.set",
    rpc(async (p) => {
      const agentId = str(p.agentId);
      if (!agentId) throw new Error("expected { agentId }");
      if (!deps.personas().some((a) => a.id === agentId)) throw new Error(`unknown InfiniBot agent "${agentId}"`);
      const s = store.get();
      const prev = s.agentOverrides[agentId] ?? {};
      const next: AgentVoiceOverride = { ...prev };
      if (p.llm === "infinibot" || p.llm === "robovoice") next.llm = p.llm;
      if (p.llmBackend !== undefined) {
        if (!isVoiceLlmBackend(p.llmBackend)) throw new Error(`unknown LLM backend "${String(p.llmBackend)}"`);
        next.llmBackend = p.llmBackend;
      }
      if (p.ttsProvider !== undefined) next.ttsProvider = str(p.ttsProvider);
      if (p.voice !== undefined) next.voice = str(p.voice);
      if (p.language !== undefined) next.language = str(p.language);
      store.update({ agentOverrides: { ...s.agentOverrides, [agentId]: next } });
      const isVoice = (s.linkedAgents ?? (s.link || deps.cloudBrokerUrl ? ["main"] : [])).includes(agentId);
      const want = typeof p.enabled === "boolean" ? p.enabled : isVoice;
      let sync: unknown = null;
      let syncError: string | null = null;
      const linked = !deps.cloudBrokerUrl && Boolean(s.link && !s.link.unlinkedAt && store.secrets().edgeToken);
      if (!linked) {
        // Not linked yet: remember the choice; the first sync applies it.
        const list = new Set(s.linkedAgents ?? ["main"]);
        if (want) list.add(agentId);
        else list.delete(agentId);
        store.update({ linkedAgents: [...list] });
      } else {
        try {
          sync = want ? await deps.service().linkAgent(agentId) : isVoice ? await deps.service().unlinkAgent(agentId) : null;
        } catch (err) {
          syncError = err instanceof Error ? err.message : String(err);
        }
      }
      return { ...agentsView(), sync, syncError };
    }),
  );

  const voiceLlmStatus = () => {
    const s = store.get();
    const locationId = s.link?.locationId ?? null;
    const tokens = store.voiceLlmTokenState();
    const agents = (s.linkedAgents ?? []).filter((id) => (s.agentOverrides[id]?.llm ?? "infinibot") === "infinibot");
    return {
      publicUrl: s.mcpPublicUrl ?? null,
      baseUrl: s.mcpPublicUrl ? `${s.mcpPublicUrl}${VOICE_LLM_BASE_PATH}` : null,
      locationId,
      token: locationId && tokens[locationId] ? tokens[locationId] : null,
      bound: Boolean(s.mcpPublicUrl && locationId && tokens[locationId] && agents.length),
      agents,
      ownerCallerEmails: ownerCallerEmails(s),
      mode: s.voiceLlmMode ?? "auto",
      fastModel: s.voiceLlmFastModel ?? null,
      voiceTools: s.voiceTools ?? null,
      timing: s.voiceTiming ?? null,
      turns: deps.stats.list(),
      summary: deps.stats.summary(),
    };
  };

  register("robovoice.voiceLlm.status", rpc(() => voiceLlmStatus()));

  register(
    "robovoice.voiceLlm.set",
    rpc((p) => {
      const patch: {
        voiceLlmMode?: "auto" | "agent";
        voiceLlmFastModel?: string;
        voiceTools?: string[];
        voiceTiming?: VoiceTimingSettings;
      } = {};
      if (p.mode !== undefined) {
        if (p.mode !== "auto" && p.mode !== "agent") throw new Error('mode must be "auto" or "agent"');
        patch.voiceLlmMode = p.mode;
      }
      if (p.fastModel !== undefined) {
        const model = typeof p.fastModel === "string" ? p.fastModel.trim() : "";
        if (model.length > 200) throw new Error("fastModel is too long");
        patch.voiceLlmFastModel = model || undefined;
      }
      if (p.voiceTools !== undefined) {
        // null / [] = back to the gateway's default voice allowlist.
        const tools = Array.isArray(p.voiceTools)
          ? p.voiceTools.filter((t: unknown): t is string => typeof t === "string" && !!t.trim()).map((t: string) => t.trim())
          : [];
        patch.voiceTools = tools.length ? tools : undefined;
      }
      if (p.timing !== undefined) {
        // Merged into the current overrides; null clears them all.
        patch.voiceTiming =
          p.timing === null ? undefined : normalizeVoiceTiming({ ...(store.get().voiceTiming ?? {}), ...(p.timing as object) });
      }
      store.update(patch);
      return voiceLlmStatus();
    }),
  );

  register(
    "robovoice.voiceLlm.rotate",
    rpc(async () => {
      const s = store.get();
      if (!s.link?.locationId) throw new Error("Link this install to a Robovoice location first.");
      store.rotateVoiceLlmToken(s.link.locationId);
      let syncError: string | null = null;
      try {
        await deps.service().sync();
      } catch (err) {
        syncError = err instanceof Error ? err.message : String(err);
      }
      return { ...voiceLlmStatus(), syncError };
    }),
  );

  register(
    "robovoice.voiceLlm.test",
    rpc(async (p) => {
      const agentId = str(p.agentId) ?? "main";
      const s = store.get();
      const o = s.agentOverrides[agentId] ?? {};
      const backend = isVoiceLlmBackend(p.backend) ? p.backend : (o.llmBackend ?? "gateway");
      const deltas: Array<{ t: number; text: string }> = [];
      const t0 = Date.now();
      const mode = p.mode === "agent" || p.mode === "auto" ? p.mode : (s.voiceLlmMode ?? "auto");
      const history = Array.isArray(p.history) ? conversationHistory(p.history) : undefined;
      if (p.poll === true || p.callEnded === true) {
        // What a quiet call would hear now (progress / results of background work).
        const polled = await deps.voiceTurn({
          agentId,
          backend,
          message: "",
          pollUpdates: p.poll === true,
          callEnded: p.callEnded === true,
          callKey: str(p.callKey) ?? `test:${agentId}`,
          provider: "robovoice",
          callerIsOwner: p.owner === true,
          voiceTiming: s.voiceTiming,
          onDelta: () => {},
        });
        return { updates: polled.updates ?? [], running: polled.running ?? 0, sessionKey: polled.sessionKey };
      }
      const r = await deps.voiceTurn({
        agentId,
        backend,
        message: str(p.message) ?? "Say hello in one short sentence.",
        callKey: str(p.callKey) ?? `test:${agentId}`,
        provider: "robovoice",
        // An operator RPC: the operator may test a turn as the owner.
        callerIsOwner: p.owner === true,
        mode,
        fastModel: str(p.fastModel) ?? s.voiceLlmFastModel,
        voiceTools: s.voiceTools,
        voiceTiming: s.voiceTiming,
        history,
        onDelta: (text) => deltas.push({ t: Date.now() - t0, text }),
      });
      const stat = turnStat({ agentId, locationId: "test", backend, trust: r.trust, call: "test" }, r, t0);
      deps.stats.add(stat);
      deps.log?.info(formatTurnLine(stat));
      return { ...r, deltas: deltas.length, llmProvider: INFINIBOT_LLM_PROVIDER };
    }),
  );
}
