import { describe, it, expect } from "vitest";
import { validatePopupMedia } from "./popup-types.js";
import { canvasFromMarkdown } from "./canvas-from-markdown.js";

const goodPayload = {
  title: "Demo",
  nodes: [
    { id: "a", kind: "title", x: 0, y: 0, w: 600, h1: "Hello" },
    { id: "b", kind: "text", x: 800, y: 0, w: 600, body: "World" },
  ],
  links: [["a", "b"]],
  scenes: [
    { id: "s1", focusNodeId: "a", narration: { ttsText: "First." } },
    { id: "s2", focusNodeId: "b", narration: { audioUrl: "/api/proactive/audio/x.mp3" } },
  ],
};

describe("infinite-canvas-walkthrough validator", () => {
  it("accepts a well-formed payload", () => {
    const { media, error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: goodPayload,
    });
    expect(error).toBeUndefined();
    expect(media?.kind).toBe("infinite-canvas-walkthrough");
  });

  it("rejects empty nodes", () => {
    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: { ...goodPayload, nodes: [] },
    });
    expect(error).toMatch(/nodes/);
  });

  it("rejects a node missing geometry", () => {
    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: { ...goodPayload, nodes: [{ id: "a", kind: "text" }] },
    });
    expect(error).toMatch(/x, y, w/);
  });

  it("rejects an unknown node kind", () => {
    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: { ...goodPayload, nodes: [{ id: "a", kind: "bogus", x: 0, y: 0, w: 1 }] },
    });
    expect(error).toMatch(/kind must be one of/);
  });

  it("rejects a scene focusNodeId that is not a node", () => {
    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: { ...goodPayload, scenes: [{ id: "s1", focusNodeId: "ghost" }] },
    });
    expect(error).toMatch(/not a known node id/);
  });

  it("rejects narration with neither audioUrl nor ttsText", () => {
    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload: { ...goodPayload, scenes: [{ id: "s1", narration: { voice: "x" } }] },
    });
    expect(error).toMatch(/audioUrl or ttsText/);
  });
});

describe("canvasFromMarkdown", () => {
  const md = [
    "---",
    "title: The 10x Workflow",
    "voice: af_heart",
    "---",
    "# The 10x Workflow",
    "One operator commands a parallel fleet by voice.",
    "",
    "## The Problem",
    "Solo AI coding is one thread of attention.",
    "",
    "## Voice Input",
    "Speaking is faster than typing.",
  ].join("\n");

  it("builds a valid payload from a markdown script", () => {
    const payload = canvasFromMarkdown(md);
    expect(payload.title).toBe("The 10x Workflow");
    expect(payload.nodes).toHaveLength(3);
    expect(payload.scenes).toHaveLength(3);
    // first node is the title; rest are text
    expect(payload.nodes[0].kind).toBe("title");
    expect(payload.nodes[1].kind).toBe("text");
    // sequential links
    expect(payload.links).toHaveLength(2);
    // narration carries the section body + the frontmatter voice
    expect(payload.scenes[1].narration?.ttsText).toContain("one thread of attention");
    expect(payload.scenes[1].narration?.voice).toBe("af_heart");
    expect(payload.voiceSuppress).toBe(true);

    const { error } = validatePopupMedia({
      kind: "infinite-canvas-walkthrough",
      payload,
    });
    expect(error).toBeUndefined();
  });
});
