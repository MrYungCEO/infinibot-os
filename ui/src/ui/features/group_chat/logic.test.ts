import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  applyMention,
  filterMessages,
  initials,
  loadViewState,
  mentionQueryAt,
  mergeMessages,
  saveViewState,
  settingsSummary,
  shortModel,
  slashSuggestions,
  suggestMembers,
  supportsComposerParity,
  toApiAttachments,
  toDisplayMessages,
  type LiveTurn,
} from "./logic";

const members = [
  { id: "main", name: "Infini" },
  { id: "coder", name: "Coder" },
  { id: "qa", name: "Quality" },
];

describe("group chat display messages", () => {
  const raw = [
    { role: "user", content: [{ type: "text", text: "hi all" }], timestamp: 1, groupChat: { messageId: "u1", kind: "user" } },
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 2,
      groupChat: { messageId: "a1", kind: "agent", agentId: "coder", agentName: "Coder" },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Workflow started" }],
      timestamp: 3,
      groupChat: { messageId: "s1", kind: "status", workflowRunId: "run-1", workflowId: "wf" },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "step out" }],
      timestamp: 4,
      groupChat: { messageId: "a2", kind: "agent", agentId: "qa", workflowRunId: "run-1", workflowId: "wf" },
    },
    { role: "assistant", content: [{ type: "text", text: "   " }], timestamp: 5 },
    { role: "toolResult", content: "x", timestamp: 6 },
  ];

  it("maps attribution and drops empty / non-chat rows", () => {
    const d = toDisplayMessages(raw);
    expect(d.map((m) => [m.id, m.kind, m.agentId ?? null])).toEqual([
      ["u1", "user", null],
      ["a1", "agent", "coder"],
      ["s1", "status", null],
      ["a2", "agent", "qa"],
    ]);
  });

  it("filters by workflow run and merges live messages without duplicates", () => {
    const d = toDisplayMessages(raw);
    expect(filterMessages(d, { runId: "run-1" }).map((m) => m.id)).toEqual(["s1", "a2"]);
    expect(filterMessages(d, { workflowId: "wf" }).map((m) => m.id)).toEqual(["s1", "a2"]);
    expect(filterMessages(d, null)).toBe(d);
    const merged = mergeMessages(d, toDisplayMessages([raw[0], { ...raw[1], groupChat: { messageId: "a9", kind: "agent", agentId: "main" } }]));
    expect(merged.map((m) => m.id)).toEqual(["u1", "a1", "s1", "a2", "a9"]);
    expect(mergeMessages(d, [])).toBe(d);
  });
});

