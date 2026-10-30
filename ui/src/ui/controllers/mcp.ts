/**
 * MCP Management Controller — state management for the MCP Server Management page.
 * Handles MCP server status, agent config loading, and server configuration.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { McpRegistryState } from "./mcp-registry";
import { createRegistryState } from "./mcp-registry";
import { gatewayOrigin } from "../gateway-endpoint";

// ── Types ────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerInfo {
  name: string;
  description?: string;
  enabled: boolean;
  running: boolean;
  custom?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  /** Rich tool info with descriptions */
  toolDetails?: McpToolInfo[];
  category?: string;
  /** Server URL / endpoint */
  url?: string;
  /** Documentation URL */
  docsUrl?: string;
  /** Transport type */
  transport?: string;
}

export interface McpAgentInfo {
  id: string;
  name: string;
  description?: string;
  model?: string;
  thinkingLevel?: string;
  isDefault?: boolean;
  workspace?: string;
  category?: string;
  tools?: {
    allow?: string[];
    deny?: string[];
    profile?: string;
  };
  subagents?: {
    allowAgents?: string[];
  };
  mcpServers?: string[];
  systemPromptPreview?: string;
}

export type CapabilitiesTab = "tools" | "skills" | "mcps";

// ── Quick Install ────────────────────────────────────────────

/** Connection scope — which network path an external client reaches us on. */
export type QuickScope = "local" | "lan" | "tailscale";

/** External agent / CLI the snippet is tailored for. */
export type QuickClient =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "windsurf"
  | "cline"
  | "continue"
  | "codex"
  | "grok"
  | "opencode"
  | "generic-json"
  | "generic-http";

/** OS we render config-file paths for. */
export type QuickOS = "macos" | "linux" | "windows";

export type QuickReach = "ok" | "warn" | "down";

/** Mirrors the `mcp.connectInfo` gateway response — the single info source. */
export interface QuickConnectInfo {
  gatewayPort: number;
  bind: string;
  httpBridgePort: number;
  stdio: {
    command: string;
    entry: string;
    urlEnv: string;
    tokenEnv: string;
    passwordEnv: string;
  };
  hosts: { local: string; lan: string | null; tailscale: string | null };
  tailscale: { cliPresent: boolean; hostname: string | null; ip: string | null };
  auth: { mode: "token" | "password" | "none"; required: boolean; hasSecret: boolean };
  reach: { local: QuickReach; lan: QuickReach; tailscale: QuickReach };
}

export interface QuickInstallState {
  /** Section expanded/collapsed. */
  expanded: boolean;
  scope: QuickScope;
  client: QuickClient;
  os: QuickOS;
  info: QuickConnectInfo | null;
  loading: boolean;
  error: string | null;
  /** Auth key reveal/rotate. */
  revealKey: boolean;
  /** Plaintext gateway secret once revealed (token or password). */
  keyValue: string | null;
  rotating: boolean;
  /** Which snippet id was last copied (for transient "Copied!" feedback). */
  copied: string | null;
  /** "Why these scopes?" help drawer. */
  showHelp: boolean;
}

export interface CanvaMcpState {
  showModal: boolean;
  tokenDraft: string;
  showToken: boolean;
  profileId: string | null;
  accountEmail: string | null;
  accountDisplayName: string | null;
  status: "disconnected" | "connected" | "expired" | "checking";
  testing: boolean;
  testResult: { valid: boolean; message: string; designCount?: number } | null;
  saving: boolean;
  disconnecting: boolean;
  oauthPending: boolean;
  error: string | null;
}

export interface SupabaseMcpState {
  showModal: boolean;
  patDraft: string;
  showPat: boolean;
  projectRefDraft: string;
  readOnly: boolean;
  profileId: string | null;
  maskedPat: string | null;
  projectRef: string | null;
  projectName: string | null;
  projectCount: number | null;
  status: "disconnected" | "connected" | "checking";
  testing: boolean;
  testResult: { valid: boolean; message: string; projectCount?: number; projectName?: string } | null;
  saving: boolean;
  disconnecting: boolean;
  error: string | null;
}

export interface McpManagementState {
  /** Current tab in capabilities view */
  currentTab: CapabilitiesTab;
  /** MCP server status */
  status: { running: boolean; port: number; uptime: number } | null;
  /** List of MCP servers */
  servers: McpServerInfo[];
  /** List of agents with their MCP config */
  agents: McpAgentInfo[];
  /** Skills status from skills.status endpoint */
  skillsReport: { skills: Array<{ name: string; description: string; eligible: boolean; disabled: boolean; source: string; skillKey: string; primaryEnv?: string; missing?: { bins: string[]; env: string[] }; install?: Array<{ id: string; label: string }> }> } | null;
  /** Skills filter */
  skillsFilter: string;
  /** Skills edits (API key drafts) */
  skillEdits: Record<string, string>;
  /** Skills busy key */
  skillsBusyKey: string | null;
  /** Skills messages */
  skillMessages: Record<string, { kind: "success" | "error"; message: string }>;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Which agents have their card expanded */
  expandedAgents: Set<string>;
  /** Which servers have their detail panel expanded */
  expandedServers: Set<string>;
  /** Which server categories are collapsed */
  collapsedCategories: Set<string>;
  /** Which agent categories are collapsed */
  collapsedAgentCategories: Set<string>;
  /** Show add server dialog */
  showAddDialog: boolean;
  /** New server form state */
  newServer: {
    name: string;
    description: string;
    command: string;
    args: string;
    env: string;
  };
  /** Busy flags for actions */
  actionBusy: string | null;
  /** Success message (auto-dismiss) */
  successMessage: string | null;
  /** Poll interval ID */
  pollIntervalId: number | null;
  /** Registry browser state */
  registry: McpRegistryState;
  /** Canva MCP credential / connection state */
  canva: CanvaMcpState;
  /** Supabase MCP credential / connection state */
  supabase: SupabaseMcpState;
  /** Inspector drawer — live tools for a connected server + "Try it" forms */
  inspector: InspectorState;
  /** Quick Install panel — connect external agents to this gateway */
  quickInstall: QuickInstallState;
}

export interface InspectorToolTry {
  /** JSON arguments draft */
  args: string;
  running: boolean;
  result: string | null;
  error: string | null;
  /** Whether the try-it form is expanded */
  open: boolean;
}

export interface InspectorState {
  /** Server whose drawer is open (null = closed) */
  serverName: string | null;
  loading: boolean;
  error: string | null;
  tools: McpToolInfo[];
  /** Per-tool try-it form state, keyed by tool name */
  tries: Record<string, InspectorToolTry>;
}

