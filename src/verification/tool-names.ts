/**
 * Tools every agent gets for verified completion (no heavy imports here —
 * policy + roster modules read this list).
 */
export const VERIFIED_COMPLETION_TOOLS = [
  "subagents_wait",
  "subagents_events",
  "visual_verify",
] as const;

/**
 * Operator-approval tools (request_approval / wait_approval) — every agent may
 * ask for the operator's OK before risky actions, so they're unioned into
 * allow lists the same way as the verified-completion tools.
 */
export const APPROVAL_TOOLS = ["request_approval", "wait_approval"] as const;

/**
 * In-flight messaging for coder sub-agents: the orchestrator's
 * `subagent_message` and the child's `subagent_inbox`. Seeded into every
 * allow-listed agent (like VERIFIED_COMPLETION_TOOLS) and always allowed for
 * sub-agent sessions, so a coder child can always drain its operator inbox.
 */
export const INFLIGHT_MESSAGING_TOOLS = ["subagent_message", "subagent_inbox"] as const;

/**
 * Local auto-OCR context (`file_context`: search uploaded files by content,
 * read their extracted text, ask the local vision model about an image).
 * Read-only and lane-bound, so every allow-listed agent gets it.
 */
export const FILE_CONTEXT_TOOLS = ["file_context", "video_analysis"] as const;
