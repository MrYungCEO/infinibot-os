/**
 * Proactive MCP tool — surfaces proactive.emit/emitMedia/list/ack/snooze/dismiss
 * to MCP clients (Claude Coder, Codex, external callers) without requiring a WS
 * connection or /rpc HTTP access.
 *
 * emit/emitMedia route through emitProactiveServerSide (persist + broadcast in
 * one call). dedupKey is auto-derived when omitted so callers don't need to
 * think about it: mcp:<agentId>:sha1(title|body):<1-minute bucket>.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { emitProactiveServerSide } from "../../proactive/emit.js";
import { getPopupStore } from "../../proactive/popup-store.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  TIER_ORDER,
  POPUP_INTERACT_OPS,
  validatePopupMedia,
  validatePopupInteract,
} from "../../proactive/popup-types.js";
import { getGatewayBroadcaster } from "../coder-runtime/subagent-broadcast.js";
import type { PopupTier } from "../../proactive/popup-types.js";

const ACTIONS = ["emit", "emitMedia", "interact", "list", "ack", "snooze", "dismiss"] as const;

const ProactiveToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  // ── emit / emitMedia ───────────────────────────────────────────────────────
  tier: Type.Optional(
    Type.String({
      description: `Severity tier: ${TIER_ORDER.join(" | ")}. Defaults to NOTABLE for emitMedia.`,
    }),
  ),
  title: Type.Optional(Type.String({ description: "Required for emit/emitMedia." })),
  body: Type.Optional(Type.String({ description: "Markdown body. Optional." })),
  /** Attribution fields (flat, reconstructed into PopupAttribution). */
  agentId: Type.Optional(
    Type.String({
      description: "Attribution agent ID (defaults to the calling agent's ID).",
    }),
  ),
  agentName: Type.Optional(Type.String({ description: "Human-readable agent name." })),
  cardId: Type.Optional(Type.String({ description: "Linked kanban card ID." })),
  goalId: Type.Optional(Type.String({ description: "Linked autonomy goal ID." })),
  dedupKey: Type.Optional(
    Type.String({
      description: "Idempotency key. Auto-derived from title+body+minuteBucket when omitted.",
    }),
  ),
  voice: Type.Optional(Type.String({ description: "Optional voice readout text." })),
  /** Optional rich media block (JSON string of {kind, payload}). */
  mediaKind: Type.Optional(
    Type.String({
      description:
        "Media kind: agent-summary | note | workflow | activity | custom | " +
        "stylized-markdown | pdf | html | image | video | card-deck.",
    }),
  ),
  mediaPayload: Type.Optional(
    Type.String({ description: "JSON string of the media payload for the selected kind." }),
  ),
  // ── interact (live overlay control) ─────────────────────────────────────────
  eventId: Type.Optional(
    Type.String({ description: "Target event id (interact). From a prior emit's event.id." }),
  ),
  op: Type.Optional(
    Type.String({ description: `Interact op: ${POPUP_INTERACT_OPS.join(" | ")}.` }),
  ),
  elementId: Type.Optional(
    Type.String({ description: "Timeline element id (highlight / scrollTo / replaceElement)." }),
  ),
  markdown: Type.Optional(
    Type.String({ description: "Markdown for replaceElement / appendElement interact ops." }),
  ),
  // ── list ──────────────────────────────────────────────────────────────────
  since: Type.Optional(Type.Number({ description: "Unix-ms lower bound for list." })),
  limit: Type.Optional(Type.Number({ description: "Max events to return (list). Default 50." })),
  // ── ack / snooze / dismiss ────────────────────────────────────────────────
  id: Type.Optional(Type.String({ description: "Event ID (ack / snooze / dismiss)." })),
  actionId: Type.Optional(Type.String({ description: "Action id to record (ack)." })),
  duration: Type.Optional(
    Type.String({ description: "Snooze duration: '1h' | '1d' | 'week' | '<n>m|h|d|w'." }),
  ),
  reason: Type.Optional(Type.String({ description: "Dismiss reason." })),
});

