/**
 * Production {@link GoalExecutor}.
 *
 * CLI targets (claude-code | codex | opencode | gemini) go through the same
 * `createCoderBackend(id).spawnBackground()` path as `claude_coder`, with
 * `durableRunId` so the process lives in a detached tmux session
 * (state-scoped socket, `infinibot_spawn_<runId>`) and survives gateway restarts.
 * Status after a restart is read straight from the durable run dir
 * (tmux liveness + `exit.code` + log mtimes), so no in-memory handle is
 * required. Runs are also registered in the subagent registry, which makes
 * them visible in subagents.list / the agent map / terminal attach.
 *
 * Gateway-agent targets (any id from agents.list) use `sessions.spawn` for the
 * first iteration and the `agent` RPC on the same session key to resume.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { callGateway } from "../../gateway/call.js";
import { createCoderBackend } from "../../agents/coder-backend/registry.js";
import type { CoderBackendId, BackgroundSession } from "../../agents/coder-backend/types.js";
import {
  durableRunDir,
  durableTerminalId,
  isDurableRunAlive,
  isDurableSpawnEnabled,
  killDurableRun,
} from "../../agents/coder-backend/durable-spawn.js";
import { getStreamParser } from "../../agents/coder-runtime/stream-parsers.js";
import {
  getSubagentRun,
  isSubagentRunActive,
  markSubagentRunComplete,
  registerSubagentRunForCoder,
  updateSubagentRunClaudeSessionId,
} from "../../agents/subagent-registry.js";
import { getProgress } from "../../agents/subagent-progress.js";
import type { GoalAgentTarget } from "./types.js";
import type { ExecutorStatus, GoalExecutor } from "./runner.js";

const log = createSubsystemLogger("autonomy.goals.exec");
const REQUESTER_SESSION_KEY = "agent:main:goal-runner";
const TAIL_BYTES = 256 * 1024;

interface LiveCli {
  /** The live backend session; swapped for a stub once the process exits. */
  bg: Pick<BackgroundSession, "startedAt" | "kill">;
  backend: CoderBackendId;
  buffer: string;
  lastOutputAt: number;
  sessionId: string | null;
  exit: { code: number | null } | null;
  durable: boolean;
}

function cliCommandFor(backend: CoderBackendId): string {
  return backend === "opencode"
    ? "opencode"
    : backend === "codex"
      ? "codex"
      : backend === "gemini"
        ? "gemini"
        : backend === "grok"
          ? "grok"
          : "claude";
}

function readTail(file: string, bytes = TAIL_BYTES): string {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Turn raw NDJSON from a coder backend into readable transcript text + session id. */
export function parseCoderStream(
  backend: CoderBackendId,
  raw: string,
): { text: string; sessionId: string | null } {
  const parse = getStreamParser(backend);
  const lines: string[] = [];
  let sessionId: string | null = null;
  let finalResult = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      try {
        const ev = JSON.parse(t) as Record<string, unknown>;
        if (ev.type === "result" && typeof ev.result === "string") finalResult = ev.result;
      } catch {
        /* not json */
      }
      let f = null;
      try {
        f = parse(t);
      } catch {
        f = null;
      }
      if (f?.claudeSessionId && !sessionId) sessionId = f.claudeSessionId;
      if (f?.transcript) lines.push(f.transcript);
    } else {
      lines.push(t);
    }
  }
  let text = lines.join("\n");
  if (finalResult) text = `${text}\n\n## Final result\n${finalResult}`;
  return { text, sessionId };
}

/** How long a finished CLI run's (small) status entry is kept for polling. */
export const GOAL_FINISHED_RUN_RETENTION_MS = 6 * 60 * 60_000;
/** Gateway-agent run metadata older than this is dropped. */
export const GOAL_AGENT_RUN_RETENTION_MS = 48 * 60 * 60_000;

