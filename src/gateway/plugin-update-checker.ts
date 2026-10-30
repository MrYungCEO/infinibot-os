/**
 * Background plugin update check.
 *
 * Instance-local timer (each gateway owns its own installed plugins): a first
 * check shortly after boot, then every `plugins.updates.intervalHours`
 * (default 12). The result is cached for the Plugins page badge. It installs
 * nothing unless a plugin has auto-update on — and then only versions that
 * ask for no new permissions. An auto-updated plugin that is currently
 * running keeps running its old code until the next gateway restart (the
 * checker never restarts the gateway by itself); the Plugins page says so.
 *
 * Off when `plugins.updates.check` is false, plugins are disabled, or
 * INFINIBOT_SKIP_PLUGIN_UPDATE_CHECK is set (side gateways, tests).
 */

import { loadConfig, validateConfigObjectWithPlugins } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { appendPluginLog } from "../plugins/plugin-logs.js";
import { isFleetTenantMachine } from "../saas/fleet-plugins.js";
import { readUpdateState, sweepStaleStaging, writeUpdateState } from "../plugins/packages/store.js";
import { checkPluginUpdates, runAutoUpdates } from "../plugins/packages/updates.js";
import {
  installedPluginRefs,
  refreshPluginRecordFromDisk,
} from "./server-methods/plugins-packages.js";
import { readConfigFileSnapshot, writeConfigFile } from "./server-methods/plugins.js";

const FIRST_CHECK_DELAY_MS = 90_000;
const DEFAULT_INTERVAL_HOURS = 12;

type Log = { info: (m: string) => void; warn: (m: string) => void };

export function pluginUpdateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTruthyEnvValue(env.INFINIBOT_SKIP_PLUGIN_UPDATE_CHECK)) return false;
  if (env.VITEST || env.NODE_ENV === "test") return false;
  // Hosted fleet Machines get plugin updates with the platform image, and a
  // boot-time network call would work against scale-to-zero.
  if (isFleetTenantMachine(env)) return false;
  try {
    const cfg = loadConfig();
    return cfg.plugins?.enabled !== false && cfg.plugins?.updates?.check !== false;
  } catch {
    return false;
  }
}

/** One check + auto-update pass. Exported for tests and the CLI. */
export async function runPluginUpdateCycle(log: Log): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) return;
  const refs = installedPluginRefs();
  const state = await checkPluginUpdates(refs, { config: snapshot.config });
  const available = Object.values(state.plugins).filter((p) => p.updateAvailable);
  if (state.error) log.warn(`plugin update check failed: ${state.error}`);
  else if (available.length) {
    log.info(
      `plugin updates available: ${available.map((p) => `${p.id} ${p.latestVersion}`).join(", ")}`,
    );
  }

  const auto = await runAutoUpdates(refs, state, { config: snapshot.config });
  if (auto.commits.length === 0) {
    for (const o of auto.outcomes)
      appendPluginLog(o.id, o.status === "error" ? "error" : "info", `auto-update: ${o.message}`);
    return;
  }
  const validated = validateConfigObjectWithPlugins(auto.config);
  if (!validated.ok) {
    for (const c of auto.commits) c.undo();
    log.warn("plugin auto-update: resulting config was invalid; changes rolled back");
    return;
  }
  try {
    await writeConfigFile(validated.config);
  } catch (err) {
    for (const c of auto.commits) c.undo();
    log.warn(`plugin auto-update: could not save config (${String(err)}); changes rolled back`);
    return;
  }
  const next = readUpdateState();
  for (const c of auto.commits) {
    delete next.plugins[c.id];
    const running = refs.find((r) => r.id === c.id)?.loaded;
    if (running) next.pendingRestart = { ...next.pendingRestart, [c.id]: c.version };
    else refreshPluginRecordFromDisk(c.id, validated.config);
    appendPluginLog(
      c.id,
      "info",
      `auto-updated ${c.previousVersion ?? "?"} → ${c.version}${running ? " (takes effect at the next gateway restart)" : ""}`,
    );
  }
  writeUpdateState(next);
  for (const o of auto.outcomes) {
    if (o.status !== "updated")
      appendPluginLog(o.id, o.status === "error" ? "error" : "info", `auto-update: ${o.message}`);
  }
  log.info(`plugin auto-update: ${auto.commits.map((c) => `${c.id} ${c.version}`).join(", ")}`);
}

export function startPluginUpdateChecker(log: Log): { stop: () => void } {
  if (!pluginUpdateCheckEnabled()) return { stop: () => {} };
  // A restart is what activates a pending auto-update: clear the marker.
  try {
    const state = readUpdateState();
    if (state.pendingRestart && Object.keys(state.pendingRestart).length) {
      delete state.pendingRestart;
      writeUpdateState(state);
    }
    sweepStaleStaging();
  } catch {
    /* best effort */
  }
  let stopped = false;
  let running = false;
  const tick = () => {
    if (stopped || running || !pluginUpdateCheckEnabled()) return;
    running = true;
    void runPluginUpdateCycle(log)
      .catch((err) => log.warn(`plugin update check failed: ${String(err)}`))
      .finally(() => {
        running = false;
      });
  };
  let hours = DEFAULT_INTERVAL_HOURS;
  try {
    const configured = loadConfig().plugins?.updates?.intervalHours;
    if (typeof configured === "number" && configured >= 1) hours = configured;
  } catch {
    /* default */
  }
  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  const interval = setInterval(tick, hours * 60 * 60_000);
  first.unref?.();
  interval.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
