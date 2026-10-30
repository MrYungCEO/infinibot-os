import { describe, expect, it, vi } from "vitest";

// The real element pulls in three.js / canvas code; the panel only needs its tag.
vi.mock("../../components/knowledge-graph.js", () => ({}));

const { renderKnowledgeGraphPanel } = await import("./knowledge-graph-panel");

describe("knowledge graph grid panel", () => {
  const markup = renderKnowledgeGraphPanel({ client: null }).strings.join("");

  it("makes the graph element the growing flex item so it fills the tile", () => {
    const el = markup.slice(markup.indexOf("<infinibot-knowledge-graph"));
    expect(el).toMatch(/style="[^"]*flex:1;/);
    expect(el).toMatch(/style="[^"]*min-height:0;/);
  });

  it("keeps the wrapper a full-height flex column", () => {
    const wrap = markup.slice(markup.indexOf('<div class="kg-grid-panel"'));
    expect(wrap).toMatch(/height:100%;/);
    expect(wrap).toMatch(/display:flex;flex-direction:column;/);
  });
});
