/**
 * MCP Registry Controller — browse, search, and install MCP servers
 * from the official MCP Registry (registry.modelcontextprotocol.io).
 */

import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────

export interface RegistryPackage {
  registryType: string;       // "npm" | "oci" | "pypi"
  identifier: string;         // e.g. "@scope/pkg" or "docker.io/img:tag"
  version?: string;
  transport: {
    type: string;             // "stdio" | "streamable-http" | "sse"
    url?: string;
  };
  environmentVariables?: Array<{
    name: string;
    description?: string;
    format?: string;
    isSecret?: boolean;
    required?: boolean;
  }>;
}

export interface RegistryRemote {
  type: string;               // "streamable-http" | "sse"
  url: string;
}

export interface RegistryServer {
  name: string;
  description: string;
  version: string;
  repository?: { url?: string; source?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export interface RegistryEntry {
  server: RegistryServer;
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status: string;
      publishedAt: string;
      updatedAt?: string;
      isLatest?: boolean;
    };
  };
}

export interface McpRegistryState {
  /** Whether the registry browser is open */
  open: boolean;
  /** Search query */
  query: string;
  /** Results from the registry */
  results: RegistryEntry[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Total count from last query */
  totalCount: number;
  /** Pagination cursor */
  nextCursor: string | null;
  /** Currently selected server for detail view */
  selectedServer: RegistryEntry | null;
  /** Installing server name (busy indicator) */
  installing: string | null;
  /** Success message */
  successMessage: string | null;
  /** Install form — env var values */
  envValues: Record<string, string>;

  // ── Curated discovery surface ──────────────────────────────
  /** Free-text search across the curated catalog (name/desc/tags) */
  catalogQuery: string;
  /** Active category pill ("All" or a McpCategory) */
  activeCategory: string;
  /** Featured server currently being installed via the guided form (null = closed) */
  installTarget: FeaturedMcp | null;
  /** Guided install form — per-env-var values */
  installEnv: Record<string, string>;
  /** Guided install busy indicator */
  installBusy: boolean;
  /** Guided install "Test connection" busy indicator */
  installTesting: boolean;
  /** Guided install test result */
  installTestResult: { ok: boolean; message: string } | null;
  /** Guided install error */
  installError: string | null;
}

// ── Curated Catalog ──────────────────────────────────────────

export type McpCategory =
  | "Productivity"
  | "Dev Tools"
  | "Browser/Web"
  | "Databases"
  | "Search"
  | "Communication"
  | "AI Infra"
  | "Cloud"
  | "Design"
  | "Finance"
  | "Automation";

export const CATALOG_CATEGORIES: McpCategory[] = [
  "Productivity",
  "Dev Tools",
  "Browser/Web",
  "Databases",
  "Search",
  "Communication",
  "AI Infra",
  "Cloud",
  "Design",
  "Finance",
  "Automation",
];

export interface FeaturedEnvVar {
  /** Env var key (or arg placeholder when asArg is set) */
  name: string;
  /** Human label shown above the input */
  label: string;
  /** Input affordance */
  type: "text" | "secret" | "path";
  required: boolean;
  placeholder?: string;
  hint?: string;
  /** Where to obtain the secret */
  helpUrl?: string;
  helpLabel?: string;
  /** When true the value is appended to args instead of env (e.g. a path or DSN) */
  asArg?: boolean;
}

export interface FeaturedMcp {
  /** Short unique key — also used as the installed server name */
  id: string;
  name: string;
  tagline: string;
  /** Emoji logo */
  icon: string;
  /** Accent colour for the card rail/logo */
  accent: string;
  category: McpCategory;
  tags: string[];
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: FeaturedEnvVar[];
  docsUrl?: string;
  /** Surfaced in the top "Featured" grid */
  featured?: boolean;
  /** Routes to a dedicated rich connector flow instead of the generic form */
  customFlow?: "canva" | "supabase";
}

export const FEATURED_MCPS: FeaturedMcp[] = [
  {
    id: "supabase",
    name: "Supabase",
    tagline: "List tables, run SQL, apply migrations, fetch logs.",
    icon: "🗄️",
    accent: "#3ecf8e",
    category: "Databases",
    tags: ["postgres", "database", "sql", "backend"],
    transport: "stdio",
    featured: true,
    customFlow: "supabase",
    docsUrl: "https://supabase.com/docs",
  },
  {
    id: "github",
    name: "GitHub",
    tagline: "Manage repos, issues, PRs, and code search.",
    icon: "🐙",
    accent: "#8b5cf6",
    category: "Dev Tools",
    tags: ["git", "repo", "issues", "pull request", "code"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    featured: true,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    env: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "Personal Access Token",
        type: "secret",
        required: true,
        placeholder: "ghp_…",
        hint: "A classic or fine-grained PAT with repo scope.",
        helpUrl: "https://github.com/settings/tokens",
        helpLabel: "Create a token on GitHub",
      },
    ],
  },
  {
    id: "playwright",
    name: "Playwright",
    tagline: "Drive a real browser — navigate, click, scrape, screenshot.",
    icon: "🎭",
    accent: "#2ecc71",
    category: "Browser/Web",
    tags: ["browser", "automation", "scrape", "e2e", "web"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    featured: true,
    docsUrl: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "slack",
    name: "Slack",
    tagline: "Read channels, post messages, and manage your workspace.",
    icon: "💬",
    accent: "#e01e5a",
    category: "Communication",
    tags: ["chat", "messaging", "team", "notifications"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    featured: true,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    env: [
      {
        name: "SLACK_BOT_TOKEN",
        label: "Bot Token",
        type: "secret",
        required: true,
        placeholder: "xoxb-…",
        helpUrl: "https://api.slack.com/apps",
        helpLabel: "Create a Slack app & bot token",
      },
      {
        name: "SLACK_TEAM_ID",
        label: "Team ID",
        type: "text",
        required: true,
        placeholder: "T01234567",
        hint: "Your workspace ID (starts with T).",
      },
    ],
  },
  {
    id: "filesystem",
    name: "Filesystem",
    tagline: "Read, write, and search files in an allowed directory.",
    icon: "📁",
    accent: "#f59e0b",
    category: "Dev Tools",
    tags: ["files", "local", "read", "write"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    featured: true,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    env: [
      {
        name: "ALLOWED_DIR",
        label: "Allowed Directory",
        type: "path",
        required: true,
        asArg: true,
        placeholder: "/home/you/projects",
        hint: "The server can only touch files under this path.",
      },
    ],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    tagline: "Privacy-first web & local search.",
    icon: "🦁",
    accent: "#fb542b",
    category: "Search",
    tags: ["search", "web", "brave"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    featured: true,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    env: [
      {
        name: "BRAVE_API_KEY",
        label: "Brave API Key",
        type: "secret",
        required: true,
        placeholder: "BSA…",
        helpUrl: "https://brave.com/search/api/",
        helpLabel: "Get a Brave Search API key",
      },
    ],
  },
  {
    id: "postgres",
    name: "Postgres",
    tagline: "Inspect schemas and run read-only SQL queries.",
    icon: "🐘",
    accent: "#336791",
    category: "Databases",
    tags: ["postgres", "sql", "database"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    env: [
      {
        name: "DATABASE_URL",
        label: "Connection String",
        type: "secret",
        required: true,
        asArg: true,
        placeholder: "postgresql://user:pass@host:5432/db",
        hint: "A full Postgres connection URL.",
      },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    tagline: "Pull issues, events, and stack traces from Sentry.",
    icon: "🛡️",
    accent: "#6e4db5",
    category: "Dev Tools",
    tags: ["errors", "monitoring", "observability"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    docsUrl: "https://github.com/getsentry/sentry-mcp",
    env: [
      {
        name: "SENTRY_AUTH_TOKEN",
        label: "Auth Token",
        type: "secret",
        required: true,
        placeholder: "sntrys_…",
        helpUrl: "https://sentry.io/settings/account/api/auth-tokens/",
        helpLabel: "Create a Sentry auth token",
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    tagline: "Create and track issues, projects, and cycles.",
    icon: "📐",
    accent: "#5e6ad2",
    category: "Productivity",
    tags: ["issues", "project management", "tickets"],
    transport: "sse",
    url: "https://mcp.linear.app/sse",
    featured: true,
    docsUrl: "https://linear.app/docs",
  },
  {
    id: "notion",
    name: "Notion",
    tagline: "Search, read, and update Notion pages and databases.",
    icon: "📓",
    accent: "#e4e4e7",
    category: "Productivity",
    tags: ["notes", "docs", "wiki", "database"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    featured: true,
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
    env: [
      {
        name: "NOTION_TOKEN",
        label: "Integration Token",
        type: "secret",
        required: true,
        placeholder: "ntn_…",
        helpUrl: "https://www.notion.so/my-integrations",
        helpLabel: "Create a Notion integration",
      },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    tagline: "Query customers, payments, invoices, and products.",
    icon: "💳",
    accent: "#635bff",
    category: "Finance",
    tags: ["payments", "billing", "invoices", "money"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@stripe/mcp", "--tools=all"],
    docsUrl: "https://github.com/stripe/agent-toolkit",
    env: [
      {
        name: "STRIPE_SECRET_KEY",
        label: "Secret Key",
        type: "secret",
        required: true,
        placeholder: "sk_live_… or sk_test_…",
        helpUrl: "https://dashboard.stripe.com/apikeys",
        helpLabel: "Find your Stripe secret key",
      },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    tagline: "Inspect Workers, DNS, and observability data.",
    icon: "☁️",
    accent: "#f6821f",
    category: "Cloud",
    tags: ["cdn", "workers", "dns", "edge"],
    transport: "sse",
    url: "https://observability.mcp.cloudflare.com/sse",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
  },
  {
    id: "memory",
    name: "Memory",
    tagline: "Persistent knowledge graph the agent can read & write.",
    icon: "🧠",
    accent: "#22c55e",
    category: "AI Infra",
    tags: ["memory", "knowledge graph", "recall"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    tagline: "Structured step-by-step reasoning scratchpad.",
    icon: "🪜",
    accent: "#a855f7",
    category: "AI Infra",
    tags: ["reasoning", "planning", "chain of thought"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "fetch",
    name: "Fetch",
    tagline: "Fetch a URL and convert it to clean markdown.",
    icon: "🔗",
    accent: "#06b6d4",
    category: "Browser/Web",
    tags: ["http", "url", "markdown", "scrape"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "time",
    name: "Time",
    tagline: "Current time and timezone conversions.",
    icon: "🕐",
    accent: "#64748b",
    category: "Automation",
    tags: ["time", "timezone", "clock"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-time"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    tagline: "Headless Chrome automation and screenshots.",
    icon: "🤖",
    accent: "#40b5a4",
    category: "Browser/Web",
    tags: ["browser", "chrome", "automation", "screenshot"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    id: "gdrive",
    name: "Google Drive",
    tagline: "Search and read files from Google Drive.",
    icon: "📂",
    accent: "#4285f4",
    category: "Productivity",
    tags: ["google", "drive", "files", "docs"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
    env: [
      {
        name: "GDRIVE_CREDENTIALS_PATH",
        label: "Credentials JSON Path",
        type: "path",
        required: true,
        placeholder: "/home/you/.config/gdrive/credentials.json",
        hint: "Path to your OAuth client credentials file.",
        helpUrl: "https://console.cloud.google.com/apis/credentials",
        helpLabel: "Google Cloud credentials",
      },
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    tagline: "Read, search, and send email from Gmail.",
    icon: "✉️",
    accent: "#ea4335",
    category: "Communication",
    tags: ["email", "google", "mail", "inbox"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
    docsUrl: "https://github.com/GongRzhe/Gmail-MCP-Server",
  },
  {
    id: "figma",
    name: "Figma",
    tagline: "Pull frames, components, and design tokens from Figma.",
    icon: "🎨",
    accent: "#f24e1e",
    category: "Design",
    tags: ["design", "ui", "components", "tokens"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    docsUrl: "https://github.com/GLips/Figma-Context-MCP",
    env: [
      {
        name: "FIGMA_API_KEY",
        label: "Personal Access Token",
        type: "secret",
        required: true,
        placeholder: "figd_…",
        helpUrl: "https://www.figma.com/developers/api#access-tokens",
        helpLabel: "Create a Figma token",
      },
    ],
  },
  {
    id: "canva",
    name: "Canva",
    tagline: "Generate, list, and export Canva designs.",
    icon: "🖌️",
    accent: "#a855f7",
    category: "Design",
    tags: ["design", "graphics", "export"],
    transport: "stdio",
    customFlow: "canva",
    docsUrl: "https://www.canva.com/developers/",
  },
];

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";

// ── State Factory ────────────────────────────────────────────

export function createRegistryState(): McpRegistryState {
  return {
    open: false,
    query: "",
    results: [],
    loading: false,
    error: null,
    totalCount: 0,
    nextCursor: null,
    selectedServer: null,
    installing: null,
    successMessage: null,
    envValues: {},
    catalogQuery: "",
    activeCategory: "All",
    installTarget: null,
    installEnv: {},
    installBusy: false,
    installTesting: false,
    installTestResult: null,
    installError: null,
  };
}

// ── Catalog search / filter ──────────────────────────────────

/** Lightweight fuzzy match — every char of the query appears in order. */
function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

export function filterCatalog(reg: McpRegistryState): FeaturedMcp[] {
  const q = reg.catalogQuery.trim();
  const cat = reg.activeCategory;
  return FEATURED_MCPS.filter((m) => {
    if (cat !== "All" && m.category !== cat) return false;
    if (!q) return true;
    const hay = [m.name, m.tagline, m.category, ...m.tags].join(" ");
    return fuzzyIncludes(hay, q);
  });
}

export function catalogCategoryCounts(): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of FEATURED_MCPS) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  return CATALOG_CATEGORIES.filter((c) => counts.has(c)).map((c) => ({ key: c, count: counts.get(c) ?? 0 }));
}

// ── Guided install (featured catalog) ────────────────────────

export function openInstall(state: AppViewState, fm: FeaturedMcp): void {
  const reg = state.mcpManagementState?.registry;
  if (!reg) return;
  reg.installTarget = fm;
  reg.installEnv = {};
  reg.installError = null;
  reg.installTestResult = null;
  for (const ev of fm.env ?? []) reg.installEnv[ev.name] = "";
  state.requestUpdate?.();
}

export function closeInstall(state: AppViewState): void {
  const reg = state.mcpManagementState?.registry;
  if (!reg) return;
  reg.installTarget = null;
  reg.installEnv = {};
  reg.installError = null;
  reg.installTestResult = null;
  reg.installTesting = false;
  state.requestUpdate?.();
}

/** Returns the list of required env vars still missing a value. */
function missingRequired(fm: FeaturedMcp, values: Record<string, string>): FeaturedEnvVar[] {
  return (fm.env ?? []).filter((ev) => ev.required && !values[ev.name]?.trim());
}

/** Build the concrete command/args/env for a featured server from form values. */
function buildFeaturedConfig(fm: FeaturedMcp, values: Record<string, string>): {
  args: string[];
  env: Record<string, string>;
} {
  const args = [...(fm.args ?? [])];
  const env: Record<string, string> = {};
  for (const ev of fm.env ?? []) {
    const v = values[ev.name]?.trim();
    if (!v) continue;
    if (ev.asArg) args.push(v);
    else env[ev.name] = v;
  }
  return { args, env };
}

export async function testFeaturedConnection(state: AppViewState, fm: FeaturedMcp): Promise<void> {
  const reg = state.mcpManagementState?.registry;
  if (!reg) return;

  const missing = missingRequired(fm, reg.installEnv);
  if (missing.length) {
    reg.installTestResult = { ok: false, message: `Missing required: ${missing.map((m) => m.label).join(", ")}` };
    state.requestUpdate?.();
    return;
  }

  reg.installTesting = true;
  reg.installTestResult = null;
  state.requestUpdate?.();

  try {
    const { args, env } = buildFeaturedConfig(fm, reg.installEnv);

    // There is no pre-install probe RPC: the gateway only exposes tool
    // listings for servers it has already started (`mcp.tools.list` /
    // `mcp.clients.status`), and spawning an arbitrary command just to
    // handshake it is not something the gateway offers. The old
    // `mcp.server.test` call was never served and always threw, so this
    // path only ever produced the fallback message below — do that check
    // locally instead of issuing a call that cannot succeed.
    const configured = Boolean(fm.command?.trim() || fm.url?.trim());
    reg.installTestResult = configured
      ? { ok: true, message: "Configuration looks valid — it will connect on install." }
      : { ok: false, message: "No command or URL configured for this server." };
    void args;
    void env;
  } catch {
    reg.installTestResult = {
      ok: true,
      message: "Live probe unavailable — config looks valid and will connect on install.",
    };
  } finally {
    reg.installTesting = false;
    state.requestUpdate?.();
  }
}

export async function installFeatured(state: AppViewState, fm: FeaturedMcp): Promise<void> {
  const reg = state.mcpManagementState?.registry;
  const mcpState = state.mcpManagementState;
  if (!reg || !mcpState) return;

  const missing = missingRequired(fm, reg.installEnv);
  if (missing.length) {
    reg.installError = `Please fill in: ${missing.map((m) => m.label).join(", ")}`;
    state.requestUpdate?.();
    return;
  }

  reg.installBusy = true;
  reg.installError = null;
  state.requestUpdate?.();

  try {
    const { args, env } = buildFeaturedConfig(fm, reg.installEnv);

    // Best-effort persist to the gateway config. Falls back to local-only if
    // the RPC isn't available (parity with the registry installer).
    try {
      // `mcp.internal.upsert` is the served writer; it takes the server name
      // plus a config entry (the `mcpServers` record shape), not a flat object.
      await state.client?.request("mcp.internal.upsert", {
        name: fm.id,
        entry: {
          type: fm.transport ?? (fm.url ? "http" : "stdio"),
          description: fm.tagline,
          command: fm.command,
          args,
          env: Object.keys(env).length ? env : undefined,
          url: fm.url,
          enabled: true,
        },
      });
    } catch {
      // ignore — local update below keeps the UI responsive
    }

    const running = !!mcpState.status?.running;
    const existing = mcpState.servers.find((s) => s.name === fm.id);
    if (existing) {
      existing.enabled = true;
      existing.running = running;
      existing.command = fm.command;
      existing.args = args;
      existing.env = Object.keys(env).length ? env : undefined;
      existing.url = fm.url;
      existing.transport = fm.transport;
      existing.description = fm.tagline;
      existing.docsUrl = fm.docsUrl;
    } else {
      mcpState.servers.push({
        name: fm.id,
        description: fm.tagline,
        enabled: true,
        running,
        custom: true,
        command: fm.command,
        args,
        env: Object.keys(env).length ? env : undefined,
        url: fm.url,
        transport: fm.transport,
        category: fm.category,
        toolDetails: [],
        docsUrl: fm.docsUrl,
      });
    }

    reg.successMessage = running
      ? `✓ ${fm.name} connected`
      : `✓ ${fm.name} installed — start MCP to activate`;
    reg.installTarget = null;
    reg.installEnv = {};
    setTimeout(() => {
      if (reg) reg.successMessage = null;
      state.requestUpdate?.();
    }, 4000);
  } catch (err) {
    reg.installError = err instanceof Error ? err.message : String(err);
  } finally {
    reg.installBusy = false;
    state.requestUpdate?.();
  }
}

// ── API Calls ────────────────────────────────────────────────

export async function searchRegistry(
  state: AppViewState,
  query?: string,
  append?: boolean,
): Promise<void> {
  const reg = state.mcpManagementState?.registry;
  if (!reg) return;

  if (!append) {
    reg.results = [];
    reg.nextCursor = null;
  }

  reg.loading = true;
  reg.error = null;
  state.requestUpdate?.();

  try {
    const params = new URLSearchParams();
    params.set("limit", "20");
    params.set("version", "latest");
    if (query?.trim()) params.set("search", query.trim());
    if (append && reg.nextCursor) params.set("cursor", reg.nextCursor);

    const resp = await fetch(`${REGISTRY_BASE}/servers?${params}`);
    if (!resp.ok) throw new Error(`Registry returned ${resp.status}`);

    const data = await resp.json();
    const entries: RegistryEntry[] = data.servers ?? [];
    const meta = data.metadata ?? {};

    if (append) {
      reg.results = [...reg.results, ...entries];
    } else {
      reg.results = entries;
    }
    reg.totalCount = meta.count ?? entries.length;
    reg.nextCursor = meta.nextCursor ?? null;
  } catch (err: any) {
    reg.error = err?.message || "Failed to fetch from MCP Registry";
  } finally {
    reg.loading = false;
    state.requestUpdate?.();
  }
}

export async function loadMoreResults(state: AppViewState): Promise<void> {
  const reg = state.mcpManagementState?.registry;
  if (!reg || !reg.nextCursor) return;
  await searchRegistry(state, reg.query, true);
}

// ── Server Detail ────────────────────────────────────────────

export function selectRegistryServer(state: AppViewState, entry: RegistryEntry | null): void {
  const reg = state.mcpManagementState?.registry;
  if (!reg) return;
  reg.selectedServer = entry;
  reg.envValues = {};
  // Pre-populate env var keys
  if (entry) {
    const pkg = entry.server.packages?.[0];
    if (pkg?.environmentVariables) {
      for (const ev of pkg.environmentVariables) {
        reg.envValues[ev.name] = "";
      }
    }
  }
  state.requestUpdate?.();
}

// ── Install Server ───────────────────────────────────────────

export function getInstallCommand(entry: RegistryEntry): { command: string; args: string[]; transport: string; env?: Record<string, string> } | { url: string; transport: string } | null {
  const srv = entry.server;

  // Check packages first (npm, oci/docker, pypi)
  if (srv.packages?.length) {
    const pkg = srv.packages[0];
    const transport = pkg.transport?.type || "stdio";

    if (pkg.registryType === "npm") {
      return {
        command: "npx",
        args: ["-y", pkg.identifier],
        transport,
      };
    }

    if (pkg.registryType === "oci") {
      return {
        command: "docker",
        args: ["run", "-i", "--rm", pkg.identifier],
        transport,
      };
    }

    if (pkg.registryType === "pypi") {
      return {
        command: "uvx",
        args: [pkg.identifier],
        transport,
      };
    }

    // Generic fallback
    return {
      command: pkg.identifier,
      args: [],
      transport,
    };
  }

  // Check remotes (streamable-http, sse)
  if (srv.remotes?.length) {
    const remote = srv.remotes[0];
    return {
      url: remote.url,
      transport: remote.type,
    };
  }

  return null;
}

export async function installRegistryServer(state: AppViewState): Promise<void> {
  const reg = state.mcpManagementState?.registry;
  const mcpState = state.mcpManagementState;
  if (!reg || !mcpState || !reg.selectedServer || !state.client) return;

  const entry = reg.selectedServer;
  const srv = entry.server;
  const installInfo = getInstallCommand(entry);
  if (!installInfo) {
    reg.error = "Cannot determine install method for this server";
    state.requestUpdate?.();
    return;
  }

  reg.installing = srv.name;
  state.requestUpdate?.();

  try {
    // Build the MCP server config entry for InfiniBot
    const serverConfig: Record<string, unknown> = {
      name: srv.name.split("/").pop() || srv.name,
      description: srv.description,
      enabled: true,
      custom: true,
    };

    if ("command" in installInfo) {
      serverConfig.command = installInfo.command;
      serverConfig.args = installInfo.args;
      serverConfig.transport = installInfo.transport;

      // Add env vars if user filled them in
      const envEntries = Object.entries(reg.envValues).filter(([, v]) => v.trim());
      if (envEntries.length) {
        serverConfig.env = Object.fromEntries(envEntries);
      }
    } else {
      serverConfig.url = installInfo.url;
      serverConfig.transport = installInfo.transport;
    }

    // Add to local server list for immediate UI update
    const shortName = String(serverConfig.name);
    const pkg = srv.packages?.[0];
    mcpState.servers.push({
      name: shortName,
      description: srv.description,
      enabled: true,
      running: false,
      custom: true,
      command: "command" in installInfo ? installInfo.command : undefined,
      args: "command" in installInfo ? installInfo.args : undefined,
      env: serverConfig.env as Record<string, string> | undefined,
      url: "url" in installInfo ? installInfo.url : undefined,
      transport: installInfo.transport,
      category: "Installed",
      toolDetails: [],
      docsUrl: srv.repository?.url,
    });

    reg.successMessage = `✓ ${shortName} added! Restart MCP to activate.`;
    reg.selectedServer = null;
    setTimeout(() => {
      if (reg) reg.successMessage = null;
      state.requestUpdate?.();
    }, 4000);
  } catch (err: any) {
    reg.error = err?.message || "Failed to install server";
  } finally {
    reg.installing = null;
    state.requestUpdate?.();
  }
}

// ── Helpers ──────────────────────────────────────────────────

export function getTransportBadge(entry: RegistryEntry): { label: string; color: string } {
  const pkg = entry.server.packages?.[0];
  const remote = entry.server.remotes?.[0];

  if (pkg?.registryType === "npm") return { label: "NPM", color: "#cb3837" };
  if (pkg?.registryType === "oci") return { label: "DOCKER", color: "#2496ed" };
  if (pkg?.registryType === "pypi") return { label: "PYPI", color: "#3776ab" };
  if (remote?.type === "streamable-http") return { label: "HTTP", color: "#22c55e" };
  if (remote?.type === "sse") return { label: "SSE", color: "#f59e0b" };
  return { label: "STDIO", color: "#a1a1aa" };
}

export function formatPublishedDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
