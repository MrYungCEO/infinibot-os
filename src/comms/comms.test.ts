import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CommsStore } from "./store.js";
import { evaluateSend } from "./autonomy.js";
import { telegramAdapter } from "./adapters/telegram.js";
import { getAdapter } from "./adapters/index.js";
import { threadKeyFor } from "./types.js";

const tmpDirs: string[] = [];
function freshStore(): CommsStore {
  const dir = mkdtempSync(join(tmpdir(), "comms-"));
  tmpDirs.push(dir);
  return new CommsStore(join(dir, "comms.db"));
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("CommsStore", () => {
  it("records inbound + outbound and rolls them into one thread", () => {
    const store = freshStore();
    const threadKey = threadKeyFor("client1", "telegram", "12345");
    store.recordMessage({
      channel: "telegram",
      direction: "inbound",
      threadKey,
      clientId: "client1",
      agencyId: "default",
      peerHandle: "12345",
      text: "hi there",
      status: "received",
    });
    store.recordMessage({
      channel: "telegram",
      direction: "outbound",
      threadKey,
      clientId: "client1",
      agencyId: "default",
      peerHandle: "12345",
      text: "hello back",
      status: "sent",
    });

    const threads = store.listThreads("default");
    expect(threads).toHaveLength(1);
    expect(threads[0].messageCount).toBe(2);
    expect(threads[0].unreadCount).toBe(1); // inbound unread, outbound implicitly read
    expect(threads[0].lastDirection).toBe("outbound");

    store.markThreadRead(threadKey);
    expect(store.listThreads("default")[0].unreadCount).toBe(0);
  });

  it("persists and enforces agent permissions round-trip", () => {
    const store = freshStore();
    const perm = store.setPermission({
      agentId: "pm",
      autonomy: "full_auto",
      channels: ["telegram"],
      dailySendLimit: 2,
    });
    expect(perm.channels).toEqual(["telegram"]);
    const reloaded = store.getPermission("pm");
    expect(reloaded?.autonomy).toBe("full_auto");
    expect(reloaded?.dailySendLimit).toBe(2);
  });
});

describe("evaluateSend (autonomy)", () => {
  const base = {
    agentId: "pm",
    enabled: true,
    autonomy: "full_auto" as const,
    channels: ["telegram" as const],
    clientScope: "all" as const,
    dailySendLimit: null,
    updatedAt: 0,
  };

  it("denies an agent with no permission (fail-closed)", () => {
    expect(evaluateSend({ permission: null, channel: "telegram", clientId: "c1" }).outcome).toBe("deny");
  });

  it("denies a channel not on the allowlist", () => {
    const d = evaluateSend({ permission: base, channel: "discord", clientId: "c1" });
    expect(d.outcome).toBe("deny");
  });

  it("requires approval for draft_for_approval", () => {
    const d = evaluateSend({
      permission: { ...base, autonomy: "draft_for_approval" },
      channel: "telegram",
      clientId: "c1",
    });
    expect(d.outcome).toBe("needs_approval");
  });

  it("allows full_auto within limits", () => {
    expect(evaluateSend({ permission: base, channel: "telegram", clientId: "c1" }).outcome).toBe("allow");
  });

  it("denies once the daily limit is reached", () => {
    const d = evaluateSend({
      permission: { ...base, dailySendLimit: 1 },
      channel: "telegram",
      clientId: "c1",
      sendsToday: 1,
    });
    expect(d.outcome).toBe("deny");
  });

  it("enforces client scope", () => {
    const d = evaluateSend({
      permission: { ...base, clientScope: ["allowed"] },
      channel: "telegram",
      clientId: "other",
    });
    expect(d.outcome).toBe("deny");
  });
});

describe("telegram adapter", () => {
  it("is the live adapter in the registry", () => {
    expect(getAdapter("telegram")).toBe(telegramAdapter);
  });

  it("normalizes a flat inbound payload", () => {
    const msg = telegramAdapter.normalizeInbound({
      chatId: "999",
      text: "need help",
      from: { first_name: "Ada", username: "ada" },
      messageId: 7,
      agencyId: "default",
      // clientId provided → adapter skips the DB-backed handle lookup (keeps this
      // a pure normalization test; DB-backed resolution is covered at runtime).
      clientId: "clientX",
    });
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe("telegram");
    expect(msg!.direction).toBe("inbound");
    expect(msg!.peerHandle).toBe("999");
    expect(msg!.text).toBe("need help");
    expect(msg!.channelMessageId).toBe("7");
    expect(msg!.peerDisplayName).toBe("Ada");
  });

  it("returns null when no chat id is present", () => {
    expect(telegramAdapter.normalizeInbound({ text: "x" })).toBeNull();
  });
});

describe("stub adapters", () => {
  it("report not-configured and throw on send", async () => {
    const email = getAdapter("email");
    const status = await email.status();
    expect(status.configured).toBe(false);
    expect(status.setupNotes).toBeTruthy();
    await expect(
      email.send({ channel: "email", agencyId: "default", clientId: null, peerHandle: "x@y.com", text: "hi" }),
    ).rejects.toThrow(/not configured/i);
  });
});
