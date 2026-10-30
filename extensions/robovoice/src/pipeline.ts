/**
 * Robovoice location pipeline — the precedence merge and patch builder behind
 * the 3-step (STT → LLM → TTS) editor, mirrored from Robovoice so the editor
 * and a live call can't disagree:
 *
 *   Robovoice-Prod frontend/lib/location-config.ts  (overlaySettings / overlayCharacter)
 *   Robovoice-Prod src/robovoice/location_config.py (same rules in the agent)
 *   Robovoice-Prod frontend/lib/use-location-settings.ts (decide / buildPatch)
 *
 * Precedence, per field, most specific SET value wins:
 *   org global → location defaults → character → location × character override
 * "Set" = not null / undefined / "" (false, 0 and [] are real values).
 * Location defaults use the org's per-provider model fields (groq_model, …);
 * the character layers use the generic stt_model / llm_model. A more specific
 * layer that switches a stage's provider drops a less specific pinned model.
 */

/**
 * Field kinds, mirrored from Robovoice-Prod frontend/lib/location-config.ts
 * (LOCATION_DEFAULT_FIELDS / LOCATION_CHARACTER_FIELDS, coerceField). Robovoice
 * validates again on PATCH; mirroring the kinds lets the editor render the
 * right control (select / slider / toggle) and reject bad input before a
 * round trip.
 */
export type FieldKind =
  | { type: "str"; max: number }
  | { type: "num"; min: number; max: number; step: number }
  | { type: "int"; min: number; max: number; step: number }
  | { type: "bool" }
  | { type: "provider"; stage: "stt" | "llm" | "tts"; extra?: readonly string[] }
  | { type: "preemptive" }
  | { type: "ids" };

export const STT_PROVIDER_IDS = ["speaches", "groq", "fal", "vibevoice", "assemblyai", "soniox"] as const;
export const LLM_PROVIDER_IDS = ["ollama", "ollama_cloud", "groq", "gemini", "openrouter", "cerebras"] as const;
export const TTS_PROVIDER_IDS = ["kokoro", "piper", "elevenlabs", "fal", "qwen", "inworld"] as const;
export const PROVIDER_IDS: Record<"stt" | "llm" | "tts", readonly string[]> = {
  stt: STT_PROVIDER_IDS,
  llm: LLM_PROVIDER_IDS,
  tts: TTS_PROVIDER_IDS,
};

const str = (max: number): FieldKind => ({ type: "str", max });
const num = (min: number, max: number, step: number): FieldKind => ({ type: "num", min, max, step });
const int = (min: number, max: number, step: number): FieldKind => ({ type: "int", min, max, step });
const bool: FieldKind = { type: "bool" };

/** Every field a location may override (Robovoice LOCATION_DEFAULT_FIELDS, same order). */
export const LOCATION_DEFAULT_FIELD_KINDS: Record<string, FieldKind> = {
  stt_provider: { type: "provider", stage: "stt" },
  stt_language: str(16),
  stt_model_speaches: str(200),
  stt_model_groq: str(200),
  stt_model_assemblyai: str(200),
  stt_model_soniox: str(200),
  llm_provider: { type: "provider", stage: "llm" },
  groq_model: str(200),
  openrouter_model: str(200),
  ollama_model: str(200),
  ollama_cloud_model: str(200),
  gemini_model: str(200),
  cerebras_model: str(200),
  temperature: num(0, 2, 0.05),
  max_tokens: int(16, 4096, 1),
  tts_provider: { type: "provider", stage: "tts" },
  tts_voice_kokoro: str(200),
  tts_voice_elevenlabs: str(200),
  tts_voice_qwen: str(200),
  tts_voice_inworld: str(200),
  inworld_model_id: str(100),
  elevenlabs_model_id: str(100),
  elevenlabs_stability: num(0, 1, 0.05),
  elevenlabs_similarity_boost: num(0, 1, 0.05),
  elevenlabs_style: num(0, 1, 0.05),
  elevenlabs_speaker_boost: bool,
  min_endpointing_delay: num(0.05, 3, 0.05),
  allow_interruptions: bool,
  max_endpointing_delay: num(0.5, 10, 0.1),
  idle_billing_timeout_seconds: int(5, 3600, 5),
  min_interruption_duration: num(0.1, 3, 0.05),
  min_interruption_words: int(0, 10, 1),
  turn_detection_enabled: bool,
  vad_min_silence_duration: num(0.1, 1, 0.05),
  vad_activation_threshold: num(0.1, 0.9, 0.05),
  wake_word_enabled: bool,
  wake_word_threshold: num(0, 1, 0.01),
  wake_word_timeout: num(0.5, 30, 0.5),
  expressive_mode: bool,
  seamless_multilingual: bool,
  adaptive_language_enabled: bool,
  mixed_language_enabled: bool,
  auto_v3_voice_enabled: bool,
  preemptive_generation: { type: "preemptive" },
};

