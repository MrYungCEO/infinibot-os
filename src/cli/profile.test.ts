import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "infinibot",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "infinibot", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "infinibot", "--dev", "gateway"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "infinibot", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "infinibot", "--profile", "work", "status"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "infinibot", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "infinibot", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "infinibot", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "infinibot", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".infinibot-dev");
    expect(env.INFINIBOT_PROFILE).toBe("dev");
    expect(env.INFINIBOT_STATE_DIR).toBe(expectedStateDir);
    expect(env.INFINIBOT_CONFIG_PATH).toBe(path.join(expectedStateDir, "infinibot.json"));
    expect(env.INFINIBOT_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      INFINIBOT_STATE_DIR: "/custom",
      INFINIBOT_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.INFINIBOT_STATE_DIR).toBe("/custom");
    expect(env.INFINIBOT_GATEWAY_PORT).toBe("19099");
    expect(env.INFINIBOT_CONFIG_PATH).toBe(path.join("/custom", "infinibot.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("infinibot doctor --fix", {})).toBe("infinibot doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("infinibot doctor --fix", { INFINIBOT_PROFILE: "default" })).toBe(
      "infinibot doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("infinibot doctor --fix", { INFINIBOT_PROFILE: "Default" })).toBe(
      "infinibot doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("infinibot doctor --fix", { INFINIBOT_PROFILE: "bad profile" })).toBe(
      "infinibot doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("infinibot --profile work doctor --fix", { INFINIBOT_PROFILE: "work" }),
    ).toBe("infinibot --profile work doctor --fix");
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("infinibot --dev doctor", { INFINIBOT_PROFILE: "dev" })).toBe(
      "infinibot --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("infinibot doctor --fix", { INFINIBOT_PROFILE: "work" })).toBe(
      "infinibot --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("infinibot doctor --fix", { INFINIBOT_PROFILE: "  jbclawd  " })).toBe(
      "infinibot --profile jbclawd doctor --fix",
    );
  });

  it("handles command with no args after infinibot", () => {
    expect(formatCliCommand("infinibot", { INFINIBOT_PROFILE: "test" })).toBe(
      "infinibot --profile test",
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm infinibot doctor", { INFINIBOT_PROFILE: "work" })).toBe(
      "pnpm infinibot --profile work doctor",
    );
  });
});
