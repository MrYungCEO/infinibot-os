/**
 * Turn timeout with progress: instead of a silent spinner, the user gets a
 * clear note ("This took longer than 20 min — here's what was gathered") with
 * the tool results collected so far, saved to the transcript so a "continue"
 * turn resumes from them. Chat surfaces render a Continue button for it
 * (assistant message model === TURN_TIMEOUT_MODEL).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  emitAgentEvent,
  hasTerminalLifecycle,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { coerceString } from "../../shared/text/coerce.js";

export const TURN_TIMEOUT_MODEL = "turn-timeout";

const MAX_TOOLS_LISTED = 14;
const EXCERPT_CHARS = 280;
const MAX_NOTICE_CHARS = 5000;

type GatheredTool = { name: string; excerpt: string; isError: boolean };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: string }).type === "text"
        ? coerceString((c as { text?: unknown }).text)
        : "",
    )
    .join("\n");
}

const LIST_KEYS = ["files", "videos", "entries", "results", "docs", "analyses", "items", "tasks"];

function clip(text: string, n = EXCERPT_CHARS): string {
  const flat = text
    .replace(/\\n/g, " ")
    .replace(/[#*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function itemLabel(item: unknown): string | null {
  if (!item || typeof item !== "object") return typeof item === "string" ? item : null;
  const o = item as Record<string, unknown>;
  for (const k of ["name", "title", "id"]) if (typeof o[k] === "string") return o[k] as string;
  return null;
}

/** A readable one-liner for a tool result (JSON results are summarized). */
export function summarizeToolText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return clip(text);
  }
  if (Array.isArray(parsed)) {
    const labels = parsed.map(itemLabel).filter(Boolean).slice(0, 8);
    return clip(`${parsed.length} item(s)${labels.length ? `: ${labels.join(", ")}` : ""}`);
  }
  if (!parsed || typeof parsed !== "object") return clip(String(parsed));
  const o = parsed as Record<string, unknown>;
  if (typeof o.error === "string") return clip(`error: ${o.error}`);
  const key = LIST_KEYS.find((k) => Array.isArray(o[k]));
  if (key) {
    const list = o[key] as unknown[];
    const labels = list.map(itemLabel).filter(Boolean).slice(0, 8);
    const more = list.length > labels.length ? ", …" : "";
    return clip(`${list.length} ${key}${labels.length ? `: ${labels.join(", ")}${more}` : ""}`);
  }
  const head = itemLabel(o);
  const detail = ["summary", "answer", "description", "content", "text"]
    .map((k) => o[k])
    .find((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (head || detail) return clip([head, detail].filter(Boolean).join(" — "));
  return clip(`fields: ${Object.keys(o).slice(0, 10).join(", ")}`);
}

/** Tool results produced in the current turn (after the last user message). */
export function gatheredToolResults(messages: AgentMessage[]): GatheredTool[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string })?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const out: GatheredTool[] = [];
  for (const m of messages.slice(start)) {
    const r = m as { role?: string; toolName?: string; content?: unknown; isError?: boolean };
    if (r?.role !== "toolResult") continue;
    out.push({
      name: r.toolName || "tool",
      excerpt: summarizeToolText(textOf(r.content)),
      isError: r.isError === true,
    });
  }
  return out;
}

export function buildTurnTimeoutNotice(params: { timeoutMs: number; messages: AgentMessage[] }): {
  text: string;
  gathered: number;
} {
  const secs = Math.round(params.timeoutMs / 1000);
  const took = secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`;
  const tools = gatheredToolResults(params.messages);
  const lines: string[] = [];
  if (tools.length) {
    lines.push(
      `⏱ **This took longer than ${took}, so I stopped here.** Here's what was gathered so far (${tools.length} tool result${tools.length === 1 ? "" : "s"}):`,
      "",
    );
    for (const t of tools.slice(-MAX_TOOLS_LISTED)) {
      lines.push(`- **${t.name}**${t.isError ? " (error)" : ""}: ${t.excerpt || "(empty)"}`);
    }
    if (tools.length > MAX_TOOLS_LISTED) {
      lines.push(`- …and ${tools.length - MAX_TOOLS_LISTED} earlier result(s)`);
    }
    lines.push(
      "",
      "Press **Continue** (or reply “continue”) and I'll pick up from these results without repeating them.",
    );
  } else {
    lines.push(
      `⏱ **This took longer than ${took}, so I stopped here** before any tool results came back.`,
      "",
      "Press **Continue** (or reply “continue”) to try again, or ask a narrower question.",
    );
  }
  let text = lines.join("\n");
  if (text.length > MAX_NOTICE_CHARS) text = `${text.slice(0, MAX_NOTICE_CHARS - 1)}…`;
  return { text, gathered: tools.length };
}

