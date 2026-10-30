/**
 * Read-only browser seam for plugins: open a page in the browser the agent
 * `browser` tool drives (the Chrome Relay extension, or the hosted Machine's
 * own Chromium), run one function in it, close the tab.
 *
 * For lookups that plain server fetches can't do (image search pages block
 * them). Plugins get no tab handles, clicks or typing — just one evaluation
 * per page, in a tab that is always closed again.
 */
export type HostBrowser = {
  /**
   * Open `url`, wait for DOM ready (+ `settleMs`, default 800 ms), evaluate
   * `fn` (function source, e.g. `() => document.title`) and return its
   * JSON-serialisable result. The tab is closed afterwards.
   */
  evaluateUrl(opts: { url: string; fn: string; settleMs?: number }): Promise<unknown>;
};

export function createHostBrowser(): HostBrowser {
  return {
    async evaluateUrl({ url, fn, settleMs }) {
      if (!/^https?:\/\//i.test(url)) throw new Error("host.browser only opens http(s) pages");
      const [{ loadConfig }, { resolveBrowserConfig }, { isHostedBrowser }, { DEFAULT_CLAWD_BROWSER_PROFILE_NAME }, client, actions] =
        await Promise.all([
          import("../../config/config.js"),
          import("../../browser/config.js"),
          import("../../browser/hosted.js"),
          import("../../browser/constants.js"),
          import("../../browser/client.js"),
          import("../../browser/client-actions.js"),
        ]);
      const cfg = loadConfig();
      if (!resolveBrowserConfig(cfg.browser, cfg).enabled) {
        throw new Error("Browser control is disabled (browser.enabled=false).");
      }
      // Same profile choice as the agent browser tool.
      const profile = isHostedBrowser() ? DEFAULT_CLAWD_BROWSER_PROFILE_NAME : "chrome";
      const tab = await client.browserOpenTab(undefined, url, { profile });
      const targetId = tab.targetId;
      try {
        await actions
          .browserAct(undefined, { kind: "wait", loadState: "domcontentloaded", targetId, timeoutMs: 15_000 }, { profile })
          .catch(() => undefined);
        const settle = Math.max(0, Math.min(settleMs ?? 800, 10_000));
        if (settle) await actions.browserAct(undefined, { kind: "wait", timeMs: settle, targetId }, { profile }).catch(() => undefined);
        const res = await actions.browserAct(undefined, { kind: "evaluate", fn, targetId }, { profile });
        return res.result;
      } finally {
        await client.browserCloseTab(undefined, targetId, { profile }).catch(() => undefined);
      }
    },
  };
}
