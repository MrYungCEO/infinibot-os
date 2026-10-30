/**
 * Voice-provider RPCs — which backend serves voice.
 *
 *   voice.providers.list   (read)  every registered provider + live status,
 *                                  the configured selection and the active one.
 *   voice.providers.select (write) set `voice.backend` ("auto" | provider id).
 *                                  Hot: `voice.backend` is a no-restart config
 *                                  prefix and is re-read on every voice request.
 *
 * Registry + selection rules: src/gateway/voice/provider-registry.ts.
 */

import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/config.js";
import { ensureLocalVoiceProvider } from "../voice/local-provider.js";
import {
  configuredVoiceBackend,
  listVoiceProviders,
  resolveVoiceProvider,
  type VoiceCapability,
  type VoiceProviderStatus,
} from "../voice/provider-registry.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const VOICE_PROVIDERS_READ_METHODS = ["voice.providers.list"] as const;
export const VOICE_PROVIDERS_WRITE_METHODS = ["voice.providers.select"] as const;

const STATUS_TIMEOUT_MS = 4000;

async function statusWithTimeout(
  fn: () => Promise<VoiceProviderStatus>,
): Promise<VoiceProviderStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<VoiceProviderStatus>((resolve) => {
        timer = setTimeout(
          () => resolve({ ready: false, error: "status check timed out" }),
          STATUS_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    return { ready: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build the list payload. Exported for tests. */
export async function buildVoiceProvidersPayload() {
  ensureLocalVoiceProvider();
  const backend = configuredVoiceBackend();
  const active: Record<VoiceCapability, string | null> = {
    realtime: resolveVoiceProvider("realtime", backend).provider?.id ?? null,
    stt: resolveVoiceProvider("stt", backend).provider?.id ?? null,
    tts: resolveVoiceProvider("tts", backend).provider?.id ?? null,
    wakeWord: resolveVoiceProvider("wakeWord", backend).provider?.id ?? null,
  };
  const realtime = resolveVoiceProvider("realtime", backend);
  const providers = await Promise.all(
    listVoiceProviders().map(async ({ provider, source }) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      capabilities: [...provider.capabilities],
      source: source === "builtin" ? "builtin" : "plugin",
      pluginId: source === "builtin" ? undefined : source.pluginId,
      active: active.realtime === provider.id,
      status: await statusWithTimeout(() => provider.status()),
      wakeWord: provider.wakeWord?.() ?? null,
    })),
  );
  return {
    backend,
    active,
    fellBack: realtime.fellBack,
    fallbackReason: realtime.reason,
    providers,
  };
}

/** Pure config transform, exported for tests. */
export function setVoiceBackendInConfig(cfg: InfinibotConfig, backend: string): InfinibotConfig {
  const voice = { ...(cfg as { voice?: Record<string, unknown> }).voice };
  if (backend === "auto") delete voice.backend;
  else voice.backend = backend;
  return { ...cfg, voice } as InfinibotConfig;
}

export const voiceProvidersHandlers: GatewayRequestHandlers = {
  "voice.providers.list": async ({ respond }) => {
    respond(true, await buildVoiceProvidersPayload());
  },

  "voice.providers.select": async ({ params, respond }) => {
    ensureLocalVoiceProvider();
    const id =
      typeof (params as { id?: unknown })?.id === "string"
        ? (params as { id: string }).id.trim()
        : "";
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, 'expected { id: "auto" | providerId }'),
      );
      return;
    }
    if (id !== "auto" && !listVoiceProviders().some((r) => r.provider.id === id)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown voice provider "${id}"`),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "config file is invalid"));
      return;
    }
    const validated = validateConfigObjectWithPlugins(setVoiceBackendInConfig(snapshot.config, id));
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    await writeConfigFile(validated.config);
    respond(true, await buildVoiceProvidersPayload());
  },
};
