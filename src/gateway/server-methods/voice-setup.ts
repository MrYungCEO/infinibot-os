/**
 * Voice setup RPC handlers — backing the browser wizard's "Voice" step.
 *
 * Naming convention mirrors the quickstart handlers: `voice.setup.<action>`.
 * These are intentionally thin wrappers over src/voice/* so the same logic
 * the CLI wizard uses also serves the browser UI (single source of truth).
 *
 * Allowlisted into the standalone setup-ui in src/setup-ui/dispatch.ts.
 */
import { loadVoiceSetup, saveVoiceSetup } from "../../voice/config.js";
import { resolveVoiceNode, setVoiceNode, type VoiceNode } from "../voice/config.js";
import { probeVoiceService, resolveVoiceUrlsForNode } from "../server-voice-urls.js";
import {
  VoiceSetupSchema,
  type VoiceCloudTtsProvider,
  type VoiceSetupConfig,
} from "../../voice/schema.js";
import { detectNativeModels, validateCloudVoiceKey } from "../../voice/validate.js";
import { runVoiceSmokeTest } from "../../voice/smoke-test.js";
import { runVoiceDoctorChecks } from "../../commands/voice-doctor.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/io.js";
import { ollamaModelDefinition } from "../../commands/auth-choice.apply.ollama.js";
import { probeVoiceRuntime } from "../voice/runtime-status.js";
import type { GatewayRequestHandlers } from "./types.js";
import { coerceString } from "../../shared/text/coerce.js";

// ── Voice "brain" (conversational LLM) helpers ──────────────────────────────
//
// The voice setup wizard lets the user pin the gateway agent's conversational
// brain to a *local* Ollama model (private, offline) instead of the configured
// cloud default. Both choices write the single authoritative field the rest of
// the agent stack reads: `agents.defaults.model.primary` (a "provider/model"
// ref string). We deliberately reuse the same config field the quickstart
// Models step writes — there is no separate "voice brain" config block.

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Resolve the Ollama host the same way the safety-net does (env override → default). */
function resolveOllamaHostFromEnv(): string {
  const envHost = process.env.OLLAMA_HOST?.trim();
  if (!envHost) return DEFAULT_OLLAMA_HOST;
  const withScheme = envHost.startsWith("http") ? envHost : `http://${envHost}`;
  return withScheme.replace(/\/+$/, "");
}

/** Hit `/api/tags` and return the installed model list (running:false on any failure). */
async function listOllamaModels(
  host: string,
): Promise<{ running: boolean; host: string; models: string[] }> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { running: false, host, models: [] };
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(data?.models)
      ? data.models
          .map((m) => (typeof m?.name === "string" ? m.name.trim() : ""))
          .filter((name): name is string => name.length > 0)
      : [];
    return { running: true, host, models };
  } catch {
    return { running: false, host, models: [] };
  }
}

/** Read the current `agents.defaults.model.primary` from on-disk config. */
function readBrainPrimary(parsed: Record<string, unknown>): string | null {
  const agents = parsed.agents as { defaults?: { model?: unknown } } | undefined;
  const modelField = agents?.defaults?.model;
  if (typeof modelField === "string") return modelField;
  if (modelField && typeof modelField === "object") {
    const primary = (modelField as { primary?: unknown }).primary;
    if (typeof primary === "string" && primary.length > 0) return primary;
  }
  return null;
}

