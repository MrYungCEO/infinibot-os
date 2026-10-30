/**
 * useAgencyDaily — the native controller for Agency Today / Daily Operations.
 *
 * Mirrors the two web controllers the page composes
 * (controllers/agency-daily.ts + controllers/agency-autonomy-board.ts): the
 * same RPCs, the same optimistic-with-rollback transitions, the same
 * two-step confirms. State lives in one mutable ref (exactly like the web
 * host object) and `bump()` re-renders — the reducers that matter are pure
 * functions in daily-model.js.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as M from './daily-model';

const RPC_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms = RPC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

export function createDailyState() {
  return {
    loadGeneration: 0,
    loading: false,
    refreshing: false,
    error: null,
    failedRequests: [],
    lastLoadedAt: null,
    agencies: [],
    agencyId: null,
    agencyName: '',
    preferredAgencyId: null,
    kpis: [],
    workItems: [],
    reviews: [],
    responsibilities: [],
    approvals: [],
    employees: [],
    delivery: { ...M.EMPTY_DELIVERY },
    loop: { ...M.EMPTY_LOOP },
    loopRunning: false,
    loopResult: null,
    busyWorkItemId: null,
    executorEnabled: false,
    executions: {},
    executionsLoaded: false,
    stagePrompt: null,
    liveAt: null,
    composer: null,
    approvalIntent: null,
    busyApprovalId: null,
    notice: null,
    workItemDetailId: null,
    // ── autonomy / delivery half ──
    mode: 'split',
    projects: [],
    tasks: [],
    rawTasks: {},
    rawProjects: {},
    kanbanLoaded: false,
    projectFilter: '',
    search: '',
    showDone: false,
    unassignedOnly: true,
    selectedTaskIds: new Set(),
    handoff: null,
    taskDetailId: null,
    taskDetailBusy: false,
    routing: { ...M.EMPTY_ROUTING },
    applyArmed: false,
    applying: false,
    // Resolved method names (null = not tried yet, false = gateway lacks it).
    methods: { preview: null, apply: null, taskAssign: null, stage: null },
  };
}

export function useAgencyDaily(gateway) {
  const sendReq = gateway?.sendReq;
  const subscribeEvent = gateway?.subscribeEvent;
  const connected = gateway?.status === 'connected';
  const ref = useRef(null);
  if (!ref.current) ref.current = createDailyState();
  const [, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const bump = useCallback(() => {
    if (mounted.current) setTick((n) => (n + 1) % 1_000_000);
  }, []);

  const call = useCallback(
    (method, params, ms) => {
      if (!sendReq) return Promise.reject(new Error('Not connected to a gateway.'));
      return withTimeout(sendReq(method, params), ms);
    },
    [sendReq],
  );

  /** Fault-isolated panel request: failure is recorded, never thrown. */
  const attempt = useCallback(
    (failures, method, params, ms) =>
      call(method, params, ms).catch((error) => {
        const entry = `${method} — ${M.errorMessage(error)}`;
        if (!failures.includes(entry)) failures.push(entry);
        return null;
      }),
    [call],
  );

  const recordFailure = useCallback((entry) => {
    const s = ref.current;
    s.failedRequests = M.addFailure(s.failedRequests, entry);
  }, []);

  /**
   * Calls the first candidate method the gateway serves. A "method not found"
   * walks to the next candidate; any other error is a real answer and throws.
   * Remembers the hit (or `false` when none exists) in `s.methods[slot]`.
   */
  const callResolved = useCallback(
    async (slot, candidates, params) => {
      const s = ref.current;
      if (s.methods[slot] === false) {
        const e = new Error('method not available on this gateway');
        e.missing = true;
        throw e;
      }
      const list = s.methods[slot] ? [s.methods[slot]] : candidates;
      let lastMissing = null;
      for (const method of list) {
        try {
          const res = await call(method, params);
          s.methods[slot] = method;
          return { method, res };
        } catch (error) {
          if (M.isMissingMethod(error)) {
            lastMissing = error;
            continue;
          }
          error.method = method;
          throw error;
        }
      }
      s.methods[slot] = false;
      const e = new Error(M.errorMessage(lastMissing) || 'method not available on this gateway');
      e.missing = true;
      throw e;
    },
    [call],
  );

  // ── Routing dry run ──────────────────────────────────────────────────────
  const loadRoutingPreview = useCallback(async () => {
    const s = ref.current;
    if (!s.agencyId) return;
    const agencyId = s.agencyId;
    s.routing = { ...s.routing, status: 'loading', error: null };
    bump();
    try {
      const { method, res } = await callResolved('preview', M.ROUTING_PREVIEW_METHODS, {
        agencyId,
        limit: M.ROUTING_PREVIEW_LIMIT,
      });
      if (s.agencyId !== agencyId) return;
      s.routing = M.routingFromResponse(res, method);
    } catch (error) {
      if (s.agencyId !== agencyId) return;
      if (error.missing) {
        s.routing = { ...M.EMPTY_ROUTING, status: 'unavailable', loadedAt: Date.now() };
      } else {
        const message = M.errorMessage(error);
        s.routing = { ...s.routing, status: 'failed', method: error.method || null, error: message, loadedAt: Date.now() };
        recordFailure(`${error.method || 'agency.ops.routing.preview'} — ${message}`);
      }
    } finally {
      bump();
    }
  }, [bump, callResolved, recordFailure]);

  // ── Load ─────────────────────────────────────────────────────────────────
  const load = useCallback(
    async (options = {}) => {
      const s = ref.current;
      if (!sendReq) return;
      const generation = ++s.loadGeneration;
      const background = options.background === true || s.lastLoadedAt !== null;
      s.loading = !background;
      s.refreshing = background;
      s.error = null;
      bump();
      const failures = [];
      try {
        const agenciesRes = await attempt(failures, 'agency.ops.agencies.list', {});
        if (generation !== s.loadGeneration) return;
        s.agencies = M.asArray(agenciesRes, 'agencies');
        const picked = M.pickAgency(s.agencies, s.preferredAgencyId);
        s.agencyId = picked?.id ?? null;
        s.agencyName = picked?.name ?? '';
        if (!s.agencyId) {
          s.failedRequests = failures;
          s.lastLoadedAt = Date.now();
          return;
        }
        const agencyId = s.agencyId;
        const [
          dashboardRes,
          inboxRes,
          reviewsRes,
          respRes,
          approvalsRes,
          employeesRes,
          projectsRes,
          tasksRes,
          cronRes,
          execRes,
          kProjectsRes,
          kTasksRes,
        ] = await Promise.all([
          attempt(failures, 'agency.ops.dashboard', { agencyId }),
          attempt(failures, 'agency.ops.employee.inbox.list', { agencyId, limit: 250 }),
          attempt(failures, 'agency.ops.employee.reviews.list', { agencyId }),
          attempt(failures, 'agency.ops.employee.responsibilities.list', { agencyId }),
          attempt(failures, 'agency.ops.approvals.list', { agencyId, status: 'pending' }),
          attempt(failures, 'agency.ops.employees.list', { agencyId, status: 'active' }),
          attempt(failures, 'agency.ops.projects.list', { agencyId }),
          attempt(failures, 'agency.ops.tasks.list', { agencyId }),
          attempt(failures, 'cron.list', { includeDisabled: true }),
          attempt(failures, 'agency.ops.employee.work-item.execution.list', { agencyId, limit: 200 }),
          attempt(failures, 'kanban.projects.list', {}),
          attempt(failures, 'kanban.tasks.list', {}),
        ]);
        if (generation !== s.loadGeneration || agencyId !== s.agencyId) return;

        if (dashboardRes) {
          const dashboard = M.unwrap(dashboardRes, 'dashboard', {});
          s.kpis = Array.isArray(dashboard?.kpis) ? dashboard.kpis : s.kpis;
        }
        if (inboxRes) s.workItems = M.asArray(inboxRes, 'workItems');
        if (reviewsRes) s.reviews = M.asArray(reviewsRes, 'reviewCycles');
        if (respRes) s.responsibilities = M.asArray(respRes, 'responsibilities');
        if (approvalsRes) s.approvals = M.asArray(approvalsRes, 'approvals');
        if (employeesRes) s.employees = M.asArray(employeesRes, 'employees');
        const projectNames = new Map(M.asArray(projectsRes, 'projects').map((p) => [p.id, p.name]));
        if (tasksRes) s.delivery = M.readDeliveryPulse(tasksRes, projectNames);
        if (cronRes) s.loop = M.readLoopStatus(cronRes);
        if (execRes) {
          const merged = M.mergeExecutions(execRes, s.executions);
          s.executions = merged.executions;
          s.executorEnabled = merged.executorEnabled;
          s.executionsLoaded = true;
        }
        if (kProjectsRes !== null) {
          const list = Array.isArray(kProjectsRes) ? kProjectsRes : M.asArray(kProjectsRes, 'projects');
          s.projects = list.map(M.mapKanbanProject);
          s.rawProjects = Object.fromEntries(list.map((p) => [p.id, M.slimRawProject(p)]));
        }
        if (kTasksRes !== null) {
          const list = Array.isArray(kTasksRes) ? kTasksRes : M.asArray(kTasksRes, 'tasks');
          s.tasks = list.map(M.mapKanbanTask);
          s.rawTasks = Object.fromEntries(list.map((t) => [t.id, M.slimRawTask(t)]));
          s.kanbanLoaded = true;
          if (s.selectedTaskIds.size) {
            const live = new Set(s.tasks.map((t) => t.id));
            s.selectedTaskIds = new Set([...s.selectedTaskIds].filter((id) => live.has(id)));
          }
        }
        s.failedRequests = failures;
        s.lastLoadedAt = Date.now();
        void loadRoutingPreview();
      } catch (error) {
        if (generation === s.loadGeneration) {
          s.error = M.errorMessage(error);
          s.failedRequests = failures;
        }
      } finally {
        if (generation === s.loadGeneration) {
          s.loading = false;
          s.refreshing = false;
          bump();
        }
      }
    },
    [attempt, bump, loadRoutingPreview, sendReq],
  );

  // Initial load once connected.
  useEffect(() => {
    if (connected && ref.current.lastLoadedAt === null && !ref.current.loading) void load();
  }, [connected, load]);

  // Live updates: `agency.work.updated` is an invalidation signal → debounced refetch.
  useEffect(() => {
    if (!subscribeEvent) return undefined;
    let timer = null;
    const off = subscribeEvent(M.WORK_ITEM_EVENT, (payload) => {
      const s = ref.current;
      const p = payload || {};
      if (p.agencyId && s.agencyId && p.agencyId !== s.agencyId) return;
      s.liveAt = Date.now();
      if (s.handoff?.submitting) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load({ background: true });
      }, 400);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, [subscribeEvent, load]);

  // ── Loop ─────────────────────────────────────────────────────────────────
  const runLoopNow = useCallback(async () => {
    const s = ref.current;
    if (!s.agencyId || s.loopRunning) return;
    s.loopRunning = true;
    s.loopResult = null;
    s.error = null;
    bump();
    try {
      const res = await call('agency.ops.employee.loop.tick', { agencyId: s.agencyId });
      s.loopResult = M.loopResultText(M.unwrap(res, 'result', {}));
      await load({ background: true });
    } catch (error) {
      s.error = M.errorMessage(error);
      recordFailure(`agency.ops.employee.loop.tick — ${M.errorMessage(error)}`);
    } finally {
      s.loopRunning = false;
      bump();
    }
  }, [bump, call, load, recordFailure]);

  // ── Work-item transitions ───────────────────────────────────────────────
  const transitionWorkItem = useCallback(
    async (workItemId, status) => {
      const s = ref.current;
      if (!s.agencyId || s.busyWorkItemId) return;
      const item = s.workItems.find((e) => e.id === workItemId);
      if (!item) return;
      const previous = item.status;
      if (previous === status) return;
      if (!M.canTransitionWorkItem(previous, status)) {
        s.error = `"${M.humanStatus(previous)}" cannot move straight to "${M.humanStatus(status)}".`;
        bump();
        return;
      }
      item.status = status;
      const prevExec = s.executions[workItemId];
      if (prevExec) s.executions = { ...s.executions, [workItemId]: { ...prevExec, stage: status } };
      s.busyWorkItemId = workItemId;
      bump();
      try {
        await call('agency.ops.employee.work-item.transition', { agencyId: s.agencyId, workItemId, status });
        s.notice = `Moved "${item.title}" to ${M.STAGE_LABELS[status] || status}.`;
      } catch (error) {
        item.status = previous;
        if (prevExec) s.executions = { ...s.executions, [workItemId]: prevExec };
        s.error = M.errorMessage(error);
        recordFailure(`agency.ops.employee.work-item.transition — ${M.errorMessage(error)}`);
      } finally {
        s.busyWorkItemId = null;
        bump();
      }
    },
    [bump, call, recordFailure],
  );

  const openStagePrompt = useCallback(
    async (workItemId) => {
      const s = ref.current;
      const item = s.workItems.find((e) => e.id === workItemId);
      if (!s.agencyId || !item) return;
      s.workItemDetailId = null;
      s.stagePrompt = {
        workItemId,
        title: item.title,
        loading: true,
        view: s.executions[workItemId] ?? null,
        error: null,
        submitting: false,
      };
      bump();
      try {
        const res = await call('agency.ops.employee.work-item.execution.status', { agencyId: s.agencyId, workItemId });
        const view = M.unwrap(res, 'execution', null);
        if (s.stagePrompt?.workItemId !== workItemId) return;
        if (view?.workItemId) {
          s.executions = { ...s.executions, [workItemId]: view };
          s.stagePrompt.view = view;
          s.executorEnabled = view.executorEnabled;
        }
      } catch (error) {
        if (s.stagePrompt?.workItemId !== workItemId) return;
        s.stagePrompt.error = `Readiness unavailable — ${M.errorMessage(error)}`;
      } finally {
        if (s.stagePrompt?.workItemId === workItemId) {
          s.stagePrompt.loading = false;
          bump();
        }
      }
    },
    [bump, call],
  );

  const closeStagePrompt = useCallback(() => {
    ref.current.stagePrompt = null;
    bump();
  }, [bump]);

  const confirmStagePrompt = useCallback(async () => {
    const s = ref.current;
    const prompt = s.stagePrompt;
    if (!prompt || prompt.submitting) return;
    prompt.submitting = true;
    bump();
    await transitionWorkItem(prompt.workItemId, M.AUTONOMY_STAGE);
    if (s.stagePrompt?.workItemId === prompt.workItemId) s.stagePrompt = null;
    bump();
  }, [bump, transitionWorkItem]);

  /** Single entry for "move this card": the autonomy stage always prompts. */
  const requestStage = useCallback(
    (workItemId, stage) => {
      const s = ref.current;
      const item = s.workItems.find((e) => e.id === workItemId);
      if (!item || item.status === stage || !M.canTransitionWorkItem(item.status, stage)) return;
      if (stage === M.AUTONOMY_STAGE) {
        void openStagePrompt(workItemId);
        return;
      }
      void transitionWorkItem(workItemId, stage);
    },
    [openStagePrompt, transitionWorkItem],
  );

  const openWorkItem = useCallback(
    async (workItemId) => {
      const s = ref.current;
      s.workItemDetailId = workItemId;
      bump();
      if (!s.agencyId) return;
      try {
        const res = await call('agency.ops.employee.work-item.execution.status', { agencyId: s.agencyId, workItemId });
        const view = M.unwrap(res, 'execution', null);
        if (view?.workItemId) {
          s.executions = { ...s.executions, [workItemId]: view };
          s.executorEnabled = view.executorEnabled;
          s.executionsLoaded = true;
          bump();
        }
      } catch {
        /* decoration only — the sheet degrades to the summary */
      }
    },
    [bump, call],
  );

  const closeWorkItem = useCallback(() => {
    ref.current.workItemDetailId = null;
    bump();
  }, [bump]);

  // ── Composer ─────────────────────────────────────────────────────────────
  const openComposer = useCallback(
    (kind, patch = {}) => {
      const s = ref.current;
      s.composer = M.createComposer(kind, patch, s.employees);
      s.notice = null;
      bump();
    },
    [bump],
  );
  const updateComposer = useCallback(
    (patch) => {
      const s = ref.current;
      if (!s.composer) return;
      s.composer = { ...s.composer, ...patch, error: patch.error ?? null };
      bump();
    },
    [bump],
  );
  const closeComposer = useCallback(() => {
    ref.current.composer = null;
    bump();
  }, [bump]);
  const submitComposer = useCallback(async () => {
    const s = ref.current;
    const composer = s.composer;
    if (!composer || composer.submitting) return;
    if (!s.agencyId) {
      s.composer = { ...composer, error: 'No agency selected.' };
      bump();
      return;
    }
    const plan = M.composerRequest(composer, s.employees, s.agencyId);
    if (typeof plan === 'string') {
      s.composer = { ...composer, error: plan };
      bump();
      return;
    }
    s.composer = { ...composer, submitting: true, error: null };
    bump();
    try {
      await call(plan.method, plan.params);
      s.composer = null;
      s.notice = plan.notice;
      bump();
      await load({ background: true });
    } catch (error) {
      const message = M.errorMessage(error);
      if (s.composer) s.composer = { ...s.composer, submitting: false, error: message };
      recordFailure(`${plan.method} — ${message}`);
      bump();
    }
  }, [bump, call, load, recordFailure]);

  // ── Approvals (two-step) ────────────────────────────────────────────────
  const setApprovalIntent = useCallback(
    (intent) => {
      const s = ref.current;
      s.approvalIntent = intent;
      s.notice = null;
      bump();
    },
    [bump],
  );
  const resolveApproval = useCallback(async () => {
    const s = ref.current;
    const intent = s.approvalIntent;
    if (!intent || !s.agencyId || s.busyApprovalId) return;
    const approval = s.approvals.find((e) => e.id === intent.approvalId);
    s.busyApprovalId = intent.approvalId;
    bump();
    try {
      await call('agency.ops.approval.resolve', {
        agencyId: s.agencyId,
        approvalId: intent.approvalId,
        decision: intent.decision,
      });
      s.approvalIntent = null;
      s.notice = `${approval?.title ?? 'Approval'} ${intent.decision}.`;
      s.approvals = s.approvals.filter((e) => e.id !== intent.approvalId);
      bump();
      await load({ background: true });
    } catch (error) {
      s.error = M.errorMessage(error);
      recordFailure(`agency.ops.approval.resolve — ${M.errorMessage(error)}`);
    } finally {
      s.busyApprovalId = null;
      bump();
    }
  }, [bump, call, load, recordFailure]);

  // ── Delivery board ───────────────────────────────────────────────────────
  const setMode = useCallback(
    (mode) => {
      ref.current.mode = mode;
      bump();
    },
    [bump],
  );
  const setFilter = useCallback(
    (patch) => {
      Object.assign(ref.current, patch);
      bump();
    },
    [bump],
  );
  const toggleSelected = useCallback(
    (taskId) => {
      const s = ref.current;
      const next = new Set(s.selectedTaskIds);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      s.selectedTaskIds = next;
      bump();
    },
    [bump],
  );
  const setSelected = useCallback(
    (ids, selected) => {
      const s = ref.current;
      const next = new Set(s.selectedTaskIds);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      s.selectedTaskIds = next;
      bump();
    },
    [bump],
  );
  const clearSelection = useCallback(() => {
    ref.current.selectedTaskIds = new Set();
    bump();
  }, [bump]);

  const openTaskDetail = useCallback(
    (taskId) => {
      ref.current.taskDetailId = taskId;
      bump();
    },
    [bump],
  );
  const closeTaskDetail = useCallback(() => {
    const s = ref.current;
    s.taskDetailId = null;
    s.taskDetailBusy = false;
    bump();
  }, [bump]);

  const setDeliveryTaskStatus = useCallback(
    async (taskId, status) => {
      const s = ref.current;
      const task = s.tasks.find((e) => e.id === taskId);
      if (!task || task.status === status) return;
      s.taskDetailBusy = true;
      const previous = task.status;
      task.status = status;
      bump();
      try {
        await call('kanban.tasks.update', { id: taskId, patch: { status: M.deliveryStatusToKanban(status) } });
        s.notice = `Moved "${task.title}" to ${M.humanStatus(status)}.`;
      } catch (error) {
        task.status = previous;
        s.error = `Could not move the task — ${M.errorMessage(error)}`;
        recordFailure(`kanban.tasks.update — ${M.errorMessage(error)}`);
      } finally {
        s.taskDetailBusy = false;
        bump();
      }
    },
    [bump, call, recordFailure],
  );

  const addDeliveryTaskNote = useCallback(
    async (taskId, note) => {
      const s = ref.current;
      const raw = s.rawTasks[taskId];
      const next = M.appendNote(raw?.description ?? '', note);
      if (!next) return false;
      s.taskDetailBusy = true;
      bump();
      try {
        await call('kanban.tasks.update', { id: taskId, patch: { description: next } });
        if (raw) raw.description = next;
        else s.rawTasks[taskId] = { description: next, tags: [] };
        s.notice = 'Note added to the task.';
        return true;
      } catch (error) {
        s.error = `Could not add the note — ${M.errorMessage(error)}`;
        recordFailure(`kanban.tasks.update — ${M.errorMessage(error)}`);
        return false;
      } finally {
        s.taskDetailBusy = false;
        bump();
      }
    },
    [bump, call, recordFailure],
  );

  // ── Routing apply (two-step) ────────────────────────────────────────────
  const setApplyArmed = useCallback(
    (armed) => {
      ref.current.applyArmed = armed;
      bump();
    },
    [bump],
  );
  const applyRouting = useCallback(async () => {
    const s = ref.current;
    if (s.applying || !s.agencyId) return;
    s.applying = true;
    s.error = null;
    bump();
    try {
      const { res } = await callResolved('apply', M.ROUTING_APPLY_METHODS, {
        agencyId: s.agencyId,
        limit: M.ROUTING_PREVIEW_LIMIT,
      });
      s.notice = M.routingApplyNotice(res);
      s.applyArmed = false;
      bump();
      await load({ background: true });
    } catch (error) {
      s.error = error.missing ? 'This gateway build has no routing engine to apply.' : M.errorMessage(error);
      s.applyArmed = false;
      if (!error.missing) recordFailure(`${error.method || 'agency.ops.routing.apply'} — ${M.errorMessage(error)}`);
    } finally {
      s.applying = false;
      bump();
    }
  }, [bump, callResolved, load, recordFailure]);

  // ── Handoff ──────────────────────────────────────────────────────────────
  const loadRecommendations = useCallback(async () => {
    const s = ref.current;
    const handoff = s.handoff;
    if (!handoff || !s.agencyId) return;
    handoff.recommendationsLoading = true;
    handoff.recommendationsError = null;
    bump();
    try {
      const res = await call('agency.ops.assignment.suitability', {
        agencyId: s.agencyId,
        estimatedHours: Math.max(1, handoff.taskIds.length),
        preferredType: 'ai',
      });
      if (s.handoff !== handoff) return;
      handoff.recommendations = M.sortRecommendations(
        M.asArray(res, 'recommendations'),
        M.openWorkloadByWorker(s.workItems),
      );
      if (!handoff.workerId) handoff.workerId = handoff.recommendations[0]?.workerId ?? s.employees[0]?.id ?? '';
    } catch (error) {
      if (s.handoff !== handoff) return;
      handoff.recommendationsError = `Suitability unavailable — ${M.errorMessage(error)}`;
      recordFailure(`agency.ops.assignment.suitability — ${M.errorMessage(error)}`);
    } finally {
      if (s.handoff === handoff) {
        handoff.recommendationsLoading = false;
        bump();
      }
    }
  }, [bump, call, recordFailure]);

  const openHandoff = useCallback(
    (taskIds, options = {}) => {
      const s = ref.current;
      const eligible = M.eligibleForHandoff(taskIds, s.tasks);
      if (eligible.length === 0) {
        s.error = 'Nothing to hand over — closed and cancelled tasks cannot be sent to autonomy.';
        bump();
        return;
      }
      s.error = null;
      s.notice = null;
      s.taskDetailId = null;
      const preselect =
        options.preselectWorkerId && s.employees.some((e) => e.id === options.preselectWorkerId)
          ? options.preselectWorkerId
          : '';
      s.handoff = {
        taskIds: eligible.slice(0, M.MAX_BATCH),
        projectId: options.projectId ?? null,
        projectName: options.projectName ?? null,
        workerId: preselect,
        priority: 'normal',
        authorizeNow: options.authorizeNow === true,
        instructions: '',
        recommendations: [],
        recommendationsLoading: false,
        recommendationsError: null,
        submitting: false,
        progress: null,
        error:
          eligible.length > M.MAX_BATCH
            ? `Capped at ${M.MAX_BATCH} tasks per batch — ${eligible.length - M.MAX_BATCH} left selected for a second pass.`
            : null,
      };
      bump();
      void loadRecommendations();
      if (!s.routing.loadedAt || Date.now() - s.routing.loadedAt > 60_000) void loadRoutingPreview();
    },
    [bump, loadRecommendations, loadRoutingPreview],
  );

  const updateHandoff = useCallback(
    (patch) => {
      const s = ref.current;
      if (!s.handoff) return;
      s.handoff = { ...s.handoff, ...patch };
      bump();
    },
    [bump],
  );
  const closeHandoff = useCallback(() => {
    ref.current.handoff = null;
    bump();
  }, [bump]);

  const recordDeliveryOwner = useCallback(
    async (agencyId, taskId, workerId) => {
      try {
        await call('kanban.tasks.update', { id: taskId, patch: { assignedAgent: workerId } });
      } catch {
        /* the kanban store may not track this task */
      }
      try {
        await call('agency.ops.tasks.assign', { agencyId, taskId, assigneeId: workerId, assigneeType: 'ai' });
      } catch {
        /* best-effort mirror */
      }
    },
    [call],
  );

  const submitHandoff = useCallback(async () => {
    const s = ref.current;
    let handoff = s.handoff;
    if (!handoff || handoff.submitting) return;
    if (!s.agencyId) return updateHandoff({ error: 'No agency selected.' });
    if (!handoff.workerId) return updateHandoff({ error: 'Pick the employee that takes this on.' });
    const agencyId = s.agencyId;
    const workerId = handoff.workerId;
    const workerName = s.employees.find((e) => e.id === workerId)?.name ?? workerId;
    handoff.submitting = true;
    handoff.error = null;
    handoff.progress = { done: 0, failed: 0, total: handoff.taskIds.length };
    bump();
    let done = 0;
    let failed = 0;
    let lastError = null;
    let lastMethod = 'agency.ops.employee.work-item.create';
    const sentTaskIds = [];
    const createdWorkItemIds = [];
    for (const taskId of handoff.taskIds) {
      if (s.handoff !== handoff) return;
      const task = s.tasks.find((e) => e.id === taskId);
      if (!task) {
        failed += 1;
        continue;
      }
      const project = s.projects.find((e) => e.id === task.projectId);
      try {
        let usedOverride = false;
        if (s.methods.taskAssign !== false) {
          try {
            const { method, res } = await callResolved('taskAssign', M.ROUTING_TASK_ASSIGN_METHODS, {
              agencyId,
              taskId: task.id,
              workerId,
              note:
                handoff.instructions.trim() ||
                `Handed over from the delivery board by the operator${project ? ` (${project.name})` : ''}.`,
            });
            lastMethod = method;
            usedOverride = true;
            const decision = M.unwrap(res, 'decision', null);
            if (decision?.workItemId) createdWorkItemIds.push(decision.workItemId);
          } catch (error) {
            if (!error.missing) throw error;
          }
        }
        if (!usedOverride) {
          lastMethod = 'agency.ops.employee.work-item.create';
          const created = await call('agency.ops.employee.work-item.create', {
            agencyId,
            workerId,
            title: task.title,
            instructions:
              handoff.instructions.trim() ||
              `Delivery task from ${project?.name ?? 'an unlinked project'}. Acceptance: complete the task and report what changed.`,
            priority: handoff.priority,
            dueAt: task.dueAt ?? null,
            context: {
              source: 'agency-autonomy-board',
              taskId: task.id,
              projectId: task.projectId,
              projectName: project?.name ?? null,
            },
            idempotencyKey: `autonomy-board:${task.id}:${workerId}`,
          });
          await recordDeliveryOwner(agencyId, task.id, workerId);
          const workItem = M.unwrap(created, 'workItem', null);
          if (workItem?.id) createdWorkItemIds.push(workItem.id);
        }
        task.assigneeId = workerId;
        task.assigneeType = 'ai';
        sentTaskIds.push(task.id);
        done += 1;
      } catch (error) {
        failed += 1;
        lastError = M.errorMessage(error);
      }
      if (s.handoff === handoff) {
        handoff.progress = { done, failed, total: handoff.taskIds.length };
        bump();
      }
    }
    let stageError = null;
    if (handoff.authorizeNow && sentTaskIds.length) {
      try {
        let staged = false;
        if (s.methods.stage !== false) {
          try {
            await callResolved('stage', M.ROUTING_STAGE_METHODS, { agencyId, taskIds: sentTaskIds, workerId });
            staged = true;
          } catch (error) {
            if (!error.missing) throw error;
          }
        }
        if (!staged) {
          for (const workItemId of createdWorkItemIds) {
            await call('agency.ops.employee.work-item.transition', { agencyId, workItemId, status: M.AUTONOMY_STAGE });
          }
        }
      } catch (error) {
        stageError = M.errorMessage(error);
        recordFailure(`${error.method || 'agency.ops.employee.work-item.transition'} — ${stageError}`);
      }
    }
    if (failed > 0) recordFailure(`${lastMethod} — ${lastError ?? 'unknown error'}`);
    s.notice = M.handoffNotice({
      sent: done,
      total: handoff.taskIds.length,
      failed,
      workerName,
      authorizeNow: handoff.authorizeNow,
      stageError,
    });
    if (s.handoff === handoff) s.handoff = null;
    if (done > 0) {
      const sentIds = new Set(handoff.taskIds);
      s.selectedTaskIds = new Set([...s.selectedTaskIds].filter((id) => !sentIds.has(id)));
    }
    handoff = null;
    bump();
    await load({ background: true });
  }, [bump, call, callResolved, load, recordDeliveryOwner, recordFailure, updateHandoff]);

  // ── Misc ─────────────────────────────────────────────────────────────────
  const dismissNotice = useCallback(() => {
    ref.current.notice = null;
    bump();
  }, [bump]);
  const dismissError = useCallback(() => {
    ref.current.error = null;
    bump();
  }, [bump]);
  const selectAgency = useCallback(
    (agencyId) => {
      const s = ref.current;
      if (s.agencyId === agencyId) return;
      s.preferredAgencyId = agencyId;
      s.selectedTaskIds = new Set();
      s.projectFilter = '';
      s.routing = { ...M.EMPTY_ROUTING };
      s.methods = { preview: null, apply: null, taskAssign: null, stage: null };
      void load({ background: true });
    },
    [load],
  );

  const actions = useMemo(
    () => ({
      load,
      refresh: () => load({ background: true }),
      runLoopNow,
      transitionWorkItem,
      requestStage,
      openStagePrompt,
      closeStagePrompt,
      confirmStagePrompt,
      openWorkItem,
      closeWorkItem,
      openComposer,
      updateComposer,
      closeComposer,
      submitComposer,
      setApprovalIntent,
      resolveApproval,
      setMode,
      setFilter,
      toggleSelected,
      setSelected,
      clearSelection,
      openTaskDetail,
      closeTaskDetail,
      setDeliveryTaskStatus,
      addDeliveryTaskNote,
      loadRoutingPreview,
      setApplyArmed,
      applyRouting,
      openHandoff,
      updateHandoff,
      closeHandoff,
      submitHandoff,
      dismissNotice,
      dismissError,
      selectAgency,
    }),
    [
      load,
      runLoopNow,
      transitionWorkItem,
      requestStage,
      openStagePrompt,
      closeStagePrompt,
      confirmStagePrompt,
      openWorkItem,
      closeWorkItem,
      openComposer,
      updateComposer,
      closeComposer,
      submitComposer,
      setApprovalIntent,
      resolveApproval,
      setMode,
      setFilter,
      toggleSelected,
      setSelected,
      clearSelection,
      openTaskDetail,
      closeTaskDetail,
      setDeliveryTaskStatus,
      addDeliveryTaskNote,
      loadRoutingPreview,
      setApplyArmed,
      applyRouting,
      openHandoff,
      updateHandoff,
      closeHandoff,
      submitHandoff,
      dismissNotice,
      dismissError,
      selectAgency,
    ],
  );

  return { state: ref.current, actions, connected };
}
