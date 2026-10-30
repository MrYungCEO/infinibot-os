/**
 * Doc-agent gateway methods. Powers the in-page document agent panel.
 *
 *   doc_agent.spawn — given a doc reference (note id / row id / project
 *   id / workflow id), return the canonical sessionKey + the doc-type
 *   system prompt + the recommended model. The UI uses these to address
 *   chat.send/chat.history against the session and to render the
 *   "instructions" header so the user sees what the agent's been told.
 *
 *   doc_agent.describe — pure read of the constructed prompt for an
 *   already-known sessionKey/docType/docId. Useful when the UI loses
 *   state or wants to refresh the instructions panel.
 *
 *   doc_agent.list — sessions that have been spawned for this doc-type
 *   across the user's data. Lets the /sessions view group "doc agents"
 *   separately from chat threads.
 *
 * The spawn method is intentionally side-effect free except for ensuring
 * a session entry exists (so the /sessions view can label it). It does
 * NOT pre-warm the agent or write the system prompt anywhere — the UI
 * passes the prompt back when it sends the user's first turn so the
 * agent sees it as conversation context. This avoids touching the
 * agent's core run pipeline.
 */

import {
  buildDocAgentSystemPrompt,
  clampModalities,
  DOC_AGENT_CAPABILITIES,
  docAgentSessionKey,
  type DocAgentContext,
  type DocAgentModalities,
  type DocAgentType,
} from "../../agents/doc-agent-prompts.js";
import { DEFAULT_MODEL } from "../../agents/defaults.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  getDocModalitiesForSession,
  getDocScopeForSession,
  setDocModalitiesForSession,
  setDocScopeForSession,
  type DocScope,
} from "../live-action-context.js";
import type { GatewayRequestHandlers } from "./types.js";

const VALID_TYPES: ReadonlySet<DocAgentType> = new Set([
  "note",
  "db_row",
  "workflow",
  "project",
  "kanban_card",
  "content_page",
  "storyboard",
  "whiteboard_doc",
  "video_composition",
  "brand_doc",
  "funnel_page",
  "inbox_thread",
  "generic",
]);

function readString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function readDocType(o: Record<string, unknown>): DocAgentType {
  const v = o.docType;
  if (typeof v === "string" && (VALID_TYPES as Set<string>).has(v)) return v as DocAgentType;
  return "generic";
}

