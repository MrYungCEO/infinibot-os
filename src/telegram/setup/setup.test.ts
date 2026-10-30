import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupBotApi } from "./bot-api.js";
import { addAllowFrom, applyTelegramSetupToConfig, fillTelegramSection } from "./config-fill.js";
import { classifyTelegramSetupError, scrubToken } from "./errors.js";
import { TelegramSetupManager } from "./sessions.js";
import { generateStartCode, matchStartCode, textCarriesCode } from "./start-code.js";
import { checkTelegramTokenFormat, cleanTelegramToken, maskTelegramToken } from "./token-format.js";

const TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const OTHER = "7999999999:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw2";

describe("token format", () => {
  it("accepts a BotFather token and reports the bot id", () => {
    expect(checkTelegramTokenFormat(TOKEN)).toEqual({
      ok: true,
      token: TOKEN,
      botId: "7123456789",
    });
    expect(TOKEN).toHaveLength(46);
  });

  it("cleans up what people paste around a token", () => {
    expect(cleanTelegramToken(`  "${TOKEN}"\n`)).toBe(TOKEN);
    expect(cleanTelegramToken(`https://api.telegram.org/bot${TOKEN}/getMe`)).toBe(TOKEN);
    expect(cleanTelegramToken(`Use this token to access the HTTP API: ${TOKEN} Keep it safe`)).toBe(
      TOKEN,
    );
    expect(cleanTelegramToken(TOKEN.replace(":", ": "))).toBe(TOKEN);
  });

  it.each([
    ["", "empty"],
    ["hello", "no-colon"],
    ["abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1", "bad-id"],
    ["7123456789:AAHdq", "too-short"],
    ["7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PAL$$aw1", "bad-chars"],
  ])("rejects %j as %s with a plain-English message", (raw, problem) => {
    const res = checkTelegramTokenFormat(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.problem).toBe(problem);
      expect(res.message.length).toBeGreaterThan(10);
    }
  });

  it("masks everything but the bot id and the last 4 characters", () => {
    const masked = maskTelegramToken(TOKEN);
    expect(masked).toBe("7123456789:••••••saw1");
    expect(masked).not.toContain("AAHdq");
  });
});

describe("start code", () => {
  const dm = (text: string, extra: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: {
      date: 2000,
      text,
      chat: { id: 555, type: "private" },
      from: { id: 555, username: "alex", first_name: "Alex" },
      ...extra,
    },
  });

  it("generates unambiguous 8-character codes", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateStartCode()));
    expect(codes.size).toBeGreaterThan(195);
    for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
  });

  it("matches /start <code>, /start@bot <code> and the bare code, case-insensitively", () => {
    expect(textCarriesCode("/start ABCD2345", "ABCD2345")).toBe(true);
    expect(textCarriesCode("/start@my_bot abcd2345", "ABCD2345")).toBe(true);
    expect(textCarriesCode("abcd2345", "ABCD2345")).toBe(true);
    expect(textCarriesCode("/start", "ABCD2345")).toBe(false);
    expect(textCarriesCode("/start ABCD2346", "ABCD2345")).toBe(false);
    expect(textCarriesCode("xABCD2345x", "ABCD2345")).toBe(false);
    expect(textCarriesCode("anything", "")).toBe(false);
  });

  it("captures user id, chat id, username and first name from the owner's DM", () => {
    expect(matchStartCode(dm("/start ABCD2345"), { code: "ABCD2345", mode: "dm" })).toEqual({
      match: true,
      found: {
        userId: 555,
        chatId: 555,
        chatType: "private",
        chatTitle: null,
        username: "alex",
        firstName: "Alex",
      },
    });
  });

  it("does not let a message without the code claim the bot", () => {
    expect(matchStartCode(dm("/start"), { code: "ABCD2345", mode: "dm" })).toEqual({
      match: false,
      reason: "no-code",
    });
    expect(matchStartCode(dm("hello there"), { code: "ABCD2345", mode: "dm" })).toEqual({
      match: false,
      reason: "no-code",
    });
  });

  it("ignores bots, old messages, non-messages and the wrong kind of chat", () => {
    const expect_ = { code: "ABCD2345", mode: "dm" as const };
    expect(matchStartCode({ update_id: 1, my_chat_member: {} }, expect_)).toMatchObject({
      reason: "not-a-message",
    });
    expect(
      matchStartCode(dm("/start ABCD2345", { from: { id: 9, is_bot: true } }), expect_),
    ).toMatchObject({ reason: "from-bot" });
    expect(matchStartCode(dm("/start ABCD2345"), { ...expect_, notBefore: 3000 })).toMatchObject({
      reason: "too-old",
    });
    expect(
      matchStartCode(dm("/start ABCD2345", { chat: { id: -100123, type: "supergroup" } }), expect_),
    ).toMatchObject({ reason: "wrong-chat-type" });
    expect(
      matchStartCode(dm("/start ABCD2345"), { code: "ABCD2345", mode: "group" }),
    ).toMatchObject({ reason: "wrong-chat-type" });
  });

  it("captures a group's negative chat id, and only from the owner once known", () => {
    const group = dm("/start@my_bot ABCD2345", {
      chat: { id: -1001234567890, type: "supergroup", title: "Team" },
    });
    expect(matchStartCode(group, { code: "ABCD2345", mode: "group", ownerUserId: 555 })).toEqual({
      match: true,
      found: {
        userId: 555,
        chatId: -1001234567890,
        chatType: "supergroup",
        chatTitle: "Team",
        username: "alex",
        firstName: "Alex",
      },
    });
    expect(
      matchStartCode(group, { code: "ABCD2345", mode: "group", ownerUserId: 42 }),
    ).toMatchObject({ reason: "wrong-sender" });
  });
});

