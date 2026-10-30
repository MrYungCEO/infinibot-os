/**
 * Backend-agnostic phase runner — ONE way to run a queue phase attempt on any
 * agent:
 *
 *   CLI (claude-code | codex | opencode | gemini)
 *     createCoderBackend(id).spawnBackground()   ← the shared coder-backend layer
 *       · durable tmux session (`durableRunId`) → survives gateway restarts
 *       · completion contract via systemPrompt  (COMPLETION_CONTRACT_PROMPT)
 *       · verification record opened before launch (HEAD = evidence baseline)
 *       · same-session resume via LaunchOptions.resumeSessionId
 *         (claude --resume · codex exec resume · opencode --session · gemini -r)
 *       · registered in the subagent registry → map / terminals / restart reattach
 *     on exit → superviseRunExit(): classify → auto-continue premature exits on
 *       the SAME session → evidence + LLM review → terminal verdict.
 *
 *   Gateway agent (any agents.list id)
 *     sessions.spawn (contract appended by buildSubagentSystemPrompt; the
 *     registry reviews it on exit via reviewFinishedRun); resume = `agent` RPC
 *     on the same session key.
 *
 * The runner never decides phase success — it reports the verification
 * verdict; the orchestrator combines it with the phase gate.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { QueueCliBackend } from "./types.js";
import type { ResolvedAgent } from "./backends.js";
import { durableRunDir } from "../agents/coder-backend/durable-spawn.js";

const log = createSubsystemLogger("queue.runner");

export interface PhaseStartParams {
  /** Reserved by the orchestrator BEFORE the spawn (exactly-once recovery). */
  runId: string;
  entryId: string;
  phaseIdx: number;
  target: ResolvedAgent;
  /** Already mapped for the backend (mapModelForBackend). */
  model?: string;
  prompt: string;
  /** Completion contract + queue context (fresh sessions only). */
  systemPrompt: string;
  workdir: string;
  /** CLI session id / gateway session key to continue. */
  resumeSessionId?: string | null;
  timeoutSec: number;
  label: string;
  /** Final W5 decision (resolveCoderAutoApprove) — false never emits the bypass flag. */
  autoApprove: boolean;
  /**
   * Evidence baseline for the verification review: the commit the PHASE
   * started from (first attempt), so a retry that finishes work committed by
   * an earlier attempt is reviewed against the whole phase diff.
   */
  baseCommit?: string | null;
}

export type AttemptPoll =
  | { state: "running"; sessionId?: string | null; lastOutputAt?: number | null }
  | {
      state: "settled";
      exitCode: number | null;
      /** Verified-completion terminal state (verified | unverified | failed | stalled | …), null when verification is off. */
      verdict: string | null;
      reasons: string[];
      sessionId: string | null;
      /** RESULT.status reported by the agent (done | blocked | needs_input). */
      resultStatus?: string | null;
      openIssues?: string[];
      summary?: string | null;
      /** The CLI failed to authenticate (401 / not logged in) — not the agent's fault. */
      authError?: string | null;
      /** The model is retired / unknown / out of quota — pick another model or agent. */
      modelError?: string | null;
    }
  | { state: "missing"; reason: string };

export interface PhaseRunner {
  start(p: PhaseStartParams): Promise<{ sessionId?: string | null }>;
  poll(runId: string, target: ResolvedAgent): Promise<AttemptPoll>;
  /** Stop the attempt and its whole process tree. Idempotent. */
  kill(runId: string, target: ResolvedAgent, reason: string): Promise<void>;
  output(
    runId: string,
    target: ResolvedAgent,
    maxChars?: number,
  ): Promise<{ text: string; source: "durable" | "session" | "none"; tmuxAttach?: string }>;
}

// ── process-tree kill ───────────────────────────────────────────────────────

/** Every descendant pid of `root` (children first → deepest last). */
export function descendantPids(root: number): number[] {
  let table: Array<[number, number]> = [];
  try {
    table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 })
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

