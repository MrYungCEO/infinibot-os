/**
 * agents.knowledge.profile — read-only "what does this agent know, and what
 * can it reach?" aggregator for the Memory › Agents view.
 *
 * Params: { agentId?: string; fresh?: boolean }
 * Returns KnowledgeProfileResult (src/agents/knowledge-profile/types.ts):
 * one itemised live profile per agent (identity, memory, knowledge sources,
 * capabilities, activity) assembled from existing stores. Cached ~5 s.
 */

import { getKnowledgeProfiles } from "../../agents/knowledge-profile/runtime.js";
import { proxyMethodsToMaster } from "../../federation/satellite-context.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const _rawHandlers: GatewayRequestHandlers = {
  "agents.knowledge.profile": async ({ params, respond }) => {
    const p = (params ?? {}) as { agentId?: unknown; fresh?: unknown };
    const agentId =
      typeof p.agentId === "string" && p.agentId.trim() ? p.agentId.trim() : undefined;
    try {
      respond(true, await getKnowledgeProfiles({ agentId, fresh: p.fresh === true }), undefined);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(e)));
    }
  },
};

export const agentsKnowledgeHandlers = proxyMethodsToMaster(_rawHandlers, [
  "agents.knowledge.profile",
]);
