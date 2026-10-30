/**
 * Boot migration: rewrite model refs that are known-retired upstream
 * (RETIRED_MODEL_REPLACEMENTS, e.g. ollama-cloud/kimi-k2.5 → gpt-oss:120b) in
 * agents.defaults.model / agents.defaults.models / agents.list[].model.
 *
 * Only the explicit retired table is persisted. Models that are merely missing
 * from the live catalog are healed per turn (agents/model-heal.ts) but never
 * written back — a transient discovery failure must not rewrite a config.
 *
 * Pure: returns a new config + human-readable change list. The caller persists
 * via writeConfigFile, which validates, rotates *.bak backups and writes as the
 * gateway's own user with 0600.
 */

import { RETIRED_MODEL_REPLACEMENTS } from "../agents/provider-model-defaults.js";
import type { InfinibotConfig } from "./config.js";
import { readConfigFileSnapshot, writeConfigFile } from "./io.js";

function replacementFor(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  const trimmed = ref.trim();
  const direct = RETIRED_MODEL_REPLACEMENTS[trimmed];
  if (direct) return direct;
  const lower = trimmed.toLowerCase();
  for (const [retired, next] of Object.entries(RETIRED_MODEL_REPLACEMENTS)) {
    if (retired.toLowerCase() === lower) return next;
  }
  return undefined;
}

type ModelField = string | { primary?: string; fallbacks?: string[]; [k: string]: unknown };

function migrateModelField(
  value: ModelField | undefined,
  label: string,
  changes: string[],
): ModelField | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") {
    const next = replacementFor(value);
    if (!next) return value;
    changes.push(`${label}: ${value} → ${next} (retired upstream)`);
    return next;
  }
  if (typeof value !== "object") return value;
  let out = value;
  const primaryNext = replacementFor(value.primary);
  if (primaryNext) {
    changes.push(`${label}.primary: ${value.primary} → ${primaryNext} (retired upstream)`);
    out = { ...out, primary: primaryNext };
  }
  if (Array.isArray(value.fallbacks)) {
    const seen = new Set<string>();
    let touched = false;
    const fallbacks: string[] = [];
    for (const ref of value.fallbacks) {
      const next = replacementFor(ref);
      if (next) touched = true;
      const resolved = next ?? ref;
      // Drop a fallback that now duplicates the primary or an earlier entry.
      if (resolved === (out.primary ?? value.primary) || seen.has(resolved)) {
        touched = true;
        continue;
      }
      seen.add(resolved);
      fallbacks.push(resolved);
    }
    if (touched) {
      changes.push(`${label}.fallbacks: retired refs replaced`);
      out = { ...out, fallbacks };
    }
  }
  return out;
}

export function migrateRetiredModelRefs(cfg: InfinibotConfig): {
  config: InfinibotConfig;
  changes: string[];
} {
  const changes: string[] = [];
  const agents = cfg.agents;
  if (!agents) return { config: cfg, changes };

  let nextAgents = agents;
  const defaults = agents.defaults;
  if (defaults) {
    let nextDefaults = defaults;
    const model = migrateModelField(
      defaults.model as ModelField | undefined,
      "agents.defaults.model",
      changes,
    );
    if (model !== defaults.model) {
      nextDefaults = { ...nextDefaults, model: model as typeof defaults.model };
    }
    // Allowlist / alias map keyed by "provider/model": move the entry, keep its alias.
    const models = defaults.models;
    if (models && typeof models === "object") {
      let movedAny = false;
      const nextModels: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(models)) {
        const next = replacementFor(key);
        if (next) {
          movedAny = true;
          changes.push(`agents.defaults.models: ${key} → ${next} (retired upstream)`);
          if (!(next in models)) nextModels[next] = entry;
          continue;
        }
        nextModels[key] = entry;
      }
      if (movedAny) {
        nextDefaults = { ...nextDefaults, models: nextModels as typeof defaults.models };
      }
    }
    if (nextDefaults !== defaults) nextAgents = { ...nextAgents, defaults: nextDefaults };
  }

  if (Array.isArray(agents.list)) {
    let listChanged = false;
    const list = agents.list.map((agent, idx) => {
      if (!agent || typeof agent !== "object" || !("model" in agent)) return agent;
      const label = `agents.list[${(agent as { id?: string }).id ?? idx}].model`;
      const model = migrateModelField(agent.model as ModelField | undefined, label, changes);
      if (model === agent.model) return agent;
      listChanged = true;
      return { ...agent, model: model as typeof agent.model };
    });
    if (listChanged) nextAgents = { ...nextAgents, list };
  }

  if (nextAgents === agents) return { config: cfg, changes };
  return { config: { ...cfg, agents: nextAgents }, changes };
}

/**
 * Gateway boot step: migrate the config file *as written* (pre-$include /
 * ${ENV} resolution, so secrets and included files are never inlined) and
 * persist via writeConfigFile (validation, *.bak rotation, 0600, own user).
 * Returns the applied changes; [] when nothing to do or the raw shape doesn't
 * validate on its own (per-turn self-healing still covers that tenant).
 */
export async function persistRetiredModelMigration(): Promise<string[]> {
  const snap = await readConfigFileSnapshot();
  if (!snap.exists || !snap.valid) return [];
  const raw = snap.parsed;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const migrated = migrateRetiredModelRefs(raw as InfinibotConfig);
  if (migrated.changes.length === 0) return [];
  await writeConfigFile(migrated.config);
  return migrated.changes;
}
