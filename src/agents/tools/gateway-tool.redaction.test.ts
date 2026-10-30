import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayTool = vi.fn();
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => callGatewayTool(...args),
}));

import {
  REDACTED_SENTINEL,
  redactConfigSnapshotForAgent as redactConfigSnapshot,
} from "../../gateway/server-methods/config-redact.js";
import { createGatewayTool, REDACTED_CONFIG_VALUE } from "./gateway-tool.js";

const snapshot = {
  path: "/home/u/.infinibot/infinibot.json",
  exists: true,
  valid: true,
  hash: "abc123",
  raw: '{ gateway: { auth: { password: "hunter2" } } }',
  config: {
    gateway: { auth: { mode: "password", password: "hunter2", token: "tok-1" } },
    channels: { telegram: { botToken: "123:AAA", allowFrom: ["8390923206"] } },
    models: {
      providers: { openai: { apiKey: "sk-live", baseUrl: "https://user:pw@api.example/v1" } },
    },
    mcpServers: { x: { command: "npx", env: { SUPABASE_PAT: "sbp_secret" } } },
    agents: { defaults: { maxTokens: 8192 } },
    secrets: { emailAccountsKey: "k" },
  },
};

describe("gateway tool config.get redaction", () => {
  beforeEach(() => callGatewayTool.mockReset());

  it("uses the gateway's shared redaction placeholder", () => {
    expect(REDACTED_CONFIG_VALUE).toBe(REDACTED_SENTINEL);
  });

  it("strict agent redaction is idempotent over an already gateway-redacted snapshot", () => {
    const once = redactConfigSnapshot(snapshot);
    const twice = redactConfigSnapshot(once);
    expect(JSON.stringify((twice as { config: unknown }).config)).toBe(
      JSON.stringify((once as { config: unknown }).config),
    );
  });

  it("redacts passwords, tokens, API keys, env maps and URL credentials", () => {
    const out = redactConfigSnapshot(snapshot) as typeof snapshot & { redacted: boolean };
    const text = JSON.stringify(out);
    for (const secret of ["hunter2", "tok-1", "123:AAA", "sk-live", "sbp_secret", "user:pw"]) {
      expect(text).not.toContain(secret);
    }
    expect(out.config.gateway.auth.password).toBe(REDACTED_CONFIG_VALUE);
    expect(out.config.gateway.auth.mode).toBe("password");
    expect(out.config.channels.telegram.allowFrom).toEqual(["8390923206"]);
    expect(out.config.agents.defaults.maxTokens).toBe(8192);
    expect(out.hash).toBe("abc123");
    expect(out.redacted).toBe(true);
  });

  it("config.get through the tool returns the redacted snapshot", async () => {
    callGatewayTool.mockResolvedValue(snapshot);
    const tool = createGatewayTool();
    const result = (await tool.execute("c1", { action: "config.get" } as never)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).not.toContain("hunter2");
    expect(result.content[0].text).not.toContain("sk-live");
  });

  it("config.apply / config.patch refuse payloads carrying the redaction placeholder", async () => {
    const tool = createGatewayTool();
    for (const action of ["config.apply", "config.patch"]) {
      await expect(
        tool.execute("c1", {
          action,
          raw: JSON.stringify({ gateway: { auth: { password: REDACTED_CONFIG_VALUE } } }),
        } as never),
      ).rejects.toThrow(/redaction placeholder/);
    }
    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});
