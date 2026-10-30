import { describe, expect, it } from "vitest";

import {
  clampScopeHops,
  projectGraphRoute,
  readProjectScope,
  scopeCountText,
  scopeInfoOf,
  scopeIsSparse,
  scopeRequestParams,
} from "./knowledge-graph-project-scope";
import { inferBasePathFromPathname, matchRoute, tabFromPath } from "../navigation";

describe("project-scoped knowledge graph links", () => {
  it("round-trips the deep link", () => {
    const route = projectGraphRoute("abc-123", { name: "FlyPic", hops: 3 });
    expect(route.startsWith("/knowledge-graph?")).toBe(true);
    const sc = readProjectScope(route.slice(route.indexOf("?")));
    expect(sc).toEqual({ id: "abc-123", name: "FlyPic", hops: 3 });
    expect(projectGraphRoute("x")).toBe("/knowledge-graph?project=x");
  });

  it("reads ?project= (node-id form too) and clamps hops", () => {
    expect(readProjectScope("?project=project:p1")).toEqual({ id: "p1", name: null, hops: 2 });
    expect(readProjectScope("?project=p1&hops=9")?.hops).toBe(4);
    expect(readProjectScope("?view=graph")).toBeNull();
    expect(clampScopeHops("0")).toBe(0);
    expect(clampScopeHops("nope")).toBe(2);
  });

  it("/knowledge aliases the knowledge graph route", () => {
    expect(tabFromPath("/knowledge")).toBe(tabFromPath("/knowledge-graph"));
    expect(matchRoute("/knowledge")).toEqual(matchRoute("/knowledge-graph"));
    // Not mistaken for a base path (would boot to the dashboard with broken assets).
    expect(inferBasePathFromPathname("/knowledge")).toBe("");
  });

  it("builds RPC params and reads the scope block", () => {
    expect(scopeRequestParams(null)).toEqual({});
    expect(scopeRequestParams({ id: "p1", name: null, hops: 1 })).toEqual({ projectId: "p1", hops: 1 });
    const info = scopeInfoOf({
      nodes: [],
      scope: { projectId: "p1", projectNodeId: "project:p1", label: "P1", found: true, hops: 2, totalNodes: 840, totalEdges: 900, hubs: ["agent:main"], capped: 0, secureExcluded: 1 },
    });
    expect(info?.projectNodeId).toBe("project:p1");
    expect(scopeCountText(info, 12)).toBe("12 of 840 nodes");
    expect(scopeIsSparse(info, 1)).toBe(true);
    expect(scopeIsSparse(info, 12)).toBe(false);
    expect(scopeInfoOf({ nodes: [] })).toBeNull();
  });
});
