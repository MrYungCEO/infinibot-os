/**
 * Session thinking-level options + value mapping, shared by the sessions table
 * and the webchat model picker. Values are what `sessions.patch
 * { thinkingLevel }` accepts; "" means "inherit" (patch null).
 */
export const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high"] as const;
export const BINARY_THINK_LEVELS = ["", "off", "on"] as const;

export function normalizeProviderId(provider?: string | null): string {
  if (!provider) return "";
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  return normalized;
}

/** Z.ai only exposes on/off thinking. */
export function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

export function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

export function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) return value;
  if (!value || value === "off") return value;
  return "on";
}

export function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) return null;
  if (!isBinary) return value;
  if (value === "on") return "low";
  return value;
}
