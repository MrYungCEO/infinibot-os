/**
 * ManyChat API gateway methods (served by the content-studio plugin).
 *
 * Honest by design: there is no mock mode. `manychat.connect` verifies the
 * key against ManyChat and only then stores it (secrets/manychat.json) and
 * reports `connected: true`. Flow listing and triggering use the stored key
 * (or an explicit `apiKey` param) and fail with NOT_CONNECTED otherwise.
 */

import {
  deleteManyChatSecrets,
  readManyChatSecrets,
  writeManyChatSecrets,
} from "../../content/manychat-secrets.js";
import type { GatewayRequestHandlers } from "./types.js";

const API = "https://api.manychat.com";

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "[error]";
}

/** Explicit param key, else the stored one. */
function resolveKey(params: Record<string, unknown>): string | null {
  const explicit = typeof params.apiKey === "string" ? params.apiKey.trim() : "";
  return explicit || readManyChatSecrets()?.apiKey || null;
}

const NOT_CONNECTED = {
  code: "NOT_CONNECTED",
  message: "ManyChat isn't connected. Connect it with your API key (ManyChat → Settings → API).",
};

export const manychatHandlers: GatewayRequestHandlers = {
  "manychat.status": ({ respond }) => {
    const s = readManyChatSecrets();
    respond(true, {
      connected: Boolean(s),
      accountName: s?.accountName ?? null,
      subscriberCount: s?.subscriberCount ?? null,
      connectedAt: s?.connectedAt ?? null,
    });
  },

  "manychat.connect": async ({ params, respond }) => {
    try {
      const apiKey = typeof params.apiKey === "string" ? params.apiKey.trim() : "";
      if (!apiKey) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "Paste your ManyChat API key (ManyChat → Settings → API).",
        });
        return;
      }
      const res = await fetch(`${API}/fb/page/getInfo`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        respond(false, undefined, {
          code: "AUTH_ERROR",
          message: `ManyChat rejected the key (${res.status} ${res.statusText}). Nothing was saved.`,
        });
        return;
      }
      const data = (await res.json()) as {
        status?: string;
        data?: { name?: string; subscribers_count?: number };
      };
      if (data.status && data.status !== "success") {
        respond(false, undefined, {
          code: "AUTH_ERROR",
          message: "ManyChat didn't accept the key. Nothing was saved.",
        });
        return;
      }
      const secrets = {
        apiKey,
        accountName: data.data?.name,
        subscriberCount: data.data?.subscribers_count,
        connectedAt: Date.now(),
      };
      writeManyChatSecrets(secrets);
      respond(true, {
        connected: true,
        accountName: secrets.accountName ?? null,
        subscriberCount: secrets.subscriberCount ?? null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "manychat.disconnect": ({ respond }) => {
    respond(true, { disconnected: deleteManyChatSecrets() });
  },

  "manychat.flows.list": async ({ params, respond }) => {
    try {
      const apiKey = resolveKey(params);
      if (!apiKey) {
        respond(false, undefined, NOT_CONNECTED);
        return;
      }
      const res = await fetch(`${API}/fb/page/getFlows`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        respond(false, undefined, {
          code: "AUTH_ERROR",
          message: `ManyChat API error: ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as {
        data?: { flows?: Array<{ ns: string; name: string }> };
      };
      const flows = (data.data?.flows ?? []).map((f) => ({ id: f.ns, name: f.name }));
      respond(true, { flows });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },

  "manychat.trigger": async ({ params, respond }) => {
    try {
      const { flowId, subscriberId } = params as { flowId?: string; subscriberId?: string };
      const apiKey = resolveKey(params);
      if (!apiKey) {
        respond(false, undefined, NOT_CONNECTED);
        return;
      }
      if (!flowId || !subscriberId) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "flowId and subscriberId are required",
        });
        return;
      }
      const res = await fetch(`${API}/fb/sending/sendFlow`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: flowId }),
      });
      if (!res.ok) {
        respond(false, undefined, {
          code: "API_ERROR",
          message: `ManyChat trigger failed: ${res.status}`,
        });
        return;
      }
      respond(true, { triggered: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: extractErrorMessage(e) });
    }
  },
};
