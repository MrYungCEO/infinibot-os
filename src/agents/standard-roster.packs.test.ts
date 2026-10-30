import { describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import {
  NON_CORE_ROSTER_IDS,
  ROSTER_PACKS,
  ROSTER_VERSION,
  STANDARD_AGENT_ROSTER,
  seedStandardAgents,
} from "./standard-roster.js";

type Entry = Record<string, unknown> & { id: string };

function ids(cfg: InfinibotConfig): string[] {
  const list = ((cfg as Record<string, unknown>).agents as { list?: Entry[] })?.list ?? [];
  return list.map((entry) => entry.id);
}

describe("standard roster packs", () => {
  it("every roster agent belongs to exactly one pack", () => {
    const packed = Object.values(ROSTER_PACKS).flat();
    expect(new Set(packed).size).toBe(packed.length);
    expect(new Set(packed)).toEqual(new Set(STANDARD_AGENT_ROSTER.map((a) => a.id)));
  });

  it("fresh install seeds only the core pack", () => {
    const cfg = seedStandardAgents({} as InfinibotConfig);
    expect(ids(cfg).sort()).toEqual([...ROSTER_PACKS.core].sort());
    // Stable across boots.
    expect(ids(seedStandardAgents(cfg)).sort()).toEqual([...ROSTER_PACKS.core].sort());
  });

  it("agents.rosterPacks opts packs in", () => {
    const cfg = seedStandardAgents({
      agents: { rosterPacks: ["dev", "ops"] },
    } as unknown as InfinibotConfig);
    expect(new Set(ids(cfg))).toEqual(
      new Set([...ROSTER_PACKS.core, ...ROSTER_PACKS.dev, ...ROSTER_PACKS.ops]),
    );
    const all = seedStandardAgents({
      agents: { rosterPacks: ["all"] },
    } as unknown as InfinibotConfig);
    expect(ids(all)).toHaveLength(STANDARD_AGENT_ROSTER.length);
  });

  it("existing install with pack agents keeps the full roster and loses nothing", () => {
    const custom: Entry = { id: "my-agent", name: "Mine", systemPrompt: "custom" };
    const operatorEditedCmo: Entry = { id: "cmo", name: "My CMO", systemPrompt: "my own prompt" };
    const seededLedger: Entry = {
      id: "ledger",
      name: "LEDGER",
      systemPrompt: "x",
      _seedVersion: ROSTER_VERSION,
      disabled: true,
    };
    const cfg = {
      agents: {
        list: [
          custom,
          operatorEditedCmo,
          seededLedger,
          { id: "main", name: "Main", systemPrompt: "m", _seedVersion: ROSTER_VERSION },
          // A seeded non-core roster agent marks the install as pre-packs.
          { id: "overseer", name: "OVERSEER", systemPrompt: "o", _seedVersion: ROSTER_VERSION },
        ],
      },
    } as unknown as InfinibotConfig;
    const before = JSON.parse(JSON.stringify(cfg));
    const out = seedStandardAgents(cfg);
    const list = ((out as Record<string, unknown>).agents as { list: Entry[] }).list;

    // Full roster present, plus the custom agent, the operator's CMO and the
    // seeded LEDGER (content and business agents now ship with their plugins
    // — content-studio, business-agency — and core never removes them).
    expect(new Set(list.map((e) => e.id))).toEqual(
      new Set([...STANDARD_AGENT_ROSTER.map((a) => a.id), "my-agent", "cmo", "ledger"]),
    );
    // Operator-owned entries untouched.
    expect(list.find((e) => e.id === "my-agent")).toEqual(before.agents.list[0]);
    expect(list.find((e) => e.id === "cmo")).toEqual(before.agents.list[1]);
    expect(list.find((e) => e.id === "ledger")).toEqual(before.agents.list[2]);
  });

  it("never removes agents from disabled packs", () => {
    const cfg = {
      agents: {
        rosterPacks: [],
        list: [
          { id: "overseer", name: "OVERSEER", systemPrompt: "s", _seedVersion: ROSTER_VERSION },
        ],
      },
    } as unknown as InfinibotConfig;
    expect(ids(seedStandardAgents(cfg))).toContain("overseer");
    expect(NON_CORE_ROSTER_IDS.has("overseer")).toBe(true);
  });
});
