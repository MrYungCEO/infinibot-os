import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The owner's live telegram block: allowFrom[0] is an id the bot cannot reach.
const telegramCfg = {
  enabled: true,
  defaultChatId: "123456789",
  allowFrom: ["8390923206", "123456789"],
};
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ channels: { telegram: telegramCfg } }),
}));
const sendMessageTelegram = vi.fn(async () => ({ messageId: "1", chatId: "123456789" }));
vi.mock("../telegram/send.js", () => ({
  sendMessageTelegram: (...a: unknown[]) => sendMessageTelegram(...(a as [])),
}));

import { resolveOwnerTelegramChatId } from "../telegram/owner-chat.js";
import { sendTelegramCompletion } from "./notify.js";
import { createRecord, getRecord, markTerminal, resetVerificationStoreForTests } from "./store.js";

let dir: string;
const prev = { state: process.env.INFINIBOT_STATE_DIR, skip: process.env.INFINIBOT_SKIP_CHANNELS };
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vc-notify-chat-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  delete process.env.INFINIBOT_SKIP_CHANNELS;
  resetVerificationStoreForTests();
  sendMessageTelegram.mockClear();
});
afterEach(() => {
  if (prev.state === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prev.state;
  if (prev.skip !== undefined) process.env.INFINIBOT_SKIP_CHANNELS = prev.skip;
  rmSync(dir, { recursive: true, force: true });
});

describe("owner Telegram chat", () => {
  it("defaultChatId wins over allowFrom[0]; allowFrom is only a fallback", () => {
    expect(resolveOwnerTelegramChatId(telegramCfg)).toBe("123456789");
    expect(resolveOwnerTelegramChatId({ allowFrom: ["*", 42] })).toBe("42");
    expect(resolveOwnerTelegramChatId({ defaultChatId: " ", allowFrom: [] })).toBeNull();
    expect(resolveOwnerTelegramChatId(undefined)).toBeNull();
  });

  it("verification notifications go to the same chat as reports (defaultChatId)", async () => {
    createRecord({
      runId: "n1",
      childSessionKey: "c",
      requesterSessionKey: "agent:main:mcp-x",
      label: "run",
      task: "t",
    });
    markTerminal("n1", "unverified", { summary: "s" });
    const sent = await sendTelegramCompletion(getRecord("n1")!);
    expect(sent).toBe(true);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect((sendMessageTelegram.mock.calls[0] as unknown[])[0]).toBe("123456789");
  });
});
