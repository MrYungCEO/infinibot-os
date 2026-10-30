/**
 * Verified-completion agent tools (all agents + every MCP client):
 *
 *   subagents_wait    block until given runIds reach a terminal state; returns
 *                     each run's RESULT summary + review verdict
 *   subagents_events  cursor-based feed of completion events (terminal states,
 *                     verdicts, auto-continuations) for the calling session
 *   visual_verify     the standard visual verification harness (screenshots +
 *                     console/RPC errors + vision assessment)
 *
 * These are how an orchestrator connected over MCP (Claude Code, Codex, …)
 * reliably learns that its detached sub-agents finished — no PID/tmux/log
 * polling. See docs/principles/VERIFIED-COMPLETION.md.
 */

import { Type } from "@sinclair/typebox";

import { getSubagentRun, getSubagentRunBySessionKey } from "../subagent-registry.js";
import {
  currentCursor,
  getRecord,
  listEvents,
  waitForRuns,
  type CompletionRecord,
} from "../../verification/store.js";
import { runVisualVerify } from "../../verification/visual/index.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

export const SUBAGENTS_WAIT_MAX_SEC = 600;

/** Compact, orchestrator-facing view of a completion record. */
export function describeRecord(rec: CompletionRecord) {
  return {
    runId: rec.runId,
    label: rec.label,
    state: rec.state,
    verdict: rec.review?.verdict ?? null,
    verified: rec.state === "verified" || rec.state === "accepted",
    summary: rec.result?.summary ?? null,
    reasons: rec.review?.reasons ?? [],
    commits: rec.result?.commits ?? [],
    filesChanged: rec.review?.changedFiles ?? rec.result?.files_changed ?? [],
    screenshots: rec.review?.screenshots ?? [],
    openIssues: rec.result?.open_issues ?? [],
    attempts: rec.attempts.length,
    backend: rec.backend,
    terminalAt: rec.terminalAt,
    relay:
      rec.state === "verified" || rec.state === "accepted"
        ? "Verified — you may relay the summary as done."
        : `NOT verified (${rec.state}). Relay the reasons, not the agent's claims as facts.`,
  };
}

/** Runs the registry knows about but the pipeline never saw (legacy / pre-upgrade). */
function registryFallback(runId: string): CompletionRecord | "running" | "unknown" {
  const entry = getSubagentRun(runId);
  if (!entry) return "unknown";
  if (!entry.endedAt) return "running";
  const now = entry.endedAt;
  return {
    runId,
    token: "",
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    label: entry.label ?? runId,
    task: entry.task,
    backend: entry.coderBackend ?? null,
    model: null,
    workdir: entry.workdir ?? null,
    baseCommit: null,
    startedAt: entry.startedAt ?? now,
    updatedAt: now,
    state: entry.outcome?.status === "error" ? "failed" : "unverified",
    attempts: [],
    maxContinuations: 0,
    result: null,
    review: {
      verdict: entry.outcome?.status === "error" ? "FAILED" : "UNVERIFIED",
      reasons: ["run finished without a verified-completion review (legacy run)"],
      evidence: [],
      visualFiles: [],
      visualSatisfied: false,
      screenshots: [],
      llm: null,
      changedFiles: [],
      commits: [],
      reviewedAt: now,
    },
    terminalAt: now,
    round: 1,
  };
}

const WaitSchema = Type.Object({
  runIds: Type.Array(Type.String(), {
    description:
      "Run ids returned by claude_coder / codex_coder / opencode_coder / grok_coder / sessions_spawn.",
  }),
  mode: Type.Optional(
    stringEnum(["all", "any"] as const, { description: "all (default) or any." }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `Max seconds to block (default 50, max ${SUBAGENTS_WAIT_MAX_SEC}).`,
    }),
  ),
});

