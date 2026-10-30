import { COMPLETION_CONTRACT_PROMPT } from "../verification/contract.js";
import crypto from "node:crypto";
import path from "node:path";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { callGateway } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { readLatestAssistantReply } from "./tools/agent-step.js";
import {
  formatDurationHuman,
  humanizeSubagentLabel,
  subagentTaskExcerpt,
} from "../notifications/subagent-format.js";

function formatDurationShort(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) return undefined;
  const totalSeconds = Math.round(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(value?: number) {
  if (!value || !Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatUsd(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function resolveModelCost(params: {
  provider?: string;
  model?: string;
  config: ReturnType<typeof loadConfig>;
}):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) return undefined;
  const models = params.config.models?.providers?.[provider]?.models ?? [];
  const entry = models.find((candidate) => candidate.id === model);
  return entry?.cost;
}

async function waitForSessionUsage(params: { sessionKey: string }) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  let entry = loadSessionStore(storePath)[params.sessionKey];
  if (!entry) return { entry, storePath };
  const hasTokens = () =>
    entry &&
    (typeof entry.totalTokens === "number" ||
      typeof entry.inputTokens === "number" ||
      typeof entry.outputTokens === "number");
  if (hasTokens()) return { entry, storePath };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    entry = loadSessionStore(storePath)[params.sessionKey];
    if (hasTokens()) break;
  }
  return { entry, storePath };
}

type DeliveryContextSource = Parameters<typeof deliveryContextFromSession>[0];

function resolveAnnounceOrigin(
  entry?: DeliveryContextSource,
  requesterOrigin?: DeliveryContext,
): DeliveryContext | undefined {
  return mergeDeliveryContext(deliveryContextFromSession(entry), requesterOrigin);
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
      threadId,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
    },
    expectFinal: true,
    timeoutMs: 60_000,
  });
}

function resolveRequesterStoreKey(
  cfg: ReturnType<typeof loadConfig>,
  requesterSessionKey: string,
): string {
  const raw = requesterSessionKey.trim();
  if (!raw) return raw;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}

function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  triggerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
}): Promise<"steered" | "queued" | "none"> {
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) return "none";

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel,
    sessionEntry: entry,
  });
  const isActive = isEmbeddedPiRunActive(sessionId);

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = queueEmbeddedPiMessage(sessionId, params.triggerMessage);
    if (steered) return "steered";
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    enqueueAnnounce({
      key: canonicalKey,
      item: {
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
      },
      settings: queueSettings,
      send: sendAnnounce,
    });
    return "queued";
  }

  return "none";
}

async function buildSubagentStatsLine(params: {
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}) {
  const cfg = loadConfig();
  const { entry, storePath } = await waitForSessionUsage({
    sessionKey: params.sessionKey,
  });

  const sessionId = entry?.sessionId;
  const transcriptPath =
    sessionId && storePath ? path.join(path.dirname(storePath), `${sessionId}.jsonl`) : undefined;

  const input = entry?.inputTokens;
  const output = entry?.outputTokens;
  const total =
    entry?.totalTokens ??
    (typeof input === "number" && typeof output === "number" ? input + output : undefined);
  const runtimeMs =
    typeof params.startedAt === "number" && typeof params.endedAt === "number"
      ? Math.max(0, params.endedAt - params.startedAt)
      : undefined;

  const provider = entry?.modelProvider;
  const model = entry?.model;
  const costConfig = resolveModelCost({ provider, model, config: cfg });
  const cost =
    costConfig && typeof input === "number" && typeof output === "number"
      ? (input * costConfig.input + output * costConfig.output) / 1_000_000
      : undefined;

  const parts: string[] = [];
  const runtime = formatDurationShort(runtimeMs);
  parts.push(`runtime ${runtime ?? "n/a"}`);
  if (typeof total === "number") {
    const inputText = typeof input === "number" ? formatTokenCount(input) : "n/a";
    const outputText = typeof output === "number" ? formatTokenCount(output) : "n/a";
    const totalText = formatTokenCount(total);
    parts.push(`tokens ${totalText} (in ${inputText} / out ${outputText})`);
  } else {
    parts.push("tokens n/a");
  }
  const costText = formatUsd(cost);
  if (costText) parts.push(`est ${costText}`);
  parts.push(`sessionKey ${params.sessionKey}`);
  if (sessionId) parts.push(`sessionId ${sessionId}`);
  if (transcriptPath) parts.push(`transcript ${transcriptPath}`);

  return `Stats: ${parts.join(" \u2022 ")}`;
}