export const docAgentHandlers: GatewayRequestHandlers = {
  "doc_agent.spawn": async ({ params, respond, context: _context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const docType = readDocType(p);
      const documentId = readString(p, "documentId");
      if (!documentId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "documentId is required",
        });
        return;
      }

      const cfg = loadConfig();
      // Honor an explicit agent id from the caller (e.g. when a workspace
      // has multiple agents); default to the user's primary.
      const callerSessionKey = readString(p, "callerSessionKey");
      const agentId =
        readString(p, "agentId") ??
        resolveSessionAgentId({ sessionKey: callerSessionKey, config: cfg }) ??
        "main";

      const ctx: DocAgentContext = {
        docType,
        documentId,
        title: readString(p, "title"),
        content: typeof p.content === "string" ? (p.content as string) : undefined,
        databaseId: readString(p, "databaseId"),
        schema: readString(p, "schema"),
        extra: readString(p, "extra"),
      };

      const sessionKey = docAgentSessionKey(agentId, docType, documentId);
      const systemPrompt = buildDocAgentSystemPrompt(ctx);
      const model = readString(p, "model") ?? DEFAULT_MODEL;

      const capabilities = DOC_AGENT_CAPABILITIES[docType] ?? DOC_AGENT_CAPABILITIES.generic;
      respond(true, {
        sessionKey,
        systemPrompt,
        docType,
        documentId,
        agentId,
        model,
        title: ctx.title ?? null,
        toolProfile: "doc-agent",
        // Hint for the UI: render this in a "Instructions" pin above the
        // chat so the user can see (and edit) what the agent is told.
        editableInstructions: true,
        // Per-docType capability matrix — the UI uses this to decide
        // which modality toggles to render (voice, live-action). The
        // panel still has to call set_modalities to ENABLE any of
        // them.
        capabilities,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  "doc_agent.describe": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const docType = readDocType(p);
      const documentId = readString(p, "documentId");
      if (!documentId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "documentId is required" });
        return;
      }
      const ctx: DocAgentContext = {
        docType,
        documentId,
        title: readString(p, "title"),
        content: typeof p.content === "string" ? (p.content as string) : undefined,
        databaseId: readString(p, "databaseId"),
        schema: readString(p, "schema"),
        extra: readString(p, "extra"),
      };
      respond(true, {
        systemPrompt: buildDocAgentSystemPrompt(ctx),
        docType,
        documentId,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // ── doc_agent.attach_live_action ────────────────────────────────────
  // Register a doc-scoped live-action context for `sessionKey`. After this,
  // the voice-stream / live-action observation routers will:
  //   1. apply the doc-scoped preamble (doc-live-action-prompt.ts) instead
  //      of the grid preamble,
  //   2. filter incoming live-action events through filterEvent(scope, ev)
  //      so the agent only sees events belonging to this document.
  // Returns the registered DocScope so the UI can echo it back in
  // subsequent voice / event-stream POSTs.
  "doc_agent.attach_live_action": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionKey = readString(p, "sessionKey");
      const docType = readDocType(p);
      const documentId = readString(p, "documentId");
      if (!sessionKey) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "sessionKey is required" });
        return;
      }
      if (!documentId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "documentId is required" });
        return;
      }
      const cap = DOC_AGENT_CAPABILITIES[docType] ?? DOC_AGENT_CAPABILITIES.generic;
      if (!cap.liveActionObserve) {
        respond(false, undefined, {
          code: "CAPABILITY_DENIED",
          message: `docType '${docType}' does not support live-action observation`,
        });
        return;
      }
      const scope: DocScope = {
        docType,
        documentId,
        title: readString(p, "title"),
      };
      setDocScopeForSession(sessionKey, scope);
      respond(true, { ok: true, sessionKey, scope });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // ── doc_agent.detach_live_action ────────────────────────────────────
  // Tear down the doc-scoped live-action registration. Called when the
  // panel closes or the user toggles live-action off. Idempotent — safe
  // to call with a sessionKey that wasn't attached.
  "doc_agent.detach_live_action": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionKey = readString(p, "sessionKey");
      if (!sessionKey) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "sessionKey is required" });
        return;
      }
      setDocScopeForSession(sessionKey, null);
      respond(true, { ok: true, sessionKey });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // ── doc_agent.set_modalities ────────────────────────────────────────
  // Stores per-session enabled modalities. The UI requests a set; the
  // server CLAMPS to the docType's capability matrix (you can never opt
  // INTO a modality the type doesn't support). Returns the effective set
  // so the panel can render its toggles against what's actually allowed.
  "doc_agent.set_modalities": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionKey = readString(p, "sessionKey");
      const docType = readDocType(p);
      if (!sessionKey) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "sessionKey is required" });
        return;
      }
      const requested: Partial<DocAgentModalities> = {};
      const m = (p.modalities ?? {}) as Record<string, unknown>;
      if (typeof m.sidePanel === "boolean") requested.sidePanel = m.sidePanel;
      if (typeof m.voice === "boolean") requested.voice = m.voice;
      if (typeof m.liveActionObserve === "boolean")
        requested.liveActionObserve = m.liveActionObserve;
      if (typeof m.liveActionAct === "boolean") requested.liveActionAct = m.liveActionAct;
      const effective = clampModalities(docType, requested);
      setDocModalitiesForSession(sessionKey, effective);
      respond(true, { ok: true, sessionKey, modalities: effective });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },

  // ── doc_agent.get_modalities ────────────────────────────────────────
  // Read-back companion to set_modalities. Returns the current stored
  // modalities and the active DocScope (if any), so a panel that
  // remounts (page nav back) can refresh its toggle state.
  "doc_agent.get_modalities": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionKey = readString(p, "sessionKey");
      if (!sessionKey) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "sessionKey is required" });
        return;
      }
      const modalities = getDocModalitiesForSession(sessionKey);
      const scope = getDocScopeForSession(sessionKey);
      respond(true, {
        sessionKey,
        modalities: modalities ?? null,
        scope: scope ?? null,
      });
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: (err as Error).message ?? String(err),
      });
    }
  },
};
