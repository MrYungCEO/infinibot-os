/**
 * Group chats persist in the standard session store: they list like chats,
 * their transcript is read by chat.history, they survive a "restart" (a new
 * service over the same files), and sessions.delete removes member sessions.
 */
import { describe, expect, it, vi } from "vitest";

import { groupMemberKey } from "../../shared/group-chat/keys.js";
import { chatHandlers } from "../server-methods/chat.js";
import { groupChatHandlers, resetGroupChatServiceForTest } from "../server-methods/group-chat.js";
import { sessionsHandlers } from "../server-methods/sessions.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../server-methods/types.js";
import { loadSessionEntry } from "../session-utils.js";
import { GroupChatService } from "./service.js";
import { createSessionGroupChatStore } from "./store.js";

function fakeContext(broadcasts: Array<[string, unknown]>): GatewayRequestContext {
  return {
    broadcast: (event: string, payload: unknown) => broadcasts.push([event, payload]),
    nodeSendToSession: () => {},
    logGateway: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    loadGatewayModelCatalog: async () => [],
  } as unknown as GatewayRequestContext;
}

async function call(
  handlers: Record<string, (o: GatewayRequestHandlerOptions) => unknown>,
  method: string,
  params: Record<string, unknown>,
  context: GatewayRequestContext,
) {
  const respond = vi.fn();
  await handlers[method]({
    req: { id: "1", method, params } as GatewayRequestHandlerOptions["req"],
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context,
  });
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  return { ok, payload, error } as { ok: boolean; payload: any; error: any };
}

describe("group chat session-store persistence", () => {
  it("creates a group session, records attributed replies, and survives a restart", async () => {
    const store = createSessionGroupChatStore();
    const svc = new GroupChatService({
      store,
      runTurn: async (p) => ({ text: `hello from ${p.agentId}` }),
      emit: () => {},
    });
    const g = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main"],
      title: "Persisted room",
    });
    await svc.postUserMessage(g.key, "ping");
    await svc.idle(g.key);
    await svc.saveWorkflow(g.key, {
      id: "wf",
      name: "One step",
      nodes: [{ id: "n", agentId: "main", x: 1, y: 2 }],
      edges: [],
    });

    // "Gateway restart": a fresh store + service over the same files.
    const svc2 = new GroupChatService({
      store: createSessionGroupChatStore(),
      runTurn: async () => ({ text: "x" }),
      emit: () => {},
    });
    const d = svc2.describe(g.key);
    expect(d.title).toBe("Persisted room");
    expect(d.members.map((m) => m.id)).toEqual(["main"]);
    expect(d.workflows.map((w) => w.name)).toEqual(["One step"]);
    const msgs = createSessionGroupChatStore().readMessages(g.key);
    expect(msgs.map((m) => [m.role, m.content[0].text, m.groupChat?.agentId ?? null])).toEqual([
      ["user", "ping", null],
      ["assistant", "hello from main", "main"],
    ]);
    // Cursor persisted: the member has seen both messages.
    expect(store.getGroup(g.key)?.meta.cursors?.main).toBe(1);
  });

  it("works through the gateway methods: create → chat.history → sessions.list → rename → delete", async () => {
    const broadcasts: Array<[string, unknown]> = [];
    const ctx = fakeContext(broadcasts);
    resetGroupChatServiceForTest(
      new GroupChatService({
        store: createSessionGroupChatStore(),
        runTurn: async () => ({ text: "agent reply" }),
        emit: () => {},
      }),
    );
    const created = await call(
      groupChatHandlers as never,
      "groupchat.create",
      { members: ["main"], title: "Ops" },
      ctx,
    );
    expect(created.ok).toBe(true);
    const key = created.payload.key as string;
    expect(created.payload.group.mode).toBe("everyone");

    const bad = await call(
      groupChatHandlers as never,
      "groupchat.create",
      { members: ["nope"] },
      ctx,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/Unknown agent/);

    // chat.send on a group key is routed to the orchestrator.
    const sent = await call(
      chatHandlers as never,
      "chat.send",
      { sessionKey: key, message: "status?", idempotencyKey: "idem-1" },
      ctx,
    );
    expect(sent.ok).toBe(true);
    expect(sent.payload.agents).toEqual(["main"]);
    await vi.waitFor(async () => {
      const h = await call(chatHandlers as never, "chat.history", { sessionKey: key }, ctx);
      expect(h.payload.messages).toHaveLength(2);
    });
    const hist = await call(chatHandlers as never, "chat.history", { sessionKey: key }, ctx);
    expect(hist.payload.messages[1].groupChat).toMatchObject({ kind: "agent", agentId: "main" });

    const list = await call(
      sessionsHandlers as never,
      "sessions.list",
      { sessionPrefixes: ["groupchat-"], includeDerivedTitles: true },
      ctx,
    );
    expect(list.payload.sessions.map((s: { key: string }) => s.key)).toContain(key);
    expect(list.payload.sessions.find((s: { key: string }) => s.key === key).label).toBe("Ops");
    // Member sessions are not group sessions and don't match the chat-list prefix.
    const memberKey = groupMemberKey("main", key.split("groupchat-")[1]);
    expect(list.payload.sessions.map((s: { key: string }) => s.key)).not.toContain(memberKey);
    expect(loadSessionEntry(memberKey).entry?.label).toBe("Ops · main");

    const renamed = await call(
      sessionsHandlers as never,
      "sessions.patch",
      { key, label: "Ops 2" },
      ctx,
    );
    expect(renamed.ok).toBe(true);
    const got = await call(groupChatHandlers as never, "groupchat.get", { key }, ctx);
    expect(got.payload.title).toBe("Ops 2");

    const del = await call(sessionsHandlers as never, "sessions.delete", { key }, ctx);
    expect(del.ok).toBe(true);
    await vi.waitFor(() => expect(loadSessionEntry(memberKey).entry).toBeUndefined());
    const gone = await call(groupChatHandlers as never, "groupchat.get", { key }, ctx);
    expect(gone.ok).toBe(false);
    resetGroupChatServiceForTest(null);
  });
});
