import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveTurnTimeoutMs } from "../timeout.js";
import { isLocalModelTurn } from "../local-model-turn.js";
import { buildSecureSessionPromptNote } from "../secure-session-prompt.js";
import {
  appendTurnTimeoutNotice,
  buildTurnTimeoutNotice,
  summarizeToolText,
  TURN_TIMEOUT_MODEL,
} from "./turn-timeout.js";

const msgs = (list: unknown[]) => list as AgentMessage[];

describe("turn timeout notice", () => {
  it("lists the tool results gathered in this turn only", () => {
    const n = buildTurnTimeoutNotice({
      timeoutMs: 20 * 60_000,
      messages: msgs([
        { role: "user", content: "older" },
        { role: "toolResult", toolName: "old_tool", content: [{ type: "text", text: "stale" }] },
        { role: "user", content: "research these assets" },
        {
          role: "toolResult",
          toolName: "file_context",
          content: [{ type: "text", text: '{"count":16}' }],
        },
        {
          role: "toolResult",
          toolName: "video_analysis",
          isError: true,
          content: [{ type: "text", text: "x".repeat(1000) }],
        },
      ]),
    });
    expect(n.gathered).toBe(2);
    expect(n.text).toContain("longer than 20 min");
    expect(n.text).toContain("**file_context**");
    expect(n.text).toContain("**video_analysis** (error)");
    expect(n.text).not.toContain("old_tool");
    expect(n.text).toContain("Continue");
    expect(n.text.length).toBeLessThan(2000);
  });

  it("summarizes JSON tool results into readable one-liners", () => {
    expect(
      summarizeToolText(
        JSON.stringify({
          lane: "secure",
          count: 3,
          files: [{ id: "s_1", name: "a.jpg" }, { name: "b.jpg" }, { id: "s_3" }],
        }),
      ),
    ).toBe("3 files: a.jpg, b.jpg, s_3");
    expect(
      summarizeToolText(
        JSON.stringify({ id: "d1", title: "Report", content: "# Head\n\nBody **bold**" }),
      ),
    ).toBe("Report — Head Body bold");
    expect(summarizeToolText(JSON.stringify({ error: "locked" }))).toBe("error: locked");
    expect(summarizeToolText("plain   text\nhere")).toBe("plain text here");
  });

  it("says so when nothing was gathered", () => {
    const n = buildTurnTimeoutNotice({
      timeoutMs: 600_000,
      messages: msgs([{ role: "user", content: "hi" }]),
    });
    expect(n.gathered).toBe(0);
    expect(n.text).toContain("before any tool results");
  });

  it("appends a turn-timeout assistant message to the transcript", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: dir })}\n`,
    );
    expect(appendTurnTimeoutNotice({ sessionFile: file, text: "⏱ took too long" })).toBe(true);
    const rows = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const msg = rows.at(-1).message;
    expect(msg).toMatchObject({
      role: "assistant",
      provider: "infinibot",
      model: TURN_TIMEOUT_MODEL,
    });
    expect(msg.content[0].text).toBe("⏱ took too long");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("timed out before any reply: creates the transcript and records the prompt once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
    const file = path.join(dir, "ram", "s2.jsonl");
    expect(
      appendTurnTimeoutNotice({
        sessionFile: file,
        sessionId: "s2",
        prompt: "value my assets",
        text: "⏱ one",
      }),
    ).toBe(true);
    appendTurnTimeoutNotice({ sessionFile: file, prompt: "value my assets", text: "⏱ two" });
    const rows = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ type: "session", id: "s2" });
    const roles = rows.slice(1).map((r) => r.message.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    // parent chain is intact (history rebuilds from it)
    expect(rows[2].parentId).toBe(rows[1].id);
    expect(rows[3].parentId).toBe(rows[2].id);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("local-model turns", () => {
  it("default timeout becomes the local one; explicit timeouts win", () => {
    expect(resolveTurnTimeoutMs({ timeoutMs: 600_000, local: true })).toBe(1_200_000);
    expect(resolveTurnTimeoutMs({ timeoutMs: 600_000, local: false })).toBe(600_000);
    expect(resolveTurnTimeoutMs({ timeoutMs: 90_000, local: true })).toBe(90_000);
    const cfg = { agents: { defaults: { localTimeoutSeconds: 1800 } } } as never;
    expect(resolveTurnTimeoutMs({ cfg, timeoutMs: 600_000, local: true })).toBe(1_800_000);
    const short = { agents: { defaults: { localTimeoutSeconds: 25 } } } as never;
    expect(resolveTurnTimeoutMs({ cfg: short, timeoutMs: 600_000, local: true })).toBe(25_000);
    const longDefault = { agents: { defaults: { timeoutSeconds: 3600 } } } as never;
    expect(resolveTurnTimeoutMs({ cfg: longDefault, timeoutMs: 3_600_000, local: true })).toBe(
      3_600_000,
    );
  });

  it("ollama on loopback and secure sessions are local; hosted providers are not", () => {
    expect(isLocalModelTurn({ provider: "ollama" })).toBe(true);
    expect(isLocalModelTurn({ provider: "openrouter" })).toBe(false);
    expect(isLocalModelTurn({ provider: "vllm-local", baseUrl: "http://127.0.0.1:8000/v1" })).toBe(
      true,
    );
    expect(isLocalModelTurn({ provider: "ollama", baseUrl: "https://ollama.com/v1" })).toBe(false);
    expect(isLocalModelTurn({ provider: "openrouter", sessionKey: "agent:main:secure-abc" })).toBe(
      true,
    );
  });

  it("secure prompt note: batch-first, and secure_research only when registered", () => {
    expect(
      buildSecureSessionPromptNote({ sessionKey: "agent:main:main", toolNames: [] }),
    ).toBeUndefined();
    const without = buildSecureSessionPromptNote({
      sessionKey: "agent:main:secure-x",
      toolNames: ["file_context"],
    })!;
    expect(without).toContain("digest");
    expect(without).not.toContain("secure_research");
    expect(without).toContain("not available in Secure Mode");
    const withTool = buildSecureSessionPromptNote({
      sessionKey: "agent:main:secure-x",
      toolNames: ["secure_research"],
    })!;
    expect(withTool).toContain("`secure_research`");
  });
});

describe("local thinking off", () => {
  it("adds reasoning_effort none for local Ollama only when thinking is off", async () => {
    const { wrapStreamFnThinkingOff } = await import("./local-thinking.js");
    const seen: Record<string, unknown>[] = [];
    const base = ((_m: unknown, _c: unknown, o: { onPayload?: (p: unknown) => void }) => {
      const payload: Record<string, unknown> = { model: "q" };
      o.onPayload?.(payload);
      seen.push(payload);
      return {} as never;
    }) as never;
    const off = wrapStreamFnThinkingOff({
      streamFn: base,
      provider: "ollama",
      thinkLevel: "off",
      local: true,
    })!;
    void off({} as never, {} as never, {} as never);
    expect(seen.at(-1)).toMatchObject({ reasoning_effort: "none" });
    const vllm = wrapStreamFnThinkingOff({ streamFn: base, provider: "vllm-local", local: true })!;
    void vllm({} as never, {} as never, {} as never);
    expect(seen.at(-1)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(
      wrapStreamFnThinkingOff({
        streamFn: base,
        provider: "ollama",
        thinkLevel: "high",
        local: true,
      }),
    ).toBeUndefined();
    expect(
      wrapStreamFnThinkingOff({ streamFn: base, provider: "openrouter", local: false }),
    ).toBeUndefined();
  });
});
