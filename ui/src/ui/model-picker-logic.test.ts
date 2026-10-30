import { describe, expect, it } from "vitest";
import {
  createModelFilterState,
  freeBadgeTitle,
  isFreeModel,
  normalizeModelsList,
  normalizeProviderInfo,
  type ModelOption,
} from "./model-filter";
import {
  applyAllowlistChange,
  buildPickerSections,
  flattenSections,
  hasPaidProviderConnected,
  isMine,
  limitForIndex,
  loadOnlyMine,
  needsAllowlistAdd,
  OFFLINE_AUTO_EXPAND_MAX,
  offlineExpanded,
  ONLY_MINE_STORAGE_KEY,
  PICKER_PAGE_SIZE,
  saveOnlyMine,
  windowRows,
} from "./model-picker-logic";
import { announceSessionModel, onSessionModel } from "./session-model-sync";

function catalog(): ModelOption[] {
  return normalizeModelsList({
    models: [
      { id: "gpt-oss:120b", name: "GPT OSS 120b", provider: "ollama-cloud", contextWindow: 128_000, available: true, allowed: true },
      { id: "qwen3", name: "Qwen 3", provider: "ollama-cloud", contextWindow: 256_000, reasoning: true, available: true, allowed: true, pinned: true },
      { id: "deepseek", name: "DeepSeek", provider: "ollama-cloud", contextWindow: 64_000, available: true, allowed: false },
      { id: "meta/llama-4:free", name: "Llama 4 (free)", provider: "openrouter", contextWindow: 131_000, available: true, allowed: false, free: "free", freeSource: "OpenRouter models API (pricing 0)" },
      { id: "anthropic/claude-opus", name: "Claude Opus", provider: "openrouter", contextWindow: 1_000_000, reasoning: true, vision: true, available: true, allowed: false },
      { id: "openai/gpt-5", name: "GPT-5", provider: "openrouter", contextWindow: 400_000, vision: true, available: true, allowed: true, pinned: true },
      { id: "gemini-3", name: "Gemini 3", provider: "google", contextWindow: 1_000_000, vision: true, available: false, allowed: false },
      { id: "__setup__", name: "Ollama (local) — not connected", provider: "ollama", unconfigured: true },
    ],
  });
}

const ids = (list: ModelOption[]) => list.map((m) => m.id);

describe("model picker sections", () => {
  it("lists every usable model: allowlist on top, the rest grouped by provider", () => {
    const s = buildPickerSections(catalog(), createModelFilterState());
    expect(ids(s.mine)).toEqual(["ollama-cloud/gpt-oss:120b", "ollama-cloud/qwen3", "openrouter/openai/gpt-5"]);
    expect(s.groups.map((g) => [g.provider, ids(g.models)])).toEqual([
      ["ollama-cloud", ["ollama-cloud/deepseek"]],
      ["openrouter", ["openrouter/meta/llama-4:free", "openrouter/anthropic/claude-opus"]],
    ]);
    expect(s.total).toBe(6);
    // No credentials → listed as a provider to connect, never as a selectable row.
    expect(s.offline.map((o) => [o.provider, o.count, ids(o.models)])).toEqual([
      ["google", 1, ["google/gemini-3"]],
      ["ollama", 0, []],
    ]);
  });

  it("filters reach models outside the allowlist", () => {
    const f = createModelFilterState();
    f.provider = "openrouter";
    let s = buildPickerSections(catalog(), f);
    expect(ids(s.mine)).toEqual(["openrouter/openai/gpt-5"]);
    expect(ids(s.groups.flatMap((g) => g.models))).toEqual([
      "openrouter/meta/llama-4:free",
      "openrouter/anthropic/claude-opus",
    ]);

    const caps = createModelFilterState();
    caps.capabilities.add("reasoning");
    caps.capabilities.add("vision");
    s = buildPickerSections(catalog(), caps);
    expect(s.mine).toEqual([]);
    expect(ids(s.groups.flatMap((g) => g.models))).toEqual(["openrouter/anthropic/claude-opus"]);

    const free = createModelFilterState();
    free.capabilities.add("free");
    expect(ids(buildPickerSections(catalog(), free).groups.flatMap((g) => g.models))).toEqual([
      "openrouter/meta/llama-4:free",
    ]);

    const tier = createModelFilterState();
    tier.tier = "l";
    s = buildPickerSections(catalog(), tier);
    expect(s.total).toBe(3);
    expect(s.offline.map((o) => [o.provider, o.count])).toEqual([["google", 1]]);

    const search = createModelFilterState();
    search.search = "  CLAUDE ";
    expect(buildPickerSections(catalog(), search).total).toBe(1);
  });

  it("'only my models' keeps just the allowlist", () => {
    const s = buildPickerSections(catalog(), createModelFilterState(), { onlyMine: true });
    expect(s.mine).toHaveLength(3);
    expect(s.groups).toEqual([]);
    expect(s.offline).toEqual([]);
    expect(s.total).toBe(3);
  });

  it("has no 'Your models' section when no allowlist is configured", () => {
    const open = catalog().map((m) => ({ ...m, allowed: undefined, pinned: undefined }));
    const s = buildPickerSections(open, createModelFilterState());
    expect(s.mine).toEqual([]);
    expect(s.total).toBe(6);
    expect(open.some(needsAllowlistAdd)).toBe(false);
  });

  it("treats a model as free only when the gateway sourced it — never by its name", () => {
    expect(isFreeModel({ free: "free" })).toBe(true);
    expect(isFreeModel({ free: "free-tier" })).toBe(true);
    expect(isFreeModel({ free: "local" })).toBe(true);
    const [named] = normalizeModelsList({ models: [{ id: "big-pickle-free", name: "Big Pickle Free", provider: "opencode" }] });
    expect(isFreeModel(named)).toBe(false);
    const [bogus] = normalizeModelsList({ models: [{ id: "x", name: "X", provider: "p", free: "gratis" }] });
    expect(bogus.free).toBeUndefined();
  });
});

