import type { InfinibotConfig } from "./config.js";
import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "./paths.js";
import {
  getChatChannelMeta,
  listChatChannels,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
} from "../channels/plugins/catalog.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { hasAnyWhatsAppAuth } from "../web/accounts.js";

type PluginEnableChange = {
  pluginId: string;
  reason: string;
};

export type PluginAutoEnableResult = {
  config: InfinibotConfig;
  changes: string[];
};

const CHANNEL_PLUGIN_IDS = Array.from(
  new Set([
    ...listChatChannels().map((meta) => meta.id),
    ...listChannelPluginCatalogEntries().map((entry) => entry.id),
  ]),
);

const PROVIDER_PLUGIN_IDS: Array<{ pluginId: string; providerId: string }> = [
  { pluginId: "google-antigravity-auth", providerId: "google-antigravity" },
  { pluginId: "google-gemini-cli-auth", providerId: "google-gemini-cli" },
  { pluginId: "qwen-portal-auth", providerId: "qwen-portal" },
  { pluginId: "copilot-proxy", providerId: "copilot-proxy" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function recordHasKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function accountsHaveKeys(value: unknown, keys: string[]): boolean {
  if (!isRecord(value)) return false;
  for (const account of Object.values(value)) {
    if (!isRecord(account)) continue;
    for (const key of keys) {
      if (hasNonEmptyString(account[key])) return true;
    }
  }
  return false;
}

function resolveChannelConfig(
  cfg: InfinibotConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

function isTelegramConfigured(cfg: InfinibotConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasNonEmptyString(env.TELEGRAM_BOT_TOKEN)) return true;
  const entry = resolveChannelConfig(cfg, "telegram");
  if (!entry) return false;
  if (hasNonEmptyString(entry.botToken) || hasNonEmptyString(entry.tokenFile)) return true;
  if (accountsHaveKeys(entry.accounts, ["botToken", "tokenFile"])) return true;
  return recordHasKeys(entry);
}

function isDiscordConfigured(cfg: InfinibotConfig, env: NodeJS.ProcessEnv): boolean {
  if (hasNonEmptyString(env.DISCORD_BOT_TOKEN)) return true;
  const entry = resolveChannelConfig(cfg, "discord");
  if (!entry) return false;
  if (hasNonEmptyString(entry.token)) return true;
  if (accountsHaveKeys(entry.accounts, ["token"])) return true;
  return recordHasKeys(entry);
}

function isSlackConfigured(cfg: InfinibotConfig, env: NodeJS.ProcessEnv): boolean {
  if (
    hasNonEmptyString(env.SLACK_BOT_TOKEN) ||
    hasNonEmptyString(env.SLACK_APP_TOKEN) ||
    hasNonEmptyString(env.SLACK_USER_TOKEN)
  ) {
    return true;
  }
  const entry = resolveChannelConfig(cfg, "slack");
  if (!entry) return false;
  if (
    hasNonEmptyString(entry.botToken) ||
    hasNonEmptyString(entry.appToken) ||
    hasNonEmptyString(entry.userToken)
  ) {
    return true;
  }
  if (accountsHaveKeys(entry.accounts, ["botToken", "appToken", "userToken"])) return true;
  return recordHasKeys(entry);
}

function isSignalConfigured(cfg: InfinibotConfig): boolean {
  const entry = resolveChannelConfig(cfg, "signal");
  if (!entry) return false;
  if (
    hasNonEmptyString(entry.account) ||
    hasNonEmptyString(entry.httpUrl) ||
    hasNonEmptyString(entry.httpHost) ||
    typeof entry.httpPort === "number" ||
    hasNonEmptyString(entry.cliPath)
  ) {
    return true;
  }
  if (accountsHaveKeys(entry.accounts, ["account", "httpUrl", "httpHost", "cliPath"])) return true;
  return recordHasKeys(entry);
}

function isIMessageConfigured(cfg: InfinibotConfig): boolean {
  const entry = resolveChannelConfig(cfg, "imessage");
  if (!entry) return false;
  if (hasNonEmptyString(entry.cliPath)) return true;
  return recordHasKeys(entry);
}

function isWhatsAppConfigured(cfg: InfinibotConfig): boolean {
  if (hasAnyWhatsAppAuth(cfg)) return true;
  const entry = resolveChannelConfig(cfg, "whatsapp");
  if (!entry) return false;
  return recordHasKeys(entry);
}

function isGenericChannelConfigured(cfg: InfinibotConfig, channelId: string): boolean {
  const entry = resolveChannelConfig(cfg, channelId);
  return recordHasKeys(entry);
}

export function isChannelConfigured(
  cfg: InfinibotConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (channelId) {
    case "whatsapp":
      return isWhatsAppConfigured(cfg);
    case "telegram":
      return isTelegramConfigured(cfg, env);
    case "discord":
      return isDiscordConfigured(cfg, env);
    case "slack":
      return isSlackConfigured(cfg, env);
    case "signal":
      return isSignalConfigured(cfg);
    case "imessage":
      return isIMessageConfigured(cfg);
    default:
      return isGenericChannelConfigured(cfg, channelId);
  }
}

function collectModelRefs(cfg: InfinibotConfig): string[] {
  const refs: string[] = [];
  const pushModelRef = (value: unknown) => {
    if (typeof value === "string" && value.trim()) refs.push(value.trim());
  };
  const collectFromAgent = (agent: Record<string, unknown> | null | undefined) => {
    if (!agent) return;
    const model = agent.model;
    if (typeof model === "string") {
      pushModelRef(model);
    } else if (isRecord(model)) {
      pushModelRef(model.primary);
      const fallbacks = model.fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const entry of fallbacks) pushModelRef(entry);
      }
    }
    const models = agent.models;
    if (isRecord(models)) {
      for (const key of Object.keys(models)) {
        pushModelRef(key);
      }
    }
  };

  const defaults = cfg.agents?.defaults as Record<string, unknown> | undefined;
  collectFromAgent(defaults);

  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecord(entry)) collectFromAgent(entry);
    }
  }
  return refs;
}

