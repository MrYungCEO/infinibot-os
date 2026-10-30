import { describe, expect, it } from "vitest";

import {
  parseWorkspaceDevPath,
  rewritePreviewText,
  workspaceUpstreamPath,
} from "./preview-proxy.js";

describe("workspace preview proxy", () => {
  it("strips the authenticated project prefix without losing routes or queries", () => {
    expect(parseWorkspaceDevPath("/api/workspace/dev/proj%201/docs?q=1")).toEqual({
      directoryId: "proj 1",
      upstreamPath: "/docs?q=1",
      prefix: "/api/workspace/dev/proj%201/",
    });
  });

  it("preserves the configured base upstream only for base-aware frameworks", () => {
    const parsed = parseWorkspaceDevPath("/api/workspace/dev/project/src/main.jsx?x=1");
    expect(parsed).not.toBeNull();
    expect(workspaceUpstreamPath(parsed!, "vite")).toBe(
      "/api/workspace/dev/project/src/main.jsx?x=1",
    );
    expect(workspaceUpstreamPath(parsed!, "astro")).toBe(
      "/api/workspace/dev/project/src/main.jsx?x=1",
    );
    expect(workspaceUpstreamPath(parsed!, "next")).toBe("/src/main.jsx?x=1");
    expect(workspaceUpstreamPath(parsed!, "static")).toBe("/src/main.jsx?x=1");
  });

  it("rewrites root-relative framework assets and injects the visual inspector", () => {
    const html = rewritePreviewText(
      '<html><head></head><body><script src="/@vite/client"></script><a href="/about">About</a></body></html>',
      "demo",
      "text/html",
    );
    expect(html).toContain('src="/api/workspace/dev/demo/@vite/client"');
    expect(html).toContain('href="/api/workspace/dev/demo/about"');
    expect(html).toContain("data-infinibot-inspector");
    expect(html).toContain(".__ib_hover,.__ib_selected");
    expect(html).toContain("#__ib_label");
    expect(html).toContain("mouseover");
    expect(html).toContain("function inspectTarget");
    expect(html).toContain("section,article,header,nav,footer");
    expect(html).toContain("const below=r.bottom+7");
    expect(html).toContain('<base href="/api/workspace/dev/demo/">');
    expect(html).toContain("snapshot timeout");
    const script = html.match(/<script data-infinibot-inspector>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("rewrites Next and Vite runtime strings in JavaScript", () => {
    const js = rewritePreviewText(
      'const a="/_next/static/a.js"; const b="/@vite/client";',
      "x",
      "text/javascript",
    );
    expect(js).toContain('"/api/workspace/dev/x/_next/static/a.js"');
    expect(js).toContain('"/api/workspace/dev/x/@vite/client"');
  });
});
