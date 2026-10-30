import {
  type BrowserSiteDecision,
  type BrowserSiteRule,
  getBrowserExtensionGovernance,
} from "../../browser/extension-governance.js";
import { browserViewerAccess } from "../../browser/viewer/access.js";
import { isSaasMode } from "../../saas/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

function guard(client: GatewayClient | null, respond: RespondFn): boolean {
  const access = browserViewerAccess({
    saasMode: isSaasMode(),
    role: client?.saasRole,
    scopes: client?.connect?.scopes,
    hasTenant: Boolean(client?.saasTenantId),
  });
  if (!access.allowed) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, access.reason));
    return false;
  }
  return true;
}

function fail(respond: RespondFn, err: unknown): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

export const browserExtensionHandlers: GatewayRequestHandlers = {
  "browser.extension.status": ({ client, respond }) => {
    if (!guard(client, respond)) return;
    respond(true, getBrowserExtensionGovernance().status());
  },

  "browser.extension.pairing.create": ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      respond(
        true,
        getBrowserExtensionGovernance().createPairingCode(
          typeof params.name === "string" ? params.name : undefined,
        ),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.extension.kill.set": ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    const enabled = params.enabled === true;
    getBrowserExtensionGovernance().setKillSwitch(enabled);
    respond(true, { ok: true, enabled });
  },

  "browser.extension.permissions.set": ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const rawRules = Array.isArray(params.rules) ? params.rules : [];
      const rules: BrowserSiteRule[] = rawRules.map((raw) => {
        const row = raw as { pattern?: unknown; decision?: unknown };
        const decision = String(row.decision ?? "ask") as BrowserSiteDecision;
        if (!(["allow", "ask", "block"] as const).includes(decision)) {
          throw new Error(`Invalid site decision: ${decision}`);
        }
        return { pattern: String(row.pattern ?? ""), decision };
      });
      const defaultDecision = String(params.defaultDecision ?? "ask") as BrowserSiteDecision;
      if (!(["allow", "ask", "block"] as const).includes(defaultDecision)) {
        throw new Error(`Invalid default decision: ${defaultDecision}`);
      }
      const registry = getBrowserExtensionGovernance();
      registry.setRules(rules, defaultDecision);
      respond(true, registry.status());
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.extension.profile.revoke": ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    const id = typeof params.id === "string" ? params.id : "";
    respond(true, { ok: getBrowserExtensionGovernance().revoke(id) });
  },
};
