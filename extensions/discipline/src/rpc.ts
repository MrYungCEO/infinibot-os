/**
 * Discipline gateway methods (discipline.*), registered by the plugin entry.
 *
 * Formerly src/gateway/server-methods/discipline.ts, which armed the auto-log,
 * Telegram bridge and Telegram completion notifier as import side effects —
 * the root cause of one-shot CLI commands hanging (their command graph
 * imported the gateway handlers). Nothing here starts anything now: timers
 * and subscriptions live in the plugin's service (index.ts).
 *
 * Satellite → master forwarding is done by the gateway dispatcher (the
 * "discipline." prefix is in SATELLITE_MASTER_PROXY_PREFIXES).
 */

import { randomUUID } from "node:crypto";

import type { GatewayRequestHandlers } from "../../../src/gateway/server-methods/types.js";
import { disciplineDataDir } from "./data-dir.js";
import {
  computeDisciplineInsights,
  type DisciplineInsightResult,
  type GatherBusinessSnapshot,
} from "./insights.js";
import {
  connectDisciplineNotion,
  disconnectDisciplineNotion,
  getDisciplineNotionStatus,
  syncDisciplineNow,
} from "./notion-sync.js";
import { getDisciplineStore } from "./store.js";
import {
  DisciplineBlock,
  DisciplineCategory,
  DISCIPLINE_CATEGORIES,
  DisciplineLog,
  LogSource,
  RoutineItem,
} from "./types.js";

export type DisciplineRpcDeps = {
  /** Tenant-aware state dir (api.runtime.state.resolveStateDir). */
  stateDir: () => string;
  gatherBusinessSnapshot: GatherBusinessSnapshot;
};

