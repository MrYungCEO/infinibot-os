import { afterEach, describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { _setBrowserPairedForTests, resolveEffectiveToolPolicy } from "./pi-tools.policy.js";

const cfg = (mainTools: Record<string, unknown>, globalTools: Record<string, unknown> = {}) =>
  ({
    tools: globalTools,
    agents: {
      list: [
        { id: "main", default: true, tools: mainTools },
        { id: "helper", tools: { allow: ["kanban"] } },
      ],
    },
  }) as unknown as InfinibotConfig;

afterEach(() => _setBrowserPairedForTests(undefined));

describe("paired Chrome enables the browser tool for the main agent", () => {
  it("adds browser to a restrictive main allowlist once paired", () => {
    _setBrowserPairedForTests(true);
    const p = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"] }),
      sessionKey: "agent:main:main",
    });
    expect(p.agentPolicy?.allow).toEqual(["kanban", "browser"]);
  });

  it("does nothing before pairing", () => {
    _setBrowserPairedForTests(false);
    const p = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"] }),
      sessionKey: "agent:main:main",
    });
    expect(p.agentPolicy?.allow).toEqual(["kanban"]);
  });

  it("respects an explicit deny (agent or global)", () => {
    _setBrowserPairedForTests(true);
    const a = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"], deny: ["browser"] }),
      sessionKey: "agent:main:main",
    });
    expect(a.agentPolicy?.allow).toEqual(["kanban"]);
    const g = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"] }, { deny: ["group:ui"] }),
      sessionKey: "agent:main:main",
    });
    expect(g.agentPolicy?.allow).toEqual(["kanban"]);
  });

  it("leaves other agents alone", () => {
    _setBrowserPairedForTests(true);
    const p = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"] }),
      sessionKey: "agent:helper:main",
    });
    expect(p.agentPolicy?.allow).toEqual(["kanban"]);
  });

  it("applies to MCP sessions of the main agent too", () => {
    _setBrowserPairedForTests(true);
    const p = resolveEffectiveToolPolicy({
      config: cfg({ allow: ["kanban"] }),
      sessionKey: "agent:main:mcp-host-123-abc",
    });
    expect(p.agentPolicy?.allow).toContain("browser");
  });
});