function extractProviderFromModelRef(value: string): string | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return normalizeProviderId(trimmed.slice(0, slash));
}

function isProviderConfigured(cfg: InfinibotConfig, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);

  const profiles = cfg.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (!isRecord(profile)) continue;
      const provider = normalizeProviderId(String(profile.provider ?? ""));
      if (provider === normalized) return true;
    }
  }

  const providerConfig = cfg.models?.providers;
  if (providerConfig && typeof providerConfig === "object") {
    for (const key of Object.keys(providerConfig)) {
      if (normalizeProviderId(key) === normalized) return true;
    }
  }

  const modelRefs = collectModelRefs(cfg);
  for (const ref of modelRefs) {
    const provider = extractProviderFromModelRef(ref);
    if (provider && provider === normalized) return true;
  }

  return false;
}

function resolveConfiguredPlugins(
  cfg: InfinibotConfig,
  env: NodeJS.ProcessEnv,
  stateDir?: string,
  extraStateDirs: string[] = [],
  hostedChannels: string[] = [],
): PluginEnableChange[] {
  const changes: PluginEnableChange[] = [];
  // Hosted fleet Machine whose plan runs channels: the tenant's channel tokens
  // live in its namespace, not this config, so enable the channel plugins it
  // may use up front (a channel connected later then starts without a restart).
  for (const pluginId of hostedChannels) {
    changes.push({ pluginId, reason: `${pluginId} hosted for this workspace` });
  }
  const channelIds = new Set(CHANNEL_PLUGIN_IDS);
  const configuredChannels = cfg.channels as Record<string, unknown> | undefined;
  if (configuredChannels && typeof configuredChannels === "object") {
    for (const key of Object.keys(configuredChannels)) {
      if (key === "defaults") continue;
      channelIds.add(key);
    }
  }
  for (const channelId of channelIds) {
    if (!channelId) continue;
    if (isChannelConfigured(cfg, channelId, env)) {
      changes.push({
        pluginId: channelId,
        reason: `${channelId} configured`,
      });
    }
  }
  for (const mapping of PROVIDER_PLUGIN_IDS) {
    if (isProviderConfigured(cfg, mapping.providerId)) {
      changes.push({
        pluginId: mapping.pluginId,
        reason: `${mapping.providerId} auth configured`,
      });
    }
  }
  if ([...(stateDir ? [stateDir] : []), ...extraStateDirs].some(hasExistingProductsData)) {
    changes.push({
      pluginId: "products",
      reason: "existing Products catalog or portfolio data found",
    });
  }
  const whiteboardStateDir = stateDir ?? resolveStateDir(env);
  const hasScenes = (dir: string) => {
    try {
      return readdirSync(dir).some((name) => name.endsWith(".excalidraw"));
    } catch {
      return false;
    }
  };
  if (
    [whiteboardStateDir, ...extraStateDirs].some(
      (dir) =>
        hasScenes(join(dir, "files", "whiteboards")) ||
        hasScenes(join(dir, "plugin-data", "whiteboard", "boards")),
    )
  ) {
    changes.push({ pluginId: "whiteboard", reason: "existing whiteboard data found" });
  }
  if (hasMonsoonStudioProjects(env)) {
    changes.push({ pluginId: "monsoon-studio", reason: "local Monsoon studio projects found" });
  }
  return changes;
}

/**
 * Product Studio (monsoon-studio) turns on once the local studio server has
 * stored a project, so installing the studio + one gateway restart activates
 * the page and tools. Only explicit env/HOME paths are checked (deterministic
 * in tests; hosted fleet Machines have no studio store).
 */
