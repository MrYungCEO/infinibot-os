import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { agentSecretRef, setAgentSecret, TELEGRAM_BOT_TOKEN_KEY } from "./agent-secret-store.js";
import {
  resolveAgentCoderBackends,
  resolveAgentTelegramToken,
} from "./agent-integration-config.js";

function cfg(partial: unknown): InfinibotConfig {
  return partial as InfinibotConfig;
}

describe("resolveAgentCoderBackends", () => {
  it("defaults to claude-code with no agent entry and no global", () => {
    const r = resolveAgentCoderBackends(cfg({}), "main");
    expect(r.primary).toBe("claude-code");
    expect(r.fallback).toBeUndefined();
    expect(r.primaryExplicit).toBe(false);
  });

  it("uses the global coder.backend when the agent has no override", () => {
    const r = resolveAgentCoderBackends(cfg({ coder: { backend: "opencode" } }), "main");
    expect(r.primary).toBe("opencode");
  });

  it("prefers the agent's defaultCoderBackend over the global default", () => {
    const c = cfg({
      coder: { backend: "opencode" },
      agents: { list: [{ id: "main", defaultCoderBackend: "codex" }] },
    });
    expect(resolveAgentCoderBackends(c, "main").primary).toBe("codex");
  });

  it("lets an explicit call argument win over everything", () => {
    const c = cfg({ agents: { list: [{ id: "main", defaultCoderBackend: "codex" }] } });
    const r = resolveAgentCoderBackends(c, "main", "opencode");
    expect(r.primary).toBe("opencode");
    expect(r.primaryExplicit).toBe(true);
  });

  it("exposes the fallback only when it differs from the primary", () => {
    const same = cfg({
      agents: {
        list: [{ id: "main", defaultCoderBackend: "codex", fallbackCoderBackend: "codex" }],
      },
    });
    expect(resolveAgentCoderBackends(same, "main").fallback).toBeUndefined();

    const diff = cfg({
      agents: {
        list: [
          { id: "main", defaultCoderBackend: "claude-code", fallbackCoderBackend: "opencode" },
        ],
      },
    });
    const r = resolveAgentCoderBackends(diff, "main");
    expect(r.primary).toBe("claude-code");
    expect(r.fallback).toBe("opencode");
  });
});

describe("resolveAgentTelegramToken", () => {
  it("uses the agent's own token when its ref decrypts", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-int-"));
    const ref = agentSecretRef("main", TELEGRAM_BOT_TOKEN_KEY);
    setAgentSecret(ref, "agent-token", { stateDir });
    const c = cfg({
      channels: { telegram: { botToken: "global-token" } },
      agents: { list: [{ id: "main", telegramBotTokenRef: ref }] },
    });
    const r = resolveAgentTelegramToken(c, "main", { stateDir });
    expect(r.token).toBe("agent-token");
    expect(r.source).toBe("agent");
  });

  it("falls back to the global token when the agent has no ref", () => {
    const c = cfg({ channels: { telegram: { botToken: "global-token" } } });
    const r = resolveAgentTelegramToken(c, "main");
    expect(r.token).toBe("global-token");
    expect(r.source).toBe("global");
  });

  it("falls back to global when the agent ref has no stored secret", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "agent-int-"));
    const ref = agentSecretRef("main", TELEGRAM_BOT_TOKEN_KEY);
    const c = cfg({
      channels: { telegram: { botToken: "global-token" } },
      agents: { list: [{ id: "main", telegramBotTokenRef: ref }] },
    });
    const r = resolveAgentTelegramToken(c, "main", { stateDir });
    expect(r.token).toBe("global-token");
    expect(r.source).toBe("global");
  });

  it("reports none when neither agent nor global token exists", () => {
    // resolveTelegramToken also falls back to the TELEGRAM_BOT_TOKEN env var;
    // clear it so this asserts the truly-empty case deterministically.
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const r = resolveAgentTelegramToken(cfg({}), "main");
      expect(r.token).toBe("");
      expect(r.source).toBe("none");
    } finally {
      if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });
});
