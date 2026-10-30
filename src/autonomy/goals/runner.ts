/**
 * Goal runner — the `/goal` loop.
 *
 *   spawn agent → (periodic checks while it works) → on exit / per-iteration
 *   timeout / hang: run ALL checks → all pass = COMPLETED; otherwise feed the
 *   failing checks back and resume/respawn → until pass, max iterations or
 *   max wall-clock (EXHAUSTED) or an unrecoverable failure (FAILED).
 *
 * Process exit never marks success on its own — only passing checks do.
 *
 * State lives in {@link GoalStore} (queue.db) and the tick loop is
 * idempotent, so a gateway restart simply resumes: a durable (tmux) agent
 * that is still alive keeps being supervised, a vanished one is recorded as
 * crashed and re-checked, and a run caught mid-check is re-checked.
 *
 * All process / agent I/O goes through {@link GoalExecutor} so the loop is
 * unit-testable without spawning anything.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { describeCheck, runCheck, type CheckContext } from "./checks.js";
import type { GoalStore } from "./store.js";
import {
  GOAL_TERMINAL_STATUSES,
  type GoalAgentTarget,
  type GoalCheckResult,
  type GoalIteration,
  type GoalIterationOutcome,
  type GoalRun,
} from "./types.js";

const log = createSubsystemLogger("autonomy.goals");

export interface ExecutorStartParams {
  goalId: string;
  iteration: number;
  target: GoalAgentTarget;
  prompt: string;
  workdir: string | null;
  /** Session to resume (null → fresh session). */
  resumeSessionId: string | null;
  label: string;
  /** Hard ceiling the executor may enforce itself (seconds). */
  timeoutSec: number;
}

export interface ExecutorStatus {
  state: "running" | "exited" | "missing";
  exitCode?: number | null;
  /** ms epoch of the most recent output chunk (for hang detection). */
  lastOutputAt?: number | null;
  /** Backend session id discovered so far (for resume). */
  sessionId?: string | null;
}

export interface GoalExecutor {
  start(p: ExecutorStartParams): Promise<{ runId: string; sessionId?: string | null }>;
  status(runId: string, target: GoalAgentTarget): Promise<ExecutorStatus>;
  /** Tail of the agent's output / final reply. */
  output(runId: string, target: GoalAgentTarget): Promise<string>;
  kill(runId: string, target: GoalAgentTarget): Promise<void>;
  /** Whether a follow-up iteration can resume the previous session. */
  supportsResume(target: GoalAgentTarget): boolean;
}

export type GoalEventKind =
  | "goal.created"
  | "goal.updated"
  | "goal.iteration"
  | "goal.checked"
  | "goal.completed"
  | "goal.failed";

export interface GoalRunnerDeps {
  store: GoalStore;
  executor: GoalExecutor;
  emit?: (kind: GoalEventKind, run: GoalRun) => void;
  notify?: (run: GoalRun) => Promise<unknown> | void;
  /** Injectable clock + judge for tests. */
  now?: () => number;
  judge?: CheckContext["judge"];
}

