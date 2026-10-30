/**
 * show_panel — the agent's way to ANSWER WITH A LIVE, INTERACTIVE UI PANEL
 * instead of a wall of text: the live agent mesh, a project, a task, an agent
 * run, the business snapshot, CRM tables, or a generic table.
 * Generalised from the OmniTrade fork's show_panel (9a6ead3f).
 *
 * End to end:
 *   1. This tool calls the `chat.panel.show` RPC, which resolves the kind
 *      through real gateway RPCs (src/chat-panels/resolve.ts) and broadcasts
 *      `chat.panel.show` (display:"modal" panels pop on every connected UI).
 *   2. The tool RESULT carries a data-free `chatPanel` ref. Every chat surface
 *      (webchat, Grid chat, classic chat, voice transcript) detects that ref in
 *      the tool-result block and renders a live inline card — also on history
 *      reload — which re-queries `chat.panel.refresh` on an interval.
 *   3. The result also carries `summary` + a markdown `text` fallback, so on
 *      channels that can't render UI (Telegram, WhatsApp, …) the model simply
 *      replies with the text and the tool never dead-ends.
 *
 * HONESTY: summary/count/empty/error come only from what the RPCs returned.
 */

import { Type } from "@sinclair/typebox";

import {
  allPanelKindDefs,
  describePanelKinds,
  isPanelKind,
  type ChatPanelRef,
} from "../../chat-panels/resolve.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const log = createSubsystemLogger("tools").child("show-panel");

/** Channels that render the InfiniBot UI (anything else gets the text fallback). */
const UI_CHANNELS = new Set(["webchat", "voice"]);

export function isUiChannel(channel?: string | null): boolean {
  if (!channel) return true;
  return UI_CHANNELS.has(channel.trim().toLowerCase());
}

/**
 * Built per tool instance (not at module load): kinds contributed by enabled
 * plugins (e.g. flypic.generation) exist only once the plugin registry loaded.
 */
const showPanelSchema = (kinds: string[]) =>
  Type.Object({
    kind: stringEnum(kinds, {
      description: `Panel type:\n${describePanelKinds()}`,
    }),
    query: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Params for the kind (see each kind above). e.g. project {name:'Robovoice'}, task {id}, " +
            "agent {runId} or {label}, clients {status:'active'}, table {columns:[..], rows:[[..]]}.",
        },
      ),
    ),
    id: Type.Optional(
      Type.String({
        description: "Shorthand for query.id (project / task / agent runId).",
      }),
    ),
    title: Type.Optional(Type.String({ description: "Optional header title override." })),
    display: Type.Optional(
      stringEnum(["inline", "modal"], {
        description:
          "'inline' (default) = compact live card in the chat that can be expanded; " +
          "'modal' = also pop it open full-size right away (use when the user says 'pull up' / 'open').",
      }),
    ),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
  });

export const SHOW_PANEL_TOOL_DESCRIPTION =
  "Answer with a LIVE, INTERACTIVE UI PANEL in the InfiniBot chat instead of a text dump. " +
  "Use it whenever the user asks to SEE / SHOW / PULL UP / OPEN something, or asks the status of a " +
  "project, task, agent, or the business — e.g. 'show me the agent mesh', 'pull up the Robovoice project', " +
  "'what's the status of task X', 'how is the claude coder run doing', 'what agents are running', " +
  "'how's the business', 'show my active clients', 'show the pipeline'. For anything else tabular, " +
  "pass your own rows with kind 'table'. The panel re-queries live data and has a button to the full page. " +
  "The result gives a factual `summary` of what was shown — speak from it in one or two sentences, don't " +
  "repeat the whole panel. On non-UI channels (Telegram, WhatsApp, SMS…) reply with the returned `text`. " +
  "If a lookup fails the result has ok:false + the real reason (with suggestions) — relay it, never invent data.";

export function createShowPanelTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  const kinds = allPanelKindDefs().map((k) => k.id);
  return {
    label: "Show Panel",
    name: "show_panel",
    description: SHOW_PANEL_TOOL_DESCRIPTION,
    parameters: showPanelSchema(kinds),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const kind = typeof params.kind === "string" ? params.kind.trim() : "";
      const kindText: string = kind;
      if (!isPanelKind(kind)) {
        return jsonResult({
          ok: false,
          shown: false,
          error: `unknown panel kind "${kindText}"`,
          validKinds: allPanelKindDefs().map((k) => k.id),
          note: "Call show_panel again with one of validKinds (use 'table' with your own rows for anything else).",
        });
      }
      const query: Record<string, unknown> =
        params.query && typeof params.query === "object" && !Array.isArray(params.query)
          ? { ...(params.query as Record<string, unknown>) }
          : {};
      if (typeof params.id === "string" && params.id.trim() && query.id == null)
        query.id = params.id.trim();
      const title =
        typeof params.title === "string" && params.title.trim() ? params.title.trim() : undefined;
      const display = params.display === "modal" ? "modal" : "inline";
      const ui = isUiChannel(opts?.agentChannel);

      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: typeof params.gatewayUrl === "string" ? params.gatewayUrl : undefined,
        gatewayToken: typeof params.gatewayToken === "string" ? params.gatewayToken : undefined,
        timeoutMs: 30_000,
      };

      try {
        const res = (await callGatewayTool("chat.panel.show", gatewayOpts, {
          kind,
          query,
          title,
          // Non-UI channels never pop a modal on some other screen.
          display: ui ? display : "inline",
          sourceSession: opts?.agentSessionKey,
        })) as {
          panelId?: string;
          title?: string;
          summary?: string;
          count?: number;
          empty?: boolean;
          error?: string | null;
          text?: string;
          ref?: ChatPanelRef;
        };

        if (res.error) {
          log.info("panel error", { kind, error: res.error });
          return jsonResult({
            // The ref is kept so the UI shows the (honest) error state card.
            ...(ui && res.ref ? { chatPanel: res.ref } : {}),
            ok: false,
            kind,
            shown: ui,
            error: res.error,
            summary: res.summary ?? res.error,
            note: "The lookup failed. Relay this reason (and any suggestions in it) to the user; do not invent data.",
          });
        }

        log.info("panel shown", {
          kind,
          count: res.count,
          empty: res.empty,
          ui,
        });
        return jsonResult({
          // FIRST key on purpose: surfaces that truncate long tool output still
          // see the ref (ui/src/ui/chat-panels/panel-ref.ts detects it).
          ...(ui && res.ref ? { chatPanel: res.ref } : {}),
          ok: true,
          kind,
          shown: ui,
          title: res.title,
          count: res.count ?? 0,
          empty: res.empty ?? false,
          summary: res.summary ?? "",
          text: res.text ?? "",
          note: ui
            ? res.empty
              ? "An empty-state panel is on the user's screen. Say nothing matched — do not fabricate rows."
              : "A live panel is now on the user's screen. Reply briefly from `summary`; don't restate the panel. " +
                "If the user is actually on a non-UI channel, reply with `text` instead."
            : "This channel cannot render UI panels — reply with `text` (you may trim it) as your answer.",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("panel show failed", { kind, error: message });
        return jsonResult({
          ok: false,
          kind,
          shown: false,
          error: message,
          summary: `Could not open the ${kind} panel: ${message}`,
          note: "The panel system is unreachable. Answer from other tools (kanban, subagents_list, …) instead.",
        });
      }
    },
  };
}
