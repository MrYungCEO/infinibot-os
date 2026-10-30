import { describe, expect, it, vi } from "vitest";

import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { InfinibotConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { fitTelegramMenu, registerTelegramNativeCommands } from "./bot-native-commands.js";

const skills = Array.from({ length: 150 }, (_, i) => ({
  name: `skill_${i}`,
  skillName: `skill-${i}`,
  description: `Skill ${i}`,
}));

vi.mock("../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: () => skills,
}));
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: () => [],
  matchPluginCommand: vi.fn(),
  executePluginCommand: vi.fn(),
}));
vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => []),
}));

describe("fitTelegramMenu", () => {
  it("stops at Telegram's total-text budget, not just the 100-entry limit", () => {
    // 80 entries × ~100-char descriptions was rejected live (BOT_COMMANDS_TOO_MUCH).
    const long = Array.from({ length: 100 }, (_, i) => ({
      command: `cmd_${i}`,
      description: "x".repeat(95),
    }));
    const menu = fitTelegramMenu(long);
    expect(menu.length).toBeLessThan(70);
    const size = menu.reduce((n, c) => n + c.command.length + c.description.length, 0);
    expect(size).toBeLessThanOrEqual(6000);

    const short = Array.from({ length: 150 }, (_, i) => ({ command: `c${i}`, description: "d" }));
    expect(fitTelegramMenu(short)).toHaveLength(100);
  });
});

describe("registerTelegramNativeCommands (menu cap)", () => {
  it("caps the Telegram menu at 100 with built-ins first, but registers every handler", () => {
    const handlers = new Set<string>();
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const bot = {
      api: { setMyCommands, sendMessage: vi.fn() },
      command: (name: string) => {
        handlers.add(name);
      },
    };

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: {} as InfinibotConfig,
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: [],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }) as ChannelGroupPolicy,
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const menu = setMyCommands.mock.calls[0]?.[0] as Array<{ command: string }>;
    expect(menu).toHaveLength(100);
    const firstSkill = menu.findIndex((entry) => entry.command.startsWith("skill_"));
    expect(menu.slice(0, firstSkill).map((entry) => entry.command)).toContain("claude");
    expect(menu.slice(firstSkill).every((entry) => entry.command.startsWith("skill_"))).toBe(true);
    expect(handlers.has("claude")).toBe(true);
    expect(handlers.has("skill_149")).toBe(true);
  });
});
