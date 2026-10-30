/**
 * Design page — agent runner.
 *
 * Spawns a Claude Code CLI background session per user message. The
 * project workspace is the cwd. Composed system prompt (DISCOVERY +
 * identity + DESIGN.md + SKILL.md + project metadata) is passed via
 * `--append-system-prompt`. Conversation history is appended to the
 * background prompt so the CLI sees prior turns.
 *
 * One project = one active run at a time. Concurrent sends queue.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";

// COORDINATION: opencode-swap — replaced direct launcher import with registry.
import { getCoderBackend } from "../agents/coder-backend/registry.js";
import type { CLIAgentConfig } from "../agents/types/agent-types.js";

import { getDesignStore } from "./store.js";
import { getDesignSkill } from "./skills-registry.js";
import { getDesignSystem } from "./design-systems.js";
import { buildSystemPrompt } from "./prompts.js";
import { rescanArtifacts } from "./artifacts.js";
import type { DesignMessage, DesignProject, ProjectRuntime } from "./types.js";

const ASSISTANT_STDOUT_LIMIT = 200_000; // hard cap to avoid runaway transcripts

const runtimeByProject = new Map<string, ProjectRuntime>();
const queueByProject = new Map<string, Array<() => Promise<void>>>();

export function getRuntime(projectId: string): ProjectRuntime {
  return (
    runtimeByProject.get(projectId) ?? {
      mode: "idle",
      runId: null,
      childSessionKey: null,
      startedAt: null,
      lastError: null,
    }
  );
}

function setRuntime(projectId: string, patch: Partial<ProjectRuntime>): ProjectRuntime {
  const next = { ...getRuntime(projectId), ...patch };
  runtimeByProject.set(projectId, next);
  return next;
}

export interface SendMessageInput {
  stateDir: string;
  project: DesignProject;
  userContent: string;
  /** Caller can pass null on the first turn before the brief is known. */
  modelOverride?: string;
}

export interface SendMessageResult {
  userMessage: DesignMessage;
  runId: string;
}

