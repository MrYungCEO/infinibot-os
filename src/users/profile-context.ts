/**
 * Profile context block — Layer 1 (operator notes) → AI-surface injection.
 *
 * `buildProfileContextBlock` turns a profile's operator-authored fields
 * (role, goals, languages, skill level, project focus, communication style,
 * freeform notes) into a tight, clearly-labelled text block that gets
 * PREPENDED to every AI system prompt: the voice orchestrator (web + mobile),
 * spawned coder sub-agents, and the chat agent.
 *
 * Design rules:
 *   • Pure function. No fs, no Date, no globals → trivially unit-testable.
 *   • Skip any empty section. If NO operator-context field is set, return ""
 *     (the empty string) so nothing is injected — a fresh single-profile
 *     install with no notes sees zero change.
 *   • Keep it tight: this rides on every AI turn, so no filler.
 *
 * This is DISTINCT from the auto-memory system (Layer 2), which evolves on
 * its own per-user dir. The two are parallel and never coupled here.
 */

import type { Profile } from "./profiles.js";
import { getProfile } from "./profiles.js";
import { getCurrentUserId } from "../config/paths.js";

/** Indent every line of a (possibly multi-line) value by two spaces. */
function indentBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line.trimEnd()}`)
    .join("\n");
}

/**
 * Render the operator-context block for a profile. Returns "" when the profile
 * is null/undefined or carries no operator-context fields (name/avatar/theme
 * alone never trigger injection).
 */
export function buildProfileContextBlock(profile: Profile | null | undefined): string {
  if (!profile) return "";

  const role = profile.role?.trim();
  const goals = profile.goals?.trim();
  const notes = profile.notes?.trim();
  const primary = profile.preferredLanguage?.trim();
  const secondary = profile.secondaryLanguage?.trim();
  const skillLevel = profile.skillLevel;
  const projectContext = profile.projectContext?.trim();
  const communicationStyle = profile.communicationStyle?.trim();

  // No operator context at all → no injection (name alone doesn't count).
  const hasAny =
    role ||
    goals ||
    notes ||
    primary ||
    secondary ||
    skillLevel ||
    projectContext ||
    communicationStyle;
  if (!hasAny) return "";

  const lines: string[] = ["USER CONTEXT"];

  const name = profile.name?.trim();
  if (name) lines.push(`Name: ${name}`);
  if (role) lines.push(`Role: ${role}`);

  if (primary || secondary) {
    let langs = "";
    if (primary && secondary) {
      langs = `${primary} (primary) + ${secondary} (secondary)`;
    } else if (primary) {
      langs = `${primary} (primary)`;
    } else {
      langs = `${secondary} (secondary)`;
    }
    lines.push(`Languages: ${langs}`);
  }

  if (skillLevel) lines.push(`Skill level: ${skillLevel}`);

  if (goals) {
    lines.push("Goals:");
    lines.push(indentBlock(goals));
  }

  if (projectContext) {
    lines.push("Current focus:");
    lines.push(indentBlock(projectContext));
  }

  if (communicationStyle) lines.push(`Communication style: ${communicationStyle}`);

  if (notes) {
    lines.push("Operator notes:");
    lines.push(indentBlock(notes));
  }

  return lines.join("\n");
}

/**
 * Resolve the ACTIVE profile's context block, server-side. Best-effort: any
 * failure (registry not readable yet, profile not loaded) returns "" so it
 * never blocks agent/voice startup. Used at the AI-surface injection points.
 */
export function buildActiveProfileContextBlock(): string {
  try {
    const profile = getProfile(getCurrentUserId());
    return buildProfileContextBlock(profile);
  } catch {
    return "";
  }
}