export function hasMonsoonStudioProjects(env: NodeJS.ProcessEnv): boolean {
  const root =
    env.MONSOON_STUDIO_DATA_DIR?.trim() ||
    env.STUDIO_DATA_DIR?.trim() ||
    (env.HOME ? join(env.HOME, ".local", "share", "monsoon-studio") : "");
  if (!root) return false;
  try {
    return readdirSync(join(root, "projects")).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** Read-only migration detector: schemas/empty seed databases do not count. */
export function hasExistingProductsData(stateDir: string): boolean {
  const candidates = [
    {
      file: join(stateDir, "plugin-data", "products", "portfolio.db"),
      query: "SELECT 1 FROM products LIMIT 1",
    },
    { file: join(stateDir, "product.db"), query: "SELECT 1 FROM products LIMIT 1" },
    {
      file: join(stateDir, "databases.db"),
      query: `SELECT 1 FROM database_rows WHERE database_id IN (
        SELECT database_id FROM system_databases WHERE role = 'products'
        UNION SELECT database_id FROM business_role_databases WHERE role = 'products'
      ) LIMIT 1`,
    },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) continue;
    try {
      const db = new Database(candidate.file, { readonly: true, fileMustExist: true });
      const found = Boolean(db.prepare(candidate.query).get());
      db.close();
      if (found) return true;
    } catch {
      // A missing legacy table or an unreadable DB is not evidence of data.
    }
  }
  return false;
}

function isPluginExplicitlyDisabled(cfg: InfinibotConfig, pluginId: string): boolean {
  const entry = cfg.plugins?.entries?.[pluginId];
  return entry?.enabled === false;
}

function isPluginDenied(cfg: InfinibotConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

function resolvePreferredOverIds(pluginId: string): string[] {
  const normalized = normalizeChatChannelId(pluginId);
  if (normalized) {
    return getChatChannelMeta(normalized).preferOver ?? [];
  }
  const catalogEntry = getChannelPluginCatalogEntry(pluginId);
  return catalogEntry?.meta.preferOver ?? [];
}

function shouldSkipPreferredPluginAutoEnable(
  cfg: InfinibotConfig,
  entry: PluginEnableChange,
  configured: PluginEnableChange[],
): boolean {
  for (const other of configured) {
    if (other.pluginId === entry.pluginId) continue;
    if (isPluginDenied(cfg, other.pluginId)) continue;
    if (isPluginExplicitlyDisabled(cfg, other.pluginId)) continue;
    const preferOver = resolvePreferredOverIds(other.pluginId);
    if (preferOver.includes(entry.pluginId)) {
      return true;
    }
  }
  return false;
}

function ensureAllowlisted(cfg: InfinibotConfig, pluginId: string): InfinibotConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) return cfg;
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}

function enablePluginEntry(cfg: InfinibotConfig, pluginId: string): InfinibotConfig {
  const entries = {
    ...cfg.plugins?.entries,
    [pluginId]: {
      ...(cfg.plugins?.entries?.[pluginId] as Record<string, unknown> | undefined),
      enabled: true,
    },
  };
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
      ...(cfg.plugins?.enabled === false ? { enabled: true } : {}),
    },
  };
}

function formatAutoEnableChange(entry: PluginEnableChange): string {
  let reason = entry.reason.trim();
  const channelId = normalizeChatChannelId(entry.pluginId);
  if (channelId) {
    const label = getChatChannelMeta(channelId).label;
    reason = reason.replace(new RegExp(`^${channelId}\\b`, "i"), label);
  }
  return `${reason}, not enabled yet.`;
}

export function applyPluginAutoEnable(params: {
  config: InfinibotConfig;
  env?: NodeJS.ProcessEnv;
  /** Explicit for deterministic tests; gateway startup passes its state dir. */
  stateDir?: string;
  /** More per-user state dirs to check for data (hosted fleet tenant dirs). */
  extraStateDirs?: string[];
  /** Channel plugins a hosted fleet Machine runs for its tenant (src/saas/fleet-channels.ts). */
  hostedChannels?: string[];
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const configured = resolveConfiguredPlugins(
    params.config,
    env,
    params.stateDir,
    params.extraStateDirs,
    params.hostedChannels,
  );
  if (configured.length === 0) {
    return { config: params.config, changes: [] };
  }

  let next = params.config;
  const changes: string[] = [];

  if (next.plugins?.enabled === false) {
    return { config: next, changes };
  }

  for (const entry of configured) {
    if (isPluginDenied(next, entry.pluginId)) continue;
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) continue;
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured)) continue;
    const allow = next.plugins?.allow;
    const allowMissing = Array.isArray(allow) && !allow.includes(entry.pluginId);
    const alreadyEnabled = next.plugins?.entries?.[entry.pluginId]?.enabled === true;
    if (alreadyEnabled && !allowMissing) continue;
    next = enablePluginEntry(next, entry.pluginId);
    next = ensureAllowlisted(next, entry.pluginId);
    changes.push(formatAutoEnableChange(entry));
  }

  return { config: next, changes };
}
