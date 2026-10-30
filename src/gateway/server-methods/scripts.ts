/**
 * Scripts Gateway Handlers — exposes the unified script service over RPC.
 *
 * Mirrors the storyboard handler shape so any agent / MCP client can:
 *   scripts.generate   → generateScriptUnified
 *   scripts.refine     → refineScript
 *   scripts.parse      → parseScript (no LLM)
 *   scripts.list       → list rows in a content page's `scripts` child-DB
 *   scripts.get        → fetch one row by id
 */

import {
  generateScriptUnified,
  generateScriptAgentic,
  parseScriptText,
  refineScript,
  type ScriptRequest,
} from "../../content/script-service.js";
import type { ResearchDepth, AgentStreamHooks } from "../../scripts/agent/types.js";
import type { GatewayRequestContext } from "./types.js";
import { randomUUID } from "node:crypto";
import { getContentPagesStore } from "../../content/pages-store.js";
import { getDatabasesStore } from "../../databases/store.js";
import {
  getViralExamplesStore,
  type ViralExampleInput,
} from "../../content/viral-examples-store.js";
import type { Platform } from "../../storyboard/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

function coerceScriptRequest(params: Record<string, unknown>): ScriptRequest {
  return {
    prompt: String(params.prompt ?? ""),
    platform: params.platform as Platform | undefined,
    targetDuration: typeof params.targetDuration === "number" ? params.targetDuration : undefined,
    tone: typeof params.tone === "string" ? params.tone : undefined,
    style: typeof params.style === "string" ? params.style : undefined,
    includeVoiceover:
      typeof params.includeVoiceover === "boolean" ? params.includeVoiceover : undefined,
    research: typeof params.research === "boolean" ? params.research : undefined,
    researchQuery: typeof params.researchQuery === "string" ? params.researchQuery : undefined,
    useExemplars: typeof params.useExemplars === "boolean" ? params.useExemplars : undefined,
    exemplarTopic: typeof params.exemplarTopic === "string" ? params.exemplarTopic : undefined,
    exemplarLimit: typeof params.exemplarLimit === "number" ? params.exemplarLimit : undefined,
    savePageId: typeof params.savePageId === "string" ? params.savePageId : undefined,
    saveAsNote: typeof params.saveAsNote === "boolean" ? params.saveAsNote : undefined,
    title: typeof params.title === "string" ? params.title : undefined,
  };
}

/** Extra fields the agentic path accepts on top of ScriptRequest. */
function coerceAgenticExtras(params: Record<string, unknown>): {
  durationSec?: number;
  persona?: string;
  anglesToExplore?: string[];
  researchDepth?: ResearchDepth;
  maxToolCalls?: number;
  maxWallMs?: number;
} {
  const depth = params.researchDepth;
  return {
    durationSec: typeof params.durationSec === "number" ? params.durationSec : undefined,
    persona: typeof params.persona === "string" ? params.persona : undefined,
    anglesToExplore: Array.isArray(params.anglesToExplore)
      ? (params.anglesToExplore as unknown[]).map(String)
      : undefined,
    researchDepth:
      depth === "shallow" || depth === "standard" || depth === "deep" ? depth : undefined,
    maxToolCalls: typeof params.maxToolCalls === "number" ? params.maxToolCalls : undefined,
    maxWallMs: typeof params.maxWallMs === "number" ? params.maxWallMs : undefined,
  };
}

/**
 * Build streaming hooks that broadcast the agent's trace + checkpoints over WS
 * so the calling client can render a live "thinking" view instead of a blank
 * spinner. Best-effort: dropIfSlow keeps a slow consumer from back-pressuring
 * the run. Events are namespaced by requestId so a client can match a stream to
 * its own request.
 */
function makeStreamHooks(context: GatewayRequestContext, requestId: string): AgentStreamHooks {
  return {
    onTrace: (entry) => {
      context.broadcast("scripts.agent.trace", { requestId, entry }, { dropIfSlow: true });
    },
    onCheckpoint: (info) => {
      context.broadcast("scripts.agent.checkpoint", { requestId, ...info }, { dropIfSlow: true });
    },
  };
}

