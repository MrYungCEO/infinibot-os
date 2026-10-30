/**
 * Autonomy lifecycle suite — the real state machine, end to end, over the live
 * gateway.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * Autonomous execution is ENABLED on this deployment, so moving a card into the
 * `accepted` (Staged) column spawns a real `claude` / `codex` CLI and costs
 * money. This suite therefore has two modes:
 *
 *   SAFE (default)  Never stages a card that could execute. It asserts the
 *                   lifecycle guards and the autonomy policy through
 *                   `work-item.execution.status`, which is a pure read-only
 *                   description of what WOULD happen. The one card it does
 *                   stage belongs to a worker temporarily demoted to autonomy
 *                   level 0 — a level the executor provably refuses to run
 *                   before it ever reaches a spawn.
 *
 *   LIVE (--live)   Additionally stages real cards for level-1 / level-2 /
 *                   level-3 workers and the codex-bound failure path, then
 *                   polls them to settlement. This SPENDS MONEY.
 *
 * Every work item this file creates is cancelled in a `finally`, and the
 * temporary autonomy-level change is restored there too.
 */
import { sleep } from "./lib/harness.mjs";

/** Namespace the executor writes per-worker run records into. */
const JOB_MEMORY_NAMESPACE = "work-item-execution";
/** The single board stage that authorises autonomous work. */
const EXECUTION_STAGE = "accepted";
/** Marker so leftovers are always identifiable and greppable. */
export const PROBE_PREFIX = "e2e-autonomy probe";

const TRIVIAL_INSTRUCTIONS =
  "This is an automated end-to-end probe. Reply with exactly one sentence stating your role. " +
  "Do not create, modify or delete any files. Do not run any commands. Do not call any tools.";

/**
 * Statuses a probe item can be cancelled from directly. `review` needs a hop
 * back through `in_progress`; `completed` is terminal and cannot be undone.
 */
const DIRECTLY_CANCELLABLE = new Set([
  "queued",
  "accepted",
  "in_progress",
  "waiting",
  "escalated",
]);

/**
 * Mirror of `decideAutonomy` in src/workforce/executor.ts. Kept here as an
 * INDEPENDENT expectation so the suite verifies the server's behaviour rather
 * than importing (and therefore trusting) the same code it is testing.
 */
function expectedAutonomy(worker) {
  const level = worker.autonomyLevel;
  if (!(level > 0)) return { execute: false, terminalStage: null, why: "autonomyLevel 0" };
  if (level === 1) return { execute: true, terminalStage: "review", why: "autonomyLevel 1 is draft-only" };
  if (level === 2) {
    const threshold = Number.isFinite(worker.approvalThreshold) ? worker.approvalThreshold : 0;
    // Probe items declare no estimatedCost, so cost is 0.
    return {
      execute: true,
      terminalStage: 0 <= threshold ? "completed" : "review",
      why: `autonomyLevel 2, cost 0 vs approvalThreshold ${threshold}`,
    };
  }
  return { execute: true, terminalStage: "completed", why: "autonomyLevel 3 is autonomous" };
}