// ── State Factory ────────────────────────────────────────────

export function createInitialMcpState(): McpManagementState {
  return {
    currentTab: "tools",
    status: null,
    servers: [],
    agents: [],
    skillsReport: null,
    skillsFilter: "",
    skillEdits: {},
    skillsBusyKey: null,
    skillMessages: {},
    loading: false,
    error: null,
    expandedAgents: new Set(),
    expandedServers: new Set(),
    collapsedCategories: new Set(),
    collapsedAgentCategories: new Set(),
    showAddDialog: false,
    newServer: {
      name: "",
      description: "",
      command: "",
      args: "",
      env: "",
    },
    actionBusy: null,
    successMessage: null,
    pollIntervalId: null,
    registry: createRegistryState(),
    canva: {
      showModal: false,
      tokenDraft: "",
      showToken: false,
      profileId: null,
      accountEmail: null,
      accountDisplayName: null,
      status: "disconnected",
      testing: false,
      testResult: null,
      saving: false,
      disconnecting: false,
      oauthPending: false,
      error: null,
    },
    supabase: {
      showModal: false,
      patDraft: "",
      showPat: false,
      projectRefDraft: "",
      readOnly: false,
      profileId: null,
      maskedPat: null,
      projectRef: null,
      projectName: null,
      projectCount: null,
      status: "disconnected",
      testing: false,
      testResult: null,
      saving: false,
      disconnecting: false,
      error: null,
    },
    inspector: {
      serverName: null,
      loading: false,
      error: null,
      tools: [],
      tries: {},
    },
    quickInstall: {
      expanded: true,
      scope: "local",
      client: "claude-code",
      os: detectClientOS(),
      info: null,
      loading: false,
      error: null,
      revealKey: false,
      keyValue: null,
      rotating: false,
      copied: null,
      showHelp: false,
    },
  };
}

// ── Quick Install actions ────────────────────────────────────