export function createDisciplineHandlers(deps: DisciplineRpcDeps): GatewayRequestHandlers {
  const STATE_DIR_FN = deps.stateDir;

  function normalizeRoutineItems(raw: unknown): RoutineItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x: any) => x && typeof x.label === "string" && x.label.trim())
      .map((x: any, i: number) => ({
        id: typeof x.id === "string" && x.id ? x.id : `ri_${randomUUID().slice(0, 8)}`,
        label: String(x.label).slice(0, 200),
        order: Number.isFinite(x.order) ? Number(x.order) : i,
      }))
      .sort((a, b) => a.order - b.order);
  }

  function store() {
    return getDisciplineStore(STATE_DIR_FN());
  }

  function dataDir() {
    return disciplineDataDir(STATE_DIR_FN());
  }

  // Insight cache — the engine reads live business data, so we cache the whole
  // result for a short window (it refreshes on data change via the gateway feed,
  // and at worst goes stale for CACHE_MS). Keyed by the block-set signature so a
  // schedule edit busts the cache immediately.
  let _insightCache: { key: string; at: number; result: DisciplineInsightResult } | null = null;
  // (key includes the state dir, so tenants never share a cached result)
  const INSIGHT_CACHE_MS = 60_000;

  async function computeInsightsCached(force = false): Promise<DisciplineInsightResult> {
    const stateDir = STATE_DIR_FN();
    const blocks = store().getBlocks();
    const key =
      stateDir +
      "::" +
      blocks.map((b) => `${b.id}:${b.taskId ?? ""}:${b.projectId ?? ""}:${b.category}`).join("|");
    const now = Date.now();
    if (
      !force &&
      _insightCache &&
      _insightCache.key === key &&
      now - _insightCache.at < INSIGHT_CACHE_MS
    ) {
      return _insightCache.result;
    }
    const result = await computeDisciplineInsights(deps.gatherBusinessSnapshot, stateDir, blocks);
    _insightCache = { key, at: now, result };
    return result;
  }

  function normalizeCategory(
    v: unknown,
    fallback: DisciplineCategory = "deep-work",
  ): DisciplineCategory {
    return typeof v === "string" && (DISCIPLINE_CATEGORIES as string[]).includes(v)
      ? (v as DisciplineCategory)
      : fallback;
  }

  function clampMinute(v: unknown, fallback: number): number {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1440, Math.round(n)));
  }

  const _rawDisciplineHandlers: GatewayRequestHandlers = {
    "discipline.state": async ({ respond }) => {
      try {
        const s = store();
        const today = new Date().toISOString().slice(0, 10);
        respond(true, {
          blocks: s.getBlocks(),
          logs: s.getLogs({ limit: 500 }),
          settings: s.getSettings(),
          routineCompletions: s.getRoutineCompletions(today),
          blockCompletions: s.getBlockCompletions(today),
          blockOverrides: s.getBlockOverrides(today),
          dayStart: s.getDayStart(today),
        });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.complete": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id || typeof p.id !== "string") {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        const now = new Date();
        const nowMinute =
          typeof p.nowMinute === "number" && Number.isFinite(p.nowMinute)
            ? Math.max(0, Math.min(1440, Math.round(p.nowMinute)))
            : now.getHours() * 60 + now.getMinutes();
        const result = store().markBlockComplete(p.id, date, nowMinute);
        respond(true, result);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.uncomplete": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id || typeof p.id !== "string") {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        respond(true, store().unmarkBlockComplete(p.id, date));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.overrides.reset": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        respond(true, { cleared: store().resetBlockOverrides(date) });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.list": async ({ respond }) => {
      try {
        respond(true, store().getBlocks());
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.create": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.label || typeof p.label !== "string") {
          respond(false, undefined, { code: "BAD_REQUEST", message: "label required" });
          return;
        }
        const block = store().createBlock({
          label: p.label,
          category: normalizeCategory(p.category),
          intent: p.intent,
          startMinute: clampMinute(p.startMinute, 9 * 60),
          endMinute: clampMinute(p.endMinute, 10 * 60),
          days: Array.isArray(p.days)
            ? p.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
            : [],
          oneOffDate: p.oneOffDate,
          hard: !!p.hard,
          enabled: p.enabled !== false,
          color: p.color,
          projectId: p.projectId || undefined,
          taskId: p.taskId || undefined,
          nonNegotiable: !!p.nonNegotiable,
          routineItems: normalizeRoutineItems(p.routineItems),
        });
        respond(true, block);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.update": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const patch: Partial<DisciplineBlock> = {};
        if (p.label !== undefined) patch.label = String(p.label);
        if (p.category !== undefined) patch.category = normalizeCategory(p.category);
        if (p.intent !== undefined) patch.intent = p.intent || undefined;
        if (p.startMinute !== undefined) patch.startMinute = clampMinute(p.startMinute, 0);
        if (p.endMinute !== undefined) patch.endMinute = clampMinute(p.endMinute, 0);
        if (p.days !== undefined && Array.isArray(p.days)) {
          patch.days = p.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6);
        }
        if (p.oneOffDate !== undefined) patch.oneOffDate = p.oneOffDate || undefined;
        if (p.hard !== undefined) patch.hard = !!p.hard;
        if (p.enabled !== undefined) patch.enabled = !!p.enabled;
        if (p.color !== undefined) patch.color = p.color || undefined;
        if (p.projectId !== undefined) patch.projectId = p.projectId || undefined;
        if (p.taskId !== undefined) patch.taskId = p.taskId || undefined;
        if (p.nonNegotiable !== undefined) patch.nonNegotiable = !!p.nonNegotiable;
        if (p.routineItems !== undefined)
          patch.routineItems = normalizeRoutineItems(p.routineItems);
        const updated = store().updateBlock(p.id, patch);
        if (!updated) {
          respond(false, undefined, { code: "NOT_FOUND", message: "block not found" });
          return;
        }
        respond(true, updated);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.blocks.delete": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        respond(true, { deleted: store().deleteBlock(p.id) });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.logs.list": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        respond(
          true,
          store().getLogs({
            sinceMs: typeof p.sinceMs === "number" ? p.sinceMs : undefined,
            untilMs: typeof p.untilMs === "number" ? p.untilMs : undefined,
            limit: typeof p.limit === "number" ? p.limit : undefined,
          }),
        );
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.logs.create": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.label || typeof p.label !== "string") {
          respond(false, undefined, { code: "BAD_REQUEST", message: "label required" });
          return;
        }
        const source: LogSource = ["planned", "probe", "manual", "abort"].includes(p.source)
          ? p.source
          : "manual";
        const entry: Omit<DisciplineLog, "id" | "createdAt"> = {
          blockId: p.blockId || undefined,
          label: p.label,
          category: normalizeCategory(p.category),
          source,
          startMs: typeof p.startMs === "number" ? p.startMs : Date.now(),
          endMs: typeof p.endMs === "number" ? p.endMs : undefined,
          reason: p.reason || undefined,
          note: p.note || undefined,
        };
        respond(true, store().createLog(entry));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.logs.update": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const patch: Partial<DisciplineLog> = {};
        if (p.blockId !== undefined) patch.blockId = p.blockId || undefined;
        if (p.label !== undefined) patch.label = String(p.label);
        if (p.category !== undefined) patch.category = normalizeCategory(p.category);
        if (p.source !== undefined && ["planned", "probe", "manual", "abort"].includes(p.source)) {
          patch.source = p.source;
        }
        if (p.startMs !== undefined) patch.startMs = Number(p.startMs);
        if (p.endMs !== undefined) patch.endMs = p.endMs == null ? undefined : Number(p.endMs);
        if (p.reason !== undefined) patch.reason = p.reason || undefined;
        if (p.note !== undefined) patch.note = p.note || undefined;
        const updated = store().updateLog(p.id, patch);
        if (!updated) {
          respond(false, undefined, { code: "NOT_FOUND", message: "log not found" });
          return;
        }
        respond(true, updated);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.logs.delete": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        respond(true, { deleted: store().deleteLog(p.id) });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.settings.get": async ({ respond }) => {
      try {
        respond(true, store().getSettings());
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.settings.update": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const patch: Record<string, unknown> = {};
        if (p.militant !== undefined) patch.militant = !!p.militant;
        if (typeof p.probeIntervalMin === "number")
          patch.probeIntervalMin = Math.max(5, Math.min(240, p.probeIntervalMin));
        if (typeof p.dayStartHour === "number")
          patch.dayStartHour = Math.max(0, Math.min(23, p.dayStartHour));
        if (typeof p.dayEndHour === "number")
          patch.dayEndHour = Math.max(1, Math.min(24, p.dayEndHour));
        if (typeof p.quietHoursStart === "number")
          patch.quietHoursStart = Math.max(0, Math.min(23, p.quietHoursStart));
        if (typeof p.quietHoursEnd === "number")
          patch.quietHoursEnd = Math.max(0, Math.min(23, p.quietHoursEnd));
        if (p.telegramEnabled !== undefined) patch.telegramEnabled = !!p.telegramEnabled;
        if (typeof p.telegramChatId === "string") patch.telegramChatId = p.telegramChatId.trim();
        if (p.telegramEvents && typeof p.telegramEvents === "object")
          patch.telegramEvents = p.telegramEvents;
        if (p.prioritySortEnabled !== undefined)
          patch.prioritySortEnabled = !!p.prioritySortEnabled;
        if (p.priorityHighlight !== undefined) patch.priorityHighlight = !!p.priorityHighlight;
        respond(true, store().updateSettings(patch as any));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.routine.status": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        respond(true, store().getRoutineCompletions(date));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.routine.toggle": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.blockId || !p.itemId) {
          respond(false, undefined, {
            code: "BAD_REQUEST",
            message: "blockId and itemId required",
          });
          return;
        }
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        const completed = store().toggleRoutineCompletion(p.blockId, p.itemId, date);
        respond(true, { blockId: p.blockId, itemId: p.itemId, date, completed });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.score.day": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const date =
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
            ? p.date
            : new Date().toISOString().slice(0, 10);
        respond(true, store().computeDayScore(date));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    /**
     * Day scores across an arbitrary inclusive [from, to] date range. Same row
     * shape as `discipline.score.day`, returned oldest-first like
     * `discipline.score.week` — the analytics chart needs windows other than
     * exactly 7 days.
     */
    "discipline.score.range": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const isDate = (v: unknown): v is string =>
          typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

        // Parse and format in UTC throughout: `new Date("YYYY-MM-DDT00:00:00")`
        // is local time, so round-tripping through toISOString() shifts the day
        // by one on any machine that isn't at UTC+0.
        const DAY_MS = 86_400_000;
        const toIso = isDate(p.to) ? p.to : new Date().toISOString().slice(0, 10);
        const endMs = Date.parse(`${toIso}T00:00:00Z`);
        const fromIso = isDate(p.from)
          ? p.from
          : new Date(endMs - 6 * DAY_MS).toISOString().slice(0, 10);
        const startMs = Date.parse(`${fromIso}T00:00:00Z`);

        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid from/to date" });
          return;
        }
        if (endMs < startMs) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "`to` is before `from`" });
          return;
        }

        // Cap the window so a bad range can't walk thousands of days.
        const MAX_DAYS = 366;
        const s = store();
        const days: ReturnType<typeof s.computeDayScore>[] = [];
        for (let ms = startMs; ms <= endMs && days.length < MAX_DAYS; ms += DAY_MS) {
          days.push(s.computeDayScore(new Date(ms).toISOString().slice(0, 10)));
        }
        respond(true, days);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.score.week": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const end =
          typeof p.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.endDate)
            ? new Date(`${p.endDate}T00:00:00`)
            : new Date();
        const s = store();
        const days: ReturnType<typeof s.computeDayScore>[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(end);
          d.setDate(d.getDate() - i);
          days.push(s.computeDayScore(d.toISOString().slice(0, 10)));
        }
        respond(true, days);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    // ── Templates ──────────────────────────────────────────
    //
    // Saved snapshots of block layouts. The UI was already calling these
    // methods (controllers/discipline.ts loadTemplates / saveAsTemplate
    // / overwriteTemplate / renameTemplate / deleteTemplate / applyTemplate)
    // but only localStorage was holding state. These handlers move the
    // source of truth onto the server so the agent tool can drive the
    // same surface.

    "discipline.templates.list": async ({ respond }) => {
      try {
        respond(true, store().listTemplates());
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.templates.get": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const t = store().getTemplate(p.id);
        if (!t) {
          respond(false, undefined, { code: "NOT_FOUND", message: "template not found" });
          return;
        }
        respond(true, t);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.templates.create": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.name || typeof p.name !== "string") {
          respond(false, undefined, { code: "BAD_REQUEST", message: "name required" });
          return;
        }
        // Two modes:
        //   - Caller supplies `blocks`: persists exactly those.
        //   - Caller omits `blocks`: snapshots the current live schedule
        //     ("save current as a template" — the most common UI path).
        const blocks = Array.isArray(p.blocks) ? p.blocks : null;
        const t = blocks
          ? store().createTemplate({
              name: String(p.name),
              description: p.description ? String(p.description) : undefined,
              blocks,
              source: p.source === "imported" ? "imported" : "user",
            })
          : store().snapshotAsTemplate(
              String(p.name),
              p.description ? String(p.description) : undefined,
            );
        respond(true, t);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.templates.update": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (p.name !== undefined) patch.name = String(p.name);
        if (p.description !== undefined) patch.description = String(p.description);
        if (Array.isArray(p.blocks)) patch.blocks = p.blocks;
        const next = store().updateTemplate(p.id, patch as never);
        if (!next) {
          respond(false, undefined, { code: "NOT_FOUND", message: "template not found" });
          return;
        }
        respond(true, next);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.templates.delete": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        respond(true, { deleted: store().deleteTemplate(p.id) });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.templates.apply": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        if (!p.id) {
          respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
          return;
        }
        const result = store().applyTemplate(p.id);
        if (!result.applied) {
          respond(false, undefined, { code: "NOT_FOUND", message: "template not found" });
          return;
        }
        respond(true, result);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    // ── Auto-log events ─────────────────────────────────────────────────────

    "discipline.events.list": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const today = new Date();
        const todayStart = new Date(today.toISOString().slice(0, 10) + "T00:00:00").getTime();
        const todayEnd = todayStart + 86_400_000;
        const sinceMs = typeof p.sinceMs === "number" ? p.sinceMs : todayStart;
        const untilMs = typeof p.untilMs === "number" ? p.untilMs : todayEnd;
        const events = store().getDisciplineEvents({
          sinceMs,
          untilMs,
          limit: typeof p.limit === "number" ? Math.min(p.limit, 2000) : 500,
        });
        const counts = store().getDisciplineEventCounts(sinceMs, untilMs);
        respond(true, { events, counts });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    // ── Proactive insights ──────────────────────────────────────────────────
    //
    // Deterministic engine (src/discipline/insights.ts) folds live business data
    // — kanban tasks, projects, CRM clients, deadlines — into a per-block
    // headline + suggested action. Shared verbatim by web + mobile; both call
    // this RPC and only differ in presentation.

    "discipline.insights": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const result = await computeInsightsCached(p.force === true);
        respond(true, result);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    // Day-start status — when the discipline day auto-started today (or null).
    "discipline.day.status": async ({ respond }) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        respond(true, { date: today, dayStart: store().getDayStart(today) });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    // ── Start / End Day ─────────────────────────────────────────────────────

    "discipline.start_day": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const dow = now.getDay();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const toleranceMin = typeof p.toleranceMin === "number" ? p.toleranceMin : 60;

        const s = store();
        const allBlocks = s.getBlocks().filter((b) => {
          if (!b.enabled) return false;
          if (b.oneOffDate) return b.oneOffDate === today;
          return (b.days ?? []).includes(dow);
        });

        // Find the nearest block within ±toleranceMin of now
        let target =
          allBlocks
            .map((b) => ({ b, delta: Math.abs(b.startMinute - nowMin) }))
            .filter(({ delta }) => delta <= toleranceMin)
            .sort((a, b) => a.delta - b.delta)[0]?.b ?? null;

        if (target) {
          // Shift its start (and preserve duration)
          const duration = target.endMinute - target.startMinute;
          const newEnd = Math.min(1440, nowMin + duration);
          const updated = s.updateBlock(target.id, {
            startMinute: nowMin,
            endMinute: newEnd,
            oneOffDate: today, // pin this shift to today only
            days: [],
          });
          respond(true, { shifted: true, block: updated, nowMin });
        } else {
          // No nearby block — create a default Work block
          const newBlock = s.createBlock({
            label: "Work",
            category: "deep-work",
            intent: "Start of day work session",
            startMinute: nowMin,
            endMinute: Math.min(1440, nowMin + 90),
            days: [],
            oneOffDate: today,
            hard: false,
            enabled: true,
            color: undefined,
            projectId: undefined,
            taskId: undefined,
            nonNegotiable: false,
            routineItems: [],
          });
          respond(true, { shifted: false, block: newBlock, nowMin });
        }
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.end_day": async ({ params, respond }) => {
      try {
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const dow = now.getDay();

        const s = store();
        // Find active block and complete it
        const activeBlocks = s.getBlocks().filter((b) => {
          if (!b.enabled) return false;
          const start = b.startMinute;
          const end = b.endMinute;
          if (nowMin < start || nowMin >= end) return false;
          if (b.oneOffDate) return b.oneOffDate === today;
          return (b.days ?? []).includes(dow);
        });

        const completed = [];
        for (const b of activeBlocks) {
          const result = s.markBlockComplete(b.id, today, nowMin);
          completed.push({ blockId: b.id, label: b.label, ...result });
        }

        const score = s.computeDayScore(today);
        respond(true, { completedBlocks: completed, score });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.shift_from_now": async ({ respond }) => {
      try {
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const dow = now.getDay();
        const nowMin = now.getHours() * 60 + now.getMinutes();

        const s = store();
        // Get today's blocks sorted by start time
        const allBlocks = s
          .getBlocks()
          .filter((b) => {
            if (!b.enabled) return false;
            if (b.oneOffDate) return b.oneOffDate === today;
            return (b.days ?? []).includes(dow);
          })
          .sort((a, b) => a.startMinute - b.startMinute);

        // Find blocks that haven't finished yet (endMinute > nowMin)
        const remaining = allBlocks.filter((b) => b.endMinute > nowMin);
        if (remaining.length === 0) {
          respond(true, { shiftedCount: 0, blocks: [], nowMin });
          return;
        }

        // Resequence: first block starts NOW, each subsequent starts when previous ends
        let cursor = nowMin;
        const updated: any[] = [];
        for (const b of remaining) {
          const duration = Math.max(5, b.endMinute - b.startMinute);
          const newEnd = Math.min(1440, cursor + duration);
          const upd = s.updateBlock(b.id, {
            startMinute: cursor,
            endMinute: newEnd,
            oneOffDate: today,
            days: [],
          });
          updated.push(upd);
          cursor = newEnd;
        }

        respond(true, { shiftedCount: updated.length, blocks: updated, nowMin });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.notion.status": async ({ respond }) => {
      try {
        respond(true, getDisciplineNotionStatus(dataDir()));
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.notion.connect": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as any;
        const result = await connectDisciplineNotion(dataDir(), {
          blocksDatabaseId: typeof p.blocksDatabaseId === "string" ? p.blocksDatabaseId : undefined,
          logsDatabaseId: typeof p.logsDatabaseId === "string" ? p.logsDatabaseId : undefined,
        });
        respond(true, result);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.notion.disconnect": async ({ respond }) => {
      try {
        disconnectDisciplineNotion(dataDir());
        respond(true, { disconnected: true });
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },

    "discipline.notion.syncNow": async ({ respond }) => {
      try {
        const result = await syncDisciplineNow(dataDir(), store());
        respond(true, result);
      } catch (e) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
      }
    },
  };

  // Discipline state (blocks, logs, settings, templates, day-scoring) is per-
  // user, not per-device — wrapping every method routes satellites to master so
  // the user's daily plan and completion log is identical on every screen.
  return _rawDisciplineHandlers;
}
