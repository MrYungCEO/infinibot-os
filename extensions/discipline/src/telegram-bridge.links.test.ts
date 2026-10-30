import { describe, expect, it } from "vitest";
import { DISCIPLINE_DEEP_LINK, withOpenLink } from "./telegram-bridge.js";

describe("discipline Telegram Open link", () => {
  it("appends a markdown link when the host has a web URL", () => {
    expect(DISCIPLINE_DEEP_LINK).toBe("infinibot://discipline");
    expect(withOpenLink("🔔 **Deep work** is up", "https://box.ts.net/m/discipline")).toBe(
      "🔔 **Deep work** is up\n[Open in InfiniBot](https://box.ts.net/m/discipline)",
    );
    expect(withOpenLink("x", null)).toBe("x");
  });
});
