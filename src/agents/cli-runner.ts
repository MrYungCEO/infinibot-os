import type { ImageContent } from "@mariozechner/pi-ai";
import { secureOnlyBlockReason } from "../secure-mode/agent-policy.js";
import { SecureModeBlockedError } from "../secure-mode/policy.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { InfinibotConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { shouldLogVerbose } from "../globals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { appendCliTurnToSessionTranscript } from "../config/sessions/transcript.js";
import { resolveUserPath } from "../utils.js";
import { resolveInfiniBotDocsPath } from "./docs-path.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CliBackendConfig } from "../config/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { enrichedPathEnv, resolveBin } from "./coder-backend/bin-detect.js";
import { cliSupportsMcpTools, prepareCliMcp } from "./cli-runner/mcp.js";
import {
  classifyCliFailure,
  createCliStreamParser,
  describeCliFailure,
  runCliProcess,
  type CliFailureKind,
} from "./cli-runner/stream.js";
import type { CliOutput } from "./cli-runner/helpers.js";
import { planCliArgv } from "./cli-runner/argv-plan.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
import {
  appendImagePathsToPrompt,
  buildSystemPrompt,
  cleanupResumeProcesses,
  cleanupSuspendedCliProcesses,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

const log = createSubsystemLogger("agent/claude-cli");

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: InfinibotConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
  /** Streaming backends: called as the reply text grows. */
  onPartialReply?: (payload: { text: string; delta: string }) => void | Promise<void>;
  abortSignal?: AbortSignal;
  /** false = don't write the turn to the session transcript (connection tests). */
  recordTranscript?: boolean;
}): Promise<EmbeddedPiRunResult> {
  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const label = backend.label ?? params.provider;
  if (isSecureSessionKey(params.sessionKey) && backend.localOnly !== true) {
    // A cloud CLI sends the conversation to its vendor's servers, off this
    // machine. Only CLIs the operator marked localOnly may serve the lane.
    throw new SecureModeBlockedError(
      `Secure Mode: ${label} sends your messages to ${backend.vendor ?? "a hosted service"}'s servers, off this computer, so secure chats never use it. Use a local model, or a CLI marked localOnly (e.g. OpenCode on Ollama).`,
    );
  }
  const secureOnly = secureOnlyBlockReason(params.config, params.sessionKey);
  if (secureOnly) throw new SecureModeBlockedError(secureOnly);
  const started = Date.now();
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const workspaceDir = resolvedWorkspace;

  const modelId = (params.model ?? "default").trim() || "default";
  // "default" = let the CLI use the model it is configured for.
  const normalizedModel = modelId === "default" ? "" : normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  const toolsOn =
    params.config?.cliRouting?.tools !== false &&
    Boolean(backend.stream) &&
    cliSupportsMcpTools(backend.stream);
  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    toolsOn
      ? `You are running inside InfiniBot through ${label}. InfiniBot's tools (memory, kanban, notes, workflows, messaging, …) are available as the "infinibot" MCP server; use them when the user asks for something they cover. You have no other tools.`
      : "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveInfiniBotDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });

  const { sessionId: cliSessionIdToSend, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: params.cliSessionId,
  });
  const useResume = Boolean(
    params.cliSessionId &&
    cliSessionIdToSend &&
    backend.resumeArgs &&
    backend.resumeArgs.length > 0,
  );
  const sessionIdSent = cliSessionIdToSend
    ? useResume || Boolean(backend.sessionArg) || Boolean(backend.sessionArgs?.length)
      ? cliSessionIdToSend
      : undefined
    : undefined;
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let prompt = params.prompt;
  // CLIs without a system-prompt flag get it inline on a session's first turn.
  if (isNew && !backend.systemPromptArg && systemPrompt.trim()) {
    prompt = `${systemPrompt.trim()}\n\n---\n\n${prompt}`;
  }
  if (params.images && params.images.length > 0) {
    const imagePayload = await writeCliImages(params.images);
    imagePaths = imagePayload.paths;
    cleanupImages = imagePayload.cleanup;
    if (!backend.imageArg) {
      prompt = appendImagePathsToPrompt(prompt, imagePaths);
    }
  }

  const scratch: string[] = [];
  const writeScratch = async (name: string, body: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-cli-"));
    scratch.push(dir);
    const file = path.join(dir, name);
    await fs.writeFile(file, body, { mode: 0o600 });
    return file;
  };

  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const mcp =
    toolsOn && backend.stream
      ? await prepareCliMcp({
          dialect: backend.stream,
          cfg: params.config,
          sessionKey: params.sessionKey,
        }).catch((err) => {
          log.warn(`cli mcp: ${label} runs without InfiniBot tools this turn: ${String(err)}`);
          return null;
        })
      : null;
  const withMcp = mcp?.args.length ? insertBeforeSessionPlaceholder(baseArgs, mcp.args) : baseArgs;
  const resolvedArgs = useResume
    ? withMcp.map((entry) => entry.replaceAll("{sessionId}", cliSessionIdToSend ?? ""))
    : withMcp;

  // Windows: spawn() only finds .exe/.com, so a bare "claude" never
  // reaches claude.cmd (npm / Setup › Coders shim). Resolve it first.
  const command =
    process.platform === "win32" && !path.isAbsolute(backend.command)
      ? (resolveBin(backend.command) ?? backend.command)
      : backend.command;

  // Fit the command line to the platform (Windows: 32,767 chars for the
  // WHOLE line, 8,191 through cmd.exe): big text goes to files / stdin.
  const plan = await planCliArgv({
    backend,
    command,
    baseArgs: resolvedArgs,
    modelId: normalizedModel,
    sessionId: cliSessionIdToSend,
    useResume,
    imagePaths,
    prompt,
    systemPrompt: systemPromptArg,
    writeScratch,
  });
  const { args, argsPrompt } = plan;
  const stdinPayload = plan.stdin;
  if (!plan.check.fits) {
    log.warn(
      `cli argv: ${label} command line is ${plan.check.length} chars (budget ${plan.check.budget}) even with prompts in files`,
    );
  }

  // Default: one queue per chat, so turns of the same session stay ordered
  // (and resume the right CLI session) while different chats run in parallel.
  const serialize = backend.serialize === true;
  const queueKey = serialize
    ? backendResolved.id
    : `${backendResolved.id}:${params.sessionKey ?? params.sessionId ?? params.runId}`;

  try {
    const output = await enqueueCliRun(queueKey, async () => {
      log.info(
        `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText = isTruthyEnvValue(process.env.INFINIBOT_CLAUDE_CLI_LOG_OUTPUT);
      if (logOutputText) {
        const logArgs: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i] ?? "";
          if (arg === backend.systemPromptArg) {
            const systemPromptValue = args[i + 1] ?? "";
            logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
            i += 1;
            continue;
          }
          if (arg === backend.sessionArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.modelArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.imageArg) {
            logArgs.push(arg, "<image>");
            i += 1;
            continue;
          }
          logArgs.push(arg);
        }
        if (argsPrompt) {
          const promptIndex = logArgs.indexOf(argsPrompt);
          if (promptIndex >= 0) {
            logArgs[promptIndex] = `<prompt:${argsPrompt.length} chars>`;
          }
        }
        log.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
      }

      const env = (() => {
        const next: NodeJS.ProcessEnv = {
          ...enrichedPathEnv(process.env),
          ...backend.env,
          ...mcp?.env,
        };
        for (const key of backend.clearEnv ?? []) {
          delete next[key];
        }
        return next;
      })();

      // Cleanup suspended processes that have accumulated (regardless of sessionId)
      await cleanupSuspendedCliProcesses(backend);
      if (useResume && cliSessionIdToSend) {
        await cleanupResumeProcesses(backend, cliSessionIdToSend);
      }

      if (backend.stream) {
        return await runStreamingCli({
          backend,
          label,
          argv: [command, ...args],
          cwd: workspaceDir,
          env,
          stdin: stdinPayload,
          timeoutMs: params.timeoutMs,
          signal: params.abortSignal,
          runId: params.runId,
          provider: params.provider,
          model: modelId,
          onPartialReply: params.onPartialReply,
        });
      }

      const result = await runCommandWithTimeout([command, ...args], {
        timeoutMs: params.timeoutMs,
        cwd: workspaceDir,
        env,
        input: stdinPayload,
      }).catch((err: unknown) => {
        // Never surface a raw "spawn ENAMETOOLONG" / "spawn EINVAL".
        const kind = classifyCliFailure(String((err as Error)?.message ?? err));
        if (kind === "unknown") throw err;
        throw new FailoverError(describeCliFailure({ kind, label, command: backend.command }), {
          reason: FAILURE_REASON[kind],
          provider: params.provider,
          model: modelId,
          status: resolveFailoverStatus(FAILURE_REASON[kind]),
        });
      });

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) log.info(`cli stdout:\n${stdout}`);
        if (stderr) log.info(`cli stderr:\n${stderr}`);
      }
      if (shouldLogVerbose()) {
        if (stdout) log.debug(`cli stdout:\n${stdout}`);
        if (stderr) log.debug(`cli stderr:\n${stderr}`);
      }

      if (result.code !== 0) {
        const err = stderr || stdout || "CLI failed.";
        const reason = classifyFailoverReason(err) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(err, {
          reason,
          provider: params.provider,
          model: modelId,
          status,
        });
      }

      const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

      if (outputMode === "text") {
        return { text: stdout, sessionId: undefined };
      }
      if (outputMode === "jsonl") {
        const parsed = parseCliJsonl(stdout, backend);
        return parsed ?? { text: stdout };
      }

      const parsed = parseCliJson(stdout, backend);
      return parsed ?? { text: stdout };
    });

    const text = output.text?.trim();
    const payloads = text ? [{ text }] : undefined;
    if (text && params.recordTranscript !== false) {
      // Chat history (web / desktop / mobile) reads the session transcript.
      await appendCliTurnToSessionTranscript({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        userText: params.prompt,
        assistantText: text,
        provider: params.provider,
        model: modelId,
        usage: output.usage,
      }).catch((err) => {
        log.warn(`cli transcript append failed: ${String(err)}`);
      });
    }

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId: output.sessionId ?? sessionIdSent ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage: output.usage,
        },
      },
    };
  } catch (err) {
    if (err instanceof FailoverError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }
    throw err;
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
    await mcp?.cleanup().catch(() => {});
    for (const dir of scratch) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** MCP flags go before a resume session-id placeholder (which precedes the prompt). */
function insertBeforeSessionPlaceholder(args: string[], extra: string[]): string[] {
  const idx = args.findIndex((entry) => entry.includes("{sessionId}"));
  if (idx < 0) return [...args, ...extra];
  // Keep "--resume {sessionId}" style pairs together.
  const at = idx > 0 && args[idx - 1]?.startsWith("-") ? idx - 1 : idx;
  return [...args.slice(0, at), ...extra, ...args.slice(at)];
}

const FAILURE_REASON: Record<CliFailureKind, FailoverReason> = {
  rate_limit: "rate_limit",
  auth: "auth",
  timeout: "timeout",
  not_installed: "auth",
  unsupported_account: "auth",
  untrusted_dir: "unknown",
  spawn_failed: "auth",
  command_too_long: "auth",
  plan_required: "auth",
  unknown: "unknown",
};

async function runStreamingCli(params: {
  backend: CliBackendConfig;
  label: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  runId: string;
  provider: string;
  model: string;
  onPartialReply?: (payload: { text: string; delta: string }) => void | Promise<void>;
}): Promise<{ text: string; sessionId?: string; usage?: CliOutput["usage"] }> {
  const parser = createCliStreamParser(params.backend.stream!);
  let emitted = "";
  const res = await runCliProcess({
    argv: params.argv,
    cwd: params.cwd,
    env: params.env,
    stdin: params.stdin,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    onLine: (line) => {
      if (!parser.push(line)) return;
      const text = parser.state.text;
      // Only forward append-only growth; a rewrite (rare) shows in the final reply.
      if (!text.startsWith(emitted)) return;
      const delta = text.slice(emitted.length);
      if (!delta) return;
      emitted = text;
      emitAgentEvent({ runId: params.runId, stream: "assistant", data: { text, delta } });
      void Promise.resolve(params.onPartialReply?.({ text, delta })).catch(() => {});
    },
  });
  const state = parser.state;
  if (res.aborted) {
    const err = new Error(`${params.label} run aborted`);
    err.name = "AbortError";
    throw err;
  }
  const failed =
    res.spawnError !== undefined ||
    res.timedOut ||
    (res.code !== 0 && res.code !== null) ||
    res.signal !== null ||
    (!state.text && (state.error || state.limited));
  if (!failed) {
    return { text: state.text, sessionId: state.sessionId, usage: state.usage };
  }
  const detail = [
    res.spawnError?.code === "ENOENT" ? "ENOENT" : res.spawnError?.message,
    state.error,
    state.limited?.message,
    res.stderr.trim().split("\n").slice(-40).join("\n"),
    state.error ? "" : res.stdoutTail.trim().split("\n").slice(-2).join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
  const kind: CliFailureKind = res.timedOut
    ? "timeout"
    : state.limited
      ? "rate_limit"
      : classifyCliFailure(detail);
  const message = describeCliFailure({
    kind,
    label: params.label,
    command: params.backend.command,
    detail:
      kind === "not_installed" ? undefined : (state.error ?? state.limited?.message ?? detail),
    resetsAt: state.limited?.resetsAt,
  });
  log.warn(`cli ${params.provider} failed (${kind}): ${detail.slice(0, 400)}`);
  const reason = FAILURE_REASON[kind];
  throw new FailoverError(message, {
    reason,
    provider: params.provider,
    model: params.model,
    status: resolveFailoverStatus(reason),
  });
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: InfinibotConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
