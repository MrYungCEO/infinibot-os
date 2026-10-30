/**
 * Agent tools the content-studio plugin contributes (content_intel, script,
 * viral_watch, content_pages,
 * content_pipeline, content_posting). Core no longer lists them in createInfiniBotTools(); the
 * plugin registers them with api.registerTool while it is enabled.
 */

import type { AnyAgentTool } from "../agents/tools/common.js";
import { createContentIntelTool } from "../agents/tools/content-intel-tool.js";
import { createContentPagesTool } from "../agents/tools/content-pages-tool.js";
import { createScriptTool } from "../agents/tools/script-tool.js";
import { createViralWatchTool } from "../agents/tools/viral-watch-tool.js";
import { createContentPipelineTool } from "./pipeline-tool.js";
import { createContentPostingTool } from "./posting-tool.js";

export const CONTENT_STUDIO_TOOL_NAMES = [
  "content_intel",
  "script",
  "viral_watch",
  "content_pages",
  "content_pipeline",
  "content_posting",
] as const;

export function createContentStudioTools(ctx: { agentId?: string }): AnyAgentTool[] {
  return [
    createContentIntelTool({ agentId: ctx.agentId }),
    createScriptTool({ agentId: ctx.agentId }),
    createViralWatchTool({ agentId: ctx.agentId }),
    createContentPagesTool({ agentId: ctx.agentId }),
    createContentPipelineTool({ agentId: ctx.agentId }),
    createContentPostingTool({ agentId: ctx.agentId }),
  ];
}
