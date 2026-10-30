import type { InfinibotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

export type OllamaDiscovery = {
  host: string;
  running: boolean;
  models: string[];
};

export function resolveOnboardingOllamaHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OLLAMA_HOST?.trim();
  if (!configured) return DEFAULT_OLLAMA_HOST;
  const withScheme = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
  try {
    const url = new URL(withScheme);
    return url.origin;
  } catch {
    return DEFAULT_OLLAMA_HOST;
  }
}

export async function discoverOnboardingOllama(params?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OllamaDiscovery> {
  const host = resolveOnboardingOllamaHost(params?.env);
  const fetchImpl = params?.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${host}/api/tags`, {
      signal: AbortSignal.timeout(params?.timeoutMs ?? 3_000),
    });
    if (!response.ok) return { host, running: false, models: [] };
    const body = (await response.json()) as { models?: Array<{ name?: unknown }> };
    const models = Array.isArray(body.models)
      ? body.models
          .map((model) => (typeof model?.name === "string" ? model.name.trim() : ""))
          .filter((name): name is string => name.length > 0)
      : [];
    return { host, running: true, models: [...new Set(models)] };
  } catch {
    return { host, running: false, models: [] };
  }
}

export function ollamaModelDefinition(id: string): ModelDefinitionConfig {
  const lower = id.toLowerCase();
  return {
    id,
    name: id,
    reasoning: lower.includes("reasoning") || lower.includes("qwen3") || lower.includes("r1"),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function withOllamaProvider(
  config: InfinibotConfig,
  discovery: OllamaDiscovery,
  setDefaultModel: boolean,
): InfinibotConfig {
  const firstModel = discovery.models[0];
  const currentModel = config.agents?.defaults?.model;
  const modelConfig =
    typeof currentModel === "string" ? { primary: currentModel } : { ...currentModel };

  return {
    ...config,
    models: {
      ...config.models,
      mode: config.models?.mode ?? "merge",
      providers: {
        ...config.models?.providers,
        ollama: {
          baseUrl: `${discovery.host}/v1`,
          apiKey: "ollama",
          api: "openai-completions",
          models: discovery.models.map(ollamaModelDefinition),
        },
      },
    },
    agents: setDefaultModel
      ? {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: { ...modelConfig, primary: `ollama/${firstModel}` },
          },
        }
      : config.agents,
  };
}

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") return null;

  const discovery = await discoverOnboardingOllama();
  if (!discovery.running) {
    await params.prompter.note(
      `No Ollama server was detected at ${discovery.host}. Start it with \`ollama serve\`, pull a model, then re-run onboarding.`,
      "Ollama not detected",
    );
    return { config: params.config };
  }
  if (discovery.models.length === 0) {
    await params.prompter.note(
      `Ollama is running at ${discovery.host}, but it has no installed models. Run \`ollama pull llama3.2\`, then re-run onboarding.`,
      "No Ollama models",
    );
    return { config: params.config };
  }

  await params.prompter.note(
    discovery.models.map((model) => `- ${model}`).join("\n"),
    `Ollama models detected (${discovery.models.length})`,
  );
  const config = withOllamaProvider(params.config, discovery, params.setDefaultModel);
  return {
    config,
    agentModelOverride: params.agentId ? `ollama/${discovery.models[0]}` : undefined,
  };
}

export const __testing = { modelDefinition: ollamaModelDefinition, withOllamaProvider } as const;
