/**
 * A voice call bound to a chat session: turns the fast step answered (no agent
 * run, so nothing wrote the transcript) are appended to that session's
 * transcript and broadcast like chat.inject does, so the caller's words and
 * the spoken reply show up in the chat they started the call from.
 *
 * Full-agent turns need none of this: agentCommand runs ON the bound session
 * key and records them itself.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type Broadcast = (event: string, payload: unknown) => void;

export async function mirrorVoiceTurnToSession(
  sessionKey: string,
  userText: string,
  assistantText: string,
  deps: { broadcast?: Broadcast | null } = {},
): Promise<boolean> {
  const [{ loadSessionEntry }, { getGatewayBroadcaster }] = await Promise.all([
    import("../session-utils.js"),
    import("../../agents/coder-runtime/subagent-broadcast.js"),
  ]);
  const { storePath, entry } = loadSessionEntry(sessionKey);
  if (!entry?.sessionId || !storePath) return false;
  const transcriptPath = entry.sessionFile
    ? entry.sessionFile
    : path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return false;
  const now = Date.now();
  const lines: Array<{
    type: string;
    id: string;
    timestamp: string;
    message: Record<string, unknown>;
  }> = [];
  if (userText.trim()) {
    lines.push({
      type: "message",
      id: randomUUID().slice(0, 8),
      timestamp: new Date(now).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: userText.trim() }],
        timestamp: now,
        source: "voice",
      },
    });
  }
  if (assistantText.trim()) {
    lines.push({
      type: "message",
      id: randomUUID().slice(0, 8),
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText.trim() }],
        timestamp: now + 1,
        stopReason: "voice",
        usage: { input: 0, output: 0, totalTokens: 0 },
      },
    });
  }
  if (!lines.length) return false;
  await fs.promises.appendFile(
    transcriptPath,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
  const broadcast = deps.broadcast === undefined ? getGatewayBroadcaster() : deps.broadcast;
  for (const l of lines) {
    broadcast?.("chat", {
      runId: `voice-${l.id}`,
      sessionKey,
      seq: 0,
      state: "final",
      message: l.message,
    });
  }
  return true;
}
