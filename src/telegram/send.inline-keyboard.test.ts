import { describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => ({
  Bot: class {
    api = {};
    catch = vi.fn();
  },
  HttpError: class extends Error {},
  InputFile: class {},
}));

import { buildInlineKeyboard, sendMessageTelegram, stripUrlButtons } from "./send.js";

describe("buildInlineKeyboard — callback + URL buttons", () => {
  it("keeps callback buttons and adds http(s) URL buttons", () => {
    expect(
      buildInlineKeyboard([
        [
          { text: "Approve", callback_data: "apv:a:1" },
          { text: "Deny", callback_data: "apv:d:1" },
        ],
        [{ text: "Open", url: "https://box.ts.net/m/approvals/1" }],
      ]),
    ).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: "apv:a:1" },
          { text: "Deny", callback_data: "apv:d:1" },
        ],
        [{ text: "Open", url: "https://box.ts.net/m/approvals/1" }],
      ],
    });
  });

  it("drops buttons Telegram would refuse (no action, custom scheme)", () => {
    expect(
      buildInlineKeyboard([
        [{ text: "App", url: "infinibot://runs/1" }, { text: "Nothing" }],
        [{ text: "", callback_data: "x" }],
      ]),
    ).toBeUndefined();
    expect(buildInlineKeyboard([])).toBeUndefined();
  });

  it("stripUrlButtons leaves only callback buttons", () => {
    const kb = buildInlineKeyboard([
      [{ text: "A", callback_data: "a" }],
      [{ text: "Open", url: "https://x.example/m/" }],
    ])!;
    expect(stripUrlButtons(kb)).toEqual({ inline_keyboard: [[{ text: "A", callback_data: "a" }]] });
    expect(
      stripUrlButtons({ inline_keyboard: [[{ text: "Open", url: "https://x.example" }]] }),
    ).toBeUndefined();
  });

  it("resends without the URL button when Telegram refuses it", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("400: Bad Request: BUTTON_URL_INVALID"))
      .mockResolvedValueOnce({ message_id: 7, chat: { id: "123" } });
    const res = await sendMessageTelegram("123", "hello", {
      token: "tok",
      api: { sendMessage } as never,
      textMode: "html",
      buttons: [
        [{ text: "Retry", callback_data: "vc:retry:t" }],
        [{ text: "Open", url: "https://box.ts.net/m/runs/r1" }],
      ],
    });
    expect(res.messageId).toBe("7");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][2].reply_markup.inline_keyboard).toHaveLength(2);
    expect(sendMessage.mock.calls[1][2].reply_markup).toEqual({
      inline_keyboard: [[{ text: "Retry", callback_data: "vc:retry:t" }]],
    });
  });
});
