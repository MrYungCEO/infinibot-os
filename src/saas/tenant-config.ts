// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { InfinibotConfig } from "../config/types.js";
import type { ModelProviderConfig } from "../config/types.models.js";

export interface TenantConfig {
  version: 1;
  assistant?: { name?: string; avatar?: string };
  model?: { primary?: string; fallbacks?: string[] };
  modelProviders?: Record<string, ModelProviderConfig>;
  onboarding?: { completedAt?: string; completedBy?: string };
}

export const REDACTED = "__REDACTED__";

export function isSaasTenantScope(): boolean {
  return false;
}

export function resolveTenantWorkspaceRoot(): string {
  throw new Error("not available in the open-source build");
}

export function readTenantConfig(): TenantConfig {
  return { version: 1 };
}

export function updateTenantConfig(_mutate: (cfg: TenantConfig) => void): TenantConfig {
  throw new Error("not available in the open-source build");
}

export function applyTenantConfigOverlay(cfg: InfinibotConfig): InfinibotConfig {
  return cfg;
}

export function redactConfigForTenant<T>(value: T): T {
  return value;
}