export function createSubagentsWaitTool(): AnyAgentTool {
  return {
    label: "Wait for sub-agents",
    name: "subagents_wait",
    description:
      "Block until the given sub-agent runs reach a terminal state (verified | unverified | failed | stalled | blocked | needs_input | needs_owner), then return each run's summary and review verdict. " +
      "Use this after delegating instead of polling PIDs, tmux or log files. Returns early with timedOut=true and the still-pending runIds — call again to keep waiting. " +
      "Only relay work as done when verdict is VERIFIED.",
    parameters: WaitSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const runIds = Array.isArray(params.runIds)
        ? (params.runIds as unknown[]).filter(
            (x): x is string => typeof x === "string" && x.trim() !== "",
          )
        : [];
      if (runIds.length === 0) throw new Error("subagents_wait: runIds is required");
      const mode = params.mode === "any" ? "any" : "all";
      const raw = typeof params.timeoutSec === "number" ? params.timeoutSec : 50;
      const timeoutSec = Math.max(0, Math.min(SUBAGENTS_WAIT_MAX_SEC, raw));
      const res = await waitForRuns({
        runIds,
        mode,
        timeoutMs: timeoutSec * 1000,
        fallback: registryFallback,
      });
      return jsonResult({
        done: res.done.map(describeRecord),
        pending: res.pending.map((id) => {
          const rec = getRecord(id);
          return { runId: id, state: rec?.state ?? "running", attempts: rec?.attempts.length ?? 1 };
        }),
        unknown: res.unknown,
        timedOut: res.timedOut,
        cursor: currentCursor(),
      });
    },
  };
}

const EventsSchema = Type.Object({
  cursor: Type.Optional(
    Type.Number({
      description: "Return events after this cursor (from the previous call). Omit for all.",
    }),
  ),
  runIds: Type.Optional(Type.Array(Type.String())),
  all: Type.Optional(
    Type.Boolean({
      description: "Include events for runs spawned by other sessions (default: only yours).",
    }),
  ),
  terminalOnly: Type.Optional(Type.Boolean({ description: "Only terminal (finished) events." })),
  waitSec: Type.Optional(
    Type.Number({
      description: "Long-poll: block up to N seconds (max 300) until a new event arrives.",
    }),
  ),
  limit: Type.Optional(Type.Number()),
});

export function createSubagentsEventsTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Sub-agent completion events",
    name: "subagents_events",
    description:
      "Cursor-based feed of sub-agent completion events for your session: run.terminal (with verdict), run.continued (auto-resume after a premature exit / missing evidence), run.decision. " +
      "Pass the returned cursor next time to get only new events; waitSec long-polls. Reliable delivery for MCP clients that cannot receive pushes.",
    parameters: EventsSchema,
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const cursor = typeof params.cursor === "number" ? params.cursor : 0;
      const runIds = Array.isArray(params.runIds)
        ? (params.runIds as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const requesterSessionKey =
        params.all === true || runIds?.length ? undefined : opts?.agentSessionKey;
      const types = params.terminalOnly === true ? (["run.terminal"] as const) : undefined;
      const limit =
        typeof params.limit === "number" ? Math.min(500, Math.max(1, params.limit)) : 100;
      const query = () =>
        listEvents({
          cursor,
          requesterSessionKey,
          runIds,
          types: types ? [...types] : undefined,
          limit,
        });
      let res = query();
      const waitSec =
        typeof params.waitSec === "number" ? Math.min(300, Math.max(0, params.waitSec)) : 0;
      if (res.events.length === 0 && waitSec > 0) {
        const { onCompletionEvent } = await import("../../verification/store.js");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            off();
            resolve();
          }, waitSec * 1000);
          const off = onCompletionEvent(() => {
            if (query().events.length > 0) {
              clearTimeout(timer);
              off();
              resolve();
            }
          });
        });
        res = query();
      }
      return jsonResult({
        events: res.events.map((ev) => {
          const rec = ev.type === "run.terminal" ? getRecord(ev.runId) : undefined;
          return { ...ev, ...(rec ? { run: describeRecord(rec) } : {}) };
        }),
        cursor: res.cursor,
        scope: requesterSessionKey ? `session ${requesterSessionKey}` : "all sessions",
      });
    },
  };
}

const ViewportSchema = Type.Object({
  width: Type.Number(),
  height: Type.Number(),
  name: Type.Optional(Type.String()),
});

