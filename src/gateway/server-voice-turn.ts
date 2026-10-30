/**
 * POST /api/voice/turn — one turn of a LOCAL voice call (the built-in voice
 * provider). The Voice page's local engine does speech-to-text and
 * text-to-speech on this machine (/api/voice/stt, /api/voice/tts) and sends
 * each transcribed utterance here; the reply streams back as SSE so speech
 * can start on the first sentence.
 *
 * It runs the same seam every voice provider uses (runVoiceLlmTurn), so a
 * local call gets exactly what a Robovoice call gets:
 *   - direct CLI mode   the Voice page's routing switch (voice.cliRoute.*)
 *                       sends the turn straight into the selected Claude Code /
 *                       Codex / OpenCode session; its reply is spoken back with
 *                       no relay narration (voice-cli-turn.ts)
 *   - gateway agent     the selected InfiniBot agent answers (fast path for
 *                       conversation, the full agent with tools for work);
 *                       spawned sub-agents report back through the call's
 *                       progress hub, which `{ poll: true }` drains
 *
 * The route is protected (gateway credential), so the caller is the owner.
 *
 * Body: { message, agentId?, callKey, sessionKey?, mode?, history?, poll?, ended? }
 * SSE:  { delta } … then { done: true, text, sessionKey, updates?, running?, timings? }
 *       or { error }
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  VoiceLlmTurnRequest,
  VoiceLlmTurnResult,
  VoiceTurnMessage,
} from "./voice/voice-llm-turn.js";

export const VOICE_TURN_PATH = "/api/voice/turn";
/** Provider id local calls run under (part of the call's session key). */
export const LOCAL_VOICE_TURN_PROVIDER = "local";

type TurnRunner = (req: VoiceLlmTurnRequest) => Promise<VoiceLlmTurnResult>;

export type VoiceTurnBody = {
  message?: unknown;
  agentId?: unknown;
  callKey?: unknown;
  sessionKey?: unknown;
  mode?: unknown;
  history?: unknown;
  poll?: unknown;
  ended?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Validate the body into a turn request (minus onDelta/signal). Exported for tests. */
export function parseVoiceTurnBody(
  body: VoiceTurnBody,
): { ok: true; req: Omit<VoiceLlmTurnRequest, "onDelta"> } | { ok: false; error: string } {
  const callKey = str(body.callKey);
  if (!callKey || callKey.length > 200 || !/^[\w.:-]+$/.test(callKey)) {
    return { ok: false, error: "callKey required ([A-Za-z0-9_.:-], ≤200 chars)" };
  }
  const poll = body.poll === true;
  const ended = body.ended === true;
  const message = typeof body.message === "string" ? body.message.slice(0, 4000) : "";
  if (!poll && !ended && !message.trim()) return { ok: false, error: "message required" };
  const history: VoiceTurnMessage[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (m): m is VoiceTurnMessage =>
            !!m &&
            typeof m === "object" &&
            ((m as VoiceTurnMessage).role === "user" || (m as VoiceTurnMessage).role === "assistant") &&
            typeof (m as VoiceTurnMessage).content === "string",
        )
        .slice(-20)
    : [];
  const sessionKey = str(body.sessionKey);
  return {
    ok: true,
    req: {
      agentId: str(body.agentId) || "main",
      backend: "gateway",
      message,
      callKey,
      provider: LOCAL_VOICE_TURN_PROVIDER,
      // Protected route: only the gateway's own credential reaches it.
      callerIsOwner: true,
      mode: body.mode === "agent" ? "agent" : "auto",
      ...(history.length ? { history } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(poll ? { pollUpdates: true } : {}),
      ...(ended ? { callEnded: true } : {}),
    },
  };
}

export async function handleVoiceTurnRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { run?: TurnRunner } = {},
): Promise<boolean> {
  const url = req.url ?? "";
  if (url !== VOICE_TURN_PATH && !url.startsWith(`${VOICE_TURN_PATH}?`)) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256_000) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body too large" }));
      return true;
    }
  }
  let body: VoiceTurnBody;
  try {
    body = JSON.parse(raw || "{}") as VoiceTurnBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return true;
  }
  const parsed = parseVoiceTurnBody(body);
  if (!parsed.ok) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: parsed.error }));
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  // The caller hung up or spoke again (barge-in): abort the turn.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const run: TurnRunner =
    deps.run ?? (async (r) => (await import("./voice/voice-llm-turn.js")).runVoiceLlmTurn(r));
  try {
    const result = await run({
      ...parsed.req,
      signal: abort.signal,
      onDelta: (text) => {
        if (text) send({ delta: text });
      },
    });
    send({
      done: true,
      text: result.text,
      sessionKey: result.sessionKey,
      firstTokenMs: result.firstTokenMs,
      totalMs: result.totalMs,
      ...(result.updates ? { updates: result.updates } : {}),
      ...(typeof result.running === "number" ? { running: result.running } : {}),
      ...(result.timings ? { timings: result.timings } : {}),
    });
  } catch (err) {
    if (!abort.signal.aborted) {
      send({ error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
  return true;
}
