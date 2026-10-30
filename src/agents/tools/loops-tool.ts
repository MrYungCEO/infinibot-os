/**
 * `loops` agent tool — drives the Loops.so email marketing integration.
 *
 * Single tool with an `action` discriminator (matches the `canvas` tool
 * pattern). Every action proxies through the gateway WS so the result is
 * audited in the loops_sync_log SQLite table and the Email Marketing UI
 * sees the change immediately.
 *
 * Common workflow:
 *   1. `contacts.upsert` to add or refresh a contact.
 *   2. `events.send` to fire a campaign trigger ("welcome", "drip-day-3").
 *   3. `transactional.send` for one-off mail (receipts, password reset).
 *   4. `kpi.summary` to check open/click rates over a window.
 */
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const LOOPS_ACTIONS = [
  "status",
  "contacts.upsert",
  "contacts.find",
  "contacts.delete",
  "lists.list",
  "groups.list",
  "groups.upsert",
  "groups.delete",
  "properties.list",
  "events.send",
  "transactional.send",
  "sync.crm",
  "kpi.summary",
] as const;

const LoopsToolSchema = Type.Object({
  action: stringEnum(LOOPS_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),

  // Common contact identity
  email: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  firstName: Type.Optional(Type.String()),
  lastName: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  userGroup: Type.Optional(Type.String()),
  subscribed: Type.Optional(Type.Boolean()),
  /** Custom properties for upsert. Loops accepts any JSON-scalar field. */
  properties: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** mailingListId → true (add) | false (remove) */
  mailingLists: Type.Optional(Type.Object({}, { additionalProperties: true })),

  // events.send
  eventName: Type.Optional(Type.String()),
  eventProperties: Type.Optional(Type.Object({}, { additionalProperties: true })),

  // transactional.send
  transactionalId: Type.Optional(Type.String()),
  dataVariables: Type.Optional(Type.Object({}, { additionalProperties: true })),
  addToAudience: Type.Optional(Type.Boolean()),

  // groups.upsert
  groupId: Type.Optional(Type.String()),
  groupName: Type.Optional(Type.String()),
  groupDescription: Type.Optional(Type.String()),
  groupSource: Type.Optional(stringEnum(["loops", "crm-segment"])),
  groupFilter: Type.Optional(Type.Object({}, { additionalProperties: true })),
  groupMemberCount: Type.Optional(Type.Number()),

  // kpi.summary
  days: Type.Optional(Type.Number()),
});

function gatewayOpts(params: Record<string, unknown>): GatewayCallOptions {
  return {
    gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
    gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
    timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
  };
}

export function createLoopsTool(): AnyAgentTool {
  return {
    label: "Loops",
    name: "loops",
    description:
      "Email marketing + transactional email via Loops.so. Manage contacts, mailing lists, send campaign-trigger events, send transactional emails, query KPIs (opens/clicks/sends).",
    parameters: LoopsToolSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const opts = gatewayOpts(params);

      switch (action) {
        case "status":
          return jsonResult(await callGatewayTool("loops.status", opts, {}));

        case "contacts.upsert": {
          const email = readStringParam(params, "email");
          const userId = readStringParam(params, "userId");
          if (!email && !userId) throw new Error("contacts.upsert: email or userId required");
          const payload: Record<string, unknown> = {
            email: email || undefined,
            userId: userId || undefined,
            firstName: readStringParam(params, "firstName") || undefined,
            lastName: readStringParam(params, "lastName") || undefined,
            source: readStringParam(params, "source") || undefined,
            userGroup: readStringParam(params, "userGroup") || undefined,
            subscribed: typeof params.subscribed === "boolean" ? params.subscribed : undefined,
          };
          if (params.properties && typeof params.properties === "object") {
            Object.assign(payload, params.properties);
          }
          if (params.mailingLists && typeof params.mailingLists === "object") {
            payload.mailingLists = params.mailingLists;
          }
          return jsonResult(await callGatewayTool("loops.contacts.upsert", opts, payload));
        }

        case "contacts.find": {
          const email = readStringParam(params, "email");
          const userId = readStringParam(params, "userId");
          if (!email && !userId) throw new Error("contacts.find: email or userId required");
          return jsonResult(await callGatewayTool("loops.contacts.find", opts, { email, userId }));
        }

        case "contacts.delete": {
          const email = readStringParam(params, "email");
          const userId = readStringParam(params, "userId");
          if (!email && !userId) throw new Error("contacts.delete: email or userId required");
          return jsonResult(
            await callGatewayTool("loops.contacts.delete", opts, { email, userId }),
          );
        }

        case "lists.list":
          return jsonResult(await callGatewayTool("loops.lists.list", opts, {}));

        case "groups.list":
          return jsonResult(await callGatewayTool("loops.groups.list", opts, {}));

        case "groups.upsert": {
          const id = readStringParam(params, "groupId", { required: true });
          const name = readStringParam(params, "groupName", { required: true });
          const source = (readStringParam(params, "groupSource") || "crm-segment") as
            | "loops"
            | "crm-segment";
          return jsonResult(
            await callGatewayTool("loops.groups.upsert", opts, {
              id,
              name,
              description: readStringParam(params, "groupDescription") || undefined,
              source,
              filter: params.groupFilter ?? undefined,
              memberCount:
                typeof params.groupMemberCount === "number" ? params.groupMemberCount : 0,
            }),
          );
        }

        case "groups.delete": {
          const id = readStringParam(params, "groupId", { required: true });
          return jsonResult(await callGatewayTool("loops.groups.delete", opts, { id }));
        }

        case "properties.list":
          return jsonResult(await callGatewayTool("loops.properties.list", opts, {}));

        case "events.send": {
          const email = readStringParam(params, "email");
          const userId = readStringParam(params, "userId");
          if (!email && !userId) throw new Error("events.send: email or userId required");
          const eventName = readStringParam(params, "eventName", { required: true });
          return jsonResult(
            await callGatewayTool("loops.events.send", opts, {
              email: email || undefined,
              userId: userId || undefined,
              eventName,
              eventProperties: (params.eventProperties as Record<string, unknown>) ?? undefined,
              mailingLists: (params.mailingLists as Record<string, boolean>) ?? undefined,
            }),
          );
        }

        case "transactional.send": {
          const email = readStringParam(params, "email", { required: true });
          const transactionalId = readStringParam(params, "transactionalId", { required: true });
          return jsonResult(
            await callGatewayTool("loops.transactional.send", opts, {
              transactionalId,
              email,
              dataVariables: (params.dataVariables as Record<string, unknown>) ?? undefined,
              addToAudience:
                typeof params.addToAudience === "boolean" ? params.addToAudience : undefined,
            }),
          );
        }

        case "sync.crm":
          return jsonResult(
            await callGatewayTool("loops.sync.crm", opts, {
              mailingLists: (params.mailingLists as Record<string, boolean>) ?? undefined,
            }),
          );

        case "kpi.summary":
          return jsonResult(
            await callGatewayTool("loops.kpi.summary", opts, {
              days: typeof params.days === "number" ? params.days : undefined,
            }),
          );

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
