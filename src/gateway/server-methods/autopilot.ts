/**
 * Gateway handlers for the page-by-page autopilot planner + the internal
 * MCP server registry. Both are config-driven, no DB.
 *
 * - agent.autopilot.plan — translate a free-form prompt + page tab into an
 *   ordered list of `AutonomyCommand`s the UI sidebar then dispatches.
 * - mcp.internal.list / .upsert / .remove / .sync — manage the
 *   `mcpServers` block in the InfiniBot config + mirror to Claude Code.
 */

import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";
import {
  listInternalMcpServers,
  syncInternalMcpToClaudeCode,
  upsertInternalMcpServer,
  removeInternalMcpServer,
} from "../../mcp/internal-servers.js";
import type { McpServerEntry } from "../../config/types.infinibot.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Autopilot planner ────────────────────────────────────────────

type PlannerCommand = { kind: string; [k: string]: unknown };
interface PlannerPlan {
  narration?: string;
  commands: PlannerCommand[];
}

/**
 * Tiny rule-based planner that mirrors the UI's local fallback so headless
 * callers (CLI, MCP) get the same behaviour.
 *
 * Future: hand off to an LLM session via `chat.send` with a structured
 * prompt that requests JSON. For now we keep it deterministic so it works
 * offline.
 */
function plan(prompt: string, tab: string): PlannerPlan {
  const p = prompt.toLowerCase();

  const navTargets: Array<{ keywords: string[]; tab: string }> = [
    { keywords: ["business", "biz", "company"], tab: "business" },
    { keywords: ["agent"], tab: "agents" },
    { keywords: ["discipline", "schedule", "block"], tab: "discipline" },
    { keywords: ["grid", "multi-chat", "panels"], tab: "grid" },
    { keywords: ["chat"], tab: "chat" },
    { keywords: ["mcp"], tab: "mcp" },
  ];
  for (const { keywords, tab: t } of navTargets) {
    if (keywords.some((k) => p.includes(k)) && t !== tab) {
      return {
        narration: `Heading to ${t}.`,
        commands: [{ kind: "navigate", tab: t }],
      };
    }
  }

  if (tab === "discipline") {
    if (p.includes("timeline")) {
      return {
        narration: "Switching discipline to the timeline view.",
        commands: [{ kind: "discipline.subView", subView: "timeline" }],
      };
    }
    if (p.includes("score") || p.includes("compliance")) {
      return {
        narration: "Showing your score.",
        commands: [{ kind: "discipline.subView", subView: "score" }],
      };
    }
    if (p.includes("deep focus")) {
      return {
        narration: "Applying the Deep Focus preset.",
        commands: [{ kind: "discipline.applyPreset", presetId: "deep-focus" }],
      };
    }
  }

  if (tab === "business") {
    if (p.includes("notion")) {
      return {
        narration: "Opening Notion settings.",
        commands: [{ kind: "business.section", section: "notion" }],
      };
    }
    if (p.includes("brand")) {
      return {
        narration: "Opening Brand controls.",
        commands: [{ kind: "business.section", section: "brand" }],
      };
    }
    if (p.includes("client")) {
      return {
        narration: "Opening Clients.",
        commands: [{ kind: "business.section", section: "clients" }],
      };
    }
  }

  if (tab === "grid") {
    if (p.includes("add") || p.includes("new")) {
      return {
        narration: "Adding a new chat panel.",
        commands: [{ kind: "grid.addPanel" }],
      };
    }
  }

  return {
    narration: "I'll need a more specific instruction.",
    commands: [],
  };
}

// ── Internal MCP servers ─────────────────────────────────────────

async function readMutableConfig(): Promise<{ config: InfinibotConfig; raw: string }> {
  const snapshot = await readConfigFileSnapshot();
  const raw = snapshot.raw ?? "{}";
  const parsed = parseConfigJson5(raw);
  const obj = parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
    ? (parsed.parsed as InfinibotConfig)
    : ({} as InfinibotConfig);
  return { config: obj, raw };
}

async function writeMutableConfig(next: InfinibotConfig): Promise<void> {
  const validation = validateConfigObjectWithPlugins(next);
  if (!validation.ok) {
    throw new Error(
      `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }
  await writeConfigFile(next);
}

// ── Handlers ──────────────────────────────────────────────────────

export const autopilotHandlers: GatewayRequestHandlers = {
  "agent.autopilot.plan": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { prompt?: unknown; tab?: unknown };
      const prompt = typeof p.prompt === "string" ? p.prompt : "";
      const tab = typeof p.tab === "string" ? p.tab : "chat";
      if (!prompt.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "prompt required" });
        return;
      }
      respond(true, plan(prompt, tab));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.internal.list": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      respond(true, { servers: listInternalMcpServers(cfg) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.internal.upsert": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { name?: unknown; entry?: unknown };
      if (typeof p.name !== "string" || !p.name.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name required" });
        return;
      }
      if (!p.entry || typeof p.entry !== "object") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "entry required" });
        return;
      }
      const { config } = await readMutableConfig();
      upsertInternalMcpServer(config, p.name, p.entry as McpServerEntry);
      await writeMutableConfig(config);
      respond(true, { name: p.name, ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.internal.remove": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { name?: unknown };
      if (typeof p.name !== "string") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name required" });
        return;
      }
      const { config } = await readMutableConfig();
      const existed = removeInternalMcpServer(config, p.name);
      await writeMutableConfig(config);
      respond(true, { name: p.name, removed: existed });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "mcp.internal.sync": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { configPath?: unknown };
      const configPath =
        typeof p.configPath === "string" && p.configPath ? p.configPath : undefined;
      const cfg = loadConfig();
      const result = syncInternalMcpToClaudeCode(cfg, { configPath });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
