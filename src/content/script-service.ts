/**
 * Script Service — single source of truth for script generation across
 * gateway, MCP, and in-process agent tools.
 *
 * Wraps the existing storyboard `generateScript()` (so we don't duplicate
 * provider logic) and adds:
 *   - optional research injection (research-service contract)
 *   - persistence to a content page's `scripts` child-DB
 *   - persistence to the Notes store
 *   - a `refineScript()` helper that re-runs generation with revision instructions
 */

import { generateScript, parseScript, type ParsedScene } from "../storyboard/script-generator.js";
import type { Platform, ScriptExemplar, ScriptGenOptions } from "../storyboard/types.js";
import { bundleToPromptBlock, gatherResearch, type ResearchBundle } from "./research-service.js";
import { getContentPagesStore } from "./pages-store.js";
import { getDatabasesStore } from "../databases/store.js";
import { NoteStore } from "../notes/store.js";
import { getViralExamplesStore, toExemplar } from "./viral-examples-store.js";
import { runScriptAgent } from "../scripts/agent/script-agent.js";
import type {
  AgentStreamHooks,
  AgenticScriptRequest,
  ResearchDepth,
  TraceEntry,
} from "../scripts/agent/types.js";
import type { LintResult } from "../scripts/agent/viral-lint.js";

export type { ParsedScene };

export interface ScriptRequest {
  prompt: string;
  platform?: Platform;
  /** Minutes; default 1. */
  targetDuration?: number;
  tone?: string;
  style?: string;
  /** Default true. */
  includeVoiceover?: boolean;
  /** When true, gather research before generation. Default false. */
  research?: boolean;
  /** Override the research query (defaults to `prompt`). */
  researchQuery?: string;
  /** When true (default), retrieve viral-video exemplars and inject as style guidance. */
  useExemplars?: boolean;
  /** Override the exemplar retrieval topic (defaults to `prompt`). */
  exemplarTopic?: string;
  /** Max exemplars to inject (default 3, hard-capped at 3 in the prompt). */
  exemplarLimit?: number;
  /** If set, upsert into the page's `scripts` child-DB. */
  savePageId?: string;
  /** If set, also save the script as a note. */
  saveAsNote?: boolean;
  /** Optional explicit title for saved artifacts. */
  title?: string;
}

export interface ScriptResponse {
  success: boolean;
  script?: string;
  scenes?: ParsedScene[];
  estimatedDuration?: number;
  research?: ResearchBundle;
  /** Non-fatal warnings (e.g. research timed out, note save failed). */
  warnings?: string[];
  savedTo?: { noteId?: string; pageRowId?: string };
  /** Exemplars actually fed to the LLM (for UI surfacing / debugging). */
  exemplarsUsed?: ScriptExemplar[];
  /** Agentic path only: full tool-call + draft trace ("why this script"). */
  trace?: TraceEntry[];
  /** Agentic path only: final viral-structure lint result. */
  lint?: LintResult;
  /** Agentic path only: how the agent loop terminated. */
  stopReason?: string;
  /** Which engine produced this — "agent" (tool loop) or "oneshot" (legacy). */
  engine?: "agent" | "oneshot";
  error?: string;
}

function stateDir(): string {
  return process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

function defaultTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || "Untitled script";
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `script-${Date.now()}`
  );
}

/**
 * Unified script generation. Optionally injects research and persists to
 * notes / content-page child-DB. Always returns a ScriptResponse — never
 * throws for "soft" failures like research timeouts (those land in `warnings`).
 */
