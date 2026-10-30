/**
 * Pure state for the chat sidebar's Robovoice speech (read-aloud + talk):
 * gating, persisted picks, local credit estimates and the text that gets
 * spoken. The catalog and every price come from robovoice.speech.catalog —
 * the org's real Robovoice account — so nothing here names a provider, model
 * or voice of its own.
 */

export type SpeechOption = { id: string; name: string; note?: string };

export type SpeechWallet = {
  availableCredits: number;
  balanceCredits: number;
  enforcement: string;
  empty: boolean;
};

export type SpeechCatalog = {
  available: true;
  locationId: string;
  tts: Array<{ id: string; label: string; local: boolean; models: SpeechOption[]; voices: SpeechOption[] }>;
  ttsUnavailable: Array<{ id: string; label: string; reason: string }>;
  stt: Array<{ id: string; label: string; models: SpeechOption[] }>;
  pricing: {
    creditUsd: number;
    ttsCreditsPer1kChars: { standard: number; premium: number; expressive: number };
    ttsTierRules: Array<{ provider: string; model?: string | null; tier: string }>;
    sttCreditsPerSecond: number;
    limits: { ttsMaxChars: number; sttMaxSeconds: number };
  };
  wallet: SpeechWallet;
  fetchedAt: string;
};

export type SpeechUnavailable = { available: false; reason: string; message: string };

export type SpeechCharge = {
  credits: number;
  ratedCredits: number;
  charged: boolean;
  ledgerKind: "tts" | "stt" | null;
  wallet: SpeechWallet;
};

/**
 * What the sidebar shows:
 *   hidden     — still asking (nothing rendered yet)
 *   connect    — Robovoice plugin off, or on but not linked → "Connect Robovoice" hint only
 *   error      — linked, but Robovoice didn't answer → message + retry
 *   empty      — Robovoice refused (busy / fair-use limit) → "Cloud voice is busy — switch to local voice"
 *   ready      — controls live
 */
export type SpeechGate =
  | { kind: "hidden" }
  | { kind: "connect"; pluginEnabled: boolean }
  | { kind: "error"; message: string }
  | { kind: "empty"; catalog: SpeechCatalog }
  | { kind: "ready"; catalog: SpeechCatalog };

/** Cloud voice is free: a refusal means busy, with a one-click switch to local voice (never a top-up). */
export const WALLET_EMPTY_TEXT = "Cloud voice is busy — switch to local voice";

export function speechGate(input: {
  pluginEnabled: boolean;
  loaded: boolean;
  catalog: SpeechCatalog | SpeechUnavailable | null;
  /** RPC failure (plugin missing / method not served). */
  rpcError?: string | null;
  wallet?: SpeechWallet | null;
}): SpeechGate {
  if (!input.pluginEnabled) return { kind: "connect", pluginEnabled: false };
  if (!input.loaded) return { kind: "hidden" };
  if (input.rpcError) {
    return /unknown method|not declared|plugin.*disabled|not found/i.test(input.rpcError)
      ? { kind: "connect", pluginEnabled: false }
      : { kind: "error", message: input.rpcError };
  }
  const c = input.catalog;
  if (!c) return { kind: "hidden" };
  if (!c.available) return c.reason === "not_linked" ? { kind: "connect", pluginEnabled: true } : { kind: "error", message: c.message };
  const wallet = input.wallet ?? c.wallet;
  const catalog = wallet === c.wallet ? c : { ...c, wallet };
  return wallet.empty ? { kind: "empty", catalog } : { kind: "ready", catalog };
}

/** Error code from a gateway RPC failure (GatewayRequestError carries it). */
export function errorCode(e: unknown): string | null {
  const c = (e as { gatewayCode?: unknown; code?: unknown })?.gatewayCode ?? (e as { code?: unknown })?.code;
  return typeof c === "string" ? c : null;
}

export function isWalletEmptyError(e: unknown): boolean {
  const code = errorCode(e);
  return (
    code === "wallet_empty" ||
    code === "cloud_voice_busy" ||
    /wallet empty|cloud voice is busy/i.test(e instanceof Error ? e.message : String(e ?? ""))
  );
}

// --- persisted picks -------------------------------------------------------------

export const SPEECH_PREFS_KEY = "infinibot.chatSpeech.prefs";

export type SpeechPrefs = {
  /** Read assistant replies aloud as they arrive. */
  readAloud: boolean;
  ttsProvider: string | null;
  ttsModel: string | null;
  ttsVoice: string | null;
  sttProvider: string | null;
  sttModel: string | null;
  /** Send the transcript as soon as it lands (else it waits in the composer). */
  autoSend: boolean;
};

