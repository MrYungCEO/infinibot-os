/**
 * Gateway glue for the agent browser: picks the profile for a call, makes sure
 * that profile's managed Chrome is running, and hands the action layer a
 * Playwright context on it. Agent activity is published so the live browser
 * panel can follow the agent's tab (browser-viewer.ts subscribes).
 */
import { EventEmitter } from "node:events";

import type { Browser, BrowserContext, Page } from "playwright-core";

import type { InfinibotConfig } from "../../config/config.js";
import { deriveDefaultBrowserCdpPortRange } from "../../config/port-defaults.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { getChromeWebSocketUrl } from "../chrome.js";
import { resolveProfile } from "../config.js";
import { getHeadersWithAuth } from "../cdp.helpers.js";
import { DEFAULT_CLAWD_BROWSER_PROFILE_NAME } from "../constants.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../control-service.js";
import {
  assertBrowserSessionAvailable,
  hostedBrowserSessionCap,
  isHostedBrowser,
} from "../hosted.js";
import { allocateCdpPort, getUsedPorts, PROFILE_COLORS } from "../profiles.js";
import type { BrowserServerState } from "../server-context.types.js";
import { AgentBrowserSession } from "./actions.js";
import { ensureChromeExtensionRelayServer } from "../extension-relay.js";
import { BROWSER_NOT_CONNECTED_MESSAGE, waitForRelayConnection } from "../extension-connection.js";
import {
  AGENT_DEFAULT_PROFILE,
  normalizeAgentProfileName,
  RELAY_BROWSER_PROFILE,
  SECURE_BROWSER_PROFILE,
} from "./profile-store.js";

const log = createSubsystemLogger("browser").child("agent");

export type ResolvedAgentProfile = {
  /** Agent-facing name: "default", "work", "secure", "chrome". */
  name: string;
  /** "relay" → user's own Chrome via the extension (legacy path). */
  kind: "managed" | "relay";
  secure: boolean;
};

/**
 * Which profile a browser call runs in.
 *   explicit `profile` param > session's sticky choice > browser.agentProfiles[agentId]
 *   > the paired Chrome ("chrome", main agent only, when connected) > "default".
 * Secure Mode sessions are pinned to the ephemeral "secure" profile and every
 * other session is kept out of it.
 */
export function resolveAgentProfile(opts: {
  requested?: unknown;
  sticky?: string;
  agentId?: string;
  sessionKey?: string;
  cfg?: InfinibotConfig;
  /** Nothing chosen → use the user's paired Chrome (main agent, Chrome connected). */
  preferRelay?: boolean;
}): ResolvedAgentProfile {
  const secureSession = isSecureSessionKey(opts.sessionKey);
  const configured = opts.agentId ? opts.cfg?.browser?.agentProfiles?.[opts.agentId] : undefined;
  const raw =
    (typeof opts.requested === "string" && opts.requested.trim()) ||
    opts.sticky ||
    configured ||
    "";
  if (secureSession) {
    const name = raw ? normalizeAgentProfileName(raw) : SECURE_BROWSER_PROFILE;
    if (name !== SECURE_BROWSER_PROFILE) {
      throw new Error(
        `Secure Mode sessions can only use the ephemeral "secure" browser profile (asked for "${name}").`,
      );
    }
    return { name, kind: "managed", secure: true };
  }
  if (!raw && opts.preferRelay)
    return { name: RELAY_BROWSER_PROFILE, kind: "relay", secure: false };
  const name = normalizeAgentProfileName(raw);
  if (name === SECURE_BROWSER_PROFILE) {
    throw new Error('The "secure" browser profile is reserved for Secure Mode sessions.');
  }
  if (name === RELAY_BROWSER_PROFILE) return { name, kind: "relay", secure: false };
  return { name, kind: "managed", secure: false };
}

/** Agent-facing name → managed profile name in the browser control service. */
export function managedProfileName(state: BrowserServerState, name: string): string {
  if (name !== AGENT_DEFAULT_PROFILE) return name;
  if (isHostedBrowser()) return DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
  const def = state.resolved.defaultProfile;
  const cfg = state.resolved.profiles[def];
  if (cfg && cfg.driver !== "extension" && !cfg.cdpUrl) return def;
  return DEFAULT_CLAWD_BROWSER_PROFILE_NAME;
}

