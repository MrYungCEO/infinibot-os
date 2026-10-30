import { describe, expect, it } from "vitest";

import { SpeechShaper, cleanInline, splitSentences } from "./voice-speech.js";

function shaper(maxChars?: number) {
  const out: string[] = [];
  const s = new SpeechShaper({ emit: (t) => out.push(t), maxChars });
  return { s, out, text: () => out.join("") };
}

describe("SpeechShaper", () => {
  it("streams the first message at word boundaries without cutting words", () => {
    const { s, out, text } = shaper();
    s.push("Hello the");
    expect(text()).toBe("Hello ");
    s.push("re, how are you?");
    s.end();
    expect(text()).toBe("Hello there, how are you?");
    expect(out.length).toBeGreaterThan(1);
  });

  it("speaks a final payload that repeats the streamed text only once", () => {
    const { s, text } = shaper();
    s.push("All three agents are running. I will tell you when they finish.");
    s.boundary();
    s.push("All three agents are running. I will tell you when they finish.");
    s.end();
    expect(text()).toBe("All three agents are running. I will tell you when they finish.");
  });

  it("joins separate assistant messages with a space and keeps order", () => {
    const { s, text } = shaper();
    s.push("Checking your tasks.");
    s.boundary();
    s.push("You have two open tasks.");
    s.end();
    expect(text()).toBe("Checking your tasks. You have two open tasks.");
  });

  it("drops the agent echoing the acknowledgement", () => {
    const { s, text } = shaper();
    s.say("Sure, pulling that up.");
    s.push("Sure, pulling that up. Your inbox has four new emails.");
    s.end();
    expect(text()).toBe("Sure, pulling that up. Your inbox has four new emails.");
  });

  it("never reads markdown, links, code fences or tool JSON aloud", () => {
    const { s, text } = shaper();
    s.push("## Status\n- **Build** is green\n- See [the run](https://x.y/z)\n");
    s.push('{"tool_call": {"name": "kanban", "args": {}}}\n');
    s.push("```js\nconsole.log(1)\n```\nAll good 🎉");
    s.end();
    const t = text();
    expect(t).not.toMatch(/[#*`{}[\]]|https?:|console|tool_call|🎉/);
    expect(t).toContain("Build is green");
    expect(t).toContain("See the run");
    expect(t).toContain("All good");
  });

  it("holds a payload line until it is complete, then drops it", () => {
    const { s, text } = shaper();
    s.push('{"name": "web_se');
    expect(text()).toBe("");
    s.push('arch"}\nFound it.');
    s.end();
    expect(text()).toBe("Found it.");
  });

  it("cuts a long reply at a sentence end and says the rest is in the chat", () => {
    const { s, text } = shaper(60);
    const long = Array.from({ length: 12 }, (_, i) => `Item number ${i} is done.`).join(" ");
    s.push(long);
    s.end();
    const t = text();
    expect(t.length).toBeLessThan(long.length);
    expect(t).toMatch(/done\. The full details are in the chat\.$/);
    expect(s.fullText.length).toBeGreaterThanOrEqual(long.length - 1);
    expect(s.wasTruncated).toBe(true);
  });

  it("reports pending output so an ack is not spoken over a reply in progress", () => {
    const { s } = shaper();
    expect(s.hasOutput()).toBe(false);
    s.push("Wor");
    expect(s.hasOutput()).toBe(true);
  });
});

describe("helpers", () => {
  it("cleanInline removes emphasis and replaces urls", () => {
    expect(cleanInline("**bold** and `code` at https://a.b/c")).toBe("bold and code at the link");
  });
  it("splitSentences keeps terminators", () => {
    expect(splitSentences("One. Two? Three")).toEqual(["One.", "Two?", "Three"]);
  });
});
