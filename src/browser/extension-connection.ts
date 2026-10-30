/**
 * Small, dependency-light helpers about the paired Chrome (Browser Relay
 * extension): where the relay listens, whether a Chrome is connected right
 * now, waiting briefly for a sleeping extension to reconnect, and the one
 * "browser not connected" message every surface shows.
 */
import type { InfinibotConfig } from "../config/config.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { getBrowserExtensionGovernance } from "./extension-governance.js";

export const RELAY_PROFILE_NAME = "chrome";
export const DEFAULT_RELAY_URL = "http://127.0.0.1:18792";

/** Marker the chat UI looks for to show a Reconnect button. */
export const BROWSER_NOT_CONNECTED_CODE = "BROWSER_NOT_CONNECTED";

export const BROWSER_NOT_CONNECTED_MESSAGE =
  `Browser not connected (${BROWSER_NOT_CONNECTED_CODE}). Your Chrome with the InfiniBot Browser Relay ` +
  "extension isn't reachable right now. Open Chrome (it reconnects on its own within a few seconds), " +
  "or open Setup › Connect your browser and click Reconnect. If you never paired it, that page walks " +
  "you through it in about a minute.";

export type RelayProbe = {
  url: string;
  reachable: boolean;
  connected: boolean;
  profiles: Array<{ id: string; name: string }>;
};

export function relayBaseUrl(cfg?: InfinibotConfig): string {
  try {
    const resolved = resolveBrowserConfig(cfg?.browser, cfg);
    const profile = resolveProfile(resolved, RELAY_PROFILE_NAME);
    if (profile?.cdpUrl) return profile.cdpUrl.replace(/\/+$/, "");
  } catch {
    /* fall through */
  }
  return DEFAULT_RELAY_URL;
}

/** Ask the relay (HTTP, loopback) whether an extension is connected. Never throws. */
export async function probeRelay(url: string, timeoutMs = 1_500): Promise<RelayProbe> {
  try {
    const res = await fetch(`${url}/extension/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { url, reachable: true, connected: false, profiles: [] };
    const body = (await res.json()) as {
      connected?: unknown;
      profiles?: Array<{ id?: unknown; name?: unknown }>;
    };
    return {
      url,
      reachable: true,
      connected: body.connected === true,
      profiles: Array.isArray(body.profiles)
        ? body.profiles.map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? "Chrome") }))
        : [],
    };
  } catch {
    return { url, reachable: false, connected: false, profiles: [] };
  }
}

/**
 * Wait up to `timeoutMs` for a Chrome to (re)connect. An idle MV3 service
 * worker is woken by its keep-alive alarm and reconnects within ~30 s; most
 * reconnects (gateway restart, laptop wake) land within a few seconds.
 */
export async function waitForRelayConnection(
  url: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<RelayProbe> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 8_000);
  const interval = opts?.intervalMs ?? 500;
  let last = await probeRelay(url);
  while (!last.connected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    last = await probeRelay(url);
  }
  return last;
}

/** True once any Chrome profile has been paired with this gateway. */
export function isBrowserExtensionPaired(): boolean {
  try {
    return getBrowserExtensionGovernance().status().profiles.length > 0;
  } catch {
    return false;
  }
}

/** Run a promise with a hard deadline so a stuck CDP call can't hang a turn. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
