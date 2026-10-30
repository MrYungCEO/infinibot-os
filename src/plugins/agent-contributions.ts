/**
 * Plugin-contributed roster agents (manifest v2 `contributes.agents`).
 *
 * A v2 plugin lists JSON files of agent definitions. While the plugin is
 * enabled, its agents are seeded into `agents.list` exactly like the standard
 * roster (standard-roster.ts): inserted when missing, refreshed when the
 * file's `version` changes, and tagged `_plugin: <id>` so the host knows who
 * owns them. When the plugin is disabled, its still-managed entries (those
 * carrying `_seedVersion`) are removed again; entries the operator customised
 * (they deleted `_seedVersion`) are left alone.
 *
 * Runs at gateway boot next to `seedStandardAgents`, from manifests only —
 * before any plugin code loads — the same way plugin skills are resolved.
 */

import fs from "node:fs";
import path from "node:path";

import type { InfinibotConfig } from "../config/config.js";
import {
  APPROVAL_TOOLS,
  INFLIGHT_MESSAGING_TOOLS,
  FILE_CONTEXT_TOOLS,
  VERIFIED_COMPLETION_TOOLS,
} from "../verification/tool-names.js";
import { normalizePluginsConfig, resolveEnableState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

export type PluginAgentDef = {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  toolsAllow?: string[];
  skillsAllow?: string[];
  delegatesTo?: string[];
};

export type PluginAgentContribution = {
  pluginId: string;
  /** Seed tag written to `_seedVersion`, e.g. "omniclinic:omniclinic-roster-1". */
  seedVersion: string;
  agents: PluginAgentDef[];
};

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function parseAgentFile(raw: unknown): { version: string; agents: PluginAgentDef[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { version?: unknown; agents?: unknown };
  if (!Array.isArray(obj.agents)) return null;
  const version = typeof obj.version === "string" && obj.version.trim() ? obj.version.trim() : "1";
  const agents: PluginAgentDef[] = [];
  for (const a of obj.agents as Record<string, unknown>[]) {
    const id = typeof a?.id === "string" ? a.id.trim() : "";
    const prompt = typeof a?.systemPrompt === "string" ? a.systemPrompt : "";
    if (!AGENT_ID_RE.test(id) || !prompt.trim()) continue;
    const list = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
        : [];
    agents.push({
      id,
      name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : id,
      description: typeof a.description === "string" ? a.description : undefined,
      systemPrompt: prompt,
      model: typeof a.model === "string" ? a.model : undefined,
      toolsAllow: list(a.toolsAllow),
      skillsAllow: list(a.skillsAllow),
      delegatesTo: list(a.delegatesTo),
    });
  }
  return { version, agents };
}

const rosterIdCache = new Map<string, { mtimeMs: number; ids: string[] }>();

/**
 * Roster agent ids a plugin's `contributes.agents` files declare, read from
 * disk (cached by mtime). Used by plugins.list so the control UI can tell
 * which plugin an active roster agent belongs to (mesh-map plugin rooms).
 */
export function readPluginRosterAgentIds(rootDir: string, files: readonly string[]): string[] {
  const out: string[] = [];
  const root = path.resolve(rootDir);
  for (const rel of files) {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) continue;
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      const hit = rosterIdCache.get(file);
      if (hit && hit.mtimeMs === mtimeMs) {
        out.push(...hit.ids);
        continue;
      }
      const parsed = parseAgentFile(JSON.parse(fs.readFileSync(file, "utf8")));
      const ids = parsed ? parsed.agents.map((a) => a.id) : [];
      rosterIdCache.set(file, { mtimeMs, ids });
      out.push(...ids);
    } catch {
      /* unreadable roster file — the plugin loader reports it */
    }
  }
  return [...new Set(out)];
}

