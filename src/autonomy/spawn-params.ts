/**
 * Shared validation for sub-agent spawn parameters.
 *
 * Centralizes the constraints the gateway will enforce anyway so we fail
 * deterministically at the call site instead of round-tripping a request
 * that we already know cannot succeed. Mirrors the pre-call guardrail
 * pattern from Hermes (`agent/tool_executor.py:get_pre_tool_call_block_message`).
 *
 * See docs/hermes-reliability-audit.md → Change 1 for rationale.
 */

// label cap: the gateway's agent-params schema rejects label > 64 chars.
// We use 63 to leave one-char headroom against the exact-64 boundary; do
// NOT raise without first widening the gateway schema.
export const SPAWN_LABEL_MAX = 63;
export const SPAWN_TASK_MAX = 32_000;
export const SPAWN_TIMEOUT_MIN_SEC = 30;
export const SPAWN_TIMEOUT_MAX_SEC = 10_800; // 3 h
export const SPAWN_TIMEOUT_DEFAULT_SEC = 3_600; // 1 h

export interface SpawnParamsInput {
  agentId: string;
  label: string;
  task: string;
  runTimeoutSeconds?: number;
}

export interface SpawnParamsValidated {
  agentId: string;
  label: string;
  task: string;
  runTimeoutSeconds: number;
}

export class SpawnParamsError extends Error {
  constructor(
    public readonly field: string,
    detail: string,
  ) {
    // Format matches the gateway's "invalid agent params" string so
    // isRetryableError classifies these the same as a real gateway rejection.
    super(`invalid agent params: at /${field}: ${detail}`);
    this.name = "SpawnParamsError";
  }
}

function truncateWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Validate, normalize, and (where safe) repair spawn input.
 * Throws SpawnParamsError if a constraint can't be repaired silently.
 *
 *   - agentId: trimmed; empty rejected
 *   - label: trimmed; empty rejected; > SPAWN_LABEL_MAX truncated with ellipsis
 *   - task: trimmed; empty rejected; > SPAWN_TASK_MAX rejected (too lossy to
 *     truncate silently — the caller should compress instead)
 *   - runTimeoutSeconds: clamped to [SPAWN_TIMEOUT_MIN_SEC, SPAWN_TIMEOUT_MAX_SEC];
 *     missing / non-finite → SPAWN_TIMEOUT_DEFAULT_SEC
 */
export function validateSpawnParams(input: SpawnParamsInput): SpawnParamsValidated {
  const agentIdRaw = typeof input.agentId === "string" ? input.agentId.trim() : "";
  if (!agentIdRaw) {
    throw new SpawnParamsError("agentId", "must be a non-empty string");
  }

  const labelRaw = typeof input.label === "string" ? input.label.trim() : "";
  if (!labelRaw) {
    throw new SpawnParamsError("label", "must be a non-empty string");
  }
  const label = truncateWithEllipsis(labelRaw, SPAWN_LABEL_MAX);

  const taskRaw = typeof input.task === "string" ? input.task.trim() : "";
  if (!taskRaw) {
    throw new SpawnParamsError("task", "must be a non-empty string");
  }
  if (taskRaw.length > SPAWN_TASK_MAX) {
    throw new SpawnParamsError(
      "task",
      `length ${taskRaw.length} exceeds max ${SPAWN_TASK_MAX}; compress before spawning`,
    );
  }

  let timeout = input.runTimeoutSeconds;
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    timeout = SPAWN_TIMEOUT_DEFAULT_SEC;
  }
  timeout = Math.max(SPAWN_TIMEOUT_MIN_SEC, Math.min(SPAWN_TIMEOUT_MAX_SEC, Math.floor(timeout)));

  return {
    agentId: agentIdRaw,
    label,
    task: taskRaw,
    runTimeoutSeconds: timeout,
  };
}

/**
 * Sanitize a string that's about to be embedded back into a model prompt as a
 * tool-call result/error. Strips XML/HTML tags, markdown code fences, and
 * CDATA — anything that could let a malformed tool response forge protocol
 * framing for the next model turn — then hard-caps length.
 *
 * Mirrors Hermes's tool-error sanitizer (2000-char cap, "prevents framing
 * escape" — see docs/hermes-reliability-audit.md H0.7).
 */
export const TOOL_RESULT_SANITIZE_MAX = 2_000;
export function sanitizeToolResult(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<\/?[a-z_][\w-]*[^>]*>/gi, "")
    .replace(/```/g, "")
    .slice(0, TOOL_RESULT_SANITIZE_MAX);
}
