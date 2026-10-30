/**
 * Optimal default MCP/tool sets per agent role.
 * Applied when an agent config doesn't specify its own enabledMCPs.
 */

const MCP_DEFAULTS: Record<string, string[]> = {
  main: ["infinibot", "browser", "research", "notes", "kanban"],
  cmo: ["infinibot", "canva", "research", "browser", "notes"],
  "brand-designer": ["infinibot", "canva", "browser"],
  "content-director": ["infinibot", "canva", "research", "notes", "browser"],
  scriptwriter: ["infinibot", "notes", "research", "browser"],
  coder: ["infinibot", "browser"],
  "coder-claude": ["infinibot", "browser"],
  "coder-codex": ["infinibot", "browser"],
  "coder-opencode": ["infinibot", "browser"],
  "head-of-dev": ["infinibot", "browser", "kanban"],
  webdev: ["infinibot", "browser", "kanban"],
  "client-director": ["infinibot", "notes", "kanban", "browser"],
  outreach: ["infinibot", "browser", "research", "notes"],
  ledger: ["infinibot", "notes", "browser"],
  scout: ["infinibot", "research", "browser", "notes"],
  monitor: ["infinibot", "browser", "kanban"],
  overseer: ["infinibot", "browser", "kanban"],
  archivist: ["infinibot", "notes", "browser", "research"],
  "inbox-handler": ["infinibot", "browser", "notes"],
  designer: ["infinibot", "canva", "browser"],
  "graphic-designer": ["infinibot", "canva", "browser"],
  "video-editor-agent": ["infinibot", "browser", "notes"],
  opus: ["infinibot", "research", "browser", "notes"],
  qa: ["infinibot", "browser", "kanban"],
};

/** Returns the optimal default MCP list for a given agent id.
 *  Falls back to a minimal baseline for unknown agents. */
export function getMcpDefaultsForAgent(agentId: string): string[] {
  return MCP_DEFAULTS[agentId] ?? ["infinibot", "browser"];
}

/** Returns the full defaults map (for listing endpoints). */
export function getAllMcpDefaults(): Record<string, string[]> {
  return { ...MCP_DEFAULTS };
}
