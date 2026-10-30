import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Avoid shelling out to tailscale when the runner module loads.
vi.mock("../infra/tailscale.js", () => ({
  getTailnetHostname: vi.fn().mockResolvedValue(null),
}));

import { resolveDefaultProjectDir } from "./expo-runner.js";

describe("resolveDefaultProjectDir (integration)", () => {
  const saved = {
    EXPO_PROJECT_DIR: process.env.EXPO_PROJECT_DIR,
    INFINIBOT_MOBILE_DIR: process.env.INFINIBOT_MOBILE_DIR,
  };

  beforeAll(() => {
    delete process.env.EXPO_PROJECT_DIR;
    delete process.env.INFINIBOT_MOBILE_DIR;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("resolves to the in-repo mobile/ dir with no env override", () => {
    const dir = resolveDefaultProjectDir();
    expect(
      dir.endsWith(join("infinibot", "mobile")) ||
        dir.endsWith(join("InfiniBot-fresh", "mobile")) ||
        dir.endsWith("mobile"),
    ).toBe(true);

    const appJson = join(dir, "app.json");
    expect(existsSync(appJson)).toBe(true);
    const parsed = JSON.parse(readFileSync(appJson, "utf-8")) as Record<string, unknown>;
    expect(parsed).toHaveProperty("expo");
  });
});
