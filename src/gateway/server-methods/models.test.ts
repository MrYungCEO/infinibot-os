import { describe, expect, test } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { InfinibotConfig } from "../../config/config.js";
import { annotateModelAccess, planAllowlistChange, resolveProviderAvailability } from "./models.js";

describe("models.list provider availability", () => {
  test("marks providers with a credential or a local endpoint as available", () => {
    const cfg = {
      models: {
        providers: {
          "keyed-prov": { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", models: [] },
          "local-prov": { baseUrl: "http://127.0.0.1:11434/v1", models: [] },
        },
      },
    } as unknown as InfinibotConfig;
    const store = {
      version: 1,
      profiles: {
        "profiled-prov:default": { type: "api_key", provider: "profiled-prov", key: "k" },
      },
    } as unknown as AuthProfileStore;
    const res = resolveProviderAvailability(
      ["keyed-prov", "local-prov", "profiled-prov", "nokey-prov-zz"],
      cfg,
      store,
    );
    expect(res.get("keyed-prov")).toBe(true);
    expect(res.get("local-prov")).toBe(true);
    expect(res.get("profiled-prov")).toBe(true);
    expect(res.get("nokey-prov-zz")).toBe(false);
  });

  test("flags models outside the allowlist (default stays allowed)", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: { "openai/gpt-5-mini": {} },
        },
      },
    } as unknown as InfinibotConfig;
    const catalog = [
      { provider: "openai", id: "gpt-5.2", name: "a" },
      { provider: "openai", id: "gpt-5-mini", name: "b" },
      { provider: "openai", id: "gpt-4o", name: "c" },
    ];
    const rows = catalog.map((m) => ({ id: m.id, provider: m.provider })) as Array<{
      id: string;
      provider: string;
      allowed?: boolean;
    }>;
    annotateModelAccess(rows, catalog, cfg, {
      version: 1,
      profiles: {},
    } as unknown as AuthProfileStore);
    expect(rows.map((r) => r.allowed)).toEqual([true, true, false]);
  });

  test("leaves allowed unset when no allowlist is configured", () => {
    const catalog = [{ provider: "openai", id: "gpt-4o", name: "c" }];
    const rows = [{ id: "gpt-4o", provider: "openai" }] as Array<{
      id: string;
      provider: string;
      allowed?: boolean;
    }>;
    annotateModelAccess(
      rows,
      catalog,
      {} as InfinibotConfig,
      { version: 1, profiles: {} } as unknown as AuthProfileStore,
    );
    expect(rows[0].allowed).toBeUndefined();
  });
});

describe("models.allowlist planning", () => {
  const catalog = [
    { provider: "openai", id: "gpt-5.2", name: "a" },
    { provider: "openai", id: "gpt-5-mini", name: "b" },
    { provider: "openrouter", id: "meta/llama:free", name: "c" },
  ];
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.2" },
        models: { "openai/gpt-5-mini": { alias: "mini" } },
      },
    },
  } as unknown as InfinibotConfig;

  test("adds a catalog model as a merge patch that keeps existing entries", () => {
    const plan = planAllowlistChange({
      cfg,
      catalog,
      action: "add",
      model: "openrouter/meta/llama:free",
    });
    expect(plan).toEqual({
      ok: true,
      key: "openrouter/meta/llama:free",
      changed: true,
      patch: { agents: { defaults: { models: { "openrouter/meta/llama:free": {} } } } },
    });
  });

  test("adding an already listed model is a no-op", () => {
    const plan = planAllowlistChange({ cfg, catalog, action: "add", model: "openai/gpt-5-mini" });
    expect(plan).toMatchObject({ ok: true, changed: false, patch: null });
  });

  test("rejects models the allowlist could not honour", () => {
    const plan = planAllowlistChange({ cfg, catalog, action: "add", model: "nope/ghost-model" });
    expect(plan.ok).toBe(false);
  });

  test("removes by normalized key and ignores unlisted models", () => {
    expect(
      planAllowlistChange({ cfg, catalog, action: "remove", model: "openai/gpt-5-mini" }),
    ).toEqual({
      ok: true,
      key: "openai/gpt-5-mini",
      changed: true,
      patch: { agents: { defaults: { models: { "openai/gpt-5-mini": null } } } },
    });
    expect(
      planAllowlistChange({ cfg, catalog, action: "remove", model: "openai/gpt-5.2" }),
    ).toMatchObject({ ok: true, changed: false });
  });

  test("models.list rows carry pinned for explicitly listed models only", () => {
    const rows = catalog.map((m) => ({ id: m.id, provider: m.provider })) as Array<{
      id: string;
      provider: string;
      allowed?: boolean;
      pinned?: boolean;
    }>;
    annotateModelAccess(rows, catalog, cfg, {
      version: 1,
      profiles: {},
    } as unknown as AuthProfileStore);
    expect(rows.map((r) => [r.allowed, r.pinned])).toEqual([
      [true, undefined],
      [true, true],
      [false, undefined],
    ]);
  });
});
