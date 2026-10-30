import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { sliceHistoryPage } from "./server-methods/chat.js";
import { listSessionsFromStore } from "./session-utils.js";

const cfg = {
  session: { mainKey: "main" },
  agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
} as InfinibotConfig;

function chatStore(n: number): Record<string, SessionEntry> {
  const store: Record<string, SessionEntry> = {};
  for (let i = 0; i < n; i++) {
    store[`agent:main:webchat-${i}`] = {
      sessionId: `s-${i}`,
      updatedAt: 1_000 + i,
    } as SessionEntry;
  }
  store["agent:ops:quick-chat"] = { sessionId: "s-quick", updatedAt: 500 } as SessionEntry;
  store["agent:main:telegram:dm:42"] = { sessionId: "s-tg", updatedAt: 5_000 } as SessionEntry;
  return store;
}

describe("listSessionsFromStore paging", () => {
  test("offset + limit page through newest-first with total/hasMore", () => {
    const store = chatStore(7);
    const opts = { sessionPrefixes: ["webchat-"], limit: 3 };
    const p1 = listSessionsFromStore({
      cfg,
      storePath: "/tmp/s.json",
      store,
      opts: { ...opts, offset: 0 },
    });
    const p3 = listSessionsFromStore({
      cfg,
      storePath: "/tmp/s.json",
      store,
      opts: { ...opts, offset: 6 },
    });
    expect(p1.sessions.map((s) => s.key)).toEqual([
      "agent:main:webchat-6",
      "agent:main:webchat-5",
      "agent:main:webchat-4",
    ]);
    expect(p1.total).toBe(7);
    expect(p1.hasMore).toBe(true);
    expect(p3.sessions.map((s) => s.key)).toEqual(["agent:main:webchat-0"]);
    expect(p3.hasMore).toBe(false);
  });

  test("sessionPrefixes keeps only chat threads (not channel sessions)", () => {
    const res = listSessionsFromStore({
      cfg,
      storePath: "/tmp/s.json",
      store: chatStore(2),
      opts: { sessionPrefixes: ["webchat-", "quick-chat"] },
    });
    expect(res.sessions.map((s) => s.key).sort()).toEqual([
      "agent:main:webchat-0",
      "agent:main:webchat-1",
      "agent:ops:quick-chat",
    ]);
  });

  test("combines with agentId", () => {
    const res = listSessionsFromStore({
      cfg,
      storePath: "/tmp/s.json",
      store: chatStore(2),
      opts: { sessionPrefixes: ["webchat-", "quick-chat"], agentId: "ops" },
    });
    expect(res.sessions.map((s) => s.key)).toEqual(["agent:ops:quick-chat"]);
  });

  test("no paging params keeps the old response shape semantics", () => {
    const res = listSessionsFromStore({
      cfg,
      storePath: "/tmp/s.json",
      store: chatStore(3),
      opts: {},
    });
    expect(res.count).toBe(5);
    expect(res.hasMore).toBe(false);
  });
});

describe("listSessionsFromStore title search", () => {
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("search matches the first-message title when titles are requested", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-sess-search-"));
    const storePath = path.join(dir, "sessions.json");
    const write = (id: string, text: string) =>
      fs.writeFileSync(
        path.join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: "session", id })}\n${JSON.stringify({ message: { role: "user", content: text } })}\n`,
      );
    write("s-a", "Plan the quarterly roadmap");
    write("s-b", "Fix the login bug");
    const store: Record<string, SessionEntry> = {
      "agent:main:webchat-a": { sessionId: "s-a", updatedAt: 2 } as SessionEntry,
      "agent:main:webchat-b": { sessionId: "s-b", updatedAt: 1 } as SessionEntry,
    };
    const hit = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: { search: "roadmap", includeDerivedTitles: true },
    });
    expect(hit.sessions.map((s) => s.key)).toEqual(["agent:main:webchat-a"]);
    expect(hit.sessions[0]?.derivedTitle).toContain("roadmap");
    const keyOnly = listSessionsFromStore({ cfg, storePath, store, opts: { search: "roadmap" } });
    expect(keyOnly.sessions).toEqual([]);
  });
});

describe("sliceHistoryPage", () => {
  test("newest page without a cursor", () => {
    expect(sliceHistoryPage(250, 60)).toEqual({ start: 190, end: 250 });
    expect(sliceHistoryPage(10, 60)).toEqual({ start: 0, end: 10 });
  });

  test("page before a cursor, clamped", () => {
    expect(sliceHistoryPage(250, 60, 190)).toEqual({ start: 130, end: 190 });
    expect(sliceHistoryPage(250, 60, 40)).toEqual({ start: 0, end: 40 });
    expect(sliceHistoryPage(250, 60, 0)).toEqual({ start: 0, end: 0 });
    expect(sliceHistoryPage(250, 60, 999)).toEqual({ start: 190, end: 250 });
  });
});