export const voiceSetupHandlers: GatewayRequestHandlers = {
  /** Current setup + live native-model detection for the step's initial render. */
  "voice.setup.get": async ({ respond }) => {
    const setup = await loadVoiceSetup();
    const models = await detectNativeModels();
    respond(true, { setup, models });
  },

  /** Validate a cloud provider API key before the user commits. */
  "voice.setup.validateKey": async ({ params, respond }) => {
    const provider = String(
      (params as { provider?: string }).provider ?? "",
    ) as VoiceCloudTtsProvider;
    const apiKey = String((params as { apiKey?: string }).apiKey ?? "");
    if (!["openai", "elevenlabs", "edge"].includes(provider)) {
      respond(false, undefined, { code: "BAD_PROVIDER", message: `unknown provider: ${provider}` });
      return;
    }
    const result = await validateCloudVoiceKey(provider, apiKey);
    respond(true, result);
  },

  /** Persist a chosen setup into the unified config block. */
  "voice.setup.save": async ({ params, respond }) => {
    const parsed = VoiceSetupSchema.safeParse((params as { setup?: unknown }).setup);
    if (!parsed.success) {
      respond(false, undefined, {
        code: "INVALID_SETUP",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    const saved = await saveVoiceSetup(parsed.data as VoiceSetupConfig);
    // One-shot readiness probe so the wizard's Done summary reflects REAL
    // reachability (not just "configured" booleans). Never leave the user in a
    // state where STT/TTS silently has no working provider — surface a warning.
    const runtime = await probeVoiceRuntime();
    const warnings: string[] = [];
    if (!runtime.stt.reachable) warnings.push(`STT: ${runtime.stt.detail}`);
    if (!runtime.tts.reachable) warnings.push(`TTS: ${runtime.tts.detail}`);
    respond(true, { setup: saved, runtime, warnings });
  },

  /**
   * Live STT/TTS readiness — provider, endpoint, and ACTUAL reachability for
   * each component. Backs the wizard Done summary + dashboard 🎙 indicator so
   * they show real readiness rather than a "configured" boolean. Read-only.
   */
  "voice.runtime.status": async ({ respond }) => {
    const runtime = await probeVoiceRuntime();
    respond(true, runtime);
  },

  // ── Satellite-wide voice node toggle (local Docker vs master) ──────────────
  // NODE-LOCAL (the `voice.` prefix is intentionally NOT proxied to master):
  // each node decides which voice backend IT uses, so a satellite can run its
  // own Docker stack or borrow the master's. See server-voice-urls.ts for the
  // routing + automatic fallback the toggle drives.

  /** Read the current voice node selection ("local" | "master"). */
  "voice.node.get": async ({ respond }) => {
    respond(true, { node: resolveVoiceNode() });
  },

  /** Set the voice node selection. Validates the value and persists to voice.json. */
  "voice.node.set": async ({ params, respond }) => {
    const node = coerceString((params as { node?: unknown })?.node);
    if (node !== "local" && node !== "master") {
      respond(false, undefined, {
        code: "BAD_NODE",
        message: `voice node must be "local" or "master", got: ${node}`,
      });
      return;
    }
    const cfg = setVoiceNode(node as VoiceNode);
    respond(true, { node: cfg.voiceNode ?? node });
  },

  /**
   * Capability discovery for the toggle UI: probe THIS node's local Kokoro/
   * Speaches and the master-derived URLs so the picker only offers a node that
   * actually answers. `master.configured` distinguishes a satellite (master
   * URLs differ from localhost) from a standalone (both localhost).
   */
  "voice.nodes.list": async ({ respond }) => {
    const local = resolveVoiceUrlsForNode("local");
    const master = resolveVoiceUrlsForNode("master");
    const masterConfigured = master.kokoro !== local.kokoro || master.speaches !== local.speaches;

    const [localKokoro, localSpeaches, masterKokoro, masterSpeaches] = await Promise.all([
      probeVoiceService(local.kokoro),
      probeVoiceService(local.speaches),
      masterConfigured ? probeVoiceService(master.kokoro) : Promise.resolve(false),
      masterConfigured ? probeVoiceService(master.speaches) : Promise.resolve(false),
    ]);

    respond(true, {
      current: resolveVoiceNode(),
      local: {
        kokoroUrl: local.kokoro,
        speachesUrl: local.speaches,
        kokoro: localKokoro,
        speaches: localSpeaches,
        available: localKokoro || localSpeaches,
      },
      master: {
        configured: masterConfigured,
        kokoroUrl: master.kokoro,
        speachesUrl: master.speaches,
        kokoro: masterKokoro,
        speaches: masterSpeaches,
        available: masterConfigured && (masterKokoro || masterSpeaches),
      },
    });
  },

  /** Run the round-trip smoke test (uses the current config unless one is passed). */
  "voice.setup.smoke": async ({ params, respond }) => {
    const provided = (params as { setup?: unknown }).setup;
    const parsed = provided ? VoiceSetupSchema.safeParse(provided) : null;
    const setup = parsed?.success ? (parsed.data as VoiceSetupConfig) : undefined;
    const result = await runVoiceSmokeTest(setup ? { setup } : undefined);
    respond(true, result);
  },

  /** Full doctor report (table data) for the UI to render inline. */
  "voice.setup.doctor": async ({ respond }) => {
    const report = await runVoiceDoctorChecks();
    respond(true, report);
  },

  /**
   * List locally-installed Ollama models for the "Voice brain → Local" picker.
   * Returns `running:false` (with the probed host + an install hint) when no
   * local daemon answers, so the UI can show "Ollama not detected".
   */
  "voice.setup.ollamaModels": async ({ respond }) => {
    const host = resolveOllamaHostFromEnv();
    const probe = await listOllamaModels(host);
    respond(true, {
      ...probe,
      installHint: probe.running
        ? undefined
        : "Install from https://ollama.com then run `ollama serve` and `ollama pull llama3.2`.",
    });
  },

  /**
   * Read the current conversational brain selection so the picker can
   * pre-select Cloud vs Local (Ollama) on first render.
   */
  "voice.setup.brainGet": async ({ respond }) => {
    const snap = await readConfigFileSnapshot();
    const parsed =
      snap.parsed && typeof snap.parsed === "object" && !Array.isArray(snap.parsed)
        ? (snap.parsed as Record<string, unknown>)
        : {};
    const primary = readBrainPrimary(parsed);
    const isOllama = !!primary && primary.startsWith("ollama/");
    respond(true, {
      primary,
      provider: isOllama ? "ollama" : "cloud",
      modelId: isOllama ? primary!.slice("ollama/".length) : (primary ?? null),
    });
  },

  /**
   * Pin the gateway agent's conversational brain.
   *   - provider:"ollama" + modelId → writes `agents.defaults.model.primary`
   *     to `ollama/<modelId>` and records the local host as the provider
   *     baseUrl/endpoint so model resolution finds the local daemon.
   *   - provider:"cloud" + modelId ("anthropic/claude-…" etc.) → writes that
   *     ref as the primary, restoring the configured cloud default.
   * Writes the SAME field the quickstart Models step uses — there is no
   * separate voice-brain config block.
   */
  "voice.setup.brain": async ({ params, respond }) => {
    const provider = String((params as { provider?: string }).provider ?? "");
    const modelIdRaw = String((params as { modelId?: string }).modelId ?? "").trim();
    if (provider !== "ollama" && provider !== "cloud") {
      respond(false, undefined, {
        code: "BAD_PROVIDER",
        message: `voice brain provider must be "ollama" or "cloud", got: ${provider}`,
      });
      return;
    }
    if (!modelIdRaw) {
      respond(false, undefined, {
        code: "MISSING_MODEL",
        message:
          'modelId is required (e.g. "llama3.2" for ollama or "anthropic/claude-opus-4-8" for cloud).',
      });
      return;
    }

    const snap = await readConfigFileSnapshot();
    const base =
      snap.parsed && typeof snap.parsed === "object" && !Array.isArray(snap.parsed)
        ? { ...(snap.parsed as Record<string, unknown>) }
        : {};

    // For ollama the picker passes a bare model name; for cloud it passes a
    // full provider/model ref (so the picker can offer any configured cloud
    // model). Normalize both to a `provider/model` primary ref.
    const primary = provider === "ollama" ? `ollama/${modelIdRaw}` : modelIdRaw;

    const agents = (base.agents as Record<string, unknown> | undefined) ?? {};
    const defaults = (agents.defaults as Record<string, unknown> | undefined) ?? {};
    const modelField = defaults.model;
    // Preserve any existing fallbacks object shape; only swap `primary`.
    const nextModel =
      modelField && typeof modelField === "object" && !Array.isArray(modelField)
        ? { ...(modelField as Record<string, unknown>), primary }
        : { primary };
    base.agents = { ...agents, defaults: { ...defaults, model: nextModel } };

    if (provider === "ollama") {
      // Ensure the provider block exists so model resolution can reach the
      // local daemon. Don't clobber an existing baseUrl the user set.
      const models = (base.models as Record<string, unknown> | undefined) ?? {};
      const providers = (models.providers as Record<string, unknown> | undefined) ?? {};
      const ollamaCfg = (providers.ollama as Record<string, unknown> | undefined) ?? {};
      const host = resolveOllamaHostFromEnv();
      // Model entries are definitions ({ id, name, … }), never bare names: a
      // bare string fails config validation and the model is never saved.
      const fresh = typeof ollamaCfg.baseUrl !== "string";
      // A new block lists every installed model (like CLI onboarding), so the
      // explicit provider doesn't hide the other local models.
      const seed =
        fresh && !Array.isArray(ollamaCfg.models) ? (await listOllamaModels(host)).models : [];
      const ollamaModels = (
        Array.isArray(ollamaCfg.models) ? (ollamaCfg.models as unknown[]) : seed
      ).map((m) => (typeof m === "string" ? ollamaModelDefinition(m) : m));
      if (!ollamaModels.some((m) => (m as { id?: unknown })?.id === modelIdRaw)) {
        ollamaModels.push(ollamaModelDefinition(modelIdRaw));
      }
      base.models = {
        ...models,
        ...(fresh && !models.mode ? { mode: "merge" } : {}),
        providers: {
          ...providers,
          ollama: {
            // A new block matches what CLI onboarding writes for Ollama.
            ...(fresh ? { apiKey: "ollama", api: "openai-completions" } : {}),
            ...ollamaCfg,
            baseUrl: fresh ? `${host.replace(/\/+$/, "")}/v1` : ollamaCfg.baseUrl,
            models: ollamaModels,
          },
        },
      };
    }

    await writeConfigFile(base as never);
    respond(true, { primary, provider, modelId: modelIdRaw, restartRequired: true });
  },
};
