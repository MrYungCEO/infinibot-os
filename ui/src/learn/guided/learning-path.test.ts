import { describe, expect, it } from "vitest";

import { PARALLEL_REF, buildPath, mergeRefs, nextInPath, pathProgress, resolvePath } from "./learning-path";

const wt = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id.toUpperCase(), summary: "", estMinutes: 3, steps: [], ...extra });
const tracks = [
  { id: "chat-models", title: "Chat", walkthroughs: [wt("first-chat"), wt("composer"), wt("sessions")] },
  { id: "agents", title: "Agents", walkthroughs: [wt("agent-control"), wt("parallel-sub-agents"), wt("watch-runs")] },
  // "advanced" lists its prerequisite after itself in the catalogue.
  { id: "projects", title: "Projects", walkthroughs: [wt("advanced", { prerequisites: ["projects/basics"] }), wt("basics")] },
  { id: "business-agency", title: "Business", walkthroughs: [wt("clients"), wt("invoices")] },
] as never[];

describe("learning path", () => {
  it("orders lessons by the onboarding courses, adds parallel sub-agents after the first course", () => {
    expect(buildPath(["chat-models", "projects", "business-agency"], tracks)).toEqual([
      "chat-models/first-chat",
      "chat-models/composer",
      PARALLEL_REF,
      "projects/basics",
      "projects/advanced",
      "business-agency/clients",
      "business-agency/invoices",
    ]);
  });

  it("skips courses this install doesn't have and caps the length", () => {
    expect(buildPath(["chat-models", "solatrix"], tracks, { max: 3 })).toEqual(["chat-models/first-chat", "chat-models/composer", PARALLEL_REF]);
    expect(buildPath([], tracks)).toEqual([PARALLEL_REF]);
  });

  it("resolves titles from the catalogue and drops lessons that disappeared", () => {
    const items = resolvePath(["chat-models/first-chat", "gone/x", PARALLEL_REF], tracks);
    expect(items.map((i) => [i.ref, i.title, i.trackTitle])).toEqual([
      ["chat-models/first-chat", "FIRST-CHAT", "Chat"],
      [PARALLEL_REF, "PARALLEL-SUB-AGENTS", "Agents"],
    ]);
  });

  it("finds the next unfinished lesson and the progress", () => {
    const items = resolvePath(buildPath(["chat-models", "projects"], tracks), tracks);
    const done = { status: "completed" } as never;
    const progress = { "chat-models/first-chat": done, [PARALLEL_REF]: done };
    expect(nextInPath(items, progress)?.ref).toBe("chat-models/composer");
    expect(nextInPath(items, progress, "chat-models/composer")?.ref).toBe("projects/basics");
    expect(pathProgress(items, progress)).toEqual({ done: 2, total: 5, minutesLeft: 9 });
  });

  it("lessons of plugins turned on later join at the end", () => {
    expect(mergeRefs(["a/1", "b/1"], ["a/1", "c/1", "b/1", "d/1"])).toEqual(["a/1", "b/1", "c/1", "d/1"]);
  });
});
