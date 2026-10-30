import { describe, expect, it } from "vitest";

import {
  REDACTED_SENTINEL,
  isSensitiveConfigKey,
  redactConfigSnapshot,
  redactConfigValue,
  restoreRedactedValues,
} from "./config-redact.js";

const parsed = {
  gateway: { port: 18789, auth: { mode: "password", password: "hunter2-pw" } },
  channels: { telegram: { botToken: "123:abc", enabled: true } },
  models: { providers: { openai: { apiKey: "sk-live-1", baseUrl: "https://x" } } },
  env: { NOTION_API_KEY: "ntn_1", PLAIN: "visible" },
  agents: { defaults: { maxTokens: 4096 } },
};

describe("isSensitiveConfigKey", () => {
  it("flags secret-ish keys and leaves ordinary ones", () => {
    for (const k of [
      "password",
      "token",
      "botToken",
      "apiKey",
      "api_key",
      "NOTION_API_KEY",
      "clientSecret",
    ]) {
      expect(isSensitiveConfigKey(k), k).toBe(true);
    }
    for (const k of ["port", "maxTokens", "mode", "baseUrl", "enabled"]) {
      expect(isSensitiveConfigKey(k), k).toBe(false);
    }
  });
});

describe("redactConfigSnapshot", () => {
  const raw = JSON.stringify(parsed, null, 2);
  const redacted = redactConfigSnapshot({ raw, parsed, config: parsed, hash: "h" });

  it("removes every secret from raw, parsed and config", () => {
    const all = JSON.stringify(redacted);
    for (const secret of ["hunter2-pw", "123:abc", "sk-live-1", "ntn_1"]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain("visible");
    expect((redacted.parsed as typeof parsed).agents.defaults.maxTokens).toBe(4096);
    expect((redacted.config as typeof parsed).gateway.auth.password).toBe(REDACTED_SENTINEL);
    expect(redacted.hash).toBe("h");
  });

  it("round-trips: writing the redacted config back restores the secrets", () => {
    const edited = JSON.parse(redacted.raw as string);
    edited.gateway.port = 19000;
    const restored = restoreRedactedValues(edited, parsed);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const v = restored.value as typeof parsed;
    expect(v.gateway.auth.password).toBe("hunter2-pw");
    expect(v.channels.telegram.botToken).toBe("123:abc");
    expect(v.gateway.port).toBe(19000);
  });

  it("refuses a sentinel with no original at that path", () => {
    const restored = restoreRedactedValues(
      { channels: { discord: { token: REDACTED_SENTINEL } } },
      parsed,
    );
    expect(restored).toEqual({ ok: false, path: "channels.discord.token" });
  });

  it("lets a client replace a secret with a new value", () => {
    const restored = restoreRedactedValues({ gateway: { auth: { password: "new" } } }, parsed);
    expect(restored.ok && (restored.value as typeof parsed).gateway.auth.password).toBe("new");
  });
});

describe("shared redaction modes", () => {
  const cfg = {
    env: { PLAIN: "visible", SUPABASE_PAT: "sbp_x" },
    secrets: { emailAccountsKey: "enc-key" },
    hooks: { discordWebhook: "https://discord/api/webhooks/1/abc" },
    models: { providers: { x: { baseUrl: "https://user:pw@api.example/v1", compat: "openai" } } },
  };

  it("default mode keeps env and URLs round-trippable but hides the secrets map", () => {
    const { value } = redactConfigValue(cfg);
    expect(value.env.PLAIN).toBe("visible");
    expect(value.secrets.emailAccountsKey).toBe(REDACTED_SENTINEL);
    expect(value.models.providers.x.baseUrl).toBe("https://user:pw@api.example/v1");
    const restored = restoreRedactedValues(value, cfg);
    expect(restored).toEqual({ ok: true, value: cfg });
  });

  it("strict mode (agent) also hides env maps, PATs, webhooks and URL credentials", () => {
    const { value } = redactConfigValue(cfg, { strict: true });
    const text = JSON.stringify(value);
    for (const secret of ["visible", "sbp_x", "enc-key", "abc", "user:pw"]) {
      expect(text).not.toContain(secret);
    }
    expect(value.models.providers.x.baseUrl).toBe(`https://${REDACTED_SENTINEL}@api.example/v1`);
    expect(value.models.providers.x.compat).toBe("openai");
  });
});
