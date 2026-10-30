/**
 * Discipline agent tool — full robust control of the /discipline page.
 * Registered by the Discipline plugin into core's `discipline` tool slot.
 *
 * Wraps the same in-process store the gateway uses so writes are
 * immediately visible to the live UI (a connected browser repaints on
 * the next discipline.state poll). The agent can:
 *   - Create / update / delete / list blocks (the scheduled time-boxes)
 *   - Mark complete / uncomplete; reset overrides for a date
 *   - Append / edit / delete activity logs
 *   - Read + adjust settings (militant mode, probe interval, day window)
 *   - Pull today/week scores
 *   - Save current schedule as a template; list, load, delete templates
 *   - Assign or clear a project / task on a block (kanban linkage)
 *
 * Design notes:
 *   - Same store handle as the gateway, so a UI tab open during agent
 *     edits doesn't get a stale snapshot — the next state-poll picks
 *     it up.
 *   - Routine items: a flat array of { label, order? }. The tool
 *     normalizes them the same way the gateway does (drops blanks,
 *     stamps ids, sorts by order). Operators can pass strings only
 *     ("[\"Push-ups\", \"Stretch\"]") — the tool wraps them.
 *   - Day-of-week (`days`): integers 0=Sun..6=Sat. Defaults to all
 *     seven when omitted on create (so the block fires daily).
 *   - Time fields accept either "HH:MM" strings ("09:30") or raw
 *     minutes-from-midnight numbers. Strings are converted up-front so
 *     the rest of the tool can rely on numbers.
 *
 * Returns minimal JSON bodies — agents prefer compact context.
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { jsonResult, readStringParam, stringEnum } from "infinibot/plugin-sdk";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import { getDisciplineStore } from "./store.js";
import {
  DISCIPLINE_CATEGORIES,
  type DisciplineBlock,
  type DisciplineCategory,
  type DisciplineLog,
  type DisciplineTemplateBlock,
  type LogSource,
  type RoutineItem,
} from "./types.js";

const ACTIONS = [
  // Blocks
  "list_blocks",
  "get_block",
  "create_block",
  "update_block",
  "delete_block",
  "complete_block",
  "uncomplete_block",
  "reset_overrides",
  // Task / project assignment
  "assign_task",
  "assign_project",
  "clear_assignment",
  // Logs
  "list_logs",
  "create_log",
  "update_log",
  "delete_log",
  // Settings
  "get_settings",
  "update_settings",
  // Scoring
  "score_day",
  "score_week",
  // Templates
  "list_templates",
  "get_template",
  "save_template",
  "update_template",
  "delete_template",
  "apply_template",
  // Day lifecycle
  "start_day",
  "end_day",
  // Analytics + query shortcuts
  "query_today",
  "log_event",
  "set_setting",
] as const;

const LOG_SOURCES = ["planned", "probe", "manual", "abort"] as const;

const DisciplineToolSchema = Type.Object({
  action: stringEnum(ACTIONS),

  // Block fields (subset shared by create + update — runtime decides what's required)
  id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  category: Type.Optional(stringEnum(DISCIPLINE_CATEGORIES as readonly DisciplineCategory[])),
  intent: Type.Optional(Type.String()),
  /** Start time. Either "HH:MM" or minutes-from-midnight number. */
  start: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  /** End time. Either "HH:MM" or minutes-from-midnight number. */
  end: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  /** Days of week (0=Sun..6=Sat). Empty → daily. */
  days: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }))),
  oneOffDate: Type.Optional(Type.String()),
  hard: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(Type.Boolean()),
  color: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  nonNegotiable: Type.Optional(Type.Boolean()),
  routineItems: Type.Optional(
    Type.Array(
      Type.Union([
        Type.String(),
        Type.Object({
          label: Type.String(),
          order: Type.Optional(Type.Number()),
        }),
      ]),
    ),
  ),

  // Date helpers
  date: Type.Optional(Type.String()), // YYYY-MM-DD
  endDate: Type.Optional(Type.String()), // for score_week

  // Logs
  blockId: Type.Optional(Type.String()),
  source: Type.Optional(stringEnum(LOG_SOURCES)),
  startMs: Type.Optional(Type.Number()),
  endMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  /** Kind of discipline event for log_event action. */
  eventKind: Type.Optional(Type.String()),
  /** JSON payload for log_event. */
  payload: Type.Optional(Type.String()),
  /** Setting key for set_setting action. */
  settingKey: Type.Optional(Type.String()),
  /** Setting value for set_setting (any JSON-serialisable value). */
  settingValue: Type.Optional(Type.Any()),

  // Settings
  militant: Type.Optional(Type.Boolean()),
  probeIntervalMin: Type.Optional(Type.Number()),
  dayStartHour: Type.Optional(Type.Number()),
  dayEndHour: Type.Optional(Type.Number()),

  // Templates
  templateId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  /**
   * Optional explicit blocks payload when saving a template. Omit to
   * snapshot the current live schedule — the most common case.
   */
  blocks: Type.Optional(Type.Array(Type.Any())),
});

