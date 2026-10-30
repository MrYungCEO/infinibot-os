/**
 * verification.* RPCs — verified completion (docs/principles/VERIFIED-COMPLETION.md).
 *
 * Read:
 *   verification.contract   RESULT JSON schema + the injected prompt text
 *   verification.list       completion records (filter by requester / state)
 *   verification.get        one record (attempts, RESULT, review, evidence)
 *   verification.events     cursor-based completion events
 *   verification.wait       block (≤110s over RPC) until runs are terminal
 *   verification.screenshots.list  UI-verification screenshot gallery (filters + paging)
 *   review.thread.get       the worker ↔ Auditor review conversation of one run
 *   review.threads.list     recent review conversations (mesh map / activity feed)
 * Write:
 *   verification.decide     operator Continue / Retry / Accept / Reject
 *   verification.review     re-run the evidence review for a run now
 *   verification.visual     run the visual_verify harness
 *   verification.start      open a record for a run an external pipeline manages
 *   verification.submit     hand an exited attempt to the pipeline (classify → review → terminal)
 *
 * `start` + `submit` + `wait`/`events` are the integration points for
 * pipelines that spawn their own agents (scheduled agent tasks, goal runs).
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { COMPLETION_CONTRACT_PROMPT, RESULT_JSON_SCHEMA } from "../../verification/contract.js";
import { classifyExit } from "../../verification/classifier.js";
import {
  applyDecision,
  reReviewRecord,
  superviseRunExit,
  type ContinuationSpawner,
} from "../../verification/pipeline.js";
import {
  createRecord,
  currentCursor,
  getRecord,
  listEvents,
  listRecords,
  waitForRuns,
  type CompletionRecord,
  type CompletionState,
} from "../../verification/store.js";
import { digestTranscript } from "../../verification/transcript.js";
import {
  REVIEWER_AGENT,
  getReviewThread,
  listReviewThreads,
} from "../../verification/review-thread.js";
import { listScreenshots } from "../../verification/screenshot-index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const log = createSubsystemLogger("gateway/verification");

export const VERIFICATION_READ_METHODS = [
  "verification.contract",
  "verification.list",
  "verification.get",
  "verification.events",
  "verification.wait",
  "verification.screenshots.list",
  "review.thread.get",
  "review.threads.list",
] as const;

export const VERIFICATION_WRITE_METHODS = [
  "verification.decide",
  "verification.review",
  "verification.visual",
  "verification.start",
  "verification.submit",
] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : undefined;
}

function bad(respond: RespondFn, message: string): void {
  respond(false, undefined, { code: "INVALID_PARAMS", message });
}

/** Resume spawner for a record whose run came from a coder CLI backend. */
export async function spawnerForRecord(rec: CompletionRecord): Promise<ContinuationSpawner | null> {
  const backend = rec.backend;
  if (
    backend !== "claude-code" &&
    backend !== "codex" &&
    backend !== "opencode" &&
    backend !== "gemini" &&
    backend !== "grok"
  ) {
    return null;
  }
  const { buildCoderContinuationSpawner } = await import("../../verification/coder-integration.js");
  return buildCoderContinuationSpawner({
    runId: rec.runId,
    backend,
    workdir: rec.workdir ?? process.cwd(),
    model: rec.model,
    env: {
      INFINIBOT_SUBAGENT_RUN_ID: rec.runId,
      INFINIBOT_SUBAGENT_SESSION_KEY: rec.childSessionKey,
      INFINIBOT_PARENT_SESSION_KEY: rec.requesterSessionKey,
    },
    // Only used for a fresh session (Retry without a resumable session).
    systemPrompt: COMPLETION_CONTRACT_PROMPT,
  });
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export const verificationHandlers: GatewayRequestHandlers = {
  "review.thread.get": ({ params, respond }) => {
    const runId = str((params as Record<string, unknown>)?.runId);
    if (!runId) return bad(respond, "runId is required");
    const thread = getReviewThread(runId);
    if (!thread) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `no completion record for ${runId}`,
      });
      return;
    }
    respond(true, thread);
  },

  "review.threads.list": ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const threads = listReviewThreads({
      limit: Math.min(200, Math.max(1, num(p.limit) ?? 30)),
      since: num(p.since),
      states: strArr(p.states),
      requesterSessionKey: str(p.requesterSessionKey),
      includeEmpty: p.includeEmpty === true,
    });
    respond(true, { threads, reviewer: REVIEWER_AGENT });
  },

  "verification.screenshots.list": ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const verdict = str(p.verdict);
    respond(
      true,
      listScreenshots({
        limit: num(p.limit),
        cursor: num(p.cursor),
        verdict:
          verdict === "pass" || verdict === "fail" || verdict === "unknown" ? verdict : undefined,
        route: str(p.route),
        viewport: str(p.viewport),
        agent: str(p.agent),
        runId: str(p.runId),
        q: str(p.q),
        since: num(p.since),
        until: num(p.until),
      }),
    );
  },

  "verification.contract": ({ respond }) => {
    respond(true, { schema: RESULT_JSON_SCHEMA, prompt: COMPLETION_CONTRACT_PROMPT });
  },

  "verification.list": ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const records = listRecords({
      requesterSessionKey: str(p.requesterSessionKey),
      states: strArr(p.states) as CompletionState[] | undefined,
      limit: typeof p.limit === "number" ? Math.min(500, Math.max(1, p.limit)) : 100,
    });
    respond(true, { records, cursor: currentCursor() });
  },

  "verification.get": ({ params, respond }) => {
    const runId = str((params as Record<string, unknown>)?.runId);
    if (!runId) return bad(respond, "runId is required");
    const record = getRecord(runId);
    if (!record) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `no completion record for ${runId}`,
      });
      return;
    }
    respond(true, { record });
  },

  "verification.events": ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const res = listEvents({
      cursor: typeof p.cursor === "number" ? p.cursor : 0,
      requesterSessionKey: str(p.requesterSessionKey),
      runIds: strArr(p.runIds),
      types: p.terminalOnly === true ? ["run.terminal"] : undefined,
      limit: typeof p.limit === "number" ? Math.min(500, Math.max(1, p.limit)) : 100,
    });
    respond(true, res);
  },

  "verification.wait": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runIds = strArr(p.runIds) ?? [];
    if (runIds.length === 0) return bad(respond, "runIds is required");
    const timeoutSec = Math.max(
      0,
      Math.min(110, typeof p.timeoutSec === "number" ? p.timeoutSec : 30),
    );
    const res = await waitForRuns({
      runIds,
      mode: p.mode === "any" ? "any" : "all",
      timeoutMs: timeoutSec * 1000,
    });
    respond(true, { ...res, cursor: currentCursor() });
  },

  "verification.decide": async ({ params, respond, client }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p.runId);
    const action = str(p.action);
    if (!runId) return bad(respond, "runId is required");
    if (action !== "continue" && action !== "retry" && action !== "accept" && action !== "reject") {
      return bad(respond, "action must be continue | retry | accept | reject");
    }
    const rec = getRecord(runId);
    if (!rec) return bad(respond, `no completion record for ${runId}`);
    const spawner =
      action === "continue" || action === "retry" ? await spawnerForRecord(rec) : null;
    const res = await applyDecision({
      runId,
      action,
      by: str(p.by) ?? client?.authUser ?? client?.saasEmail ?? "control-ui",
      note: str(p.note),
      spawnContinuation: spawner,
    });
    if (!res.ok) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: res.error ?? "decision failed",
      });
      return;
    }
    respond(true, { record: res.record });
  },

  "verification.review": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p.runId);
    if (!runId) return bad(respond, "runId is required");
    const rec = getRecord(runId);
    if (!rec) return bad(respond, `no completion record for ${runId}`);
    try {
      // Works for terminal runs too. settle (default true) moves the record's
      // state to the new verdict; rerun:false skips re-running build/test checks.
      const res = await reReviewRecord(runId, {
        settle: p.settle !== false,
        deps: p.rerun === false ? { rerunCommands: false } : {},
      });
      respond(true, {
        outcome: res?.outcome,
        before: res?.before,
        after: res?.after,
        record: getRecord(runId),
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "verification.visual": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const routes = strArr(p.routes) ?? [];
    if (routes.length === 0) return bad(respond, "routes is required");
    try {
      const { runVisualVerify } = await import("../../verification/visual/index.js");
      const res = await runVisualVerify({ ...(p as object), routes } as Parameters<
        typeof runVisualVerify
      >[0]);
      respond(true, res);
    } catch (err) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "verification.start": ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p.runId);
    const task = str(p.task);
    if (!runId || !task) return bad(respond, "runId and task are required");
    const tags =
      p.tags && typeof p.tags === "object"
        ? Object.fromEntries(
            Object.entries(p.tags as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    const workdir = str(p.workdir) ?? null;
    void import("../../verification/evidence.js").then(({ gitHead }) => {
      const record = createRecord({
        runId,
        childSessionKey: str(p.childSessionKey) ?? `external:${runId}`,
        requesterSessionKey: str(p.requesterSessionKey) ?? "external",
        label: str(p.label) ?? task.slice(0, 80),
        task,
        backend: str(p.backend) ?? null,
        model: str(p.model) ?? null,
        workdir,
        baseCommit: str(p.baseCommit) ?? gitHead(workdir),
        maxContinuations: typeof p.maxContinuations === "number" ? p.maxContinuations : undefined,
        tags,
      });
      respond(true, { record });
    });
  },

  "verification.submit": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const runId = str(p.runId);
    if (!runId) return bad(respond, "runId is required");
    const rec = getRecord(runId);
    if (!rec)
      return bad(respond, `no completion record for ${runId} — call verification.start first`);
    const exitCode = typeof p.exitCode === "number" ? p.exitCode : p.exitCode === null ? null : 0;
    const rawOutput = typeof p.rawOutput === "string" ? p.rawOutput : "";
    const finalText = typeof p.finalText === "string" ? p.finalText : "";
    const allowContinue = p.continue !== false;
    const spawner = allowContinue ? await spawnerForRecord(rec) : null;
    // Preview the classification synchronously so callers see it even when
    // the pipeline goes on to continue the run in the background.
    const preview = classifyExit({
      exitCode,
      digest: digestTranscript(rawOutput || finalText),
      extraText: finalText,
    });
    const run = superviseRunExit({
      runId,
      outcome: {
        exitCode,
        rawOutput,
        outputText: finalText,
        sessionId: str(p.sessionId) ?? null,
      },
      spawnContinuation: spawner,
    });
    if (p.wait === true) {
      const final = await run;
      respond(true, { classification: preview.kind, record: final });
      return;
    }
    run.catch((err) => log.warn("verification.submit pipeline error", { runId, err: String(err) }));
    respond(true, { classification: preview.kind, accepted: true });
  },
};
