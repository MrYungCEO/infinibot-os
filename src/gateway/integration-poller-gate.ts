/**
 * Start an integration poller only once its integration is configured.
 *
 * Background pollers (Instagram stats, Notion pull, Netlify form submissions,
 * GitHub project sync) used to start on every boot and tick forever, even on a
 * fresh install with nothing connected. This gate checks a cheap local
 * `isConfigured()` predicate: when it is already true the poller starts at
 * once (so existing installs behave exactly as before); otherwise it re-checks
 * on a slow timer and starts the poller the first time the integration shows
 * up, so connecting it later from the UI still works without a restart.
 */

export type IntegrationPollerGateOptions = {
  name: string;
  /** Cheap, local check (config/store lookup). Never a network call. */
  isConfigured: () => boolean | Promise<boolean>;
  start: () => void | Promise<void>;
  /** How often to re-check while unconfigured. Default 5 minutes. */
  recheckMs?: number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
};

export type IntegrationPollerGate = {
  /** True once `start()` has been called. */
  started: () => boolean;
  stop: () => void;
};

export async function startWhenConfigured(
  opts: IntegrationPollerGateOptions,
): Promise<IntegrationPollerGate> {
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const tryStart = async (): Promise<boolean> => {
    if (started) return true;
    let configured = false;
    try {
      configured = await opts.isConfigured();
    } catch (err) {
      opts.log?.warn(`${opts.name}: configuration check failed: ${String(err)}`);
      return false;
    }
    if (!configured) return false;
    started = true;
    stopTimer();
    try {
      await opts.start();
      opts.log?.info(`${opts.name} started`);
    } catch (err) {
      opts.log?.warn(`${opts.name} failed to start: ${String(err)}`);
    }
    return true;
  };

  if (!(await tryStart())) {
    opts.log?.info(`${opts.name}: not configured — idle until it is connected`);
    timer = setInterval(() => void tryStart(), opts.recheckMs ?? 5 * 60_000);
    timer.unref?.();
  }

  return { started: () => started, stop: stopTimer };
}