describe("config fill", () => {
  it("fills token, allowFrom and defaultChatId for a new install", () => {
    const next = applyTelegramSetupToConfig({ gateway: { port: 1 } } as never, {
      token: TOKEN,
      owner: { userId: 555, chatId: 555 },
    });
    expect(next.channels?.telegram).toEqual({
      enabled: true,
      botToken: TOKEN,
      allowFrom: ["555"],
      defaultChatId: "555",
    });
    expect((next as { gateway?: unknown }).gateway).toEqual({ port: 1 });
  });

  it("keeps existing settings and never duplicates the owner", () => {
    const section = fillTelegramSection(
      { botToken: OTHER, dmPolicy: "allowlist", allowFrom: [111, "tg:555"], streamMode: "partial" },
      { owner: { userId: 555, chatId: 555 } },
    );
    expect(section).toMatchObject({
      botToken: OTHER,
      dmPolicy: "allowlist",
      streamMode: "partial",
      allowFrom: [111, "tg:555"],
      defaultChatId: "555",
      enabled: true,
    });
    expect(addAllowFrom(["555"], 555)).toEqual(["555"]);
    expect(addAllowFrom(undefined, 7)).toEqual(["7"]);
  });

  it("a pasted token replaces a token file", () => {
    const section = fillTelegramSection({ tokenFile: "/x/token" }, { token: TOKEN });
    expect(section.botToken).toBe(TOKEN);
    expect(section.tokenFile).toBeUndefined();
  });

  it("adds a group without moving the owner's default chat", () => {
    const section = fillTelegramSection(
      { defaultChatId: "555", groups: { "-1": { requireMention: true } } },
      { group: { chatId: -1001234567890 } },
    );
    expect(section.groups).toEqual({
      "-1": { requireMention: true },
      "-1001234567890": { enabled: true },
    });
    expect(section.defaultChatId).toBe("555");
    expect(
      fillTelegramSection({}, { group: { chatId: -5, makeDefault: true } }).defaultChatId,
    ).toBe("-5");
  });
});

describe("error classification", () => {
  it("explains each failure and never echoes the token", () => {
    expect(classifyTelegramSetupError({ error_code: 401, description: "Unauthorized" }).code).toBe(
      "invalid_token",
    );
    expect(
      classifyTelegramSetupError({
        error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      }),
    ).toMatchObject({ code: "webhook_active", action: "deleteWebhook" });
    expect(
      classifyTelegramSetupError({
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      }).code,
    ).toBe("in_use_elsewhere");
    expect(
      classifyTelegramSetupError({ error_code: 400, description: "chat not found" }).code,
    ).toBe("chat_unreachable");
    expect(classifyTelegramSetupError(new TypeError("fetch failed")).code).toBe("network");
    const unknown = classifyTelegramSetupError(new Error(`boom https://x/bot${TOKEN}/getMe`));
    expect(JSON.stringify(unknown)).not.toContain(TOKEN);
    expect(scrubToken(`a ${TOKEN} b`)).toBe("a <token> b");
  });
});

