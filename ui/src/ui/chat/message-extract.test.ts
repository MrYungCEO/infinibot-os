import { describe, expect, it } from "vitest";

import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
} from "./message-extract";

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });

  it("falls back to assistant errorMessage when content is empty", () => {
    const message = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 Provider returned error",
    };

    expect(extractTextCached(message)).toBe(
      "⚠️ Rate limit reached. Wait a minute and try again, switch to another model, or check your AI provider plan.",
    );
  });
});

describe("extractThinkingCached", () => {
  it("matches extractThinking output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe(extractThinking(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});

describe("attachment OCR context", () => {
  it("is hidden from user bubbles", async () => {
    const { extractText } = await import("./message-extract");
    const text = extractText({
      role: "user",
      content: 'Who is the owner?\n\n<attachment_context source="local-ocr">\n[Attachment 1: a.png]\nsecret OCR\n</attachment_context>',
    });
    expect(text).toBe("Who is the owner?");
  });
});
