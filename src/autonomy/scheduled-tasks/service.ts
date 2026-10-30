/**
 * Scheduled Agent Tasks — the service.
 *
 *   tick() (every 15s, idempotent, restart-safe — all state is in queue.db):
 *     1. due tasks        → start a run: a READ-ONLY suggestion goal run whose
 *                           completion check is the report validator
 *     2. running runs     → when the goal run completes: validate report.json,
 *                           check refs didn't move, render (black-gold PDF),
 *                           create pipeline items, deliver (Telegram + UI)
 *     3. pipeline items   → poll dev goal runs (building), deploy goal runs /
 *                           detached deploy commands (deploying), wake snoozes,
 *                           start queued builds when a slot frees
 *   decide()              → owner decisions (UI / Telegram / agent tool),
 *                           validated by the pure state machine in pipeline.ts
 *
 * Dev and deploy work are verified goal runs (src/autonomy/goals) in an
 * isolated git worktree per item. Nothing merges, pushes or deploys without an
 * explicit approval.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ReportPayload } from "../../reports/types.js";
import { describeCheck, runChecks } from "../goals/checks.js";
import { GOAL_TERMINAL_STATUSES, type GoalCheck, type GoalRun } from "../goals/types.js";
import type { DeliverySink, OutgoingMessage, SendResult } from "./delivery.js";
import {
  diffSummary,
  ensureWorktree,
  hasChangesCheck,
  refViolations,
  slug,
  snapshotRefs,
} from "./git.js";
import { PipelineError, transition, type PipelineEffect, type SystemEvent } from "./pipeline.js";
import {
  buildDeployGoal,
  buildDevGoal,
  buildSuggestionGoal,
  reportPath,
  validatorPath,
} from "./prompts.js";
import {
  finalReportPayload,
  itemButtons,
  itemText,
  lowRiskButton,
  readyText,
  runSummaryText,
  suggestionReportPayload,
  esc,
} from "./render.js";
import { validateReport, writeStandaloneValidator, REPORT_TEMPLATE_ID } from "./report-schema.js";
import { nextRunAt, resolveMissedRun, validateSchedule } from "./schedule.js";
import type { ScheduledTaskStore } from "./store.js";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_TASK_LIMITS,
  ITEM_TERMINAL_STAGES,
  deployCommandFor,
  type Decision,
  type ItemStage,
  type PipelineItem,
  type RepoSpec,
  type ScheduledTask,
  type TaskRun,
} from "./types.js";

const log = createSubsystemLogger("autonomy.scheduled");

/** The slice of the goal-run API the pipeline needs (injectable for tests). */
export interface GoalsApi {
  create(input: Record<string, unknown>): GoalRun;
  get(id: string): GoalRun | null;
  continueWith(id: string, instruction: string | null): Promise<GoalRun>;
  retry(id: string): Promise<GoalRun>;
  cancel(id: string, reason?: string): Promise<GoalRun>;
}

export interface ScheduledTaskServiceDeps {
  store: ScheduledTaskStore;
  goals: GoalsApi;
  sink: DeliverySink | null;
  stateDir: string;
  now?: () => number;
  /** Render a payload to a PDF at `path`; returns the report id (or null). Null disables PDFs. */
  renderPdf?:
    | ((payload: ReportPayload, path: string, kind: string) => Promise<string | null>)
    | null;
  emit?: (event: string, payload: Record<string, unknown>) => void;
  /** Missed schedule slots younger than this fire once on boot (default 6h). */
  catchUpMs?: number;
}

export type TaskInput = Partial<
  Pick<
    ScheduledTask,
    | "name"
    | "cron"
    | "timezone"
    | "assignee"
    | "repos"
    | "instructions"
    | "reportTemplate"
    | "delivery"
    | "deployCommand"
    | "enabled"
  >
> & {
  approval?: Partial<ScheduledTask["approval"]>;
  limits?: Partial<ScheduledTask["limits"]>;
  createdBy?: string | null;
  seedKey?: string | null;
};

const ACTIVE_BUILD: ItemStage[] = ["building", "deploying"];

function clampLimits(l: Partial<ScheduledTask["limits"]> | undefined, base = DEFAULT_TASK_LIMITS) {
  const out = { ...base };
  for (const [k, v] of Object.entries(l ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && k in out)
      (out as Record<string, number>)[k] = Math.floor(v);
  }
  return out;
}