/** Every field a location × character override may set (Robovoice LOCATION_CHARACTER_FIELDS). */
export const LOCATION_CHARACTER_FIELD_KINDS: Record<string, FieldKind> = {
  stt_provider: { type: "provider", stage: "stt" },
  stt_model: str(200),
  llm_provider: { type: "provider", stage: "llm", extra: ["infinibot"] },
  llm_model: str(200),
  tts_provider: { type: "provider", stage: "tts" },
  tts_voice_kokoro: str(200),
  tts_voice_elevenlabs: str(200),
  tts_voice_qwen: str(200),
  tts_voice_inworld: str(200),
  inworld_model_id: str(100),
  elevenlabs_model_id: str(100),
  elevenlabs_stability: num(0, 1, 0.05),
  elevenlabs_similarity_boost: num(0, 1, 0.05),
  elevenlabs_style: num(0, 1, 0.05),
  elevenlabs_speaker_boost: bool,
  expressive_mode: bool,
  seamless_multilingual: bool,
  adaptive_language_enabled: bool,
  mixed_language_enabled: bool,
  auto_v3_voice_enabled: bool,
  preemptive_generation: { type: "preemptive" },
  max_endpointing_delay: num(0.5, 10, 0.1),
  idle_billing_timeout_seconds: int(5, 3600, 5),
  min_interruption_duration: num(0.1, 3, 0.05),
  min_interruption_words: int(0, 10, 1),
  turn_detection_enabled: bool,
  vad_min_silence_duration: num(0.1, 1, 0.05),
  vad_activation_threshold: num(0.1, 0.9, 0.05),
  wake_word_enabled: bool,
  wake_word_threshold: num(0, 1, 0.01),
  requires_signin: bool,
  temperature: num(0, 2, 0.05),
  always_on_session_enabled: bool,
  motion_threshold: num(0.01, 1, 0.01),
  motion_cooldown_seconds: num(1, 300, 1),
  mcp_servers: { type: "ids" },
  greeting: str(2000),
  system_prompt: str(12000),
  behavior_rules: str(4000),
  language: str(16),
  motion_profile: str(32),
};

export const LOCATION_DEFAULT_FIELDS = Object.keys(LOCATION_DEFAULT_FIELD_KINDS) as readonly string[];
export const LOCATION_CHARACTER_FIELDS = Object.keys(LOCATION_CHARACTER_FIELD_KINDS) as readonly string[];

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * Validate + coerce one field (Robovoice coerceField): null / "" = reset;
 * throws naming the field otherwise.
 */
