/**
 * Group chat run settings — the same per-chat options the 1:1 composer has
 * (model picker + thinking level), set once on the group and fanned out to
 * every member's run, with an optional per-member override.
 *
 * Resolution per member, field by field:
 *   member override  >  group setting  >  the agent's own default
 * A field that is absent inherits; the gateway applies the effective values to
 * the member's own session (sessions.patch semantics) before each turn.
 */
import type { GroupChatMeta } from "./types.js";

export type GroupRunSettings = {
  /** "provider/model"; absent = the agent's default model. */
  model?: string;
  /** Thinking / effort level (off | minimal | low | medium | high | xhigh); absent = inherit. */
  thinkingLevel?: string;
};

/** A patch: a string sets the field, `null` clears it (back to inherit). */
export type GroupRunSettingsPatch = {
  model?: string | null;
  thinkingLevel?: string | null;
};

export type SettingSource = "member" | "group" | "agent";

export type EffectiveRunSettings = GroupRunSettings & {
  source: { model: SettingSource; thinkingLevel: SettingSource };
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const MODEL_REF_RE = /^[A-Za-z0-9][\w.:@+-]*\/\S+$|^[A-Za-z0-9][\w.:@+-]*$/;

function cleanModel(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new Error("model must be a string or null");
  const s = v.trim();
  if (!s || s === "default" || s === "inherit") return null;
  if (s.length > 200 || !MODEL_REF_RE.test(s)) throw new Error(`invalid model: ${s}`);
  return s;
}

function cleanThinking(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new Error("thinkingLevel must be a string or null");
  const s = v.trim().toLowerCase();
  if (!s || s === "default" || s === "inherit") return null;
  const alias: Record<string, string> = {
    on: "low",
    min: "minimal",
    med: "medium",
    max: "high",
    "x-high": "xhigh",
  };
  const level = alias[s] ?? s;
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`invalid thinkingLevel (use ${THINKING_LEVELS.join("|")})`);
  }
  return level;
}

/** Validate a raw patch (shape + syntax only; the gateway checks the model allowlist). */
export function normalizeSettingsPatch(raw: unknown): GroupRunSettingsPatch {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings must be an object");
  const r = raw as Record<string, unknown>;
  const out: GroupRunSettingsPatch = {};
  const model = cleanModel(r.model);
  if (model !== undefined) out.model = model;
  const thinking = cleanThinking("thinkingLevel" in r ? r.thinkingLevel : r.thinking);
  if (thinking !== undefined) out.thinkingLevel = thinking;
  return out;
}

/** Apply a patch to stored settings; returns undefined when nothing is left. */
export function applySettingsPatch(
  base: GroupRunSettings | undefined,
  patch: GroupRunSettingsPatch,
): GroupRunSettings | undefined {
  const next: GroupRunSettings = { ...base };
  for (const k of ["model", "thinkingLevel"] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next.model || next.thinkingLevel ? next : undefined;
}

/** Effective settings a member runs with (member override > group > agent default). */
export function effectiveSettings(
  meta: Pick<GroupChatMeta, "settings" | "memberSettings">,
  agentId: string,
): EffectiveRunSettings {
  const group = meta.settings ?? {};
  const mine = meta.memberSettings?.[agentId] ?? {};
  const pick = (k: keyof GroupRunSettings): [string | undefined, SettingSource] =>
    mine[k] ? [mine[k], "member"] : group[k] ? [group[k], "group"] : [undefined, "agent"];
  const [model, ms] = pick("model");
  const [thinkingLevel, ts] = pick("thinkingLevel");
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    source: { model: ms, thinkingLevel: ts },
  };
}

/** Drop overrides for agents that left the group. */
export function pruneMemberSettings(
  memberSettings: Record<string, GroupRunSettings> | undefined,
  members: string[],
): Record<string, GroupRunSettings> | undefined {
  if (!memberSettings) return undefined;
  const out: Record<string, GroupRunSettings> = {};
  for (const [id, s] of Object.entries(memberSettings)) {
    if (members.includes(id) && (s.model || s.thinkingLevel)) out[id] = s;
  }
  return Object.keys(out).length ? out : undefined;
}
