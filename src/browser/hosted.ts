/**
 * The browser on a hosted fleet tenant Machine (FLEET_HOSTED_BROWSER).
 *
 * The tenant image ships a full Chromium (Dockerfile.fleet-gateway,
 * INFINIBOT_BROWSER_EXECUTABLE) run in the new headless mode: no X server, but
 * the real browser, so the workspace owner can sign in to sites through the
 * live viewer (./viewer/session.ts) and agents then act in that session. The
 * profile lives on the volume (<state dir>/browser/<profile>/user-data), so
 * cookies and logins survive restarts. On such a Machine the browser config
 * is pinned to what can actually run there, whatever the tenant's config says:
 *   - headless, that executable, one local managed profile;
 *   - no Chrome-extension relay profile (there is no desktop Chrome to attach);
 *   - Chromium's sandbox ON, unless the entrypoint's probe found no user
 *     namespaces (INFINIBOT_BROWSER_NO_SANDBOX=1, logged with the reason).
 * The plan caps concurrent browser sessions (open tabs), since each tab is a
 * renderer process that costs RAM on a fixed-size Machine.
 *
 * Off the fleet nothing here applies.
 */
import { resolveHostedFeatures } from "../saas/hosted-features.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { DEFAULT_CLAWD_BROWSER_PROFILE_NAME } from "./constants.js";

export function isHostedBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  const hosted = resolveHostedFeatures(env);
  return hosted.fleet && hosted.browser;
}

/** Pin a resolved browser config to the hosted Machine's headless Chromium. */
export function applyHostedBrowserConfig(
  resolved: ResolvedBrowserConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrowserConfig {
  if (!isHostedBrowser(env)) return resolved;
  const name =
    resolved.profiles[resolved.defaultProfile]?.driver !== "extension" &&
    resolved.profiles[resolved.defaultProfile]
      ? resolved.defaultProfile
      : DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
  const profile = resolved.profiles[name];
  return {
    ...resolved,
    enabled: true,
    headless: true,
    attachOnly: false,
    noSandbox: env.INFINIBOT_BROWSER_NO_SANDBOX?.trim() === "1",
    executablePath: env.INFINIBOT_BROWSER_EXECUTABLE?.trim() || resolved.executablePath,
    defaultProfile: name,
    profiles:
      profile && profile.driver !== "extension" && !profile.cdpUrl ? { [name]: profile } : {},
  };
}

/** Page size of the hosted browser: what the agent sees and the viewer streams. */
export const HOSTED_BROWSER_WINDOW = { width: 1280, height: 800 };

/**
 * A desktop-Chrome user agent for the hosted browser. Headless Chromium
 * announces itself as "HeadlessChrome", which sign-in pages (Google, X, …)
 * refuse outright; the user is really there, driving it through the viewer.
 * `versionOutput` is what `<chromium> --version` printed.
 */
export function hostedBrowserUserAgent(versionOutput: string): string | null {
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(versionOutput)?.[1];
  if (!major) return null;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Extra Chromium flags on a hosted Machine (none elsewhere): a real window
 * size for the viewer's stream, a non-headless user agent, and no
 * `navigator.webdriver` — this is the user's own interactive browser.
 */
export function hostedChromeArgs(
  versionOutput: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isHostedBrowser(env)) return [];
  const ua = versionOutput ? hostedBrowserUserAgent(versionOutput) : null;
  return [
    `--window-size=${HOSTED_BROWSER_WINDOW.width},${HOSTED_BROWSER_WINDOW.height}`,
    "--disable-blink-features=AutomationControlled",
    "--lang=en-US",
    ...(ua ? [`--user-agent=${ua}`] : []),
  ];
}

export class BrowserSessionLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `Browser session limit reached: your plan allows ${limit} open browser ` +
        `tab${limit === 1 ? "" : "s"} at a time. Close a tab (browser action "close") ` +
        `or reuse one with "navigate", or upgrade for more sessions.`,
    );
    this.name = "BrowserSessionLimitError";
  }
}

/** The plan's concurrent-session cap on a hosted Machine, or null (no cap). */
export function hostedBrowserSessionCap(env: NodeJS.ProcessEnv = process.env): number | null {
  if (!isHostedBrowser(env)) return null;
  return resolveHostedFeatures(env).browserSessions;
}

/** Tabs that count as a session: real pages, not the blank placeholder tab. */
export function countBrowserSessions(tabs: Array<{ url?: string; type?: string }>): number {
  return tabs.filter((t) => (t.type ?? "page") === "page" && t.url !== "about:blank").length;
}

/** Throw when opening one more tab would exceed the plan's cap. */
export function assertBrowserSessionAvailable(
  tabs: Array<{ url?: string; type?: string }>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const cap = hostedBrowserSessionCap(env);
  if (cap === null) return;
  if (countBrowserSessions(tabs) >= cap) throw new BrowserSessionLimitError(cap);
}