function signal(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the tree rooted at `pids`, then SIGKILL survivors after `graceMs`. */
export async function killTree(rootPids: number[], graceMs = 3_000): Promise<number[]> {
  const all = [...new Set(rootPids.flatMap((p) => [p, ...descendantPids(p)]))];
  signal(all, "SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until && all.some(alive)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const survivors = all.filter(alive);
  signal(survivors, "SIGKILL");
  return all;
}

// ── production runner ───────────────────────────────────────────────────────

interface LiveCli {
  backend: QueueCliBackend;
  pid?: number;
  kill: (sig?: NodeJS.Signals) => void;
  sessionId: string | null;
  exited: boolean;
  supervising: boolean;
  lastOutputAt: number;
  /** Raw stdout for non-durable runs (durable runs read stdout.log). */
  raw: { push(chunk: string): void; toString(): string };
  /** Last stderr bytes (auth-error detection for non-durable runs). */
  errTail: string;
}

const REQUESTER_SESSION_KEY = "agent:main:queue";
/** Grace after a durable process died before the queue supervises it itself. */
const SELF_SUPERVISE_GRACE_MS = 90_000;
/** Grace for a finished gateway-agent run to get its verification record. */
const AGENT_REVIEW_GRACE_MS = 120_000;

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readTail(file: string, bytes: number): string {
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
  } catch {
    return "";
  }
}

export interface PhaseRunnerOptions {
  /** Verification pipeline deps (tests: stub judge / delivery / command re-runs). */
  pipelineDeps?: import("../verification/pipeline.js").PipelineDeps;
}

/**
 * Auth failures of a coding CLI (expired / missing login, bad key). Detected
 * from the attempt output so the queue blocks with a login fix instead of
 * burning retries on an agent that can never start.
 */
const AUTH_ERROR_RE =
  /(\b401\b[^\n]{0,80}unauthori[sz]ed|unauthori[sz]ed[^\n]{0,40}\b401\b|missing bearer|not logged in|please (?:run|use) [`'"]?\w+ (?:auth )?login|authentication (?:failed|required)|invalid (?:api[ _-]?key|x-api-key|authentication)|oauth token (?:has )?expired|api key not valid)/i;

const MODEL_ERROR_RE =
  /(model[^\n]{0,120}(?:was retired|has been (?:retired|deprecated)|not found|does not exist|is not (?:available|supported))|\b\S+ was retired at\b|unknown model|invalid model|model_not_found|insufficient_quota|usage credits[^\n]{0,60}(?:failed|exhausted)|credit balance is too low|add usage credits|\b402\b[^\n]{0,40}payment required|or newer is required to use)/i;

function firstMatchLine(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  if (!m) return null;
  const line = text.slice(Math.max(0, text.lastIndexOf("\n", m.index) + 1)).split("\n")[0] ?? m[0];
  return line.trim().slice(0, 300);
}

/** Retired / unknown model or exhausted credits — retrying the same model can't help. */
export function detectModelError(text: string): string | null {
  return firstMatchLine(MODEL_ERROR_RE, text);
}

export function detectAuthError(text: string): string | null {
  const m = AUTH_ERROR_RE.exec(text);
  if (!m) return null;
  const line = text.slice(Math.max(0, text.lastIndexOf("\n", m.index) + 1)).split("\n")[0] ?? m[0];
  return line.trim().slice(0, 300);
}

function durableTail(key: string): string {
  const dir = durableRunDir(key);
  return `${readTail(path.join(dir, "stderr.log"), 16 * 1024)}\n${readTail(path.join(dir, "stdout.log"), 16 * 1024)}`;
}

/** How long a finished CLI attempt's (trimmed) status entry is kept. */
export const PHASE_FINISHED_RUN_RETENTION_MS = 6 * 60 * 60_000;
/** Gateway-agent run metadata older than this is dropped. */
export const PHASE_AGENT_RUN_RETENTION_MS = 48 * 60 * 60_000;
const FINISHED_RAW_TAIL_CHARS = 32 * 1024;

export function createPhaseRunner(opts: PhaseRunnerOptions = {}): PhaseRunner {
  const live = new Map<string, LiveCli>();
  const killed = new Set<string>();
  const selfSupervising = new Set<string>();
  const agentRuns = new Map<string, { sessionKey: string; startedAt: number; endedAt?: number }>();

  const pruneAgentRuns = () => {
    const cutoff = Date.now() - PHASE_AGENT_RUN_RETENTION_MS;
    for (const [id, meta] of agentRuns) if (meta.startedAt < cutoff) agentRuns.delete(id);
  };

  /**
   * After supervision: drop the closure over the backend session (it retains
   * the process's entire stdout, tens of MB per coder run), keep only the raw
   * tail that poll() scans, and forget the entry after a retention window.
   * Previously every attempt stayed in `live`/`killed` for the process lifetime.
   */
  const releaseFinished = (runId: string, entry: LiveCli) => {
    entry.kill = () => {};
    const tail = entry.raw.toString().slice(-FINISHED_RAW_TAIL_CHARS);
    entry.raw = { push() {}, toString: () => tail };
    const timer = setTimeout(() => {
      if (live.get(runId) !== entry) return;
      live.delete(runId);
      killed.delete(runId);
    }, PHASE_FINISHED_RUN_RETENTION_MS);
    timer.unref?.();
  };

  async function verification() {
    const pipeline = await import("../verification/pipeline.js");
    const store = await import("../verification/store.js");
    const coder = await import("../verification/coder-integration.js");
    return { pipeline, store, coder };
  }

  async function durable() {
    return await import("../agents/coder-backend/durable-spawn.js");
  }

  async function registry() {
    return await import("../agents/subagent-registry.js");
  }

  /**
   * Drive an exited CLI attempt through the verified-completion pipeline and
   * mirror the result into the registry. Used for live runs and as a fallback
   * for durable runs nobody else supervised.
   */
  async function supervise(p: {
    runId: string;
    backend: QueueCliBackend;
    workdir: string;
    model?: string;
    systemPrompt: string;
    timeoutMinutes: number;
    autoApprove: boolean;
    exitCode: number | null;
    killedFlag?: boolean;
    rawOutput?: string;
    outputText?: string;
    sessionId: string | null;
    env: Record<string, string>;
  }): Promise<void> {
    const { pipeline, coder } = await verification();
    const reg = await registry();
    let ok = p.exitCode === 0;
    if (pipeline.isVerificationEnabled()) {
      const spawner = coder.buildCoderContinuationSpawner({
        runId: p.runId,
        backend: p.backend,
        workdir: p.workdir,
        model: p.model ?? null,
        env: p.env,
        timeoutMinutes: p.timeoutMinutes,
        autoApprove: p.autoApprove,
        systemPrompt: p.systemPrompt,
        onSpawned: ({ pid, durableKey }) => {
          const l = live.get(p.runId);
          if (l) l.pid = pid;
          reg.updateSubagentRunContinuation(p.runId, {
            childPid: pid,
            durableKey,
            timeoutMinutes: p.timeoutMinutes,
          });
        },
      });
      const guarded: typeof spawner = async (req) => {
        if (killed.has(p.runId)) {
          return { exitCode: null, killed: true, rawOutput: "", sessionId: req.sessionId };
        }
        return spawner(req);
      };
      const rec = await pipeline.superviseRunExit({
        runId: p.runId,
        outcome: {
          exitCode: p.exitCode,
          killed: p.killedFlag,
          rawOutput: coder.readDurableStdout(p.runId) || p.rawOutput || "",
          outputText: p.outputText,
          sessionId: p.sessionId,
        },
        spawnContinuation: guarded,
        deps: opts.pipelineDeps,
      });
      ok = rec?.state === "verified" || rec?.state === "accepted";
    }
    reg.markSubagentRunComplete(
      p.runId,
      ok ? { status: "ok" } : { status: "error", error: "phase attempt not verified" },
    );
  }

  return {
    async start(p) {
      if (p.target.kind === "agent") {
        const { callGateway } = await import("../gateway/call.js");
        if (p.resumeSessionId) {
          const res = (await callGateway({
            method: "agent",
            params: {
              message: p.prompt,
              sessionKey: p.resumeSessionId,
              idempotencyKey: p.runId,
              deliver: false,
              lane: "subagent",
            },
            timeoutMs: 30_000,
          })) as { runId?: string };
          const id = res?.runId || p.runId;
          pruneAgentRuns();
          agentRuns.set(p.runId, { sessionKey: p.resumeSessionId, startedAt: Date.now() });
          if (id !== p.runId)
            agentRuns.set(id, { sessionKey: p.resumeSessionId, startedAt: Date.now() });
          return { sessionId: p.resumeSessionId };
        }
        const res = (await callGateway({
          method: "sessions.spawn",
          params: {
            task: p.prompt,
            agentId: p.target.agentId,
            label: p.label,
            ...(p.model ? { model: p.model } : {}),
            cwd: p.workdir,
            runTimeoutSeconds: p.timeoutSec,
          },
          timeoutMs: 60_000,
        })) as { runId?: string; childSessionKey?: string; error?: string };
        if (!res?.runId || !res.childSessionKey) {
          throw new Error(res?.error ?? "sessions.spawn returned no runId");
        }
        pruneAgentRuns();
        agentRuns.set(p.runId, { sessionKey: res.childSessionKey, startedAt: Date.now() });
        // The gateway picks its own run id; alias ours to it for polling.
        if (res.runId !== p.runId) {
          agentRuns.set(`alias:${p.runId}`, { sessionKey: res.runId, startedAt: Date.now() });
        }
        return { sessionId: res.childSessionKey };
      }

      const backend = p.target.backend;
      const { createCoderBackend } = await import("../agents/coder-backend/registry.js");
      const { pipeline, coder } = await verification();
      const dur = await durable();
      const reg = await registry();
      const { getStreamParser } = await import("../agents/coder-runtime/stream-parsers.js");
      const useDurable = dur.isDurableSpawnEnabled();
      const timeoutMinutes = Math.max(1, Math.ceil(p.timeoutSec / 60));
      const childSessionKey = `agent:queue:phase:${p.runId}`;
      const env: Record<string, string> = {
        INFINIBOT_SUBAGENT_RUN_ID: p.runId,
        INFINIBOT_SUBAGENT_SESSION_KEY: childSessionKey,
        INFINIBOT_PARENT_SESSION_KEY: REQUESTER_SESSION_KEY,
        INFINIBOT_QUEUE_ENTRY_ID: p.entryId,
        INFINIBOT_QUEUE_PHASE: String(p.phaseIdx + 1),
      };
      const startedAt = Date.now();
      if (pipeline.isVerificationEnabled()) {
        const { createRecord } = await import("../verification/store.js");
        const { gitHead } = await import("../verification/evidence.js");
        createRecord({
          runId: p.runId,
          childSessionKey,
          requesterSessionKey: REQUESTER_SESSION_KEY,
          label: p.label,
          task: p.prompt,
          backend,
          model: p.model ?? null,
          workdir: p.workdir,
          startedAt,
          baseCommit: p.baseCommit ?? gitHead(p.workdir),
          maxContinuations: Number(process.env.INFINIBOT_VERIFY_MAX_CONTINUATIONS) || undefined,
          tags: { queueEntryId: p.entryId, queuePhase: String(p.phaseIdx + 1) },
        });
      }
      const bg = createCoderBackend(backend).spawnBackground(
        {
          id: p.runId,
          name: "queue-phase",
          type: "cli",
          cliCommand: coder.cliCommandFor(backend),
          autoApprove: p.autoApprove,
          timeoutMinutes,
          enabledMCPs: [],
          env,
        } as never,
        p.prompt,
        p.workdir,
        {
          runId: p.runId,
          env,
          model: p.model,
          resumeSessionId: p.resumeSessionId ?? undefined,
          // Always: claude --append-system-prompt and opencode instructions are
          // per-invocation, so a resumed session would otherwise lose the contract.
          systemPrompt: p.systemPrompt,
          durableRunId: useDurable ? p.runId : undefined,
        },
      );
      const entry: LiveCli = {
        backend,
        pid: bg.pid,
        kill: (sig) => bg.kill(sig ?? "SIGTERM"),
        sessionId: p.resumeSessionId ?? null,
        exited: false,
        supervising: false,
        lastOutputAt: Date.now(),
        raw: new coder.RawOutputBuffer(),
        errTail: "",
      };
      live.set(p.runId, entry);
      const parse = getStreamParser(backend);
      let pending = "";
      bg.onStdout((chunk: string) => {
        entry.lastOutputAt = Date.now();
        if (!useDurable) entry.raw.push(chunk);
        pending += chunk;
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const line of parts) {
          try {
            const f = parse(line.trim());
            if (f?.claudeSessionId && f.claudeSessionId !== entry.sessionId) {
              entry.sessionId = f.claudeSessionId;
              reg.updateSubagentRunClaudeSessionId(p.runId, f.claudeSessionId);
            }
          } catch {
            /* non-json line */
          }
        }
      });
      bg.onStderr((chunk: string) => {
        entry.lastOutputAt = Date.now();
        entry.errTail = (entry.errTail + chunk).slice(-16 * 1024);
      });
      try {
        reg.registerSubagentRunForCoder({
          runId: p.runId,
          childSessionKey,
          requesterSessionKey: REQUESTER_SESSION_KEY,
          requesterDisplayKey: REQUESTER_SESSION_KEY,
          task: p.prompt,
          label: p.label,
          childPid: bg.pid,
          timeoutMinutes,
          workdir: p.workdir,
          coderBackend: backend,
          durableSpawn: useDurable ? "tmux-coder" : undefined,
          terminalId: useDurable ? dur.durableTerminalId(p.runId) : undefined,
        });
      } catch (err) {
        log.warn("registry registration failed", { runId: p.runId, error: String(err) });
      }
      bg.finalPromise
        .then(async (info) => {
          entry.exited = true;
          if (info.sessionId && !entry.sessionId) entry.sessionId = info.sessionId;
          if (killed.has(p.runId)) return;
          entry.supervising = true;
          await supervise({
            runId: p.runId,
            backend,
            workdir: p.workdir,
            model: p.model,
            systemPrompt: p.systemPrompt,
            timeoutMinutes,
            autoApprove: p.autoApprove,
            exitCode: info.exitCode,
            killedFlag: info.killed,
            rawOutput: entry.raw.toString(),
            outputText: info.output,
            sessionId: entry.sessionId,
            env,
          });
        })
        .catch((err: unknown) => {
          entry.exited = true;
          log.warn("phase attempt supervision failed", { runId: p.runId, error: String(err) });
        })
        .finally(() => {
          entry.supervising = false;
          releaseFinished(p.runId, entry);
        });
      return { sessionId: entry.sessionId };
    },

    async poll(runId, target) {
      const { pipeline, store } = await verification();
      const rec = store.getRecord(runId);
      const verifying = pipeline.isVerificationEnabled();
      const settledFrom = (r: NonNullable<typeof rec>): AttemptPoll => {
        const last = r.attempts[r.attempts.length - 1];
        const ok = r.state === "verified" || r.state === "accepted";
        const scan =
          !ok && target.kind === "cli"
            ? [
                ...r.attempts.flatMap((a) => a.reasons ?? []),
                ...r.attempts.map((a) => (a.durableKey ? durableTail(a.durableKey) : "")),
                durableTail(runId),
                live.get(runId)?.errTail ?? "",
                (live.get(runId)?.raw.toString() ?? "").slice(-32 * 1024),
              ].join("\n")
            : "";
        const authError = scan ? detectAuthError(scan) : null;
        const modelError = scan && !authError ? detectModelError(scan) : null;
        return {
          authError,
          modelError,
          state: "settled",
          exitCode: last?.exitCode ?? null,
          verdict: r.state,
          reasons: r.review?.reasons?.length ? r.review.reasons : (last?.reasons ?? []),
          sessionId: [...r.attempts].reverse().find((a) => a.sessionId)?.sessionId ?? null,
          resultStatus: r.result?.status ?? null,
          openIssues: r.result?.open_issues ?? [],
          summary: r.result?.summary ?? null,
        };
      };
      if (rec && store.isTerminal(rec)) return settledFrom(rec);

      if (target.kind === "agent") {
        const reg = await registry();
        const alias = agentRuns.get(`alias:${runId}`)?.sessionKey;
        const gwRunId = alias ?? runId;
        const aliasRec = alias ? store.getRecord(alias) : undefined;
        if (aliasRec && store.isTerminal(aliasRec)) return settledFrom(aliasRec);
        const r = reg.getSubagentRun(gwRunId);
        const meta = agentRuns.get(runId);
        if (r) {
          if (reg.isSubagentRunActive(r)) return { state: "running", sessionId: r.childSessionKey };
          const endedAt = r.endedAt ?? Date.now();
          if (verifying && Date.now() - endedAt < AGENT_REVIEW_GRACE_MS) {
            return { state: "running", sessionId: r.childSessionKey };
          }
          return {
            state: "settled",
            exitCode: r.outcome?.status === "ok" ? 0 : 1,
            verdict: null,
            reasons: r.outcome?.error ? [r.outcome.error] : [],
            sessionId: r.childSessionKey,
          };
        }
        const { callGateway } = await import("../gateway/call.js");
        const wait = (await callGateway({
          method: "agent.wait",
          params: { runId: gwRunId, timeoutMs: 0 },
          timeoutMs: 10_000,
        }).catch(() => null)) as { status?: string } | null;
        if (wait?.status === "ok" || wait?.status === "error") {
          return {
            state: "settled",
            exitCode: wait.status === "ok" ? 0 : 1,
            verdict: null,
            reasons: [],
            sessionId: meta?.sessionKey ?? null,
          };
        }
        if (!meta)
          return { state: "missing", reason: "gateway agent run not found (gateway restarted?)" };
        return { state: "running", sessionId: meta.sessionKey };
      }

      // CLI target
      const dur = await durable();
      const l = live.get(runId);
      const dir = dur.durableRunDir(runId);
      const hasDir = existsSync(dir);
      const lastOutputAt = Math.max(
        mtime(path.join(dir, "stdout.log")),
        mtime(path.join(dir, "stderr.log")),
        l?.lastOutputAt ?? 0,
      );
      // Continuations run under `<runId>-cN` durable keys.
      const contKey = rec?.attempts[rec.attempts.length - 1]?.durableKey ?? runId;
      const processAlive =
        (l && !l.exited) ||
        dur.isDurableRunAlive(runId) ||
        (contKey !== runId && dur.isDurableRunAlive(contKey));
      if (processAlive || l?.supervising || selfSupervising.has(runId)) {
        return { state: "running", sessionId: l?.sessionId ?? null, lastOutputAt };
      }
      if (
        rec &&
        (rec.state === "reviewing" || rec.state === "continuing" || rec.state === "interrupted")
      ) {
        // Pipeline busy (or a boot recheck is pending) — the phase timeout bounds this.
        return { state: "running", sessionId: l?.sessionId ?? null, lastOutputAt };
      }
      const exitFile = path.join(dir, "exit.code");
      const exitCode = existsSync(exitFile)
        ? (() => {
            const n = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
            return Number.isFinite(n) ? n : null;
          })()
        : null;
      if (!verifying) {
        if (hasDir && existsSync(exitFile)) {
          return {
            state: "settled",
            exitCode,
            verdict: null,
            reasons: [],
            sessionId: l?.sessionId ?? null,
          };
        }
        if (l?.exited) {
          return {
            state: "settled",
            exitCode: null,
            verdict: null,
            reasons: [],
            sessionId: l.sessionId,
          };
        }
        return hasDir && Date.now() - mtime(dir) < 10_000
          ? { state: "running" }
          : { state: "missing", reason: "agent process is gone and left no exit code" };
      }
      if (!rec) {
        return hasDir && Date.now() - mtime(dir) < 10_000
          ? { state: "running" }
          : { state: "missing", reason: "no verification record and no live process" };
      }
      // Process gone, record not terminal, nobody in this process supervising.
      // The subagent registry supervises durable runs it recovered on boot;
      // give it a grace window, then supervise ourselves (exactly once).
      const reg = await registry();
      const regRun = reg.getSubagentRun(runId);
      const exitedAt = Math.max(mtime(exitFile), lastOutputAt) || rec.updatedAt;
      const registryOwns = regRun && reg.isSubagentRunActive(regRun);
      if (registryOwns && Date.now() - exitedAt < SELF_SUPERVISE_GRACE_MS) {
        return { state: "running", lastOutputAt };
      }
      if (Date.now() - exitedAt < 5_000) return { state: "running", lastOutputAt };
      if (!hasDir && !l) {
        return { state: "missing", reason: "agent process never started or its run dir vanished" };
      }
      selfSupervising.add(runId);
      const backend = target.backend;
      log.info("self-supervising orphaned phase attempt", { runId, exitCode });
      void supervise({
        runId,
        backend,
        workdir: rec.workdir ?? process.cwd(),
        model: rec.model ?? undefined,
        systemPrompt: "",
        timeoutMinutes: 30,
        autoApprove: true,
        exitCode,
        sessionId: l?.sessionId ?? regRun?.claudeSessionId ?? null,
        env: { INFINIBOT_SUBAGENT_RUN_ID: runId },
      })
        .catch((err) => log.warn("self-supervision failed", { runId, error: String(err) }))
        .finally(() => selfSupervising.delete(runId));
      return { state: "running", lastOutputAt };
    },

    async kill(runId, target, reason) {
      killed.add(runId);
      const { store } = await verification();
      if (target.kind === "agent") {
        const { callGateway } = await import("../gateway/call.js");
        const gwRunId = agentRuns.get(`alias:${runId}`)?.sessionKey ?? runId;
        await callGateway({
          method: "subagents.stop",
          params: { runId: gwRunId },
          timeoutMs: 10_000,
        }).catch(() => {});
        const sessionKey = agentRuns.get(runId)?.sessionKey;
        if (sessionKey) {
          await callGateway({
            method: "agent.abort",
            params: { sessionKey },
            timeoutMs: 10_000,
          }).catch(() => {});
        }
      } else {
        const dur = await durable();
        const rec = store.getRecord(runId);
        const keys = new Set<string>([runId]);
        for (const a of rec?.attempts ?? []) if (a.durableKey) keys.add(a.durableKey);
        const roots: number[] = [];
        const l = live.get(runId);
        if (l?.pid) roots.push(l.pid);
        const { resolveTmuxSocketName } = await import("../terminal/tmux-socket.js");
        for (const key of keys) {
          try {
            const out = execFileSync(
              "tmux",
              [
                "-L",
                resolveTmuxSocketName(),
                "list-panes",
                "-t",
                dur.durableTmuxSession(key),
                "-F",
                "#{pane_pid}",
              ],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
            );
            for (const pid of out
              .split("\n")
              .map(Number)
              .filter((n) => n > 0))
              roots.push(pid);
          } catch {
            /* no such session */
          }
        }
        const pids = await killTree(roots);
        for (const key of keys) dur.killDurableRun(key);
        try {
          l?.kill("SIGKILL");
        } catch {
          /* gone */
        }
        log.info("killed phase attempt process tree", { runId, reason, pids: pids.length });
      }
      // Settle the verification record so neither the pipeline nor the
      // registry's restart recovery resumes a run the queue stopped.
      try {
        const rec = store.getRecord(runId);
        if (rec && !store.isTerminal(rec)) {
          store.markTerminal(runId, "failed", {
            summary: `stopped by the queue: ${reason}`,
            reasons: [reason],
          });
        }
      } catch {
        /* best effort */
      }
      try {
        const reg = await registry();
        reg.markSubagentRunComplete(runId, {
          status: "error",
          error: `stopped by queue: ${reason}`,
        });
      } catch {
        /* best effort */
      }
    },

    async output(runId, target, maxChars = 20_000) {
      if (target.kind === "agent") {
        const sessionKey =
          agentRuns.get(runId)?.sessionKey ??
          (await registry()).getSubagentRun(agentRuns.get(`alias:${runId}`)?.sessionKey ?? runId)
            ?.childSessionKey;
        if (!sessionKey) return { text: "", source: "none" };
        try {
          const { readLatestAssistantReply } = await import("../agents/tools/agent-step.js");
          const text = (await readLatestAssistantReply({ sessionKey })) ?? "";
          return { text: text.slice(-maxChars), source: "session" };
        } catch {
          return { text: "", source: "none" };
        }
      }
      const dur = await durable();
      const { store } = await verification();
      const { parseCoderStream } = await import("../autonomy/goals/executor.js");
      const rec = store.getRecord(runId);
      const keys = [
        runId,
        ...(rec?.attempts ?? [])
          .map((a) => a.durableKey)
          .filter((k): k is string => Boolean(k) && k !== runId),
      ];
      const parts: string[] = [];
      for (const key of [...new Set(keys)]) {
        const dir = dur.durableRunDir(key);
        if (!existsSync(dir)) continue;
        const text = parseCoderStream(
          target.backend,
          readTail(path.join(dir, "stdout.log"), 512 * 1024),
        ).text;
        const err = readTail(path.join(dir, "stderr.log"), 32 * 1024)
          .split("\n")
          .filter((line) => line.trim() && line.length < 400)
          .slice(-15)
          .join("\n");
        parts.push(
          [
            key !== runId ? `## continuation ${key}` : `## attempt ${key}`,
            err ? `### stderr (tail)\n${err}` : "",
            text,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
      if (!parts.length) return { text: "", source: "none" };
      const { resolveTmuxSocketName } = await import("../terminal/tmux-socket.js");
      const lastKey = keys[keys.length - 1];
      const aliveKey = [...keys].reverse().find((k) => dur.isDurableRunAlive(k));
      return {
        text: parts.join("\n\n").slice(-maxChars),
        source: "durable",
        ...(aliveKey
          ? {
              tmuxAttach: `tmux -L ${resolveTmuxSocketName()} attach -t ${dur.durableTmuxSession(aliveKey ?? lastKey)}`,
            }
          : {}),
      };
    },
  };
}