function normalizeRepos(raw: unknown): RepoSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: RepoSpec[] = [];
  for (const r of raw) {
    if (typeof r === "string" && r.trim()) {
      const p = r.trim();
      out.push({ label: p.split("/").filter(Boolean).pop() ?? p, path: p });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!path) continue;
    const label =
      typeof o.label === "string" && o.label.trim()
        ? o.label.trim()
        : (path.split("/").filter(Boolean).pop() ?? path);
    out.push({
      label,
      path,
      ...(typeof o.branch === "string" && o.branch.trim() ? { branch: o.branch.trim() } : {}),
      ...(Array.isArray(o.focus) ? { focus: o.focus.map(String) } : {}),
      ...(typeof o.notes === "string" && o.notes.trim() ? { notes: o.notes.trim() } : {}),
    });
  }
  const labels = new Set<string>();
  for (const r of out) {
    if (labels.has(r.label)) throw new Error(`duplicate repo label: ${r.label}`);
    labels.add(r.label);
  }
  return out;
}

function checkEvidence(run: GoalRun): string {
  return run.checks
    .map((c) => {
      const r = run.lastResults[c.id ?? ""];
      const first = (r?.output ?? "").split("\n").find((l) => l.trim()) ?? "";
      return `${r?.pass ? "✓" : "✗"} ${describeCheck(c)}${first ? ` — ${first.slice(0, 160)}` : ""}`;
    })
    .join("\n");
}

