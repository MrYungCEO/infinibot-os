export type ToolProfileId = "minimal" | "coding" | "messaging" | "full" | "doc-agent";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

// Keyless web access: search, page read, images, transcripts, GitHub, feeds.
const WEB_TOOLS = [
  "web_search",
  "web_fetch",
  "web_read",
  "web_image_search",
  "youtube_transcript",
  "github_read",
  "rss_read",
];

export const TOOL_GROUPS: Record<string, string[]> = {
  // NOTE: Keep canonical (lowercase) tool names here.
  "group:memory": ["memory_search", "memory_get"],
  "group:web": WEB_TOOLS,
  // Roster agents (main, archivist, content/business/infinitrade plugin agents)
  // list a bare "web"; no tool has that name, so treat it as the web group.
  web: WEB_TOOLS,
  // Same for a bare "memory" (main, ops, finance, ...): the memory tools are
  // memory_search/memory_get, and the plugin ids are memory-core/memory-lancedb.
  memory: ["memory_search", "memory_get"],
  // Basic workspace/file tools
  "group:fs": ["read", "write", "edit", "apply_patch"],
  // Host/runtime execution tools
  "group:runtime": ["exec", "process"],
  // Session management tools
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "claude_coder",
    "opencode_coder",
    "codex_coder",
    "grok_coder",
    "subagent_message",
    "subagent_inbox",
  ],
  // UI helpers (browser, agent-driven UI control plane). Canvas is now
  // exclusively the MCP excalidraw surface (extensions/mcp-excalidraw),
  // so it is no longer in the native tool group.
  "group:ui": ["browser", "ui_control", "show_panel", "infinibot_help", "infinibot_state"],
  // Automation + infra
  "group:automation": ["cron", "gateway"],
  // Messaging surface
  "group:messaging": ["message"],
  // Nodes + device tools
  "group:nodes": ["nodes"],
  // Hyprland / Linux desktop control. Linux/Hyprland sessions only — tools
  // self-detect platform and return structured errors elsewhere.
  "group:hyprland": [
    "hyprland_window",
    "hyprland_workspace",
    "hyprland_launch",
    "hyprland_capture",
    "hyprland_input",
    "hyprland_pick",
    "hyprland_highlight",
    "overlay_notify",
    "infinibot_terminal",
  ],
  // OS-level desktop control (Windows + Hyprland).
  "group:desktop": [
    "desktop_app",
    "desktop_ui",
    "screen_analyze",
    "hyprland_window",
    "hyprland_workspace",
    "hyprland_launch",
    "hyprland_capture",
    "hyprland_input",
    "hyprland_pick",
    "hyprland_highlight",
    "overlay_notify",
    "infinibot_terminal",
  ],
  // All InfiniBot native tools (excludes provider plugins).
  "group:infinibot": [
    "file_context",
    "video_analysis",
    "browser",
    "discipline",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "claude_coder",
    "opencode_coder",
    "codex_coder",
    "grok_coder",
    "subagent_message",
    "subagent_inbox",
    "memory_search",
    "memory_get",
    "file_context",
    "video_analysis",
    ...WEB_TOOLS,
    "image",
    "ui_control",
    "show_panel",
    "infinibot_help",
    "infinibot_state",
    "desktop_app",
    "desktop_ui",
    "screen_analyze",
    "hyprland_window",
    "hyprland_workspace",
    "hyprland_launch",
    "hyprland_capture",
    "hyprland_input",
    "hyprland_pick",
    "hyprland_highlight",
    "overlay_notify",
    "infinibot_terminal",
  ],
};

const TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: ["session_status"],
  },
  coding: {
    allow: ["group:fs", "group:runtime", "group:sessions", "group:memory", "image"],
  },
  messaging: {
    allow: [
      "group:messaging",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
    ],
  },
  full: {},
  // doc-agent: scoped profile for the in-page document agent panel.
  // The session is bound to a specific document (note row, db row,
  // workflow, project page, content page, storyboard, whiteboard, video
  // composition, brand doc, funnel page, inbox thread), so we want the
  // agent to be able to read and edit that document, search related
  // context, and propose plans — but NOT to spawn long-running
  // processes or write outside the doc.
  //
  // Universal doc-agent expansion (see docs/doc-agent-universal-plan.md):
  // additions are PURELY ADDITIVE — the deny list does not loosen,
  // because exec/process/browser/cron stay denied for ALL doc-agent
  // sessions regardless of docType. The runtime narrows this further
  // via per-docType hints in the system prompt (e.g. brand_doc tells the
  // model to prefer branding tools), but the policy itself stays one
  // profile.
  "doc-agent": {
    allow: [
      "group:memory",
      "group:web",
      "group:sessions",
      "message",
      "image",
      // Existing document content APIs.
      "notes_tool",
      "databases_tool",
      "kanban_tool",
      "workflows_tool",
      // New tool surfaces wired up by the universal doc-agent rollout.
      // Each maps to one or more new docTypes — see
      // docs/doc-agent-universal-plan.md §2.
      "content_pages_tool", // content_page
      "storyboard_tool", // storyboard
      "compositions_tool", // video_composition
      "branding_tool", // brand_doc
      "funnels_tool", // funnel_page
      "gmail_tool", // inbox_thread (read)
      "reply_dispatch", // inbox_thread (send drafts)
      // Excalidraw MCP surface — whiteboard_doc edits the active scene.
      // These tools live on the mcp-excalidraw plugin; using
      // `group:plugins` would be too broad, so we name the prefix.
      "excalidraw_create_element",
      "excalidraw_create_batch",
      "excalidraw_update_element",
      "excalidraw_update_batch",
      "excalidraw_delete_elements",
      "excalidraw_query_elements",
      "excalidraw_get_scene",
      "excalidraw_get_element",
      "excalidraw_scroll_to",
      "excalidraw_set_zoom",
      "excalidraw_group_elements",
      "excalidraw_ungroup_elements",
      "excalidraw_bring_forward",
      "excalidraw_send_backward",
      "excalidraw_bring_to_front",
      "excalidraw_send_to_back",
      "excalidraw_fit_to_content",
      "excalidraw_export_scene",
      "excalidraw_import_scene",
      // ui_control is allowed so the doc-agent can dispatch view-scoped
      // ops (e.g. refresh the panel after a write). The doc-scoped
      // live-action preamble tells the model to ONLY dispatch into the
      // panel that owns the open document.
      "ui_control",
      // For reasoning/research adjacent to the doc.
      "vision",
    ],
    // Deny list is the same set as before — these stay denied for ALL
    // doc-agent sessions regardless of docType. Do not loosen.
    deny: ["exec", "process", "browser", "cron"],
  },
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) return [];
  return list.map(normalizeToolName).filter(Boolean);
}

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  strippedAllowlist: boolean;
};

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) continue;
    for (const value of policy.allow) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) entries.push(trimmed);
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) continue;
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = meta.pluginId.toLowerCase();
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) return list;
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) return undefined;
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasCoreEntry = false;
  for (const entry of normalized) {
    const expanded = expandToolGroups([entry]);
    // Aliases count too: a bare "memory" expands to memory_search/memory_get,
    // which come from the memory-core plugin, not core.
    const isPluginEntry =
      entry === "group:plugins" ||
      pluginIds.has(entry) ||
      pluginTools.has(entry) ||
      expanded.some((tool) => pluginTools.has(tool));
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) hasCoreEntry = true;
    if (!isCoreEntry && !isPluginEntry) unknownAllowlist.push(entry);
  }
  const strippedAllowlist = !hasCoreEntry;
  // When an allowlist contains only plugin tools, we strip it to avoid accidentally
  // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
  if (strippedAllowlist) {
    // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
    // We keep this note here for future maintainers.
  }
  return {
    policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
    unknownAllowlist: Array.from(new Set(unknownAllowlist)),
    strippedAllowlist,
  };
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) return undefined;
  const resolved = TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) return undefined;
  if (!resolved.allow && !resolved.deny) return undefined;
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}