export function coerceField(field: string, kind: FieldKind, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (kind.type) {
    case "str":
      if (typeof value !== "string") throw new Error(`${field}: expected a string`);
      return value.slice(0, kind.max);
    case "num":
    case "int": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field}: expected a number`);
      if (value < kind.min || value > kind.max) throw new Error(`${field}: must be between ${kind.min} and ${kind.max}`);
      return kind.type === "int" ? Math.round(value) : value;
    }
    case "bool":
      if (typeof value !== "boolean") throw new Error(`${field}: expected true/false`);
      return value;
    case "provider":
      if (typeof value !== "string" || !(PROVIDER_IDS[kind.stage].includes(value) || kind.extra?.includes(value))) {
        throw new Error(`${field}: unknown provider`);
      }
      return value;
    case "preemptive":
      if (typeof value === "boolean" || value === "auto") return value;
      throw new Error(`${field}: expected true, false or 'auto'`);
    case "ids":
      if (!Array.isArray(value) || value.length > 50 || !value.every((v) => typeof v === "string" && ID_RE.test(v))) {
        throw new Error(`${field}: expected a list of ids`);
      }
      return [...new Set(value as string[])];
  }
}

/** LLM provider id for "InfiniBot answers" (Robovoice-side: an OpenAI-compatible callback). */
export const INFINIBOT_LLM_PROVIDER = "infinibot";

export function infinibotLlmModel(agentId: string): string {
  return `infinibot:${agentId}`;
}

/** Agent id from an `infinibot:<agent>` model, else null. */
export function agentFromInfinibotModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const m = /^infinibot:([A-Za-z0-9_.-]{1,64})$/.exec(model.trim());
  return m ? m[1] : null;
}

export type Fields = Record<string, unknown>;
export type Stage = "stt" | "llm" | "tts";
export type Layer = "org" | "location" | "character" | "override";

export const isSet = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

function pickSet(o: Fields | null | undefined, keys: readonly string[]): Fields {
  const out: Fields = {};
  if (!o) return out;
  for (const k of keys) if (isSet(o[k])) out[k] = o[k];
  return out;
}

/** Org-level model field per provider (location-default layer). */
export const STT_MODEL_KEY: Record<string, string> = {
  speaches: "stt_model_speaches",
  groq: "stt_model_groq",
  assemblyai: "stt_model_assemblyai",
  soniox: "stt_model_soniox",
};
export const LLM_MODEL_KEY: Record<string, string> = {
  groq: "groq_model",
  openrouter: "openrouter_model",
  ollama: "ollama_model",
  ollama_cloud: "ollama_cloud_model",
  gemini: "gemini_model",
  cerebras: "cerebras_model",
};
export const TTS_VOICE_KEY = (provider: string) => `tts_voice_${provider}`;

/** org settings overlaid with the location defaults. */
export function overlaySettings(org: Fields, defaults: Fields | null | undefined): Fields {
  return { ...org, ...pickSet(defaults, LOCATION_DEFAULT_FIELDS) };
}

/** The character with the location × character override applied (Robovoice overlayCharacter). */
export function overlayCharacter(org: Fields, character: Fields, defaults: Fields | null | undefined, override: Fields | null | undefined): Fields {
  const d = defaults ?? {};
  const o = override ?? {};
  const base: Fields = { ...character };
  for (const [pk, mk] of [
    ["stt_provider", "stt_model"],
    ["llm_provider", "llm_model"],
  ] as const) {
    // Location switched the stage's provider away from the org's: a character
    // model pinned for the org provider would be wrong for it.
    if (isSet(d[pk]) && d[pk] !== org[pk] && !isSet(base[pk]) && isSet(base[mk])) base[mk] = "";
    // Override switches provider without naming a model: drop the pinned one.
    if (isSet(o[pk]) && !isSet(o[mk])) {
      const cur = base[pk] || d[pk] || org[pk];
      if (o[pk] !== cur) base[mk] = "";
    }
  }
  Object.assign(base, pickSet(o, LOCATION_CHARACTER_FIELDS));
  return base;
}

export type StageValue = { provider: string; model: string; providerFrom: Layer; modelFrom: Layer | null };
export type EffectivePipeline = { stt: StageValue; llm: StageValue; tts: StageValue };

/**
 * Effective STT/LLM/TTS for a character at a location, with the layer each
 * value came from (what the editor shows as Inherited / Overridden here).
 */
export function effectivePipeline(input: {
  org: Fields;
  defaults?: Fields | null;
  character?: Fields | null;
  override?: Fields | null;
}): EffectivePipeline {
  const org = input.org ?? {};
  const defaults = input.defaults ?? {};
  const own = input.character ?? {};
  const override = input.override ?? {};
  const settings = overlaySettings(org, defaults);
  const ch = input.character ? overlayCharacter(org, own, defaults, override) : {};
  const from = (key: string, charKey = key): Layer => {
    if (input.character && isSet(override[charKey])) return "override";
    if (input.character && isSet(own[charKey])) return "character";
    if (isSet(defaults[key])) return "location";
    return "org";
  };
  // No invented provider: a stage no Robovoice layer sets has provider "" (shown as not set).
  const stage = (pk: string, genericModel: string | null, modelKey: (p: string) => string | undefined): StageValue => {
    const provider = String((isSet(ch[pk]) ? ch[pk] : settings[pk]) ?? "");
    const providerFrom = from(pk);
    let model = "";
    let modelFrom: Layer | null = null;
    if (genericModel && isSet(ch[genericModel])) {
      model = String(ch[genericModel]);
      modelFrom = isSet(override[genericModel]) ? "override" : "character";
    } else {
      const k = modelKey(provider);
      if (k && isSet(settings[k])) {
        model = String(settings[k]);
        modelFrom = isSet(defaults[k]) ? "location" : "org";
      }
    }
    return { provider, model, providerFrom, modelFrom };
  };
  const stt = stage("stt_provider", "stt_model", (p) => STT_MODEL_KEY[p]);
  const llm = stage("llm_provider", "llm_model", (p) => LLM_MODEL_KEY[p]);
  // TTS: provider on the character (Robovoice keeps tts_provider per character),
  // voice keyed per provider: character/override tts_voice_<p>, else the
  // location/org tts_voice_<p>.
  const ttsProvider = String((isSet(ch.tts_provider) ? ch.tts_provider : settings.tts_provider) ?? "");
  const vk = ttsProvider ? TTS_VOICE_KEY(ttsProvider) : "";
  let voice = "";
  let voiceFrom: Layer | null = null;
  if (!vk) {
    // no TTS provider set anywhere → no voice either
  } else if (isSet(ch[vk])) {
    voice = String(ch[vk]);
    voiceFrom = isSet(override[vk]) ? "override" : "character";
  } else if (isSet(settings[vk])) {
    voice = String(settings[vk]);
    voiceFrom = isSet(defaults[vk]) ? "location" : "org";
  }
  return {
    stt,
    llm,
    tts: { provider: ttsProvider, model: voice, providerFrom: from("tts_provider"), modelFrom: voiceFrom },
  };
}

/**
 * Robovoice's `decide(value, inherited, stored)`: empty or equal to what would
 * be inherited → clear the override (null); differs from what's stored → send
 * it; otherwise nothing to send (undefined).
 */
export function decide(value: unknown, inherited: unknown, stored: unknown): unknown | null | undefined {
  if (!isSet(value) || value === inherited) return isSet(stored) ? null : undefined;
  if (value !== stored) return value;
  return undefined;
}

/** Patch for one scope from edited values; only allowed fields, only real changes. */
export function buildPatch(params: {
  fields: readonly string[];
  edited: Fields;
  inherited: Fields;
  stored: Fields;
}): Fields {
  const out: Fields = {};
  for (const k of params.fields) {
    if (!(k in params.edited)) continue;
    const d = decide(params.edited[k], params.inherited[k], params.stored[k]);
    if (d !== undefined) out[k] = d;
  }
  return out;
}

/** Keep only fields a patch may carry, coerced like Robovoice; null clears. Throws on unknown / bad fields. */
export function sanitizePatch(patch: unknown): { defaults?: Fields; characters?: Record<string, Fields | null> } {
  const out: { defaults?: Fields; characters?: Record<string, Fields | null> } = {};
  if (!patch || typeof patch !== "object") return out;
  const p = patch as Record<string, unknown>;
  const clean = (o: unknown, kinds: Record<string, FieldKind>, scope: string): Fields => {
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${scope} must be an object`);
    const r: Fields = {};
    for (const [k, v] of Object.entries(o as Fields)) {
      const kind = kinds[k];
      if (!kind) throw new Error(`${scope}: field "${k}" can't be set per location`);
      r[k] = coerceField(`${scope}.${k}`, kind, v);
    }
    return r;
  };
  if (p.defaults !== undefined) out.defaults = clean(p.defaults, LOCATION_DEFAULT_FIELD_KINDS, "defaults");
  if (p.characters !== undefined) {
    if (!p.characters || typeof p.characters !== "object") throw new Error("characters must be an object");
    out.characters = {};
    for (const [cid, o] of Object.entries(p.characters as Record<string, unknown>)) {
      if (!ID_RE.test(cid)) throw new Error(`bad character id "${cid}"`);
      out.characters[cid] = o === null ? null : clean(o, LOCATION_CHARACTER_FIELD_KINDS, `characters.${cid}`);
    }
  }
  return out;
}
