/**
 * Per-worker execution profile — the knobs that were previously implicit,
 * global, or hard-coded, made explicit and editable per AI employee.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * Everything about *how* an employee runs used to live in one global
 * `WorkItemExecutorConfig`: one timeout for everybody, one fallback backend for
 * everybody, no tool restrictions at all. That is wrong at agency scale — the
 * CEO drafting a memo and a back-end dev running a migration are not the same
 * risk, and today `Dev` and `Wren` are both bound to `codex`, which exits 1,
 * with no per-worker retry path.
 *
 * The profile is stored as JSON on `wf_workers.execution_profile_json`. Every
 * field is nullable-by-omission: null means "inherit the gateway default", so
 * an untouched worker behaves exactly as it did before this feature landed and
 * the global config stays the single place to change fleet-wide policy.
 *
 * NOTE ON CREDENTIALS: like channel bindings, nothing here is a secret. A
 * model *binding* is a backend id ("claude", "codex"), never an API key.
 */

export const EXECUTION_PROFILE_VERSION = 1 as const;

/** Blank/`*` allowlist means "no restriction", which is the default. */
export interface WorkerExecutionProfile {
  version: typeof EXECUTION_PROFILE_VERSION;
  /**
   * Backend to retry with when this worker's `modelBinding` fails to launch.
   * Null inherits `WorkItemExecutorConfig.fallbackBackend`. This is the fix for
   * a worker pinned to a backend that is not installed or is rate-limited.
   */
  fallbackModelBinding: string | null;
  /**
   * Tools/capabilities this worker may use. Empty = unrestricted. Entries are
   * matched case-insensitively; `*` is an explicit "allow everything".
   */
  toolAllowlist: string[];
  /** Tools this worker may never use. Wins over the allowlist. */
  toolDenylist: string[];
  /** Per-item wall-clock budget. Null inherits the global timeout. */
  timeoutMinutes: number | null;
  /** Max simultaneous runs for THIS worker. Null inherits global concurrency. */
  maxConcurrent: number | null;
  /** Extra launch attempts after the primary+fallback pair. */
  maxRetries: number;
  /** Operator note; surfaced to no one but the operator. */
  notes: string;
  updatedAt: number;
}

export function defaultExecutionProfile(now = Date.now()): WorkerExecutionProfile {
  return {
    version: EXECUTION_PROFILE_VERSION,
    fallbackModelBinding: null,
    toolAllowlist: [],
    toolDenylist: [],
    timeoutMinutes: null,
    maxConcurrent: null,
    maxRetries: 0,
    notes: "",
    updatedAt: now,
  };
}

const clampOrNull = (raw: unknown, fallback: number | null, min: number, max: number) => {
  if (raw === null) return null;
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
};

const stringList = (raw: unknown, fallback: string[]): string[] => {
  if (raw === undefined) return fallback;
  if (!Array.isArray(raw)) return fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim().slice(0, 200);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 200) break;
  }
  return out;
};

const nullableString = (raw: unknown, fallback: string | null): string | null => {
  if (raw === null) return null;
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
};

/**
 * Coerce arbitrary (RPC) input into a complete, storable execution profile.
 * Merged over `base`; never throws — bad input degrades to the base value.
 */
export function normalizeExecutionProfile(
  raw: unknown,
  base: WorkerExecutionProfile = defaultExecutionProfile(),
  now = Date.now(),
): WorkerExecutionProfile {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    version: EXECUTION_PROFILE_VERSION,
    fallbackModelBinding: nullableString(value.fallbackModelBinding, base.fallbackModelBinding),
    toolAllowlist: stringList(value.toolAllowlist, base.toolAllowlist),
    toolDenylist: stringList(value.toolDenylist, base.toolDenylist),
    timeoutMinutes: clampOrNull(value.timeoutMinutes, base.timeoutMinutes, 1, 240),
    maxConcurrent: clampOrNull(value.maxConcurrent, base.maxConcurrent, 1, 16),
    maxRetries: clampOrNull(value.maxRetries, base.maxRetries, 0, 5) ?? 0,
    notes:
      value.notes === undefined
        ? base.notes
        : typeof value.notes === "string"
          ? value.notes.trim().slice(0, 2_000)
          : base.notes,
    updatedAt: now,
  };
}

/** The worker's profile, or the default for rows that predate the feature. */
export function resolveExecutionProfile(worker: {
  executionProfile?: WorkerExecutionProfile | null;
}): WorkerExecutionProfile {
  return worker.executionProfile ?? defaultExecutionProfile(0);
}

/**
 * Is `tool` permitted for this worker? Denylist wins; an empty allowlist (or
 * one containing `*`) permits everything.
 */
export function isToolAllowed(profile: WorkerExecutionProfile, tool: string): boolean {
  const needle = tool.trim().toLowerCase();
  if (!needle) return false;
  if (profile.toolDenylist.some((entry) => entry.trim().toLowerCase() === needle)) return false;
  if (!profile.toolAllowlist.length) return true;
  return profile.toolAllowlist.some((entry) => {
    const value = entry.trim().toLowerCase();
    return value === "*" || value === needle;
  });
}

/** Prompt-ready statement of the worker's tool boundary, or "" when open. */
export function describeToolPolicy(profile: WorkerExecutionProfile): string {
  const lines: string[] = [];
  if (profile.toolAllowlist.length && !profile.toolAllowlist.includes("*")) {
    lines.push(`You may only use these tools/capabilities: ${profile.toolAllowlist.join(", ")}.`);
  }
  if (profile.toolDenylist.length) {
    lines.push(`You must NOT use: ${profile.toolDenylist.join(", ")}.`);
  }
  return lines.join(" ");
}