type TranscriptRow = { type?: string; id?: string; message?: { role?: string; content?: unknown } };

function readRows(sessionFile: string): TranscriptRow[] {
  try {
    return fs
      .readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TranscriptRow);
  } catch {
    return [];
  }
}

/**
 * Save the notice as an assistant message so history + "continue" see it.
 * A turn that timed out before its first reply has nothing on disk yet (not
 * even the user's message): create the transcript and record the prompt first.
 * Rows are appended directly (id/parentId chain) — SessionManager drops
 * buffered user entries when opened on a header-only file.
 */
export function appendTurnTimeoutNotice(params: {
  sessionFile: string;
  sessionId?: string;
  sessionKey?: string;
  prompt?: string;
  text: string;
}): boolean {
  try {
    if (!fs.existsSync(params.sessionFile)) {
      fs.mkdirSync(path.dirname(params.sessionFile), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId ?? randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(params.sessionFile, `${JSON.stringify(header)}\n`, { mode: 0o600 });
    }
    const rows = readRows(params.sessionFile);
    let parentId: string | null =
      [...rows].reverse().find((r) => r.type !== "session" && typeof r.id === "string")?.id ?? null;
    const lastUser = [...rows].reverse().find((r) => r.message?.role === "user");
    const now = Date.now();
    const lines: string[] = [];
    const push = (message: Record<string, unknown>, ts: number) => {
      const id = randomUUID().replace(/-/g, "").slice(0, 8);
      lines.push(
        JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: new Date(ts).toISOString(),
          message,
        }),
      );
      parentId = id;
    };
    const prompt = params.prompt?.trim();
    const lastUserText = textOf(lastUser?.message?.content).trim();
    if (
      prompt &&
      !(lastUserText && (lastUserText.includes(prompt) || prompt.includes(lastUserText)))
    ) {
      push({ role: "user", content: prompt, timestamp: now - 1 }, now - 1);
    }
    push(
      {
        role: "assistant",
        content: [{ type: "text", text: params.text }],
        api: "openai-responses",
        provider: "infinibot",
        model: TURN_TIMEOUT_MODEL,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      },
      now,
    );
    fs.appendFileSync(params.sessionFile, `${lines.join("\n")}\n`);
    // Secure transcripts live in RAM until sealed; no cross-subsystem events.
    if (!isSecureSessionKey(params.sessionKey)) emitSessionTranscriptUpdate(params.sessionFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Push the notice to chat surfaces as its own short run: the turn's own final
 * may already have gone out (agent_end fires on abort), so a separate final
 * makes the UI show it and reload history.
 */
export function broadcastTurnTimeoutNotice(params: {
  runId: string;
  sessionKey?: string;
  text: string;
}) {
  if (!params.sessionKey) return;
  const noticeRunId = `${params.runId}:timeout-${randomUUID().slice(0, 6)}`;
  registerAgentRunContext(noticeRunId, { sessionKey: params.sessionKey });
  emitAgentEvent({
    runId: noticeRunId,
    sessionKey: params.sessionKey,
    stream: "assistant",
    data: { text: params.text },
  });
  emitAgentEvent({
    runId: noticeRunId,
    sessionKey: params.sessionKey,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now(), timeoutNotice: true },
  });
}

/**
 * A timed-out run can return without its lifecycle "end" (the agent never
 * reached agent_end), which left chat surfaces spinning. Close it explicitly.
 */
export function endTimedOutRunLifecycle(runId: string) {
  if (hasTerminalLifecycle(runId)) return;
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now(), timedOut: true },
  });
}
