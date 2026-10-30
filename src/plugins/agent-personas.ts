/**
 * Agent personas for plugins: who each configured InfiniBot agent is (id,
 * display name, one-line role, emoji), without the full text-chat system
 * prompt. Used by voice plugins to build a voice persona per agent.
 *
 * Source order: `agents.list[]` entries (name / identity) over the standard
 * roster's name + description, so a renamed agent keeps its roster role line.
 */

import type { InfinibotConfig } from "../config/config.js";
import { STANDARD_AGENT_ROSTER } from "../agents/standard-roster.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";

export type AgentPersona = {
  id: string;
  name: string;
  description?: string;
  emoji?: string;
  department?: string;
  /** True when the agent is defined in config (not only the standard roster). */
  configured: boolean;
};

export function listAgentPersonas(cfg: InfinibotConfig): AgentPersona[] {
  const roster = new Map(STANDARD_AGENT_ROSTER.map((a) => [a.id, a]));
  let rows: Array<{ id: string; name?: string; identity?: { name?: string; emoji?: string } }> = [];
  try {
    rows = listAgentsForGateway(cfg).agents;
  } catch {
    rows = (cfg.agents?.list ?? []).filter((a) => a?.id).map((a) => ({ id: a.id, name: a.name }));
  }
  const configured = new Set((cfg.agents?.list ?? []).map((a) => a?.id).filter(Boolean));
  const out: AgentPersona[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const std = roster.get(r.id);
    out.push({
      id: r.id,
      name: r.identity?.name || r.name || std?.name || r.id,
      description: std?.description,
      emoji: r.identity?.emoji || undefined,
      department: std?.department,
      configured: configured.has(r.id),
    });
  }
  return out;
}