describe("model picker rows", () => {
  it("flattens to headers + rows with 'Your models' first", () => {
    const rows = flattenSections(buildPickerSections(catalog(), createModelFilterState()));
    expect(rows.map((r) => (r.kind === "head" ? `# ${r.label} ${r.count}` : r.model.id))).toEqual([
      "# Your models 3",
      "ollama-cloud/gpt-oss:120b",
      "ollama-cloud/qwen3",
      "openrouter/openai/gpt-5",
      "# ollama-cloud 1",
      "ollama-cloud/deepseek",
      "# openrouter 2",
      "openrouter/meta/llama-4:free",
      "openrouter/anthropic/claude-opus",
    ]);
  });

  it("caps rendering and reports what is still hidden", () => {
    const many: ModelOption[] = Array.from({ length: 425 }, (_, i) => ({
      id: `p${i % 5}/m${i}`,
      name: `Model ${i}`,
      provider: `p${i % 5}`,
      available: true,
      allowed: false,
    }));
    const rows = flattenSections(buildPickerSections(many, createModelFilterState()));
    const win = windowRows(rows, PICKER_PAGE_SIZE);
    expect(win.rows.filter((r) => r.kind === "model")).toHaveLength(PICKER_PAGE_SIZE);
    expect(win.hidden).toBe(425 - PICKER_PAGE_SIZE);
    expect(win.rows.at(-1)?.kind).toBe("model");
    expect(windowRows(rows, 1000).hidden).toBe(0);
  });

  it("grows the window to reach a keyboard-selected row", () => {
    expect(limitForIndex(10, PICKER_PAGE_SIZE)).toBe(PICKER_PAGE_SIZE);
    expect(limitForIndex(PICKER_PAGE_SIZE, PICKER_PAGE_SIZE)).toBe(PICKER_PAGE_SIZE * 2);
    expect(limitForIndex(424, PICKER_PAGE_SIZE)).toBe(480);
  });
});

