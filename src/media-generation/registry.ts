import { ComfyUiMediaProvider } from "./comfyui-provider.js";
import type { MediaGenerationJob, MediaGenerationProvider } from "./types.js";

export type RegisteredMediaProvider = {
  provider: MediaGenerationProvider;
  source: "core" | "plugin";
  pluginId?: string;
};

export class MediaProviderRegistry {
  private readonly builtIns = new Map<string, MediaGenerationProvider>();
  private pluginProviders: () => Array<{ pluginId: string; provider: MediaGenerationProvider }>;

  constructor(
    pluginProviders: () => Array<{
      pluginId: string;
      provider: MediaGenerationProvider;
    }> = () => [],
  ) {
    this.pluginProviders = pluginProviders;
  }

  setPluginProviderSource(
    source: () => Array<{ pluginId: string; provider: MediaGenerationProvider }>,
  ): void {
    this.pluginProviders = source;
  }

  registerBuiltIn(provider: MediaGenerationProvider): void {
    if (this.builtIns.has(provider.id))
      throw new Error(`Media provider already registered: ${provider.id}`);
    this.builtIns.set(provider.id, provider);
  }

  list(): RegisteredMediaProvider[] {
    const out: RegisteredMediaProvider[] = [...this.builtIns.values()].map((provider) => ({
      provider,
      source: "core",
    }));
    for (const item of this.pluginProviders()) {
      const existing = out.find((entry) => entry.provider.id === item.provider.id);
      if (existing) throw new Error(`Media provider already registered: ${item.provider.id}`);
      out.push({ provider: item.provider, source: "plugin", pluginId: item.pluginId });
    }
    return out;
  }

  get(id: string): MediaGenerationProvider | undefined {
    return this.list().find((entry) => entry.provider.id === id)?.provider;
  }

  require(id: string): MediaGenerationProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`Unknown media provider: ${id}`);
    return provider;
  }

  async waitForCompletion(
    providerId: string,
    initial: MediaGenerationJob,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<MediaGenerationJob> {
    if (["succeeded", "failed", "cancelled"].includes(initial.status)) return initial;
    const provider = this.require(providerId);
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    const pollMs = options.pollMs ?? 1_500;
    let current = initial;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      current = await provider.getStatus(initial.id);
      if (["succeeded", "failed", "cancelled"].includes(current.status)) return current;
    }
    throw new Error(`Media generation job ${initial.id} timed out`);
  }
}

let singleton: MediaProviderRegistry | undefined;

export function getMediaProviderRegistry(): MediaProviderRegistry {
  if (!singleton) {
    singleton = new MediaProviderRegistry(() => {
      // Lazy require avoids coupling provider users to plugin-loader startup.
      const registry = (
        globalThis as typeof globalThis & {
          __infinibotMediaPluginProviders?: Array<{
            pluginId: string;
            provider: MediaGenerationProvider;
          }>;
        }
      ).__infinibotMediaPluginProviders;
      return registry ?? [];
    });
    singleton.registerBuiltIn(new ComfyUiMediaProvider());
  }
  return singleton;
}

export function setActivePluginMediaProviders(
  providers: Array<{ pluginId: string; provider: MediaGenerationProvider }>,
): void {
  (
    globalThis as typeof globalThis & {
      __infinibotMediaPluginProviders?: Array<{
        pluginId: string;
        provider: MediaGenerationProvider;
      }>;
    }
  ).__infinibotMediaPluginProviders = providers;
}

/** Test hook: returns an isolated registry without touching process globals. */
export function createMediaProviderRegistryForTest(
  pluginProviders: () => Array<{ pluginId: string; provider: MediaGenerationProvider }> = () => [],
): MediaProviderRegistry {
  return new MediaProviderRegistry(pluginProviders);
}
