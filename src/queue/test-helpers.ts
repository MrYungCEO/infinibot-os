/**
 * Test doubles for the queue: a scripted fake phase runner that simulates
 * backend behaviour per attempt (verified, unverified, hang, crash, spawn
 * error, needs-input, premature-exit-then-resume) and a fake availability
 * probe. Excluded from the production build (tsconfig: test-helpers.ts).
 */

import type { AttemptPoll, PhaseRunner, PhaseStartParams } from "./phase-runner.js";
import type { BackendAvailability, ResolvedAgent } from "./backends.js";
import type { QueueCliBackend } from "./types.js";

export type FakeBehavior =
  | { kind: "verified"; polls?: number; summary?: string }
  | { kind: "unverified"; polls?: number; reasons?: string[] }
  | { kind: "failed"; polls?: number }
  | { kind: "needs_input"; polls?: number; issues?: string[] }
  | { kind: "exit"; code: number; polls?: number } // verification disabled
  | { kind: "hang" }
  | { kind: "crash"; polls?: number }
  | { kind: "spawn_error"; message?: string }
  | { kind: "auth_error"; message?: string }
  | { kind: "model_error"; message?: string }
  /** Hook to mutate the workdir (so gate checks see the agent's work). */
  | { kind: "custom"; polls?: number; onSettle?: (p: PhaseStartParams) => void; verdict?: string };

interface RunState {
  params: PhaseStartParams;
  behavior: FakeBehavior;
  polls: number;
  sessionId: string;
  killed: string | null;
}

export class FakeRunner implements PhaseRunner {
  readonly starts: PhaseStartParams[] = [];
  readonly kills: Array<{ runId: string; reason: string }> = [];
  readonly runs = new Map<string, RunState>();
  private scripts = new Map<string, FakeBehavior[]>();
  private sessionSeq = 0;
  /** Default when no script is queued for an agent. */
  defaultBehavior: FakeBehavior = { kind: "verified" };

  /** Queue behaviours for successive attempts of `agent` (label, e.g. "codex" or "agent:main"). */
  script(agent: string, ...behaviors: FakeBehavior[]): this {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), ...behaviors]);
    return this;
  }

  async start(p: PhaseStartParams): Promise<{ sessionId?: string | null }> {
    this.starts.push(p);
    const behavior = this.scripts.get(p.target.label)?.shift() ?? this.defaultBehavior;
    if (behavior.kind === "spawn_error") throw new Error(behavior.message ?? "spawn ENOENT");
    const sessionId = p.resumeSessionId ?? `${p.target.label}-sess-${++this.sessionSeq}`;
    this.runs.set(p.runId, { params: p, behavior, polls: 0, sessionId, killed: null });
    return { sessionId };
  }

  async poll(runId: string, _target: ResolvedAgent): Promise<AttemptPoll> {
    const r = this.runs.get(runId);
    if (!r) return { state: "missing", reason: "fake: unknown run (restart lost it)" };
    if (r.killed) {
      return {
        state: "settled",
        exitCode: 143,
        verdict: "failed",
        reasons: [r.killed],
        sessionId: r.sessionId,
      };
    }
    r.polls++;
    const b = r.behavior;
    const need = "polls" in b && typeof b.polls === "number" ? b.polls : 1;
    if (b.kind === "hang" || r.polls < need) return { state: "running", sessionId: r.sessionId };
    switch (b.kind) {
      case "verified":
        return {
          state: "settled",
          exitCode: 0,
          verdict: "verified",
          reasons: [],
          sessionId: r.sessionId,
          resultStatus: "done",
          summary: b.summary ?? `did ${r.params.label}`,
        };
      case "unverified":
        return {
          state: "settled",
          exitCode: 0,
          verdict: "unverified",
          reasons: b.reasons ?? ["claim unsupported"],
          sessionId: r.sessionId,
          resultStatus: "done",
        };
      case "failed":
        return {
          state: "settled",
          exitCode: 1,
          verdict: "failed",
          reasons: ["exit 1"],
          sessionId: r.sessionId,
        };
      case "needs_input":
        return {
          state: "settled",
          exitCode: 0,
          verdict: "needs_input",
          reasons: [],
          sessionId: r.sessionId,
          resultStatus: "needs_input",
          openIssues: b.issues ?? ["which database?"],
        };
      case "auth_error":
        return {
          state: "settled",
          exitCode: 1,
          verdict: "failed",
          reasons: ["exit 1"],
          sessionId: r.sessionId,
          authError: b.message ?? "401 Unauthorized: Missing bearer",
        };
      case "model_error":
        return {
          state: "settled",
          exitCode: 1,
          verdict: "failed",
          reasons: ["exit 1"],
          sessionId: r.sessionId,
          modelError: b.message ?? "glm-5.1 was retired at 2026-09-25",
        };
      case "exit":
        return {
          state: "settled",
          exitCode: b.code,
          verdict: null,
          reasons: [],
          sessionId: r.sessionId,
        };
      case "crash":
        this.runs.delete(runId);
        return { state: "missing", reason: "fake crash" };
      case "custom":
        b.onSettle?.(r.params);
        return {
          state: "settled",
          exitCode: 0,
          verdict: b.verdict ?? "verified",
          reasons: [],
          sessionId: r.sessionId,
          resultStatus: "done",
        };
    }
    return { state: "running" };
  }

  async kill(runId: string, _t: ResolvedAgent, reason: string): Promise<void> {
    this.kills.push({ runId, reason });
    const r = this.runs.get(runId);
    if (r) r.killed = reason;
  }

  async output(runId: string): Promise<{ text: string; source: "durable" | "session" | "none" }> {
    const r = this.runs.get(runId);
    return r
      ? { text: `fake output of ${runId}\nRESULT done`, source: "durable" }
      : { text: "", source: "none" };
  }

  /** Simulate a gateway restart: in-memory state of live runs is lost unless kept. */
  forget(runId: string): void {
    this.runs.delete(runId);
  }
}

export function fakeAvailability(
  unavailable: Partial<Record<QueueCliBackend, "not-installed" | "auth-required">> = {},
) {
  return {
    probes: 0,
    async get(b: QueueCliBackend): Promise<BackendAvailability> {
      this.probes++;
      const st = unavailable[b];
      return st
        ? {
            id: b,
            installed: st !== "not-installed",
            authState: st,
            available: false,
            reason:
              st === "not-installed"
                ? `${b} CLI is not installed on the gateway host`
                : `${b} CLI is installed but not logged in`,
            fix: `install/login ${b}`,
            checkedAt: Date.now(),
          }
        : { id: b, installed: true, authState: "ok", available: true, checkedAt: Date.now() };
    },
  };
}

/** Tick until `pred` holds (or `max` ticks). */
export async function tickUntil(
  tick: () => Promise<void>,
  pred: () => boolean,
  max = 50,
): Promise<number> {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    await tick();
  }
  if (!pred()) throw new Error(`condition not reached after ${max} ticks`);
  return max;
}
