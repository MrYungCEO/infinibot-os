/**
 * Scoring utilities — preserved from the original scoring-service.ts.
 *
 * These are PURE functions (no API calls, no store access) used by
 * consumers that import from the scoring-service barrel.
 * The actual API-calling logic now lives in pipeline-wrapper.ts.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("content-intel-scoring-utils");

/** Primary free model (per project brief). */
export const PRIMARY_MODEL = "deepseek/deepseek-chat-v3-0324:free";
/** Fallback model (per project brief). */
export const FALLBACK_MODEL = "deepseek/deepseek-v4-flash";

/** Map a numeric overall score to a letter tier. S=9+, A=7-8.9, B=5-6.9, C<5. */
export function tierFromScore(score: number): string {
  if (score >= 9.0) return "S";
  if (score >= 7.0) return "A";
  if (score >= 5.0) return "B";
  return "C";
}

/**
 * Robustly extract a JSON object from model output.
 * Handles code fences, leading/trailing prose, partial markdown.
 * Returns `null` when no valid JSON object is found.
 */
export function extractScoreJson(text: string): Record<string, unknown> | null {
  // Strip markdown code fences
  let cleaned = text
    .replace(/```(?:json)?/g, "")
    .trim()
    .replace(/`+$/g, "")
    .trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // continue
  }

  // Try to find the first {...} block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Validate and normalise a parsed score dict.
 * Returns `null` if the dict is missing required keys or has non-numeric values.
 * Always recomputes the tier from `overall` (don't trust the model's tier).
 */
export function validateScore(
  data: Record<string, unknown>,
  shortcode: string,
): {
  shortcode: string;
  hook: number;
  value: number;
  viral: number;
  overall: number;
  tier: string;
  reason: string;
  idea_vs_execution: string;
} | null {
  const required = ["hook", "value", "viral", "overall", "tier", "reason", "idea_vs_execution"];
  for (const key of required) {
    if (!(key in data)) {
      log.warn("score response missing key", { key, shortcode });
      return null;
    }
  }

  const clamp = (v: unknown): number | null => {
    const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
    if (isNaN(n)) return null;
    return Math.max(1.0, Math.min(10.0, n));
  };

  const hook = clamp(data["hook"]);
  const value = clamp(data["value"]);
  const viral = clamp(data["viral"]);
  const overall = clamp(data["overall"]);

  if (hook === null || value === null || viral === null || overall === null) {
    log.warn("non-numeric score fields", { shortcode });
    return null;
  }

  const tier = tierFromScore(overall); // always recompute
  const reason = String(data["reason"] ?? "")
    .trim()
    .slice(0, 400);
  const ideaVsExecution = String(data["idea_vs_execution"] ?? "")
    .trim()
    .slice(0, 400);

  return {
    shortcode,
    hook: Math.round(hook * 10) / 10,
    value: Math.round(value * 10) / 10,
    viral: Math.round(viral * 10) / 10,
    overall: Math.round(overall * 10) / 10,
    tier,
    reason,
    idea_vs_execution: ideaVsExecution,
  };
}
