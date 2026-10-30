/**
 * Canonical Chrome launch flag builder. Single source of truth so every
 * code path that spawns or attaches to a Chrome instance uses the same
 * baseline, with predictable, auditable variations.
 *
 * Goals:
 *   - Deterministic CDP port + userDataDir
 *   - Sandbox ON by default — `--no-sandbox` only when we detect we're
 *     running in a container that doesn't allow user namespaces
 *   - No telemetry / first-run / signin defaults that would dirty the
 *     profile we're trying to keep clean
 *   - Stable session: profile keeps cookies, extensions, history across
 *     restarts because we always point at the same userDataDir
 */

import * as fs from "node:fs";

export interface ChromeArgsOptions {
  /** Absolute path to the Chrome profile directory. */
  userDataDir: string;
  /** Remote-debugging port — must be free; the safe-launch helper pins it. */
  cdpPort: number;
  /** Start a tab on this URL when launching. Omit for about:blank. */
  startUrl?: string;
  /** Run headless. Default false — most agent flows want a visible window. */
  headless?: boolean;
  /**
   * Force `--no-sandbox`. Defaults to auto-detect: enabled only when we
   * detect a container that can't support the Chrome sandbox.
   */
  noSandbox?: boolean;
  /**
   * Extra args to append. Use sparingly — flag drift across call sites is
   * exactly the problem this module exists to prevent.
   */
  extraArgs?: string[];
  /** Custom user-agent override. Empty / omitted = Chrome default. */
  userAgent?: string;
  /** Disable the first-run "what's new" splash. Default true. */
  suppressFirstRun?: boolean;
}

let cachedContainerProbe: boolean | undefined;

/**
 * Detect a containerized environment in which Chrome's sandbox can't
 * function without `--no-sandbox`. We probe `/proc/1/cgroup` for common
 * container markers; the answer is cached per-process.
 */
export function isLikelyContainer(): boolean {
  if (cachedContainerProbe !== undefined) return cachedContainerProbe;
  let result = false;
  try {
    if (fs.existsSync("/.dockerenv")) result = true;
    if (!result && fs.existsSync("/run/.containerenv")) result = true;
    if (!result) {
      try {
        const cg = fs.readFileSync("/proc/1/cgroup", "utf-8");
        if (/docker|kubepods|containerd|lxc|podman/i.test(cg)) result = true;
      } catch {
        /* not /proc-aware host */
      }
    }
  } catch {
    /* ignore */
  }
  cachedContainerProbe = result;
  return result;
}

/**
 * Build the full Chrome argv. The function is pure — pass the same opts,
 * get the same flag list back — so tests can assert exact composition.
 */
export function buildChromeArgs(opts: ChromeArgsOptions): string[] {
  const args: string[] = [];

  args.push(`--user-data-dir=${opts.userDataDir}`);
  args.push(`--remote-debugging-port=${opts.cdpPort}`);
  // Bind only to loopback — never expose CDP to the network.
  args.push(`--remote-debugging-address=127.0.0.1`);

  if (opts.headless) {
    args.push(`--headless=new`);
    args.push(`--hide-scrollbars`);
  }

  if (opts.noSandbox === true || (opts.noSandbox === undefined && isLikelyContainer())) {
    args.push(`--no-sandbox`);
    args.push(`--disable-setuid-sandbox`);
  }

  if (opts.suppressFirstRun !== false) {
    args.push(`--no-first-run`);
    args.push(`--no-default-browser-check`);
    args.push(`--disable-default-apps`);
  }

  // Minimize unsolicited network noise that would dirty a clean profile:
  //   - Suppress field trials / variations
  //   - Disable metrics
  //   - Block sync flows / signin
  // Users who want a logged-in profile add `infini` and pass real
  // credentials through; we don't want background sync silently changing
  // saved cookies.
  args.push(`--disable-background-networking`);
  args.push(`--disable-features=TranslateUI,OptimizationHints,InterestFeedV2`);
  args.push(`--metrics-recording-only`);
  args.push(`--disable-component-update`);
  args.push(`--disable-sync`);
  args.push(`--disable-domain-reliability`);
  args.push(`--disable-client-side-phishing-detection`);

  // Improve stability in agent workloads:
  args.push(`--disable-background-timer-throttling`);
  args.push(`--disable-backgrounding-occluded-windows`);
  args.push(`--disable-renderer-backgrounding`);

  // Crash recovery / restore prompts get in the way of automation.
  args.push(`--no-crash-upload`);
  args.push(`--disable-breakpad`);

  if (opts.userAgent && opts.userAgent.trim()) {
    args.push(`--user-agent=${opts.userAgent.trim()}`);
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  if (opts.startUrl && opts.startUrl.trim()) {
    args.push(opts.startUrl.trim());
  }

  return args;
}

/** For tests — clear the container probe cache. */
export function resetContainerProbeCache(): void {
  cachedContainerProbe = undefined;
}