export async function runAutonomySuite(session, reporter, agencyId, { live = false } = {}) {
  const { rpc } = session;
  /** Every work item id this suite created — cancelled in the finally. */
  const created = [];
  /** {employeeId, autonomyLevel} to restore. */
  let demoted = null;

  const createProbe = async (worker, label) => {
    const res = await rpc("agency.ops.employee.work-item.create", {
      agencyId,
      workerId: worker.id,
      title: `${PROBE_PREFIX} — ${label} — ${worker.name}`,
      instructions: TRIVIAL_INSTRUCTIONS,
      priority: "low",
    });
    if (!res.ok) return { ok: false, error: res.error };
    const item = res.payload?.workItem ?? res.payload;
    if (item?.id) created.push(item.id);
    return { ok: true, item };
  };

  try {
    // ── Discovery ───────────────────────────────────────────────────────────
    reporter.group("autonomy: discovery");
    const employeesRes = await rpc("agency.ops.employees.list", { agencyId });
    if (!employeesRes.ok) {
      reporter.fail("employees.list", employeesRes.error);
      return;
    }
    const ai = (employeesRes.payload?.employees ?? []).filter((e) => e.kind === "ai");
    reporter.check("agency has AI workers", ai.length > 0, `${ai.length} found`);
    reporter.info(
      `AI workforce: ${ai.map((w) => `${w.name}=L${w.autonomyLevel}`).join(", ")}`,
    );
    reporter.check(
      "every AI worker declares a valid autonomy level (0-3)",
      ai.every((w) => Number.isInteger(w.autonomyLevel) && w.autonomyLevel >= 0 && w.autonomyLevel <= 3),
      ai.filter((w) => !(w.autonomyLevel >= 0 && w.autonomyLevel <= 3)).map((w) => w.name).join(", "),
    );
    const byLevel = (n) => ai.filter((w) => w.autonomyLevel === n);
    reporter.check(
      "the workforce spans more than one autonomy level",
      new Set(ai.map((w) => w.autonomyLevel)).size > 1,
      `levels present: ${[...new Set(ai.map((w) => w.autonomyLevel))].sort().join(",")}`,
    );

    const readiness = await rpc("agency.ops.employee.work-item.execution.list", { agencyId, limit: 200 });
    if (!readiness.ok) {
      reporter.fail("execution.list", readiness.error);
      return;
    }
    const executorEnabled = readiness.payload?.executorEnabled === true;
    const preStaged = readiness.payload?.items ?? [];
    reporter.check(
      "execution feed reports the staged column as the execution stage",
      readiness.payload?.stage === EXECUTION_STAGE,
      `stage=${readiness.payload?.stage}`,
    );
    reporter.info(`executorEnabled=${executorEnabled}, ${preStaged.length} card(s) already staged`);
    if (preStaged.length) {
      reporter.info(
        "WARNING: pre-existing staged cards belong to someone else; ticking would execute them.",
      );
    }

    // ── Lifecycle guards (no execution possible) ────────────────────────────
    reporter.group("autonomy: lifecycle guards");
    const guardWorker = ai[0];
    const guard = await createProbe(guardWorker, "guard");
    if (!guard.ok) {
      reporter.fail("work-item.create", guard.error);
      return;
    }
    reporter.check(
      "generated work lands in queued (the backlog), never staged",
      guard.item.status === "queued",
      `status=${guard.item.status}`,
    );

    // THE gate: a backlog item must not be executable. If this ever passes the
    // staged column stops being a human authorisation boundary.
    const illegal = await rpc("agency.ops.employee.work-item.transition", {
      agencyId,
      workItemId: guard.item.id,
      status: "in_progress",
    });
    reporter.check(
      "queued -> in_progress is REJECTED (staged column is a real authorisation gate)",
      !illegal.ok && /invalid work item transition/i.test(illegal.error ?? ""),
      illegal.ok ? "the transition was ACCEPTED — the approval gate is bypassable" : illegal.error,
    );

    for (const status of ["review", "completed", "waiting"]) {
      const res = await rpc("agency.ops.employee.work-item.transition", {
        agencyId,
        workItemId: guard.item.id,
        status,
      });
      reporter.check(
        `queued -> ${status} is REJECTED`,
        !res.ok && /invalid work item transition/i.test(res.error ?? ""),
        res.ok ? "the transition was ACCEPTED" : res.error,
      );
    }

    const guardStatus = await rpc("agency.ops.employee.work-item.execution.status", {
      agencyId,
      workItemId: guard.item.id,
    });
    const guardView = guardStatus.payload?.execution;
    reporter.check(
      "a queued card is not execution-eligible",
      guardStatus.ok && guardView?.executionEligible === false,
      `executionEligible=${guardView?.executionEligible} (${guardStatus.error ?? ""})`,
    );
    reporter.check(
      "a queued card explains that staging is required",
      /accepted|stage/i.test(guardView?.blockedReason ?? ""),
      `blockedReason=${guardView?.blockedReason}`,
    );

    const stagedFeed = await rpc("agency.ops.employee.work-item.execution.list", { agencyId, limit: 200 });
    reporter.check(
      "a queued card does not appear in the staged execution feed",
      !(stagedFeed.payload?.items ?? []).some((i) => i.workItemId === guard.item.id),
      "backlog item leaked into the execution feed",
    );

    // ── Autonomy policy, per worker, read-only ──────────────────────────────
    // `execution.status` describes what WOULD happen. Asserting it for every
    // worker proves the level mapping is honoured without spawning anything.
    reporter.group("autonomy: level policy (read-only)");
    const probes = new Map();
    for (const worker of ai) {
      const probe = worker.id === guardWorker.id ? guard : await createProbe(worker, "policy");
      if (!probe.ok) {
        reporter.fail(`probe for ${worker.name}`, probe.error);
        continue;
      }
      probes.set(worker.id, probe.item);
      const status = await rpc("agency.ops.employee.work-item.execution.status", {
        agencyId,
        workItemId: probe.item.id,
      });
      const view = status.payload?.execution;
      if (!status.ok || !view) {
        reporter.fail(`execution.status for ${worker.name}`, status.error ?? "no execution view");
        continue;
      }
      const expected = expectedAutonomy(worker);
      reporter.check(
        `${worker.name} (L${worker.autonomyLevel}) reports autonomyLevel to the board`,
        view.autonomyLevel === worker.autonomyLevel,
        `board says ${view.autonomyLevel}, roster says ${worker.autonomyLevel}`,
      );
      reporter.check(
        `${worker.name} (L${worker.autonomyLevel}) would land in ${expected.terminalStage ?? "nothing"} — ${expected.why}`,
        view.terminalStage === expected.terminalStage,
        `terminalStage=${view.terminalStage}, expected ${expected.terminalStage}`,
      );
      if (!expected.execute) {
        reporter.check(
          `${worker.name} at level 0 is blocked with a human-operator reason`,
          /autonomyLevel 0/i.test(view.blockedReason ?? ""),
          `blockedReason=${view.blockedReason}`,
        );
      }
      reporter.check(
        `${worker.name} resolves to a coder backend`,
        typeof view.backend === "string" && view.backend.length > 0,
        `backend=${view.backend}`,
      );
    }
    const level1 = byLevel(1);
    const level3 = byLevel(3);
    reporter.check(
      "at least one level-1 (draft-only) worker exists",
      level1.length > 0,
      "no level-1 worker to exercise the always-review path",
    );
    reporter.check(
      "at least one level-3 (autonomous) worker exists",
      level3.length > 0,
      "no level-3 worker to exercise the auto-complete path",
    );

    // ── Level 0 never executes, even when staged ────────────────────────────
    // Demote a worker to level 0, stage its card, and tick. `decideAutonomy`
    // returns execute:false before any spawn, so this is free and safe.
    reporter.group("autonomy: level 0 never executes even when staged");
    const canTick = preStaged.length === 0;
    if (!canTick) {
      reporter.skip(
        "level-0 staged card is skipped by the executor",
        `${preStaged.length} pre-existing staged card(s) — ticking would execute someone else's work`,
      );
      reporter.skip("loop.tick runs generation AND execution", "same reason");
    } else {
      const victim = ai.find((w) => w.autonomyLevel > 0) ?? ai[0];
      const victimProbe = probes.get(victim.id);
      const update = await rpc("agency.ops.employee.update", {
        agencyId,
        employeeId: victim.id,
        autonomyLevel: 0,
      });
      if (!update.ok) {
        reporter.skip("level-0 staged card is skipped by the executor", `could not demote: ${update.error}`);
      } else {
        demoted = { employeeId: victim.id, autonomyLevel: victim.autonomyLevel };
        const stage = await rpc("agency.ops.employee.work-item.transition", {
          agencyId,
          workItemId: victimProbe.id,
          status: EXECUTION_STAGE,
        });
        reporter.check(
          "queued -> accepted (staging) is the one route to execution",
          stage.ok && stage.payload?.workItem?.status === EXECUTION_STAGE,
          stage.ok ? `status=${stage.payload?.workItem?.status}` : stage.error,
        );
        const before = await rpc("agency.ops.employee.work-item.execution.status", {
          agencyId,
          workItemId: victimProbe.id,
        });
        reporter.check(
          "a staged level-0 card is reported as blocked, not runnable",
          /autonomyLevel 0/i.test(before.payload?.execution?.blockedReason ?? ""),
          `blockedReason=${before.payload?.execution?.blockedReason}`,
        );

        // ── loop.tick must run BOTH halves ────────────────────────────────
        // It regressed to generation-only once, which froze every staged card
        // until the next background pass.
        const tick = await rpc("agency.ops.employee.loop.tick", { agencyId });
        reporter.check("loop.tick succeeds", tick.ok, tick.error ?? "");
        reporter.check(
          "loop.tick runs the GENERATION half (returns a loop result)",
          Boolean(tick.payload?.result),
          `payload keys: ${Object.keys(tick.payload ?? {}).join(",")}`,
        );
        reporter.check(
          "loop.tick runs the EXECUTION half (returns an execution pass)",
          tick.payload?.execution != null && typeof tick.payload.execution === "object",
          `execution=${JSON.stringify(tick.payload?.execution)} — a generation-only tick leaves staged cards frozen`,
        );
        if (tick.payload?.execution) {
          reporter.check(
            "the execution pass reports the executor as enabled",
            tick.payload.execution.enabled === executorEnabled,
            `pass.enabled=${tick.payload.execution.enabled}, executorEnabled=${executorEnabled}`,
          );
          reporter.check(
            "the execution pass considered the staged card",
            (tick.payload.execution.considered ?? 0) >= 1,
            `considered=${tick.payload.execution.considered}`,
          );
          reporter.check(
            "the execution pass SKIPPED it rather than executing it",
            (tick.payload.execution.executed ?? 0) === 0 &&
              (tick.payload.execution.skipped ?? 0) >= 1,
            `executed=${tick.payload.execution.executed} skipped=${tick.payload.execution.skipped}`,
          );
          const result = (tick.payload.execution.results ?? []).find(
            (r) => r.workItemId === victimProbe.id,
          );
          reporter.check(
            "the skip reason names autonomy level 0",
            /autonomyLevel 0/i.test(result?.reason ?? ""),
            `reason=${result?.reason}`,
          );
        }

        const after = await rpc("agency.ops.employee.work-item.execution.status", {
          agencyId,
          workItemId: victimProbe.id,
        });
        reporter.check(
          "the level-0 card stayed staged — it was never started",
          after.payload?.execution?.stage === EXECUTION_STAGE,
          `stage=${after.payload?.execution?.stage}`,
        );
      }
    }

    // ── Per-worker job memory ──────────────────────────────────────────────
    reporter.group("autonomy: job memory");
    let memoryFound = false;
    let memoryWorker = null;
    for (const worker of ai) {
      const mem = await rpc("agency.ops.employee.memory.list", {
        agencyId,
        workerId: worker.id,
        namespace: JOB_MEMORY_NAMESPACE,
      });
      const records = mem.payload?.memory ?? [];
      if (records.some((r) => r.key === "last-run")) {
        memoryFound = true;
        memoryWorker = worker.name;
        const lastRun = records.find((r) => r.key === "last-run");
        reporter.check(
          `${worker.name}'s last-run record carries an outcome and a backend`,
          Boolean(lastRun?.value?.outcome) && Boolean(lastRun?.value?.backend),
          `value=${JSON.stringify(lastRun?.value).slice(0, 200)}`,
        );
        break;
      }
    }
    reporter.check(
      `job memory is written on execution (namespace "${JOB_MEMORY_NAMESPACE}", key "last-run")`,
      memoryFound,
      memoryFound
        ? `found on ${memoryWorker}`
        : "no worker has a last-run record; either nothing has ever executed or the executor stopped persisting memory",
    );

    // ── LIVE: real execution ───────────────────────────────────────────────
    reporter.group("autonomy: live execution");
    if (!live) {
      reporter.skip(
        "level-3 staged card auto-completes",
        "safe mode — pass --live to spend real CLI budget",
      );
      reporter.skip("level-1 staged card always lands in review", "safe mode");
      reporter.skip("a failing backend escalates instead of hanging", "safe mode");
      reporter.skip("execution writes a fresh last-run job-memory record", "safe mode");
    } else if (!executorEnabled) {
      reporter.skip("live execution", "cron.agencyOperatingLoop.executeWorkItems is off");
    } else {
      const pick = (level) => ai.find((w) => w.autonomyLevel === level && w.id !== demoted?.employeeId);
      const targets = [];
      const l3 = pick(3);
      const l1 = pick(1);
      if (l3) targets.push({ worker: l3, expect: ["completed"], label: "level-3 auto-completes" });
      if (l1) targets.push({ worker: l1, expect: ["review"], label: "level-1 always lands in review" });
      // Dev / Wren are bound to the codex backend, which currently exits 1 —
      // the reachable failure path.
      const failing = ai.find((w) => /^(Dev|Wren)$/i.test(w.name));
      if (failing)
        targets.push({
          worker: failing,
          expect: ["escalated"],
          label: "a failing backend escalates instead of hanging",
        });

      const staged = [];
      for (const target of targets) {
        const probe = await createProbe(target.worker, `live-${target.worker.autonomyLevel}`);
        if (!probe.ok) {
          reporter.fail(target.label, `create failed: ${probe.error}`);
          continue;
        }
        const stage = await rpc("agency.ops.employee.work-item.transition", {
          agencyId,
          workItemId: probe.item.id,
          status: EXECUTION_STAGE,
        });
        if (!stage.ok) {
          reporter.fail(target.label, `staging failed: ${stage.error}`);
          continue;
        }
        staged.push({ ...target, id: probe.item.id });
      }

      const memoryBefore = new Map();
      for (const entry of staged) {
        const mem = await rpc("agency.ops.employee.memory.list", {
          agencyId,
          workerId: entry.worker.id,
          namespace: JOB_MEMORY_NAMESPACE,
        });
        memoryBefore.set(
          entry.worker.id,
          (mem.payload?.memory ?? []).find((r) => r.key === "last-run")?.updatedAt ?? 0,
        );
      }

      const tick = await rpc("agency.ops.employee.loop.tick", { agencyId });
      reporter.check("live loop.tick succeeds", tick.ok, tick.error ?? "");

      // Poll to settlement. A card that never leaves `accepted`/`in_progress`
      // within the budget is a HANG, which is itself a failure.
      const terminal = new Set(["completed", "review", "escalated", "cancelled"]);
      const deadline = Date.now() + 12 * 60_000;
      const final = new Map();
      while (Date.now() < deadline && final.size < staged.length) {
        await sleep(15_000);
        const inbox = await rpc("agency.ops.employee.inbox.list", { agencyId, limit: 250 });
        for (const entry of staged) {
          if (final.has(entry.id)) continue;
          const item = (inbox.payload?.workItems ?? []).find((i) => i.id === entry.id);
          if (item && terminal.has(item.status)) final.set(entry.id, item);
        }
        reporter.info(
          `settled ${final.size}/${staged.length} (${Math.round((deadline - Date.now()) / 1000)}s left)`,
        );
      }

      for (const entry of staged) {
        const item = final.get(entry.id);
        reporter.check(
          entry.label,
          Boolean(item) && entry.expect.includes(item.status),
          item
            ? `${entry.worker.name} ended in "${item.status}", expected ${entry.expect.join("/")}`
            : `${entry.worker.name} never settled — it hung in the pipeline`,
        );
      }

      for (const entry of staged) {
        const mem = await rpc("agency.ops.employee.memory.list", {
          agencyId,
          workerId: entry.worker.id,
          namespace: JOB_MEMORY_NAMESPACE,
        });
        const lastRun = (mem.payload?.memory ?? []).find((r) => r.key === "last-run");
        reporter.check(
          `execution wrote a fresh last-run record for ${entry.worker.name}`,
          Boolean(lastRun) && lastRun.value?.workItemId === entry.id,
          `last-run workItemId=${lastRun?.value?.workItemId}, expected ${entry.id}`,
        );
      }
    }
  } finally {
    // ── Cleanup: nothing this suite created may survive it ─────────────────
    reporter.group("autonomy: cleanup");
    if (demoted) {
      const restore = await rpc("agency.ops.employee.update", {
        agencyId,
        employeeId: demoted.employeeId,
        autonomyLevel: demoted.autonomyLevel,
      });
      reporter.check(
        "temporary autonomy-level change restored",
        restore.ok && restore.payload?.employee?.autonomyLevel === demoted.autonomyLevel,
        restore.ok
          ? `now L${restore.payload?.employee?.autonomyLevel}, expected L${demoted.autonomyLevel}`
          : restore.error,
      );
    }

    const leftovers = [];
    for (const id of created) {
      let item = null;
      const inbox = await rpc("agency.ops.employee.inbox.list", { agencyId, limit: 250 });
      item = (inbox.payload?.workItems ?? []).find((i) => i.id === id);
      if (!item || item.status === "cancelled") continue;
      if (item.status === "completed") {
        leftovers.push(`${id} (completed — terminal, cannot be cancelled)`);
        continue;
      }
      if (item.status === "review") {
        // review -> cancelled is not a legal edge; hop through in_progress.
        await rpc("agency.ops.employee.work-item.transition", {
          agencyId,
          workItemId: id,
          status: "in_progress",
        });
      }
      const res = await rpc("agency.ops.employee.work-item.transition", {
        agencyId,
        workItemId: id,
        status: "cancelled",
      });
      if (!res.ok) leftovers.push(`${id} (${item.status}: ${res.error})`);
    }
    reporter.check(
      `all ${created.length} probe work item(s) cleaned up`,
      leftovers.length === 0,
      `left behind: ${leftovers.join("; ")}`,
    );
  }
}
