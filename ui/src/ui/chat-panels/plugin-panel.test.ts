import { describe, expect, it } from "vitest";

import { actionMethodAllowed, renderPluginPanel, safeHref, safeMediaUrl } from "./plugin-panel";

describe("plugin panel guards", () => {
  it("buttons may call only their own plugin's RPCs (never chat.panel.*)", () => {
    expect(actionMethodAllowed("flypic.generation", "flypic.generate.start")).toBe(true);
    expect(actionMethodAllowed("flypic.feed", "flypic.feed.favorite")).toBe(true);
    expect(actionMethodAllowed("flypic.feed", "config.apply")).toBe(false);
    expect(actionMethodAllowed("flypic.feed", "flypicx.do")).toBe(false);
    expect(actionMethodAllowed("flypic.feed", "chat.panel.show")).toBe(false);
    expect(actionMethodAllowed("flypic.feed", 42)).toBe(false);
  });

  it("links: http(s), in-app paths and media data URLs only", () => {
    expect(safeHref("https://flypic.ai/app")).toBe("https://flypic.ai/app");
    expect(safeHref("/flypic?view=feed")).toBe("/flypic?view=feed");
    expect(safeHref("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil.test/x")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
  });

  it("media: http(s), blob, same-origin paths and image/video data URLs only", () => {
    expect(safeMediaUrl("data:image/svg+xml,%3Csvg%3E")).toBeTruthy();
    expect(safeMediaUrl("https://cdn.test/v.mp4")).toBeTruthy();
    expect(safeMediaUrl("javascript:1")).toBeNull();
    expect(safeMediaUrl("data:text/html,x")).toBeNull();
  });

  it("renders every block without live state (static surfaces) and with it", () => {
    const data = {
      alert: { tone: "danger", title: "Failed", message: "Higgsfield failed (request_id hf_1)", details: [{ label: "Request id", value: "hf_1" }] },
      progress: { label: "Generating…", startedAt: Date.now() - 5000, typicalSeconds: 20 },
      media: [{ url: "data:image/png;base64,AA", kind: "image" }],
      fields: [{ label: "Model", value: "m" }],
      actions: [{ id: "regenerate", label: "Regenerate", rpc: { method: "flypic.generate.start" } }],
      grid: { layout: "media", items: [{ id: "a", title: "A", media: { url: "data:image/png;base64,AA", kind: "image" } }] },
    };
    expect(renderPluginPanel(data, "card")).toBeTruthy();
    const ctx = {
      kind: "flypic.feed",
      query: {},
      setQuery: () => {},
      selected: "a",
      select: () => {},
      inputFor: "panel:regenerate",
      inputValue: "x",
      openInput: () => {},
      setInputValue: () => {},
      cancelInput: () => {},
      run: () => {},
      busyKey: null,
      actionError: "nope",
      actionNote: null,
      spawned: [],
      now: Date.now(),
    };
    expect(renderPluginPanel(data, "modal", ctx)).toBeTruthy();
  });
});