let resolveStateDir: () => string = () => {
  throw new Error("discipline tool used before the plugin registered it");
};

function store() {
  return getDisciplineStore(resolveStateDir());
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampMinute(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1440, Math.round(v)));
}

/** Accept "HH:MM" or a raw minute number; return minutes-from-midnight. */
function timeToMinutes(v: unknown, fallback: number): number {
  if (typeof v === "number") return clampMinute(v, fallback);
  if (typeof v === "string") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (m) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        return clampMinute(hh * 60 + mm, fallback);
      }
    }
    const n = Number(v);
    if (Number.isFinite(n)) return clampMinute(n, fallback);
  }
  return fallback;
}

function normalizeRoutineItems(raw: unknown): RoutineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, i) => {
      if (typeof entry === "string") {
        const label = entry.trim();
        if (!label) return null;
        return { id: `ri_${randomUUID().slice(0, 8)}`, label, order: i };
      }
      if (entry && typeof entry === "object") {
        const o = entry as { id?: unknown; label?: unknown; order?: unknown };
        const label = typeof o.label === "string" ? o.label.trim() : "";
        if (!label) return null;
        return {
          id: typeof o.id === "string" && o.id ? o.id : `ri_${randomUUID().slice(0, 8)}`,
          label,
          order: typeof o.order === "number" ? Math.floor(o.order) : i,
        };
      }
      return null;
    })
    .filter((x): x is RoutineItem => x !== null)
    .sort((a, b) => a.order - b.order);
}

function formatBlock(b: DisciplineBlock): Record<string, unknown> {
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    id: b.id,
    label: b.label,
    category: b.category,
    intent: b.intent ?? null,
    start: fmt(b.startMinute),
    end: fmt(b.endMinute),
    startMinute: b.startMinute,
    endMinute: b.endMinute,
    days: b.days,
    oneOffDate: b.oneOffDate ?? null,
    hard: b.hard,
    enabled: b.enabled,
    color: b.color ?? null,
    projectId: b.projectId ?? null,
    taskId: b.taskId ?? null,
    nonNegotiable: b.nonNegotiable,
    routineItems: b.routineItems.map((r) => ({ id: r.id, label: r.label, order: r.order })),
  };
}

function readDate(params: Record<string, unknown>): string {
  const v = params.date;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return todayIso();
}

