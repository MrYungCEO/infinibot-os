import { describe, expect, it } from "vitest";
import { renderTelegramHtmlText } from "../telegram/format.js";
import { buildMessage } from "./telegram-completions.js";

describe("telegram completion Open link", () => {
  it("appends a markdown link that renders as an anchor", () => {
    const md = buildMessage(
      "end",
      "Fix nav",
      { endedAt: 2000 },
      1000,
      "https://box.ts.net/m/chat/a%3Ab",
    );
    expect(md).toContain("[Open in InfiniBot](https://box.ts.net/m/chat/a%3Ab)");
    expect(renderTelegramHtmlText(md, { textMode: "markdown" })).toContain(
      '<a href="https://box.ts.net/m/chat/a%3Ab">Open in InfiniBot</a>',
    );
  });
  it("omits the link without a public base", () => {
    expect(buildMessage("error", "Fix nav", { error: "boom" }, undefined, null)).not.toContain(
      "Open",
    );
  });
});
