/**
 * End-to-end harness against a STUB Telegram Bot API server (no real Telegram).
 *
 * Drives the real createTelegramBot() handler stack (callback_query + message
 * handlers, grammy, api throttler) through `proxyFetch`, which rewrites
 * api.telegram.org → a local HTTP stub. With APPROVALS_SAMPLE_DIR set it also
 * writes the rendered sample message text + keyboard JSON there.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  _resetApprovalRegistry,
  createApprovalRequest,
  getApprovalRequest,
} from "../autonomy/approval-registry.js";
import type { InfinibotConfig } from "../config/config.js";
import { createTelegramBot } from "../telegram/bot.js";
import {
  _resetTelegramApprovals,
  installTelegramApprovals,
  registerApprovalTelegramApi,
} from "./telegram-approvals.js";

const OWNER = 424242;
const STRANGER = 777;
const TOKEN = "123456:TEST-TOKEN-not-real";

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let server: http.Server;
let base = "";
let msgSeq = 500;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop() ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      calls.push({ method, body });
      let result: unknown = true;
      if (method === "sendMessage") {
        msgSeq += 1;
        result = {
          message_id: msgSeq,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: "private" },
          text: String(body.text ?? ""),
        };
      } else if (method === "getMe") {
        result = { id: 1, is_bot: true, first_name: "stub", username: "stub_bot" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  _resetTelegramApprovals();
  await new Promise<void>((r) => server.close(() => r()));
});

const stubFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "object" && "url" in input ? input.url : input);
  if (!url.startsWith("https://api.telegram.org/")) {
    throw new Error(`unexpected outbound fetch in harness: ${url}`);
  }
  return fetch(url.replace("https://api.telegram.org", base), init);
}) as typeof fetch;

const config = {
  channels: {
    telegram: {
      botToken: TOKEN,
      defaultChatId: String(OWNER),
      allowFrom: [String(OWNER)],
      dmPolicy: "allowlist",
    },
  },
  approvals: { telegram: { digestWindowMs: 0, minIntervalMs: 0 } },
} as unknown as InfinibotConfig;

let updateId = 1000;
function bot() {
  const b = createTelegramBot({
    token: TOKEN,
    config,
    accountId: "default",
    proxyFetch: stubFetch,
    runtime: { log: () => {}, error: () => {}, exit: () => {} } as never,
  });
  b.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "stub",
    username: "stub_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as never;
  return b;
}

function tap(b: ReturnType<typeof bot>, data: string, fromId: number, messageId: number) {
  updateId += 1;
  return b.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      chat_instance: "ci",
      data,
      from: {
        id: fromId,
        is_bot: false,
        first_name: "x",
        username: fromId === OWNER ? "boss" : "intruder",
      },
      message: {
        message_id: messageId,
        date: 1,
        chat: { id: OWNER, type: "private" },
        text: "card",
      },
    },
  } as never);
}

function say(b: ReturnType<typeof bot>, text: string) {
  updateId += 1;
  return b.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER, is_bot: false, first_name: "Boss", username: "boss" },
      text,
    },
  } as never);
}

beforeEach(() => {
  calls.length = 0;
  _resetApprovalRegistry();
  _resetTelegramApprovals();
});

describe("Telegram approvals over a stub Bot API", () => {
  it("send card → stranger tap ignored → owner tap approves → card edited in place", async () => {
    const b = bot();
    registerApprovalTelegramApi("default", b.api);
    const notifier = installTelegramApprovals({ getConfig: () => config });

    const rec = createApprovalRequest({
      source: "orchestrator",
      title: "fly deploy infinibot-gateway (billable)",
      summary: "Deploy image bff644a9 to the personal Fly org. Costs ~$0.40/day while running.",
      details:
        "fly deploy -a example-app --image registry.example/app:1 \\\n  --strategy rolling\nFLY_API_TOKEN=fo1_abcdefghijklmnopqrstuvwx",
      risk: "high",
      requester: { label: "MCP orchestrator · Claude Code", sessionKey: "agent:main:mcp-cc-1" },
    });
    await notifier.drain();

    const send = calls.find((c) => c.method === "sendMessage")!;
    expect(send.body.chat_id).toBe(String(OWNER));
    expect(send.body.parse_mode).toBe("HTML");
    expect(String(send.body.text)).not.toContain("fo1_abcdefghijklmnopqrstuvwx");
    const keyboard = (send.body.reply_markup as { inline_keyboard: unknown }).inline_keyboard;
    expect(keyboard).toEqual([
      [
        { text: "✅ Approve", callback_data: `apv:a:${rec.id}` },
        { text: "❌ Deny", callback_data: `apv:d:${rec.id}` },
      ],
      [{ text: "✍️ Reply…", callback_data: `apv:r:${rec.id}` }],
    ]);
    const messageId = getApprovalRequest(rec.id)!.telegram![0].messageId;

    // Stranger: ignored, gets a toast, nothing edited.
    await tap(b, `apv:a:${rec.id}`, STRANGER, messageId);
    await notifier.drain();
    expect(getApprovalRequest(rec.id)!.status).toBe("pending");
    expect(calls.filter((c) => c.method === "editMessageText")).toHaveLength(0);
    expect(calls.find((c) => c.method === "answerCallbackQuery")?.body.text).toBe("Not authorized");

    // Owner: approved + edited in place with buttons removed.
    await tap(b, `apv:a:${rec.id}`, OWNER, messageId);
    await notifier.drain();
    expect(getApprovalRequest(rec.id)).toMatchObject({
      status: "approved",
      decidedBy: "@boss",
      decidedVia: "telegram",
    });
    const edit = calls.find((c) => c.method === "editMessageText")!;
    expect(edit.body.message_id).toBe(messageId);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(String(edit.body.text)).toMatch(/Approved<\/b> by you \(@boss\) at \d\d:\d\d/);
    expect(calls.filter((c) => c.method === "answerCallbackQuery").at(-1)?.body.text).toBe(
      "Approved ✅",
    );

    // Sample artefacts for the PR / operator (APPROVALS_SAMPLE_DIR=<dir> to write).
    const outDir = process.env.APPROVALS_SAMPLE_DIR;
    if (!outDir) return;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "telegram-sample-card.json"),
      JSON.stringify(
        {
          sendMessage: send.body,
          afterOwnerTap_editMessageText: edit.body,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(outDir, "telegram-sample-card.txt"),
      `${String(send.body.text)}\n\n--- keyboard ---\n${JSON.stringify(keyboard, null, 2)}\n\n--- after tap ---\n${String(edit.body.text)}\n`,
    );
  });

  it("burst → one digest; ✍️ Reply… → next owner message becomes the redirect", async () => {
    const b = bot();
    registerApprovalTelegramApi("default", b.api);
    const notifier = installTelegramApprovals({ getConfig: () => config });

    createApprovalRequest({
      source: "exec",
      title: "Run command on gateway",
      details: "rm -rf dist",
      options: ["approve-always"],
    });
    createApprovalRequest({
      source: "orchestrator",
      title: "Restart gateway :18789",
      risk: "critical",
    });
    const cp = createApprovalRequest({
      source: "subagent-checkpoint",
      title: "Check-in: fix login",
      summary: "Fixed the null check in session.ts",
      details: "NEXT: rewrite the auth module",
      options: ["approve", "deny", "redirect"],
      requester: { label: "claude_coder · fix login", runId: "run-abc123" },
    });
    await notifier.drain();

    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(String(sends[0].body.text)).toContain("3 approvals waiting");
    const digestKeyboard = (sends[0].body.reply_markup as { inline_keyboard: unknown[][] })
      .inline_keyboard;
    expect(digestKeyboard).toHaveLength(3);
    const digestId = getApprovalRequest(cp.id)!.telegram![0].messageId;

    await tap(b, `apv:r:${cp.id}`, OWNER, digestId);
    await notifier.drain();
    const prompt = calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(prompt.body.reply_markup).toMatchObject({ force_reply: true });

    await say(b, "Skip the rewrite — only fix the null check and add a test");
    await notifier.drain();
    expect(getApprovalRequest(cp.id)).toMatchObject({
      status: "redirected",
      note: "Skip the rewrite — only fix the null check and add a test",
    });
    const digestEdit = calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(digestEdit.body.message_id).toBe(digestId);
    expect(String(digestEdit.body.text)).toContain("2 approvals waiting");

    if (!process.env.APPROVALS_SAMPLE_DIR) return;
    fs.writeFileSync(
      path.join(process.env.APPROVALS_SAMPLE_DIR, "telegram-sample-digest.json"),
      JSON.stringify(
        { digest: sends[0].body, replyPrompt: prompt.body, digestAfterRedirect: digestEdit.body },
        null,
        2,
      ),
    );
  });
});