describe("not-connected providers", () => {
  it("stay collapsed until opened, but a narrow search shows their matches", () => {
    const toggled = new Map<string, boolean>();
    const google = { provider: "google", count: 3 };
    expect(offlineExpanded(google, { filtered: false, toggled })).toBe(false);
    expect(offlineExpanded(google, { filtered: true, toggled })).toBe(true);
    expect(offlineExpanded({ provider: "big", count: OFFLINE_AUTO_EXPAND_MAX + 1 }, { filtered: true, toggled })).toBe(false);
    expect(offlineExpanded({ provider: "ollama", count: 0 }, { filtered: true, toggled })).toBe(false);
    toggled.set("google", false);
    expect(offlineExpanded(google, { filtered: true, toggled })).toBe(false);
    toggled.set("big", true);
    expect(offlineExpanded({ provider: "big", count: 200 }, { filtered: false, toggled })).toBe(true);
  });
});

describe("allowlist bookkeeping", () => {
  it("flags only models the gateway would reject", () => {
    const list = catalog();
    expect(needsAllowlistAdd(list.find((m) => m.id === "ollama-cloud/deepseek"))).toBe(true);
    expect(needsAllowlistAdd(list.find((m) => m.id === "ollama-cloud/qwen3"))).toBe(false);
    expect(needsAllowlistAdd(undefined)).toBe(false);
  });

  it("moves a model into and out of 'Your models'", () => {
    let list = applyAllowlistChange(catalog(), "ollama-cloud/deepseek", "add");
    const added = list.find((m) => m.id === "ollama-cloud/deepseek")!;
    expect(isMine(added)).toBe(true);
    expect(needsAllowlistAdd(added)).toBe(false);
    list = applyAllowlistChange(list, "ollama-cloud/deepseek", "remove");
    expect(isMine(list.find((m) => m.id === "ollama-cloud/deepseek")!)).toBe(false);
  });

  it("the first pin on an open catalog makes the rest need adding", () => {
    const open = catalog().map((m) => ({ ...m, allowed: undefined, pinned: undefined }));
    const list = applyAllowlistChange(open, "ollama-cloud/qwen3", "add");
    expect(ids(list.filter(isMine))).toEqual(["ollama-cloud/qwen3"]);
    expect(needsAllowlistAdd(list.find((m) => m.id === "ollama-cloud/deepseek"))).toBe(true);
  });

  it("remembers the 'only my models' toggle", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(loadOnlyMine(storage)).toBe(false);
    saveOnlyMine(storage, true);
    expect(data.get(ONLY_MINE_STORAGE_KEY)).toBe("1");
    expect(loadOnlyMine(storage)).toBe(true);
    expect(loadOnlyMine(null)).toBe(false);
  });
});

describe("session model sync", () => {
  it("delivers changes to other surfaces and skips the sender's own echo", () => {
    const target = new EventTarget();
    const a = {};
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    const offA = onSessionModel((c) => seenByA.push(`${c.sessionKey}=${c.model}`), { ignoreSource: a, target });
    const offB = onSessionModel((c) => seenByB.push(`${c.sessionKey}=${c.model}`), { target });
    announceSessionModel({ sessionKey: "agent:main:quick-chat", model: "openrouter/x:free", source: a }, target);
    announceSessionModel({ sessionKey: "agent:main:quick-chat", model: null }, target);
    expect(seenByA).toEqual(["agent:main:quick-chat=null"]);
    expect(seenByB).toEqual(["agent:main:quick-chat=openrouter/x:free", "agent:main:quick-chat=null"]);
    offA();
    offB();
    announceSessionModel({ sessionKey: "agent:main:quick-chat", model: "a/b" }, target);
    expect(seenByB).toHaveLength(2);
  });
});

