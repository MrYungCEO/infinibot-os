import type { InfinibotConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry, PluginServiceRegistration } from "./registry.js";
import { isContributionActive } from "./host-state.js";
import { appendPluginLog } from "./plugin-logs.js";

const log = createSubsystemLogger("plugins");

type ServiceContext = { config: InfinibotConfig; workspaceDir?: string };
type ServiceState = {
  entry: PluginServiceRegistration;
  running: boolean;
  startedAt?: number;
  lastError?: string;
};

/** Live service table so Setup › Plugins can report, stop, start and
 *  restart one plugin's services without restarting the gateway. */
const SERVICES = Symbol.for("infinibot.pluginServices");
function table(): { ctx: ServiceContext | null; services: ServiceState[] } {
  const g = globalThis as typeof globalThis & {
    [SERVICES]?: { ctx: ServiceContext | null; services: ServiceState[] };
  };
  if (!g[SERVICES]) g[SERVICES] = { ctx: null, services: [] };
  return g[SERVICES];
}

function serviceLogger(pluginId: string) {
  return {
    info: (msg: string) => {
      appendPluginLog(pluginId, "info", msg, "plugin");
      log.info(msg);
    },
    warn: (msg: string) => {
      appendPluginLog(pluginId, "warn", msg, "plugin");
      log.warn(msg);
    },
    error: (msg: string) => {
      appendPluginLog(pluginId, "error", msg, "plugin");
      log.error(msg);
    },
    debug: (msg: string) => log.debug(msg),
  };
}

async function startOne(state: ServiceState, ctx: ServiceContext): Promise<void> {
  if (state.running) return;
  try {
    await state.entry.service.start({
      config: ctx.config,
      workspaceDir: ctx.workspaceDir,
      stateDir: STATE_DIR,
      logger: serviceLogger(state.entry.pluginId),
    });
    state.running = true;
    state.startedAt = Date.now();
    state.lastError = undefined;
    appendPluginLog(state.entry.pluginId, "info", `service ${state.entry.service.id} started`);
  } catch (err) {
    state.lastError = String(err);
    appendPluginLog(
      state.entry.pluginId,
      "error",
      `service ${state.entry.service.id} failed: ${String(err)}`,
    );
    log.error(`plugin service failed (${state.entry.service.id}): ${String(err)}`);
  }
}

async function stopOne(state: ServiceState, ctx: ServiceContext): Promise<void> {
  if (!state.running) return;
  state.running = false;
  try {
    await state.entry.service.stop?.({
      config: ctx.config,
      workspaceDir: ctx.workspaceDir,
      stateDir: STATE_DIR,
      logger: serviceLogger(state.entry.pluginId),
    });
    appendPluginLog(state.entry.pluginId, "info", `service ${state.entry.service.id} stopped`);
  } catch (err) {
    appendPluginLog(
      state.entry.pluginId,
      "warn",
      `service ${state.entry.service.id} stop failed: ${String(err)}`,
    );
    log.warn(`plugin service stop failed (${state.entry.service.id}): ${String(err)}`);
  }
}

export function listPluginServiceStates(pluginId: string): {
  id: string;
  running: boolean;
  startedAt?: number;
  lastError?: string;
}[] {
  return table()
    .services.filter((s) => s.entry.pluginId === pluginId)
    .map((s) => ({
      id: s.entry.service.id,
      running: s.running,
      startedAt: s.startedAt,
      lastError: s.lastError,
    }));
}

/**
 * Bring one plugin's services in line with its contribution toggles, or
 * restart them all (`restart: true`). No-op before the gateway started them.
 */
export async function reconcilePluginServices(
  pluginId: string,
  opts: { restart?: boolean } = {},
): Promise<{ id: string; running: boolean }[]> {
  const t = table();
  const ctx = t.ctx;
  if (!ctx) return [];
  for (const s of t.services.filter((x) => x.entry.pluginId === pluginId)) {
    const active = isContributionActive(
      { id: pluginId, catalog: s.entry.catalog },
      `service:${s.entry.service.id}`,
    );
    if (opts.restart || !active) await stopOne(s, ctx);
    if (active) await startOne(s, ctx);
  }
  return listPluginServiceStates(pluginId).map(({ id, running }) => ({ id, running }));
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: InfinibotConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  const t = table();
  const ctx: ServiceContext = { config: params.config, workspaceDir: params.workspaceDir };
  t.ctx = ctx;
  const catalogs = new Map(params.registry.plugins.map((p) => [p.id, p.catalog]));
  t.services = params.registry.services.map((entry) => ({
    entry: { ...entry, catalog: catalogs.get(entry.pluginId) },
    running: false,
  }));
  for (const state of t.services) {
    const active = isContributionActive(
      { id: state.entry.pluginId, catalog: state.entry.catalog },
      `service:${state.entry.service.id}`,
    );
    if (active) await startOne(state, ctx);
  }

  return {
    stop: async () => {
      const current = table();
      for (const state of [...current.services].reverse()) await stopOne(state, ctx);
      if (current.ctx === ctx) current.ctx = null;
    },
  };
}
