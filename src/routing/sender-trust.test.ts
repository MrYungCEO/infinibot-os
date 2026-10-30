import { describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import { resolveChannelOwnerIds, resolveTurnTrust } from "./sender-trust.js";

const ownerCfg: InfinibotConfig = {
  channels: {
    telegram: { dmPolicy: "allowlist", allowFrom: ["8390923206", "tg:123456789"] },
  },
} as InfinibotConfig;

describe("resolveTurnTrust", () => {
  it("treats control-UI / webchat turns as operator", () => {
    const trust = resolveTurnTrust({
      config: ownerCfg,
      sessionKey: "agent:main:main",
      messageProvider: "webchat",
      senderId: "control-ui-client",
    });
    expect(trust).toMatchObject({ level: "operator", trusted: true });
  });

  it("treats turns with no provider (MCP, cron, autonomy, CLI) as operator", () => {
    expect(
      resolveTurnTrust({ config: ownerCfg, sessionKey: "agent:main:cron:job-1" }).trusted,
    ).toBe(true);
    expect(resolveTurnTrust({ sessionKey: "agent:main:subagent:abc" }).level).toBe("operator");
  });

  it("treats a channel run without a sender (cron delivery / announce) as operator", () => {
    const trust = resolveTurnTrust({ config: ownerCfg, messageProvider: "telegram" });
    expect(trust.trusted).toBe(true);
  });

  it("trusts the owner's own Telegram identity from channels.telegram.allowFrom", () => {
    const a = resolveTurnTrust({
      config: ownerCfg,
      messageProvider: "telegram",
      senderId: "8390923206",
    });
    expect(a).toMatchObject({ level: "owner", trusted: true, channel: "telegram" });
    const b = resolveTurnTrust({
      config: ownerCfg,
      messageProvider: "telegram",
      senderId: "123456789",
    });
    expect(b.level).toBe("owner");
  });

  it("marks a non-owner Telegram DM sender untrusted", () => {
    const trust = resolveTurnTrust({
      config: ownerCfg,
      messageProvider: "telegram",
      senderId: "111222333",
      senderUsername: "stranger",
    });
    expect(trust).toMatchObject({ level: "untrusted-sender", trusted: false });
  });

  it("fresh install (no allowFrom): every channel sender is untrusted", () => {
    const trust = resolveTurnTrust({
      config: {} as InfinibotConfig,
      messageProvider: "telegram",
      senderId: "8390923206",
    });
    expect(trust.level).toBe("untrusted-sender");
  });

  it("a wildcard allowFrom does not make everyone the owner", () => {
    const cfg = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    } as InfinibotConfig;
    expect(resolveChannelOwnerIds({ config: cfg, channel: "telegram" })).toEqual([]);
    const trust = resolveTurnTrust({ config: cfg, messageProvider: "telegram", senderId: "42" });
    expect(trust.trusted).toBe(false);
  });

  it("honors tools.trust.owners (channel-scoped and bare)", () => {
    const cfg = {
      tools: { trust: { owners: ["whatsapp:+15551234567", "999"] } },
    } as InfinibotConfig;
    expect(
      resolveTurnTrust({
        config: cfg,
        messageProvider: "whatsapp",
        senderE164: "+15551234567",
        senderId: "+15551234567",
      }).level,
    ).toBe("owner");
    expect(
      resolveTurnTrust({ config: cfg, messageProvider: "telegram", senderId: "999" }).level,
    ).toBe("owner");
    // A WhatsApp-scoped owner entry does not leak onto Telegram.
    expect(
      resolveTurnTrust({ config: cfg, messageProvider: "telegram", senderId: "+15551234567" })
        .trusted,
    ).toBe(false);
  });

  it("tools.trust.nonOwnerSenders=trusted restores legacy behavior", () => {
    const cfg = { tools: { trust: { nonOwnerSenders: "trusted" } } } as InfinibotConfig;
    expect(
      resolveTurnTrust({ config: cfg, messageProvider: "telegram", senderId: "42" }).trusted,
    ).toBe(true);
  });

  it("marks external hook sessions (gmail/webhook) as untrusted content", () => {
    const gmail = resolveTurnTrust({
      config: ownerCfg,
      sessionKey: "agent:main:hook:gmail:abc123",
    });
    expect(gmail).toMatchObject({ level: "untrusted-content", trusted: false });
    expect(resolveTurnTrust({ sessionKey: "hook:webhook:xyz" }).level).toBe("untrusted-content");
  });
});
