/**
 * The real grammY-backed client against a local mock Bot API
 * (INFINIBOT_TELEGRAM_API_ROOT): getMe, getUpdates, sendMessage, deleteWebhook.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  startMockTelegramBotApi,
  type MockTelegram,
} from "../../../test/helpers/mock-telegram-bot-api.js";
import { resolveTelegramApiRoot, withTelegramApiRoot } from "../api-root.js";
import { createGrammySetupApi } from "./bot-api.js";
import { TelegramSetupManager } from "./sessions.js";

const TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const BAD = "7000000000:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9";

describe("guided setup against a mock Bot API", () => {
  let mock: MockTelegram;
  let manager: TelegramSetupManager;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    mock = await startMockTelegramBotApi({
      bots: [
        {
          token: TOKEN,
          id: 7123456789,
          username: "my_helper_bot",
          first_name: "My Helper",
          avatar: true,
        },
      ],
      maxHoldMs: 150,
    });
    env = { INFINIBOT_TELEGRAM_API_ROOT: mock.url };
    manager = new TelegramSetupManager({
      createApi: (token) => createGrammySetupApi(token, { env }),
      pollTimeoutSec: 1,
      retryDelayMs: 10,
    });
  });
  afterAll(async () => {
    manager.dispose();
    await mock.close();
  });

  it("the API root override is opt-in and trims slashes", () => {
    expect(resolveTelegramApiRoot({})).toBe("https://api.telegram.org");
    expect(resolveTelegramApiRoot({ INFINIBOT_TELEGRAM_API_ROOT: "ftp://x" })).toBe(
      "https://api.telegram.org",
    );
    expect(resolveTelegramApiRoot({ INFINIBOT_TELEGRAM_API_ROOT: "http://127.0.0.1:9/" })).toBe(
      "http://127.0.0.1:9",
    );
    expect(withTelegramApiRoot(undefined, {})).toBeUndefined();
    expect(withTelegramApiRoot({ timeoutSeconds: 5 }, env)).toEqual({
      timeoutSeconds: 5,
      apiRoot: mock.url,
    });
  });

  it("an unknown token is reported as invalid", async () => {
    const res = await manager.verify("default", { token: BAD, source: "pasted" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_token" } });
  });

  it("verify → capture → confirm → test message, end to end", async () => {
    const verified = await manager.verify("default", { token: TOKEN, source: "pasted" });
    if (!verified.ok) throw new Error(verified.error.message);
    expect(verified.value.bot).toMatchObject({
      id: 7123456789,
      username: "my_helper_bot",
      name: "My Helper",
      canReadAllGroupMessages: false,
    });
    expect(verified.value.bot.avatar).toMatch(/^data:image\/png;base64,/);
    const sessionId = verified.value.sessionId;

    const started = await manager.startCapture("default", sessionId, "dm");
    if (!started.ok) throw new Error(started.error.message);
    const code = started.value.capture!.code;

    await mock.message({ token: TOKEN, text: "hello?", from: { id: 999, first_name: "Stranger" } });
    await mock.message({
      token: TOKEN,
      text: `/start ${code}`,
      from: { id: 555, username: "alex", first_name: "Alex" },
    });
    await vi.waitFor(
      () => {
        const now = manager.get("default", sessionId);
        expect(now.ok && now.value.capture?.status).toBe("found");
      },
      { timeout: 5000 },
    );
    const confirmed = manager.confirm("default", sessionId);
    expect(confirmed.ok && confirmed.value.found).toMatchObject({
      userId: 555,
      chatId: 555,
      username: "alex",
      firstName: "Alex",
    });

    const test = await manager.sendTest("default", sessionId);
    expect(test).toEqual({ ok: true, value: { chatId: "555" } });
    expect(mock.sent.map((m) => m.text)).toContain("✅ InfiniBot is connected");
    expect(mock.sent.every((m) => m.chat_id === 555)).toBe(true);

    // Polling stopped: no further getUpdates after the capture finished.
    const before = mock.calls.filter((c) => c.method === "getUpdates").length;
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.calls.filter((c) => c.method === "getUpdates").length).toBe(before);
  });

  it("another app's webhook blocks polling until it is removed", async () => {
    mock.setWebhook(TOKEN, "https://other-app.example.com/tg");
    const verified = await manager.verify("default", { token: TOKEN, source: "pasted" });
    if (!verified.ok) throw new Error("verify");
    expect(verified.value.webhookHost).toBe("other-app.example.com");
    const blocked = await manager.startCapture("default", verified.value.sessionId, "dm");
    expect(blocked).toMatchObject({ ok: false, error: { code: "webhook_active" } });
    const cleared = await manager.deleteWebhook("default", verified.value.sessionId);
    expect(cleared.ok && cleared.value.webhookHost).toBeNull();
    const started = await manager.startCapture("default", verified.value.sessionId, "dm");
    expect(started.ok).toBe(true);
    manager.cancelCapture("default", verified.value.sessionId);
  });

  it("a bot already polled by another program is reported", async () => {
    mock.setConflict(TOKEN, true);
    const verified = await manager.verify("default", { token: TOKEN, source: "pasted" });
    if (!verified.ok) throw new Error("verify");
    await manager.startCapture("default", verified.value.sessionId, "dm");
    await vi.waitFor(
      () => {
        const now = manager.get("default", verified.value.sessionId);
        expect(now.ok && now.value.capture?.error?.code).toBe("in_use_elsewhere");
      },
      { timeout: 5000 },
    );
    mock.setConflict(TOKEN, false);
  });

  it("a test message to a chat that never started the bot explains what to do", async () => {
    const verified = await manager.verify("default", { token: TOKEN, source: "pasted" });
    if (!verified.ok) throw new Error("verify");
    const res = await manager.sendTest("default", verified.value.sessionId, 424242);
    expect(res).toMatchObject({ ok: false, error: { code: "chat_unreachable" } });
  });
});
