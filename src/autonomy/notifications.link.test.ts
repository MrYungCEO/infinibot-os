import { describe, expect, it } from "vitest";
import { formatTelegramMessage } from "./notifications.js";

describe("autonomy Telegram Open line", () => {
  it("adds an escaped Open line after the task footer", () => {
    const text = formatTelegramMessage({
      id: "n",
      timestamp: 0,
      level: "success",
      title: "Goal completed",
      message: "body",
      channel: "telegram",
      sent: false,
      taskId: "g1",
      deepLink: "infinibot://goals/g1",
      webUrl: "https://box.ts.net/m/goals/g1?a=1&b=2",
    });
    expect(text).toContain(
      "<code>Task: g1</code>\nOpen: https://box.ts.net/m/goals/g1?a=1&amp;b=2",
    );
  });
  it("no line without a web URL", () => {
    const text = formatTelegramMessage({
      id: "n",
      timestamp: 0,
      level: "info",
      title: "t",
      message: "m",
      channel: "telegram",
      sent: false,
    });
    expect(text).not.toContain("Open:");
  });
});
