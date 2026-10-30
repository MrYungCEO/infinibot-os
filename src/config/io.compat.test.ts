import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfigIO } from "./io.js";

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-config-"));
  try {
    await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeConfig(home: string, dirname: string, port: number) {
  const dir = path.join(home, dirname);
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "infinibot.json");
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port } }, null, 2));
  return configPath;
}

describe("config io canonical paths", () => {
  it("loads ~/.infinibot/infinibot.json", async () => {
    await withTempHome(async (home) => {
      const newConfigPath = await writeConfig(home, ".infinibot", 19001);

      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(newConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(19001);
    });
  });

  it("defaults to ~/.infinibot/infinibot.json when no config exists", async () => {
    await withTempHome(async (home) => {
      const io = createConfigIO({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
      });
      expect(io.configPath).toBe(path.join(home, ".infinibot", "infinibot.json"));
      expect(io.loadConfig()).toEqual({});
    });
  });

  it("honors an explicit INFINIBOT_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      const newConfigPath = await writeConfig(home, ".infinibot", 19002);
      const overrideConfigPath = await writeConfig(home, ".custom", 20002);

      const io = createConfigIO({
        env: { INFINIBOT_CONFIG_PATH: overrideConfigPath } as NodeJS.ProcessEnv,
        homedir: () => home,
      });

      expect(io.configPath).not.toBe(newConfigPath);
      expect(io.configPath).toBe(overrideConfigPath);
      expect(io.loadConfig().gateway?.port).toBe(20002);
    });
  });
});
