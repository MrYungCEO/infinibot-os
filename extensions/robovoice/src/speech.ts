/**
 * Metered one-shot speech through the linked Robovoice org: the chat
 * sidebar's read-aloud (TTS) and talk button (STT). Every synthesis and every
 * transcription is charged by Robovoice to the org wallet as its own ledger
 * line (kind `tts` per character, kind `stt` per second; 1 credit = 1 s of
 * standard voice) — this side never meters on its own, it only relays what
 * Robovoice charged and refuses early when Robovoice already told us the
 * wallet is empty.
 *
 * Robovoice endpoints (frontend/app/api/edge/infinibot/speech/**, branch
 * feat/infinibot-speech-metering), `rve_` token, scoped to the linked location:
 *
 *   GET  /api/edge/infinibot/speech?location=     catalog + credit prices + wallet
 *   POST /api/edge/infinibot/speech/estimate      credits a request would cost
 *   POST /api/edge/infinibot/speech/tts           text → audio, charged
 *   POST /api/edge/infinibot/speech/stt           audio → text, charged
 *
 * Nothing here has a default provider, model or voice: the catalog is exactly
 * what the org's Robovoice account lists, and a request names its own choice.
 */

import { randomUUID } from "node:crypto";

import { EdgeApiError, type RobovoiceEdgeApi } from "./edge-api.js";

export type SpeechWallet = {
  availableCredits: number;
  balanceCredits: number;
  enforcement: string;
  /** Enforced wallet with nothing available: every request is refused. */
  empty: boolean;
};

export type SpeechOption = { id: string; name: string; note?: string };

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

export type SpeechUnavailable = {
  available: false;
  /** not_linked: plugin on but no Robovoice link; error: Robovoice didn't answer. */
  reason: "not_linked" | "error";
  message: string;
};

export type SpeechCharge = {
  /** Credits actually debited for this request (0 on shadow/off wallets). */
  credits: number;
  ratedCredits: number;
  charged: boolean;
  duplicate?: boolean;
  ledgerKind: "tts" | "stt" | null;
  wallet: SpeechWallet;
};

export type SpeechRating = {
  kind: "tts" | "stt";
  tier: string | null;
  chars: number | null;
  seconds: number | null;
  credits: number;
};

export class RobovoiceSpeechError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly wallet?: SpeechWallet,
  ) {
    super(message);
    this.name = "RobovoiceSpeechError";
  }
}

