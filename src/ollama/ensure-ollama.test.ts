import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetOllamaBootstrapForTests,
  ensureOllamaRunning,
  getLastOllamaStatus,
  resolveOllamaHost,
} from "./ensure-ollama.js";

function mockTags(models: string[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ models: models.map((name) => ({ name })) }),
  })) as unknown as typeof fetch;
}

describe("resolveOllamaHost", () => {
  const prevEnv = process.env.OLLAMA_HOST;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prevEnv;
  });

  it("defaults to local loopback", () => {
    delete process.env.OLLAMA_HOST;
    expect(resolveOllamaHost(undefined)).toBe("http://127.0.0.1:11434");
  });

  it("prefers providers.ollama.baseUrl and strips trailing slash", () => {
    const cfg = { providers: { ollama: { baseUrl: "http://gpu-box:11434/" } } } as never;
    expect(resolveOllamaHost(cfg)).toBe("http://gpu-box:11434");
  });

  it("accepts legacy integrations.ollama.host and bare host:port", () => {
    const cfg = { integrations: { ollama: { host: "10.0.0.5:11434" } } } as never;
    expect(resolveOllamaHost(cfg)).toBe("http://10.0.0.5:11434");
  });

  it("honours OLLAMA_HOST env", () => {
    process.env.OLLAMA_HOST = "192.0.2.7:11434";
    expect(resolveOllamaHost(undefined)).toBe("http://192.0.2.7:11434");
  });
});

describe("ensureOllamaRunning", () => {
  beforeEach(() => __resetOllamaBootstrapForTests());
  afterEach(() => {
    __resetOllamaBootstrapForTests();
    vi.restoreAllMocks();
  });

  it("reports running + models without autostarting when already healthy", async () => {
    vi.stubGlobal("fetch", mockTags(["qwen2.5:32b", "llama3.1:8b"]));
    const status = await ensureOllamaRunning({});
    expect(status.running).toBe(true);
    expect(status.startedByUs).toBe(false);
    expect(status.models).toEqual(["qwen2.5:32b", "llama3.1:8b"]);
    expect(getLastOllamaStatus()?.running).toBe(true);
  });

  it("caches the first ensure result (idempotent per process)", async () => {
    const fetchMock = mockTags(["qwen3:32b"]);
    vi.stubGlobal("fetch", fetchMock);
    const a = await ensureOllamaRunning({});
    const b = await ensureOllamaRunning({});
    expect(a).toBe(b);
  });
});
