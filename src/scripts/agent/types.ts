/**
 * Shared types for the agentic script pipeline.
 */

import type { ParsedScene } from "../../storyboard/script-generator.js";
import type { ResearchBundle } from "../../content/research-service.js";
import type { LintResult } from "./viral-lint.js";

export type ResearchDepth = "shallow" | "standard" | "deep";

/** Input to the agentic generator. Superset of the legacy ScriptRequest. */
export interface AgenticScriptRequest {
  prompt: string;
  platform?: string;
  /** Seconds. When omitted, platform default is used. */
  durationSec?: number;
  /** Legacy minutes field (mapped to durationSec if durationSec absent). */
  targetDuration?: number;
  persona?: string;
  tone?: string;
  style?: string;
  anglesToExplore?: string[];
  researchDepth?: ResearchDepth;
  includeVoiceover?: boolean;
  /** Hard cap on tool calls. Default 12. */
  maxToolCalls?: number;
  /** Wall-clock budget in ms. Default 90_000. */
  maxWallMs?: number;
  /** Persist hooks (mirrors legacy ScriptRequest). */
  savePageId?: string;
  saveAsNote?: boolean;
  title?: string;
}

/** One entry in the agent's execution trace. */
export interface TraceEntry {
  step: number;
  type: "tool_call" | "tool_result" | "draft" | "lint" | "thought" | "error";
  /** Tool name for tool_* entries. */
  tool?: string;
  /** Input args (tool_call) — trimmed for size. */
  input?: unknown;
  /** Result summary (tool_result) — trimmed for size. */
  summary?: string;
  /** For draft entries: the draft length / scene count. */
  draftMeta?: { chars: number; scenes: number };
  /** For lint entries. */
  lint?: LintResult;
  /** For thought entries: the model's interstitial text. */
  text?: string;
  at: number;
}

export interface AgenticScriptResult {
  success: boolean;
  script?: string;
  scenes?: ParsedScene[];
  estimatedDuration?: number;
  /** Final lint result for the returned script. */
  lint?: LintResult;
  /** Research gathered (when the agent ran web research). */
  research?: ResearchBundle;
  /** Exemplar ids/titles the agent actually pulled. */
  exemplarsUsed?: Array<{ id: string; title: string; platform: string }>;
  /** Full tool-call + draft trace for UI "why this script" surfacing. */
  trace: TraceEntry[];
  /** How the run ended. */
  stopReason?: "complete" | "tool_budget" | "time_budget" | "no_provider" | "error";
  warnings?: string[];
  error?: string;
}

/** Streaming + checkpoint hooks supplied by the caller (gateway handler). */
export interface AgentStreamHooks {
  /** Called for each trace entry as it happens (WS streaming). */
  onTrace?: (entry: TraceEntry) => void;
  /** Called at milestones for the subagent checkpoint system. */
  onCheckpoint?: (info: { phase: string; message: string }) => void;
}