function autoDedup(agentId: string, title: string, body: string): string {
  const hash = createHash("sha1").update(`${title}|${body}`).digest("hex").slice(0, 12);
  const bucket = Math.floor(Date.now() / 60_000);
  return `mcp:${agentId}:${hash}:${bucket}`;
}

function parseSnoozeDuration(d: string): number | null {
  const named: Record<string, number> = {
    "1h": 3_600_000,
    "1d": 86_400_000,
    week: 604_800_000,
    "1w": 604_800_000,
  };
  const s = d.trim().toLowerCase();
  if (named[s]) return named[s];
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]]!;
    return n * unit;
  }
  return null;
}

export function createProactiveTool(options?: { agentId?: string }): AnyAgentTool {
  const defaultAgentId = options?.agentId ?? "mcp";

  return {
    label: "Proactive",
    name: "proactive",
    description:
      "Surface pop-up notifications in the InfiniBot UI from any agent or external caller. " +
      "Actions: " +
      "emit (push a CRITICAL/NOTABLE/FYI/AMBIENT interrupt; title required), " +
      "emitMedia (emit with a typed rich-media card — agent-summary/note/workflow/activity/custom/" +
      "stylized-markdown/pdf/html/image/video/card-deck), " +
      "interact (drive an already-shown overlay live: highlight/scrollTo/replaceElement/appendElement/" +
      "next/prev/revealAll/dismiss an element by eventId+op), " +
      "list (fetch recent events; optional since/limit), " +
      "ack (mark an event as acted), " +
      "snooze (snooze for 1h/1d/week or a duration like '30m'), " +
      "dismiss (remove from feed with an optional reason). " +
      "dedupKey is auto-derived (mcp:<agentId>:sha1(title|body):<minuteBucket>) when omitted. " +
      "Requires gateway restart after install to activate MCP surface.",
    parameters: ProactiveToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      try {
        const action = readStringParam(params, "action", { required: true });
        const stateDir = resolveStateDir();

        // ── emit ────────────────────────────────────────────────────────────
        if (action === "emit" || action === "emitMedia") {
          const title = readStringParam(params, "title");
          if (!title) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "title is required for emit/emitMedia",
            });
          }

          const body = readStringParam(params, "body") ?? "";
          const agentId = readStringParam(params, "agentId") ?? defaultAgentId;
          const agentName = readStringParam(params, "agentName");
          const cardId = readStringParam(params, "cardId");
          const goalId = readStringParam(params, "goalId");
          const voice = readStringParam(params, "voice");

          const dedupKey = readStringParam(params, "dedupKey") ?? autoDedup(agentId, title, body);

          let tier: PopupTier;
          if (action === "emitMedia") {
            const rawTier = readStringParam(params, "tier")?.toUpperCase();
            tier = (TIER_ORDER.includes(rawTier as PopupTier) ? rawTier : "NOTABLE") as PopupTier;
          } else {
            const rawTier = readStringParam(params, "tier")?.toUpperCase();
            if (!rawTier || !TIER_ORDER.includes(rawTier as PopupTier)) {
              return jsonResult({
                status: "error",
                code: "INVALID_TIER",
                message: `tier must be one of ${TIER_ORDER.join(", ")}`,
              });
            }
            tier = rawTier as PopupTier;
          }

          // Build optional media block.
          let media: ReturnType<typeof validatePopupMedia>["media"] = undefined;
          const mediaKind = readStringParam(params, "mediaKind");
          const mediaPayloadRaw = readStringParam(params, "mediaPayload");
          if (mediaKind) {
            let mediaPayloadObj: unknown = {};
            if (mediaPayloadRaw) {
              try {
                mediaPayloadObj = JSON.parse(mediaPayloadRaw);
              } catch {
                return jsonResult({
                  status: "error",
                  code: "INVALID_MEDIA",
                  message: "mediaPayload must be valid JSON",
                });
              }
            }
            const v = validatePopupMedia({ kind: mediaKind, payload: mediaPayloadObj });
            if (v.error) {
              return jsonResult({ status: "error", code: "INVALID_MEDIA", message: v.error });
            }
            media = v.media;
          }

          if (action === "emitMedia" && !media) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "emitMedia requires mediaKind + mediaPayload",
            });
          }

          const emitInput = {
            tier,
            title,
            body,
            attribution: {
              agentId,
              agentName,
              cardId,
              goalId,
            },
            dedupKey,
            voice,
            media,
          };

          // Always call in-process: this tool is registered server-side and always
          // has direct access to emitProactiveServerSide. The broadcaster-null case
          // is handled by the queue-and-flush in emit.ts.
          const built = emitProactiveServerSide(emitInput, stateDir);
          if (!built) {
            return jsonResult({ status: "error", message: "emit failed (see gateway logs)" });
          }
          return jsonResult({ status: "ok", event: built.event, routing: built.routing });
        }

        // ── interact (drive a live overlay) ──────────────────────────────────
        if (action === "interact") {
          const v = validatePopupInteract({
            eventId: readStringParam(params, "eventId"),
            op: readStringParam(params, "op"),
            elementId: readStringParam(params, "elementId"),
            markdown: readStringParam(params, "markdown"),
          });
          if (v.error) {
            return jsonResult({ status: "error", code: "INVALID_PARAMS", message: v.error });
          }
          const store = getPopupStore(stateDir);
          if (!store.get(v.interact!.eventId)) {
            return jsonResult({
              status: "error",
              code: "NOT_FOUND",
              message: `event ${v.interact!.eventId} not found`,
            });
          }
          const broadcast = getGatewayBroadcaster();
          if (broadcast) {
            try {
              broadcast("proactive.interact", { interact: v.interact });
            } catch {
              /* non-fatal — overlay may not be open */
            }
          }
          return jsonResult({ status: "ok", interact: v.interact });
        }

        // ── list ────────────────────────────────────────────────────────────
        if (action === "list") {
          const since = typeof params.since === "number" ? params.since : undefined;
          const limit = typeof params.limit === "number" ? params.limit : 50;
          const store = getPopupStore(stateDir);
          const events = store.list({ since, limit });
          return jsonResult({
            status: "ok",
            count: events.length,
            events,
            serverTime: Date.now(),
          });
        }

        // ── ack ─────────────────────────────────────────────────────────────
        if (action === "ack") {
          const id = readStringParam(params, "id");
          if (!id) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "id is required",
            });
          }
          const actionId = readStringParam(params, "actionId") ?? "ack";
          const store = getPopupStore(stateDir);
          const event = store.ack(id, actionId);
          if (!event) {
            return jsonResult({
              status: "error",
              code: "NOT_FOUND",
              message: `event ${id} not found`,
            });
          }
          return jsonResult({ status: "ok", event });
        }

        // ── snooze ──────────────────────────────────────────────────────────
        if (action === "snooze") {
          const id = readStringParam(params, "id");
          if (!id) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "id is required",
            });
          }
          const durationStr = readStringParam(params, "duration") ?? "1h";
          const ms = parseSnoozeDuration(durationStr);
          if (ms == null) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "duration must be '1h' | '1d' | 'week' | '<n>m|h|d|w'",
            });
          }
          const store = getPopupStore(stateDir);
          const now = Date.now();
          const event = store.snooze(id, now + ms, now);
          if (!event) {
            return jsonResult({
              status: "error",
              code: "NOT_FOUND",
              message: `event ${id} not found`,
            });
          }
          return jsonResult({ status: "ok", event });
        }

        // ── dismiss ─────────────────────────────────────────────────────────
        if (action === "dismiss") {
          const id = readStringParam(params, "id");
          if (!id) {
            return jsonResult({
              status: "error",
              code: "INVALID_PARAMS",
              message: "id is required",
            });
          }
          const reason = readStringParam(params, "reason") ?? "dismissed via MCP";
          const store = getPopupStore(stateDir);
          const event = store.dismiss(id, reason);
          if (!event) {
            return jsonResult({
              status: "error",
              code: "NOT_FOUND",
              message: `event ${id} not found`,
            });
          }
          return jsonResult({ status: "ok", event });
        }

        return jsonResult({ status: "error", message: `Unknown action: ${action}` });
      } catch (e) {
        return jsonResult({ status: "error", message: String(e) });
      }
    },
  };
}