export function createGoalExecutor(): GoalExecutor {
  const live = new Map<string, LiveCli>();
  /** Gateway-agent runs: runId → session key (+ spawn time for hang fallback). */
  const agentRuns = new Map<string, { sessionKey: string; startedAt: number }>();

  const pruneAgentRuns = () => {
    const cutoff = Date.now() - GOAL_AGENT_RUN_RETENTION_MS;
    for (const [id, meta] of agentRuns) if (meta.startedAt < cutoff) agentRuns.delete(id);
  };

  /**
   * After exit: drop the BackgroundSession (its closures hold the process's
   * entire stdout — tens of MB per coder run) and forget the entry after a
   * retention window. Previously every finished run stayed in `live` forever.
   */
  const releaseFinished = (runId: string, entry: LiveCli) => {
    const startedAt = entry.bg.startedAt;
    entry.bg = { startedAt, kill: () => false };
    const timer = setTimeout(() => {
      if (live.get(runId) === entry) live.delete(runId);
    }, GOAL_FINISHED_RUN_RETENTION_MS);
    timer.unref?.();
  };

  const cliStatus = (runId: string): ExecutorStatus => {
    const l = live.get(runId);
    const dir = durableRunDir(runId);
    const hasDurableDir = existsSync(dir);
    if (l && !l.durable) {
      return {
        state: l.exit ? "exited" : "running",
        exitCode: l.exit?.code ?? null,
        lastOutputAt: l.lastOutputAt,
        sessionId: l.sessionId,
      };
    }
    if (!hasDurableDir) return { state: l ? "running" : "missing" };
    const lastOutputAt = Math.max(
      mtime(path.join(dir, "stdout.log")),
      mtime(path.join(dir, "stderr.log")),
      l?.lastOutputAt ?? 0,
    );
    const exitFile = path.join(dir, "exit.code");
    if (isDurableRunAlive(runId)) {
      return { state: "running", lastOutputAt, sessionId: l?.sessionId ?? null };
    }
    if (existsSync(exitFile)) {
      const n = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
      return { state: "exited", exitCode: Number.isFinite(n) ? n : null, lastOutputAt };
    }
    // Launch script is written before tmux starts; give tmux a moment.
    if (l && Date.now() - l.bg.startedAt < 5_000) return { state: "running", lastOutputAt };
    return { state: "missing", lastOutputAt };
  };

  /** Readable output: parsed stdout transcript last (so tails keep it), short stderr excerpt first. */
  const cliText = (runId: string, backend: CoderBackendId): string => {
    const l = live.get(runId);
    if (l && !l.durable) return parseCoderStream(backend, l.buffer).text;
    const dir = durableRunDir(runId);
    const text = parseCoderStream(backend, readTail(path.join(dir, "stdout.log"))).text;
    const err = readTail(path.join(dir, "stderr.log"), 64 * 1024)
      .split("\n")
      .filter((line) => line.trim() && line.length < 400)
      .slice(-15)
      .join("\n");
    return err ? `## stderr (tail)\n${err}\n\n${text}` : text;
  };

  const backendOf = (target: GoalAgentTarget): CoderBackendId =>
    target.kind === "cli" ? target.backend : "claude-code";

  return {
    supportsResume: () => true,

    async start(p) {
      const runId = `goal-${p.goalId.replace(/^goal_/, "").slice(0, 8)}-${p.iteration}-${randomUUID().slice(0, 6)}`;
      if (p.target.kind === "agent") {
        const agentId = p.target.agentId;
        if (p.resumeSessionId) {
          const res = (await callGateway({
            method: "agent",
            params: {
              message: p.prompt,
              sessionKey: p.resumeSessionId,
              idempotencyKey: runId,
              deliver: false,
              lane: "subagent",
            },
            timeoutMs: 30_000,
          })) as { runId?: string };
          const id = res?.runId || runId;
          pruneAgentRuns();
          agentRuns.set(id, { sessionKey: p.resumeSessionId, startedAt: Date.now() });
          return { runId: id, sessionId: p.resumeSessionId };
        }
        const res = (await callGateway({
          method: "sessions.spawn",
          params: {
            task: p.prompt,
            agentId,
            label: p.label,
            ...(p.target.model ? { model: p.target.model } : {}),
            ...(p.workdir ? { cwd: p.workdir } : {}),
            runTimeoutSeconds: p.timeoutSec,
          },
          timeoutMs: 60_000,
        })) as { runId?: string; childSessionKey?: string; error?: string };
        if (!res?.runId || !res.childSessionKey) {
          throw new Error(res?.error ?? "sessions.spawn returned no runId");
        }
        pruneAgentRuns();
        agentRuns.set(res.runId, { sessionKey: res.childSessionKey, startedAt: Date.now() });
        return { runId: res.runId, sessionId: res.childSessionKey };
      }

      const backend = p.target.backend;
      const workdir = p.workdir && existsSync(p.workdir) ? p.workdir : process.cwd();
      const durable = isDurableSpawnEnabled();
      const timeoutMinutes = Math.max(1, Math.ceil(p.timeoutSec / 60));
      const bg = createCoderBackend(backend).spawnBackground(
        {
          id: runId,
          name: "goal-runner",
          type: "cli",
          cliCommand: cliCommandFor(backend),
          autoApprove: true,
          timeoutMinutes,
          enabledMCPs: [],
        } as never,
        p.prompt,
        workdir,
        {
          runId,
          model: p.target.model || undefined,
          resumeSessionId: p.resumeSessionId ?? undefined,
          durableRunId: durable ? runId : undefined,
          firstOutputTimeoutMs: 0,
        },
      );
      const entry: LiveCli = {
        bg,
        backend,
        buffer: "",
        lastOutputAt: Date.now(),
        sessionId: p.resumeSessionId,
        exit: null,
        durable: durable && existsSync(durableRunDir(runId)),
      };
      live.set(runId, entry);
      const parse = getStreamParser(backend);
      let pending = "";
      bg.onStdout((chunk: string) => {
        entry.lastOutputAt = Date.now();
        if (!entry.durable) {
          entry.buffer += chunk;
          if (entry.buffer.length > TAIL_BYTES * 2) entry.buffer = entry.buffer.slice(-TAIL_BYTES);
        }
        pending += chunk;
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const line of parts) {
          try {
            const f = parse(line.trim());
            if (f?.claudeSessionId && f.claudeSessionId !== entry.sessionId) {
              entry.sessionId = f.claudeSessionId;
              updateSubagentRunClaudeSessionId(runId, f.claudeSessionId);
            }
          } catch {
            /* non-json line */
          }
        }
      });
      bg.onStderr((chunk: string) => {
        entry.lastOutputAt = Date.now();
        if (!entry.durable) entry.buffer += chunk;
      });
      bg.finalPromise
        .then((info) => {
          entry.exit = { code: info.exitCode };
          if (info.sessionId && !entry.sessionId) entry.sessionId = info.sessionId;
          markSubagentRunComplete(runId, {
            status: info.exitCode === 0 ? "ok" : "error",
            error: info.exitCode === 0 ? undefined : `exit ${info.exitCode}`,
          });
        })
        .catch((err: unknown) => {
          entry.exit = { code: null };
          markSubagentRunComplete(runId, { status: "error", error: String(err) });
        })
        .finally(() => releaseFinished(runId, entry));
      try {
        registerSubagentRunForCoder({
          runId,
          childSessionKey: `agent:coder:goal:${runId}`,
          requesterSessionKey: REQUESTER_SESSION_KEY,
          requesterDisplayKey: REQUESTER_SESSION_KEY,
          task: p.prompt,
          label: p.label,
          childPid: bg.pid,
          timeoutMinutes,
          workdir,
          coderBackend: backend,
          durableSpawn: entry.durable ? "tmux-coder" : undefined,
          terminalId: entry.durable ? durableTerminalId(runId) : undefined,
        });
      } catch (err) {
        log.warn("goal run: registry registration failed", { runId, error: String(err) });
      }
      return { runId, sessionId: p.resumeSessionId };
    },

    async status(runId, target) {
      if (target.kind === "cli") {
        const st = cliStatus(runId);
        if (!st.sessionId && st.state !== "missing") {
          const l = live.get(runId);
          if (!l) {
            // After a restart: recover the session id from the log.
            st.sessionId = parseCoderStream(
              target.backend,
              readTail(path.join(durableRunDir(runId), "stdout.log"), 64 * 1024),
            ).sessionId;
          }
        }
        return st;
      }
      const rec = getSubagentRun(runId);
      const progressAt = getProgress(runId)?.lastUpdateAt ?? null;
      if (rec) {
        if (isSubagentRunActive(rec)) return { state: "running", lastOutputAt: progressAt };
        if (rec.interruptedAt && !rec.outcome) return { state: "missing" };
        return { state: "exited", exitCode: rec.outcome?.status === "ok" ? 0 : 1 };
      }
      const wait = (await callGateway({
        method: "agent.wait",
        params: { runId, timeoutMs: 0 },
        timeoutMs: 10_000,
      }).catch(() => null)) as { status?: string } | null;
      if (wait?.status === "ok") return { state: "exited", exitCode: 0 };
      if (wait?.status === "error") return { state: "exited", exitCode: 1 };
      // "timeout" → still running (or unknown after a restart; hang/timeout limits bound it).
      return {
        state: "running",
        lastOutputAt: progressAt ?? agentRuns.get(runId)?.startedAt ?? null,
      };
    },

    async output(runId, target) {
      if (target.kind === "cli") {
        return cliText(runId, backendOf(target)).slice(-12_000);
      }
      const sessionKey = agentRuns.get(runId)?.sessionKey ?? getSubagentRun(runId)?.childSessionKey;
      if (!sessionKey) return "";
      try {
        const { readLatestAssistantReply } = await import("../../agents/tools/agent-step.js");
        return (await readLatestAssistantReply({ sessionKey })) ?? "";
      } catch {
        return "";
      }
    },

    async kill(runId, target) {
      if (target.kind === "cli") {
        const l = live.get(runId);
        try {
          killDurableRun(runId);
        } catch {
          /* not durable */
        }
        try {
          l?.bg.kill("SIGTERM");
        } catch {
          /* already dead */
        }
        markSubagentRunComplete(runId, { status: "error", error: "stopped by goal runner" });
        return;
      }
      await callGateway({ method: "subagents.stop", params: { runId }, timeoutMs: 10_000 }).catch(
        () => {},
      );
      const sessionKey = agentRuns.get(runId)?.sessionKey;
      if (sessionKey) {
        await callGateway({
          method: "agent.abort",
          params: { sessionKey },
          timeoutMs: 10_000,
        }).catch(() => {});
      }
    },
  };
}