/** Inverse of managedProfileName (for the UI / activity events). */
export function agentProfileName(state: BrowserServerState | null, managed: string): string {
  if (!state) return managed;
  return managedProfileName(state, AGENT_DEFAULT_PROFILE) === managed
    ? AGENT_DEFAULT_PROFILE
    : managed;
}

/** Make a not-yet-configured profile name launchable (in memory, no config write). */
export function ensureDynamicProfile(state: BrowserServerState, managed: string): void {
  if (state.resolved.profiles[managed]) return;
  const range = deriveDefaultBrowserCdpPortRange(state.resolved.controlPort);
  const port = allocateCdpPort(getUsedPorts(state.resolved.profiles), range);
  if (port === null) throw new Error("No free CDP port left for another browser profile.");
  const color = PROFILE_COLORS[Object.keys(state.resolved.profiles).length % PROFILE_COLORS.length];
  state.resolved.profiles[managed] = { cdpPort: port, color };
  log.info(`registered browser profile "${managed}" on CDP port ${port}`);
}

// ── Playwright connections (one per profile Chrome) ─────────────────────────

const connections = new Map<string, Promise<Browser>>();

async function connect(cdpUrl: string): Promise<Browser> {
  const existing = connections.get(cdpUrl);
  if (existing) {
    const b = await existing.catch(() => null);
    if (b?.isConnected()) return b;
    connections.delete(cdpUrl);
  }
  const p = (async () => {
    const { chromium } = await import("playwright-core");
    const wsUrl = (await getChromeWebSocketUrl(cdpUrl, 5000).catch(() => null)) ?? cdpUrl;
    const browser = await chromium.connectOverCDP(wsUrl, {
      timeout: 10_000,
      headers: getHeadersWithAuth(wsUrl),
    });
    browser.on("disconnected", () => connections.delete(cdpUrl));
    return browser;
  })();
  connections.set(cdpUrl, p);
  p.catch(() => connections.delete(cdpUrl));
  return await p;
}

export type AgentBrowserHandle = {
  managed: string;
  cdpUrl: string;
  context: BrowserContext;
};

/** Start (if needed) the managed Chrome for a profile and return its default context. */
export async function openManagedProfile(name: string): Promise<AgentBrowserHandle> {
  const state = await startBrowserControlServiceFromConfig();
  if (!state) throw new Error("The browser is turned off on this gateway (browser.enabled=false).");
  const managed = managedProfileName(state, name);
  ensureDynamicProfile(state, managed);
  const profileCtx = createBrowserControlContext().forProfile(managed);
  await profileCtx.ensureBrowserAvailable();
  const cdpUrl = profileCtx.profile.cdpUrl;
  const browser = await connect(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`The browser for profile "${name}" has no window context.`);
  return { managed, cdpUrl, context };
}

/** Connect to the user's already-running, paired Chrome. Never launches a browser/profile. */
export async function openRelayProfile(): Promise<AgentBrowserHandle> {
  const state = await startBrowserControlServiceFromConfig();
  if (!state) throw new Error("The browser is turned off on this gateway (browser.enabled=false).");
  const profile = resolveProfile(state.resolved, RELAY_BROWSER_PROFILE);
  if (!profile || profile.driver !== "extension") {
    throw new Error('The built-in "chrome" extension profile is not configured.');
  }
  await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
    // Another InfiniBot process may already serve the relay on this port;
    // that's fine as long as it answers below.
    log.debug(`relay server: ${String(err)}`);
  });
  // A sleeping MV3 service worker reconnects on its own; give it a moment
  // instead of failing the turn on the first probe.
  const probe = await waitForRelayConnection(profile.cdpUrl.replace(/\/+$/, ""), {
    timeoutMs: 8_000,
  });
  const wsUrl = probe.connected ? await getChromeWebSocketUrl(profile.cdpUrl, 1500) : null;
  if (!wsUrl) throw new Error(BROWSER_NOT_CONNECTED_MESSAGE);
  let browser: Browser;
  try {
    browser = await connect(wsUrl);
  } catch {
    // One retry: the extension may have swapped its socket mid-handshake.
    await new Promise((r) => setTimeout(r, 750));
    browser = await connect(wsUrl).catch(() => {
      throw new Error(BROWSER_NOT_CONNECTED_MESSAGE);
    });
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("The paired Chrome profile has no browser context.");
  adoptRacedRelayTabs(context);
  return { managed: RELAY_BROWSER_PROFILE, cdpUrl: profile.cdpUrl, context };
}

const adoptedContexts = new WeakSet<BrowserContext>();

