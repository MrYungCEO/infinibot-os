import { isTruthyEnvValue } from "../infra/env.js";

export type BrowserControlServer = {
  stop: () => Promise<void>;
};

export async function startBrowserControlServerIfEnabled(): Promise<BrowserControlServer | null> {
  if (isTruthyEnvValue(process.env.INFINIBOT_SKIP_BROWSER_CONTROL_SERVER)) return null;
  // Lazy import: keeps startup fast, but still bundles for the embedded
  // gateway (bun --compile) via the static specifier path.
  const override = process.env.INFINIBOT_BROWSER_CONTROL_MODULE?.trim();
  const mod = override ? await import(override) : await import("../browser/control-service.js");
  const start =
    typeof (mod as { startBrowserControlServiceFromConfig?: unknown })
      .startBrowserControlServiceFromConfig === "function"
      ? (mod as { startBrowserControlServiceFromConfig: () => Promise<unknown> })
          .startBrowserControlServiceFromConfig
      : (mod as { startBrowserControlServerFromConfig?: () => Promise<unknown> })
          .startBrowserControlServerFromConfig;
  const stop =
    typeof (mod as { stopBrowserControlService?: unknown }).stopBrowserControlService === "function"
      ? (mod as { stopBrowserControlService: () => Promise<void> }).stopBrowserControlService
      : (mod as { stopBrowserControlServer?: () => Promise<void> }).stopBrowserControlServer;
  if (!start) return null;
  await start();
  await exportHostedBrowserEndpoint();
  return { stop: stop ?? (async () => {}) };
}

/**
 * Hosted tenant Machine: tell everything the gateway spawns (terminals, coder
 * CLIs, MCP servers) where the workspace's Chrome listens, so tools that can
 * attach over CDP share the one signed-in browser instead of launching their
 * own. Loopback only — the port is never published by the Machine.
 * (deploy/fly/gateway/tool-env.sh sets the matching CHROME_PATH family.)
 */
async function exportHostedBrowserEndpoint(): Promise<void> {
  try {
    const { isHostedBrowser } = await import("../browser/hosted.js");
    if (!isHostedBrowser()) return;
    const { loadConfig } = await import("../config/config.js");
    const { resolveBrowserConfig, resolveProfile } = await import("../browser/config.js");
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const profile = resolveProfile(resolved, resolved.defaultProfile);
    if (!profile?.cdpIsLoopback) return;
    const url = `http://127.0.0.1:${profile.cdpPort}`;
    process.env.INFINIBOT_BROWSER_CDP_URL ??= url;
    process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ??= url;
  } catch {
    // The browser tool itself does not depend on this.
  }
}
