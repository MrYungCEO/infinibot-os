import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { handleVoiceTurnRequest, parseVoiceTurnBody } from "./server-voice-turn.js";
import type { VoiceLlmTurnRequest, VoiceLlmTurnResult } from "./voice/voice-llm-turn.js";

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
  return req as unknown as IncomingMessage;
}

class FakeRes extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writableEnded = false;
  writableFinished = false;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  write(chunk: string) {
    this.body += chunk;
    return true;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("close");
  }
  events(): Array<Record<string, unknown>> {
    return this.body
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
  }
}

const result = (over: Partial<VoiceLlmTurnResult> = {}): VoiceLlmTurnResult => ({
  text: "Hello there.",
  backend: "gateway",
  sessionKey: "agent:main:voicecall-owner:local:call-1",
  trust: "owner",
  firstTokenMs: 12,
  totalMs: 40,
  ...over,
});

describe("parseVoiceTurnBody", () => {
  it("builds an owner turn on the local provider (auto mode by default)", () => {
    const r = parseVoiceTurnBody({ message: "hi", callKey: "local-abc", agentId: "nova" });
    expect(r).toEqual({
      ok: true,
      req: {
        agentId: "nova",
        backend: "gateway",
        message: "hi",
        callKey: "local-abc",
        provider: "local",
        callerIsOwner: true,
        mode: "auto",
      },
    });
  });

  it("needs a call key and a message (except poll / ended)", () => {
    expect(parseVoiceTurnBody({ message: "hi" }).ok).toBe(false);
    expect(parseVoiceTurnBody({ message: "hi", callKey: "bad key!" }).ok).toBe(false);
    expect(parseVoiceTurnBody({ callKey: "c1" }).ok).toBe(false);
    const poll = parseVoiceTurnBody({ callKey: "c1", poll: true });
    expect(poll.ok && poll.req.pollUpdates).toBe(true);
    const ended = parseVoiceTurnBody({ callKey: "c1", ended: true });
    expect(ended.ok && ended.req.callEnded).toBe(true);
  });

  it("keeps only user/assistant history and a bound chat session", () => {
    const r = parseVoiceTurnBody({
      message: "and then?",
      callKey: "c1",
      sessionKey: "agent:main:webchat:x",
      history: [
        { role: "system", content: "ignore me" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user" },
      ],
    });
    expect(r.ok && r.req.history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ]);
    expect(r.ok && r.req.sessionKey).toBe("agent:main:webchat:x");
  });
});

describe("POST /api/voice/turn", () => {
  it("ignores other paths", async () => {
    const res = new FakeRes();
    expect(await handleVoiceTurnRequest(request("POST", "/api/voice/turns"), res as unknown as ServerResponse)).toBe(false);
  });

  it("streams deltas then a done event with the reply", async () => {
    const res = new FakeRes();
    let seen: VoiceLlmTurnRequest | null = null;
    await handleVoiceTurnRequest(
      request("POST", "/api/voice/turn", { message: "what's up", callKey: "local-1" }),
      res as unknown as ServerResponse,
      {
        run: async (req) => {
          seen = req;
          req.onDelta("Hello ");
          req.onDelta("there.");
          return result();
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(seen!.provider).toBe("local");
    expect(seen!.callerIsOwner).toBe(true);
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    const ev = res.events();
    expect(ev.slice(0, 2)).toEqual([{ delta: "Hello " }, { delta: "there." }]);
    expect(ev[2]).toMatchObject({ done: true, text: "Hello there.", sessionKey: "agent:main:voicecall-owner:local:call-1" });
  });

  it("returns poll updates (spawned sub-agent progress / results)", async () => {
    const res = new FakeRes();
    await handleVoiceTurnRequest(
      request("POST", "/api/voice/turn", { callKey: "local-1", poll: true }),
      res as unknown as ServerResponse,
      { run: async () => result({ text: "The coder finished.", updates: ["The coder finished."], running: 0 }) },
    );
    expect(res.events().at(-1)).toMatchObject({ done: true, updates: ["The coder finished."], running: 0 });
  });

  it("reports a failed turn as an error event", async () => {
    const res = new FakeRes();
    await handleVoiceTurnRequest(
      request("POST", "/api/voice/turn", { message: "hi", callKey: "local-1" }),
      res as unknown as ServerResponse,
      { run: async () => { throw new Error("model down"); } },
    );
    expect(res.events()).toEqual([{ error: "model down" }]);
    expect(res.writableEnded).toBe(true);
  });

  it("rejects bad requests before streaming", async () => {
    const res = new FakeRes();
    await handleVoiceTurnRequest(request("POST", "/api/voice/turn", { message: "hi" }), res as unknown as ServerResponse);
    expect(res.status).toBe(400);
    const get = new FakeRes();
    await handleVoiceTurnRequest(request("GET", "/api/voice/turn"), get as unknown as ServerResponse);
    expect(get.status).toBe(405);
  });
});