// ── session manager with a fake Bot API ─────────────────────────────────────

function fakeApi(overrides: Partial<SetupBotApi> = {}) {
  const queue: Array<{ update_id: number }> = [];
  const waiters: Array<() => void> = [];
  const sent: Array<{ chatId: number | string; text: string }> = [];
  const state = {
    polls: 0,
    webhook: null as string | null,
    acked: undefined as number | undefined,
  };
  const api: SetupBotApi = {
    getMe: async () => ({
      id: 7123456789,
      username: "my_helper_bot",
      name: "My Helper",
      canJoinGroups: true,
      canReadAllGroupMessages: false,
    }),
    getWebhookUrl: async () => state.webhook,
    deleteWebhook: async () => {
      state.webhook = null;
    },
    getUpdates: async (params, signal) => {
      state.polls += 1;
      if (params.offset !== undefined) {
        state.acked = params.offset;
        while (queue.length && queue[0].update_id < params.offset) queue.shift();
      }
      if (queue.length === 0 && params.timeout > 0) {
        await new Promise<void>((resolve, reject) => {
          waiters.push(resolve);
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return [...queue];
    },
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    getChat: async (chatId) => ({
      id: Number(chatId),
      type: Number(chatId) < 0 ? "supergroup" : "private",
      title: Number(chatId) < 0 ? "Team" : null,
      username: "alex",
      firstName: "Alex",
    }),
    avatar: async () => null,
    ...overrides,
  };
  let nextId = 10;
  const push = (message: Record<string, unknown>) => {
    queue.push({ update_id: nextId++, message } as never);
    for (const wake of waiters.splice(0)) wake();
  };
  return { api, push, sent, state };
}

const dmMessage = (text: string, userId = 555) => ({
  date: Math.floor(Date.now() / 1000),
  text,
  chat: { id: userId, type: "private" },
  from: { id: userId, username: "alex", first_name: "Alex" },
});

describe("TelegramSetupManager", () => {
  let fake: ReturnType<typeof fakeApi>;
  let manager: TelegramSetupManager;

  beforeEach(() => {
    fake = fakeApi();
    manager = new TelegramSetupManager({ createApi: () => fake.api, retryDelayMs: 1 });
  });
  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  async function verified(scope = "default") {
    const res = await manager.verify(scope, { token: TOKEN, source: "pasted" });
    if (!res.ok) throw new Error(res.error.code);
    return res.value;
  }

  it("verify returns the bot and a masked token, never the token itself", async () => {
    const view = await verified();
    expect(view.bot).toMatchObject({ username: "my_helper_bot", name: "My Helper" });
    expect(view.tokenMasked).toBe("7123456789:••••••saw1");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("verify rejects a malformed token without calling Telegram", async () => {
    const getMe = vi.fn(() => fake.api.getMe());
    manager = new TelegramSetupManager({ createApi: () => ({ ...fake.api, getMe }) });
    const res = await manager.verify("default", { token: "nope", source: "pasted" });
    expect(res).toMatchObject({ ok: false, error: { code: "bad_format" } });
    expect(getMe).not.toHaveBeenCalled();
  });

  it("verify explains an invalid token", async () => {
    manager = new TelegramSetupManager({
      createApi: () => ({
        ...fake.api,
        getMe: async () => {
          throw Object.assign(new Error("Unauthorized"), { error_code: 401 });
        },
      }),
    });
    const res = await manager.verify("default", { token: TOKEN, source: "pasted" });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_token" } });
  });

  it("finds the owner from /start <code> by polling, replies, and stops polling", async () => {
    const { sessionId } = await verified();
    const started = await manager.startCapture("default", sessionId, "dm");
    if (!started.ok) throw new Error("no capture");
    const capture = started.value.capture!;
    expect(capture).toMatchObject({ status: "waiting", transport: "polling", mode: "dm" });
    expect(capture.deepLink).toBe(`https://t.me/my_helper_bot?start=${capture.code}`);

    fake.push(dmMessage("hi, who is this?", 999)); // a stranger, no code
    fake.push(dmMessage(`/start ${capture.code}`));
    await vi.waitFor(() => {
      const now = manager.get("default", sessionId);
      expect(now.ok && now.value.capture?.status).toBe("found");
    });
    const now = manager.get("default", sessionId);
    if (!now.ok) throw new Error("gone");
    expect(now.value.capture?.found).toMatchObject({ userId: 555, chatId: 555, username: "alex" });
    expect(now.value.capture?.otherMessages).toBe(1);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0].chatId).toBe(555);
    // The start message was acknowledged so the channel won't see it again.
    await vi.waitFor(() => expect(fake.state.acked).toBe(12));
    const polls = fake.state.polls;
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.state.polls).toBe(polls);

    const confirmed = manager.confirm("default", sessionId);
    expect(confirmed.ok && confirmed.value.found.userId).toBe(555);
    expect(confirmed.ok && confirmed.value.view.owner?.chatId).toBe(555);
  });

  it("a stranger messaging the bot during setup cannot claim it", async () => {
    const { sessionId } = await verified();
    await manager.startCapture("default", sessionId, "dm");
    fake.push(dmMessage("/start", 999));
    fake.push(dmMessage("/start WRONGCODE", 999));
    await vi.waitFor(() => {
      const now = manager.get("default", sessionId);
      expect(now.ok && now.value.capture?.otherMessages).toBe(2);
    });
    const now = manager.get("default", sessionId);
    expect(now.ok && now.value.capture?.status).toBe("waiting");
    expect(manager.confirm("default", sessionId)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("capture times out after 5 minutes and stops polling", async () => {
    vi.useFakeTimers();
    const { sessionId } = await verified();
    const started = await manager.startCapture("default", sessionId, "dm");
    const code = started.ok ? started.value.capture!.code : "";
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59_000);
    let now = manager.get("default", sessionId);
    expect(now.ok && now.value.capture?.status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2000);
    now = manager.get("default", sessionId);
    expect(now.ok && now.value.capture?.status).toBe("expired");
    // A late start message is no longer accepted.
    fake.push(dmMessage(`/start ${code}`));
    await vi.advanceTimersByTimeAsync(50);
    now = manager.get("default", sessionId);
    expect(now.ok && now.value.capture?.status).toBe("expired");
    expect(
      manager.offerUpdate(TOKEN, { update_id: 99, message: dmMessage(`/start ${code}`) }),
    ).toBe(false);
  });

  it("reports another app's webhook instead of polling, and can remove it", async () => {
    fake.state.webhook = "https://other-app.example.com/hook/secret";
    const view = await verified();
    expect(view.webhookHost).toBe("other-app.example.com");
    const blocked = await manager.startCapture("default", view.sessionId, "dm");
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "webhook_active", action: "deleteWebhook" },
    });
    expect(fake.state.polls).toBe(0);
    const cleared = await manager.deleteWebhook("default", view.sessionId);
    expect(cleared.ok && cleared.value.webhookHost).toBeNull();
    expect((await manager.startCapture("default", view.sessionId, "dm")).ok).toBe(true);
  });

  it("reports a bot that another program is already polling", async () => {
    manager = new TelegramSetupManager({
      createApi: () => ({
        ...fake.api,
        getUpdates: async () => {
          throw Object.assign(new Error("Conflict: terminated by other getUpdates request"), {
            error_code: 409,
          });
        },
      }),
    });
    const { sessionId } = await verified();
    await manager.startCapture("default", sessionId, "dm");
    await vi.waitFor(() => {
      const now = manager.get("default", sessionId);
      expect(now.ok && now.value.capture).toMatchObject({
        status: "error",
        error: { code: "in_use_elsewhere" },
      });
    });
  });

  it("uses the running channel (long-poll or webhook) instead of polling", async () => {
    const release = manager.markLive(TOKEN);
    const { sessionId, channelLive } = await verified();
    expect(channelLive).toBe(true);
    const started = await manager.startCapture("default", sessionId, "dm");
    const capture = started.ok ? started.value.capture! : null;
    expect(capture?.transport).toBe("live");
    expect(fake.state.polls).toBe(0);

    // Ordinary traffic passes through to the assistant untouched.
    expect(manager.offerUpdate(TOKEN, { update_id: 1, message: dmMessage("hello") })).toBe(false);
    // Another bot's update never matches this session.
    expect(
      manager.offerUpdate(OTHER, { update_id: 2, message: dmMessage(`/start ${capture!.code}`) }),
    ).toBe(false);
    // The webhook / poller hands over the start message: claimed and swallowed.
    expect(
      manager.offerUpdate(TOKEN, { update_id: 3, message: dmMessage(`/start ${capture!.code}`) }),
    ).toBe(true);
    const now = manager.get("default", sessionId);
    expect(now.ok && now.value.capture?.found?.userId).toBe(555);
    // One-time: the same code cannot be replayed.
    expect(
      manager.offerUpdate(TOKEN, {
        update_id: 4,
        message: dmMessage(`/start ${capture!.code}`, 9),
      }),
    ).toBe(false);
    release();
    expect(manager.isLive(TOKEN)).toBe(false);
  });

  it("adds a group by its negative chat id, only from the confirmed owner", async () => {
    const release = manager.markLive(TOKEN);
    const { sessionId } = await verified();
    const dm = await manager.startCapture("default", sessionId, "dm");
    manager.offerUpdate(TOKEN, {
      update_id: 1,
      message: dmMessage(`/start ${dm.ok ? dm.value.capture!.code : ""}`),
    });
    manager.confirm("default", sessionId);

    const started = await manager.startCapture("default", sessionId, "group");
    const capture = started.ok ? started.value.capture! : null;
    expect(capture?.deepLink).toBe(`https://t.me/my_helper_bot?startgroup=${capture?.code}`);
    const inGroup = (userId: number) => ({
      update_id: 5,
      message: {
        ...dmMessage(`/start@my_helper_bot ${capture!.code}`, userId),
        chat: { id: -1001234567890, type: "supergroup", title: "Team" },
      },
    });
    expect(manager.offerUpdate(TOKEN, inGroup(999))).toBe(false);
    expect(manager.offerUpdate(TOKEN, inGroup(555))).toBe(true);
    const confirmed = manager.confirm("default", sessionId);
    expect(confirmed.ok && confirmed.value).toMatchObject({
      mode: "group",
      found: { chatId: -1001234567890, chatTitle: "Team" },
    });
    release();
  });

  it("manual fallback checks the id with Telegram first", async () => {
    const { sessionId } = await verified();
    expect(await manager.manual("default", sessionId, { mode: "dm", id: "abc" })).toMatchObject({
      ok: false,
      error: { code: "bad_format" },
    });
    expect(await manager.manual("default", sessionId, { mode: "group", id: "123" })).toMatchObject({
      ok: false,
    });
    const ok = await manager.manual("default", sessionId, { mode: "dm", id: "555000" });
    expect(ok.ok && ok.value.capture).toMatchObject({
      status: "found",
      transport: "manual",
      found: { userId: 555000, chatId: 555000, firstName: "Alex" },
    });
  });

  it("sends the test message to the confirmed chat", async () => {
    const { sessionId } = await verified();
    expect(await manager.sendTest("default", sessionId)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await manager.manual("default", sessionId, { mode: "dm", id: "555000" });
    manager.confirm("default", sessionId);
    expect(await manager.sendTest("default", sessionId)).toEqual({
      ok: true,
      value: { chatId: "555000" },
    });
    expect(fake.sent.at(-1)).toEqual({ chatId: 555000, text: "✅ InfiniBot is connected" });
  });

  it("keeps sessions inside their tenant scope and expires idle ones", async () => {
    let clock = 1_000_000;
    manager = new TelegramSetupManager({ createApi: () => fake.api, now: () => clock });
    const { sessionId } = await verified("tenant-a");
    expect(manager.get("tenant-b", sessionId)).toMatchObject({
      ok: false,
      error: { code: "expired" },
    });
    expect(manager.tokenOf("tenant-b", sessionId)).toBeUndefined();
    expect(manager.get("tenant-a", sessionId).ok).toBe(true);
    clock += 31 * 60 * 1000;
    expect(manager.get("tenant-a", sessionId)).toMatchObject({
      ok: false,
      error: { code: "expired" },
    });
  });
});