const VisualVerifySchema = Type.Object({
  routes: Type.Array(Type.String(), {
    description: "Control-UI routes, e.g. ['/chat', '/agents'].",
  }),
  expectation: Type.Optional(
    Type.String({
      description: "What the change should look like — the vision reviewer grades against it.",
    }),
  ),
  worktree: Type.Optional(
    Type.String({
      description:
        "Absolute worktree path whose dist/control-ui to serve (build it first: pnpm -C ui build). Omit or 'live' to screenshot the live gateway UI.",
    }),
  ),
  distDir: Type.Optional(
    Type.String({
      description: "Explicit static dir to serve instead of <worktree>/dist/control-ui.",
    }),
  ),
  baseUrl: Type.Optional(
    Type.String({ description: "Load a different origin (e.g. a dev server) instead." }),
  ),
  viewports: Type.Optional(
    Type.Array(ViewportSchema, { description: "Default 1440x900 + 390x844." }),
  ),
  themes: Type.Optional(
    Type.Array(Type.String(), { description: "dark | light | hud | system. Default dark." }),
  ),
  actions: Type.Optional(
    Type.Array(
      Type.Object({
        type: stringEnum(["click", "type", "press", "wait", "scroll", "hover", "eval"] as const),
        selector: Type.Optional(Type.String({ description: "CSS selector; pierces shadow DOM." })),
        text: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        ms: Type.Optional(Type.Number()),
        script: Type.Optional(Type.String()),
        y: Type.Optional(Type.Number()),
      }),
      { description: "Interactions to run before the screenshot." },
    ),
  ),
  crops: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        selector: Type.Optional(Type.String()),
        clip: Type.Optional(
          Type.Object({
            x: Type.Number(),
            y: Type.Number(),
            width: Type.Number(),
            height: Type.Number(),
          }),
        ),
      }),
    ),
  ),
  waitFor: Type.Optional(
    Type.String({ description: "Selector to wait for (shadow-piercing) before capturing." }),
  ),
  settleMs: Type.Optional(Type.Number()),
  compareTo: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String())], {
      description: "Baseline screenshots (dir or file list) for a before/after comparison.",
    }),
  ),
  gatewayPort: Type.Optional(
    Type.Number({ description: "Gateway the page connects to (default: this gateway)." }),
  ),
  fullPage: Type.Optional(Type.Boolean()),
});

/** runId of the calling coder spawn, from its MCP session key (`claude-coder:<runId>`) or subagent key. */
export function runIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const m = sessionKey.match(/^claude-coder:(.+)$/);
  if (m) return m[1];
  const rec = getSubagentRunBySessionKey(sessionKey);
  return rec?.runId;
}

export function createVisualVerifyTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Visual verify",
    name: "visual_verify",
    description:
      "MANDATORY for any visual change (UI/CSS/HTML views, components, styles, mobile screens, docs pages). Screenshots control-UI routes headlessly at desktop + mobile viewports " +
      "(serving a worktree's dist/control-ui on a free port, or the live UI), handles gateway auth, the profile gate, overlays and WebGL flags, records console errors + failed RPCs, " +
      "and has a vision model grade the screenshots against your `expectation`. Returns screenshot paths — put them in your RESULT block's `screenshots`.",
    parameters: VisualVerifySchema,
    execute: async (_id, args) => {
      const p = args as Record<string, unknown>;
      const routes = Array.isArray(p.routes)
        ? (p.routes as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      const res = await runVisualVerify({
        routes,
        expectation: readStringParam(p, "expectation"),
        worktree: readStringParam(p, "worktree"),
        distDir: readStringParam(p, "distDir"),
        baseUrl: readStringParam(p, "baseUrl"),
        viewports: Array.isArray(p.viewports)
          ? (p.viewports as Array<{ width: number; height: number; name?: string }>)
          : undefined,
        themes: Array.isArray(p.themes) ? (p.themes as string[]) : undefined,
        actions: Array.isArray(p.actions) ? (p.actions as never[]) : undefined,
        crops: Array.isArray(p.crops) ? (p.crops as never[]) : undefined,
        waitFor: readStringParam(p, "waitFor"),
        settleMs: typeof p.settleMs === "number" ? p.settleMs : undefined,
        compareTo: (p.compareTo as string | string[] | undefined) ?? null,
        gatewayPort: typeof p.gatewayPort === "number" ? p.gatewayPort : undefined,
        fullPage: p.fullPage === true,
        runId: runIdFromSessionKey(opts?.agentSessionKey) ?? null,
      });
      return jsonResult({
        ok: res.ok,
        screenshots: res.screenshots,
        crops: res.crops,
        outDir: res.outDir,
        report: res.reportPath,
        assessment: res.assessment,
        consoleErrors: res.consoleErrors,
        failedRpcs: res.failedRpcs,
        perShot: res.shots.map((s) => ({
          route: s.route,
          viewport: s.viewport,
          theme: s.theme,
          path: s.path,
          error: s.error,
          consoleErrors: s.consoleErrors.slice(0, 5),
          pageErrors: s.pageErrors.slice(0, 3),
          failedRpcs: s.failedRpcs.slice(0, 5),
        })),
        error: res.error,
        next: "List these screenshot paths in RESULT.screenshots and claim them with evidence_type 'screenshot'.",
      });
    },
  };
}