describe("free highlights", () => {
  const res = {
    models: [
      { id: "gpt-5", name: "GPT-5", provider: "openai", available: false },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", available: false, free: "free-tier", freeNote: "Free tier.", freeSource: "https://ai.google.dev/gemini-api/docs/pricing (verified 2026-10-01)" },
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", provider: "google", available: false },
      { id: "anthropic/claude", name: "Claude", provider: "openrouter", available: true },
      { id: "x/y:free", name: "Y", provider: "openrouter", available: true, free: "free" },
      { id: "qwen3", name: "Qwen 3", provider: "ollama", available: true, free: "local" },
      { id: "big", name: "Big", provider: "aaa-paid", available: true },
      { id: "__setup__", name: "LM Studio — not connected", provider: "lmstudio", unconfigured: true },
    ],
    providers: [
      { id: "google", available: false, free: { kind: "free-tier", label: "Free tier", note: "n", source: "s", verified: "2026-10-01", keyUrl: "https://aistudio.google.com/apikey", count: 1 } },
      { id: "openrouter", available: true, free: { kind: "free", label: "Free models", note: "n", source: "s", count: 1 } },
      { id: "ollama", available: true, free: { kind: "local", label: "Local", note: "n", source: "s", count: 1 } },
      { id: "lmstudio", free: { kind: "local", label: "Local", note: "n", source: "s", count: 0 } },
      { id: "openai", available: false },
      { id: "bogus", free: { kind: "gratis", label: "?", note: "", source: "", count: 0 } },
    ],
  };
  const models = normalizeModelsList(res);
  const info = normalizeProviderInfo(res);

  it("carries the gateway's free kind, note and source through normalization", () => {
    const gem = models.find((m) => m.id === "google/gemini-3.8-flash")!;
    expect(gem.free).toBe("free-tier");
    expect(freeBadgeTitle(gem)).toContain("Source: https://ai.google.dev/gemini-api/docs/pricing");
    expect(freeBadgeTitle({ free: undefined })).toBe("");
    expect(info.get("google")?.free?.label).toBe("Free tier");
    expect(info.get("bogus")?.free).toBeUndefined();
  });

  it("the Free filter keeps free, free-tier and local models — connected or not", () => {
    const f = createModelFilterState();
    f.capabilities.add("free");
    const s = buildPickerSections(models, f, { providerInfo: info });
    expect(ids(s.groups.flatMap((g) => g.models))).toEqual(["ollama/qwen3", "openrouter/x/y:free"]);
    // Not-connected free-tier provider stays visible with only its free model;
    // a free (local) provider with no models yet keeps its connect row.
    expect(s.offline.map((o) => [o.provider, ids(o.models)])).toEqual([
      ["google", ["google/gemini-3.8-flash"]],
      ["lmstudio", []],
    ]);
  });

  it("lists not-connected providers with a free option before paid-only ones", () => {
    const s = buildPickerSections(models, createModelFilterState(), { providerInfo: info });
    expect(s.offline.map((o) => o.provider)).toEqual(["google", "lmstudio", "openai"]);
  });

  it("puts free providers and models first only when no paid provider is connected", () => {
    expect(hasPaidProviderConnected(models)).toBe(true);
    const alpha = buildPickerSections(models, createModelFilterState(), { providerInfo: info });
    expect(alpha.groups.map((g) => g.provider)).toEqual(["aaa-paid", "ollama", "openrouter"]);
    expect(ids(alpha.groups[2].models)).toEqual(["openrouter/anthropic/claude", "openrouter/x/y:free"]);

    const freeOnly = models.filter((m) => m.provider !== "aaa-paid" && m.id !== "openrouter/anthropic/claude");
    expect(hasPaidProviderConnected(freeOnly)).toBe(false);

    const first = buildPickerSections(models, createModelFilterState(), { providerInfo: info, freeFirst: true });
    expect(first.groups.map((g) => g.provider)).toEqual(["ollama", "openrouter", "aaa-paid"]);
    expect(ids(first.groups[1].models)).toEqual(["openrouter/x/y:free", "openrouter/anthropic/claude"]);
  });

  it("flags provider-rejected models and their suggested replacement", () => {
    const [gone] = normalizeModelsList({
      models: [{ id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", provider: "google", unavailable: true, suggestion: "google/gemini-2.5-flash" }],
    });
    expect(gone.unavailable).toBe(true);
    expect(gone.suggestion).toBe("google/gemini-2.5-flash");
  });

  it("stays fast on a 900-model catalog", () => {
    const big = normalizeModelsList({
      models: Array.from({ length: 900 }, (_, i) => ({
        id: `m-${i}`,
        name: `Model ${i}`,
        provider: `p${i % 24}`,
        available: i % 3 !== 0,
        ...(i % 7 === 0 ? { free: "free" } : {}),
      })),
    });
    const f = createModelFilterState();
    f.capabilities.add("free");
    const t = performance.now();
    for (let i = 0; i < 50; i++) flattenSections(buildPickerSections(big, f, { freeFirst: true, providerInfo: info }));
    expect((performance.now() - t) / 50).toBeLessThan(20);
  });
});
