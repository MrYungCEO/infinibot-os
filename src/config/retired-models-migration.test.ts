import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";

import type { InfinibotConfig } from "./config.js";
import {
  migrateRetiredModelRefs,
  persistRetiredModelMigration,
} from "./retired-models-migration.js";

useBundledPlugins();

describe("migrateRetiredModelRefs", () => {
  it("rewrites the retired ollama-cloud/kimi-k2.5 primary and preserves everything else", () => {
    const cfg = {
      gateway: { port: 18789, auth: { token: "${GATEWAY_TOKEN}" } },
      channels: { telegram: { enabled: true } },
      agents: {
        defaults: {
          model: {
            primary: "ollama-cloud/kimi-k2.5",
            fallbacks: ["openrouter/anthropic/claude-sonnet-4-5"],
            ollamaSafetyNet: true,
          },
          workspace: "/data/workspace",
        },
      },
    } as unknown as InfinibotConfig;
    const snapshot = JSON.stringify(cfg);

    const { config, changes } = migrateRetiredModelRefs(cfg);

    expect(changes).toEqual([
      "agents.defaults.model.primary: ollama-cloud/kimi-k2.5 → ollama-cloud/gpt-oss:120b (retired upstream)",
    ]);
    expect(config.agents?.defaults?.model).toEqual({
      primary: "ollama-cloud/gpt-oss:120b",
      fallbacks: ["openrouter/anthropic/claude-sonnet-4-5"],
      ollamaSafetyNet: true,
    });
    // Untouched sections are carried over verbatim (incl. ${ENV} refs).
    expect((config as Record<string, unknown>).gateway).toEqual(cfg.gateway);
    expect((config as Record<string, unknown>).channels).toEqual(
      (cfg as Record<string, unknown>).channels,
    );
    expect(config.agents?.defaults?.workspace).toBe("/data/workspace");
    // Input not mutated.
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it("handles string model refs, fallbacks, the models allowlist and per-agent models", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openrouter/x",
            fallbacks: ["ollama-cloud/kimi-k2.5", "ollama-cloud/gpt-oss:120b", "openrouter/y"],
          },
          models: {
            "ollama-cloud/kimi-k2.5": { alias: "kimi" },
            "openrouter/x": {},
          },
        },
        list: [
          { id: "main", model: "ollama-cloud/kimi-k2.5" },
          { id: "cmo", model: { primary: "openrouter/x" } },
        ],
      },
    } as unknown as InfinibotConfig;

    const { config, changes } = migrateRetiredModelRefs(cfg);

    expect(config.agents?.defaults?.model).toEqual({
      primary: "openrouter/x",
      // Replacement de-duplicated against the entry that already existed.
      fallbacks: ["ollama-cloud/gpt-oss:120b", "openrouter/y"],
    });
    expect(config.agents?.defaults?.models).toEqual({
      "ollama-cloud/gpt-oss:120b": { alias: "kimi" },
      "openrouter/x": {},
    });
    expect(config.agents?.list?.[0]).toEqual({ id: "main", model: "ollama-cloud/gpt-oss:120b" });
    expect(config.agents?.list?.[1]).toBe(cfg.agents?.list?.[1]);
    expect(changes.length).toBe(3);
  });

  it("is a no-op (same object) when nothing is retired", () => {
    const cfg = {
      agents: { defaults: { model: { primary: "ollama-cloud/gpt-oss:120b" } } },
    } as unknown as InfinibotConfig;
    const res = migrateRetiredModelRefs(cfg);
    expect(res.changes).toEqual([]);
    expect(res.config).toBe(cfg);
  });
});

describe("persistRetiredModelMigration (boot, real file)", () => {
  it("rewrites the file, keeps a .bak, preserves ${ENV} refs and 0600", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-retired-"));
    const file = path.join(dir, "infinibot.json");
    const original = {
      gateway: { mode: "local", auth: { mode: "token", token: "${IB_RETIRED_TEST_TOKEN}" } },
      agents: { defaults: { model: { primary: "ollama-cloud/kimi-k2.5" } } },
    };
    await fs.writeFile(file, JSON.stringify(original, null, 2), { mode: 0o600 });
    vi.stubEnv("INFINIBOT_CONFIG_PATH", file);
    vi.stubEnv("IB_RETIRED_TEST_TOKEN", "super-secret-token");
    try {
      const changes = await persistRetiredModelMigration();
      expect(changes).toHaveLength(1);

      const written = JSON.parse(await fs.readFile(file, "utf8"));
      expect(written.agents.defaults.model.primary).toBe("ollama-cloud/gpt-oss:120b");
      // Secret stays an env reference — never inlined by the migration.
      expect(written.gateway.auth.token).toBe("${IB_RETIRED_TEST_TOKEN}");
      expect(JSON.stringify(written)).not.toContain("super-secret-token");

      const backup = JSON.parse(await fs.readFile(`${file}.bak`, "utf8"));
      expect(backup.agents.defaults.model.primary).toBe("ollama-cloud/kimi-k2.5");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

      // Second boot: nothing left to migrate.
      expect(await persistRetiredModelMigration()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