export async function generateScriptUnified(req: ScriptRequest): Promise<ScriptResponse> {
  if (!req.prompt || !req.prompt.trim()) {
    return { success: false, error: "prompt required" };
  }

  const warnings: string[] = [];
  let bundle: ResearchBundle | undefined;
  let promptForLLM = req.prompt;

  if (req.research) {
    try {
      bundle = await gatherResearch({
        query: req.researchQuery ?? req.prompt,
        timeoutMs: 12000,
      });
      const block = bundleToPromptBlock(bundle);
      if (block && block.trim()) {
        // Research goes ABOVE the topic with an explicit instruction so the
        // model treats the stats/quotes as ammo, not background reading.
        promptForLLM = `${block}\n\n---\n\nUSE THE FACTS / STATS / QUOTES ABOVE AS AMMUNITION — drop at least one specific stat, name, or quote into the script. Do not paraphrase generic claims when a concrete number is available above.\n\nTOPIC:\n${req.prompt}`;
      }
    } catch (err) {
      warnings.push(
        `research_failed: ${err instanceof Error ? err.message : String(err)} — falling back to non-research generation`,
      );
      bundle = undefined;
    }
  }

  const platform: Platform = req.platform ?? "custom";

  // Retrieve viral exemplars unless explicitly disabled. Default ON so the
  // mobile editor (which can't easily pass new flags through) gets the upgrade
  // automatically. Failures degrade silently to a warning.
  let exemplars: ScriptExemplar[] | undefined;
  const useExemplars = req.useExemplars !== false;
  if (useExemplars) {
    try {
      const store = getViralExamplesStore(stateDir());
      const matches = store.retrieveBest({
        topic: req.exemplarTopic || req.prompt,
        platform: platform === "custom" ? undefined : platform,
        limit: Math.max(1, Math.min(3, req.exemplarLimit ?? 3)),
      });
      if (matches.length > 0) {
        exemplars = matches.map((m) => toExemplar(m));
      }
    } catch (err) {
      warnings.push(
        `exemplars_failed: ${err instanceof Error ? err.message : String(err)} — generating without style exemplars`,
      );
    }
  }

  const opts: ScriptGenOptions = {
    prompt: promptForLLM,
    platform,
    targetDuration: req.targetDuration ?? 1,
    tone: req.tone,
    style: req.style,
    includeVoiceover: req.includeVoiceover ?? true,
    exemplars,
  };

  const result = await generateScript(opts);
  if (!result.success || !result.script) {
    return {
      success: false,
      error: result.error || "Script generation failed",
      research: bundle,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  const scenes = parseScript(result.script);
  const response: ScriptResponse = {
    success: true,
    script: result.script,
    scenes,
    estimatedDuration: result.estimatedDuration,
    research: bundle,
    exemplarsUsed: exemplars,
    warnings: warnings.length ? warnings : undefined,
  };

  const savedTo: { noteId?: string; pageRowId?: string } = {};

  if (req.savePageId) {
    try {
      const pages = getContentPagesStore(stateDir());
      const page = pages.get(req.savePageId);
      if (!page) {
        warnings.push(`save_page_failed: page not found (${req.savePageId})`);
      } else {
        const databaseId = pages.childDatabaseId(page, "scripts");
        const databases = getDatabasesStore(stateDir());
        const title = req.title || defaultTitle(req.prompt);
        const row = databases.upsertRow({
          databaseId,
          title,
          body: result.script,
          values: {
            platform: { type: "richText", markdown: opts.platform },
            durationMinutes: { type: "number", value: opts.targetDuration },
            estimatedDurationMinutes: {
              type: "number",
              value: result.estimatedDuration ?? null,
            },
            tone: { type: "richText", markdown: opts.tone ?? "" },
            style: { type: "richText", markdown: opts.style ?? "" },
            researchUsed: { type: "checkbox", checked: !!bundle },
          },
        });
        savedTo.pageRowId = row.id;
      }
    } catch (err) {
      warnings.push(`save_page_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (req.saveAsNote) {
    try {
      const notes = new NoteStore(stateDir());
      const baseName = req.title || defaultTitle(req.prompt);
      // Idempotent: include a short timestamp tail so repeated calls don't collide.
      const id = `${slugify(baseName)}-${Date.now().toString(36)}`;
      const note = notes.create({
        id,
        name: baseName,
        description: `Generated script — ${opts.platform}, ~${opts.targetDuration} min`,
        tags: ["script", "ai-generated", opts.platform],
        category: "scripts",
        body: result.script,
      });
      savedTo.noteId = note.id;
    } catch (err) {
      warnings.push(`save_note_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (savedTo.noteId || savedTo.pageRowId) response.savedTo = savedTo;
  if (warnings.length) response.warnings = warnings;

  return response;
}

/**
 * Persist a generated script to a content page's `scripts` child-DB and/or the
 * Notes store. Shared by the one-shot and agentic paths. Mutates `warnings` and
 * returns the saved ids.
 */
function persistScript(
  req: { savePageId?: string; saveAsNote?: boolean; title?: string; prompt: string },
  script: string,
  meta: {
    platform: string;
    durationMinutes: number;
    estimatedDuration?: number;
    tone?: string;
    style?: string;
    researchUsed: boolean;
  },
  warnings: string[],
): { noteId?: string; pageRowId?: string } {
  const savedTo: { noteId?: string; pageRowId?: string } = {};
  if (req.savePageId) {
    try {
      const pages = getContentPagesStore(stateDir());
      const page = pages.get(req.savePageId);
      if (!page) {
        warnings.push(`save_page_failed: page not found (${req.savePageId})`);
      } else {
        const databaseId = pages.childDatabaseId(page, "scripts");
        const databases = getDatabasesStore(stateDir());
        const title = req.title || defaultTitle(req.prompt);
        const row = databases.upsertRow({
          databaseId,
          title,
          body: script,
          values: {
            platform: { type: "richText", markdown: meta.platform },
            durationMinutes: { type: "number", value: meta.durationMinutes },
            estimatedDurationMinutes: { type: "number", value: meta.estimatedDuration ?? null },
            tone: { type: "richText", markdown: meta.tone ?? "" },
            style: { type: "richText", markdown: meta.style ?? "" },
            researchUsed: { type: "checkbox", checked: meta.researchUsed },
          },
        });
        savedTo.pageRowId = row.id;
      }
    } catch (err) {
      warnings.push(`save_page_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (req.saveAsNote) {
    try {
      const notes = new NoteStore(stateDir());
      const baseName = req.title || defaultTitle(req.prompt);
      const id = `${slugify(baseName)}-${Date.now().toString(36)}`;
      const note = notes.create({
        id,
        name: baseName,
        description: `Generated script — ${meta.platform}, ~${meta.durationMinutes} min`,
        tags: ["script", "ai-generated", meta.platform],
        category: "scripts",
        body: script,
      });
      savedTo.noteId = note.id;
    } catch (err) {
      warnings.push(`save_note_failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return savedTo;
}

/**
 * AGENTIC script generation. Dispatches the script-agent tool loop (research →
 * exemplars → draft → lint → revise) and maps the result onto the same
 * ScriptResponse shape callers already expect, plus `trace`/`lint`. Falls back
 * to the one-shot pipeline when no Anthropic provider is configured so callers
 * never hard-fail by flipping the flag on.
 */
export async function generateScriptAgentic(
  req: ScriptRequest & {
    durationSec?: number;
    persona?: string;
    anglesToExplore?: string[];
    researchDepth?: ResearchDepth;
    maxToolCalls?: number;
    maxWallMs?: number;
  },
  hooks: AgentStreamHooks = {},
): Promise<ScriptResponse> {
  if (!req.prompt || !req.prompt.trim()) return { success: false, error: "prompt required" };

  const agentReq: AgenticScriptRequest = {
    prompt: req.prompt,
    platform: req.platform,
    durationSec: req.durationSec,
    targetDuration: req.targetDuration,
    persona: req.persona,
    tone: req.tone,
    style: req.style,
    anglesToExplore: req.anglesToExplore,
    researchDepth: req.researchDepth ?? (req.research === false ? "shallow" : "standard"),
    includeVoiceover: req.includeVoiceover,
    maxToolCalls: req.maxToolCalls,
    maxWallMs: req.maxWallMs,
  };

  const result = await runScriptAgent(agentReq, hooks);

  // No provider for the tool loop → transparently fall back to one-shot.
  if (!result.success && result.stopReason === "no_provider") {
    const fallback = await generateScriptUnified(req);
    fallback.engine = "oneshot";
    fallback.warnings = [
      ...(fallback.warnings ?? []),
      "agentic_unavailable: no Anthropic provider — used one-shot pipeline",
    ];
    return fallback;
  }

  if (!result.success || !result.script) {
    return {
      success: false,
      engine: "agent",
      error: result.error || "Agentic generation failed",
      trace: result.trace,
      warnings: result.warnings,
    };
  }

  const platform: Platform = req.platform ?? "custom";
  const durationMinutes = req.targetDuration ?? (req.durationSec ? req.durationSec / 60 : 1);
  const warnings = [...(result.warnings ?? [])];
  const savedTo = persistScript(
    req,
    result.script,
    {
      platform: String(platform),
      durationMinutes,
      estimatedDuration: result.estimatedDuration,
      tone: req.tone,
      style: req.style,
      researchUsed: !!result.research,
    },
    warnings,
  );

  const response: ScriptResponse = {
    success: true,
    engine: "agent",
    script: result.script,
    scenes: result.scenes,
    estimatedDuration: result.estimatedDuration,
    research: result.research,
    trace: result.trace,
    lint: result.lint,
    stopReason: result.stopReason,
    warnings: warnings.length ? warnings : undefined,
  };
  if (savedTo.noteId || savedTo.pageRowId) response.savedTo = savedTo;
  return response;
}

/**
 * Refine an existing script by re-running generation with revision instructions
 * prepended. Reuses the same provider order.
 */
export async function refineScript(
  scriptText: string,
  instructions: string,
): Promise<ScriptResponse> {
  if (!scriptText || !scriptText.trim()) {
    return { success: false, error: "scriptText required" };
  }
  if (!instructions || !instructions.trim()) {
    return { success: false, error: "instructions required" };
  }

  const composedPrompt =
    `Revise the following script according to the instructions. ` +
    `Preserve the [SCENE X: Title] / VISUAL / VOICEOVER / DURATION structure.\n\n` +
    `INSTRUCTIONS:\n${instructions}\n\n` +
    `EXISTING SCRIPT:\n${scriptText}`;

  const result = await generateScript({
    prompt: composedPrompt,
    platform: "custom",
    targetDuration: 1,
    includeVoiceover: true,
  });

  if (!result.success || !result.script) {
    return { success: false, error: result.error || "Refinement failed" };
  }

  return {
    success: true,
    script: result.script,
    scenes: parseScript(result.script),
    estimatedDuration: result.estimatedDuration,
  };
}

/** Pure parse — no LLM call. */
export function parseScriptText(scriptText: string): ParsedScene[] {
  return parseScript(scriptText);
}
