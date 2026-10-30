/**
 * Voice task spawn endpoint - Async task dispatch with completion callback
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { callGateway } from "./call.js";
import { AGENT_LANE_SUBAGENT } from "../agents/lanes.js";

// Store active voice tasks with their room names for callbacks
const activeVoiceTasks = new Map<
  string,
  {
    voiceRoom: string;
    label: string;
    startedAt: number;
    runId: string;
  }
>();

// Export for external access (e.g., subagent completion handler)
export function getActiveVoiceTask(taskId: string) {
  return activeVoiceTasks.get(taskId);
}

export function completeVoiceTask(taskId: string) {
  activeVoiceTasks.delete(taskId);
}

export function getAllActiveVoiceTasks() {
  return Array.from(activeVoiceTasks.entries()).map(([id, info]) => ({
    id,
    ...info,
    elapsed: Math.round((Date.now() - info.startedAt) / 1000),
  }));
}

export async function handleVoiceSpawnRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/spawn")) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  try {
    console.log("[VoiceSpawn] Spawn request received");

    // Read request body
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const data = JSON.parse(body);
    const task = data.task || "";
    const voiceRoom = data.voiceRoom || "";
    const label = data.label || task.slice(0, 40);

    if (!task) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task is required" }));
      return true;
    }

    const taskId = `voice-${randomUUID().slice(0, 8)}`;
    const childSessionKey = `agent:main:subagent:voice-${randomUUID()}`;
    const childIdem = randomUUID();

    console.log(`[VoiceSpawn] Spawning task ${taskId}: ${task.slice(0, 80)}...`);

    // Spawn the task via gateway agent call (non-blocking)
    const spawnPromise = (async () => {
      try {
        const response = (await callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            idempotencyKey: childIdem,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            extraSystemPrompt: [
              "[Voice mode style - Speakable replies]",
              "You are a sub-agent handling a voice-requested task. Kokoro TTS will read your summary aloud. Follow every rule below for ALL output.",
              "",
              "CONTENT: Max 3 short sentences unless the user asked for detail. No filler openers ('Sure!', 'Great!', 'Here is...'). Confirm concisely: 'Done. Build passed.' not 'I have successfully completed the task!'",
              "",
              "FORMATTING (critical for TTS): NO markdown - no **bold**, no _italic_, no # headings, no bullet lists, no numbered lists, no tables, no code fences, no inline backticks. Say commands in plain words: 'run npm run build'. NO typographic punctuation: no curly quotes, no em-dashes, no en-dashes, no Unicode ellipsis. Use plain ASCII only: straight quotes, plain hyphens, plain '...' sparingly. No emoji.",
              "",
              "NUMBERS: Spell small ones as words ('three files'). Keep large ones numeric when cleaner ('twelve thousand lines').",
              "",
              `Task: ${task}`,
            ].join("\n"),
            timeout: 300, // 5 min
            label: `🎤 ${label}`,
            spawnedBy: "agent:main:voice",
            voiceTaskId: taskId, // Custom field for callback routing
          },
          timeoutMs: 10_000,
        })) as { runId?: string };

        const runId = response?.runId || childIdem;
        console.log(`[VoiceSpawn] Task ${taskId} started with runId: ${runId}`);

        // Store task for callback tracking
        if (voiceRoom) {
          activeVoiceTasks.set(taskId, {
            voiceRoom,
            label,
            startedAt: Date.now(),
            runId,
          });
        }

        return { ok: true, runId };
      } catch (err) {
        console.error(`[VoiceSpawn] Task ${taskId} spawn failed:`, err);
        return { ok: false, error: err instanceof Error ? err.message : "Spawn failed" };
      }
    })();

    // Don't await - respond immediately
    spawnPromise.catch((err) => {
      console.error(`[VoiceSpawn] Unhandled error in task ${taskId}:`, err);
    });

    // Respond immediately with acceptance
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        taskId,
        sessionKey: childSessionKey,
        message: `Task spawned: ${label}`,
      }),
    );

    return true;
  } catch (err: any) {
    console.error("[VoiceSpawn] Error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error", details: err.message }));
    return true;
  }
}

// Endpoint to check active tasks (for debugging/UI)
export async function handleVoiceTasksRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/tasks")) return false;
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  const tasks = getAllActiveVoiceTasks();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ tasks }));
  return true;
}