export class ScheduledTaskService {
  readonly store: ScheduledTaskStore;
  private readonly goals: GoalsApi;
  private sink: DeliverySink | null;
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly renderPdf: ScheduledTaskServiceDeps["renderPdf"];
  private readonly emitFn: ScheduledTaskServiceDeps["emit"];
  private readonly catchUpMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: ScheduledTaskServiceDeps) {
    this.store = deps.store;
    this.goals = deps.goals;
    this.sink = deps.sink;
    this.stateDir = deps.stateDir;
    this.now = deps.now ?? Date.now;
    this.renderPdf = deps.renderPdf ?? null;
    this.emitFn = deps.emit;
    this.catchUpMs = deps.catchUpMs ?? 6 * 3600_000;
  }

  setSink(sink: DeliverySink | null): void {
    this.sink = sink;
  }

  private emit(payload: Record<string, unknown>): void {
    try {
      this.emitFn?.("scheduledTask.changed", payload);
    } catch {
      /* never throw into a write path */
    }
  }

  start(tickMs = 15_000): void {
    if (this.timer) return;
    this.recover();
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Boot: settle schedule slots that were missed while the gateway was down. */
  recover(): void {
    const now = this.now();
    for (const t of this.store.listTasks()) {
      if (!t.enabled) continue;
      const verdict = resolveMissedRun(t.nextRunAt, now, this.catchUpMs);
      if (verdict === "skip") {
        const next = nextRunAt(t.cron, t.timezone, now);
        if (t.nextRunAt !== null)
          this.store.logEvent({
            itemId: null,
            runId: null,
            taskId: t.id,
            from: null,
            to: "schedule_skipped",
            actor: "system",
            note: `missed slot ${new Date(t.nextRunAt).toISOString()} (older than catch-up window)`,
          });
        t.nextRunAt = next;
        this.store.saveTask(t);
      }
      // "run" → the first tick fires it; "wait" → nothing to do.
    }
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  createTask(input: TaskInput): ScheduledTask {
    const name = input.name?.trim();
    if (!name) throw new Error("name is required");
    const cron = (input.cron ?? "").trim();
    const timezone = (input.timezone ?? "UTC").trim();
    validateSchedule(cron, timezone);
    const repos = normalizeRepos(input.repos);
    const task = this.store.createTask({
      name,
      cron,
      timezone,
      assignee: input.assignee ?? { kind: "cli", backend: "claude-code" },
      repos,
      instructions: input.instructions ?? "",
      reportTemplate: input.reportTemplate ?? REPORT_TEMPLATE_ID,
      delivery: input.delivery?.length ? [...new Set(input.delivery)] : ["telegram", "ui"],
      approval: { ...DEFAULT_APPROVAL_POLICY, ...input.approval, mode: "per-item" },
      limits: clampLimits(input.limits),
      deployCommand: input.deployCommand?.trim() || null,
      enabled: input.enabled !== false,
      nextRunAt: nextRunAt(cron, timezone, this.now()),
      createdBy: input.createdBy ?? null,
      seedKey: input.seedKey ?? null,
    });
    this.store.logEvent({
      itemId: null,
      runId: null,
      taskId: task.id,
      from: null,
      to: "task_created",
      actor: input.createdBy ?? "system",
      note: `${cron} ${timezone}`,
    });
    this.emit({ taskId: task.id });
    return task;
  }

  updateTask(id: string, patch: TaskInput): ScheduledTask {
    const t = this.requireTask(id);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error("name cannot be empty");
      t.name = patch.name.trim();
    }
    const cron = patch.cron?.trim() ?? t.cron;
    const tz = patch.timezone?.trim() ?? t.timezone;
    if (cron !== t.cron || tz !== t.timezone) validateSchedule(cron, tz);
    const rescheduled = cron !== t.cron || tz !== t.timezone;
    t.cron = cron;
    t.timezone = tz;
    if (patch.assignee) t.assignee = patch.assignee;
    if (patch.repos) t.repos = normalizeRepos(patch.repos);
    if (patch.instructions !== undefined) t.instructions = patch.instructions;
    if (patch.reportTemplate) t.reportTemplate = patch.reportTemplate;
    if (patch.delivery?.length) t.delivery = [...new Set(patch.delivery)];
    if (patch.approval) t.approval = { ...t.approval, ...patch.approval, mode: "per-item" };
    if (patch.limits) t.limits = clampLimits(patch.limits, t.limits);
    if (patch.deployCommand !== undefined) t.deployCommand = patch.deployCommand?.trim() || null;
    const enabling = patch.enabled === true && !t.enabled;
    if (patch.enabled !== undefined) t.enabled = patch.enabled;
    if (rescheduled || enabling || t.nextRunAt === null)
      t.nextRunAt = nextRunAt(t.cron, t.timezone, this.now());
    this.store.saveTask(t);
    this.emit({ taskId: t.id });
    return t;
  }

  async deleteTask(id: string): Promise<void> {
    this.requireTask(id);
    for (const r of this.store.listRuns({ taskId: id, status: ["running"] })) {
      if (r.goalId) await this.goals.cancel(r.goalId, "scheduled task deleted").catch(() => {});
    }
    for (const it of this.store.listItems({ taskId: id, stages: ACTIVE_BUILD })) {
      const g = it.stage === "building" ? it.devGoalId : it.deployGoalId;
      if (g) await this.goals.cancel(g, "scheduled task deleted").catch(() => {});
    }
    this.store.deleteTask(id);
    this.emit({ taskId: id, deleted: true });
  }

  private requireTask(id: string): ScheduledTask {
    const t = this.store.getTask(id);
    if (!t) throw new Error(`scheduled task not found: ${id}`);
    return t;
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  runNow(taskId: string, trigger: TaskRun["trigger"] = "manual"): TaskRun {
    const task = this.requireTask(taskId);
    const busy = this.store.listRuns({ taskId, status: ["running", "validating"], limit: 1 });
    if (busy.length)
      throw new Error(`a run of "${task.name}" is already in progress (${busy[0].id})`);
    const missing = task.repos.filter((r) => !existsSync(r.path));
    const id = `sr_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const run = this.store.createRun({
      id,
      taskId,
      trigger,
      artifactDir: join(this.stateDir, "scheduled-tasks", "runs", id),
    });
    task.lastRunAt = this.now();
    task.lastRunId = run.id;
    this.store.saveTask(task);
    this.logRun(run, "run_started", trigger, `${task.repos.length} repo(s)`);
    try {
      if (!task.repos.length) throw new Error("task has no repos configured");
      if (missing.length)
        throw new Error(`repo path(s) not found: ${missing.map((r) => r.path).join(", ")}`);
      mkdirSync(run.artifactDir, { recursive: true });
      writeStandaloneValidator(
        validatorPath(run.artifactDir),
        task.repos.map((r) => r.label),
      );
      run.refsBefore = snapshotRefs(task.repos);
      const checks: GoalCheck[] = [
        {
          id: "report-valid",
          type: "shell",
          label: `report.json matches ${REPORT_TEMPLATE_ID}`,
          command: `"${process.execPath}" validate-report.mjs`,
          timeoutSec: 60,
        },
      ];
      const goal = this.goals.create({
        title: `[Scheduled] ${task.name} — review`,
        goal: buildSuggestionGoal(task, run.artifactDir),
        checks,
        target: task.assignee,
        workdir: run.artifactDir,
        limits: {
          maxIterations: task.limits.suggestionMaxIterations,
          maxWallClockSec: task.limits.suggestionTimeoutSec,
          iterationTimeoutSec: task.limits.suggestionTimeoutSec,
          checkIntervalSec: 60,
          hangSec: 15 * 60,
        },
        notify: false,
        createdBy: `scheduled-task:${task.id}`,
      });
      run.goalId = goal.id;
      this.store.saveRun(run);
    } catch (err) {
      this.failRun(task, run, String((err as Error)?.message ?? err));
    }
    this.emit({ taskId, runId: run.id });
    return this.store.getRun(run.id)!;
  }

  private logRun(run: TaskRun, to: string, actor: string, note: string | null): void {
    this.store.logEvent({
      itemId: null,
      runId: run.id,
      taskId: run.taskId,
      from: null,
      to,
      actor,
      note,
    });
  }

  private failRun(task: ScheduledTask, run: TaskRun, error: string): void {
    run.status = "failed";
    run.error = error;
    run.finishedAt = this.now();
    this.store.saveRun(run);
    this.logRun(run, "run_failed", "system", error);
    log.warn("scheduled run failed", { taskId: task.id, runId: run.id, error });
    void this.deliver(task, {
      kind: "run_failed",
      taskId: task.id,
      runId: run.id,
      text: `<b>${esc(task.name)}</b> — review failed\n${esc(error.slice(0, 1500))}\n\n<code>${run.id}</code>`,
    });
  }

  /** Completed suggestion goal run → validated report → items → delivery. Idempotent. */
  private async finalizeRun(task: ScheduledTask, run: TaskRun): Promise<void> {
    run.status = "validating";
    this.store.saveRun(run);
    let raw: string;
    try {
      raw = readFileSync(reportPath(run.artifactDir), "utf8");
    } catch {
      return this.failRun(task, run, "report.json was not written");
    }
    const v = validateReport(
      raw,
      task.repos.map((r) => r.label),
    );
    if (!v.ok || !v.report)
      return this.failRun(task, run, `invalid report: ${v.errors.join("; ")}`);
    const report = v.report;
    report.items = report.items.slice(0, task.limits.maxItems);
    run.report = report;
    run.readOnlyViolations = refViolations(task.repos, run.refsBefore);
    if (this.renderPdf && !run.reportPdfPath) {
      const pdf = join(run.artifactDir, "report.pdf");
      try {
        run.reportId = await this.renderPdf(
          suggestionReportPayload(task, run),
          pdf,
          "scheduled_task_report",
        );
        run.reportPdfPath = pdf;
      } catch (err) {
        log.warn("report render failed (delivering text only)", { error: String(err) });
      }
    }
    if (this.store.listItems({ runId: run.id }).length === 0) {
      for (const item of report.items) {
        const it = this.store.createItem({ runId: run.id, taskId: task.id, item });
        this.store.logEvent({
          itemId: it.id,
          runId: run.id,
          taskId: task.id,
          from: null,
          to: "suggested",
          actor: "assignee",
          note: `${item.priority} ${item.effort} ${item.risk}`,
        });
      }
    }
    run.status = "delivered";
    run.finishedAt = this.now();
    this.store.saveRun(run);
    this.logRun(
      run,
      "report_ready",
      "system",
      `${report.items.length} item(s)${run.readOnlyViolations.length ? `; read-only violations: ${run.readOnlyViolations.join(", ")}` : ""}`,
    );
    await this.deliverRun(task, run);
    this.emit({ taskId: task.id, runId: run.id });
  }

  private async deliverRun(task: ScheduledTask, run: TaskRun): Promise<void> {
    if (!task.delivery.includes("telegram") || !this.sink) {
      run.deliveredAt = this.now();
      this.store.saveRun(run);
      return;
    }
    run.deliveryAttempts += 1;
    const items = this.store.listItems({ runId: run.id });
    const first = await this.sink.send({
      kind: "report",
      taskId: task.id,
      runId: run.id,
      text: runSummaryText(task, run, Boolean(run.reportPdfPath)),
      pdfPath: run.reportPdfPath,
      pdfCaption: `${task.name} — work suggestions`,
    });
    if (!first.ok) {
      run.deliveryError = first.error ?? "delivery failed";
      this.store.saveRun(run);
      return;
    }
    for (const it of items) {
      if (it.tgMessageId) continue;
      const res = await this.sink.send({
        kind: "item",
        taskId: task.id,
        runId: run.id,
        itemId: it.id,
        text: itemText(it, task),
        buttons: itemButtons(it, task),
      });
      if (res.ok && res.messageId) {
        it.tgChatId = res.chatId ?? null;
        it.tgMessageId = res.messageId;
        this.store.saveItem(it);
      }
    }
    const low = items.filter((i) => i.stage === "suggested" && i.item.risk === "low").length;
    if (low > 1)
      await this.sink.send({
        kind: "bulk",
        taskId: task.id,
        runId: run.id,
        text: `Approve every low-risk item from <b>${esc(task.name)}</b> in one tap:`,
        buttons: lowRiskButton(run, low),
      });
    run.deliveredAt = this.now();
    run.deliveryError = null;
    this.store.saveRun(run);
  }

  private async deliver(task: ScheduledTask, msg: OutgoingMessage) {
    if (!task.delivery.includes("telegram") || !this.sink) return null;
    const r: SendResult = await this.sink
      .send(msg)
      .catch((err): SendResult => ({ ok: false, error: String(err) }));
    if (!r.ok) log.warn("scheduled-task delivery failed", { kind: msg.kind, error: r.error });
    return r;
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async decide(itemId: string, d: Decision): Promise<PipelineItem> {
    const item = this.store.getItem(itemId);
    if (!item) throw new Error(`pipeline item not found: ${itemId}`);
    const task = this.requireTask(item.taskId);
    const instruction = d.instruction?.trim() || null;
    const t = transition(item.stage, d.action, task.approval, {
      hasInstruction: Boolean(instruction),
    });
    const from = item.stage;
    if (instruction && (d.action === "modify" || d.action === "continue"))
      item.instructions.push(instruction);
    if (d.action === "snooze")
      item.snoozeUntil = this.now() + Math.max(0.25, d.snoozeHours ?? 24) * 3600_000;
    if (t.to !== "snoozed") item.snoozeUntil = null;
    item.stage = t.to;
    this.store.saveItem(item);
    this.store.logEvent({
      itemId: item.id,
      runId: item.runId,
      taskId: item.taskId,
      from,
      to: t.to,
      actor: d.actor ?? "owner",
      note: [d.action, instruction].filter(Boolean).join(": "),
    });
    await this.applyEffect(task, item, t.effect, instruction);
    const fresh = this.store.getItem(item.id)!;
    await this.refreshItemMessage(task, fresh);
    this.emit({ taskId: task.id, runId: item.runId, itemId: item.id });
    return fresh;
  }

  async approveLowRisk(runId: string, actor = "owner"): Promise<PipelineItem[]> {
    const items = this.store
      .listItems({ runId, stages: ["suggested", "snoozed"] })
      .filter((i) => i.item.risk === "low");
    const out: PipelineItem[] = [];
    for (const it of items) out.push(await this.decide(it.id, { action: "approve", actor }));
    return out;
  }

  private async refreshItemMessage(task: ScheduledTask, item: PipelineItem): Promise<void> {
    if (!this.sink || !item.tgChatId || !item.tgMessageId) return;
    await this.sink
      .edit(item.tgChatId, item.tgMessageId, itemText(item, task), itemButtons(item, task))
      .catch(() => {});
  }

  /** Apply a system event (build/deploy outcome, snooze wake). */
  private async systemEvent(
    task: ScheduledTask,
    item: PipelineItem,
    ev: SystemEvent,
    note: string | null,
  ): Promise<void> {
    let t;
    try {
      t = transition(item.stage, ev, task.approval);
    } catch (err) {
      if (err instanceof PipelineError) return;
      throw err;
    }
    const from = item.stage;
    item.stage = t.to;
    if (ev === "wake") item.snoozeUntil = null;
    this.store.saveItem(item);
    this.store.logEvent({
      itemId: item.id,
      runId: item.runId,
      taskId: item.taskId,
      from,
      to: t.to,
      actor: "system",
      note: note ? note.slice(0, 500) : ev,
    });
    await this.applyEffect(task, item, t.effect, null);
    await this.refreshItemMessage(task, this.store.getItem(item.id)!);
    this.emit({ taskId: task.id, runId: item.runId, itemId: item.id });
  }

  private async applyEffect(
    task: ScheduledTask,
    item: PipelineItem,
    effect: PipelineEffect,
    instruction: string | null,
  ): Promise<void> {
    switch (effect) {
      case "none":
        return;
      case "start_build":
        return this.startBuild(task, item);
      case "retry_build":
        if (!item.devGoalId) return this.startBuild(task, item);
        await this.goals.retry(item.devGoalId);
        return;
      case "continue_build":
        if (!item.devGoalId) return this.startBuild(task, item);
        await this.goals.continueWith(item.devGoalId, instruction);
        return;
      case "cancel_build":
        if (item.devGoalId)
          await this.goals.cancel(item.devGoalId, "rejected by owner").catch(() => {});
        return;
      case "start_deploy":
      case "retry_deploy":
        return this.startDeploy(task, item);
      case "notify_suggested":
        await this.sendItem(task, item, "item");
        return;
      case "notify_ready": {
        const r = await this.deliver(task, {
          kind: "ready",
          taskId: task.id,
          runId: item.runId,
          itemId: item.id,
          text: readyText(item, task),
          buttons: itemButtons(item, task),
        });
        if (r?.ok && r.messageId) {
          item.tgChatId = r.chatId ?? item.tgChatId;
          item.tgMessageId = r.messageId;
          this.store.saveItem(item);
        }
        return;
      }
      case "notify_build_failed":
      case "notify_deploy_failed":
        await this.sendItem(
          task,
          item,
          effect === "notify_build_failed" ? "build_failed" : "deploy_failed",
        );
        return;
      case "final_report":
        return this.sendFinal(task, item);
    }
  }

  private async sendItem(task: ScheduledTask, item: PipelineItem, kind: string): Promise<void> {
    const r = await this.deliver(task, {
      kind,
      taskId: task.id,
      runId: item.runId,
      itemId: item.id,
      text: itemText(item, task),
      buttons: itemButtons(item, task),
    });
    if (r?.ok && r.messageId) {
      item.tgChatId = r.chatId ?? item.tgChatId;
      item.tgMessageId = r.messageId;
      this.store.saveItem(item);
    }
  }

  private buildSlotsFree(task: ScheduledTask): boolean {
    return (
      this.store.listItems({ taskId: task.id, stages: ["building"] }).length <
      task.limits.maxConcurrentBuilds
    );
  }

  private async startBuild(task: ScheduledTask, item: PipelineItem): Promise<void> {
    if (
      this.store
        .listItems({ taskId: task.id, stages: ["building"] })
        .filter((i) => i.id !== item.id).length >= task.limits.maxConcurrentBuilds
    ) {
      item.stage = "approved";
      this.store.saveItem(item);
      this.store.logEvent({
        itemId: item.id,
        runId: item.runId,
        taskId: task.id,
        from: "building",
        to: "approved",
        actor: "system",
        note: `waiting for a build slot (max ${task.limits.maxConcurrentBuilds})`,
      });
      return;
    }
    try {
      const repo = task.repos.find((r) => r.label === item.item.repo);
      if (!repo) throw new Error(`repo "${item.item.repo}" is not configured on this task`);
      const dir =
        item.worktreePath ??
        join(this.stateDir, "scheduled-tasks", "worktrees", `${slug(task.name, 24)}-${item.id}`);
      const branch =
        item.branch ??
        `sched/${slug(task.name, 24)}/${slug(item.reportItemId, 30)}-${item.id.slice(3, 9)}`;
      const wt = ensureWorktree(repo, dir, branch);
      item.worktreePath = wt.path;
      item.branch = wt.branch;
      item.baseSha = item.baseSha ?? wt.baseSha;
      item.stage = "building";
      const goal = this.goals.create({
        title: `[Scheduled] ${item.item.title}`,
        goal: buildDevGoal(task, item),
        checks: [...item.item.checks, hasChangesCheck(item.baseSha!)],
        target: task.assignee,
        workdir: wt.path,
        limits: {
          maxIterations: task.limits.devMaxIterations,
          maxWallClockSec: task.limits.devMaxWallClockSec,
          iterationTimeoutSec: task.limits.devIterationTimeoutSec,
        },
        notify: false,
        createdBy: `scheduled-task:${task.id}`,
      });
      item.devGoalId = goal.id;
      item.lastError = null;
      this.store.saveItem(item);
      this.store.logEvent({
        itemId: item.id,
        runId: item.runId,
        taskId: task.id,
        from: null,
        to: "build_started",
        actor: "system",
        note: `goal ${goal.id} in ${wt.path} (${wt.branch})`,
      });
    } catch (err) {
      item.lastError = String((err as Error)?.message ?? err);
      this.store.saveItem(item);
      await this.systemEvent(task, item, "build_fail", item.lastError);
    }
  }

  private async startDeploy(task: ScheduledTask, item: PipelineItem): Promise<void> {
    const command = deployCommandFor(task, item.item);
    item.deployOutput = null;
    item.lastError = null;
    try {
      if (!item.worktreePath || !existsSync(item.worktreePath))
        throw new Error("the item's worktree is missing");
      if (command) {
        const dir = join(this.stateDir, "scheduled-tasks", "deploys", `${item.id}-${this.now()}`);
        mkdirSync(dir, { recursive: true });
        const script = `(${command}) > "${dir}/out.log" 2>&1; echo $? > "${dir}/exit.code"`;
        const child = spawn("bash", ["-lc", script], {
          cwd: item.worktreePath,
          detached: true,
          stdio: "ignore",
          env: { ...process.env, INFINIBOT_SCHEDULED_DEPLOY: item.id },
        });
        child.unref();
        writeFileSync(join(dir, "started.at"), String(this.now()));
        item.deployDir = dir;
        item.deployPid = child.pid ?? null;
        item.deployGoalId = null;
        this.store.saveItem(item);
        this.store.logEvent({
          itemId: item.id,
          runId: item.runId,
          taskId: task.id,
          from: null,
          to: "deploy_command_started",
          actor: "system",
          note: command.slice(0, 300),
        });
        return;
      }
      const checks: GoalCheck[] = item.item.deploy.checks?.length
        ? item.item.deploy.checks
        : [
            {
              id: "deploy-verified",
              type: "llm",
              criterion:
                "Every step of the deploy plan was executed and the output shows concrete evidence the deploy succeeded and is healthy.",
            },
          ];
      const goal = this.goals.create({
        title: `[Scheduled] Deploy: ${item.item.title}`,
        goal: buildDeployGoal(task, item),
        checks,
        target: task.assignee,
        workdir: item.worktreePath,
        limits: {
          maxIterations: 2,
          maxWallClockSec: task.limits.deployTimeoutSec,
          iterationTimeoutSec: task.limits.deployTimeoutSec,
        },
        notify: false,
        createdBy: `scheduled-task:${task.id}`,
      });
      item.deployGoalId = goal.id;
      item.deployDir = null;
      item.deployPid = null;
      this.store.saveItem(item);
    } catch (err) {
      item.lastError = String((err as Error)?.message ?? err);
      this.store.saveItem(item);
      await this.systemEvent(task, item, "deploy_fail", item.lastError);
    }
  }

  private async sendFinal(task: ScheduledTask, item: PipelineItem): Promise<void> {
    const events = this.store.events({ itemId: item.id });
    let pdf: string | null = null;
    if (this.renderPdf) {
      const dir = join(this.stateDir, "scheduled-tasks", "runs", item.runId);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `final-${item.id}.pdf`);
      try {
        await this.renderPdf(finalReportPayload(task, item, events), p, "scheduled_task_final");
        pdf = p;
      } catch (err) {
        log.warn("final report render failed", { error: String(err) });
      }
    }
    await this.deliver(task, {
      kind: "final",
      taskId: task.id,
      runId: item.runId,
      itemId: item.id,
      text: `<b>${item.stage === "deployed" ? "Deployed" : "Closed"}: ${esc(item.item.title)}</b>\n${esc(
        (item.deployOutput ?? item.diffSummary ?? "").slice(0, 1200),
      )}\n\n<code>${item.id}</code>`,
      pdfPath: pdf,
      pdfCaption: `${item.item.title} — final report`,
    });
  }

  // ── tick ─────────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickSchedules();
      await this.tickRuns();
      await this.tickItems();
    } catch (err) {
      log.warn("scheduled-task tick failed", { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async tickSchedules(): Promise<void> {
    const now = this.now();
    for (const t of this.store.listTasks()) {
      if (!t.enabled || t.nextRunAt === null || t.nextRunAt > now) continue;
      t.nextRunAt = nextRunAt(t.cron, t.timezone, now + 1000);
      this.store.saveTask(t);
      try {
        this.runNow(t.id, "schedule");
      } catch (err) {
        this.store.logEvent({
          itemId: null,
          runId: null,
          taskId: t.id,
          from: null,
          to: "schedule_skipped",
          actor: "system",
          note: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  private async tickRuns(): Promise<void> {
    for (const run of this.store.listRuns({ status: ["running", "validating"], limit: 100 })) {
      const task = this.store.getTask(run.taskId);
      if (!task) continue;
      if (run.status === "validating") {
        await this.finalizeRun(task, run);
        continue;
      }
      if (!run.goalId) continue;
      const g = this.goals.get(run.goalId);
      if (!g) {
        this.failRun(task, run, `goal run ${run.goalId} disappeared`);
        continue;
      }
      if (!GOAL_TERMINAL_STATUSES.has(g.status)) continue;
      if (g.status === "completed") await this.finalizeRun(task, run);
      else this.failRun(task, run, `review ${g.status}: ${g.reason ?? "no reason"}`);
    }
    // Retry failed Telegram deliveries a few times.
    for (const run of this.store.listRuns({ status: ["delivered"], limit: 20 })) {
      if (!run.deliveryError || run.deliveryAttempts >= 5) continue;
      if (this.now() - run.updatedAt < 60_000 * run.deliveryAttempts) continue;
      const task = this.store.getTask(run.taskId);
      if (task) await this.deliverRun(task, run);
    }
  }

  private async tickItems(): Promise<void> {
    const now = this.now();
    for (const it of this.store.listItems({ stages: ["snoozed"] })) {
      if (it.snoozeUntil !== null && it.snoozeUntil <= now) {
        const task = this.store.getTask(it.taskId);
        if (task) await this.systemEvent(task, it, "wake", "snooze ended");
      }
    }
    for (const it of this.store.listItems({ stages: ["building"] })) {
      const task = this.store.getTask(it.taskId);
      if (!task || !it.devGoalId) continue;
      const g = this.goals.get(it.devGoalId);
      if (!g) {
        it.lastError = `dev goal ${it.devGoalId} disappeared`;
        this.store.saveItem(it);
        await this.systemEvent(task, it, "build_fail", it.lastError);
        continue;
      }
      if (!GOAL_TERMINAL_STATUSES.has(g.status)) continue;
      it.testEvidence = checkEvidence(g);
      if (it.worktreePath && it.baseSha) it.diffSummary = diffSummary(it.worktreePath, it.baseSha);
      if (g.status === "completed") {
        this.store.saveItem(it);
        await this.systemEvent(
          task,
          it,
          "build_ok",
          `goal ${g.id} completed (${g.iterations.length} iteration(s))`,
        );
      } else {
        it.lastError = `${g.status}: ${g.reason ?? "no reason"}`;
        this.store.saveItem(it);
        await this.systemEvent(task, it, "build_fail", it.lastError);
      }
    }
    // Queued builds (approved while no slot was free, autoContinue on).
    for (const it of this.store.listItems({ stages: ["approved"] }).reverse()) {
      const task = this.store.getTask(it.taskId);
      if (!task || !task.approval.autoContinueOnApprove || !this.buildSlotsFree(task)) continue;
      it.stage = "building";
      this.store.saveItem(it);
      await this.startBuild(task, it);
      await this.refreshItemMessage(task, this.store.getItem(it.id)!);
      this.emit({ taskId: task.id, itemId: it.id });
    }
    for (const it of this.store.listItems({ stages: ["deploying"] })) {
      const task = this.store.getTask(it.taskId);
      if (!task) continue;
      if (it.deployGoalId) {
        const g = this.goals.get(it.deployGoalId);
        if (!g || !GOAL_TERMINAL_STATUSES.has(g.status)) continue;
        it.deployOutput = checkEvidence(g);
        if (g.status === "completed") {
          this.store.saveItem(it);
          await this.systemEvent(task, it, "deploy_ok", `deploy goal ${g.id} completed`);
        } else {
          it.lastError = `deploy ${g.status}: ${g.reason ?? ""}`;
          this.store.saveItem(it);
          await this.systemEvent(task, it, "deploy_fail", it.lastError);
        }
        continue;
      }
      if (it.deployDir) await this.pollDeployCommand(task, it);
    }
  }

  private async pollDeployCommand(task: ScheduledTask, it: PipelineItem): Promise<void> {
    const dir = it.deployDir!;
    const exitFile = join(dir, "exit.code");
    const out = () => {
      try {
        return readFileSync(join(dir, "out.log"), "utf8").slice(-4000);
      } catch {
        return "";
      }
    };
    if (!existsSync(exitFile)) {
      const started = Number(readFileSync(join(dir, "started.at"), "utf8")) || it.updatedAt;
      let alive = false;
      if (it.deployPid) {
        try {
          process.kill(it.deployPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive && this.now() - started < task.limits.deployTimeoutSec * 1000) return;
      if (alive && it.deployPid) {
        try {
          process.kill(-it.deployPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      // Re-check: the command may have finished between the two reads.
      if (existsSync(exitFile)) return;
      it.deployOutput = out();
      it.lastError = alive
        ? `deploy command timed out after ${task.limits.deployTimeoutSec}s`
        : "deploy command vanished without an exit code (gateway restart or kill)";
      this.store.saveItem(it);
      await this.systemEvent(task, it, "deploy_fail", it.lastError);
      return;
    }
    const code = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
    const output = out();
    if (code !== 0) {
      it.deployOutput = output;
      it.lastError = `deploy command exited ${code}`;
      this.store.saveItem(it);
      await this.systemEvent(task, it, "deploy_fail", it.lastError);
      return;
    }
    const checks = it.item.deploy.checks ?? [];
    let evidence = `$ ${deployCommandFor(task, it.item)} → exit 0\n${output}`;
    if (checks.length) {
      const res = await runChecks(checks, {
        workdir: it.worktreePath,
        goalText: it.item.title,
        getAgentOutput: () => output,
        iteration: 1,
        trigger: "manual",
      });
      evidence += `\n\nPost-deploy checks:\n${res.results
        .map(
          (r, i) =>
            `${r.pass ? "✓" : "✗"} ${describeCheck(checks[i])} ${r.output.split("\n")[0] ?? ""}`,
        )
        .join("\n")}`;
      if (!res.allPass) {
        it.deployOutput = evidence.slice(-6000);
        it.lastError = "post-deploy checks failed";
        this.store.saveItem(it);
        await this.systemEvent(task, it, "deploy_fail", it.lastError);
        return;
      }
    }
    it.deployOutput = evidence.slice(-6000);
    this.store.saveItem(it);
    await this.systemEvent(task, it, "deploy_ok", "deploy command exit 0");
  }

  // ── views ────────────────────────────────────────────────────────────────

  summarizeTask(t: ScheduledTask) {
    const runs = this.store.listRuns({ taskId: t.id, limit: 1 });
    const items = this.store.listItems({ taskId: t.id });
    const count = (stages: ItemStage[]) => items.filter((i) => stages.includes(i.stage)).length;
    return {
      ...t,
      lastRun: runs[0]
        ? {
            id: runs[0].id,
            status: runs[0].status,
            createdAt: runs[0].createdAt,
            items: runs[0].report?.items.length ?? null,
            error: runs[0].error,
          }
        : null,
      counts: {
        awaitingDecision: count(["suggested", "awaiting_deploy", "build_failed", "deploy_failed"]),
        inFlight: count(["approved", "building", "deploying"]),
        deployed: count(["deployed"]),
        closed: items.filter((i) => ITEM_TERMINAL_STAGES.has(i.stage)).length,
      },
    };
  }
}
