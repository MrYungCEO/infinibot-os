import { describe, expect, it } from "vitest";

import { coerceToolContent } from "./infinibot-adapter.js";

describe("MCP tool content", () => {
  it("passes tool images (phone screenshots) through next to the text", () => {
    const out = coerceToolContent({
      content: [
        { type: "text", text: "Screenshot of Phone 01 (dev-01)." },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      details: { path: "/tmp/x.png" },
    });
    expect(out).toEqual([
      { type: "text", text: "Screenshot of Phone 01 (dev-01)." },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  });

  it("keeps text-only results as before and drops malformed images", () => {
    expect(coerceToolContent({ content: [{ type: "text", text: "ok" }] })).toEqual([
      { type: "text", text: "ok" },
    ]);
    expect(
      coerceToolContent({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "" },
        ],
      }),
    ).toEqual([{ type: "text", text: "a" }]);
    expect(coerceToolContent("plain")).toEqual([{ type: "text", text: "plain" }]);
    expect(coerceToolContent({ a: 1 })[0].type).toBe("text");
  });
});
