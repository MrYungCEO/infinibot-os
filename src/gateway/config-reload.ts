import chokidar from "chokidar";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { InfinibotConfig, ConfigFileSnapshot, GatewayReloadMode } from "../config/config.js";

export type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  restartGmailWatcher: boolean;
  restartBrowserControl: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  restartChannels: Set<ChannelKind>;
  noopPaths: string[];
};

type ReloadRule = {
  prefix: string;
  kind: "restart" | "hot" | "none";
  actions?: ReloadAction[];
};

type ReloadAction =
  | "reload-hooks"
  | "restart-gmail-watcher"
  | "restart-browser-control"
  | "restart-cron"
  | "restart-heartbeat"
  | `restart-channel:${ChannelId}`;

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};

const BASE_RELOAD_RULES: ReloadRule[] = [
  { prefix: "gateway.remote", kind: "none" },
  { prefix: "gateway.reload", kind: "none" },
  { prefix: "hooks.gmail", kind: "hot", actions: ["restart-gmail-watcher"] },
  { prefix: "hooks", kind: "hot", actions: ["reload-hooks"] },
  {
    prefix: "agents.defaults.heartbeat",
    kind: "hot",
    actions: ["restart-heartbeat"],
  },
  { prefix: "agent.heartbeat", kind: "hot", actions: ["restart-heartbeat"] },
  { prefix: "cron", kind: "hot", actions: ["restart-cron"] },
  {
    prefix: "browser",
    kind: "hot",
    actions: ["restart-browser-control"],
  },
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  // meta.lastTouchedAt is bumped on EVERY config write (stampConfigVersion
  // in io.ts). Without this rule the bookkeeping timestamp falls through
  // to "unknown → restart", which closes every WebSocket every time the
  // gateway saves the config — including writes the gateway initiates
  // itself (notion import commit, quickstart, etc). Pure bookkeeping,
  // never needs a restart.
  { prefix: "meta", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "models", kind: "none" },
  { prefix: "agents", kind: "none" },
  // Secure Mode policy knobs are read via loadConfig() on every run/RPC.
  { prefix: "secureMode", kind: "none" },
  // Subscription CLI routing is read from loadConfig() at every model resolution.
  { prefix: "cliRoutingEnabled", kind: "none" },
  { prefix: "cliRouting", kind: "none" },
  // The local runtime manager re-reads its registry on every acquire/RPC.
  { prefix: "localRuntimes", kind: "none" },
  { prefix: "tools", kind: "none" },
  { prefix: "bindings", kind: "none" },
  // Notion config is consumed dynamically — getNotionConfig() re-reads
  // infinibot.json on every call, and the import wizard writes to
  // notion.bindings as part of normal operation. Without this rule the
  // notion.* path falls through to "unknown → restart", which closes
  // every WebSocket mid-import (the operator's commit RPC response is
  // dropped along with the socket). Marking notion no-op lets the
  // gateway keep running while binding writes land.
  { prefix: "notion", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  // The landing plugin is read live by plugins.list — no restart needed.
  { prefix: "plugins.landing", kind: "none" },
  // Package bookkeeping (install records, registry URL, update-check
  // settings): the plugins.* package RPCs restart the gateway themselves when
  // a LOADED plugin's files changed; a record on its own changes nothing.
  { prefix: "plugins.installs", kind: "none" },
  { prefix: "plugins.registryUrl", kind: "none" },
  { prefix: "plugins.updates", kind: "none" },
  { prefix: "plugins", kind: "restart" },
  // Voice-provider selection is re-read on every voice request.
  { prefix: "voice.backend", kind: "none" },
  // Voice endpoints (kokoroUrl / speachesUrl / livekitUrl, written by the
  // one-click local voice setup and the satellite auto-wire) are resolved per
  // request in server-voice-urls.ts — a restart would only drop every socket.
  { prefix: "voice", kind: "none" },
  // coder.* (default backend, per-backend models, artifact delivery) is read
  // via loadConfig() at each coder spawn; restarting would kill running
  // sub-agents just to switch the default in Setup › Coders.
  { prefix: "coder", kind: "none" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
  { prefix: "canvasHost", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function listReloadRules(): ReloadRule[] {
  const registry = getActivePluginRegistry();
  if (registry !== cachedRegistry) {
    cachedReloadRules = null;
    cachedRegistry = registry;
  }
  if (cachedReloadRules) return cachedReloadRules;
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    ...(plugin.reload?.configPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "hot",
        actions: [`restart-channel:${plugin.id}` as ReloadAction],
      }),
    ),
    ...(plugin.reload?.noopPrefixes ?? []).map(
      (prefix): ReloadRule => ({
        prefix,
        kind: "none",
      }),
    ),
  ]);
  const rules = [...BASE_RELOAD_RULES, ...channelReloadRules, ...BASE_RELOAD_RULES_TAIL];
  cachedReloadRules = rules;
  return rules;
}

/** Per-plugin choices the plugins.* RPCs apply in memory (src/plugins/host-state.ts). */
const PLUGIN_HOT_ENTRY_KEY =
  /^plugins\.entries\.[^.]+\.(appearance|contributions|permissions|autoUpdate)(\.|$)/;

function matchRule(path: string): ReloadRule | null {
  if (PLUGIN_HOT_ENTRY_KEY.test(path)) return { prefix: path, kind: "none" };
  for (const rule of listReloadRules()) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]",
  );
}

