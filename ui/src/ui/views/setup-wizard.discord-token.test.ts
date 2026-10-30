import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "../../../../src/config/zod-schema.providers-core.js";
import { buildChannelPatch, createInitialWizardState } from "./setup-wizard";

describe("setup wizard — Discord token key", () => {
  it("writes channels.discord.token (the key token.ts reads), never botToken", () => {
    const s = { ...createInitialWizardState(), channel: "discord" as const, discordBotToken: "  abc.def.ghi  " };
    const patch = buildChannelPatch(s) as { channels: { discord: Record<string, unknown> } };
    expect(patch.channels.discord).toEqual({ token: "abc.def.ghi" });
    expect(patch.channels.discord).not.toHaveProperty("botToken");
    // The strict schema accepts it (botToken was rejected, so the step never saved).
    expect(DiscordConfigSchema.safeParse(patch.channels.discord).success).toBe(true);
    expect(DiscordConfigSchema.safeParse({ botToken: "abc.def.ghi" }).success).toBe(false);
  });

  it("skips Discord when no token was typed", () => {
    const s = { ...createInitialWizardState(), channel: "discord" as const, discordBotToken: "   " };
    expect(buildChannelPatch(s)).toEqual({ channels: {} });
  });
});
