export interface MonsoonStudioConfig {
  studioUrl: string;
  timeoutMs: number;
}

export const DEFAULT_STUDIO_URL = "http://127.0.0.1:4311";

/** Typed reader for `plugins.entries["monsoon-studio"].config`; bad values fall back to defaults. */
export function readStudioConfig(raw: unknown): MonsoonStudioConfig {
  const cfg = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = typeof cfg.studioUrl === "string" && /^https?:\/\//i.test(cfg.studioUrl.trim()) ? cfg.studioUrl.trim() : DEFAULT_STUDIO_URL;
  const timeout = typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs >= 1000 ? cfg.timeoutMs : 180_000;
  return { studioUrl: url.replace(/\/+$/, ""), timeoutMs: timeout };
}
