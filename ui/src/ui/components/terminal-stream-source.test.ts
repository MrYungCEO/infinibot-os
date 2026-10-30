import { describe, expect, it, vi } from "vitest";
import {
  VOICE_CLI_MODE_KEY,
  canonicalTerminalId,
  fetchStreamSnapshot,
  mergeStreamSources,
  pickStreamSource,
  readVoiceCliSelection,
  setVoiceCliSelection,
  subscribeTerminalOutput,
  type StreamSource,
} from "./terminal-stream-source";

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

const src = (p: Partial<StreamSource> & { id: string }): StreamSource => ({
  kind: "terminal",
  title: p.id,
  backend: "shell",
  lastActiveAt: 0,
  active: false,
  pty: true,
  ...p,
});

describe("readVoiceCliSelection (integration point)", () => {
  it("reads the toggle's persisted value first", () => {
    const s = mem({ [VOICE_CLI_MODE_KEY]: JSON.stringify({ isCliMode: true, backend: "codex" }) });
    expect(readVoiceCliSelection(s)).toEqual({ isCliMode: true, backend: "codex", terminalId: null });
  });

  it("falls back to <agent-cli-selector>'s voice surface, then its default surface", () => {
    expect(readVoiceCliSelection(mem({ "infinibot.voice.cli-selector.voice": JSON.stringify({ kind: "cli", id: "opencode" }) }))).toEqual({
      isCliMode: true,
      backend: "opencode",
    });
    expect(readVoiceCliSelection(mem({ "infinibot.voice.cli-selector.default": JSON.stringify({ kind: "cli", id: "claude-code" }) }))).toEqual({
      isCliMode: true,
      backend: "claude-code",
    });
    expect(readVoiceCliSelection(mem({ "infinibot.voice.cli-selector.voice": JSON.stringify({ kind: "gateway", id: "gateway" }) }))).toEqual({ isCliMode: false });
  });

  it("nothing set → not CLI mode; garbage is ignored", () => {
    expect(readVoiceCliSelection(mem())).toEqual({ isCliMode: false });
    expect(readVoiceCliSelection(mem({ [VOICE_CLI_MODE_KEY]: "{nope" }))).toEqual({ isCliMode: false });
  });

  it("setVoiceCliSelection persists what readVoiceCliSelection returns", () => {
    const s = mem();
    setVoiceCliSelection({ isCliMode: true, backend: "codex", terminalId: "spawn-1" }, s);
    expect(readVoiceCliSelection(s)).toEqual({ isCliMode: true, backend: "codex", terminalId: "spawn-1" });
  });
});

describe("pickStreamSource", () => {
  const sources = [
    src({ id: "term-old", lastActiveAt: 100 }),
    src({ id: "term-new", lastActiveAt: 900 }),
    src({ id: "spawn-codex", kind: "coder", backend: "codex", lastActiveAt: 500, pty: false }),
    src({ id: "spawn-claude", kind: "coder", backend: "claude-code", lastActiveAt: 300, active: true, pty: false }),
  ];

  it("defaults to the working coder run, then the most recent", () => {
    expect(pickStreamSource(sources, { isCliMode: false })?.id).toBe("spawn-claude");
    expect(pickStreamSource(sources.filter((s) => !s.active), { isCliMode: false })?.id).toBe("term-new");
  });

  it("CLI mode follows the selected backend", () => {
    expect(pickStreamSource(sources, { isCliMode: true, backend: "codex" })?.id).toBe("spawn-codex");
    expect(pickStreamSource(sources, { isCliMode: true, backend: "claude" })?.id).toBe("spawn-claude");
    // backend with no source → most recent overall
    expect(pickStreamSource(sources, { isCliMode: true, backend: "gemini" })?.id).toBe("spawn-claude");
  });

  it("a pinned or explicit terminal wins (id forms term-1 / term_1 are the same)", () => {
    expect(pickStreamSource(sources, { isCliMode: true, backend: "codex" }, "term_old")?.id).toBe("term-old");
    expect(pickStreamSource(sources, { isCliMode: false, terminalId: "term-new" })?.id).toBe("term-new");
    expect(pickStreamSource(sources, { isCliMode: false }, "gone")?.id).toBe("spawn-claude");
    expect(pickStreamSource([], { isCliMode: false })).toBeNull();
  });
});

describe("mergeStreamSources", () => {
  it("merges terminal.list + listReattachable + subagents.list, de-duplicated by canonical id", () => {
    const out = mergeStreamSources(
      [{ id: "term-1", title: "repo shell", cliType: "claude", lastActiveAt: "2026-10-07T10:00:00Z" }],
      [
        { id: "term_1", kind: "cli", label: "term 1" },
        { id: "spawn_abc", kind: "cloud", runId: "run-abc", label: "spawn abc" },
      ],
      [{ runId: "run-abc", status: "working", lastUpdateAt: 1_800_000_000_000, label: "Fix login bug", coderBackend: "claude-code" }],
    );
    expect(out).toHaveLength(2);
    const term = out.find((s) => canonicalTerminalId(s.id) === "term_1")!;
    expect(term).toMatchObject({ id: "term-1", title: "repo shell", backend: "claude-code", kind: "terminal", pty: true });
    const coder = out.find((s) => s.id === "spawn_abc")!;
    expect(coder).toMatchObject({ kind: "coder", title: "Fix login bug", backend: "claude-code", active: true, pty: false, lastActiveAt: 1_800_000_000_000 });
  });
});

describe("fetchStreamSnapshot", () => {
  it("reads terminal.peek", async () => {
    const rpc = vi.fn(async () => ({ text: "hi", source: "tmux", alive: true })) as never;
    await expect(fetchStreamSnapshot(rpc, "spawn-1")).resolves.toEqual({ text: "hi", source: "tmux", alive: true });
  });
});

describe("subscribeTerminalOutput", () => {
  it("delivers only this terminal's terminal.output chunks", () => {
    let handler: ((e: { event: string; payload?: unknown }) => void) | null = null;
    const client = { subscribe: (h: typeof handler) => ((handler = h), () => (handler = null)) };
    const got: string[] = [];
    const off = subscribeTerminalOutput(client as never, "term-1", (d) => got.push(d));
    handler!({ event: "terminal.output", payload: { id: "term_1", data: "a" } });
    handler!({ event: "terminal.output", payload: { id: "term-2", data: "b" } });
    handler!({ event: "chat", payload: { id: "term-1", data: "c" } });
    expect(got).toEqual(["a"]);
    off();
    expect(handler).toBeNull();
  });
});
