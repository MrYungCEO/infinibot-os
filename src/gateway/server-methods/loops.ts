/**
 * Loops.so gateway handlers — bridge the WebUI Email Marketing tab and
 * the agent `loops` tool to the Loops REST API + the local KPI store.
 *
 * Auth: API key lives in cfg.loops.apiKey. Every handler resolves it
 * fresh on call so config edits take effect without a gateway restart.
 *
 * Webhook events arrive on the gateway's HTTP server (see
 * server-startup.ts) — those are recorded into the loops store and
 * surface in `loops.kpi.summary`.
 */
import { loadConfig } from "../../config/config.js";
import { getLoopsClient } from "../../loops/client.js";
import {
  computeKpiSummary,
  deleteGroup,
  listGroups,
  listSyncLog,
  recordSyncLog,
  upsertGroup,
} from "../../loops/store.js";
import { syncCrmContactsToLoops } from "../../loops/crm-sync.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { getDatabasesStore } from "../../databases/store.js";

type LoopsCfg = {
  apiKey?: string;
  webhookSecret?: string;
  autoSyncMinutes?: number;
  defaultUserGroup?: string;
};

function resolveClient() {
  const cfg = loadConfig() as { loops?: LoopsCfg };
  const client = getLoopsClient(cfg?.loops?.apiKey);
  return { client, cfg };
}

export const loopsHandlers: GatewayRequestHandlers = {
  /** Status: API key configured? Connection live? */
  "loops.status": async ({ respond }) => {
    try {
      const { client, cfg } = resolveClient();
      if (!client) {
        respond(true, { configured: false });
        return;
      }
      const verify = await client.safeVerify();
      respond(true, {
        configured: true,
        connected: verify.ok,
        teamName: verify.teamName,
        error: verify.error,
        autoSyncMinutes: cfg?.loops?.autoSyncMinutes ?? 0,
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Contacts ──────────────────────────────────────────────────

  "loops.contacts.upsert": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as Record<string, unknown>;
      const res = await client.upsertContact(p);
      recordSyncLog({
        kind: "contact",
        action: "upsert",
        target: String(p.email ?? ""),
        success: !!res.success,
      });
      respond(true, res);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.contacts.find": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as { email?: string; userId?: string };
      const contact = await client.findContact(p);
      respond(true, { contact });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.contacts.delete": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as { email?: string; userId?: string };
      const res = await client.deleteContact(p);
      recordSyncLog({
        kind: "contact",
        action: "delete",
        target: p.email ?? p.userId ?? "",
        success: !!res.success,
      });
      respond(true, res);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Mailing lists / groups ────────────────────────────────────

  "loops.lists.list": async ({ respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const lists = await client.listMailingLists();
      respond(true, { lists });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.groups.list": async ({ respond }) => {
    try {
      respond(true, { groups: listGroups() });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.groups.upsert": async ({ params, respond }) => {
    try {
      const p = params as {
        id: string;
        name: string;
        description?: string;
        source: "loops" | "crm-segment";
        filter?: { table: "clients" | "leads"; where?: Record<string, string> };
        memberCount?: number;
        data?: Record<string, unknown>;
      };
      if (!p.id || !p.name || !p.source) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "id, name, source required"),
        );
      }
      upsertGroup({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        source: p.source,
        filter: p.filter ?? null,
        memberCount: p.memberCount ?? 0,
        data: p.data ?? {},
      });
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.groups.delete": async ({ params, respond }) => {
    try {
      const id = (params as { id?: string })?.id;
      if (!id)
        return respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id required"));
      deleteGroup(id);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Custom properties ────────────────────────────────────────

  "loops.properties.list": async ({ respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const properties = await client.listCustomProperties();
      respond(true, { properties });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Events / campaigns trigger ───────────────────────────────

  "loops.events.send": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as {
        email?: string;
        userId?: string;
        eventName: string;
        eventProperties?: Record<string, unknown>;
        mailingLists?: Record<string, boolean>;
      };
      const res = await client.sendEvent(p);
      recordSyncLog({
        kind: "event",
        action: "send",
        target: p.email ?? p.userId ?? "",
        success: !!res.success,
        message: p.eventName,
      });
      respond(true, res);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Transactional ────────────────────────────────────────────

  "loops.transactional.send": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as {
        transactionalId: string;
        email: string;
        dataVariables?: Record<string, unknown>;
        addToAudience?: boolean;
        attachments?: Array<{ filename: string; contentType: string; data: string }>;
      };
      const res = await client.sendTransactional(p);
      recordSyncLog({
        kind: "transactional",
        action: "send",
        target: p.email,
        success: !!res.success,
        message: p.transactionalId,
      });
      respond(true, res);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── CRM sync ────────────────────────────────────────────────

  "loops.sync.crm": async ({ params, respond }) => {
    try {
      const { client } = resolveClient();
      if (!client)
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "loops.apiKey not configured"),
        );
      const p = params as { mailingLists?: Record<string, boolean> };
      const store = getDatabasesStore();
      const result = await syncCrmContactsToLoops(client, store, { mailingLists: p?.mailingLists });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  "loops.sync.log": async ({ params, respond }) => {
    try {
      const limit = Math.max(1, Math.min(500, Number((params as { limit?: number })?.limit) || 50));
      respond(true, { entries: listSyncLog(limit) });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── KPIs / dashboard ─────────────────────────────────────────

  "loops.kpi.summary": async ({ params, respond }) => {
    try {
      const days = Math.max(1, Math.min(365, Number((params as { days?: number })?.days) || 7));
      const summary = computeKpiSummary(days * 86_400_000);
      respond(true, summary);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },

  // ── Config ───────────────────────────────────────────────────

  "loops.config.get": async ({ respond }) => {
    try {
      const cfg = loadConfig() as {
        loops?: {
          apiKey?: string;
          webhookSecret?: string;
          autoSyncMinutes?: number;
          defaultUserGroup?: string;
        };
      };
      const k = cfg?.loops ?? {};
      respond(true, {
        // Mask the API key — UI never needs the full value, just whether one's set.
        hasApiKey: Boolean(k.apiKey),
        apiKeyTail: k.apiKey ? k.apiKey.slice(-4) : null,
        hasWebhookSecret: Boolean(k.webhookSecret),
        autoSyncMinutes: k.autoSyncMinutes ?? 0,
        defaultUserGroup: k.defaultUserGroup ?? "lead",
      });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (e as Error).message));
    }
  },
};
