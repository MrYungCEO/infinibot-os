/**
 * robovoice.speech.* — metered read-aloud + talk for the chat sidebar
 * (see ./speech.ts for the Robovoice endpoints and the charging model):
 *
 *   robovoice.speech.catalog   (read)   { available:false, reason } when not linked, else the
 *                                       org's real TTS providers → models + voices, STT
 *                                       providers → models, credit prices and the wallet
 *   robovoice.speech.estimate  (read)   credits a tts (text/chars) or stt (seconds) request
 *                                       would cost, and whether the wallet can pay
 *   robovoice.speech.tts       (write)  text → { audioBase64, mime, rating, charge }
 *   robovoice.speech.stt       (write)  { audioBase64, mime, durationMs } → { text, rating, charge }
 *
 * Errors carry Robovoice's code (`wallet_empty`, `insufficient_balance`,
 * `not_linked`, `provider_error`, …) and, when known, `details.wallet`.
 */

import type { GatewayRequestHandler } from "infinibot/plugin-sdk";

import type { RobovoiceLinkService } from "./link.js";
import type { RobovoiceSettingsStore } from "./settings.js";
import { RobovoiceSpeechError, RobovoiceSpeechService } from "./speech.js";

export type SpeechRpcDeps = {
  register: (method: string, handler: GatewayRequestHandler) => void;
  store: RobovoiceSettingsStore;
  service: () => RobovoiceLinkService;
};

type Params = Record<string, unknown>;
const isRecord = (v: unknown): v is Params => Boolean(v && typeof v === "object" && !Array.isArray(v));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function createSpeechService(deps: Pick<SpeechRpcDeps, "store" | "service">): RobovoiceSpeechService {
  const linked = () => {
    const s = deps.store.get();
    return Boolean(s.link && !s.link.unlinkedAt && s.link.locationId && deps.store.secrets().edgeToken);
  };
  return new RobovoiceSpeechService({
    api: () => (linked() ? deps.service().api() : null),
    locationId: () => (linked() ? (deps.store.get().link?.locationId ?? null) : null),
  });
}

export function registerSpeechRpcs(deps: SpeechRpcDeps): RobovoiceSpeechService {
  const speech = createSpeechService(deps);
  const rpc =
    (fn: (p: Params) => Promise<unknown>): GatewayRequestHandler =>
    async ({ params, respond }) => {
      try {
        respond(true, await fn(isRecord(params) ? params : {}));
      } catch (err) {
        if (err instanceof RobovoiceSpeechError) {
          respond(false, undefined, {
            code: err.code,
            message: err.message,
            ...(err.wallet ? { details: { wallet: err.wallet } } : {}),
          });
          return;
        }
        const code = (err as { code?: unknown }).code;
        respond(false, undefined, {
          code: typeof code === "string" && code ? code : "robovoice_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

  deps.register(
    "robovoice.speech.catalog",
    rpc(async () => {
      return await speech.catalog();
    }),
  );
  deps.register(
    "robovoice.speech.estimate",
    rpc(async (p) => {
      if (p.kind === "stt") {
        const seconds = Number(p.seconds ?? (Number(p.durationMs) || 0) / 1000);
        if (!(seconds > 0)) throw new RobovoiceSpeechError("expected { kind:'stt', seconds }", "bad_request");
        return speech.estimate({ kind: "stt", seconds });
      }
      const provider = str(p.provider);
      if (p.kind !== "tts" || !provider)
        throw new RobovoiceSpeechError("expected { kind:'tts', provider, model?, text | chars }", "bad_request");
      return speech.estimate({
        kind: "tts",
        provider,
        model: str(p.model),
        ...(typeof p.text === "string" ? { text: p.text } : { chars: Number(p.chars) || 0 }),
      });
    }),
  );
  deps.register(
    "robovoice.speech.tts",
    rpc(async (p) =>
      speech.tts({
        provider: str(p.provider) ?? "",
        model: str(p.model),
        voice: str(p.voice) ?? "",
        text: typeof p.text === "string" ? p.text : "",
        requestId: str(p.requestId),
      }),
    ),
  );
  deps.register(
    "robovoice.speech.stt",
    rpc(async (p) =>
      speech.stt({
        provider: str(p.provider) ?? "",
        model: str(p.model) ?? "",
        audioBase64: typeof p.audioBase64 === "string" ? p.audioBase64 : "",
        mime: str(p.mime) ?? "audio/webm",
        durationMs: Number(p.durationMs) || 0,
        language: str(p.language),
        requestId: str(p.requestId),
      }),
    ),
  );
  return speech;
}
