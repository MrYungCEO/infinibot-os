import { describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { FLYPIC_TOOLS, ROSTER_VERSION, seedStandardAgents } from "./standard-roster.js";

type Entry = { id: string; tools?: { allow?: string[] }; _seedTools?: string[] };

const mainOf = (cfg: InfinibotConfig) =>
  ((cfg as { agents: { list: Entry[] } }).agents.list.find((a) => a.id === "main") ??
    null) as Entry | null;

/** A current-version seed entry for `main` whose allow list predates new defaults. */
function oldMain(allow: string[], seedTools?: string[]): InfinibotConfig {
  return {
    agents: {
      list: [
        {
          id: "main",
          name: "Main",
          systemPrompt: "seeded",
          tools: { allow },
          _seedVersion: ROSTER_VERSION,
          ...(seedTools ? { _seedTools: seedTools } : {}),
        },
      ],
    },
  } as unknown as InfinibotConfig;
}

describe("seedStandardAgents additive tool upgrade", () => {
  it("adds roster defaults an existing seed entry is missing (e.g. infinibot_help)", () => {
    const main = mainOf(seedStandardAgents(oldMain(["kanban", "notes"])))!;
    expect(main.tools?.allow).toEqual(
      expect.arrayContaining(["kanban", "notes", "infinibot_help", "infinibot_state"]),
    );
    expect(main._seedTools).toContain("infinibot_help");
  });

  it("keeps tools the operator added by hand", () => {
    const main = mainOf(seedStandardAgents(oldMain(["kanban", "solana_market", "show_panel"])))!;
    expect(main.tools?.allow).toEqual(expect.arrayContaining(["solana_market", "show_panel"]));
  });

  it("does not re-add a default the operator removed after it was offered", () => {
    const first = mainOf(seedStandardAgents(oldMain(["kanban"])))!;
    const offered = first._seedTools!;
    const withoutHelp = (first.tools?.allow ?? []).filter((t) => t !== "infinibot_help");
    const again = mainOf(seedStandardAgents(oldMain(withoutHelp, offered)))!;
    expect(again.tools?.allow).not.toContain("infinibot_help");
  });

  it("is a no-op once the entry has seen the current defaults", () => {
    const first = seedStandardAgents(oldMain(["kanban"]));
    const main = mainOf(first)!;
    const cfg = oldMain([...(main.tools?.allow ?? [])], main._seedTools);
    const before = JSON.stringify(mainOf(cfg));
    // Other missing roster agents may still be inserted; `main` itself must not change.
    expect(JSON.stringify(mainOf(seedStandardAgents(cfg)))).toBe(before);
  });

  it("main carries the phone-rack tools (core android_ops + Droid Swarm's droid_swarm)", () => {
    const main = mainOf(seedStandardAgents(oldMain(["kanban"])))!;
    expect(main.tools?.allow).toEqual(expect.arrayContaining(["android_ops", "droid_swarm"]));
  });

  it("main carries direct-action tools needed by owner voice delegations", () => {
    const direct = ["message", "telegram_send", "kanban", "notes", "report"];
    const fresh = mainOf(seedStandardAgents({} as InfinibotConfig))!;
    expect(fresh.tools?.allow).toEqual(expect.arrayContaining(direct));
    const upgraded = mainOf(seedStandardAgents(oldMain(["kanban"])))!;
    expect(upgraded.tools?.allow).toEqual(expect.arrayContaining(direct));
    expect(upgraded._seedTools).toEqual(expect.arrayContaining(direct));
  });

  it("main carries every FlyPic plugin tool, added to existing installs on boot", () => {
    const fresh = mainOf(seedStandardAgents({} as InfinibotConfig))!;
    expect(fresh.tools?.allow).toEqual(expect.arrayContaining([...FLYPIC_TOOLS]));
    const upgraded = mainOf(seedStandardAgents(oldMain(["kanban", "show_panel"])))!;
    expect(upgraded.tools?.allow).toEqual(expect.arrayContaining([...FLYPIC_TOOLS, "show_panel"]));
    expect(upgraded._seedTools).toEqual(expect.arrayContaining([...FLYPIC_TOOLS]));
  });

  it("main and Architect carry Whiteboard UI + plugin access", () => {
    const seeded = seedStandardAgents({
      agents: { rosterPacks: ["dev"] },
    } as unknown as InfinibotConfig) as unknown as {
      agents: { list: Entry[] };
    };
    const main = seeded.agents.list.find((agent) => agent.id === "main")!;
    const architect = seeded.agents.list.find((agent) => agent.id === "webdev")!;
    for (const agent of [main, architect]) {
      expect(agent.tools?.allow).toEqual(expect.arrayContaining(["ui_control", "whiteboard"]));
      expect(agent._seedTools).toEqual(expect.arrayContaining(["ui_control", "whiteboard"]));
    }
  });
});
