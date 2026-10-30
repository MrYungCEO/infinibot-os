/**
 * browser.viewer.* — the live browser panel (src/browser/viewer/session.ts).
 *
 * Every method checks viewer access first (owner/admin on a hosted tenant
 * Machine, admin scope when self-hosted), and frames/state are delivered only
 * to connections that passed that check and subscribed. Chrome's debugging
 * port never leaves loopback: the UI only ever talks to these RPCs.
 */
import { getChromeWebSocketUrl } from "../../browser/chrome.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import {
  countBrowserSessions,
  hostedBrowserSessionCap,
  isHostedBrowser,
} from "../../browser/hosted.js";
import {
  ensureDynamicProfile,
  managedProfileName,
  onAgentBrowserActivity,
} from "../../browser/agent/runtime.js";
import {
  AGENT_DEFAULT_PROFILE,
  normalizeAgentProfileName,
  SECURE_BROWSER_PROFILE,
} from "../../browser/agent/profile-store.js";
import { browserViewerAccess } from "../../browser/viewer/access.js";
import { CdpConnection } from "../../browser/viewer/cdp-connection.js";
import { normalizeViewerUrl } from "../../browser/viewer/input.js";
import { BrowserViewer, type ViewerLayout } from "../../browser/viewer/session.js";
import { isSaasMode } from "../../saas/config.js";
import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

let broadcastRef: GatewayRequestContext["broadcast"] | null = null;
let viewer: BrowserViewer | null = null;
/** Agent-facing profile on screen ("default" = the agents' shared browser). */
let viewerProfileName = AGENT_DEFAULT_PROFILE;

async function viewerProfile() {
  const state = await startBrowserControlServiceFromConfig();
  if (!state) throw new Error("The browser is turned off on this gateway.");
  const ctx = createBrowserControlContext();
  // The same managed profile the agents' browser tool resolves "default" to,
  // so the panel always shows the browser the agent is driving.
  const name = managedProfileName(state, viewerProfileName);
  ensureDynamicProfile(state, name);
  const profile = state.resolved.profiles[name];
  if (!profile || profile.driver === "extension") {
    throw new Error("No managed browser profile is configured.");
  }
  return ctx.forProfile(name);
}

let unfollow: (() => void) | null = null;

/** The panel follows the agent: same profile, same tab (never the secure profile). */
function ensureAgentFollow(): void {
  if (unfollow) return;
  unfollow = onAgentBrowserActivity((a) => {
    if (a.secure || a.profile === "chrome") return;
    const v = viewer;
    if (!v || v.subscriberCount === 0) return;
    void (async () => {
      if (a.profile !== viewerProfileName) {
        viewerProfileName = a.profile;
        await v.switchProfile(a.profile, a.targetId).catch(() => {});
      }
      await v.followAgent(a);
    })();
  });
}

function getViewer(): BrowserViewer {
  viewer ??= new BrowserViewer({
    resolveBrowserWsUrl: async () => {
      const profile = await viewerProfile();
      await profile.ensureBrowserAvailable();
      const wsUrl = await getChromeWebSocketUrl(profile.profile.cdpUrl, 3000);
      if (!wsUrl) throw new Error("The browser started but its control channel is not ready.");
      return wsUrl;
    },
    connect: (wsUrl) => CdpConnection.connect(wsUrl),
    emit: (connIds, event, payload) =>
      broadcastRef?.(event, payload, { connIds, dropIfSlow: true }),
  });
  return viewer;
}

/** Why the viewer can't run here, or null when it can. */
function unavailableReason(): string | null {
  if (isFleetTenantMachineEnv() && !isHostedBrowser()) {
    return "Your plan doesn't include the hosted browser.";
  }
  return null;
}

function guard(client: GatewayClient | null, respond: RespondFn): client is GatewayClient {
  const access = browserViewerAccess({
    saasMode: isSaasMode(),
    role: client?.saasRole,
    scopes: client?.connect?.scopes,
    hasTenant: Boolean(client?.saasTenantId),
  });
  if (!access.allowed || !client) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        access.allowed ? "connection required" : access.reason,
      ),
    );
    return false;
  }
  const reason = unavailableReason();
  if (reason) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, reason));
    return false;
  }
  return true;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function sessionInfo() {
  const cap = hostedBrowserSessionCap();
  let sessions = 0;
  try {
    sessions = countBrowserSessions(await (await viewerProfile()).listTabs());
  } catch {
    // browser not running yet
  }
  return { cap, sessions };
}

