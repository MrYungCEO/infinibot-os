/**
 * Glue between the coder backends (claude_coder / codex_coder /
 * opencode_coder, detach + sync, and restart recovery in the subagent
 * registry) and the verified-completion pipeline.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { durableRunDir, isDurableSpawnEnabled } from "../agents/coder-backend/durable-spawn.js";
import type { CoderBackendId } from "../agents/coder-backend/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { gitHead } from "./evidence.js";
import { isGatewayStopping, isSignalExit } from "./lifecycle.js";
import type { AttemptOutcome, ContinuationRequest, ContinuationSpawner } from "./pipeline.js";
import { createRecord, type CompletionRecord } from "./store.js";

const log = createSubsystemLogger("verification.coder");

/** Cap on raw stdout kept in memory per attempt (tail wins). */
const RAW_CAP = 3 * 1024 * 1024;

export class RawOutputBuffer {
  private chunks: string[] = [];
  private size = 0;
  push(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > RAW_CAP && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  toString(): string {
    return this.chunks.join("");
  }
}

export function startCoderVerification(p: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label: string;
  task: string;
  backend: string;
  model?: string | null;
  workdir: string;
  startedAt: number;
}): CompletionRecord {
  return createRecord({
    ...p,
    baseCommit: gitHead(p.workdir),
    maxContinuations: Number(process.env.INFINIBOT_VERIFY_MAX_CONTINUATIONS) || undefined,
  });
}

/** Read a durable attempt's stdout log (tmux-backed runs). */
export function readDurableStdout(durableKey: string): string {
  try {
    return readFileSync(path.join(durableRunDir(durableKey), "stdout.log"), "utf8");
  } catch {
    return "";
  }
}

export function cliCommandFor(backend: CoderBackendId): string {
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

/**
 * Build a spawner that resumes the SAME backend session in the background
 * (claude --resume / codex exec resume / opencode --session / gemini -r / grok --resume),
 * durable under a per-attempt tmux key, and resolves when it exits.
 */
export function buildCoderContinuationSpawner(p: {
  runId: string;
  backend: CoderBackendId;
  workdir: string;
  model?: string | null;
  env?: Record<string, string>;
  timeoutMinutes?: number;
  autoApprove?: boolean;
  enabledMCPs?: string[];
  /** Used only when starting a FRESH session (operator Retry with no session). */
  systemPrompt?: string;
  durable?: boolean;
  /** Forward every stdout chunk (activity feed, transcript). */
  onStdout?: (chunk: string) => void;
  /** Called once the continuation process exists (registry bookkeeping). */
  onSpawned?: (info: { pid?: number; durableKey: string; attempt: number }) => void;
}): ContinuationSpawner {
  return async (req: ContinuationRequest): Promise<AttemptOutcome> => {
    const { createCoderBackend } = await import("../agents/coder-backend/registry.js");
    const durable = p.durable ?? isDurableSpawnEnabled();
    const raw = new RawOutputBuffer();
    log.info("continuing run", {
      runId: p.runId,
      attempt: req.attempt,
      backend: p.backend,
      resume: Boolean(req.sessionId),
    });
    const session = createCoderBackend(p.backend).spawnBackground(
      {
        id: p.runId,
        name: "claude-coder-continuation",
        type: "cli",
        cliCommand: cliCommandFor(p.backend),
        autoApprove: p.autoApprove ?? true,
        timeoutMinutes: p.timeoutMinutes ?? 30,
        enabledMCPs: p.enabledMCPs ?? [],
        env: p.env,
      },
      req.prompt,
      p.workdir,
      {
        runId: p.runId,
        model: p.model ?? undefined,
        env: p.env,
        resumeSessionId: req.sessionId || undefined,
        systemPrompt: req.sessionId ? undefined : p.systemPrompt,
        durableRunId: durable ? req.durableKey : undefined,
      },
    );
    session.onStdout((chunk) => {
      raw.push(chunk);
      try {
        p.onStdout?.(chunk);
      } catch {
        /* consumer errors never break supervision */
      }
    });
    p.onSpawned?.({ pid: session.pid, durableKey: req.durableKey, attempt: req.attempt });
    const info = await session.finalPromise;
    const interrupted = isGatewayStopping() && (info.killed || isSignalExit(info.exitCode));
    return {
      exitCode: info.exitCode,
      killed: info.killed,
      ...(interrupted
        ? {
            interrupted: true,
            interruptReason: "continuation killed by a gateway restart/shutdown",
          }
        : {}),
      rawOutput: raw.toString(),
      outputText: info.output,
      sessionId: info.sessionId ?? req.sessionId ?? null,
    };
  };
}