describe("@mention autocomplete", () => {
  it("detects the partial mention at the caret", () => {
    expect(mentionQueryAt("hey @co", 7)).toEqual({ start: 4, query: "co" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail a@co", 9)).toBeNull();
    expect(mentionQueryAt("hey @coder done", 15)).toBeNull();
  });

  it("suggests members by id or name prefix, plus @all", () => {
    expect(suggestMembers(members, "q").map((m) => m.id)).toEqual(["qa"]);
    expect(suggestMembers(members, "inf").map((m) => m.id)).toEqual(["main"]);
    expect(suggestMembers(members, "").map((m) => m.id)).toEqual(["main", "coder", "qa", "all"]);
    expect(suggestMembers(members, "zz")).toEqual([]);
  });

  it("replaces the partial with @id and moves the caret", () => {
    expect(applyMention("hey @co please", 4, 7, "coder")).toEqual({ text: "hey @coder please", caret: 11 });
  });
});

describe("live turns + misc", () => {
  it("streams delta text into the matching turn only", () => {
    const turns = new Map<string, LiveTurn>([["r1", { runId: "r1", agentId: "coder", memberKey: "agent:coder:gcmember-x", text: "" }]]);
    const same = applyChatEvent(turns, { runId: "other", state: "delta", message: { content: [{ type: "text", text: "x" }] } });
    expect(same).toBe(turns);
    const wrongSession = applyChatEvent(turns, { runId: "r1", sessionKey: "agent:main:webchat-1", state: "delta", message: { content: "x" } });
    expect(wrongSession).toBe(turns);
    const next = applyChatEvent(turns, {
      runId: "r1",
      sessionKey: "agent:coder:gcmember-x",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Hello wor" }] },
    });
    expect(next.get("r1")?.text).toBe("Hello wor");
    expect(turns.get("r1")?.text).toBe("");
  });

  it("initials and view-state round trip", () => {
    expect(initials("Head of Dev")).toBe("HO");
    expect(initials("coder")).toBe("CO");
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadViewState("k", s)).toEqual({ draft: "", scrollTop: null, runFilter: null, tab: "chat" });
    saveViewState("k", { draft: "half typed", scrollTop: 420, runFilter: "run-1", tab: "workflows" }, s);
    expect(loadViewState("k", s)).toEqual({ draft: "half typed", scrollTop: 420, runFilter: "run-1", tab: "workflows" });
    store.set("infinibot.groupchat.view.bad", "{not json");
    expect(loadViewState("bad", s).draft).toBe("");
  });
});

describe("group chat composer parity (images, panels, commands, settings)", () => {
  it("keeps image-only user messages and panel-only agent messages; exposes model + panels", () => {
    const panel = { v: 1, panelId: "p1", kind: "agents", query: {}, title: "Agents", display: "inline", summary: "", count: 1, empty: false, error: null, link: { tab: "agents", label: "Agents" }, refreshMs: 0, ts: 1 };
    const msgs = toDisplayMessages([
      { role: "user", content: [{ type: "text", text: "" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1, groupChat: { messageId: "u1", kind: "user" } },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }], timestamp: 2, groupChat: { messageId: "u2", kind: "user" } },
      { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 3, groupChat: { messageId: "a1", kind: "agent", agentId: "main", panels: [panel], model: "mock/fast" } },
      { role: "assistant", content: [{ type: "text", text: "" }], timestamp: 4, groupChat: { messageId: "a2", kind: "agent", agentId: "qa" } },
    ]);
    expect(msgs.map((m) => m.id)).toEqual(["u1", "u2", "a1"]);
    expect(msgs[0].images).toEqual(["data:image/png;base64,AAAA"]);
    expect(msgs[1].images).toEqual(["data:image/jpeg;base64,BBBB"]);
    expect(msgs[2].panels.map((p) => p.panelId)).toEqual(["p1"]);
    expect(msgs[2].model).toBe("mock/fast");
  });

  it("slash suggestions only while typing a bare /word", () => {
    expect(slashSuggestions("/").map((c) => c.name)).toEqual(["model", "think", "mode", "stop", "help"]);
    expect(slashSuggestions("/mo").map((c) => c.name)).toEqual(["model", "mode"]);
    expect(slashSuggestions("/model x")).toEqual([]);
    expect(slashSuggestions("hi /mo")).toEqual([]);
  });

  it("attachments use the chat.send wire shape; settings summary", () => {
    expect(toApiAttachments([
      { id: "1", dataUrl: "data:image/png;base64,QUJD", mimeType: "image/png" },
      { id: "2", dataUrl: "bogus", mimeType: "x" },
      {
        id: "3",
        dataUrl: "data:application/pdf;base64,JVBERg==",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        ocrId: "ocr_pdf",
        filePath: "chat-uploads/brief.pdf",
      },
      {
        id: "4",
        dataUrl: "data:video/mp4;base64,AAAA",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        ocrId: "ocr_video",
      },
    ])).toEqual([
      { type: "image", mimeType: "image/png", content: "QUJD" },
      {
        type: "document",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        ocrId: "ocr_pdf",
        filePath: "chat-uploads/brief.pdf",
      },
      { type: "video", mimeType: "video/mp4", fileName: "clip.mp4", ocrId: "ocr_video" },
    ]);
    expect(settingsSummary({ settings: {}, memberSettings: {} })).toBe("Agent defaults");
    expect(settingsSummary({ settings: { model: "openrouter/deepseek/v4", thinkingLevel: "high" }, memberSettings: { qa: { model: "x/y" } } })).toBe(
      "v4 · High thinking · 1 override",
    );
    expect(shortModel("mock/mock-fast")).toBe("mock-fast");
  });
});

describe("composer parity gating", () => {
  it("only gateways that return `settings` from groupchat.get get the new controls", () => {
    expect(supportsComposerParity(null)).toBe(false);
    expect(supportsComposerParity({} as never)).toBe(false);
    expect(supportsComposerParity({ settings: {} })).toBe(true);
  });
});