function fail(respond: RespondFn, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

export const browserViewerHandlers: GatewayRequestHandlers = {
  "browser.viewer.status": async ({ client, respond }) => {
    const access = browserViewerAccess({
      saasMode: isSaasMode(),
      role: client?.saasRole,
      scopes: client?.connect?.scopes,
      hasTenant: Boolean(client?.saasTenantId),
    });
    const reason = access.allowed ? unavailableReason() : access.reason;
    if (reason) {
      respond(true, { available: false, reason });
      return;
    }
    respond(true, {
      available: true,
      hosted: isHostedBrowser(),
      ...(await sessionInfo()),
      viewer: viewer?.state() ?? null,
    });
  },

  "browser.viewer.open": async ({ params, client, respond, context }) => {
    if (!guard(client, respond)) return;
    broadcastRef = context.broadcast;
    ensureAgentFollow();
    try {
      if (typeof params.profile === "string" && params.profile.trim()) {
        const wanted = normalizeAgentProfileName(params.profile);
        if (wanted === SECURE_BROWSER_PROFILE || wanted === "chrome") {
          throw new Error(`The "${wanted}" profile can't be shown in the live panel.`);
        }
        if (wanted !== viewerProfileName) {
          viewerProfileName = wanted;
          await getViewer().switchProfile(wanted);
        }
      }
      const state = await getViewer().subscribe(client.connId, {
        targetId: str(params.targetId) || undefined,
      });
      respond(true, { ...state, ...(await sessionInfo()) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.close": ({ client, respond }) => {
    if (client) viewer?.unsubscribe(client.connId);
    respond(true, { ok: true });
  },

  "browser.viewer.ack": ({ client, respond }) => {
    if (client) viewer?.ack(client.connId);
    respond(true, { ok: true });
  },

  "browser.viewer.input": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const events = Array.isArray(params.events) ? params.events.slice(0, 64) : [params.event];
      for (const event of events) await getViewer().input(client.connId, event);
      respond(true, { ok: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.navigate": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    const action = str(params.action) || "goto";
    if (!["goto", "back", "forward", "reload", "stop"].includes(action)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown action"));
      return;
    }
    try {
      let url: string | undefined;
      if (action === "goto") {
        const normalized = normalizeViewerUrl(str(params.url));
        if (!normalized.ok) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalized.error));
          return;
        }
        url = normalized.url;
      }
      await getViewer().navigate(client.connId, action as "goto", url);
      respond(true, { ok: true, ...(url ? { url } : {}) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.tab": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    const action = str(params.action);
    const targetId = str(params.targetId);
    try {
      const v = getViewer();
      if (!v.isSubscribed(client.connId)) throw new Error("Open the live browser first.");
      if (action === "new") {
        let url = "about:blank";
        if (str(params.url)) {
          const normalized = normalizeViewerUrl(str(params.url));
          if (!normalized.ok) throw new Error(normalized.error);
          url = normalized.url;
        }
        // Same path as the agents' browser tool, so the plan's session cap applies.
        const tab = await (await viewerProfile()).openTab(url);
        await v.selectTab(client.connId, tab.targetId).catch(() => {});
        respond(true, { ok: true, targetId: tab.targetId, ...(await sessionInfo()) });
        return;
      }
      if (!targetId) throw new Error("targetId required");
      if (action === "select") await v.selectTab(client.connId, targetId);
      else if (action === "close") await v.closeTab(client.connId, targetId);
      else throw new Error("unknown action");
      respond(true, { ok: true, ...(await sessionInfo()) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.layout": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    const layout: ViewerLayout = params.layout === "phone" ? "phone" : "desktop";
    try {
      await getViewer().setLayout(client.connId, layout);
      respond(true, { ok: true, layout });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.dialog": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      await getViewer().resolveDialog(
        client.connId,
        params.accept === true,
        typeof params.promptText === "string" ? params.promptText : undefined,
      );
      respond(true, { ok: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.viewer.copy": async ({ client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      respond(true, { text: await getViewer().copySelection(client.connId) });
    } catch (err) {
      fail(respond, err);
    }
  },
};