/** Agent contributions of every enabled manifest-v2 plugin. */
export function loadPluginAgentContributions(params: {
  config: InfinibotConfig;
  workspaceDir?: string;
}): PluginAgentContribution[] {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const normalized = normalizePluginsConfig(params.config.plugins);
  const out: PluginAgentContribution[] = [];
  for (const record of registry.plugins) {
    const files = record.v2?.contributes.agents ?? [];
    if (files.length === 0) continue;
    if (!resolveEnableState(record.id, record.origin, normalized).enabled) continue;
    for (const rel of files) {
      const file = path.resolve(record.rootDir, rel);
      if (!file.startsWith(path.resolve(record.rootDir) + path.sep)) continue;
      let parsed: ReturnType<typeof parseAgentFile> = null;
      try {
        parsed = parseAgentFile(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.agents.length === 0) continue;
      out.push({
        pluginId: record.id,
        seedVersion: `${record.id}:${parsed.version}`,
        agents: parsed.agents,
      });
    }
  }
  return out;
}

function buildEntry(
  pluginId: string,
  seedVersion: string,
  a: PluginAgentDef,
): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    systemPrompt: a.systemPrompt,
    ...(a.model ? { model: a.model } : {}),
    type: "native",
    ...(a.toolsAllow && a.toolsAllow.length > 0
      ? {
          tools: {
            allow: [
              ...new Set([
                ...a.toolsAllow,
                ...VERIFIED_COMPLETION_TOOLS,
                ...APPROVAL_TOOLS,
                ...INFLIGHT_MESSAGING_TOOLS,
                ...FILE_CONTEXT_TOOLS,
              ]),
            ],
          },
        }
      : {}),
    ...(a.skillsAllow && a.skillsAllow.length > 0 ? { skills: { allow: [...a.skillsAllow] } } : {}),
    ...(a.delegatesTo && a.delegatesTo.length > 0
      ? { subagents: { allowAgents: [...a.delegatesTo] } }
      : {}),
    _seedVersion: seedVersion,
    _plugin: pluginId,
  };
}

/**
 * Insert / refresh / remove plugin agents in `cfg.agents.list`. Pure apart
 * from mutating and returning `cfg` (same contract as seedStandardAgents).
 * An agent id already owned by core or another plugin is never overwritten.
 */
export function reconcilePluginAgents(
  cfg: InfinibotConfig,
  contributions: PluginAgentContribution[],
): InfinibotConfig {
  const agentsBlock = ((cfg as Record<string, unknown>).agents ?? {}) as {
    list?: Array<Record<string, unknown>>;
  };
  const existing = Array.isArray(agentsBlock.list) ? agentsBlock.list : [];
  const wanted = new Map<string, { pluginId: string; seedVersion: string; def: PluginAgentDef }>();
  for (const c of contributions) {
    for (const def of c.agents) {
      if (!wanted.has(def.id))
        wanted.set(def.id, { pluginId: c.pluginId, seedVersion: c.seedVersion, def });
    }
  }

  let mutated = false;
  const seen = new Set<string>();
  const next: Array<Record<string, unknown>> = [];
  for (const entry of existing) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const owner = typeof entry?._plugin === "string" ? entry._plugin : undefined;
    const managed = owner !== undefined && typeof entry._seedVersion === "string";
    if (id) seen.add(id);
    const want = wanted.get(id);
    if (owner && (!want || want.pluginId !== owner)) {
      // Plugin disabled/removed (or the agent left its roster).
      if (managed) {
        mutated = true;
        continue;
      }
      next.push(entry);
      continue;
    }
    if (want && owner === want.pluginId && managed && entry._seedVersion !== want.seedVersion) {
      const preserved: Record<string, unknown> = {};
      for (const key of ["identity", "references", "default", "disabled", "model"] as const) {
        if (entry[key] !== undefined) preserved[key] = entry[key];
      }
      next.push({ ...buildEntry(want.pluginId, want.seedVersion, want.def), ...preserved });
      mutated = true;
      continue;
    }
    next.push(entry);
  }
  for (const [id, want] of wanted) {
    if (seen.has(id)) continue;
    next.push(buildEntry(want.pluginId, want.seedVersion, want.def));
    mutated = true;
  }
  if (!mutated) return cfg;
  (cfg as Record<string, unknown>).agents = { ...agentsBlock, list: next };
  return cfg;
}

/** Boot hook: reconcile agents for the plugins enabled in `cfg`. */
export function applyPluginAgentContributions(
  cfg: InfinibotConfig,
  workspaceDir?: string,
): InfinibotConfig {
  return reconcilePluginAgents(cfg, loadPluginAgentContributions({ config: cfg, workspaceDir }));
}
