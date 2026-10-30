import { describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { listAgentPersonas } from "./agent-personas.js";

describe("listAgentPersonas", () => {
  it("prefers config identity names and keeps the standard roster role line", () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", identity: { name: "Ash", emoji: "🔥" } },
          { id: "cmo", name: "Maya" },
          { id: "custom-bot", name: "Custom" },
        ],
      },
    } as unknown as InfinibotConfig;
    const out = listAgentPersonas(cfg);
    const byId = new Map(out.map((p) => [p.id, p]));
    expect(byId.get("main")).toMatchObject({ name: "Ash", emoji: "🔥", configured: true });
    expect(byId.get("main")?.description).toMatch(/Chief Executive/);
    expect(byId.get("cmo")).toMatchObject({ name: "Maya", configured: true });
    expect(byId.get("custom-bot")).toMatchObject({ name: "Custom", description: undefined });
    expect(out[0]?.id).toBe("main");
  });

  it("falls back to the default agent when nothing is configured", () => {
    const out = listAgentPersonas({} as InfinibotConfig);
    expect(out.some((p) => p.id === "main")).toBe(true);
  });
});
