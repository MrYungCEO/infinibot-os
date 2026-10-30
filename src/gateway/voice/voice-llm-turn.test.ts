import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resolveTurnTrust } from "../../routing/sender-trust.js";
import {
  buildCliInvocation,
  clearVoiceCliSessionsForTests,
  cliBinEnvName,
  parseCliStreamLine,
  runCliVoiceTurn,
  runGatewayVoiceTurn,
  runVoiceLlmTurn,
  voiceCallSessionKey,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
} from "./voice-llm-turn.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-llm-turn-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Fake Claude Code CLI: logs its argv, streams stream-json deltas, keeps a session id. */
function fakeClaude(): string {
  const p = path.join(tmp, "fake-claude.mjs");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(tmp, "argv.log"))}, JSON.stringify(args) + "\\n");
const msg = args[args.indexOf("-p") + 1];
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: resume ?? "sess-123" });
for (const w of ["You ", "said: ", msg, resume ? " (resumed)" : ""]) {
  if (w) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } });
}
out({ type: "assistant", message: { content: [{ type: "text", text: "You said: " + msg }] } });
out({ type: "result", result: "You said: " + msg, session_id: resume ?? "sess-123" });
`,
    { mode: 0o755 },
  );
  return p;
}

const base = (over: Partial<VoiceLlmTurnRequest> = {}): VoiceLlmTurnRequest => ({
  agentId: "main",
  backend: "gateway",
  message: "hello there",
  callKey: "loc-1:robopark-room",
  provider: "robovoice",
  callerIsOwner: false,
  onDelta: () => {},
  ...over,
});

beforeEach(() => clearVoiceCliSessionsForTests());

describe("voice-call trust (W5)", () => {
  it("a voice caller is an untrusted sender; an owner-authenticated caller is owner", () => {
    const caller = voiceCallSessionKey(base());
    expect(caller).toBe("agent:main:voicecall:robovoice:loc-1_robopark-room");
    expect(resolveTurnTrust({ sessionKey: caller })).toMatchObject({
      level: "untrusted-sender",
      trusted: false,
    });
    const owner = voiceCallSessionKey(base({ callerIsOwner: true }));
    expect(owner).toBe("agent:main:voicecall-owner:robovoice:loc-1_robopark-room");
    expect(resolveTurnTrust({ sessionKey: owner })).toMatchObject({
      level: "owner",
      trusted: true,
    });
    // Even with a webchat provider, the voicecall key decides.
    expect(resolveTurnTrust({ sessionKey: caller, messageProvider: "webchat" }).trusted).toBe(
      false,
    );
    // Regular sessions unchanged.
    expect(resolveTurnTrust({ sessionKey: "agent:main:main" }).level).toBe("operator");
  });
});

describe("gateway backend", () => {
  it("runs the agent on the voicecall session, streams assistant deltas and measures first token", async () => {
    let listener:
      | ((e: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void)
      | null = null;
    const seen: Array<Record<string, unknown>> = [];
    const deps: GatewayTurnDeps = {
      onAgentEvent: (l) => {
        listener = l;
        return () => (listener = null);
      },
      runAgent: async (o) => {
        seen.push(o);
        listener?.({ runId: "someone-else", stream: "assistant", data: { delta: "NOPE" } });
        await new Promise((r) => setTimeout(r, 15));
        for (const d of ["Hi ", "there."])
          listener?.({ runId: o.runId, stream: "assistant", data: { delta: d } });
        listener?.({ runId: o.runId, stream: "tool", data: { name: "web_search" } });
        return { payloads: [{ text: "Hi there." }] };
      },
    };
    const deltas: string[] = [];
    const r = await runGatewayVoiceTurn(base({ onDelta: (t) => deltas.push(t) }), deps);
    expect(deltas).toEqual(["Hi ", "there."]);
    expect(r).toMatchObject({
      text: "Hi there.",
      backend: "gateway",
      trust: "caller",
      sessionKey: "agent:main:voicecall:robovoice:loc-1_robopark-room",
    });
    expect(r.firstTokenMs).toBeGreaterThanOrEqual(10);
    expect(seen[0]).toMatchObject({
      agentId: "main",
      message:
        "[Live voice call, the caller is not verified as the owner. Reply in one to three short spoken sentences.]\nhello there",
      sessionKey: r.sessionKey,
    });
    expect(String(seen[0].extraSystemPrompt)).toContain("NOT the owner");
    expect(listener).toBeNull(); // unsubscribed
  });

  it("speaks the final payload when the model didn't stream", async () => {
    const deltas: string[] = [];
    const r = await runGatewayVoiceTurn(
      base({ onDelta: (t) => deltas.push(t), callerIsOwner: true }),
      {
        onAgentEvent: () => () => {},
        runAgent: async () => ({ payloads: [{ text: "Done." }, { text: "Anything else?" }] }),
      },
    );
    expect(deltas.join("")).toBe("Done. Anything else?");
    expect(r.trust).toBe("owner");
  });
});

describe("CLI backends", () => {
  it("streams a fake Claude Code turn, then resumes the same CLI session on the next turn of the call", async () => {
    const bin = fakeClaude();
    const deltas: string[] = [];
    const env = { ...process.env, [cliBinEnvName("claude-code")]: bin };
    const r1 = await runCliVoiceTurn(
      base({ backend: "claude-code", onDelta: (t) => deltas.push(t) }) as VoiceLlmTurnRequest & {
        backend: "claude-code";
      },
      { env, cwd: tmp },
    );
    expect(r1.text).toBe("You said: hello there");
    expect(deltas).toEqual(["You ", "said: ", "hello there"]); // assistant/result repeats ignored
    expect(r1.cliSessionId).toBe("sess-123");
    expect(r1.firstTokenMs).not.toBeNull();
    const r2 = await runVoiceLlmTurn(base({ backend: "claude-code", message: "again" }), {
      cli: { env, cwd: tmp },
    });
    expect(r2.text).toBe("You said: again (resumed)");
    const argv = fs
      .readFileSync(path.join(tmp, "argv.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(argv[0]).toContain("--disallowedTools"); // untrusted caller: no shell/edit tools
    expect(argv[0]).not.toContain("--dangerously-skip-permissions");
    expect(argv[1].slice(argv[1].indexOf("--resume"), argv[1].indexOf("--resume") + 2)).toEqual([
      "--resume",
      "sess-123",
    ]);
    // A different call does not resume that session.
    const r3 = await runCliVoiceTurn(
      base({ backend: "claude-code", callKey: "other-call" }) as VoiceLlmTurnRequest & {
        backend: "claude-code";
      },
      { env, cwd: tmp },
    );
    expect(r3.text).not.toContain("resumed");
  });

  it("fails loudly when the CLI is missing or exits without text", async () => {
    await expect(
      runCliVoiceTurn(base({ backend: "codex" }) as VoiceLlmTurnRequest & { backend: "codex" }, {
        resolveBin: () => undefined,
      }),
    ).rejects.toThrow(/CLI not found/);
    const bad = path.join(tmp, "bad.sh");
    fs.writeFileSync(bad, "#!/bin/sh\necho 'boom' >&2\nexit 3\n", { mode: 0o755 });
    await expect(
      runCliVoiceTurn(base({ backend: "gemini" }) as VoiceLlmTurnRequest & { backend: "gemini" }, {
        resolveBin: () => bad,
      }),
    ).rejects.toThrow(/gemini turn failed: boom/);
  });

  it("builds conservative argv per backend (no permission bypass for callers)", () => {
    const p = { bin: "x", message: "hi", system: "SYS", trusted: false };
    expect(buildCliInvocation("codex", p).args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "SYS\n\nCaller said: hi",
    ]);
    expect(buildCliInvocation("codex", { ...p, trusted: true, resume: "t1" }).args).toEqual([
      "exec",
      "resume",
      "t1",
      "--json",
      "--skip-git-repo-check",
      "hi",
    ]);
    expect(buildCliInvocation("gemini", p).args).toContain("--approval-mode");
    expect(buildCliInvocation("opencode", { ...p, resume: "s1" }).args).toEqual([
      "run",
      "--format",
      "json",
      "--session",
      "s1",
      "hi",
    ]);
    for (const b of ["claude-code", "codex", "opencode", "gemini"] as const) {
      expect(buildCliInvocation(b, p).args.join(" ")).not.toMatch(/dangerously|yolo|bypass/);
    }
  });

  it("parses every CLI's stream shape", () => {
    expect(parseCliStreamLine('{"type":"thread.started","thread_id":"th1"}')).toEqual({
      sessionId: "th1",
    });
    expect(
      parseCliStreamLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hi"}}'),
    ).toEqual({ full: "Hi" });
    expect(parseCliStreamLine('{"type":"text","sessionID":"s","part":{"text":"Yo"}}')).toEqual({
      sessionId: "s",
      full: "Yo",
    });
    expect(
      parseCliStreamLine('{"type":"message","role":"assistant","content":"He","delta":true}'),
    ).toEqual({ delta: "He" });
    expect(parseCliStreamLine('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual({
      error: "quota",
    });
    expect(parseCliStreamLine("not json")).toBeNull();
  });
});