export function createDisciplineTool(stateDir: () => string): AnyAgentTool {
  resolveStateDir = stateDir;
  return {
    label: "Discipline",
    name: "discipline",
    description:
      "Full control of the /discipline page: create / edit / delete / complete time-blocks, manage routine checklists, append logs, adjust settings (militant mode, probe interval, day window), score days / weeks, save current schedule as a template + apply saved templates, assign kanban projects / tasks to blocks. Time fields accept 'HH:MM' or minutes-from-midnight. days = [0..6] (0=Sun); omit for daily. Use list_blocks first to discover ids before editing/completing. New shortcut actions: query_today (active block + next + score), log_event (write an event to a block), set_setting (set a single settings key).",
    parameters: DisciplineToolSchema,
    execute: async (_toolCallId, args) => {
      const p = args as Record<string, unknown>;
      const action = readStringParam(p, "action", { required: true });
      const s = store();

      switch (action) {
        // ── Blocks ─────────────────────────────────────────────
        case "list_blocks":
          return jsonResult({ blocks: s.getBlocks().map(formatBlock) });
        case "get_block": {
          const id = readStringParam(p, "id", { required: true });
          const found = s.getBlocks().find((b) => b.id === id);
          if (!found) return jsonResult({ ok: false, error: "block not found" });
          return jsonResult({ block: formatBlock(found) });
        }
        case "create_block": {
          const label = readStringParam(p, "label", { required: true });
          const startMinute = timeToMinutes(p.start, 9 * 60);
          const endMinute = timeToMinutes(p.end, startMinute + 60);
          const days =
            Array.isArray(p.days) && p.days.length > 0
              ? (p.days as number[]).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
              : [0, 1, 2, 3, 4, 5, 6];
          const block = s.createBlock({
            label,
            category: (readStringParam(p, "category") as DisciplineCategory) ?? "deep-work",
            intent: readStringParam(p, "intent") || undefined,
            startMinute,
            endMinute,
            days,
            oneOffDate: readStringParam(p, "oneOffDate") || undefined,
            hard: p.hard === true,
            enabled: p.enabled !== false,
            color: readStringParam(p, "color") || undefined,
            projectId: readStringParam(p, "projectId") || undefined,
            taskId: readStringParam(p, "taskId") || undefined,
            nonNegotiable: p.nonNegotiable === true,
            routineItems: normalizeRoutineItems(p.routineItems),
          });
          return jsonResult({ block: formatBlock(block) });
        }
        case "update_block": {
          const id = readStringParam(p, "id", { required: true });
          const patch: Partial<DisciplineBlock> = {};
          if (p.label !== undefined) patch.label = String(p.label);
          if (p.category !== undefined)
            patch.category = readStringParam(p, "category") as DisciplineCategory;
          if (p.intent !== undefined) patch.intent = readStringParam(p, "intent") || undefined;
          if (p.start !== undefined) patch.startMinute = timeToMinutes(p.start, 0);
          if (p.end !== undefined) patch.endMinute = timeToMinutes(p.end, 0);
          if (p.days !== undefined && Array.isArray(p.days)) {
            patch.days = (p.days as number[]).filter(
              (d) => Number.isInteger(d) && d >= 0 && d <= 6,
            );
          }
          if (p.oneOffDate !== undefined)
            patch.oneOffDate = readStringParam(p, "oneOffDate") || undefined;
          if (p.hard !== undefined) patch.hard = p.hard === true;
          if (p.enabled !== undefined) patch.enabled = p.enabled === true;
          if (p.color !== undefined) patch.color = readStringParam(p, "color") || undefined;
          if (p.projectId !== undefined)
            patch.projectId = readStringParam(p, "projectId") || undefined;
          if (p.taskId !== undefined) patch.taskId = readStringParam(p, "taskId") || undefined;
          if (p.nonNegotiable !== undefined) patch.nonNegotiable = p.nonNegotiable === true;
          if (p.routineItems !== undefined)
            patch.routineItems = normalizeRoutineItems(p.routineItems);
          const updated = s.updateBlock(id, patch);
          if (!updated) return jsonResult({ ok: false, error: "block not found" });
          return jsonResult({ block: formatBlock(updated) });
        }
        case "delete_block": {
          const id = readStringParam(p, "id", { required: true });
          return jsonResult({ deleted: s.deleteBlock(id) });
        }
        case "complete_block": {
          const id = readStringParam(p, "id", { required: true });
          const now = new Date();
          const nowMinute = now.getHours() * 60 + now.getMinutes();
          const r = s.markBlockComplete(id, readDate(p), nowMinute);
          return jsonResult(r);
        }
        case "uncomplete_block": {
          const id = readStringParam(p, "id", { required: true });
          const r = s.unmarkBlockComplete(id, readDate(p));
          return jsonResult(r);
        }
        case "reset_overrides":
          return jsonResult({ cleared: s.resetBlockOverrides(readDate(p)) });

        // ── Task / project assignment (sugar over update_block) ─
        case "assign_task": {
          const id = readStringParam(p, "id", { required: true });
          const taskId = readStringParam(p, "taskId", { required: true });
          const updated = s.updateBlock(id, { taskId });
          if (!updated) return jsonResult({ ok: false, error: "block not found" });
          return jsonResult({ block: formatBlock(updated) });
        }
        case "assign_project": {
          const id = readStringParam(p, "id", { required: true });
          const projectId = readStringParam(p, "projectId", { required: true });
          const updated = s.updateBlock(id, { projectId });
          if (!updated) return jsonResult({ ok: false, error: "block not found" });
          return jsonResult({ block: formatBlock(updated) });
        }
        case "clear_assignment": {
          const id = readStringParam(p, "id", { required: true });
          const updated = s.updateBlock(id, { projectId: undefined, taskId: undefined });
          if (!updated) return jsonResult({ ok: false, error: "block not found" });
          return jsonResult({ block: formatBlock(updated) });
        }

        // ── Logs ──────────────────────────────────────────────
        case "list_logs": {
          const sinceMs = typeof p.startMs === "number" ? p.startMs : undefined;
          const untilMs = typeof p.endMs === "number" ? p.endMs : undefined;
          return jsonResult({ logs: s.getLogs({ sinceMs, untilMs, limit: 500 }) });
        }
        case "create_log": {
          const label = readStringParam(p, "label", { required: true });
          const entry: Omit<DisciplineLog, "id" | "createdAt"> = {
            blockId: readStringParam(p, "blockId") || undefined,
            label,
            category: (readStringParam(p, "category") as DisciplineCategory) ?? "deep-work",
            source: (readStringParam(p, "source") as LogSource) || "manual",
            startMs: typeof p.startMs === "number" ? p.startMs : Date.now(),
            endMs: typeof p.endMs === "number" ? p.endMs : undefined,
            reason: readStringParam(p, "reason") || undefined,
            note: readStringParam(p, "note") || undefined,
          };
          return jsonResult({ log: s.createLog(entry) });
        }
        case "update_log": {
          const id = readStringParam(p, "id", { required: true });
          const patch: Partial<DisciplineLog> = {};
          if (p.blockId !== undefined) patch.blockId = readStringParam(p, "blockId") || undefined;
          if (p.label !== undefined) patch.label = String(p.label);
          if (p.category !== undefined)
            patch.category = readStringParam(p, "category") as DisciplineCategory;
          if (
            p.source !== undefined &&
            (LOG_SOURCES as readonly string[]).includes(String(p.source))
          )
            patch.source = p.source as LogSource;
          if (p.startMs !== undefined) patch.startMs = Number(p.startMs);
          if (p.endMs !== undefined) patch.endMs = p.endMs == null ? undefined : Number(p.endMs);
          if (p.reason !== undefined) patch.reason = readStringParam(p, "reason") || undefined;
          if (p.note !== undefined) patch.note = readStringParam(p, "note") || undefined;
          const updated = s.updateLog(id, patch);
          if (!updated) return jsonResult({ ok: false, error: "log not found" });
          return jsonResult({ log: updated });
        }
        case "delete_log": {
          const id = readStringParam(p, "id", { required: true });
          return jsonResult({ deleted: s.deleteLog(id) });
        }

        // ── Settings ──────────────────────────────────────────
        case "get_settings":
          return jsonResult({ settings: s.getSettings() });
        case "update_settings": {
          // updateSettings spreads patch over current, and `undefined`
          // beats the spread (overriding the defined value with null).
          // Build a clean patch with only the keys the caller actually set.
          const patch: Record<string, unknown> = {};
          if (p.militant !== undefined) patch.militant = !!p.militant;
          if (typeof p.probeIntervalMin === "number") {
            patch.probeIntervalMin = Math.max(5, Math.min(240, Math.round(p.probeIntervalMin)));
          }
          if (typeof p.dayStartHour === "number") {
            patch.dayStartHour = Math.max(0, Math.min(23, Math.round(p.dayStartHour)));
          }
          if (typeof p.dayEndHour === "number") {
            patch.dayEndHour = Math.max(1, Math.min(24, Math.round(p.dayEndHour)));
          }
          const next = s.updateSettings(patch as never);
          return jsonResult({ settings: next });
        }

        // ── Scoring ──────────────────────────────────────────
        case "score_day":
          return jsonResult({ score: s.computeDayScore(readDate(p)) });
        case "score_week": {
          const endIso =
            typeof p.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.endDate)
              ? p.endDate
              : todayIso();
          const end = new Date(`${endIso}T00:00:00`);
          const days: ReturnType<typeof s.computeDayScore>[] = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date(end);
            d.setDate(d.getDate() - i);
            days.push(s.computeDayScore(d.toISOString().slice(0, 10)));
          }
          return jsonResult({ days });
        }

        // ── Templates ────────────────────────────────────────
        case "list_templates":
          return jsonResult({
            templates: s.listTemplates().map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description ?? null,
              source: t.source,
              blockCount: t.blocks.length,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            })),
          });
        case "get_template": {
          const id = readStringParam(p, "templateId", { required: true });
          const t = s.getTemplate(id);
          if (!t) return jsonResult({ ok: false, error: "template not found" });
          return jsonResult({ template: t });
        }
        case "save_template": {
          const name = readStringParam(p, "name", { required: true });
          const description = readStringParam(p, "description") || undefined;
          // Default: snapshot the current live schedule. Caller can
          // pass an explicit `blocks` array to persist a different
          // shape (e.g. for templating from an imported JSON file).
          let template;
          if (Array.isArray(p.blocks)) {
            template = s.createTemplate({
              name,
              description,
              blocks: p.blocks as DisciplineTemplateBlock[],
              source: "user",
            });
          } else {
            template = s.snapshotAsTemplate(name, description);
          }
          return jsonResult({
            template: {
              id: template.id,
              name: template.name,
              description: template.description ?? null,
              source: template.source,
              blockCount: template.blocks.length,
            },
          });
        }
        case "update_template": {
          const id = readStringParam(p, "templateId", { required: true });
          const patch: Record<string, unknown> = {};
          if (p.name !== undefined) patch.name = String(p.name);
          if (p.description !== undefined) patch.description = String(p.description);
          if (Array.isArray(p.blocks)) patch.blocks = p.blocks;
          const next = s.updateTemplate(id, patch as never);
          if (!next) return jsonResult({ ok: false, error: "template not found" });
          return jsonResult({ template: next });
        }
        case "delete_template": {
          const id = readStringParam(p, "templateId", { required: true });
          return jsonResult({ deleted: s.deleteTemplate(id) });
        }
        case "apply_template": {
          const id = readStringParam(p, "templateId", { required: true });
          const result = s.applyTemplate(id);
          if (!result.applied) return jsonResult({ ok: false, error: "template not found" });
          return jsonResult({
            applied: true,
            blocks: result.blocks.map(formatBlock),
            blockCount: result.blocks.length,
          });
        }

        case "start_day": {
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          const dow = now.getDay();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const toleranceMin = typeof p.toleranceMin === "number" ? p.toleranceMin : 60;
          const allBlocks = s.getBlocks().filter((b) => {
            if (!b.enabled) return false;
            if (b.oneOffDate) return b.oneOffDate === today;
            return (b.days ?? []).includes(dow);
          });
          const target =
            allBlocks
              .map((b) => ({ b, delta: Math.abs(b.startMinute - nowMin) }))
              .filter(({ delta }) => delta <= toleranceMin)
              .sort((a, b) => a.delta - b.delta)[0]?.b ?? null;
          if (target) {
            const duration = target.endMinute - target.startMinute;
            const newEnd = Math.min(1440, nowMin + duration);
            const updated = s.updateBlock(target.id, {
              startMinute: nowMin,
              endMinute: newEnd,
              oneOffDate: today,
              days: [],
            });
            return jsonResult({
              shifted: true,
              block: updated ? formatBlock(updated) : null,
              nowMin,
            });
          }
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
          return jsonResult({ shifted: false, block: formatBlock(newBlock), nowMin });
        }

        case "end_day": {
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const dow = now.getDay();
          const activeBlocks = s.getBlocks().filter((b) => {
            if (!b.enabled) return false;
            if (nowMin < b.startMinute || nowMin >= b.endMinute) return false;
            if (b.oneOffDate) return b.oneOffDate === today;
            return (b.days ?? []).includes(dow);
          });
          const completed = [];
          for (const b of activeBlocks) {
            const result = s.markBlockComplete(b.id, today, nowMin);
            completed.push({ blockId: b.id, label: b.label });
          }
          const score = s.computeDayScore(today);
          return jsonResult({ completedBlocks: completed, score });
        }

        case "query_today": {
          const now = new Date();
          const today = now.toISOString().slice(0, 10);
          const dow = now.getDay();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const allBlocks = s.getBlocks().filter((b) => {
            if (!b.enabled) return false;
            if (b.oneOffDate) return b.oneOffDate === today;
            return (b.days ?? []).includes(dow);
          });
          const active =
            allBlocks.find((b) => nowMin >= b.startMinute && nowMin < b.endMinute) ?? null;
          const next =
            allBlocks
              .filter((b) => b.startMinute > nowMin)
              .sort((a, bk) => a.startMinute - bk.startMinute)[0] ?? null;
          const score = s.computeDayScore(today);
          // Dispatch a DOM-visible agent action event via console marker so the
          // UI polling can detect agent activity in the current session log.
          console.log(
            `[discipline:agent-action] action=query_today date=${today} compliance=${score.compliance}`,
          );
          return jsonResult({
            today,
            nowMin,
            activeBlock: active ? formatBlock(active) : null,
            nextBlock: next ? formatBlock(next) : null,
            score,
          });
        }

        case "log_event": {
          const blockId = readStringParam(p, "blockId") || null;
          const kind = readStringParam(p, "eventKind") || "agent:tool";
          const payload = readStringParam(p, "payload") || "{}";
          const now2 = Date.now();
          // Persist as a standard discipline log so it appears in the UI
          const label = readStringParam(p, "label") || `Agent event: ${kind}`;
          const entry = s.createLog({
            blockId: blockId ?? undefined,
            label,
            category: (readStringParam(p, "category") as DisciplineCategory) ?? "ops",
            source: "probe",
            startMs: now2,
            endMs: now2,
            note: payload,
          });
          console.log(`[discipline:agent-action] action=log_event blockId=${blockId} kind=${kind}`);
          return jsonResult({ event: { id: entry.id, blockId, kind, payload, createdAt: now2 } });
        }

        case "set_setting": {
          const key = readStringParam(p, "settingKey", { required: true });
          const value = p.settingValue;
          const patch: Record<string, unknown> = { [key]: value };
          const next2 = s.updateSettings(patch as never);
          console.log(`[discipline:agent-action] action=set_setting key=${key}`);
          return jsonResult({ settings: next2 });
        }

        default:
          throw new Error(`Unknown discipline action: ${action}`);
      }
    },
  };
}
