/**
 * Unified voice-setup config schema.
 *
 * This is the single source of truth for the `voice` block's setup fields
 * (provider / cloud / native / fallback). The top-level config schema
 * (`src/config/zod-schema.ts`) imports these so the same shape is validated
 * whether the config is written by the wizard, the `voice doctor` CLI, or
 * hand-edited in `infinibot.json`.
 *
 * The top-level `voice` block ALSO carries federation endpoint overrides
 * (kokoroUrl / speachesUrl / livekitUrl …) written by the satellite
 * bootstrap. Those are intentionally NOT part of this schema — the setup
 * parser strips unknown keys so the two concerns coexist in one block
 * ("don't fragment the config").
 */
import { z } from "zod";

/** Cloud TTS providers we can drive through a managed API key. */
export const VoiceCloudTtsProviderSchema = z.enum(["openai", "elevenlabs", "edge"]);
export type VoiceCloudTtsProvider = z.infer<typeof VoiceCloudTtsProviderSchema>;

/** Local (native) TTS engines. Both run as local containers/binaries. */
export const VoiceNativeTtsProviderSchema = z.enum(["kokoro", "piper"]);
export type VoiceNativeTtsProvider = z.infer<typeof VoiceNativeTtsProviderSchema>;

/** Known local Whisper STT model sizes. Free-form string accepted too so a
 *  user can point at a custom faster-whisper model id. */
export const VoiceNativeSttModelSchema = z.string().min(1);

export const VoiceCloudSchema = z
  .object({
    /** STT is OpenAI-only for the managed path today. */
    stt: z.literal("openai").default("openai"),
    tts: VoiceCloudTtsProviderSchema,
    /** Managed-provider API key. Required — a cloud config without a key is
     *  invalid (this is what the wizard validates before continuing). */
    apiKey: z.string().min(1, "cloud voice requires an API key"),
    ttsVoice: z.string().optional(),
    ttsModel: z.string().optional(),
  })
  // strip (default) so a stray field doesn't hard-fail an otherwise-valid
  // config, but the required apiKey above still rejects bad input.
  .strip();
export type VoiceCloudConfig = z.infer<typeof VoiceCloudSchema>;

export const VoiceNativeSchema = z
  .object({
    tts: VoiceNativeTtsProviderSchema,
    ttsVoice: z.string().optional(),
    sttModel: VoiceNativeSttModelSchema.optional(),
    wakeWord: z.boolean().optional(),
  })
  .strip();
export type VoiceNativeConfig = z.infer<typeof VoiceNativeSchema>;

export const VoiceFallbackSchema = z.enum(["cloud-to-native", "native-to-cloud", "off"]);
export type VoiceFallback = z.infer<typeof VoiceFallbackSchema>;

export const VoiceProviderSchema = z.enum(["cloud", "native"]);
export type VoiceProvider = z.infer<typeof VoiceProviderSchema>;

/**
 * The validated voice-setup shape. `.strip()` (not `.strict()`) so the
 * federation endpoint-override keys that share the `voice` block survive a
 * parse. `superRefine` enforces the cross-field invariant: the selected
 * provider's sub-block must be present.
 */
export const VoiceSetupSchema = z
  .object({
    provider: VoiceProviderSchema,
    cloud: VoiceCloudSchema.optional(),
    native: VoiceNativeSchema.optional(),
    fallback: VoiceFallbackSchema.optional(),
  })
  .strip()
  .superRefine((val, ctx) => {
    if (val.provider === "cloud" && !val.cloud) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloud"],
        message: 'provider is "cloud" but no cloud config was provided',
      });
    }
    if (val.provider === "native" && !val.native) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["native"],
        message: 'provider is "native" but no native config was provided',
      });
    }
  });
export type VoiceSetupConfig = z.infer<typeof VoiceSetupSchema>;

/**
 * The setup-only fields, as a plain object schema (no refinement). Imported
 * by the top-level config schema and merged into the existing `voice` block
 * so `infinibot doctor` validates these fields too. Kept refinement-free so
 * it composes with `.passthrough()` on the parent without surprises.
 */
export const VoiceSetupFieldsSchema = z.object({
  provider: VoiceProviderSchema.optional(),
  cloud: VoiceCloudSchema.optional(),
  native: VoiceNativeSchema.optional(),
  fallback: VoiceFallbackSchema.optional(),
});

/** Default native Whisper model when none is chosen. */
export const DEFAULT_NATIVE_STT_MODEL = "whisper-base";
/** Default Kokoro voice (matches the legacy voice-settings.json default). */
export const DEFAULT_KOKORO_VOICE = "bm_george";
/** Default Piper voice. */
export const DEFAULT_PIPER_VOICE = "en_US-kristin-medium";
