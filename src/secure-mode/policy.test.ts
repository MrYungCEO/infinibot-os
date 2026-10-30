import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import {
  assertSecureModelAllowed,
  checkSecureModel,
  checkSecureModelAsync,
  checkSecureTool,
  filterToolsForSecureSession,
  SecureModeBlockedError,
} from "./policy.js";
import { isSecureSessionKey, newSecureSessionKey } from "./session-key.js";
import { HostLocalityChecker, setHostLocalityCheckerForTests } from "./host-locality.js";

// Hermetic host: loopback, docker0 172.17.0.1, LAN 192.168.1.13. No real DNS.
beforeAll(() => {
  setHostLocalityCheckerForTests(
    new HostLocalityChecker({
      interfaces: () => ({
        lo: [{ address: "127.0.0.1", family: "IPv4" } as never],
        docker0: [{ address: "172.17.0.1", family: "IPv4" } as never],
        wlo1: [{ address: "192.168.1.13", family: "IPv4" } as never],
      }),
      hostname: () => "testbox",
      lookup: async (h) => {
        if (h === "ollama.com") return ["34.1.2.3"];
        if (h === "openrouter.ai") return ["104.18.2.3"];
        throw new Error("ENOTFOUND");
      },
    }),
  );
});
afterAll(() => setHostLocalityCheckerForTests(null));

const SECURE = "agent:main:secure-abc123";
const cfg = {
  models: {
    providers: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", models: [] },
      "ollama-cloud": { baseUrl: "https://ollama.com/v1", models: [] },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [] },
      vllm: { baseUrl: "http://localhost:8000/v1", models: [] },
      lan: { baseUrl: "http://192.168.1.50:11434/v1", models: [] },
    },
  },
} as unknown as InfinibotConfig;

describe("secure session keys", () => {
  it("recognises secure 1:1, group and member keys only", () => {
    expect(isSecureSessionKey(SECURE)).toBe(true);
    expect(isSecureSessionKey(newSecureSessionKey("ops"))).toBe(true);
    expect(isSecureSessionKey("agent:main:groupchat-sec-abc1")).toBe(true);
    expect(isSecureSessionKey("agent:dev:gcmember-sec-abc1")).toBe(true);
    expect(isSecureSessionKey("agent:main:secure-x:thread:1")).toBe(true);
    expect(isSecureSessionKey("agent:main:main")).toBe(false);
    expect(isSecureSessionKey("agent:main:webchat-secure")).toBe(false);
    expect(isSecureSessionKey("agent:main:groupchat-abc1")).toBe(false);
    expect(isSecureSessionKey(undefined)).toBe(false);
  });
});

