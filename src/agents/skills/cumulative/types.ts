/**
 * Type definitions for the cumulative skill system.
 *
 * Architecture inspired by NousResearch/hermes-agent's "skills self-improve
 * during use" loop. See `LICENSE-NOTICE.md` in this directory for attribution.
 */

/** Compact summary of a single LLM turn or tool call inside a run trajectory. */
export interface TrajectoryStep {
  /** Logical phase: prompt, tool-call, tool-result, model-output, error. */
  kind: "prompt" | "tool-call" | "tool-result" | "model-output" | "error";
  /** Short label — e.g. tool name, "user", "assistant". */
  label: string;
  /** Truncated content (the trajectory store caps each step). */
  content: string;
  /** Wall-clock relative to the run start, in ms. */
  tMs: number;
}

/** Numeric metrics captured at the end of a run for the quality gate. */
export interface RunMetrics {
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Total input + output tokens consumed across the run, when available. */
  totalTokens?: number;
  /** Number of tool calls made. */
  toolCalls: number;
  /** Number of clarification requests the agent emitted (heuristic). */
  clarifications: number;
  /** True if the run terminated with an explicit error or abort. */
  errored: boolean;
  /** True when the agent self-reported task success. */
  reportedSuccess: boolean;
}

/** A captured run trajectory — appended to trajectory-store.jsonl. */
export interface Trajectory {
  id: string;
  /** ISO timestamp the run completed at. */
  completedAt: string;
  /** Source (which agent / session originated this run). */
  source: {
    agentId: string;
    sessionKey: string;
    /** Optional skill key — present when the run was *invoked via* a learned skill. */
    invokedSkillKey?: string;
  };
  /** First user message / task prompt (truncated). */
  taskPrompt: string;
  steps: TrajectoryStep[];
  /** Final agent output (truncated). */
  finalOutput: string;
  metrics: RunMetrics;
  /** Tags propagated for filtering — e.g. "self-improve-eligible". */
  tags?: string[];
}

/** Frontmatter persisted at the top of every learned SKILL.md. */
export interface LearnedSkillFrontmatter {
  /** Slugified skill key (also the directory name). */
  name: string;
  /** Short imperative description shown to the model in tool listings. */
  description: string;
  /** When the skill was first written. */
  createdAt: string;
  /** Last refinement run that touched this skill. */
  updatedAt: string;
  /** Trajectory id this skill was distilled from. */
  sourceTrajectoryId: string;
  /** Cheap content hash used for dedupe (sha256 of body, first 16 chars). */
  fingerprint: string;
  /** Always tagged "learned" so they sort separately from authored skills. */
  origin: "learned";
  /** Optional emoji surfaced in pickers. */
  emoji?: string;
}

/** Sidecar usage record kept alongside every learned skill. */
export interface UsageRecord {
  skillKey: string;
  invocations: number;
  successes: number;
  failures: number;
  /** ISO of the most recent invocation. */
  lastInvokedAt?: string;
  /** ISO of the last self-improvement pass that rewrote the body. */
  lastRefinedAt?: string;
  /** Most recent N trajectory ids that invoked this skill — used by self-improve. */
  recentTrajectoryIds: string[];
}

/** Result of running the quality gate against a candidate trajectory. */
export interface GateResult {
  accept: boolean;
  reason: string;
  /** When `accept === false`, which heuristic vetoed (token-cap, errored, dup, etc.). */
  vetoBy?: string;
}

/** Result of an LLM reflection pass — the draft skill plus self-rated confidence. */
export interface ReflectionDraft {
  /** Slugified name (kebab-case, lowercase). */
  name: string;
  description: string;
  body: string;
  emoji?: string;
  /** Self-rated confidence 0-1; used as a secondary gate. */
  confidence: number;
}

/** Public config — overridable via env or InfinibotConfig. */
export interface CumulativeSkillsConfig {
  /** Master switch. When false the system is a no-op. */
  enabled: boolean;
  /** Where trajectories accumulate (jsonl rotation). */
  trajectoryDir: string;
  /** Where SKILL.md files end up (loaded by the existing skill loader). */
  skillsLearnedDir: string;
  /** Where per-skill usage sidecars live. */
  usageDir: string;
  /** Cap per trajectory step; bigger steps get truncated. */
  maxStepBytes: number;
  /** Trajectory file rotates after this many lines. */
  rotateAfterLines: number;
  /** Min confidence the reflection LLM must self-report to write the skill. */
  minConfidence: number;
  /** Token budget cap for an eligible trajectory (we don't promote ultra-expensive runs). */
  maxTokensForPromotion: number;
  /** Max wall-clock for an eligible trajectory in ms. */
  maxDurationMsForPromotion: number;
  /** Min usage count before self-improve kicks in. */
  selfImproveMinUses: number;
  /** Skip self-improve if the last refinement landed inside this window. */
  selfImproveCooldownMs: number;
  /** Max recent-trajectory ids retained per skill. */
  recentTrajectoryWindow: number;
}