export function sendUserMessage(input: SendMessageInput): SendMessageResult {
  const store = getDesignStore(input.stateDir);

  // Persist the user message synchronously so the UI sees it immediately.
  const userMessage: DesignMessage = {
    id: randomUUID(),
    projectId: input.project.id,
    role: "user",
    content: input.userContent,
    meta: null,
    createdAt: Date.now(),
  };
  store.appendMessage(userMessage);

  // Ensure workspace exists.
  if (!existsSync(input.project.workspaceDir)) {
    mkdirSync(input.project.workspaceDir, { recursive: true });
  }

  // Schedule the agent run. If a run is already in flight for this project,
  // queue this turn behind it — preserves chat order.
  const runId = `design-${input.project.id.slice(0, 8)}-${Date.now()}`;
  const queue = queueByProject.get(input.project.id) ?? [];
  queueByProject.set(input.project.id, queue);
  const task = async () => {
    setRuntime(input.project.id, {
      mode: "running",
      runId,
      childSessionKey: null,
      startedAt: Date.now(),
      lastError: null,
    });
    try {
      await runOnce(input.stateDir, input.project, input.modelOverride);
    } catch (err) {
      setRuntime(input.project.id, {
        mode: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
      const errMsg: DesignMessage = {
        id: randomUUID(),
        projectId: input.project.id,
        role: "system",
        content: `Agent run failed: ${err instanceof Error ? err.message : String(err)}`,
        meta: { errorSource: "design-runner" },
        createdAt: Date.now(),
      };
      store.appendMessage(errMsg);
    } finally {
      setRuntime(input.project.id, {
        mode: "idle",
        runId: null,
        childSessionKey: null,
      });
      // Trigger the next queued turn.
      const q = queueByProject.get(input.project.id);
      if (q && q.length > 0) {
        const next = q.shift();
        if (next) void next();
      }
    }
  };
  if (getRuntime(input.project.id).mode === "running") {
    queue.push(task);
  } else {
    void task();
  }

  return { userMessage, runId };
}

async function runOnce(
  stateDir: string,
  project: DesignProject,
  modelOverride?: string,
): Promise<void> {
  const store = getDesignStore(stateDir);
  const skill = project.activeSkillId ? getDesignSkill(stateDir, project.activeSkillId) : null;
  const system = project.activeDesignSystemId
    ? getDesignSystem(stateDir, project.activeDesignSystemId)
    : null;
  const systemPrompt = buildSystemPrompt({ project, skill, system });

  // Build the per-turn task body: the most recent user message plus a
  // condensed transcript of prior turns. Claude Code is fed via its
  // single-shot task arg, so we replay context here ourselves.
  const messages = store.listMessages(project.id);
  const transcript = condensedTranscript(messages, /* maxChars */ 20_000);
  const taskBody = transcript;

  // Map our model id (e.g. "anthropic:claude-sonnet-4-6") to Claude Code's
  // CLI flag — it only accepts `opus | sonnet | haiku`. Anything else uses
  // the project default (sonnet).
  const cliModel = pickClaudeCliModel(modelOverride ?? project.modelId);

  // COORDINATION: opencode-swap — routes through backend registry.
  const designAgentConfig: CLIAgentConfig = {
    id: `design-${project.id.slice(0, 8)}`,
    name: `design:${project.name.slice(0, 32)}`,
    type: "cli",
    cliCommand: "claude",
    autoApprove: true,
    timeoutMinutes: 30,
    enabledMCPs: [],
  };
  const session = getCoderBackend().spawnBackground(
    designAgentConfig,
    taskBody,
    project.workspaceDir,
    {
      model: cliModel ?? undefined,
      systemPrompt,
    },
  );

  // Capture stdout into a single assistant message at the end.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stopStdout = session.onStdout((chunk) => {
    stdoutChunks.push(chunk);
    if (stdoutChunks.join("").length > ASSISTANT_STDOUT_LIMIT) {
      stopStdout();
    }
  });
  const stopStderr = session.onStderr((chunk) => {
    stderrChunks.push(chunk);
  });

  const info = await session.finalPromise;
  stopStdout();
  stopStderr();

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  // Parse Claude Code stdout: it produces JSON lines with assistant content
  // when running in non-interactive mode. Extract text; fall back to raw
  // stdout if no structured frames present.
  const assistantContent = extractAssistantText(stdout) || stdout.slice(-12_000);

  const assistantMessage: DesignMessage = {
    id: randomUUID(),
    projectId: project.id,
    role: "assistant",
    content: assistantContent,
    meta: {
      runId: info.runId,
      exitCode: info.exitCode,
      durationMs: info.durationMs,
      stderr: stderr.slice(-2_000) || undefined,
    },
    createdAt: Date.now(),
  };
  store.appendMessage(assistantMessage);

  // Rescan the workspace and update artifacts.
  rescanArtifacts(stateDir, project.id, project.workspaceDir);
}

function condensedTranscript(messages: DesignMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    const tag =
      m.role === "user"
        ? "User:"
        : m.role === "assistant"
          ? "Assistant:"
          : m.role === "system"
            ? "System:"
            : "Tool:";
    lines.push(`${tag} ${m.content}`);
  }
  let out = lines.join("\n\n---\n\n");
  if (out.length > maxChars) {
    // Keep the final 80% of the budget on the most recent turns.
    out = "[older turns trimmed]\n\n" + out.slice(out.length - maxChars);
  }
  return out;
}

function pickClaudeCliModel(modelId: string): "opus" | "sonnet" | "haiku" {
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet";
}

function extractAssistantText(stdout: string): string {
  // Claude Code emits ND-JSON event frames in `--output-format stream-json`
  // mode and plain text otherwise. We don't know which mode the launcher
  // chose, so try JSON-line parsing first.
  const lines = stdout.split("\n");
  const collected: string[] = [];
  let sawAnyJson = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("{")) continue;
    sawAnyJson = true;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      // Anthropic Messages-style content blocks: { type: "text", text: "..." }
      const message = (ev as { message?: { content?: unknown[] } }).message;
      const blocks = message?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if ((b as { type?: string }).type === "text") {
            const t = (b as { text?: string }).text;
            if (typeof t === "string") collected.push(t);
          }
        }
      }
      // Claude Code progressive stream: { type:"content_block_delta", delta:{ type:"text_delta", text:"..." } }
      const delta = (ev as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        collected.push(delta.text);
      }
    } catch {
      /* not a JSON frame — ignore */
    }
  }
  if (sawAnyJson && collected.length > 0) return collected.join("");
  return "";
}
