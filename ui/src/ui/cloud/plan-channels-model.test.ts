import { describe, expect, it } from "vitest";
import {
  channelLockReason,
  channelLockView,
  channelUpgradeCta,
  isChannelLocked,
  isChannelNotInPlanError,
  lockedChannelOf,
  normalizeChannelsExcluded,
} from "./plan-channels-model";

const FREE = ["telegram", "slack"];

describe("plan channel locks (Free: no Telegram, no Slack)", () => {
  it("normalizes the server list; absent / malformed means nothing is locked", () => {
    expect(normalizeChannelsExcluded(undefined)).toEqual([]);
    expect(normalizeChannelsExcluded(null)).toEqual([]);
    expect(normalizeChannelsExcluded("telegram")).toEqual([]);
    expect(normalizeChannelsExcluded([" Telegram ", "slack", "slack", 3, ""])).toEqual(["telegram", "slack"]);
  });
  it("isChannelLocked only for listed channels; [] (paid / self-hosted) locks nothing", () => {
    expect(isChannelLocked("telegram", FREE)).toBe(true);
    expect(isChannelLocked("Slack", FREE)).toBe(true);
    expect(isChannelLocked("discord", FREE)).toBe(false);
    expect(isChannelLocked("whatsapp", FREE)).toBe(false);
    expect(isChannelLocked("telegram", [])).toBe(false);
    expect(isChannelLocked("telegram", undefined)).toBe(false);
    expect(isChannelLocked(null, FREE)).toBe(false);
  });
  it("copy matches the server's 402 / laterReason wording", () => {
    expect(channelLockReason("telegram")).toBe("Telegram isn't included on the Free plan. Upgrade to connect it.");
    expect(channelUpgradeCta("slack")).toBe("Upgrade to connect Slack");
  });
  it("card view: locked when nothing is saved, paused (never deleted) after a downgrade", () => {
    expect(channelLockView("discord", FREE, false)).toBeNull();
    expect(channelLockView("telegram", [], true)).toBeNull();
    expect(channelLockView("telegram", FREE, false)).toMatchObject({ kind: "locked", cta: "Upgrade to connect Telegram" });
    expect(channelLockView("slack", FREE, true)).toMatchObject({ kind: "paused", title: "Paused on Free", cta: "Upgrade to resume" });
  });
  it("recognises the typed 402 from POST /api/channels/:id", () => {
    expect(isChannelNotInPlanError({ ok: false, code: "channel_not_in_plan", channel: "telegram", upgrade: true })).toBe(true);
    expect(isChannelNotInPlanError({ code: "daily_limit_reached" })).toBe(false);
    expect(isChannelNotInPlanError(null)).toBe(false);
  });
  it("plugins: matched by provided channel or by id", () => {
    expect(lockedChannelOf({ id: "telegram", channels: ["telegram"] }, FREE)).toBe("telegram");
    expect(lockedChannelOf({ id: "slack" }, FREE)).toBe("slack");
    expect(lockedChannelOf({ id: "discord", channels: ["discord"] }, FREE)).toBeNull();
    expect(lockedChannelOf({ id: "telegram", channels: ["telegram"] }, [])).toBeNull();
  });
});