export function buildSubagentSystemPrompt(params: {
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  childSessionKey: string;
  label?: string;
  task?: string;
  projectContext?: string;
}) {
  const taskText =
    typeof params.task === "string" && params.task.trim()
      ? params.task.trim()
      : "{{TASK_DESCRIPTION}}";

  // Extract project context from task if provided inline
  const projectContextFromTask = extractProjectContext(taskText);
  const projectContext = params.projectContext || projectContextFromTask;

  const lines = [
    "# Subagent Context",
    "",
    "You are a **subagent** spawned by the main agent for a specific task.",
    "",
    "## Your Task",
    "```",
    taskText,
    "```",
    "",
    "## Important: You Have Full Context",
    "The task description above contains ALL the context you need:",
    "- **Location/paths** are specified in the task",
    "- **What to build** is described in detail",
    "- **APIs/methods** to use are listed",
    "- **Styling/patterns** to follow are mentioned",
    "",
    "**Do NOT claim you lack context.** Read the task carefully - it has everything.",
    "If something is truly unclear, state specifically what's missing and proceed with reasonable assumptions.",
    "",
    "## Your Role",
    "- Complete the assigned task thoroughly",
    "- You are a specialist agent with full tool access",
    "- Work independently - don't ask for confirmation, just execute",
    "",
    "## Execution Strategy",
    "1. **Read the task** - All paths, APIs, and requirements are there",
    "2. **Explore first** - Use `read` and `exec` to understand the codebase structure",
    "3. **Plan briefly** - 2-3 sentences on approach, then execute",
    "4. **Build it** - Write the code, create the files",
    "5. **Test if possible** - Run builds, start dev servers",
    "6. **Report completion** - Summarize what you built",
    "",
    "## Rules",
    "1. **Execute immediately** - Don't ask clarifying questions, make reasonable choices",
    "2. **Use tools liberally** - Read files, explore directories, understand the codebase",
    "3. **Complete the task** - Your final message reports to the main agent",
    "4. **Be thorough** - Build something that works, not a skeleton",
    "",
    "## Progress Reporting",
    "Use `subagent_progress` tool to report status:",
    "- `{ status: 'working', message: 'Exploring codebase...', progress: 10 }`",
    "- `{ status: 'checkpoint', message: 'Created component', checkpoint: 'component_created', progress: 50 }`",
    "- `{ status: 'finishing', message: 'Testing build...', progress: 90 }`",
    "",
    "## Output Format",
    "When complete, include:",
    "- What you built/accomplished",
    "- Files created/modified",
    "- How to test (commands, URLs)",
    "- Any issues encountered",
    "",
    "## What You DON'T Do",
    "- NO claiming lack of context (it's all in the task)",
    "- NO user conversations (main agent's job)",
    "- NO external messages unless explicitly tasked",
    "- NO asking permission - just execute",
    "",
    "## Session Info",
    params.label ? `- Label: ${params.label}` : undefined,
    `- Session: ${params.childSessionKey}`,
    params.requesterSessionKey ? `- Requester: ${params.requesterSessionKey}` : undefined,
    "",
    // Verified completion (core principle): same contract every coder CLI gets.
    process.env.INFINIBOT_VERIFIED_COMPLETION !== "0" ? COMPLETION_CONTRACT_PROMPT : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

/**
 * Extract any project context hints from task description
 */
function extractProjectContext(task: string): string | undefined {
  // Look for common patterns that indicate project context
  const patterns = [
    /\*\*Location[:\s]*\*\*\s*([^\n]+)/i,
    /Location[:\s]+([^\n]+)/i,
    /Project[:\s]+([^\n]+)/i,
    /Codebase[:\s]+([^\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

export type SubagentRunOutcome = {
  status: "ok" | "error" | "timeout" | "unknown";
  error?: string;
};

/**
 * MCP-connected orchestrators (Claude Code / Codex / Cursor over the infinibot
 * MCP server) own sessions like `agent:main:mcp-<host>-<pid>-<tag>`. There is
 * no chat channel to inject a turn into ("unknown channel: mcp"), so their
 * completions are delivered through the verified-completion inbox instead:
 * subagents_wait / subagents_events + the MCP push relay.
 */
export function isMcpOrchestratorSession(
  sessionKey: string | undefined,
  channel?: string,
): boolean {
  if (channel === "mcp") return true;
  return typeof sessionKey === "string" && /(^|:)mcp-/.test(sessionKey);
}

/**
 * Voice-call sessions (`agent:<id>:voicecall-owner:…` / `agent:<id>:voicecall:…`,
 * including their `:dlg-<id>` delegate sessions). Results reach the caller
 * through the voice task tracker, never through a text channel.
 */
export function isVoiceCallSession(sessionKey: string | undefined): boolean {
  return typeof sessionKey === "string" && /^agent:[^:]+:voicecall(?:-owner)?:/.test(sessionKey);
}

/** One-paragraph verdict line for announce messages (never "verified" unless it is). */
export async function verificationLineForRun(runId: string): Promise<string | null> {
  try {
    const { getRecord } = await import("../verification/store.js");
    const rec = getRecord(runId);
    if (!rec) return null;
    const verdict = rec.review?.verdict ?? rec.state.toUpperCase();
    if (rec.state === "verified" || rec.state === "accepted") {
      return `Verification: ${verdict} — the claims were checked against evidence (${rec.attempts.length} attempt(s)).`;
    }
    const why = (rec.review?.reasons ?? []).slice(0, 3).join("; ");
    return `Verification: ${verdict} (${rec.state}). ${why ? `Why: ${why}. ` : ""}Do NOT present this work as done or its claims as facts — say what is unverified.`;
  } catch {
    return null;
  }
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
}): Promise<boolean> {
  let didAnnounce = false;
  try {
    const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (!reply && params.waitForCompletion !== false) {
      const waitMs = Math.min(params.timeoutMs, 60_000);
      const wait = (await callGateway({
        method: "agent.wait",
        params: {
          runId: params.childRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      })) as {
        status?: string;
        error?: string;
        startedAt?: number;
        endedAt?: number;
      };
      if (wait?.status === "timeout") {
        outcome = { status: "timeout" };
      } else if (wait?.status === "error") {
        outcome = { status: "error", error: wait.error };
      } else if (wait?.status === "ok") {
        outcome = { status: "ok" };
      }
      if (typeof wait?.startedAt === "number" && !params.startedAt) {
        params.startedAt = wait.startedAt;
      }
      if (typeof wait?.endedAt === "number" && !params.endedAt) {
        params.endedAt = wait.endedAt;
      }
      if (wait?.status === "timeout") {
        if (!outcome) outcome = { status: "timeout" };
      }
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!reply) {
      reply = await readLatestAssistantReply({
        sessionKey: params.childSessionKey,
      });
    }

    if (!outcome) outcome = { status: "unknown" };

    // Build stats
    const statsLine = await buildSubagentStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    // Build instructional message for main agent. Humanize the label so a
    // runId-shaped fallback ("coder-mobile-foo-bar-x9y2") reads as something
    // the user can actually parse if it ever surfaces verbatim.
    const taskLabel = humanizeSubagentLabel(
      params.label,
      params.task ? subagentTaskExcerpt(params.task, 80) : "background task",
    );
    const taskExcerpt = params.task ? subagentTaskExcerpt(params.task, 120) : "";
    const runtimeMs =
      typeof params.startedAt === "number" && typeof params.endedAt === "number"
        ? Math.max(0, params.endedAt - params.startedAt)
        : undefined;
    const runtimeHuman = formatDurationHuman(runtimeMs);
    const headlineParts = [`A background task "${taskLabel}" just ${statusLabel}.`];
    if (taskExcerpt && taskExcerpt !== taskLabel) {
      headlineParts.push(`Task: ${taskExcerpt}`);
    }
    if (runtimeHuman) {
      headlineParts.push(`Runtime: ${runtimeHuman}.`);
    }
    const verificationLine = await verificationLineForRun(params.childRunId);
    const triggerMessage = [
      ...headlineParts,
      ...(verificationLine ? ["", verificationLine] : []),
      "",
      "Findings:",
      reply || "(no output)",
      "",
      statsLine,
      "",
      "Summarize this naturally for the user. Keep it brief (1-2 sentences). Flow it into the conversation naturally.",
      "Do not mention technical details like tokens, stats, or that this was a background task.",
      "You can respond with NO_REPLY if no announcement is needed (e.g., internal task with no user-facing result).",
    ].join("\n");

    // MCP orchestrators: the completion inbox (written by the verification
    // pipeline) is the delivery path — injecting an agent turn fails with
    // "unknown channel: mcp". Make sure a terminal event exists, then stop.
    if (isMcpOrchestratorSession(params.requesterSessionKey, requesterOrigin?.channel)) {
      try {
        const { getRecord } = await import("../verification/store.js");
        if (!getRecord(params.childRunId)) {
          const { reviewFinishedRun } = await import("../verification/pipeline.js");
          await reviewFinishedRun({
            runId: params.childRunId,
            childSessionKey: params.childSessionKey,
            requesterSessionKey: params.requesterSessionKey,
            label: taskLabel,
            task: params.task,
            startedAt: params.startedAt,
            finalText: reply || "",
            exitOk: outcome.status === "ok",
          });
        }
      } catch {
        /* inbox write is best effort; subagents_wait falls back to the registry */
      }
      didAnnounce = true;
      return true;
    }

    // Group chat members: their session has no delivery channel, so the
    // injected turn's reply was lost (and the member had already told the
    // group "done"). Post the run's real outcome + verification verdict into
    // the group transcript, where every member and the user sees it.
    if (/:gcmember-/.test(params.requesterSessionKey)) {
      try {
        const { recordGroupMemberRunResult } = await import(
          "../gateway/server-methods/group-chat.js"
        );
        const findings = (reply || "").trim();
        const posted = recordGroupMemberRunResult(
          params.requesterSessionKey,
          [
            `Run update (${params.childRunId}): ${headlineParts.join(" ")}`,
            verificationLine ?? "Verification: (no verdict recorded)",
            findings ? `Findings: ${findings.length > 600 ? `${findings.slice(0, 599)}…` : findings}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (posted) {
          didAnnounce = true;
          return true;
        }
      } catch (err) {
        defaultRuntime.error?.(`Subagent announce → group chat failed: ${String(err)}`);
      }
    }

    const queued = await maybeQueueSubagentAnnounce({
      requesterSessionKey: params.requesterSessionKey,
      triggerMessage,
      summaryLine: taskLabel,
      requesterOrigin,
    });
    if (queued === "steered") {
      didAnnounce = true;
      return true;
    }
    if (queued === "queued") {
      didAnnounce = true;
      return true;
    }

    // Voice calls have no text channel to deliver to: the voice task tracker
    // speaks the result on the call. Delivering resolved to the default channel
    // (e.g. WhatsApp with no target) and failed the whole announce.
    const voiceRequester = isVoiceCallSession(params.requesterSessionKey);
    // Send to main agent - it will respond in its own voice
    let directOrigin = voiceRequester ? undefined : requesterOrigin;
    if (!directOrigin && !voiceRequester) {
      const { entry } = loadRequesterSessionEntry(params.requesterSessionKey);
      directOrigin = deliveryContextFromSession(entry);
    }
    await callGateway({
      method: "agent",
      params: {
        sessionKey: params.requesterSessionKey,
        message: triggerMessage,
        deliver: !voiceRequester,
        channel: directOrigin?.channel,
        accountId: directOrigin?.accountId,
        to: directOrigin?.to,
        threadId:
          directOrigin?.threadId != null && directOrigin.threadId !== ""
            ? String(directOrigin.threadId)
            : undefined,
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: 60_000,
    });

    didAnnounce = true;
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (params.cleanup === "delete") {
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: params.childSessionKey, deleteTranscript: true },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return didAnnounce;
}