export function diffConfigPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (prev === next) return [];
  // A plugin entry appearing/disappearing: diff field by field so a new entry
  // holding only hot keys (appearance/contributions/permissions) stays hot.
  if (
    (prefix === "plugins" || prefix.startsWith("plugins.entries")) &&
    ((prev === undefined && isPlainObject(next)) || (isPlainObject(prev) && next === undefined))
  ) {
    return diffConfigPaths(prev ?? {}, next ?? {}, prefix);
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const paths: string[] = [];
    for (const key of keys) {
      const prevValue = prev[key];
      const nextValue = next[key];
      if (prevValue === undefined && nextValue === undefined) continue;
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      const childPaths = diffConfigPaths(prevValue, nextValue, childPrefix);
      if (childPaths.length > 0) {
        paths.push(...childPaths);
      }
    }
    return paths;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return [prefix || "<root>"];
    // Recurse: shallow === fails on reparsed objects (e.g. gmail account
    // entries), causing phantom diffs that restart the gateway on every
    // unrelated config write. Treat structurally-equal arrays as equal.
    for (let i = 0; i < prev.length; i++) {
      const childPaths = diffConfigPaths(prev[i], next[i], `${prefix}[${i}]`);
      if (childPaths.length > 0) return [prefix || "<root>"];
    }
    return [];
  }
  return [prefix || "<root>"];
}

export function resolveGatewayReloadSettings(cfg: InfinibotConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  const debounceRaw = cfg.gateway?.reload?.debounceMs;
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw)
      ? Math.max(0, Math.floor(debounceRaw))
      : DEFAULT_RELOAD_SETTINGS.debounceMs;
  return { mode, debounceMs };
}

export function buildGatewayReloadPlan(changedPaths: string[]): GatewayReloadPlan {
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartBrowserControl: false,
    restartCron: false,
    restartHeartbeat: false,
    restartChannels: new Set(),
    noopPaths: [],
  };

  const applyAction = (action: ReloadAction) => {
    if (action.startsWith("restart-channel:")) {
      const channel = action.slice("restart-channel:".length) as ChannelId;
      plan.restartChannels.add(channel);
      return;
    }
    switch (action) {
      case "reload-hooks":
        plan.reloadHooks = true;
        break;
      case "restart-gmail-watcher":
        plan.restartGmailWatcher = true;
        break;
      case "restart-browser-control":
        plan.restartBrowserControl = true;
        break;
      case "restart-cron":
        plan.restartCron = true;
        break;
      case "restart-heartbeat":
        plan.restartHeartbeat = true;
        break;
      default:
        break;
    }
  };

  for (const path of changedPaths) {
    const rule = matchRule(path);
    if (!rule) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "restart") {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (rule.kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule.actions ?? []) {
      applyAction(action);
    }
  }

  if (plan.restartGmailWatcher) {
    plan.reloadHooks = true;
  }

  return plan;
}

export type GatewayConfigReloader = {
  stop: () => Promise<void>;
};

export function startGatewayConfigReloader(opts: {
  initialConfig: InfinibotConfig;
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  onHotReload: (plan: GatewayReloadPlan, nextConfig: InfinibotConfig) => Promise<void>;
  onRestart: (plan: GatewayReloadPlan, nextConfig: InfinibotConfig) => void;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  watchPath: string;
}): GatewayConfigReloader {
  let currentConfig = opts.initialConfig;
  let settings = resolveGatewayReloadSettings(currentConfig);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let restartQueued = false;

  const schedule = () => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const wait = settings.debounceMs;
    debounceTimer = setTimeout(() => {
      void runReload();
    }, wait);
  };

  const runReload = async () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      const snapshot = await opts.readSnapshot();
      if (!snapshot.valid) {
        const issues = snapshot.issues.map((issue) => `${issue.path}: ${issue.message}`).join(", ");
        opts.log.warn(`config reload skipped (invalid config): ${issues}`);
        return;
      }
      const nextConfig = snapshot.config;
      const changedPaths = diffConfigPaths(currentConfig, nextConfig);
      currentConfig = nextConfig;
      settings = resolveGatewayReloadSettings(nextConfig);
      if (changedPaths.length === 0) return;

      opts.log.info(`config change detected; evaluating reload (${changedPaths.join(", ")})`);
      const plan = buildGatewayReloadPlan(changedPaths);
      if (settings.mode === "off") {
        opts.log.info("config reload disabled (gateway.reload.mode=off)");
        return;
      }
      if (settings.mode === "restart") {
        if (!restartQueued) {
          restartQueued = true;
          opts.onRestart(plan, nextConfig);
        }
        return;
      }
      if (plan.restartGateway) {
        if (settings.mode === "hot") {
          opts.log.warn(
            `config reload requires gateway restart; hot mode ignoring (${plan.restartReasons.join(
              ", ",
            )})`,
          );
          return;
        }
        if (!restartQueued) {
          restartQueued = true;
          opts.onRestart(plan, nextConfig);
        }
        return;
      }

      await opts.onHotReload(plan, nextConfig);
    } catch (err) {
      opts.log.error(`config reload failed: ${String(err)}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const watcher = chokidar.watch(opts.watchPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  let watcherClosed = false;
  watcher.on("error", (err) => {
    if (watcherClosed) return;
    watcherClosed = true;
    opts.log.warn(`config watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      watcherClosed = true;
      await watcher.close().catch(() => {});
    },
  };
}