/** Cloud read-aloud/talk is free; a refusal means Robovoice is busy (fair-use limit). */
export const SPEECH_BUSY_MESSAGE = "Cloud voice is busy right now. Switch to local voice to keep talking.";

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => Boolean(v && typeof v === "object" && !Array.isArray(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const opts = (v: unknown): SpeechOption[] =>
  Array.isArray(v)
    ? v
        .filter((o): o is Raw => isRecord(o) && typeof o.id === "string" && Boolean(o.id))
        .map((o) => ({ id: o.id as string, name: str(o.name) ?? (o.id as string), ...(str(o.note) ? { note: str(o.note) } : {}) }))
    : [];

export function parseWallet(v: unknown): SpeechWallet | null {
  if (!isRecord(v) || v.available_credits === undefined) return null;
  return {
    availableCredits: num(v.available_credits),
    balanceCredits: num(v.balance_credits),
    enforcement: str(v.enforcement) ?? "enforce",
    empty: v.empty === true,
  };
}

export function parseCatalog(body: Raw, now = new Date()): SpeechCatalog {
  const p = isRecord(body.pricing) ? body.pricing : {};
  const perK = isRecord(p.tts_credits_per_1k_chars) ? p.tts_credits_per_1k_chars : {};
  const limits = isRecord(p.limits) ? p.limits : {};
  const wallet = parseWallet(body.wallet);
  if (!wallet) throw new RobovoiceSpeechError("Robovoice didn't report the wallet for speech.", "bad_response", 502);
  return {
    available: true,
    locationId: str(body.location_id) ?? "",
    tts: (Array.isArray(body.tts) ? body.tts : []).filter(isRecord).map((t) => ({
      id: String(t.id),
      label: str(t.label) ?? String(t.id),
      local: t.local === true,
      models: opts(t.models),
      voices: opts(t.voices),
    })),
    ttsUnavailable: (Array.isArray(body.tts_unavailable) ? body.tts_unavailable : []).filter(isRecord).map((t) => ({
      id: String(t.id),
      label: str(t.label) ?? String(t.id),
      reason: str(t.reason) ?? "unavailable",
    })),
    stt: (Array.isArray(body.stt) ? body.stt : []).filter(isRecord).map((t) => ({
      id: String(t.id),
      label: str(t.label) ?? String(t.id),
      models: opts(t.models),
    })),
    pricing: {
      creditUsd: num(p.credit_usd),
      ttsCreditsPer1kChars: { standard: num(perK.standard), premium: num(perK.premium), expressive: num(perK.expressive) },
      ttsTierRules: (Array.isArray(p.tts_tier_rules) ? p.tts_tier_rules : []).filter(isRecord).map((r) => ({
        provider: String(r.provider ?? "*"),
        model: str(r.model) ?? null,
        tier: String(r.tier ?? "standard"),
      })),
      sttCreditsPerSecond: num(p.stt_credits_per_second),
      limits: { ttsMaxChars: num(limits.tts_max_chars), sttMaxSeconds: num(limits.stt_max_seconds) },
    },
    wallet,
    fetchedAt: now.toISOString(),
  };
}

function parseCharge(v: unknown): SpeechCharge {
  const c = isRecord(v) ? v : {};
  const wallet = parseWallet(c.wallet);
  if (!wallet) throw new RobovoiceSpeechError("Robovoice didn't report the charge.", "bad_response", 502);
  return {
    credits: num(c.credits),
    ratedCredits: num(c.rated_credits),
    charged: c.charged === true,
    ...(c.duplicate === true ? { duplicate: true } : {}),
    ledgerKind: c.ledger_kind === "tts" || c.ledger_kind === "stt" ? c.ledger_kind : null,
    wallet,
  };
}

function parseRating(v: unknown): SpeechRating {
  const r = isRecord(v) ? v : {};
  return {
    kind: r.kind === "stt" ? "stt" : "tts",
    tier: str(r.tier) ?? null,
    chars: typeof r.chars === "number" ? r.chars : null,
    seconds: typeof r.seconds === "number" ? r.seconds : null,
    credits: num(r.credits),
  };
}

/** The wallet as last reported by Robovoice (catalog, estimate or a charge). */
type WalletMemo = { at: number; wallet: SpeechWallet };

export type SpeechServiceDeps = {
  /** The edge client with the install's `rve_` token, or null when not linked. */
  api: () => RobovoiceEdgeApi | null;
  /** The linked location id, or null when not linked. */
  locationId: () => string | null;
  now?: () => number;
  requestId?: () => string;
};

export class RobovoiceSpeechService {
  private walletMemo: WalletMemo | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: SpeechServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.requestId ?? (() => `ib-${randomUUID()}`);
  }

  /** The wallet Robovoice last reported (null before the first answer). */
  lastWallet(): SpeechWallet | null {
    return this.walletMemo?.wallet ?? null;
  }

  private remember(w: SpeechWallet | null | undefined) {
    if (w) this.walletMemo = { at: this.now(), wallet: w };
  }

  private target(): { api: RobovoiceEdgeApi; location: string } {
    const api = this.deps.api();
    const location = this.deps.locationId();
    if (!api || !location)
      throw new RobovoiceSpeechError("Connect Robovoice to use read-aloud and talk.", "not_linked", 409);
    return { api, location };
  }


  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof EdgeApiError) {
        // No credit prompts in InfiniBot: any balance/limit refusal is "busy, use local voice".
        if (e.status === 402 || e.status === 429 || e.code === "wallet_empty" || e.code === "insufficient_balance" || e.code === "cloud_voice_busy")
          throw new RobovoiceSpeechError(SPEECH_BUSY_MESSAGE, "cloud_voice_busy", 429);
        const code = e.code ?? "robovoice_error";
        throw new RobovoiceSpeechError(e.message, code, e.status || 502);
      }
      throw e;
    }
  }

  async catalog(): Promise<SpeechCatalog | SpeechUnavailable> {
    const api = this.deps.api();
    const location = this.deps.locationId();
    if (!api || !location)
      return { available: false, reason: "not_linked", message: "Connect Robovoice to use read-aloud and talk." };
    try {
      const body = await api.request<Raw>("/api/edge/infinibot/speech", { query: { location } });
      const cat = parseCatalog(body, new Date(this.now()));
      this.remember(cat.wallet);
      return cat;
    } catch (e) {
      return { available: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async estimate(
    p: { kind: "tts"; provider: string; model?: string; text?: string; chars?: number } | { kind: "stt"; seconds: number },
  ): Promise<{ estimate: SpeechRating; allowed: boolean; code?: string; message?: string; wallet: SpeechWallet }> {
    const { api, location } = this.target();
    const body = await this.call(() =>
      api.request<Raw>("/api/edge/infinibot/speech/estimate", { method: "POST", body: { location, ...p } }),
    );
    const wallet = parseWallet(body.wallet);
    this.remember(wallet);
    return {
      estimate: parseRating(body.estimate),
      allowed: body.allowed === true,
      ...(str(body.code) ? { code: str(body.code) } : {}),
      ...(str(body.message) ? { message: str(body.message) } : {}),
      wallet: wallet ?? { availableCredits: 0, balanceCredits: 0, enforcement: "enforce", empty: true },
    };
  }

  async tts(p: { provider: string; model?: string; voice: string; text: string; requestId?: string }) {
    if (!p.provider || !p.voice) throw new RobovoiceSpeechError("Pick a Robovoice voice first.", "bad_request");
    const text = p.text.trim();
    if (!text) throw new RobovoiceSpeechError("Nothing to read.", "bad_request");
    const { api, location } = this.target();
    const requestId = p.requestId ?? this.newId();
    const body = await this.call(() =>
      api.request<Raw>("/api/edge/infinibot/speech/tts", {
        method: "POST",
        body: { location, request_id: requestId, provider: p.provider, model: p.model, voice: p.voice, text },
      }),
    );
    const audio = str(body.audio_base64);
    if (!audio) throw new RobovoiceSpeechError("Robovoice returned no audio.", "bad_response", 502);
    const charge = parseCharge(body.charge);
    this.remember(charge.wallet);
    return {
      requestId,
      audioBase64: audio,
      mime: str(body.mime) ?? "audio/mpeg",
      rating: parseRating(body.rating),
      charge,
    };
  }

  async stt(p: {
    provider: string;
    model: string;
    audioBase64: string;
    mime: string;
    durationMs: number;
    language?: string;
    requestId?: string;
  }) {
    if (!p.provider || !p.model) throw new RobovoiceSpeechError("Pick a Robovoice speech-to-text model first.", "bad_request");
    if (!p.audioBase64) throw new RobovoiceSpeechError("No audio recorded.", "bad_request");
    if (!(p.durationMs > 0)) throw new RobovoiceSpeechError("Recording length is missing.", "bad_request");
    const { api, location } = this.target();
    const requestId = p.requestId ?? this.newId();
    const body = await this.call(() =>
      api.request<Raw>("/api/edge/infinibot/speech/stt", {
        method: "POST",
        body: {
          location,
          request_id: requestId,
          provider: p.provider,
          model: p.model,
          audio_base64: p.audioBase64,
          mime: p.mime,
          duration_ms: Math.round(p.durationMs),
          language: p.language,
        },
      }),
    );
    const charge = parseCharge(body.charge);
    this.remember(charge.wallet);
    return {
      requestId,
      text: typeof body.text === "string" ? body.text : "",
      rating: parseRating(body.rating),
      charge,
    };
  }
}
