import { describe, expect, test } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

describe("gateway sessions patch", () => {
  test("persists elevatedLevel=off (does not clear)", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "off" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.elevatedLevel).toBe("off");
  });

  test("pins and unpins a session", async () => {
    const store: Record<string, SessionEntry> = {};
    const pinned = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:webchat-abc",
      patch: { pinned: true },
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.entry.pinned).toBe(true);

    store["agent:main:webchat-abc"] = pinned.entry;
    const unpinned = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:webchat-abc",
      patch: { pinned: false },
    });
    expect(unpinned.ok).toBe(true);
    if (!unpinned.ok) return;
    expect(unpinned.entry.pinned).toBeUndefined();
  });

  test("persists elevatedLevel=on", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "on" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": { elevatedLevel: "off" } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: null },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const store: Record<string, SessionEntry> = {};
    const res = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:main",
      patch: { elevatedLevel: "maybe" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain("invalid elevatedLevel");
  });

  test("clears auth overrides when model patch changes", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-5",
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      } as SessionEntry,
    };
    const res = await applySessionsPatchToStore({
      cfg: {} as InfinibotConfig,
      store,
      storeKey: "agent:main:main",
      patch: { model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: async () => [{ provider: "openai", id: "gpt-5.2" }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.providerOverride).toBe("openai");
    expect(res.entry.modelOverride).toBe("gpt-5.2");
    expect(res.entry.authProfileOverride).toBeUndefined();
    expect(res.entry.authProfileOverrideSource).toBeUndefined();
    expect(res.entry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  test("judges model defaults against the session's agent", async () => {
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [{ id: "main" }, { id: "opus", model: "anthropic/claude-opus-4-6" }],
      },
    } as unknown as InfinibotConfig;
    const catalog = async () => [
      { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
      { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
    ];
    // Picking the GLOBAL default on the opus agent must pin it, otherwise the
    // session would silently keep running the agent's own model.
    const store: Record<string, SessionEntry> = {};
    const pinned = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: "agent:opus:webchat-x",
      patch: { model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: catalog,
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.entry.providerOverride).toBe("openai");
    expect(pinned.entry.modelOverride).toBe("gpt-5.2");

    // Picking the agent's own model clears the override.
    store["agent:opus:webchat-x"] = pinned.entry;
    const cleared = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: "agent:opus:webchat-x",
      patch: { model: "anthropic/claude-opus-4-6" },
      loadGatewayModelCatalog: catalog,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.entry.modelOverride).toBeUndefined();
  });

  test("keeps the global default allowed on agents with their own model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: { "anthropic/claude-haiku-4-5": {} },
        },
        list: [{ id: "opus", model: "anthropic/claude-opus-4-6" }],
      },
    } as unknown as InfinibotConfig;
    const res = await applySessionsPatchToStore({
      cfg,
      store: {},
      storeKey: "agent:opus:webchat-y",
      patch: { model: "openai/gpt-5.2" },
      loadGatewayModelCatalog: async () => [
        { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
        { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.modelOverride).toBe("gpt-5.2");
  });
});
