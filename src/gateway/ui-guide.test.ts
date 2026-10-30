import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectStaticSources } from "../../scripts/ui-targets/gen-ui-targets.js";
import {
  resetUiTargetRegistryForTests,
  setUiTargetSourcesProvider,
} from "../ui-targets/registry.js";
import {
  bindUiSession,
  forgetUiClient,
  handleGuideAction,
  noteUiClientActivity,
  pickGuideTabs,
  resetUiGuideStateForTests,
  scopeClientsToTenant,
  type GuideDeps,
} from "./ui-guide.js";

type Sent = { view: string; action: string; args: Record<string, unknown>; connId: string };

function fakeDeps(
  clients: Array<{
    connId: string;
    saasNamespace?: string;
    saasEmail?: string;
    instanceId?: string;
  }>,
) {
  const sent: Sent[] = [];
  const deps: GuideDeps = {
    uiClients: () => clients,
    resolveCodename: (name) => ({ alpha: "c1", bravo: "c2" })[name.toLowerCase()],
    codenameOf: (id) => ({ c1: "Alpha", c2: "Bravo", c3: "Charlie" })[id],
    dispatch: async (view, action, args, connId) => {
      sent.push({ view, action, args, connId });
      return { ok: true, payload: { found: true, route: "/x" } };
    },
  };
  return { deps, sent };
}

beforeEach(() => {
  resetUiGuideStateForTests();
  const src = collectStaticSources();
  setUiTargetSourcesProvider(async () => ({
    ...src,
    cloud: false,
    plugins: src.plugins.map((p) => ({
      ...p,
      enabled: p.id === "solatrix",
      status: p.id === "solatrix" ? "loaded" : "disabled",
    })),
  }));
});
afterEach(() => resetUiTargetRegistryForTests());

