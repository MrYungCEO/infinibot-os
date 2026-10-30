import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";

import { createConfigIO } from "./io.js";

useBundledPlugins();

describe("config file permissions", () => {
  it("creates the config file with mode 0600", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-config-mode-"));
    const configPath = path.join(root, "state", "infinibot.json");
    try {
      const io = createConfigIO({ configPath });
      await io.writeConfigFile({});

      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
