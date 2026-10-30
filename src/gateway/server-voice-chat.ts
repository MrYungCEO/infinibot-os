import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { callGateway } from "./call.js";

/**
 * Voice Chat HTTP Handler - Synchronous agent call for voice
 */
export async function handleVoiceChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url?.startsWith("/api/voice/chat")) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const data = JSON.parse(body);
    const message = (data.message || "").trim();
    const sessionKey = data.sessionKey || "agent:main:voice";

    if (!message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Message is required" }));
      return true;
    }

    const idempotencyKey = randomUUID();

    // Tolerate slow LLM turns during a voice call — a 60s ceiling cut
    // long replies short and presented as a mid-call disconnect. 5 min
    // matches the voice-agent's outer aiohttp timeout in agent.py.
    const VOICE_TURN_MAX_MS = 5 * 60 * 1000; // 5 minutes

    // Step 0: Pre-empt any in-flight run for this session. Without this,
    // the user's second utterance just stacks on top of the first one's
    // 5-minute wait — the voice agent appears to hang because each new
    // call queues behind a long tool-use chain. With pre-emption,
    // speaking again always means "respond to my latest words, drop
    // whatever you were doing." Best-effort: errors during abort
    // shouldn't block the new turn.
    try {
      await callGateway({
        method: "agent.abort",
        params: { sessionKey },
        timeoutMs: 5_000,
      });
    } catch (abortErr) {
      console.warn("[VoiceChat] pre-empt abort failed (non-fatal):", abortErr);
    }

    // Step 1: Send message to agent
    const agentResponse = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message,
        sessionKey,
        idempotencyKey,
        deliver: false,
        channel: "webchat",
      },
      timeoutMs: 10_000,
    });

    const runId = agentResponse?.runId || idempotencyKey;

    // Step 2: Wait for agent to complete
    await callGateway<{ status?: string }>({
      method: "agent.wait",
      params: { runId, timeoutMs: VOICE_TURN_MAX_MS },
      timeoutMs: VOICE_TURN_MAX_MS + 5_000,
    });

    // Step 3: Get the response from session history
    const historyResponse = await callGateway<{
      messages?: Array<{
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
        provider?: string;
        model?: string;
      }>;
    }>({
      method: "chat.history",
      params: { sessionKey, limit: 5 },
      timeoutMs: 5_000,
    });

    // Find the last assistant message
    let responseText = "";
    let errorSurface = "";
    const messages = historyResponse?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        const content = msg.content;
        if (typeof content === "string") {
          responseText = content;
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === "string") {
              responseText = part;
              break;
            } else if (part && typeof part === "object" && "text" in part) {
              responseText = String((part as { text: unknown }).text);
              break;
            }
          }
        }
        // If the LLM call errored, surface that as the spoken reply
        // instead of returning silent — the previous behavior made
        // model outages feel like the voice pipeline was broken.
        if (!responseText.trim() && msg.stopReason === "error") {
          const upstream = (msg.errorMessage ?? "").toString().slice(0, 120);
          const modelLabel = [msg.provider, msg.model].filter(Boolean).join("/") || "model";
          errorSurface = `The ${modelLabel} backend returned an error. ${upstream}`;
        }
        break;
      }
    }

    const finalText = responseText.trim() || errorSurface;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        response: finalText,
        model: "infinibot",
        silent: !finalText,
      }),
    );

    return true;
  } catch (err: any) {
    console.error("[VoiceChat] Error:", err.message);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        response: "",
        model: "infinibot",
        silent: true,
      }),
    );
    return true;
  }
}
