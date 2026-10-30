/**
 * PILLAR 3 — Telegram re-init: changing the bot token / chat id must take
 * effect on the LIVE notifier without a process restart.
 * // COORDINATION: orch-self-heal
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./audit.js", () => ({ logAudit: vi.fn() }));

import {
  initNotifications,
  getNotificationsConfig,
  testTelegramConnection,
} from "./notifications.js";

afterEach(() => {
  initNotifications({ botToken: undefined, chatId: undefined });
  vi.clearAllMocks();
});

describe("notifications re-init", () => {
  it("reports not-configured before any config is applied", () => {
    initNotifications({ botToken: undefined, chatId: undefined });
    const cfg = getNotificationsConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.hasBotToken).toBe(false);
    expect(cfg.hasChatId).toBe(false);
  });

  it("applies bot token + chat id and masks the chat id", () => {
    initNotifications({ botToken: "123:ABC", chatId: "987654321" });
    const cfg = getNotificationsConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.hasBotToken).toBe(true);
    expect(cfg.hasChatId).toBe(true);
    expect(cfg.chatIdMasked?.endsWith("4321")).toBe(true);
    expect(cfg.chatIdMasked).not.toContain("9876"); // leading digits masked
  });

  it("RE-init with a new chat id takes effect on the live notifier (the bug fix)", () => {
    initNotifications({ botToken: "tok1", chatId: "111111" });
    expect(getNotificationsConfig().chatIdMasked?.endsWith("1111")).toBe(true);

    // Simulate the operator editing the chat id on the autonomy page — a second
    // init call must overwrite, not be ignored.
    initNotifications({ botToken: "tok2", chatId: "222222" });
    const cfg = getNotificationsConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.chatIdMasked?.endsWith("2222")).toBe(true);
  });

  it("testTelegramConnection short-circuits with an error when unconfigured (no network)", async () => {
    initNotifications({ botToken: undefined, chatId: undefined });
    const result = await testTelegramConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });
});