/** Consecutive crash / spawn failures before a run is FAILED instead of retried. */
const MAX_CONSECUTIVE_HARD_FAILURES = 3;
const CLAIMS_DONE_RE =
  /\b(all (tests|checks|criteria) (now )?pass(ed)?|task (is )?(complete|done)|goal (is )?(complete|achieved|met)|(i'?ve|i have|successfully) (completed|finished)|done[.!]?\s*$|completed[.!]?\s*$)/im;

export function claimsDone(output: string): boolean {
  return CLAIMS_DONE_RE.test(output.slice(-2000));
}

const OUTCOME_TEXT: Record<GoalIterationOutcome, string> = {
  running: "still running",
  exited: "the agent exited",
  nonzero_exit: "the agent exited with a non-zero code",
  crashed: "the agent process crashed or vanished",
  timeout: "the per-iteration time limit was hit",
  hung: "the agent produced no output for too long and was stopped",
  claimed_done_checks_failed: "the agent reported it was done, but verification failed",
  checks_passed: "all checks passed",
  spawn_failed: "the agent failed to start",
  canceled: "the run was canceled",
  interrupted: "the operator interrupted the iteration",
};

export function buildGoalPrompt(run: GoalRun): string {
  const checks = run.checks
    .map((c, i) => {
      const how =
        c.type === "shell"
          ? `command must exit 0: \`${c.command}\``
          : c.type === "file"
            ? `file must ${c.negate ? "NOT " : ""}exist: ${c.path}`
            : c.type === "grep"
              ? `file ${c.path} must ${c.negate ? "NOT " : ""}match /${c.pattern}/`
              : c.type === "visual"
                ? `visual_verify screenshots of ${(c.routes ?? []).join(", ")} must show: ${c.expectation ?? "a correct, defect-free render"}`
                : `reviewer must agree: ${c.criterion}`;
      return `${i + 1}. [${c.type}] ${how}`;
    })
    .join("\n");
  return [
    `# Goal\n${run.goal.trim()}`,
    `# Completion criteria\nThese are verified automatically after you stop. You are NOT done until every one passes.\n${checks}`,
    run.workdir ? `# Working directory\n${run.workdir}` : "",
    "# Rules\nWork autonomously — do not ask questions or wait for confirmation. Verify the criteria yourself before stopping. When they all pass, stop and summarise what you did.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildFeedbackPrompt(
  run: GoalRun,
  prev: GoalIteration | undefined,
  failing: GoalCheckResult[],
  opts: { includeGoal: boolean; instruction?: string | null },
): string {
  const parts: string[] = [];
  if (opts.includeGoal) parts.push(buildGoalPrompt(run));
  const why = prev ? OUTCOME_TEXT[prev.outcome] : "the previous attempt ended";
  parts.push(
    `# Status\nThe goal is NOT complete yet. Iteration ${prev?.index ?? "?"} ended because ${why}.`,
  );
  if (failing.length) {
    const byId = new Map(run.checks.map((c) => [c.id, c]));
    parts.push(
      `# Failing checks\n${failing
        .map((f) => {
          const c = byId.get(f.checkId);
          return `- ${c ? describeCheck(c) : f.checkId}\n  output:\n${f.output
            .slice(-1500)
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`;
        })
        .join("\n")}`,
    );
  }
  if (opts.instruction?.trim()) {
    parts.push(`# Additional instruction from the operator\n${opts.instruction.trim()}`);
  }
  parts.push("Fix the failing checks and keep going. Stop only once every criterion passes.");
  return parts.join("\n\n");
}

export class GoalRunner {
  private timer: NodeJS.Timeout | null = null;
  private readonly busy = new Set<string>();
  private readonly deps: GoalRunnerDeps;
  private readonly now: () => number;

  constructor(deps: GoalRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  get store(): GoalStore {
    return this.deps.store;
  }

  /** Start the supervision loop. Idempotent. */
  start(tickMs = 5_000): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    log.info("goal runner started", { tickMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Boot recovery: runs caught mid-check are re-checked on the next tick.
   * `running` runs are left alone — the next tick asks the executor whether
   * the (durable) agent survived.
   */
  recover(): void {
    for (const run of this.store.list({ status: ["checking"] })) {
      run.status = "running";
      const last = run.iterations.at(-1);
      if (last && last.endedAt === null) last.note = "gateway restarted during checks";
      this.store.save(run);
      log.info("goal run recovered mid-check", { id: run.id });
    }
  }

  /** One supervision pass over every active run. Resolves when all started steps finish. */
  async tick(): Promise<void> {
    const active = this.store.list({ status: ["queued", "running"] });
    await Promise.all(active.map((r) => this.withLock(r.id, () => this.step(r.id))));
  }

  private async withLock(id: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      await fn();
    } catch (err) {
      log.warn("goal step failed", { id, error: String(err) });
    } finally {
      this.busy.delete(id);
    }
  }

  private emit(kind: GoalEventKind, run: GoalRun): void {
    try {
      this.deps.emit?.(kind, run);
    } catch {
      /* broadcaster errors never break the loop */
    }
  }

  private elapsedMs(run: GoalRun): number {
    return run.elapsedMs + (run.activeSince ? this.now() - run.activeSince : 0);
  }

  /** Iterations that count against the budget (operator interruptions don't). */
  private countedIterations(run: GoalRun): number {
    return run.iterations.filter((i) => i.outcome !== "interrupted" && i.outcome !== "canceled")
      .length;
  }

  private async step(id: string): Promise<void> {
    const run = this.store.get(id);
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    const now = this.now();

    if (run.status === "queued") {
      if (!run.activeSince) run.activeSince = now;
      if (!run.startedAt) run.startedAt = now;
      await this.startIteration(run, buildGoalPrompt(run), null);
      return;
    }

    const cur = run.iterations.at(-1);
    if (!cur || cur.endedAt !== null || !cur.runId) {
      // Running with no live iteration (e.g. restart between iterations).
      await this.evaluate(run, "recovery");
      return;
    }

    const wallExceeded = this.elapsedMs(run) > run.limits.maxWallClockSec * 1000;
    const st = await this.deps.executor.status(cur.runId, run.target);
    if (st.sessionId && st.sessionId !== cur.sessionId) {
      cur.sessionId = st.sessionId;
      run.sessionId = st.sessionId;
    }

    if (st.state === "running") {
      const iterAge = now - cur.startedAt;
      const lastOut = Math.max(st.lastOutputAt ?? 0, cur.startedAt);
      let stopAs: GoalIterationOutcome | null = null;
      if (wallExceeded) stopAs = "timeout";
      else if (iterAge > run.limits.iterationTimeoutSec * 1000) stopAs = "timeout";
      else if (run.limits.hangSec > 0 && now - lastOut > run.limits.hangSec * 1000) stopAs = "hung";
      if (stopAs) {
        await this.deps.executor.kill(cur.runId, run.target).catch(() => {});
        await this.endIteration(run, cur, stopAs, null);
        await this.evaluate(run, "iteration");
        return;
      }
      // Periodic checks while the agent works.
      const interval = run.limits.checkIntervalSec * 1000;
      if (interval > 0 && now - (run.lastCheckAt ?? cur.startedAt) >= interval) {
        const allPass = await this.runSuite(run, "timer", cur.runId);
        if (allPass) {
          await this.deps.executor.kill(cur.runId, run.target).catch(() => {});
          await this.endIteration(run, cur, "checks_passed", null, "checks passed while running");
          this.complete(run);
        } else {
          this.store.save(run);
        }
      } else {
        this.store.save(run);
      }
      return;
    }

    const outcome: GoalIterationOutcome =
      st.state === "missing"
        ? "crashed"
        : st.exitCode !== undefined && st.exitCode !== null && st.exitCode !== 0
          ? st.exitCode === 137 || st.exitCode === 139
            ? "crashed"
            : "nonzero_exit"
          : "exited";
    await this.endIteration(run, cur, outcome, st.exitCode ?? null);
    await this.evaluate(run, "iteration");
  }

  private async endIteration(
    run: GoalRun,
    it: GoalIteration,
    outcome: GoalIterationOutcome,
    exitCode: number | null,
    note?: string,
  ): Promise<void> {
    it.endedAt = this.now();
    it.outcome = outcome;
    it.exitCode = exitCode;
    if (note) it.note = note;
    if (it.runId) {
      it.outputTail = (await this.deps.executor.output(it.runId, run.target).catch(() => "")).slice(
        -6000,
      );
    }
    this.store.save(run);
    this.emit("goal.iteration", run);
  }

  /** Run every check; persist results. Returns all-pass. */
  private async runSuite(
    run: GoalRun,
    trigger: GoalCheckResult["trigger"],
    runId: string | null,
  ): Promise<boolean> {
    const iteration = run.iterations.at(-1)?.index ?? 0;
    const ctx: CheckContext = {
      workdir: run.workdir,
      goalText: run.goal,
      iteration,
      trigger,
      judge: this.deps.judge,
      getAgentOutput: async () => {
        const last = run.iterations.at(-1);
        if (last?.outputTail) return last.outputTail;
        return runId ? await this.deps.executor.output(runId, run.target).catch(() => "") : "";
      },
    };
    const results: GoalCheckResult[] = [];
    // llm + visual checks are the costly ones (model calls / headless browser).
    const cheap = run.checks.filter((c) => c.type !== "llm" && c.type !== "visual");
    const llm = run.checks.filter((c) => c.type === "llm" || c.type === "visual");
    for (const c of cheap) results.push(await runCheck(c, ctx));
    // The (costly) judge only runs when everything cheaper passes — or at the
    // end of an iteration / on manual recheck, where its feedback is useful.
    const cheapPass = results.every((r) => r.pass);
    const runLlm = trigger !== "timer" || cheapPass;
    for (const c of llm) results.push(await runCheck(c, { ...ctx, skipLlm: !runLlm }));
    const recorded = results.filter((r) => !(r.output.startsWith("skipped") && !r.pass && !runLlm));
    for (const r of recorded) run.lastResults[r.checkId] = r;
    run.lastCheckAt = this.now();
    this.store.recordResults(run.id, recorded);
    this.emit("goal.checked", run);
    return run.checks.length > 0 && results.every((r) => r.pass);
  }

  /** End-of-iteration verification + decide: complete, continue, or stop. */
  private async evaluate(run: GoalRun, trigger: GoalCheckResult["trigger"]): Promise<void> {
    run.status = "checking";
    this.store.save(run);
    this.emit("goal.updated", run);
    const last = run.iterations.at(-1);
    const allPass = await this.runSuite(run, trigger, last?.runId ?? null);
    // Status may have been changed by an operator control while checks ran.
    const fresh = this.store.get(run.id);
    if (fresh && fresh.status !== "checking") return;

    if (allPass) {
      if (last && last.outcome !== "checks_passed")
        last.note = last.note ?? `verified: ${last.outcome}`;
      this.complete(run);
      return;
    }
    const failing = run.checks
      .map((c) => run.lastResults[c.id ?? ""])
      .filter((r): r is GoalCheckResult => Boolean(r) && !r.pass);
    if (last && last.outcome === "exited" && claimsDone(last.outputTail)) {
      last.outcome = "claimed_done_checks_failed";
    }

    // Unrecoverable: repeated crashes / spawn failures.
    const resetAt = run.iterations.map((i) => Boolean(i.budgetReset)).lastIndexOf(true);
    const tail = run.iterations.slice(resetAt + 1).slice(-MAX_CONSECUTIVE_HARD_FAILURES);
    if (
      tail.length === MAX_CONSECUTIVE_HARD_FAILURES &&
      tail.every((i) => i.outcome === "crashed" || i.outcome === "spawn_failed")
    ) {
      this.finish(
        run,
        "failed",
        `${tail[0].outcome === "spawn_failed" ? "spawn_failed" : "crashed"}: agent failed ${MAX_CONSECUTIVE_HARD_FAILURES} times in a row`,
      );
      return;
    }
    const failingIds = failing.map((f) => f.checkId).join(", ") || "none";
    if (this.elapsedMs(run) > run.limits.maxWallClockSec * 1000) {
      this.finish(
        run,
        "exhausted",
        `max_time: ${run.limits.maxWallClockSec}s used; failing: ${failingIds}`,
      );
      return;
    }
    if (this.countedIterations(run) >= run.limits.maxIterations) {
      this.finish(
        run,
        "exhausted",
        `max_iterations: ${run.limits.maxIterations} iterations used; failing: ${failingIds}`,
      );
      return;
    }
    const canResume =
      Boolean(run.sessionId) &&
      this.deps.executor.supportsResume(run.target) &&
      last?.outcome !== "spawn_failed";
    const instruction = run.pendingInstruction;
    run.pendingInstruction = null;
    const prompt = buildFeedbackPrompt(run, last, failing, {
      includeGoal: !canResume,
      instruction,
    });
    run.status = "running";
    await this.startIteration(run, prompt, canResume ? run.sessionId : null);
  }

  private async startIteration(
    run: GoalRun,
    prompt: string,
    resumeSessionId: string | null,
  ): Promise<void> {
    const index = (run.iterations.at(-1)?.index ?? 0) + 1;
    if (run.pendingInstruction && index === 1) {
      prompt = `${prompt}\n\n# Additional instruction from the operator\n${run.pendingInstruction}`;
      run.pendingInstruction = null;
    }
    const it: GoalIteration = {
      index,
      runId: null,
      sessionId: resumeSessionId,
      startedAt: this.now(),
      endedAt: null,
      outcome: "running",
      exitCode: null,
      prompt,
      outputTail: "",
      resumed: Boolean(resumeSessionId),
    };
    run.iterations.push(it);
    run.status = "running";
    try {
      const res = await this.deps.executor.start({
        goalId: run.id,
        iteration: index,
        target: run.target,
        prompt,
        workdir: run.workdir,
        resumeSessionId,
        label: `goal:${run.title}`.slice(0, 60),
        timeoutSec: run.limits.iterationTimeoutSec + 60,
      });
      it.runId = res.runId;
      if (res.sessionId) {
        it.sessionId = res.sessionId;
        run.sessionId = res.sessionId;
      }
      this.store.save(run);
      this.emit("goal.iteration", run);
      log.info("goal iteration started", {
        id: run.id,
        index,
        runId: res.runId,
        resumed: it.resumed,
      });
    } catch (err) {
      it.endedAt = this.now();
      it.outcome = "spawn_failed";
      it.note = err instanceof Error ? err.message : String(err);
      this.store.save(run);
      this.emit("goal.iteration", run);
      log.warn("goal iteration spawn failed", { id: run.id, index, error: it.note });
      // Next tick re-evaluates (running + ended iteration → evaluate).
    }
  }

  private complete(run: GoalRun): void {
    this.finish(run, "completed", null);
  }

  private finish(run: GoalRun, status: GoalRun["status"], reason: string | null): void {
    const now = this.now();
    if (run.activeSince) run.elapsedMs += now - run.activeSince;
    run.activeSince = null;
    run.status = status;
    run.reason = reason;
    run.finishedAt = now;
    this.store.save(run);
    log.info("goal run finished", { id: run.id, status, reason });
    this.emit(status === "completed" ? "goal.completed" : "goal.failed", run);
    if (run.notify && this.deps.notify) {
      void Promise.resolve(this.deps.notify(run)).catch(() => {});
    }
  }

  // ─── Operator controls ────────────────────────────────────────────────

  private mustGet(id: string): GoalRun {
    const run = this.store.get(id);
    if (!run) throw new Error(`goal run not found: ${id}`);
    return run;
  }

  private async interruptCurrent(run: GoalRun, outcome: GoalIterationOutcome, note: string) {
    const cur = run.iterations.at(-1);
    if (cur && cur.endedAt === null) {
      if (cur.runId) await this.deps.executor.kill(cur.runId, run.target).catch(() => {});
      await this.endIteration(run, cur, outcome, null, note);
    }
  }

  async pause(id: string): Promise<GoalRun> {
    return this.locked(id, async () => {
      const run = this.mustGet(id);
      if (GOAL_TERMINAL_STATUSES.has(run.status) || run.status === "paused") return run;
      await this.interruptCurrent(run, "interrupted", "paused by operator");
      if (run.activeSince) run.elapsedMs += this.now() - run.activeSince;
      run.activeSince = null;
      run.status = "paused";
      this.store.save(run);
      this.emit("goal.updated", run);
      return run;
    });
  }

  async resume(id: string): Promise<GoalRun> {
    return this.locked(id, async () => {
      const run = this.mustGet(id);
      if (run.status !== "paused") return run;
      run.activeSince = this.now();
      if (!run.startedAt) run.startedAt = this.now();
      if (run.iterations.length === 0) {
        run.status = "queued";
        this.store.save(run);
      } else {
        // Re-verify first: the operator may have fixed things by hand.
        await this.evaluate(run, "manual");
      }
      this.emit("goal.updated", run);
      return this.mustGet(id);
    });
  }

  async cancel(id: string, reason = "canceled by operator"): Promise<GoalRun> {
    return this.locked(id, async () => {
      const run = this.mustGet(id);
      if (GOAL_TERMINAL_STATUSES.has(run.status)) return run;
      await this.interruptCurrent(run, "canceled", reason);
      this.finish(run, "canceled", reason);
      return run;
    });
  }

  /**
   * Run every check now. A non-terminal (or failed/exhausted) run whose checks
   * all pass is completed; otherwise only the results are recorded.
   */
  async recheck(id: string): Promise<{ run: GoalRun; allPass: boolean }> {
    return this.locked(id, async () => {
      const run = this.mustGet(id);
      const cur = run.iterations.at(-1);
      const liveRunId = cur && cur.endedAt === null ? cur.runId : null;
      const allPass = await this.runSuite(run, "manual", liveRunId);
      if (allPass && run.status !== "completed" && run.status !== "canceled") {
        if (liveRunId) {
          await this.deps.executor.kill(liveRunId, run.target).catch(() => {});
          await this.endIteration(run, cur!, "checks_passed", null, "passed on manual re-check");
        }
        this.complete(run);
      } else {
        this.store.save(run);
      }
      return { run: this.mustGet(id), allPass };
    });
  }

  /**
   * Continue with an extra instruction. Running → interrupt the current
   * iteration and resume with the instruction. Terminal / paused → reopen
   * with a fresh budget (retry-from-failed when no instruction is given).
   */
  async continueWith(id: string, instruction?: string | null): Promise<GoalRun> {
    return this.locked(id, async () => {
      const run = this.mustGet(id);
      run.pendingInstruction = instruction?.trim() || null;
      if (run.status === "running" || run.status === "checking" || run.status === "queued") {
        if (!run.pendingInstruction) return run;
        if (run.status === "queued") {
          this.store.save(run);
          return run;
        }
        await this.interruptCurrent(run, "interrupted", "operator added an instruction");
        await this.evaluate(run, "manual");
        return this.mustGet(id);
      }
      // Reopen: extend the budget so the operator gets a real new attempt.
      const used = this.countedIterations(run);
      run.limits.maxIterations = Math.max(
        run.limits.maxIterations,
        used + Math.min(run.limits.maxIterations, 5),
      );
      const last = run.iterations.at(-1);
      if (last) last.budgetReset = true;
      run.limits.maxWallClockSec = Math.max(
        run.limits.maxWallClockSec,
        Math.ceil(run.elapsedMs / 1000) + run.limits.iterationTimeoutSec * 2,
      );
      run.status = run.iterations.length ? "running" : "queued";
      run.reason = null;
      run.finishedAt = null;
      run.activeSince = this.now();
      this.store.save(run);
      this.emit("goal.updated", run);
      if (run.iterations.length) {
        await this.evaluate(run, "manual");
      }
      return this.mustGet(id);
    });
  }

  /** Live (or final) output of an iteration — defaults to the latest one. */
  async log(
    id: string,
    iteration?: number,
  ): Promise<{ iteration: number; runId: string | null; running: boolean; output: string }> {
    const run = this.mustGet(id);
    const it =
      iteration !== undefined
        ? run.iterations.find((i) => i.index === iteration)
        : run.iterations.at(-1);
    if (!it) return { iteration: 0, runId: null, running: false, output: "" };
    const running = it.endedAt === null;
    const output =
      !running && it.outputTail
        ? it.outputTail
        : it.runId
          ? await this.deps.executor.output(it.runId, run.target).catch(() => "")
          : "";
    return { iteration: it.index, runId: it.runId, running, output };
  }

  retry(id: string): Promise<GoalRun> {
    return this.continueWith(id, null);
  }

  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    // Wait (briefly) for an in-flight tick step on this run to finish.
    for (let i = 0; i < 600 && this.busy.has(id); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
}