export const scriptsHandlers: GatewayRequestHandlers = {
  // ─── Generate Script ──────────────────────────────────────────
  // Dispatches the AGENTIC script-agent loop by default (research → exemplars →
  // draft → lint → revise), streaming trace + checkpoint events over WS. Set
  // `agentic: false` to force the legacy one-shot pipeline. The agentic path
  // itself falls back to one-shot when no Anthropic provider is configured, so
  // flipping the default on is always safe.
  "scripts.generate": async ({ params, respond, context }) => {
    try {
      const p = params as Record<string, unknown>;
      const req = coerceScriptRequest(p);
      if (!req.prompt.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "prompt required" });
        return;
      }
      const useAgent = p.agentic !== false;
      const result = useAgent
        ? await generateScriptAgentic(
            { ...req, ...coerceAgenticExtras(p) },
            makeStreamHooks(context, String(p.requestId ?? randomUUID())),
          )
        : await generateScriptUnified(req);
      if (!result.success) {
        respond(false, undefined, {
          code: "GENERATION_FAILED",
          message: result.error || "Script generation failed",
        });
        return;
      }
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Generate Script (explicit agentic RPC) ───────────────────
  // Same as scripts.generate with agentic on, kept as a stable name for callers
  // that want to opt in explicitly.
  "scripts.generateAgentic": async ({ params, respond, context }) => {
    try {
      const p = params as Record<string, unknown>;
      const req = coerceScriptRequest(p);
      if (!req.prompt.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "prompt required" });
        return;
      }
      const requestId = String(p.requestId ?? randomUUID());
      const result = await generateScriptAgentic(
        { ...req, ...coerceAgenticExtras(p) },
        makeStreamHooks(context, requestId),
      );
      if (!result.success) {
        respond(false, undefined, {
          code: "GENERATION_FAILED",
          message: result.error || "Agentic script generation failed",
        });
        return;
      }
      respond(true, { ...result, requestId });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Refine Existing Script ───────────────────────────────────
  "scripts.refine": async ({ params, respond }) => {
    try {
      const scriptText = String((params as Record<string, unknown>).scriptText ?? "");
      const instructions = String((params as Record<string, unknown>).instructions ?? "");
      if (!scriptText.trim() || !instructions.trim()) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "scriptText and instructions required",
        });
        return;
      }
      const result = await refineScript(scriptText, instructions);
      if (!result.success) {
        respond(false, undefined, {
          code: "REFINEMENT_FAILED",
          message: result.error || "Script refinement failed",
        });
        return;
      }
      respond(true, result);
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Parse Script (no LLM) ────────────────────────────────────
  "scripts.parse": async ({ params, respond }) => {
    try {
      const scriptText = String((params as Record<string, unknown>).scriptText ?? "");
      if (!scriptText.trim()) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "scriptText required" });
        return;
      }
      const scenes = parseScriptText(scriptText);
      respond(true, { scenes, count: scenes.length });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── List Scripts (saved under a content page) ────────────────
  "scripts.list": async ({ params, respond }) => {
    try {
      const pageId = (params as Record<string, unknown>).pageId as string | undefined;
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "pageId required" });
        return;
      }
      const pages = getContentPagesStore(getStateDir());
      const page = pages.get(pageId);
      if (!page) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Page not found" });
        return;
      }
      const databaseId = pages.childDatabaseId(page, "scripts");
      const databases = getDatabasesStore(getStateDir());
      const rows = databases.listRows(databaseId);
      respond(true, { databaseId, rows, count: rows.length });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Viral Examples Library ───────────────────────────────────
  // Library of transcribed viral videos used as style exemplars when
  // generating scripts. Retrieved by topic/platform match and injected into
  // the generator's system prompt (see content/script-service.ts).
  "viralExamples.list": async ({ params, respond }) => {
    try {
      const p = (params || {}) as Record<string, unknown>;
      const store = getViralExamplesStore(getStateDir());
      const platform =
        typeof p.platform === "string" ? (p.platform as Platform | "any") : undefined;
      const tag = typeof p.tag === "string" ? p.tag : undefined;
      const examples = store.list({ platform, tag });
      respond(true, { examples, count: examples.length });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "viralExamples.get": async ({ params, respond }) => {
    try {
      const id = String((params as Record<string, unknown>).id ?? "");
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const store = getViralExamplesStore(getStateDir());
      const example = store.get(id);
      if (!example) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Example not found" });
        return;
      }
      respond(true, { example });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "viralExamples.upsert": async ({ params, respond }) => {
    try {
      const p = (params || {}) as Record<string, unknown>;
      const transcript = String(p.transcript ?? "").trim();
      if (!transcript) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "transcript required" });
        return;
      }
      const input: ViralExampleInput = {
        id: typeof p.id === "string" ? p.id : undefined,
        title: String(p.title ?? "").trim() || "Untitled exemplar",
        platform: typeof p.platform === "string" ? (p.platform as Platform | "any") : "any",
        sourceUrl: typeof p.sourceUrl === "string" ? p.sourceUrl : undefined,
        hook: typeof p.hook === "string" ? p.hook : undefined,
        transcript,
        structureNotes: typeof p.structureNotes === "string" ? p.structureNotes : undefined,
        tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [],
        durationSec: typeof p.durationSec === "number" ? p.durationSec : undefined,
        engagement:
          p.engagement && typeof p.engagement === "object"
            ? (p.engagement as ViralExampleInput["engagement"])
            : undefined,
      };
      const store = getViralExamplesStore(getStateDir());
      const example = store.upsert(input);
      respond(true, { example });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "viralExamples.delete": async ({ params, respond }) => {
    try {
      const id = String((params as Record<string, unknown>).id ?? "");
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const store = getViralExamplesStore(getStateDir());
      const removed = store.delete(id);
      respond(true, { removed });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "viralExamples.retrieve": async ({ params, respond }) => {
    try {
      const p = (params || {}) as Record<string, unknown>;
      const topic = String(p.topic ?? "").trim();
      if (!topic) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "topic required" });
        return;
      }
      const store = getViralExamplesStore(getStateDir());
      const examples = store.retrieveBest({
        topic,
        platform: typeof p.platform === "string" ? (p.platform as Platform) : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      });
      respond(true, { examples, count: examples.length });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // Alias of viralExamples.retrieve under the tool-surface name the script
  // agent uses. Same keyword-overlap retrieval.
  "viralExamples.search": async ({ params, respond }) => {
    try {
      const p = (params || {}) as Record<string, unknown>;
      const topic = String(p.query ?? p.topic ?? "").trim();
      if (!topic) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "query required" });
        return;
      }
      const store = getViralExamplesStore(getStateDir());
      const examples = store.retrieveBest({
        topic,
        platform: typeof p.platform === "string" ? (p.platform as Platform) : undefined,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      });
      respond(true, { examples, count: examples.length });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // Parsed HOOK/beats/CTA of one exemplar (tool-surface name).
  "viralExamples.getStructure": async ({ params, respond }) => {
    try {
      const id = String(
        (params as Record<string, unknown>).exampleId ??
          (params as Record<string, unknown>).id ??
          "",
      );
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "exampleId required" });
        return;
      }
      const store = getViralExamplesStore(getStateDir());
      const example = store.get(id);
      if (!example) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Example not found" });
        return;
      }
      const beats = parseScriptText(example.transcript);
      respond(true, { example, hook: example.hook, beats, structureNotes: example.structureNotes });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  // ─── Get One Saved Script ─────────────────────────────────────
  "scripts.get": async ({ params, respond }) => {
    try {
      const rowId = (params as Record<string, unknown>).rowId as string | undefined;
      if (!rowId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "rowId required" });
        return;
      }
      const databases = getDatabasesStore(getStateDir());
      const row = databases.getRow(rowId);
      if (!row) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Script row not found" });
        return;
      }
      respond(true, { row });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};