describe("Secure Mode model resolution", () => {
  it.each([
    ["anthropic", "claude-opus-4-6", undefined],
    ["openai", "gpt-5", undefined],
    ["google", "gemini-3-pro", undefined],
    ["openrouter", "x-ai/grok", undefined],
    ["ollama-cloud", "gpt-oss:120b", undefined],
    ["ollama", "llama3", "https://ollama.com/v1"],
    ["claude-cli", "opus", undefined],
    ["codex-cli", "gpt-5", undefined],
  ])("blocks remote %s/%s", async (provider, modelId, baseUrl) => {
    const res = checkSecureModel({ provider, modelId, baseUrl, cfg });
    expect(res.allowed).toBe(false);
    await expect(
      assertSecureModelAllowed({ sessionKey: SECURE, provider, modelId, baseUrl, cfg }),
    ).rejects.toThrow(SecureModeBlockedError);
    await expect(
      assertSecureModelAllowed({ sessionKey: SECURE, provider, modelId, baseUrl, cfg }),
    ).rejects.toThrow(/Blocked by Secure Mode/);
  });

  it.each([
    ["ollama", "huihui_ai/Qwen3.8-abliterated:latest", undefined],
    ["vllm", "qwen", undefined],
    ["custom", "m", "http://[::1]:9000/v1"],
    ["custom", "m", "http://127.0.0.5:9000/v1"],
  ])("allows local %s/%s", async (provider, modelId, baseUrl) => {
    expect(checkSecureModel({ provider, modelId, baseUrl, cfg }).allowed).toBe(true);
    await expect(
      assertSecureModelAllowed({ sessionKey: SECURE, provider, modelId, baseUrl, cfg }),
    ).resolves.toBeUndefined();
  });

  it("LAN hosts only count as local when the owner lists them", () => {
    expect(checkSecureModel({ provider: "lan", modelId: "m", cfg }).allowed).toBe(false);
    const withLan = { ...cfg, secureMode: { localHosts: ["192.168.1.50"] } } as InfinibotConfig;
    expect(checkSecureModel({ provider: "lan", modelId: "m", cfg: withLan }).allowed).toBe(true);
    const withAllowed = {
      ...cfg,
      secureMode: { allowedModelHosts: ["192.168.1.50"] },
    } as InfinibotConfig;
    expect(checkSecureModel({ provider: "lan", modelId: "m", cfg: withAllowed }).allowed).toBe(
      true,
    );
  });

  it("the Docker bridge gateway on this machine is local (the vllm-local case)", async () => {
    const vllm = {
      models: { providers: { "vllm-local": { baseUrl: "http://172.17.0.1:8010/v1", models: [] } } },
    } as unknown as InfinibotConfig;
    const res = await checkSecureModelAsync({
      provider: "vllm-local",
      modelId: "qwen3.8-27b",
      cfg: vllm,
    });
    expect(res.allowed).toBe(true);
    await expect(
      assertSecureModelAllowed({
        sessionKey: SECURE,
        provider: "vllm-local",
        modelId: "qwen3.8-27b",
        cfg: vllm,
      }),
    ).resolves.toBeUndefined();
  });

  it("never constrains normal sessions", async () => {
    await expect(
      assertSecureModelAllowed({
        sessionKey: "agent:main:main",
        provider: "anthropic",
        modelId: "x",
        cfg,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("Secure Mode tool allowlist", () => {
  const tool = (name: string) => ({ name });
  const all = [
    "read",
    "write",
    "edit",
    "exec",
    "process",
    "web_fetch",
    "web_search",
    "web_read",
    "browser",
    "message",
    "telegram_send",
    "gmail",
    "mcp",
    "research",
    "claude_coder",
    "codex_coder",
    "opencode_coder",
    "sessions_spawn",
    "flypic_generate_image",
    "kanban",
    "notes",
    "memory_search",
    "secure_lane",
    "session_status",
  ].map(tool);

  it("keeps only local-only tools for secure sessions", () => {
    expect(filterToolsForSecureSession(all, SECURE).map((t) => t.name)).toEqual([
      "read",
      "secure_lane",
    ]);
  });

  it("leaves normal sessions untouched", () => {
    expect(filterToolsForSecureSession(all, "agent:main:main")).toHaveLength(all.length);
  });

  it("reports a clear blocked reason for network tools", () => {
    for (const name of [
      "web_fetch",
      "web_search",
      "gmail",
      "telegram_send",
      "message",
      "mcp",
      "research",
      "flypic_generate_image",
    ]) {
      const res = checkSecureTool(name);
      expect(res.allowed).toBe(false);
      expect(res.allowed ? "" : res.reason).toMatch(/^Blocked by Secure Mode/);
    }
  });

  it("owner allowTools can add local tools but never network ones", () => {
    const c = {
      secureMode: { allowTools: ["write", "web_fetch", "flypic_generate_image", "mcp_foo"] },
    } as InfinibotConfig;
    expect(checkSecureTool("write", c).allowed).toBe(true);
    expect(checkSecureTool("web_fetch", c).allowed).toBe(false);
    expect(checkSecureTool("flypic_generate_image", c).allowed).toBe(false);
    expect(checkSecureTool("mcp_foo", c).allowed).toBe(false);
  });
});
