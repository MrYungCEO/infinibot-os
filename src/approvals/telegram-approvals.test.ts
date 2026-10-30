import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetApprovalRegistry,
  createApprovalRequest,
  getApprovalRequest,
  onApprovalEvent,
  resolveApprovalRequest,
} from "../autonomy/approval-registry.js";
import type { InfinibotConfig } from "../config/config.js";
import {
  createTelegramApprovalNotifier,
  isAuthorizedOperator,
  resolveTelegramApprovalsConfig,
  type ApprovalTelegramTransport,
} from "./telegram-approvals.js";
import { TELEGRAM_TEXT_LIMIT, type InlineKeyboard } from "./telegram-format.js";

const OWNER = 111222333;
const STRANGER = 999888777;

type Sent = {
  chatId: string;
  html: string;
  keyboard?: InlineKeyboard;
  forceReply?: boolean;
  messageId: number;
};
type Edited = { chatId: string; messageId: number; html: string; keyboard: InlineKeyboard | null };

function fakeTransport() {
  const sent: Sent[] = [];
  const edited: Edited[] = [];
  let nextId = 100;
  const transport: ApprovalTelegramTransport = {
    async send(chatId, html, opts) {
      const messageId = nextId++;
      sent.push({
        chatId,
        html,
        keyboard: opts?.keyboard,
        forceReply: opts?.forceReply,
        messageId,
      });
      return { messageId };
    },
    async edit(chatId, messageId, html, keyboard) {
      edited.push({ chatId, messageId, html, keyboard });
    },
  };
  return { transport, sent, edited };
}

function cfg(
  extra?: Partial<NonNullable<InfinibotConfig["approvals"]>["telegram"]>,
): InfinibotConfig {
  return {
    channels: { telegram: { defaultChatId: String(OWNER), allowFrom: [String(OWNER), "555"] } },
    approvals: { telegram: { digestWindowMs: 0, minIntervalMs: 0, ...extra } },
  } as InfinibotConfig;
}

function setup(config: InfinibotConfig = cfg()) {
  const t = fakeTransport();
  const notifier = createTelegramApprovalNotifier({
    getConfig: () => config,
    transport: t.transport,
  });
  const unsub = onApprovalEvent((e) => notifier.handleEvent(e));
  return { ...t, notifier, unsub };
}

const owner = { id: OWNER, username: "boss" };

beforeEach(() => {
  _resetApprovalRegistry();
});
afterEach(() => {
  _resetApprovalRegistry();
});

describe("config + operator auth", () => {
  it("delivers to defaultChatId and authorizes only the owner", () => {
    const c = resolveTelegramApprovalsConfig(cfg());
    expect(c.enabled).toBe(true);
    expect(c.chatId).toBe(String(OWNER));
    expect(isAuthorizedOperator(c, { id: OWNER })).toBe(true);
    // allowFrom[1] can chat with the bot but can't approve
    expect(isAuthorizedOperator(c, { id: 555 })).toBe(false);
    expect(isAuthorizedOperator(c, { id: STRANGER, username: "boss" })).toBe(false);
    expect(isAuthorizedOperator(c, null)).toBe(false);
  });

  it("fails closed when no operator can be resolved", () => {
    const c = resolveTelegramApprovalsConfig({
      channels: { telegram: { defaultChatId: "-100123", allowFrom: ["*"] } },
    } as InfinibotConfig);
    expect(c.operatorIds.size).toBe(0);
    expect(isAuthorizedOperator(c, { id: OWNER })).toBe(false);
  });

  it("honours explicit operatorIds + enabled:false", () => {
    const c = resolveTelegramApprovalsConfig(cfg({ operatorIds: ["tg:42"], enabled: false }));
    expect(c.enabled).toBe(false);
    expect(isAuthorizedOperator(c, { id: 42 })).toBe(true);
    expect(isAuthorizedOperator(c, { id: OWNER })).toBe(false);
  });
});