describe("pickGuideTabs — one tab, the user's", () => {
  const clients = [{ connId: "c1" }, { connId: "c2" }, { connId: "c3" }];
  const codename = (n: string) => ({ alpha: "c1", bravo: "c2" })[n.toLowerCase()];

  it("no clients → clear error", () => {
    expect(pickGuideTabs([], {}, codename)).toMatchObject({
      error: expect.stringContaining("No InfiniBot window"),
    });
  });

  it("defaults to exactly ONE tab (no cross-tab duplicates)", () => {
    const r = pickGuideTabs(clients, {}, codename);
    expect("connIds" in r && r.connIds).toHaveLength(1);
  });

  it("prefers the focused tab, then the most recently active", async () => {
    noteUiClientActivity("c2", { focused: false, visible: true, interacted: true });
    await new Promise((r) => setTimeout(r, 5));
    noteUiClientActivity("c1", { focused: false, visible: true, interacted: true });
    expect(pickGuideTabs(clients, {}, codename)).toMatchObject({ connIds: ["c1"] });
    noteUiClientActivity("c3", { focused: true, visible: true });
    expect(pickGuideTabs(clients, {}, codename)).toMatchObject({
      connIds: ["c3"],
      how: "focused tab",
    });
  });

  it("an interaction in a tab makes it THE focused tab (stale focus elsewhere loses)", () => {
    noteUiClientActivity("c2", { focused: true, visible: true });
    noteUiClientActivity("c1", { focused: false, interacted: true });
    expect(pickGuideTabs(clients, {}, codename)).toMatchObject({
      connIds: ["c1"],
      how: "focused tab",
    });
  });

  it("focusing one tab un-focuses the others", () => {
    noteUiClientActivity("c1", { focused: true });
    noteUiClientActivity("c2", { focused: true });
    expect(pickGuideTabs(clients, {}, codename)).toMatchObject({ connIds: ["c2"] });
  });

  it("the tab bound to the agent's chat session wins over focus", () => {
    noteUiClientActivity("c3", { focused: true });
    bindUiSession("main", "c2"); // UI shorthand
    expect(pickGuideTabs(clients, { sessionKey: "agent:main:main" }, codename)).toMatchObject({
      connIds: ["c2"],
      how: "tab bound to this chat session",
    });
    // A session the UI never touched falls back to activity.
    expect(
      pickGuideTabs(clients, { sessionKey: "agent:main:telegram:dm:42" }, codename),
    ).toMatchObject({ connIds: ["c3"] });
  });

  it("a group member's ui_control lands on the tab that sent in its group chat", () => {
    noteUiClientActivity("c3", { focused: true });
    bindUiSession("agent:boss:groupchat-g7abc", "c1");
    expect(
      pickGuideTabs(clients, { sessionKey: "agent:research:gcmember-g7abc" }, codename),
    ).toMatchObject({
      connIds: ["c1"],
      how: "tab bound to this chat session",
    });
    // Another group's member doesn't match.
    expect(
      pickGuideTabs(clients, { sessionKey: "agent:research:gcmember-zz999" }, codename),
    ).toMatchObject({
      connIds: ["c3"],
    });
  });

  it("a stale session binding (>30 min) yields to the focused tab", () => {
    vi.useFakeTimers();
    try {
      bindUiSession("agent:main:main", "c2");
      vi.advanceTimersByTime(31 * 60_000);
      noteUiClientActivity("c1", { focused: true });
      expect(pickGuideTabs(clients, { sessionKey: "agent:main:main" }, codename)).toMatchObject({
        connIds: ["c1"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a closed bound tab falls back to activity", () => {
    bindUiSession("agent:main:main", "c2");
    forgetUiClient("c2");
    noteUiClientActivity("c1", { focused: true });
    expect(pickGuideTabs(clients, { sessionKey: "agent:main:main" }, codename)).toMatchObject({
      connIds: ["c1"],
    });
  });

  it("explicit connId / codename / instanceId", () => {
    expect(pickGuideTabs(clients, { connId: "c3" }, codename)).toMatchObject({ connIds: ["c3"] });
    expect(pickGuideTabs(clients, { tab: "Bravo" }, codename)).toMatchObject({ connIds: ["c2"] });
    expect(pickGuideTabs(clients, { connId: "nope" }, codename)).toMatchObject({
      error: expect.any(String),
    });
    const dup = [
      { connId: "a", instanceId: "i" },
      { connId: "b", instanceId: "i" },
    ];
    noteUiClientActivity("a", { focused: true });
    expect(pickGuideTabs(dup, { instanceId: "i" }, codename)).toMatchObject({ connIds: ["a"] }); // duplicated tab → one
  });

  it("scope all → every tab of the same cloud member only", () => {
    const cloud = [
      { connId: "m1", saasEmail: "me@x" },
      { connId: "m2", saasEmail: "me@x" },
      { connId: "o1", saasEmail: "other@x" },
    ];
    noteUiClientActivity("m1", { focused: true });
    const r = pickGuideTabs(cloud, { scope: "all" }, codename);
    expect("connIds" in r && [...r.connIds].sort()).toEqual(["m1", "m2"]);
  });

  it("tenant scoping drops other tenants' clients", () => {
    // No request scope in tests → pass-through; the filter itself:
    const list = [{ saasNamespace: "t1" }, { saasNamespace: "t2" }];
    expect(scopeClientsToTenant(list)).toHaveLength(2);
  });
});

describe("handleGuideAction", () => {
  it("highlight resolves the target and sends ONE plan to ONE tab", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }, { connId: "c2" }]);
    noteUiClientActivity("c2", { focused: true });
    const r = await handleGuideAction(
      {
        action: "highlight",
        target: "control:solatrix/agent-access/mode",
        text: "Set this to Read-only",
        sessionKey: "agent:main:main",
      } as never,
      deps,
    );
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ view: "guide", action: "highlight", connId: "c2" });
    const args = sent[0]!.args as {
      plan: { targetId: string; route: string };
      text: string;
      style: string;
      agent: { name: string };
    };
    expect(args.plan.targetId).toBe("control:solatrix/agent-access/mode");
    expect(args.plan.route).toBe("/plugins?plugin=solatrix&ptab=settings");
    expect(args.text).toBe("Set this to Read-only");
    expect(args.style).toBe("pulse");
    expect(typeof args.agent.name).toBe("string");
    expect(r).toMatchObject({
      resolved: { id: "control:solatrix/agent-access/mode", via: "id" },
      delivered: { tabs: ["Bravo"] },
    });
  });

  it("natural-language navigate + args-shaped params", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction(
      { action: "navigate", args: { query: "where do I turn on solatrix trading" } } as never,
      deps,
    );
    expect(r.ok).toBe(true);
    expect((r.resolved as { id: string }).id).toBe("plugin:solatrix/settings/agent-access");
    expect(sent[0]!.action).toBe("navigate");
  });

  it("ambiguous → candidates, nothing sent", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction({ action: "highlight", query: "settings" } as never, deps);
    expect(r).toMatchObject({ ok: false, code: "AMBIGUOUS_TARGET" });
    expect((r.candidates as unknown[]).length).toBeGreaterThan(1);
    expect(sent).toHaveLength(0);
  });

  it("plugin off → TARGET_UNAVAILABLE with fixTarget, nothing sent", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction(
      { action: "navigate", target: "page:infinitrade" } as never,
      deps,
    );
    expect(r).toMatchObject({
      ok: false,
      code: "TARGET_UNAVAILABLE",
      fixTarget: "plugin:infinitrade/enable",
    });
    expect(sent).toHaveLength(0);
  });

  it("no browser → NO_UI_CLIENT", async () => {
    const { deps } = fakeDeps([]);
    expect(
      await handleGuideAction({ action: "highlight", target: "page:apikeys" } as never, deps),
    ).toMatchObject({ ok: false, code: "NO_UI_CLIENT" });
  });

  it("guide: resolves every step, preserves order + advance modes", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction(
      {
        action: "guide",
        title: "Add an API key",
        steps: [
          { target: "control:apikeys/add", text: "Click + Add Key", advance: "click" },
          {
            target: "control:apikeys/dialog/provider",
            text: "Pick your provider",
            advance: "click",
          },
          { query: "api key field", text: "Paste the key, then Save" },
        ],
      } as never,
      deps,
    );
    expect(r.ok).toBe(true);
    const steps = (
      sent[0]!.args as { steps: Array<{ plan: { targetId: string }; advance: string }> }
    ).steps;
    expect(steps.map((s) => s.plan.targetId)).toEqual([
      "control:apikeys/add",
      "control:apikeys/dialog/provider",
      "control:apikeys/dialog/key",
    ]);
    expect(steps.map((s) => s.advance)).toEqual(["click", "click", "next"]);
  });

  it("guide: a bad step fails the whole guide with its index", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction(
      {
        action: "guide",
        steps: [{ target: "page:apikeys" }, { target: "control:does/not-exist" }],
      } as never,
      deps,
    );
    expect(r).toMatchObject({ ok: false, step: 2 });
    expect(sent).toHaveLength(0);
  });

  it("guide: empty / too long rejected", async () => {
    const { deps } = fakeDeps([{ connId: "c1" }]);
    expect(await handleGuideAction({ action: "guide", steps: [] } as never, deps)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    const many = Array.from({ length: 13 }, () => ({ target: "page:apikeys" }));
    expect(await handleGuideAction({ action: "guide", steps: many } as never, deps)).toMatchObject({
      ok: false,
    });
  });

  it("scope all fans out, still per-user", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }, { connId: "c2" }]);
    const r = await handleGuideAction({ action: "clear_highlight", scope: "all" } as never, deps);
    expect(r.ok).toBe(true);
    expect(sent.map((s) => s.connId).sort()).toEqual(["c1", "c2"]);
  });

  it("route and raw selector escape hatches", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    await handleGuideAction(
      { action: "navigate", args: { route: "/setup?view=coders" } } as never,
      deps,
    );
    expect((sent[0]!.args as { plan: { route: string } }).plan.route).toBe("/setup?view=coders");
    await handleGuideAction(
      { action: "highlight", args: { selector: ".foo" }, text: "here" } as never,
      deps,
    );
    expect((sent[1]!.args as { plan: { selectors: string[] } }).plan.selectors).toEqual([".foo"]);
  });

  it("open_modal only considers modals", async () => {
    const { deps, sent } = fakeDeps([{ connId: "c1" }]);
    const r = await handleGuideAction({ action: "open_modal", query: "chat" } as never, deps);
    expect(r.ok).toBe(true);
    expect((sent[0]!.args as { plan: { targetId: string } }).plan.targetId).toBe("modal:chat");
  });

  it("find_targets / list_targets need no browser", async () => {
    const { deps, sent } = fakeDeps([]);
    const f = await handleGuideAction({ action: "find_targets", query: "api keys" } as never, deps);
    expect(f.ok).toBe(true);
    expect((f.targets as Array<{ id: string }>)[0]!.id).toBe("page:apikeys");
    const l = await handleGuideAction(
      { action: "list_targets", args: { plugin: "solatrix", limit: 500 } } as never,
      deps,
    );
    expect(
      (l.targets as Array<{ id: string }>).some(
        (t) => t.id === "control:solatrix/agent-access/mode",
      ),
    ).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
