import { describe, expect, it } from "vitest";
import "../agents/test-helpers/fast-coding-tools.js";
import { createInfiniBotCodingTools } from "../agents/pi-tools.js";
import type { InfinibotConfig } from "../config/config.js";

const cfg = {
  agents: { list: [{ id: "main", workspace: "/tmp/ib-secure-tools" }] },
} as InfinibotConfig;

function names(sessionKey: string) {
  return createInfiniBotCodingTools({
    config: cfg,
    sessionKey,
    workspaceDir: "/tmp/ib-secure-tools",
    agentDir: "/tmp/ib-secure-tools-agent",
  }).map((t) => t.name);
}

describe("tool assembly in Secure Mode", () => {
  it("a secure session only gets the local-only allowlist (no network tools)", () => {
    const secure = names("agent:main:secure-tools1");
    expect(secure.sort()).toEqual([
      "file_context",
      "read",
      "secure_lane",
      "secure_research",
      "video_analysis",
    ]);
    for (const blocked of [
      "web_fetch",
      "web_search",
      "message",
      "exec",
      "write",
      "mcp",
      "claude_coder",
    ]) {
      expect(secure).not.toContain(blocked);
    }
  });

  it("a normal session keeps its tools and never gets secure_lane", () => {
    const normal = names("agent:main:main");
    expect(normal).toContain("read");
    expect(normal).toContain("exec");
    expect(normal).not.toContain("secure_lane");
    expect(normal).not.toContain("secure_research");
  });

  it("secureMode.research.enabled=false removes secure_research from secure runs", () => {
    const off = createInfiniBotCodingTools({
      config: { ...cfg, secureMode: { research: { enabled: false } } } as InfinibotConfig,
      sessionKey: "agent:main:secure-tools2",
      workspaceDir: "/tmp/ib-secure-tools",
      agentDir: "/tmp/ib-secure-tools-agent",
    }).map((t) => t.name);
    expect(off).not.toContain("secure_research");
    expect(off).toContain("secure_lane");
  });
});