describe("delivery", () => {
  it("sends one card with inline Approve/Deny/Reply to the operator chat only", async () => {
    const { notifier, sent } = setup();
    const rec = createApprovalRequest({
      source: "orchestrator",
      title: "fly deploy infinibot-gateway",
      summary: "Billable deploy of bff644a9",
      details: "fly deploy -a infinibot-gateway --image registry.fly.io/x:bff644a9",
      risk: "high",
      requester: { label: "MCP orchestrator" },
    });
    await notifier.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(String(OWNER));
    expect(sent[0].html).toContain("<b>fly deploy infinibot-gateway</b>");
    expect(sent[0].html).toContain("🟠 HIGH");
    expect(sent[0].html).toContain("<pre>fly deploy -a infinibot-gateway");
    expect(sent[0].keyboard).toEqual([
      [
        { text: "✅ Approve", callback_data: `apv:a:${rec.id}` },
        { text: "❌ Deny", callback_data: `apv:d:${rec.id}` },
      ],
      [{ text: "✍️ Reply…", callback_data: `apv:r:${rec.id}` }],
    ]);
    for (const row of sent[0].keyboard!) {
      for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
    expect(getApprovalRequest(rec.id)!.telegram).toEqual([
      { chatId: String(OWNER), messageId: sent[0].messageId, kind: "single" },
    ]);
  });

  it("groups a burst of requests into ONE digest with per-item buttons", async () => {
    const { notifier, sent } = setup();
    const a = createApprovalRequest({
      source: "exec",
      title: "rm -rf dist",
      options: ["approve-always"],
    });
    const b = createApprovalRequest({ source: "orchestrator", title: "restart gateway" });
    const c = createApprovalRequest({
      source: "subagent-checkpoint",
      title: "Check-in: fix login",
      options: ["redirect"],
    });
    await notifier.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("3 approvals waiting");
    expect(sent[0].keyboard).toHaveLength(3);
    expect(sent[0].keyboard![1].map((btn) => btn.callback_data)).toEqual([
      `apv:a:${b.id}`,
      `apv:d:${b.id}`,
      `apv:r:${b.id}`,
      `apv:v:${b.id}`,
    ]);
    for (const r of [a, b, c]) {
      expect(getApprovalRequest(r.id)!.telegram?.[0]).toMatchObject({ kind: "digest" });
    }
  });

  it("rate-limits: requests inside minIntervalMs wait for the next flush", async () => {
    vi.useFakeTimers();
    try {
      const { notifier, sent } = setup(cfg({ digestWindowMs: 0, minIntervalMs: 10_000 }));
      createApprovalRequest({ source: "custom", title: "one" });
      await vi.advanceTimersByTimeAsync(1);
      await notifier.drain();
      expect(sent).toHaveLength(1);
      createApprovalRequest({ source: "custom", title: "two" });
      createApprovalRequest({ source: "custom", title: "three" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_100);
      await notifier.drain();
      expect(sent).toHaveLength(2);
      expect(sent[1].html).toContain("2 approvals waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects source + minRisk filters and enabled:false", async () => {
    const { notifier, sent } = setup(cfg({ sources: ["exec"], minRisk: "high" }));
    createApprovalRequest({
      source: "orchestrator",
      title: "filtered by source",
      risk: "critical",
    });
    createApprovalRequest({ source: "exec", title: "filtered by risk", risk: "medium" });
    createApprovalRequest({ source: "exec", title: "delivered", risk: "high" });
    await notifier.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("delivered");

    const off = setup(cfg({ enabled: false }));
    createApprovalRequest({ source: "exec", title: "nope" });
    await off.notifier.drain();
    expect(off.sent).toHaveLength(0);
  });

  it("never exceeds Telegram's 4096-char limit, even with huge details", async () => {
    const { notifier, sent } = setup();
    createApprovalRequest({
      source: "exec",
      title: "T".repeat(500),
      summary: "<&>".repeat(2000),
      details: "<script>&amp;</script>\n".repeat(2000),
    });
    await notifier.drain();
    expect(sent[0].html.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(sent[0].html).not.toContain("<script>");
    expect(sent[0].html).toContain("&lt;script&gt;");
  });
});

describe("callbacks", () => {
  it("owner tap approves and the card is edited in place (buttons removed)", async () => {
    const { notifier, sent, edited } = setup();
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    await notifier.drain();
    const out = await notifier.handleCallback({
      data: `apv:a:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.drain();
    expect(out).toEqual({ handled: true, toast: "Approved ✅" });
    expect(getApprovalRequest(rec.id)).toMatchObject({
      status: "approved",
      decidedBy: "@boss",
      decidedVia: "telegram",
    });
    expect(edited).toHaveLength(1);
    expect(edited[0].messageId).toBe(sent[0].messageId);
    expect(edited[0].keyboard).toBeNull();
    expect(edited[0].html).toMatch(/✅ <b>Approved<\/b> by you \(@boss\) at \d\d:\d\d/);
  });

  it("taps from any other Telegram user are ignored", async () => {
    const { notifier, sent, edited } = setup();
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    await notifier.drain();
    for (const from of [{ id: STRANGER, username: "boss" }, { id: 555 }, null]) {
      const out = await notifier.handleCallback({
        data: `apv:a:${rec.id}`,
        from,
        chatId: OWNER,
        messageId: sent[0].messageId,
      });
      expect(out).toEqual({ handled: true, toast: "Not authorized" });
    }
    await notifier.drain();
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    expect(edited).toHaveLength(0);
  });

  it("legacy autopilot:approve:<id> buttons still resolve (owner only)", async () => {
    const { notifier } = setup();
    const rec = createApprovalRequest({ source: "autopilot", title: "auto" });
    await notifier.handleCallback({
      data: `autopilot:deny:${rec.id}`,
      from: { id: STRANGER },
      chatId: OWNER,
    });
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    await notifier.handleCallback({ data: `autopilot:deny:${rec.id}`, from: owner, chatId: OWNER });
    expect(getApprovalRequest(rec.id)!.status).toBe("denied");
  });

  it("a second tap after resolution reports who won", async () => {
    const { notifier } = setup();
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    resolveApprovalRequest(rec.id, { action: "deny", by: "web-ui", via: "ui" });
    const out = await notifier.handleCallback({
      data: `apv:a:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: 1,
    });
    expect(out.toast).toBe("Already denied by web-ui");
    expect(getApprovalRequest(rec.id)!.status).toBe("denied");
  });

  it("resolution from the web UI edits the Telegram card too", async () => {
    const { notifier, sent, edited } = setup();
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    await notifier.drain();
    resolveApprovalRequest(rec.id, { action: "deny", by: "Control UI", via: "ui" });
    await notifier.drain();
    expect(edited).toHaveLength(1);
    expect(edited[0].messageId).toBe(sent[0].messageId);
    expect(edited[0].html).toContain("❌ <b>Denied</b> by Control UI via web UI");
  });

  it("expiry edits the card to Expired — denied", async () => {
    vi.useFakeTimers();
    try {
      const { notifier, edited } = setup();
      const rec = createApprovalRequest({
        source: "orchestrator",
        title: "deploy",
        timeoutMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(1);
      await notifier.drain();
      await vi.advanceTimersByTimeAsync(61_000);
      await notifier.drain();
      expect(getApprovalRequest(rec.id)).toMatchObject({ status: "denied", reason: "expired" });
      expect(edited.at(-1)?.html).toContain("⌛ <b>Expired</b> — denied automatically");
      expect(edited.at(-1)?.keyboard).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("digest items are re-rendered as they resolve; buttons drop per item", async () => {
    const { notifier, sent, edited } = setup();
    const a = createApprovalRequest({ source: "custom", title: "first" });
    const b = createApprovalRequest({ source: "custom", title: "second" });
    await notifier.drain();
    await notifier.handleCallback({
      data: `apv:a:${a.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.drain();
    expect(edited.at(-1)!.messageId).toBe(sent[0].messageId);
    expect(edited.at(-1)!.html).toContain("1 approval waiting");
    expect(edited.at(-1)!.keyboard).toHaveLength(1);
    expect(edited.at(-1)!.keyboard![0][0].callback_data).toBe(`apv:a:${b.id}`);
    await notifier.handleCallback({
      data: `apv:d:${b.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.drain();
    expect(edited.at(-1)!.html).toContain("all resolved");
    expect(edited.at(-1)!.keyboard).toBeNull();
  });

  it("🔍 view sends the full card for a digest item (tracked for later edits)", async () => {
    const { notifier, sent } = setup();
    createApprovalRequest({ source: "custom", title: "first" });
    const b = createApprovalRequest({
      source: "custom",
      title: "second",
      details: "the full plan",
    });
    await notifier.drain();
    await notifier.handleCallback({
      data: `apv:v:${b.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.drain();
    expect(sent).toHaveLength(2);
    expect(sent[1].html).toContain("the full plan");
    expect(getApprovalRequest(b.id)!.telegram!.map((m) => m.kind)).toEqual(["digest", "single"]);
  });
});

describe("✍️ Reply… flow", () => {
  it("next owner message becomes a note, then Approve-with-note applies it", async () => {
    const { notifier, sent } = setup();
    const rec = createApprovalRequest({
      source: "orchestrator",
      title: "deploy",
      options: ["approve-with-note"],
    });
    await notifier.drain();
    await notifier.handleCallback({
      data: `apv:r:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.drain();
    expect(sent[1].forceReply).toBe(true);
    expect(sent[1].html).toContain("Note for");

    // A stranger's text in the same chat is not consumed.
    expect(
      await notifier.handleText({ chatId: OWNER, from: { id: STRANGER }, text: "approve!" }),
    ).toBe(false);
    expect(
      await notifier.handleText({
        chatId: OWNER,
        from: owner,
        text: "only the web app, not the gateway",
      }),
    ).toBe(true);
    await notifier.drain();
    expect(sent[2].html).toContain("Note captured");
    expect(sent[2].keyboard![0].map((b) => b.callback_data)).toEqual([
      `apv:n:${rec.id}`,
      `apv:m:${rec.id}`,
    ]);
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");

    await notifier.handleCallback({
      data: `apv:n:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[2].messageId,
    });
    expect(getApprovalRequest(rec.id)).toMatchObject({
      status: "approved",
      note: "only the web app, not the gateway",
    });
    // Later messages go to the normal pipeline again.
    expect(await notifier.handleText({ chatId: OWNER, from: owner, text: "hi" })).toBe(false);
  });

  it("for redirect-capable requests (check-ins) the reply IS the redirect", async () => {
    const { notifier, sent, edited } = setup();
    const rec = createApprovalRequest({
      source: "subagent-checkpoint",
      title: "Check-in: fix login",
      options: ["approve", "deny", "redirect"],
    });
    await notifier.drain();
    expect(sent[0].keyboard![0][1].text).toBe("🛑 Stop");
    expect(sent[0].keyboard![1][0].text).toBe("↪️ Redirect…");
    await notifier.handleCallback({
      data: `apv:r:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    await notifier.handleText({
      chatId: OWNER,
      from: owner,
      text: "Skip the refactor; only fix the null check",
    });
    await notifier.drain();
    expect(getApprovalRequest(rec.id)).toMatchObject({
      status: "redirected",
      note: "Skip the refactor; only fix the null check",
    });
    expect(edited.at(-1)!.html).toContain("↪️ <b>Redirected</b> by you");
    expect(edited.at(-1)!.html).toContain("📝 Skip the refactor");
  });

  it("/cancel aborts the note capture without resolving", async () => {
    const { notifier, sent } = setup();
    const rec = createApprovalRequest({ source: "orchestrator", title: "deploy" });
    await notifier.drain();
    await notifier.handleCallback({
      data: `apv:r:${rec.id}`,
      from: owner,
      chatId: OWNER,
      messageId: sent[0].messageId,
    });
    expect(await notifier.handleText({ chatId: OWNER, from: owner, text: "/cancel" })).toBe(true);
    await notifier.drain();
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    expect(sent.at(-1)!.html).toContain("Cancelled");
  });
});
