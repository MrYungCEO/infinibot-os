import { describe, expect, it } from "vitest";

import { excerpt, filterIdeas, parseTagInput, promotedLabel, relTime, type Idea } from "./ideas-model";

const idea = (over: Partial<Idea>): Idea => ({
  id: "i",
  title: "t",
  body: "",
  tags: [],
  source: "web",
  status: "new",
  projectIds: [],
  taskIds: [],
  docIds: [],
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
  ...over,
});

describe("ideas model", () => {
  const list = [
    idea({ id: "a", title: "Blob face", body: "listens on tap", tags: ["mobile"], status: "exploring" }),
    idea({ id: "b", title: "Annual plan", tags: ["pricing"], status: "parked" }),
    idea({ id: "c", title: "Docs export", status: "new" }),
  ];

  it("filters by query (title/body/tags), status and tag", () => {
    expect(filterIdeas(list, { query: "TAP", status: "all", tag: null }).map((i) => i.id)).toEqual(["a"]);
    expect(filterIdeas(list, { query: "", status: "parked", tag: null }).map((i) => i.id)).toEqual(["b"]);
    expect(filterIdeas(list, { query: "", status: "all", tag: "mobile" }).map((i) => i.id)).toEqual(["a"]);
    expect(filterIdeas(list, { query: "pricing", status: "new", tag: null })).toEqual([]);
  });

  it("parses tag input", () => {
    expect(parseTagInput("#Voice, mobile  voice,,ux")).toEqual(["voice", "mobile", "ux"]);
  });

  it("excerpts and labels", () => {
    expect(excerpt("# Heading\n\n**bold** text", 12)).toBe("Heading bol…");
    expect(relTime("2026-10-13T00:00:00Z", Date.parse("2026-10-13T02:00:00Z"))).toBe("2h ago");
    const names = { projects: new Map([["p1", "FlyPic"]]), docs: new Map<string, string>() };
    expect(promotedLabel(idea({ promotedTo: { kind: "project", id: "p1", at: "" } }), names)).toBe("Project · FlyPic");
    expect(promotedLabel(idea({}), names)).toBeNull();
  });
});
