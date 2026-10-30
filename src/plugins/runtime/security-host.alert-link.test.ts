import { beforeEach, describe, expect, it, vi } from "vitest";

const emitNotification = vi.fn(async (_o: Record<string, unknown>) => "n1");
vi.mock("../../notifications/emit.js", () => ({
  emitNotification: (o: Record<string, unknown>) => emitNotification(o),
}));
const send = vi.fn(async () => ({ messageId: 1 }));
vi.mock("../../approvals/telegram-approvals.js", () => ({
  resolveTelegramApprovalsConfig: () => ({ enabled: true, chatId: "42", accountId: undefined }),
  createDefaultApprovalTransport: () => ({ send }),
}));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));

import { hostAlertOwner, hostLinkPair } from "./security-host.js";

beforeEach(() => {
  emitNotification.mockClear();
  send.mockClear();
  process.env.INFINIBOT_PUBLIC_URL = "https://ib.example.com";
});

describe("hostAlertOwner link", () => {
  it("turns a web path into deepLink + Open button", async () => {
    await hostAlertOwner({
      title: "Solatrix · Buy",
      body: "x",
      severity: "warning",
      link: "/solatrix/alerts",
    });
    expect(emitNotification.mock.calls[0][0]).toMatchObject({
      deepLink: "infinibot://web/solatrix/alerts",
      webUrl: "https://ib.example.com/m/web/solatrix/alerts",
    });
    const [, text, opts] = send.mock.calls[0] as unknown as [string, string, { keyboard: unknown }];
    expect(text).not.toContain("Open:");
    expect(opts.keyboard).toEqual([
      [{ text: "🔗 Open", url: "https://ib.example.com/m/web/solatrix/alerts" }],
    ]);
    delete process.env.INFINIBOT_PUBLIC_URL;
  });

  it("no link → no deep link, no keyboard", async () => {
    await hostAlertOwner({ title: "t", body: "b" });
    expect(emitNotification.mock.calls[0][0]).toMatchObject({ deepLink: null });
    expect((send.mock.calls[0] as unknown[])[2]).toBeUndefined();
    expect(hostLinkPair("infinibot://discipline").deepLink).toBe("infinibot://discipline");
    delete process.env.INFINIBOT_PUBLIC_URL;
  });
});