/** Best-effort guess at the viewer's OS so config paths default sensibly. */
function detectClientOS(): QuickOS {
  const ua =
    typeof navigator !== "undefined"
      ? `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase()
      : "";
  if (ua.includes("win")) return "windows";
  if (ua.includes("mac")) return "macos";
  return "linux";
}

/**
 * Load the canonical connection info from the gateway. This is the ONLY source
 * of port / LAN IP / Tailscale host / auth posture — the view never re-derives.
 */
export async function loadQuickInstallInfo(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const qi = mcpState.quickInstall;
  qi.loading = true;
  qi.error = null;
  state.requestUpdate?.();

  try {
    const info = await state.client.request<QuickConnectInfo>("mcp.connectInfo");
    qi.info = info;
    // If the current scope is unavailable, fall back to the best reachable one.
    if (info.reach[qi.scope] === "down") {
      qi.scope = info.reach.lan !== "down" ? "lan" : info.reach.tailscale !== "down" ? "tailscale" : "local";
    }
  } catch (err) {
    qi.error = err instanceof Error ? err.message : String(err);
  } finally {
    qi.loading = false;
    state.requestUpdate?.();
  }
}

export function setQuickScope(state: AppViewState, scope: QuickScope): void {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  qi.scope = scope;
  state.requestUpdate?.();
}

export function setQuickClient(state: AppViewState, client: QuickClient): void {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  qi.client = client;
  state.requestUpdate?.();
}

export function setQuickOS(state: AppViewState, os: QuickOS): void {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  qi.os = os;
  state.requestUpdate?.();
}

export function toggleQuickInstall(state: AppViewState): void {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  qi.expanded = !qi.expanded;
  state.requestUpdate?.();
  // Lazy-load connection info the first time the panel opens.
  if (qi.expanded && !qi.info && !qi.loading) void loadQuickInstallInfo(state);
}

export function toggleQuickHelp(state: AppViewState): void {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  qi.showHelp = !qi.showHelp;
  state.requestUpdate?.();
}

/** Copy text to the clipboard and flash a transient "Copied!" on the snippet. */
export async function copyQuickSnippet(state: AppViewState, id: string, text: string): Promise<void> {
  const qi = state.mcpManagementState?.quickInstall;
  if (!qi) return;
  try {
    await navigator.clipboard.writeText(text);
    qi.copied = id;
    state.requestUpdate?.();
    setTimeout(() => {
      if (qi.copied === id) {
        qi.copied = null;
        state.requestUpdate?.();
      }
    }, 1800);
  } catch {
    qi.error = "Clipboard unavailable — copy the snippet manually.";
    state.requestUpdate?.();
  }
}

/**
 * Reveal the gateway's auth secret by reading it from the existing config store
 * (`gateway.auth.token` / `.password`). We never persist a parallel copy.
 */
export async function revealGatewayKey(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;
  const qi = mcpState.quickInstall;

  if (qi.revealKey) {
    qi.revealKey = false;
    state.requestUpdate?.();
    return;
  }

  try {
    const snap = await state.client.request<{ config: Record<string, unknown> }>("config.get", {});
    const gateway = (snap?.config?.gateway ?? {}) as Record<string, unknown>;
    const auth = (gateway.auth ?? {}) as Record<string, unknown>;
    const secret =
      (typeof auth.token === "string" && auth.token) ||
      (typeof auth.password === "string" && auth.password) ||
      "";
    qi.keyValue = secret || null;
    qi.revealKey = true;
  } catch (err) {
    qi.error = err instanceof Error ? err.message : String(err);
  }
  state.requestUpdate?.();
}

/**
 * Rotate the gateway auth secret. Writes a fresh token into the existing config
 * store via `config.patch` (the same store the gateway already reads). This
 * triggers a gateway restart and disconnects existing clients, so it is gated
 * behind an explicit confirm in the view.
 */
export async function rotateGatewayKey(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;
  const qi = mcpState.quickInstall;

  qi.rotating = true;
  qi.error = null;
  state.requestUpdate?.();

  try {
    // Fresh snapshot for the base hash the patch optimistic-lock requires.
    const snap = await state.client.request<{ config: Record<string, unknown>; hash?: string }>(
      "config.get",
      {},
    );
    const baseHash = snap?.hash;
    if (!baseHash) throw new Error("Config hash unavailable — refresh and retry.");

    const mode = qi.info?.auth.mode === "password" ? "password" : "token";
    const newSecret = generateGatewaySecret();
    const patch = JSON.stringify({ gateway: { auth: { mode, [mode]: newSecret } } });

    await state.client.request("config.patch", {
      raw: patch,
      baseHash,
      note: "Rotated gateway auth key from Quick Install",
    });

    qi.keyValue = newSecret;
    qi.revealKey = true;
    if (qi.info) qi.info.auth = { mode, required: true, hasSecret: true };
    mcpState.successMessage =
      "Gateway key rotated — the gateway is restarting. Re-add the snippet to existing clients.";
    setTimeout(() => {
      if (mcpState) mcpState.successMessage = null;
      state.requestUpdate?.();
    }, 6000);
  } catch (err) {
    qi.error = err instanceof Error ? err.message : String(err);
  } finally {
    qi.rotating = false;
    state.requestUpdate?.();
  }
}

/** 32-hex-char secret from the Web Crypto RNG. */
function generateGatewaySecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Inspector drawer ─────────────────────────────────────────

export async function openInspector(state: AppViewState, serverName: string): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  const insp = mcpState.inspector;
  insp.serverName = serverName;
  insp.loading = true;
  insp.error = null;
  insp.tools = [];
  insp.tries = {};
  state.requestUpdate?.();

  const server = mcpState.servers.find((s) => s.name === serverName);

  try {
    let tools: McpToolInfo[] | null = null;
    // Best-effort: ask the gateway for the live tool list this server exposes.
    try {
      const res = await state.client?.request<{ tools?: Array<{ name: string; description?: string }> }>(
        "mcp.server.tools",
        { name: serverName },
      );
      if (res?.tools?.length) {
        tools = res.tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
      }
    } catch {
      // RPC unavailable — fall through to cached metadata
    }

    if (!tools || !tools.length) {
      if (server?.toolDetails?.length) tools = server.toolDetails;
      else if (server?.tools?.length) tools = server.tools.map((n) => ({ name: n, description: "" }));
      else tools = [];
    }

    insp.tools = tools;
  } catch (err) {
    insp.error = err instanceof Error ? err.message : String(err);
  } finally {
    insp.loading = false;
    state.requestUpdate?.();
  }
}

export function closeInspector(state: AppViewState): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;
  mcpState.inspector.serverName = null;
  mcpState.inspector.tools = [];
  mcpState.inspector.tries = {};
  mcpState.inspector.error = null;
  state.requestUpdate?.();
}

function inspectorTry(mcpState: McpManagementState, toolName: string): InspectorToolTry {
  let slot = mcpState.inspector.tries[toolName];
  if (!slot) {
    slot = { args: "{}", running: false, result: null, error: null, open: false };
    mcpState.inspector.tries[toolName] = slot;
  }
  return slot;
}

export function toggleInspectorTry(state: AppViewState, toolName: string): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;
  const slot = inspectorTry(mcpState, toolName);
  slot.open = !slot.open;
  state.requestUpdate?.();
}

export function setInspectorTryArgs(state: AppViewState, toolName: string, args: string): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;
  inspectorTry(mcpState, toolName).args = args;
  state.requestUpdate?.();
}

export async function callInspectorTool(state: AppViewState, toolName: string): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  const slot = inspectorTry(mcpState, toolName);
  slot.running = true;
  slot.error = null;
  slot.result = null;
  state.requestUpdate?.();

  let parsed: Record<string, unknown> = {};
  if (slot.args.trim()) {
    try {
      parsed = JSON.parse(slot.args) as Record<string, unknown>;
    } catch {
      slot.error = "Arguments must be valid JSON.";
      slot.running = false;
      state.requestUpdate?.();
      return;
    }
  }

  try {
    // Served method is `mcp.tools.invoke`; its server param is `mcp`.
    const res = await state.client?.request("mcp.tools.invoke", {
      mcp: mcpState.inspector.serverName,
      tool: toolName,
      args: parsed,
    });
    slot.result = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  } catch (err) {
    slot.error = err instanceof Error ? err.message : "Tool call failed — the live call endpoint is unavailable.";
  } finally {
    slot.running = false;
    state.requestUpdate?.();
  }
}

// ── Agent category mapping ───────────────────────────────────

const AGENT_CATEGORIES: Record<string, string> = {
  main: "Core",
  webdev: "Development",
  qa: "Quality Assurance",
};

const AGENT_NAMES: Record<string, string> = {
  main: "Infini",
  webdev: "Architect",
  qa: "Inspector",
};

const AGENT_DESCRIPTIONS: Record<string, string> = {
  main: "Default agent — integration, restoration, and general-purpose tasks",
  webdev: "Web development specialist — frontend, backend, and full-stack",
  qa: "Quality assurance — testing, validation, and bug hunting",
};

// ── Data Loading ─────────────────────────────────────────────

export async function loadMcpStatus(
  state: AppViewState,
): Promise<{ running: boolean; port: number; uptime: number } | null> {
  if (!state.client) return null;
  try {
    const result = await state.client.request<{ running: boolean; port: number; uptime: number }>("mcp.status");
    return result || { running: false, port: 0, uptime: 0 };
  } catch {
    return { running: false, port: 0, uptime: 0 };
  }
}

export async function loadMcpConfig(
  state: AppViewState,
): Promise<{ agents: McpAgentInfo[]; servers: McpServerInfo[] }> {
  if (!state.client) return { agents: [], servers: [] };
  try {
    const configSnap = await state.client.request<{ config: Record<string, unknown> }>("config.get", {});
    const config = configSnap?.config as Record<string, unknown> || {};
    const agentsConfig = config.agents as Record<string, unknown> || {};
    const agentsList = (agentsConfig.list as Array<Record<string, unknown>>) || [];

    // Parse agents
    const agents: McpAgentInfo[] = agentsList.map((a) => {
      const id = String(a.id || "unknown");
      const tools = a.tools as Record<string, unknown> | undefined;
      const subagents = a.subagents as Record<string, unknown> | undefined;
      const prompt = String(a.systemPrompt || "");
      return {
        id,
        name: String(a.name || AGENT_NAMES[id] || id),
        description: AGENT_DESCRIPTIONS[id] || `Agent: ${id}`,
        model: String((a as any).model || (config as any).model?.default || ""),
        thinkingLevel: String((a as any).thinkingLevel || (config as any).model?.thinkingLevel || ""),
        isDefault: Boolean(a.default),
        workspace: String(a.workspace || ""),
        category: AGENT_CATEGORIES[id] || "Other",
        tools: tools
          ? {
              allow: Array.isArray(tools.allow) ? tools.allow.map(String) : undefined,
              deny: Array.isArray(tools.deny) ? tools.deny.map(String) : undefined,
              profile: tools.profile ? String(tools.profile) : undefined,
            }
          : undefined,
        subagents: subagents
          ? {
              allowAgents: Array.isArray(subagents.allowAgents) ? subagents.allowAgents.map(String) : undefined,
            }
          : undefined,
        mcpServers: [],
        systemPromptPreview: prompt ? prompt.slice(0, 120) + (prompt.length > 120 ? "…" : "") : undefined,
      };
    });

    // Parse MCP servers from config (tools.mcp or similar)
    const toolsConfig = config.tools as Record<string, unknown> || {};
    const mcpConfig = toolsConfig.mcp as Record<string, unknown> || {};
    const serversConfig = (mcpConfig.servers as Array<Record<string, unknown>>) || [];

    const servers: McpServerInfo[] = serversConfig.map((s) => ({
      name: String(s.name || "unknown"),
      description: String(s.description || ""),
      enabled: Boolean(s.enabled !== false),
      running: false,
      custom: Boolean(s.custom),
      command: s.command ? String(s.command) : undefined,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: s.env as Record<string, string> | undefined,
      tools: Array.isArray(s.tools) ? s.tools.map(String) : undefined,
      category: String(s.category || "General"),
    }));

    // If no servers found in config, show some default placeholders
    if (servers.length === 0) {
      servers.push(
        {
          name: "kanban",
          description: "Kanban board task management server",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-kanban",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/kanban",
          tools: ["kanban.tasks.list", "kanban.tasks.create", "kanban.tasks.update", "kanban.tasks.delete",
                  "kanban.projects.list", "kanban.projects.create"],
          toolDetails: [
            { name: "create_task", description: "Create a new kanban task with title, description, priority, assignee, and project" },
            { name: "update_task", description: "Update task status, description, assignee, or priority by task ID" },
            { name: "list_tasks", description: "List tasks with optional filters by status, assignee, or project" },
            { name: "list_projects", description: "List all kanban projects with task counts and metadata" },
          ],
        },
        {
          name: "filesystem",
          description: "File system operations — read, write, search, and execute commands",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-filesystem",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/filesystem",
          tools: ["read", "write", "edit", "exec"],
          toolDetails: [
            { name: "read", description: "Read file contents. Supports text and images (jpg, png, gif, webp). Truncated at 2000 lines or 50KB." },
            { name: "write", description: "Write content to a file. Creates parent directories automatically. Overwrites if exists." },
            { name: "edit", description: "Surgical text replacement — find exact oldText and replace with newText. Preserves file structure." },
            { name: "exec", description: "Execute shell commands with background continuation, PTY support, and timeout control." },
            { name: "process", description: "Manage running exec sessions — list, poll, log, write, send-keys, kill background processes." },
          ],
        },
        {
          name: "web",
          description: "Web search and content fetching via Brave Search API",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "https://api.search.brave.com",
          transport: "http",
          docsUrl: "https://infinibotos.com/docs/tools/web",
          tools: ["web_search", "web_fetch"],
          toolDetails: [
            { name: "web_search", description: "Search the web using Brave Search API. Supports region, language, freshness filters. Returns titles, URLs, snippets." },
            { name: "web_fetch", description: "Fetch and extract readable content from a URL. Converts HTML to markdown or plain text with truncation." },
          ],
        },
        {
          name: "browser",
          description: "Browser automation — snapshots, navigation, clicks, screenshots, and page control",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "ws://localhost:9222",
          transport: "websocket",
          docsUrl: "https://infinibotos.com/docs/tools/browser",
          tools: ["browser"],
          toolDetails: [
            { name: "browser.snapshot", description: "Capture accessible DOM tree snapshot with role/aria refs for automation" },
            { name: "browser.screenshot", description: "Take a PNG/JPEG screenshot of the current page or element" },
            { name: "browser.navigate", description: "Navigate to a URL in the active tab" },
            { name: "browser.act", description: "Perform actions — click, type, press, hover, drag, select, fill, evaluate JS" },
            { name: "browser.open", description: "Open a new tab with a URL" },
            { name: "browser.tabs", description: "List all open browser tabs" },
            { name: "browser.console", description: "Read browser console output" },
            { name: "browser.pdf", description: "Generate PDF from current page" },
          ],
        },
        {
          name: "messaging",
          description: "Cross-platform message sending — Telegram, Discord, WhatsApp, Signal, Slack",
          enabled: true,
          running: false,
          category: "Communication",
          url: "stdio://infinibot-messaging",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/message",
          tools: ["message"],
          toolDetails: [
            { name: "message.send", description: "Send a message to a target channel or user. Supports all configured platforms." },
            { name: "message.broadcast", description: "Broadcast a message to multiple targets simultaneously" },
            { name: "message.react", description: "Add or remove emoji reactions on messages" },
            { name: "message.delete", description: "Delete a message by ID" },
            { name: "message.edit", description: "Edit an existing message" },
            { name: "message.poll", description: "Create a poll with question and options" },
          ],
        },
        {
          name: "tts",
          description: "Text-to-speech audio generation with configurable voices",
          enabled: true,
          running: false,
          category: "Media",
          url: "stdio://infinibot-tts",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/tts",
          tools: ["tts"],
          toolDetails: [
            { name: "tts", description: "Convert text to speech audio. Returns a MEDIA path for playback. Supports channel-specific output formats." },
          ],
        },
        {
          name: "memory",
          description: "Semantic memory search and retrieval across MEMORY.md and memory files",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-memory",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/memory",
          tools: ["memory_search", "memory_get"],
          toolDetails: [
            { name: "memory_search", description: "Semantically search MEMORY.md and memory/*.md files. Returns top snippets with path and line numbers." },
            { name: "memory_get", description: "Read a snippet from MEMORY.md or memory/*.md with optional line offset. Use after memory_search." },
          ],
        },
        {
          name: "cron",
          description: "Scheduled job management — cron expressions, intervals, one-shot timers",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-cron",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/cron",
          tools: ["cron"],
          toolDetails: [
            { name: "cron.add", description: "Create a scheduled job with cron expression, interval, or one-shot time" },
            { name: "cron.list", description: "List all configured cron jobs with status" },
            { name: "cron.remove", description: "Delete a cron job by ID" },
            { name: "cron.run", description: "Trigger a cron job immediately" },
            { name: "cron.wake", description: "Send a wake event to the gateway" },
          ],
        },
        {
          name: "nodes",
          description: "Paired device control — camera, screen, location, notifications, remote execution",
          enabled: true,
          running: false,
          category: "Devices",
          url: "stdio://infinibot-nodes",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/nodes",
          tools: ["nodes"],
          toolDetails: [
            { name: "nodes.status", description: "List all paired nodes with connection status" },
            { name: "nodes.camera_snap", description: "Capture a photo from a node's camera (front/back/both)" },
            { name: "nodes.camera_clip", description: "Record a short video clip from a node's camera" },
            { name: "nodes.screen_record", description: "Record the screen of a paired device" },
            { name: "nodes.location_get", description: "Get the GPS location of a paired device" },
            { name: "nodes.notify", description: "Send a push notification to a paired device" },
            { name: "nodes.run", description: "Execute a command on a paired device" },
          ],
        },
        {
          name: "canvas",
          description: "Node canvas control — present UI, evaluate JS, capture snapshots",
          enabled: true,
          running: false,
          category: "Devices",
          url: "stdio://infinibot-canvas",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/canvas",
          tools: ["canvas"],
          toolDetails: [
            { name: "canvas.present", description: "Present a URL on a node's canvas display" },
            { name: "canvas.snapshot", description: "Capture the rendered canvas UI as an image" },
            { name: "canvas.eval", description: "Evaluate JavaScript in the canvas context" },
            { name: "canvas.navigate", description: "Navigate the canvas to a new URL" },
          ],
        },
        {
          name: "sessions",
          description: "Multi-agent session management — spawn, list, send, history",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-sessions",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/sessions",
          tools: ["sessions_spawn", "sessions_list", "sessions_history", "sessions_send", "session_status"],
          toolDetails: [
            { name: "sessions_spawn", description: "Spawn a background sub-agent in an isolated session. Announces result back when done." },
            { name: "sessions_list", description: "List active sessions with optional filters and last messages" },
            { name: "sessions_history", description: "Fetch message history for a specific session by key" },
            { name: "sessions_send", description: "Send a message into another session by key or label" },
            { name: "session_status", description: "Show session status card — usage, time, cost, model override" },
          ],
        },
        {
          name: "workflows",
          description: "Reusable instruction workflow management — create, edit, search, sync to Notion",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-workflows",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/workflows",
          tools: ["workflows"],
          toolDetails: [
            { name: "workflows.list", description: "List all markdown instruction workflows" },
            { name: "workflows.get", description: "Read a workflow by ID" },
            { name: "workflows.create", description: "Create a new workflow with name and markdown body" },
            { name: "workflows.update", description: "Update workflow fields by ID" },
            { name: "workflows.delete", description: "Remove a workflow by ID" },
            { name: "workflows.search", description: "Find workflows by query or tags" },
          ],
        },
        {
          name: "notes",
          description: "Markdown notes management — quick captures, thoughts, logs with categories and pinning",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-notes",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/notes",
          tools: ["notes"],
          toolDetails: [
            { name: "notes.list", description: "List all notes with optional filters by category, pinned status, or search query" },
            { name: "notes.get", description: "Read a note by ID — returns full markdown body and metadata" },
            { name: "notes.create", description: "Create a new note with name, markdown body, category, tags, and optional pinning" },
            { name: "notes.update", description: "Update note fields by ID — body, category, tags, pinned status, linked notes" },
            { name: "notes.delete", description: "Remove a note by ID" },
            { name: "notes.search", description: "Find notes by query string, tags, or category filter" },
          ],
        },
        {
          name: "research",
          description: "Study & research document management — deep dives, papers, references with status tracking",
          enabled: true,
          running: false,
          category: "Built-in",
          url: "stdio://infinibot-research",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/research",
          tools: ["research"],
          toolDetails: [
            { name: "research.list", description: "List all research documents with optional filters by status, topic, or category" },
            { name: "research.get", description: "Read a research document by ID — full markdown body, sources, and metadata" },
            { name: "research.create", description: "Create a new research document with name, body, topic, status, sources, and category" },
            { name: "research.update", description: "Update research document fields — body, status (draft/active/review/archived), sources, topic" },
            { name: "research.delete", description: "Remove a research document by ID" },
            { name: "research.search", description: "Find research documents by query, tags, topic, or status filter" },
          ],
        },
        {
          name: "gateway",
          description: "Gateway daemon control — restart, config management, self-update",
          enabled: true,
          running: false,
          category: "System",
          url: "stdio://infinibot-gateway",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/gateway",
          tools: ["gateway"],
          toolDetails: [
            { name: "gateway.restart", description: "Restart the InfiniBot gateway daemon" },
            { name: "gateway.config.get", description: "Read current gateway configuration" },
            { name: "gateway.config.patch", description: "Safely merge partial config updates" },
            { name: "gateway.config.apply", description: "Replace entire config and restart" },
            { name: "gateway.update.run", description: "Update deps or git, then restart" },
          ],
        },
        {
          name: "image",
          description: "Vision model image analysis for images not in conversation context",
          enabled: true,
          running: false,
          category: "Media",
          url: "stdio://infinibot-image",
          transport: "stdio",
          docsUrl: "https://infinibotos.com/docs/tools/image",
          tools: ["image"],
          toolDetails: [
            { name: "image", description: "Analyze an image with a vision model. Use when the image was NOT already provided in the user's message." },
          ],
        },
        {
          name: "business-management",
          description: "Universal multi-business management — clients, products, orders, invoices, expenses, analytics",
          enabled: true,
          running: false,
          category: "Business",
          url: "http://localhost:8890",
          transport: "websocket",
          tools: [
            "business_create", "business_list", "business_get", "business_update", "business_delete", "business_switch",
            "client_create", "client_list", "client_get", "client_update", "client_delete",
            "product_create", "product_list", "product_update", "product_delete",
            "order_create", "order_list", "order_get", "order_update_status",
            "invoice_create", "invoice_list", "invoice_get", "invoice_update",
            "expense_create", "expense_list", "expense_summary",
            "business_dashboard", "business_revenue_report",
          ],
          toolDetails: [
            { name: "business_create", description: "Register a new business with name, industry, currency" },
            { name: "business_list", description: "List all registered businesses with active context" },
            { name: "business_get", description: "Get business details with financial summary stats" },
            { name: "business_switch", description: "Set the active business context for all operations" },
            { name: "client_create", description: "Add a new client/customer with contact info, tags, and notes" },
            { name: "client_list", description: "List and search clients by name, tag, or business" },
            { name: "client_get", description: "Get client details with full order and invoice history" },
            { name: "product_create", description: "Add a product or service with price, category, SKU, and stock" },
            { name: "product_list", description: "List products/services filtered by category or type" },
            { name: "order_create", description: "Create an order with line items auto-calculated from products" },
            { name: "order_list", description: "List orders filtered by status, client, or date range" },
            { name: "order_update_status", description: "Update order status: pending → confirmed → in_progress → completed" },
            { name: "invoice_create", description: "Create invoice from an order or with manual line items" },
            { name: "invoice_list", description: "List invoices filtered by status (draft/sent/paid/overdue)" },
            { name: "invoice_update", description: "Update invoice — mark as sent, paid, add payment method" },
            { name: "expense_create", description: "Record a business expense with category, vendor, receipt" },
            { name: "expense_list", description: "List expenses filtered by category, vendor, or date range" },
            { name: "expense_summary", description: "Get expense totals broken down by category and month" },
            { name: "business_dashboard", description: "Full dashboard — revenue, expenses, profit, top clients, pending orders" },
            { name: "business_revenue_report", description: "Revenue report with monthly, product, and client breakdowns" },
          ],
        },
      );
    }

    return { agents, servers };
  } catch (err) {
    console.warn("[MCP] Failed to load config:", err);
    return { agents: [], servers: [] };
  }
}

// ── Full page load ───────────────────────────────────────────

export async function loadMcpPage(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  mcpState.loading = true;
  mcpState.error = null;
  state.requestUpdate?.();

  try {
    // Load config data with fallback - this generates placeholder servers
    const configData = await loadMcpConfig(state);
    mcpState.agents = configData.agents;
    mcpState.servers = configData.servers;

    // Try to load MCP status (non-critical, has fallback)
    try {
      const status = await Promise.race([
        loadMcpStatus(state),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      mcpState.status = status;
      if (status?.running) {
        for (const server of mcpState.servers) {
          if (server.enabled) server.running = true;
        }
      }
    } catch {
      mcpState.status = { running: false, port: 0, uptime: 0 };
    }

    // Try to load skills status (non-critical)
    try {
      const skillsReport = await Promise.race([
        loadSkillsStatus(state),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      mcpState.skillsReport = skillsReport;
    } catch {
      mcpState.skillsReport = null;
    }

    // Load Canva credential profile (non-critical)
    try {
      await loadCanvaProfile(state);
    } catch {
      // ignore
    }

    // Load Supabase credential profile (non-critical)
    try {
      await loadSupabaseProfile(state);
    } catch {
      // ignore
    }

    // Load Quick Install connection info (non-critical)
    try {
      await loadQuickInstallInfo(state);
    } catch {
      // ignore
    }
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to load MCP data";
    // Still provide fallback servers
    mcpState.servers = getDefaultServers();
    mcpState.agents = [];
  } finally {
    mcpState.loading = false;
    state.requestUpdate?.();
  }
}

// ── Canva MCP credential actions ─────────────────────────────

export async function loadCanvaProfile(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  try {
    const result = await state.client.request<{
      providers: Array<{
        provider: string;
        profiles: Array<{
          profileId: string;
          email?: string;
          status: string;
          displayName?: string;
        }>;
      }>;
    }>("auth.profiles.list");
    const canvaProv = result.providers?.find((p) => p.provider === "canva");
    const profile = canvaProv?.profiles?.[0];

    if (profile) {
      mcpState.canva.profileId = profile.profileId;
      mcpState.canva.accountEmail = profile.email ?? null;
      mcpState.canva.accountDisplayName = (profile as any).displayName ?? null;
      mcpState.canva.status =
        profile.status === "expired" ? "expired" : "connected";
    } else {
      mcpState.canva.profileId = null;
      mcpState.canva.accountEmail = null;
      mcpState.canva.accountDisplayName = null;
      mcpState.canva.status = "disconnected";
    }
  } catch {
    // keep existing state
  }

  state.requestUpdate?.();
}

export function startCanvaOAuth(state: AppViewState): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  mcpState.canva.oauthPending = true;
  mcpState.canva.error = null;
  state.requestUpdate?.();

  // Derive gateway base URL from the current page location
  const base = gatewayOrigin();
  const popup = window.open(
    `${base}/oauth/canva/start`,
    "canva-oauth",
    "width=600,height=700,toolbar=no,location=no,status=no,menubar=no",
  );

  if (!popup) {
    mcpState.canva.oauthPending = false;
    mcpState.canva.error = "Popup blocked — allow popups for this page and try again.";
    state.requestUpdate?.();
    return;
  }

  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "canva:oauth:done") return;
    window.removeEventListener("message", onMessage);
    mcpState.canva.oauthPending = false;

    const { email, displayName } = event.data as { email?: string; displayName?: string };
    if (email || displayName) {
      mcpState.canva.accountEmail = email ?? null;
      mcpState.canva.accountDisplayName = displayName ?? null;
      mcpState.canva.profileId = "canva:default";
      mcpState.canva.status = "connected";
      mcpState.canva.testResult = null;
    }

    state.requestUpdate?.();
    // Reload from store to pick up persisted state
    loadCanvaProfile(state).catch(() => {});
  };

  window.addEventListener("message", onMessage);

  // Clean up listener if popup is closed without completing
  const pollClosed = setInterval(() => {
    if (popup.closed) {
      clearInterval(pollClosed);
      window.removeEventListener("message", onMessage);
      if (mcpState.canva.oauthPending) {
        mcpState.canva.oauthPending = false;
        state.requestUpdate?.();
      }
    }
  }, 500);
}

export async function saveCanvaToken(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const token = mcpState.canva.tokenDraft.trim();
  if (!token) return;

  mcpState.canva.saving = true;
  mcpState.canva.error = null;
  state.requestUpdate?.();

  try {
    await state.client.request("auth.profiles.upsert", {
      profileId: "canva:default",
      provider: "canva",
      type: "api_key",
      key: token,
    });

    mcpState.canva.profileId = "canva:default";
    mcpState.canva.status = "connected";
    mcpState.canva.tokenDraft = "";
  } catch (err) {
    mcpState.canva.error = err instanceof Error ? err.message : String(err);
  }

  mcpState.canva.saving = false;
  state.requestUpdate?.();
}

export async function testCanvaConnection(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const profileId = mcpState.canva.profileId ?? "canva:default";
  mcpState.canva.testing = true;
  mcpState.canva.testResult = null;
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{
      valid: boolean;
      message: string;
      data?: { designCount?: number };
    }>("auth.profiles.test", { profileId });

    mcpState.canva.testResult = {
      valid: result.valid,
      message: result.message,
      designCount: result.data?.designCount,
    };
    if (result.valid) mcpState.canva.status = "connected";
  } catch (err) {
    mcpState.canva.testResult = {
      valid: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  mcpState.canva.testing = false;
  state.requestUpdate?.();
}

export async function disconnectCanva(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client || !mcpState.canva.profileId) return;

  mcpState.canva.disconnecting = true;
  mcpState.canva.error = null;
  state.requestUpdate?.();

  try {
    await state.client.request("auth.profiles.delete", {
      profileId: mcpState.canva.profileId,
    });
    mcpState.canva.profileId = null;
    mcpState.canva.accountEmail = null;
    mcpState.canva.status = "disconnected";
    mcpState.canva.testResult = null;
    mcpState.canva.showModal = false;
  } catch (err) {
    mcpState.canva.error = err instanceof Error ? err.message : String(err);
  }

  mcpState.canva.disconnecting = false;
  state.requestUpdate?.();
}

// ── Supabase MCP credential actions ──────────────────────────

export async function loadSupabaseProfile(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  try {
    const result = await state.client.request<{
      connected: boolean;
      profileId: string | null;
      maskedPat: string | null;
      projectRef: string | null;
      readOnly: boolean;
    }>("supabase.mcp.load");

    mcpState.supabase.profileId = result.connected ? "supabase:default" : null;
    mcpState.supabase.maskedPat = result.maskedPat;
    mcpState.supabase.projectRef = result.projectRef;
    mcpState.supabase.projectRefDraft = result.projectRef ?? "";
    mcpState.supabase.readOnly = result.readOnly;
    mcpState.supabase.status = result.connected ? "connected" : "disconnected";
  } catch {
    // keep existing state
  }

  state.requestUpdate?.();
}

export async function saveSupabaseConfig(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const sb = mcpState.supabase;
  const pat = sb.patDraft.trim();
  if (!pat) return;

  sb.saving = true;
  sb.error = null;
  state.requestUpdate?.();

  try {
    await state.client.request("supabase.mcp.save", {
      pat,
      projectRef: sb.projectRefDraft.trim() || undefined,
      readOnly: sb.readOnly,
    });

    sb.profileId = "supabase:default";
    sb.status = "connected";
    sb.maskedPat = pat.slice(0, 6) + "••••" + pat.slice(-4);
    sb.projectRef = sb.projectRefDraft.trim() || null;
    sb.patDraft = "";
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
  }

  sb.saving = false;
  state.requestUpdate?.();
}

export async function testSupabaseConnection(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const sb = mcpState.supabase;
  sb.testing = true;
  sb.testResult = null;
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{
      valid: boolean;
      message: string;
      projectCount?: number;
      projectName?: string;
    }>("supabase.mcp.test");

    sb.testResult = {
      valid: result.valid,
      message: result.message,
      projectCount: result.projectCount,
      projectName: result.projectName,
    };
    if (result.valid) {
      sb.status = "connected";
      if (result.projectName) sb.projectName = result.projectName;
      if (result.projectCount != null) sb.projectCount = result.projectCount;
    }
  } catch (err) {
    sb.testResult = {
      valid: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  sb.testing = false;
  state.requestUpdate?.();
}

export async function disconnectSupabase(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  const sb = mcpState.supabase;
  sb.disconnecting = true;
  sb.error = null;
  state.requestUpdate?.();

  try {
    await state.client.request("supabase.mcp.disconnect");
    sb.profileId = null;
    sb.maskedPat = null;
    sb.projectRef = null;
    sb.projectName = null;
    sb.projectCount = null;
    sb.status = "disconnected";
    sb.testResult = null;
    sb.showModal = false;
  } catch (err) {
    sb.error = err instanceof Error ? err.message : String(err);
  }

  sb.disconnecting = false;
  state.requestUpdate?.();
}

function getDefaultServers(): McpServerInfo[] {
  return [
    {
      name: "kanban",
      description: "Kanban board task management server",
      enabled: true,
      running: false,
      category: "Built-in",
      url: "stdio://infinibot-kanban",
      transport: "stdio",
      tools: ["kanban.tasks.list", "kanban.tasks.create", "kanban.tasks.update"],
      toolDetails: [
        { name: "create_task", description: "Create a new kanban task with title, description, priority, assignee, and project" },
        { name: "update_task", description: "Update task status, description, assignee, or priority by task ID" },
        { name: "list_tasks", description: "List tasks with optional filters by status, assignee, or project" },
        { name: "list_projects", description: "List all kanban projects with task counts and metadata" },
      ],
    },
    {
      name: "filesystem",
      description: "File system operations — read, write, search, and execute commands",
      enabled: true,
      running: false,
      category: "Built-in",
      transport: "stdio",
      tools: ["read", "write", "edit", "exec"],
      toolDetails: [
        { name: "read", description: "Read file contents. Supports text and images." },
        { name: "write", description: "Write content to a file. Creates parent directories automatically." },
        { name: "edit", description: "Surgical text replacement — find exact oldText and replace with newText." },
        { name: "exec", description: "Execute shell commands with background continuation and PTY support." },
      ],
    },
    {
      name: "web",
      description: "Web search and content fetching via Brave Search API",
      enabled: true,
      running: false,
      category: "Built-in",
      transport: "http",
      tools: ["web_search", "web_fetch"],
      toolDetails: [
        { name: "web_search", description: "Search the web using Brave Search API. Returns titles, URLs, snippets." },
        { name: "web_fetch", description: "Fetch and extract readable content from a URL." },
      ],
    },
    {
      name: "browser",
      description: "Browser automation — snapshots, navigation, clicks, screenshots",
      enabled: true,
      running: false,
      category: "Built-in",
      transport: "websocket",
      tools: ["browser"],
      toolDetails: [
        { name: "browser.snapshot", description: "Capture accessible DOM tree snapshot" },
        { name: "browser.screenshot", description: "Take a screenshot of the current page" },
        { name: "browser.navigate", description: "Navigate to a URL" },
        { name: "browser.act", description: "Perform actions — click, type, press, hover" },
      ],
    },
    {
      name: "messaging",
      description: "Cross-platform messaging — Telegram, Discord, WhatsApp, Signal",
      enabled: true,
      running: false,
      category: "Communication",
      transport: "stdio",
      tools: ["message"],
      toolDetails: [
        { name: "message.send", description: "Send a message to a target channel or user" },
        { name: "message.react", description: "Add or remove emoji reactions" },
      ],
    },
    {
      name: "memory",
      description: "Semantic memory search and retrieval",
      enabled: true,
      running: false,
      category: "Built-in",
      transport: "stdio",
      tools: ["memory_search", "memory_get"],
      toolDetails: [
        { name: "memory_search", description: "Semantically search MEMORY.md and memory files" },
        { name: "memory_get", description: "Read a snippet from memory files" },
      ],
    },
    {
      name: "sessions",
      description: "Multi-agent session management",
      enabled: true,
      running: false,
      category: "Built-in",
      transport: "stdio",
      tools: ["sessions_spawn", "sessions_list", "sessions_send"],
      toolDetails: [
        { name: "sessions_spawn", description: "Spawn a background sub-agent session" },
        { name: "sessions_list", description: "List active sessions" },
        { name: "sessions_send", description: "Send a message to another session" },
      ],
    },
  ];
}

// ── Load Skills Status ───────────────────────────────────────

async function loadSkillsStatus(state: AppViewState): Promise<McpManagementState["skillsReport"]> {
  if (!state.client) return null;
  try {
    const res = await state.client.request("skills.status", {});
    return res as McpManagementState["skillsReport"];
  } catch {
    return null;
  }
}

// ── Server Actions ───────────────────────────────────────────

export async function startMcp(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  mcpState.actionBusy = "start";
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{ running: boolean; port: number; uptime?: number }>("mcp.start");
    mcpState.status = {
      running: result?.running ?? false,
      port: result?.port ?? 0,
      uptime: result?.uptime ?? 0,
    };
    if (result?.running) {
      for (const s of mcpState.servers) {
        if (s.enabled) s.running = true;
      }
    }
    mcpState.successMessage = "MCP server started";
    setTimeout(() => { if (mcpState) mcpState.successMessage = null; state.requestUpdate?.(); }, 3000);
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to start MCP server";
  } finally {
    mcpState.actionBusy = null;
    state.requestUpdate?.();
  }
}

export async function stopMcp(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  mcpState.actionBusy = "stop";
  state.requestUpdate?.();

  try {
    await state.client.request("mcp.stop");
    mcpState.status = { running: false, port: 0, uptime: 0 };
    for (const s of mcpState.servers) s.running = false;
    mcpState.successMessage = "MCP server stopped";
    setTimeout(() => { if (mcpState) mcpState.successMessage = null; state.requestUpdate?.(); }, 3000);
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to stop MCP server";
  } finally {
    mcpState.actionBusy = null;
    state.requestUpdate?.();
  }
}

export async function restartMcp(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  mcpState.actionBusy = "restart";
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{ running: boolean; port: number; uptime?: number }>("mcp.restart");
    mcpState.status = {
      running: result?.running ?? false,
      port: result?.port ?? 0,
      uptime: result?.uptime ?? 0,
    };
    mcpState.successMessage = "MCP server restarted";
    setTimeout(() => { if (mcpState) mcpState.successMessage = null; state.requestUpdate?.(); }, 3000);
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to restart MCP server";
  } finally {
    mcpState.actionBusy = null;
    state.requestUpdate?.();
  }
}

// ── Claude Code registration ─────────────────────────────────

export async function registerInClaudeCode(
  state: AppViewState,
  opts?: { force?: boolean },
): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  mcpState.actionBusy = "claudeCodeRegister";
  mcpState.error = null;
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{
      path: string;
      changed: boolean;
      entry: unknown;
    }>("mcp.claudeCode.register", { force: opts?.force ?? false });
    mcpState.successMessage = result.changed
      ? `Registered infinibot in Claude Code (${result.path})`
      : `Already registered at ${result.path}`;
    setTimeout(() => {
      if (mcpState) mcpState.successMessage = null;
      state.requestUpdate?.();
    }, 4000);
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to register in Claude Code";
  } finally {
    mcpState.actionBusy = null;
    state.requestUpdate?.();
  }
}

export async function unregisterFromClaudeCode(state: AppViewState): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !state.client) return;

  mcpState.actionBusy = "claudeCodeUnregister";
  mcpState.error = null;
  state.requestUpdate?.();

  try {
    const result = await state.client.request<{ path: string; removed: boolean }>(
      "mcp.claudeCode.unregister",
      {},
    );
    mcpState.successMessage = result.removed
      ? `Removed infinibot entry from ${result.path}`
      : "No infinibot entry to remove";
    setTimeout(() => {
      if (mcpState) mcpState.successMessage = null;
      state.requestUpdate?.();
    }, 4000);
  } catch (err: any) {
    mcpState.error = err?.message || "Failed to unregister from Claude Code";
  } finally {
    mcpState.actionBusy = null;
    state.requestUpdate?.();
  }
}

// ── Toggle Server ────────────────────────────────────────────

export async function toggleMcpServer(
  state: AppViewState,
  serverName: string,
  enabled: boolean,
): Promise<void> {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  const server = mcpState.servers.find((s) => s.name === serverName);
  if (server) {
    server.enabled = enabled;
    if (!enabled) server.running = false;
    state.requestUpdate?.();
  }
}

// ── Add/Remove Custom Server ─────────────────────────────────

export function addCustomServer(state: AppViewState): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  const { name, description, command, args, env } = mcpState.newServer;
  if (!name.trim() || !command.trim()) {
    mcpState.error = "Name and command are required";
    state.requestUpdate?.();
    return;
  }

  const parsedArgs = args.trim() ? args.split(/\s+/) : [];
  let parsedEnv: Record<string, string> = {};
  if (env.trim()) {
    try {
      parsedEnv = JSON.parse(env);
    } catch {
      // Try key=value format
      for (const line of env.split("\n")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          parsedEnv[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
    }
  }

  mcpState.servers.push({
    name: name.trim(),
    description: description.trim() || undefined,
    enabled: true,
    running: false,
    custom: true,
    command: command.trim(),
    args: parsedArgs.length ? parsedArgs : undefined,
    env: Object.keys(parsedEnv).length ? parsedEnv : undefined,
    category: "Custom",
  });

  // Reset form
  mcpState.newServer = { name: "", description: "", command: "", args: "", env: "" };
  mcpState.showAddDialog = false;
  mcpState.successMessage = "Custom server added";
  setTimeout(() => { if (mcpState) mcpState.successMessage = null; state.requestUpdate?.(); }, 3000);
  state.requestUpdate?.();
}

export function removeCustomServer(state: AppViewState, serverName: string): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState) return;

  mcpState.servers = mcpState.servers.filter((s) => s.name !== serverName);
  mcpState.successMessage = `Server "${serverName}" removed`;
  setTimeout(() => { if (mcpState) mcpState.successMessage = null; state.requestUpdate?.(); }, 3000);
  state.requestUpdate?.();
}

// ── Polling ──────────────────────────────────────────────────

export function startMcpPolling(state: AppViewState): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState || mcpState.pollIntervalId) return;

  mcpState.pollIntervalId = window.setInterval(async () => {
    const status = await loadMcpStatus(state);
    if (mcpState && status) {
      mcpState.status = status;
      // Update server running states
      for (const s of mcpState.servers) {
        s.running = status.running && s.enabled;
      }
      state.requestUpdate?.();
    }
  }, 10_000);
}

export function stopMcpPolling(state: AppViewState): void {
  const mcpState = state.mcpManagementState;
  if (!mcpState || !mcpState.pollIntervalId) return;
  window.clearInterval(mcpState.pollIntervalId);
  mcpState.pollIntervalId = null;
}
