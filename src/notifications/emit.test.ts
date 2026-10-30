/**
 * End-to-end chain test for the notification system:
 *   emitNotification → history row inserted → broadcaster fired →
 *   history.list returns the row → unread count increments → markRead works.
 *
 * Uses a temp directory per test so the singleton store is isolated.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import path from "path";
import { mkdirSync, rmSync } from "fs";
import { emitNotification, setNotificationBroadcaster } from "./emit.js";
import { getNotificationHistoryStore, resetNotificationHistoryStore } from "./history-store.js";

describe("notification emit → history chain", () => {
  let testDir: string;
  let broadcasts: Array<{ event: string; payload: unknown }>;

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `notif-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(testDir, { recursive: true });
    resetNotificationHistoryStore();
    broadcasts = [];
    setNotificationBroadcaster((event, payload) => {
      broadcasts.push({ event, payload });
    });
  });

  afterEach(() => {
    resetNotificationHistoryStore();
    // Reset broadcaster to a no-op so other tests aren't affected
    setNotificationBroadcaster(() => {});
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("emitNotification returns a string id and inserts a history row", async () => {
    const id = await emitNotification({
      category: "manual",
      title: "Hello",
      body: "World",
      source: "test-suite",
      stateDir: testDir,
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(4);

    const store = getNotificationHistoryStore(testDir);
    const entry = store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.title).toBe("Hello");
    expect(entry!.body).toBe("World");
    expect(entry!.category).toBe("manual");
    expect(entry!.source).toBe("test-suite");
    expect(entry!.severity).toBe("info"); // default
    expect(typeof entry!.ts).toBe("number");
    expect(entry!.readByToken).toEqual([]);
    expect(entry!.dismissedByToken).toEqual([]);
    expect(entry!.ackByToken).toEqual([]);
  });

  it("emitNotification broadcasts notification.created with correct shape", async () => {
    await emitNotification({
      category: "agent.completed",
      severity: "success",
      title: "Agent done",
      body: "Task complete",
      source: "coder",
      stateDir: testDir,
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].event).toBe("notification.created");

    const payload = broadcasts[0].payload as Record<string, unknown>;
    expect(payload.title).toBe("Agent done");
    expect(payload.body).toBe("Task complete");
    expect(payload.category).toBe("agent.completed");
    expect(payload.severity).toBe("success");
    expect(payload.source).toBe("coder");
    expect(typeof payload.id).toBe("string");
    expect(typeof payload.ts).toBe("number");
  });

  it("notifications.history.list returns inserted row", async () => {
    await emitNotification({
      category: "kanban.task.due",
      title: "Deploy v2",
      body: "Due today",
      source: "kanban",
      stateDir: testDir,
    });

    const store = getNotificationHistoryStore(testDir);
    const result = store.list({ limit: 10 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Deploy v2");
    expect(result.nextCursor).toBeNull();
  });

  it("unread count increments after each emit", async () => {
    const store = getNotificationHistoryStore(testDir);
    expect(store.unreadCount("test-device")).toBe(0);

    await emitNotification({ category: "manual", title: "One", body: "", stateDir: testDir });
    expect(store.unreadCount("test-device")).toBe(1);

    await emitNotification({ category: "manual", title: "Two", body: "", stateDir: testDir });
    expect(store.unreadCount("test-device")).toBe(2);
  });

  it("markRead removes entry from unread count", async () => {
    const id = await emitNotification({
      category: "manual",
      title: "Mark me",
      body: "Check unread",
      stateDir: testDir,
    });
    const store = getNotificationHistoryStore(testDir);
    expect(store.unreadCount("tok-1")).toBe(1);

    store.markRead([id], "tok-1");
    expect(store.unreadCount("tok-1")).toBe(0);

    // markRead is per-token — another token still sees it as unread
    expect(store.unreadCount("tok-2")).toBe(1);
  });

  it("dismiss hides entry from list for that token", async () => {
    const id = await emitNotification({
      category: "manual",
      title: "Dismiss me",
      body: "",
      stateDir: testDir,
    });
    const store = getNotificationHistoryStore(testDir);
    store.dismiss([id], "tok-1");

    const result = store.list({ limit: 10, filters: { token: "tok-1" } });
    expect(result.items.find((e) => e.id === id)).toBeUndefined();

    // Still visible to another token
    const result2 = store.list({ limit: 10, filters: { token: "tok-2" } });
    expect(result2.items.find((e) => e.id === id)).toBeDefined();
  });

  it("multiple emits give correct total count", async () => {
    for (let i = 0; i < 5; i++) {
      await emitNotification({
        category: "manual",
        title: `Item ${i}`,
        body: "",
        stateDir: testDir,
      });
    }
    const store = getNotificationHistoryStore(testDir);
    const result = store.list({ limit: 10 });
    expect(result.total).toBe(5);
    expect(store.unreadCount("any-token")).toBe(5);
  });

  it("broadcast fires once per emit, not more", async () => {
    await emitNotification({ category: "manual", title: "A", body: "", stateDir: testDir });
    await emitNotification({ category: "manual", title: "B", body: "", stateDir: testDir });
    expect(broadcasts).toHaveLength(2);
    expect((broadcasts[0].payload as any).title).toBe("A");
    expect((broadcasts[1].payload as any).title).toBe("B");
  });

  it("no broadcaster set → emit still inserts row without throwing", async () => {
    setNotificationBroadcaster(() => {});
    const id = await emitNotification({
      category: "manual",
      title: "No broadcast",
      body: "",
      stateDir: testDir,
    });
    const store = getNotificationHistoryStore(testDir);
    expect(store.get(id)).not.toBeNull();
  });

  it("emitNotification with displayTitle + summary mirrors them into data + broadcast", async () => {
    const id = await emitNotification({
      category: "agent.completed",
      severity: "success",
      title: "Sub-agent finished: Mobile Library glassmorphism revamp",
      body: "completed in 4m 12s · 3 files changed",
      source: "agent",
      displayTitle: "Sub-agent finished: Mobile Library glassmorphism revamp",
      summary: "completed in 4m 12s · 3 files changed",
      data: { runId: "coder-mobile-library-x9y2", phase: "complete", duration: 252000 },
      stateDir: testDir,
    });

    // History row carries the mirrored fields in `data`.
    const store = getNotificationHistoryStore(testDir);
    const entry = store.get(id);
    expect(entry).not.toBeNull();
    expect(entry!.data?.displayTitle).toBe(
      "Sub-agent finished: Mobile Library glassmorphism revamp",
    );
    expect(entry!.data?.summary).toBe("completed in 4m 12s · 3 files changed");

    // Broadcast carries displayTitle + summary at the top level too.
    expect(broadcasts).toHaveLength(1);
    const payload = broadcasts[0].payload as Record<string, unknown>;
    expect(payload.displayTitle).toBe("Sub-agent finished: Mobile Library glassmorphism revamp");
    expect(payload.summary).toBe("completed in 4m 12s · 3 files changed");
    // Backwards-compat: legacy title is still the primary humanized string.
    expect(payload.title).toBe("Sub-agent finished: Mobile Library glassmorphism revamp");
  });

  it("emitNotification without displayTitle leaves data untouched", async () => {
    const id = await emitNotification({
      category: "manual",
      title: "Plain",
      body: "Plain body",
      data: { existing: true },
      stateDir: testDir,
    });
    const store = getNotificationHistoryStore(testDir);
    const entry = store.get(id);
    expect(entry!.data?.displayTitle).toBeUndefined();
    expect(entry!.data?.summary).toBeUndefined();
    expect(entry!.data?.existing).toBe(true);
    // Broadcast still exposes the optional fields as null sentinels so
    // consumers can do `payload.displayTitle ?? payload.title`.
    const payload = broadcasts[0].payload as Record<string, unknown>;
    expect(payload.displayTitle).toBeNull();
    expect(payload.summary).toBeNull();
  });

  it("byCategorySummary reflects emitted notifications", async () => {
    await emitNotification({
      category: "agent.completed",
      title: "Run 1",
      body: "",
      stateDir: testDir,
    });
    await emitNotification({
      category: "agent.completed",
      title: "Run 2",
      body: "",
      stateDir: testDir,
    });
    await emitNotification({
      category: "kanban.task.due",
      title: "Task 1",
      body: "",
      stateDir: testDir,
    });

    const store = getNotificationHistoryStore(testDir);
    const summary = store.byCategorySummary("week");
    const agentEntry = summary.find((s) => s.category === "agent.completed");
    expect(agentEntry?.count).toBe(2);
    const kanbanEntry = summary.find((s) => s.category === "kanban.task.due");
    expect(kanbanEntry?.count).toBe(1);
  });
  it("normalizes deepLink and derives the web opener URL (push/broadcast/history)", async () => {
    const prev = process.env.INFINIBOT_PUBLIC_URL;
    process.env.INFINIBOT_PUBLIC_URL = "https://ib.example.com";
    try {
      const id = await emitNotification({
        category: "chat.mentions",
        title: "Hi",
        body: "there",
        deepLink: "mobile://chat?sessionKey=agent%3Amain%3Amain",
        stateDir: testDir,
      });
      const payload = broadcasts[0].payload as { deepLink: string; webUrl: string | null };
      expect(payload.deepLink).toBe("infinibot://chat/agent%3Amain%3Amain");
      expect(payload.webUrl).toBe("https://ib.example.com/m/chat/agent%3Amain%3Amain");
      const entry = getNotificationHistoryStore(testDir).get(id)!;
      expect(entry.deepLink).toBe("infinibot://chat/agent%3Amain%3Amain");
      expect(entry.data?.webUrl).toBe("https://ib.example.com/m/chat/agent%3Amain%3Amain");
    } finally {
      if (prev === undefined) delete process.env.INFINIBOT_PUBLIC_URL;
      else process.env.INFINIBOT_PUBLIC_URL = prev;
    }
  });
});
