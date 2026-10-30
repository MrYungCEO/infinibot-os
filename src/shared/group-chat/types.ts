/**
 * Agent group chat — shared types (gateway + control UI).
 *
 * A group chat is a standard gateway session (`agent:<default>:groupchat-<id>`)
 * whose transcript holds the shared conversation. Its metadata lives on the
 * session entry (`entry.groupChat`), so groups persist, list, rename and
 * delete exactly like ordinary chats. Each member agent answers in its own
 * hidden member session (`agent:<agentId>:gcmember-<id>`).
 */

import type { ToolActivity } from "./activity.js";
import type { UnverifiedClaim } from "./truth-guard.js";
import type { ChatPanelRef } from "../chat-panels/panel-ref.js";
import type { GroupRunSettings } from "./settings.js";

export type { ChatPanelRef } from "../chat-panels/panel-ref.js";
export type { GroupRunSettings } from "./settings.js";

export type GroupChatMode = "everyone" | "round-robin" | "moderator";

export const GROUP_CHAT_MODES: readonly GroupChatMode[] = ["everyone", "round-robin", "moderator"];

export type WorkflowNode = {
  id: string;
  agentId: string;
  /** Short step name shown on the canvas. */
  label?: string;
  /** Instruction for this step; the previous steps' outputs are appended. */
  prompt?: string;
  x: number;
  y: number;
  /** Hierarchy: this node is a sub-agent of `parentId` (runs after it, gets its output). */
  parentId?: string | null;
};

export type WorkflowEdge = { id: string; sourceId: string; targetId: string };

export type WorkflowGraph = {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt?: number;
};

export type WorkflowStepStatus = "pending" | "running" | "done" | "error" | "skipped";

export type WorkflowRunStep = {
  nodeId: string;
  agentId: string;
  label?: string;
  status: WorkflowStepStatus;
  /** Execution layer (steps in the same layer run in parallel). */
  layer: number;
  startedAt?: number;
  endedAt?: number;
  /** Truncated output preview (the full text is in the group transcript). */
  output?: string;
  error?: string;
};

export type WorkflowRunStatus = "running" | "done" | "error" | "aborted";

export type WorkflowRunRecord = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  input: string;
  startedAt: number;
  endedAt?: number;
  steps: WorkflowRunStep[];
  error?: string;
};

/**
 * What the group works on: one shared repo / working directory (the exec /
 * read / write cwd of every member turn), an optional linked kanban project
 * and a purpose line. Set at create time or via `groupchat.update`.
 */
export type GroupChatBinding = {
  /** Absolute path of the shared repo / working directory. */
  workdir?: string;
  projectId?: string;
  projectName?: string;
  purpose?: string;
};

export type GroupChatMeta = {
  version: 1;
  members: string[];
  mode: GroupChatMode;
  /** Lead agent for `moderator` mode (defaults to the first member). */
  moderatorId?: string;
  /** Next speaker index for `round-robin`. */
  rrIndex?: number;
  /** Number of group transcript messages each member has already been shown. */
  cursors?: Record<string, number>;
  workflows?: WorkflowGraph[];
  /** Newest last; capped. */
  runs?: WorkflowRunRecord[];
  /** Shared working context (repo, project, purpose). */
  binding?: GroupChatBinding;
  /** Model / thinking for every member's run (the 1:1 composer's picker, group-wide). */
  settings?: GroupRunSettings;
  /** Per-member overrides of `settings`, by agent id. */
  memberSettings?: Record<string, GroupRunSettings>;
  createdAt: number;
};

export type GroupMessageKind = "user" | "agent" | "status";

/** Attribution stamped on every message in a group transcript. */
export type GroupMessageMeta = {
  messageId: string;
  kind: GroupMessageKind;
  agentId?: string;
  agentName?: string;
  workflowId?: string;
  workflowRunId?: string;
  stepNodeId?: string;
  /** Agent turn failed — `text` is the error description. */
  error?: boolean;
  /** Tool calls this turn made and their REAL results (shared activity ledger). */
  activity?: ToolActivity[];
  /** Claims in `text` with no matching successful tool result (truthfulness post-check). */
  unverified?: UnverifiedClaim[];
  /** Chat panels (show_panel / plugin cards) the agent's run produced. */
  panels?: ChatPanelRef[];
  /** Model the agent replied with ("provider/model"), when known. */
  model?: string;
  /** A group slash command (or its reply): shown to the user, never sent to agents as context. */
  command?: boolean;
  /** Local OCR text of the user's attachments (agents see it; the UI does not render it inline). */
  attachmentContext?: string;
};

export type GroupImageBlock = { type: "image"; data: string; mimeType: string };

export type GroupTranscriptMessage = {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string } | GroupImageBlock>;
  timestamp: number;
  stopReason?: string;
  usage?: { input: number; output: number; totalTokens: number };
  groupChat?: GroupMessageMeta;
};

/** `groupchat` gateway event payloads (live turn + workflow status). */
export type GroupChatEvent =
  | {
      type: "turn.start";
      groupKey: string;
      agentId: string;
      memberKey: string;
      runId: string;
      workflowRunId?: string;
    }
  | { type: "turn.end"; groupKey: string; agentId: string; runId: string; ok: boolean }
  | { type: "message"; groupKey: string; message: GroupTranscriptMessage }
  | { type: "round.start"; groupKey: string; agents: string[] }
  | { type: "round.end"; groupKey: string }
  | { type: "workflow"; groupKey: string; run: WorkflowRunRecord }
  | { type: "meta"; groupKey: string };

export const GROUP_CHAT_EVENT = "groupchat";
