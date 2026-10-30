/**
 * Script agent tool — in-process wrapper over the unified script service.
 * Lets any InfiniBot agent generate, refine, or parse video scripts without
 * round-tripping through the gateway.
 */

import { Type } from "@sinclair/typebox";

import {
  generateScriptAgentic,
  generateScriptUnified,
  parseScriptText,
  refineScript,
  type ScriptRequest,
} from "../../content/script-service.js";
import type { Platform } from "../../storyboard/types.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const SCRIPT_ACTIONS = ["generate", "refine", "parse"] as const;
const PLATFORMS: Platform[] = ["youtube", "tiktok", "shorts", "instagram", "custom"];

const ScriptToolSchema = Type.Object({
  action: stringEnum(SCRIPT_ACTIONS),
  /** Topic / brief for generation. */
  prompt: Type.Optional(Type.String({ description: "Topic or brief for the script (generate)." })),
  /** Target platform. */
  platform: Type.Optional(
    stringEnum(PLATFORMS, { description: "Target platform; defaults to 'custom'." }),
  ),
  /** Length in minutes. */
  targetDuration: Type.Optional(
    Type.Number({ description: "Target length in minutes (default 1)." }),
  ),
  tone: Type.Optional(Type.String({ description: "Voice/tone (e.g. 'serious', 'casual')." })),
  style: Type.Optional(Type.String({ description: "Style (e.g. 'educational', 'documentary')." })),
  includeVoiceover: Type.Optional(
    Type.Boolean({ description: "Include VOICEOVER blocks (default true)." }),
  ),
  /** Run free-API research before generation. */
  research: Type.Optional(
    Type.Boolean({
      description:
        "When true, gather research from free sources first and inject it into the prompt.",
    }),
  ),
  /** Use the agentic viral pipeline (research → exemplars → draft → lint → revise). */
  agentic: Type.Optional(
    Type.Boolean({
      description:
        "When true (generate), use the agentic viral tool-loop with exemplar grounding and " +
        "lint-driven revision instead of the one-shot pipeline. Recommended for short-form reels.",
    }),
  ),
  researchQuery: Type.Optional(
    Type.String({ description: "Override research query (defaults to prompt)." }),
  ),
  /** Save script under a content page's `scripts` child-DB. */
  savePageId: Type.Optional(
    Type.String({ description: "Content-page ID to attach the generated script to." }),
  ),
  saveAsNote: Type.Optional(
    Type.Boolean({ description: "Also save the script to the Notes store." }),
  ),
  title: Type.Optional(Type.String({ description: "Optional title for saved artifacts." })),
  /** For refine action. */
  scriptText: Type.Optional(Type.String({ description: "Existing script text (refine/parse)." })),
  instructions: Type.Optional(
    Type.String({ description: "Revision instructions (refine action)." }),
  ),
});

export function createScriptTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Script",
    name: "script",
    description:
      "Generate, refine, or parse video scripts. Actions: " +
      "'generate' (LLM-backed; supports optional research + persistence to a content page or note), " +
      "'refine' (revise an existing script using instructions), " +
      "'parse' (split a script into structured scenes — no LLM call).",
    parameters: ScriptToolSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) {
        const err = new Error("Script tool aborted");
        err.name = "AbortError";
        throw err;
      }
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "parse") {
        const scriptText = readStringParam(params, "scriptText", { required: true });
        const scenes = parseScriptText(scriptText);
        return jsonResult({ scenes, count: scenes.length });
      }

      if (action === "refine") {
        const scriptText = readStringParam(params, "scriptText", { required: true });
        const instructions = readStringParam(params, "instructions", { required: true });
        const result = await refineScript(scriptText, instructions);
        return jsonResult(result);
      }

      if (action === "generate") {
        const req: ScriptRequest = {
          prompt: readStringParam(params, "prompt", { required: true }),
          platform: (params.platform as Platform | undefined) ?? undefined,
          targetDuration:
            typeof params.targetDuration === "number" ? params.targetDuration : undefined,
          tone: typeof params.tone === "string" ? params.tone : undefined,
          style: typeof params.style === "string" ? params.style : undefined,
          includeVoiceover:
            typeof params.includeVoiceover === "boolean" ? params.includeVoiceover : undefined,
          research: typeof params.research === "boolean" ? params.research : undefined,
          researchQuery:
            typeof params.researchQuery === "string" ? params.researchQuery : undefined,
          savePageId: typeof params.savePageId === "string" ? params.savePageId : undefined,
          saveAsNote: typeof params.saveAsNote === "boolean" ? params.saveAsNote : undefined,
          title: typeof params.title === "string" ? params.title : undefined,
        };
        const useAgentic = typeof params.agentic === "boolean" ? params.agentic : false;
        const result = useAgentic
          ? await generateScriptAgentic(req)
          : await generateScriptUnified(req);
        return jsonResult(result);
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