/**
 * Browser Relay <= 0.3.1 (and relays that predate the createTarget fallback):
 * when the extension auto-attaches new tabs, its tabs.onCreated handler wins
 * the race and Target.createTarget fails with "Another debugger is already
 * attached" even though the tab was created and attached. Playwright still
 * sees that tab arrive as a page, so adopt it instead of failing the call.
 */
export function adoptRacedRelayTabs(context: BrowserContext): void {
  if (adoptedContexts.has(context)) return;
  adoptedContexts.add(context);
  const original = context.newPage.bind(context);
  context.newPage = async () => {
    const arrived: Page[] = [];
    const onPage = (p: Page) => arrived.push(p);
    context.on("page", onPage);
    try {
      return await original();
    } catch (err) {
      if (!/already attached/i.test(String((err as Error)?.message ?? err))) throw err;
      const deadline = Date.now() + 3_000;
      while (arrived.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const page = arrived.find((p) => !p.isClosed());
      if (!page) throw err;
      log.debug("adopted a relay tab that auto-attach claimed first");
      return page;
    } finally {
      context.off("page", onPage);
    }
  };
}

// ── activity (live panel follows the agent) ─────────────────────────────────

export type AgentBrowserActivity = {
  /** Managed profile name (what the viewer attaches to). */
  managed: string;
  profile: string;
  targetId: string | null;
  url: string;
  action: string;
  sessionKey: string;
  secure: boolean;
  at: number;
};

const activity = new EventEmitter();
activity.setMaxListeners(50);

export function onAgentBrowserActivity(fn: (a: AgentBrowserActivity) => void): () => void {
  activity.on("activity", fn);
  return () => activity.off("activity", fn);
}

export function emitAgentBrowserActivity(a: AgentBrowserActivity): void {
  activity.emit("activity", a);
}

// ── sessions ────────────────────────────────────────────────────────────────

const sessions = new Map<string, AgentBrowserSession>();
/** Last profile each agent session used, so follow-up calls stay in it. */
const stickyProfiles = new Map<string, string>();

export function stickyProfileFor(sessionKey: string): string | undefined {
  return stickyProfiles.get(sessionKey);
}

export function agentBrowserSession(
  profile: ResolvedAgentProfile,
  sessionKey: string,
): AgentBrowserSession {
  const key = `${profile.name}\u0000${sessionKey}`;
  stickyProfiles.set(sessionKey, profile.name);
  let s = sessions.get(key);
  if (!s) {
    let managed = profile.name;
    let relayCdpUrl = "";
    s = new AgentBrowserSession(
      {
        getContext: async () => {
          const h =
            profile.kind === "relay"
              ? await openRelayProfile()
              : await openManagedProfile(profile.name);
          managed = h.managed;
          if (profile.kind === "relay") relayCdpUrl = h.cdpUrl;
          return h.context;
        },
        // Hosted plans cap concurrent browser sessions (same rule as openTab).
        beforeNewTab: async (context) => {
          if (hostedBrowserSessionCap() === null) return;
          assertBrowserSessionAvailable(
            context
              .pages()
              .filter((p) => !p.isClosed())
              .map((p) => ({ url: p.url() })),
          );
        },
        onActivity: (info) =>
          emitAgentBrowserActivity({
            ...info,
            managed,
            profile: profile.name,
            sessionKey,
            secure: profile.secure,
            at: Date.now(),
          }),
        onTabOwned:
          profile.kind === "relay"
            ? async (_page, targetId) => {
                const response = await fetch(`${relayCdpUrl}/extension/claim`, {
                  method: "POST",
                  signal: AbortSignal.timeout(5_000),
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    targetId,
                    runId: sessionKey,
                    label: sessionKey.split(":").slice(-2).join(" · ").slice(0, 32),
                  }),
                });
                if (!response.ok)
                  throw new Error(`extension claim failed: HTTP ${response.status}`);
              }
            : undefined,
        resolveTargetId:
          profile.kind === "relay"
            ? async (page) => {
                const list = (await fetch(`${relayCdpUrl}/json/list`, {
                  signal: AbortSignal.timeout(5_000),
                }).then((response) => response.json())) as Array<{ id?: string; url?: string }>;
                const exact = [...list].reverse().find((target) => target.url === page.url());
                return exact?.id ?? null;
              }
            : undefined,
      },
      sessionKey,
    );
    sessions.set(key, s);
    // Bound memory: sessions are cheap, but an always-on gateway sees many.
    if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
  }
  return s;
}