export const EMPTY_PREFS: SpeechPrefs = {
  readAloud: false,
  ttsProvider: null,
  ttsModel: null,
  ttsVoice: null,
  sttProvider: null,
  sttModel: null,
  autoSend: false,
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

export function loadSpeechPrefs(storage: StorageLike | null | undefined): SpeechPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(SPEECH_PREFS_KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { ...EMPTY_PREFS };
    return {
      readAloud: raw.readAloud === true,
      ttsProvider: s(raw.ttsProvider),
      ttsModel: s(raw.ttsModel),
      ttsVoice: s(raw.ttsVoice),
      sttProvider: s(raw.sttProvider),
      sttModel: s(raw.sttModel),
      autoSend: raw.autoSend === true,
    };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

export function saveSpeechPrefs(storage: StorageLike | null | undefined, p: SpeechPrefs): void {
  try {
    storage?.setItem(SPEECH_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked */
  }
}

/**
 * Keep only picks that still exist in the org's catalog (a voice removed on
 * Robovoice must not linger). Nothing is filled in: an unset pick stays unset
 * until the user chooses.
 */
export function reconcilePrefs(p: SpeechPrefs, c: SpeechCatalog): SpeechPrefs {
  const out = { ...p };
  const tts = c.tts.find((t) => t.id === p.ttsProvider);
  if (!tts) {
    out.ttsProvider = null;
    out.ttsModel = null;
    out.ttsVoice = null;
  } else {
    if (out.ttsModel && !tts.models.some((m) => m.id === out.ttsModel)) out.ttsModel = null;
    if (out.ttsVoice && !tts.voices.some((v) => v.id === out.ttsVoice)) out.ttsVoice = null;
  }
  const stt = c.stt.find((t) => t.id === p.sttProvider);
  if (!stt) {
    out.sttProvider = null;
    out.sttModel = null;
  } else if (out.sttModel && !stt.models.some((m) => m.id === out.sttModel)) out.sttModel = null;
  if (!out.ttsVoice) out.readAloud = false;
  return out;
}

/** A TTS request needs a provider + voice (+ a model when the provider lists models). */
export function ttsReady(p: SpeechPrefs, c: SpeechCatalog | null): boolean {
  if (!c || !p.ttsProvider || !p.ttsVoice) return false;
  const t = c.tts.find((x) => x.id === p.ttsProvider);
  if (!t || !t.voices.some((v) => v.id === p.ttsVoice)) return false;
  return !t.models.length || Boolean(p.ttsModel && t.models.some((m) => m.id === p.ttsModel));
}

export function sttReady(p: SpeechPrefs, c: SpeechCatalog | null): boolean {
  if (!c || !p.sttProvider || !p.sttModel) return false;
  return Boolean(c.stt.find((x) => x.id === p.sttProvider)?.models.some((m) => m.id === p.sttModel));
}

// --- estimates (same rules Robovoice charges by) ---------------------------------

type Tier = "standard" | "premium" | "expressive";

/** Mirrors Robovoice's rating.tierFor over the card's tier rules. */
export function ttsTier(c: SpeechCatalog, provider: string, model: string | null): Tier {
  const p = provider.toLowerCase();
  const m = (model ?? "").toLowerCase();
  for (const r of c.pricing.ttsTierRules) {
    const rp = r.provider.toLowerCase();
    if (rp !== "*" && rp !== p) continue;
    if (r.model && r.model.toLowerCase() !== m) continue;
    return r.tier === "premium" || r.tier === "expressive" ? r.tier : "standard";
  }
  return "standard";
}

export function roundCredits(c: number): number {
  if (!(c > 0)) return 0;
  return c < 10 ? Math.round(c * 100) / 100 : Math.round(c * 10) / 10;
}

export function estimateTtsCredits(c: SpeechCatalog, provider: string, model: string | null, chars: number): number {
  const per1k = c.pricing.ttsCreditsPer1kChars[ttsTier(c, provider, model)];
  return roundCredits((Math.max(0, chars) * per1k) / 1000);
}

export function estimateSttCredits(c: SpeechCatalog, seconds: number): number {
  const s = Math.max(1, Math.ceil(seconds));
  return roundCredits(s * c.pricing.sttCreditsPerSecond);
}

export function formatCredits(n: number): string {
  if (!(n > 0)) return "0 cr";
  if (n < 1) return `${n.toFixed(2)} cr`;
  if (n < 10) return `${(Math.round(n * 10) / 10).toString()} cr`;
  return `${Math.round(n).toLocaleString()} cr`;
}

// --- what gets spoken ------------------------------------------------------------

/** Markdown → speakable plain text: code blocks, URLs, tables and markup dropped. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Split into ≤ max-char pieces at sentence / line boundaries (each piece is one charged request). */
export function speechChunks(text: string, max: number): string[] {
  const clean = text.trim();
  if (!clean || !(max > 0)) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?\n]+[.!?]*[\s\n]*|\n+/g) ?? [clean];
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    let s = raw;
    while (s.length > max) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      const cut = s.lastIndexOf(" ", max) > max / 2 ? s.lastIndexOf(" ", max) : max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if ((cur + s).length > max) {
      if (cur.trim()) out.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Local voice's speech catalog: what this gateway runs itself. Nothing is
 * metered, so prices are 0 and the wallet is never empty (and never shown).
 */
export const LOCAL_SPEECH_CATALOG: SpeechCatalog = {
  available: true,
  locationId: "local",
  tts: [
    {
      id: "local",
      label: "Local (Kokoro)",
      local: true,
      models: [],
      voices: [{ id: "configured", name: "Local voice", note: "voice.json / Kokoro" }],
    },
  ],
  ttsUnavailable: [],
  stt: [{ id: "local", label: "Local (Whisper)", models: [{ id: "whisper", name: "Whisper" }] }],
  pricing: {
    creditUsd: 0,
    ttsCreditsPer1kChars: { standard: 0, premium: 0, expressive: 0 },
    ttsTierRules: [],
    sttCreditsPerSecond: 0,
    limits: { ttsMaxChars: 1500, sttMaxSeconds: 300 },
  },
  wallet: { availableCredits: 0, balanceCredits: 0, enforcement: "none", empty: false },
  fetchedAt: new Date(0).toISOString(),
};
