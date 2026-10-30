/**
 * Config writes on a hosted fleet tenant Machine: the file is the tenant's own
 * gateway config, so boot/ambient writes and the plugins.* handlers may write
 * it, and so may the workspace owner/admins through the generic path
 * (config.set, models.allowlist.*, …); a plain member still may not.
 * On the operator's shared SaaS gateway nothing changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useBundledPlugins } from "../../test/helpers/bundled-plugins.js";

import { readTenantConfig, updateTenantConfig } from "../saas/tenant-config.js";
import {
  clearConfigCacheForTest,
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "./io.js";
import { runWithTenantScope, runWithUserId, setCurrentUserId } from "./paths.js";

useBundledPlugins();

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-io-fleet-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  process.env.SAAS_MODE = "1";
  process.env.SAAS_ENV_FILE = path.join(dir, "none.env");
});
afterEach(() => {
  process.env = { ...saved };
  setCurrentUserId("default");
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = { plugins: { entries: { whiteboard: { enabled: true } } } } as never;

describe("writeConfigFile in SaaS", () => {
  it("shared SaaS gateway: a tenant request can never write the operator config", async () => {
    await expect(runWithUserId("t_member", () => writeConfigFile(cfg))).rejects.toThrow(
      /managed by the workspace operator/,
    );
    await expect(
      runWithUserId("t_member", () => writeConfigFile(cfg, { fleetMachine: true })),
    ).rejects.toThrow(/managed by the workspace operator/);
  });

  it("shared SaaS gateway: even an owner-role tenant request is refused", async () => {
    await expect(
      runWithTenantScope("t_member", "owner", () => writeConfigFile(cfg)),
    ).rejects.toThrow(/managed by the workspace operator/);
  });

  it("fleet Machine: role-less scoped work needs the explicit opt-in; boot writes allowed", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    await expect(runWithUserId("t_mine", () => writeConfigFile(cfg))).rejects.toThrow(
      /Only the workspace owner or an admin/,
    );
    await runWithUserId("t_mine", () => writeConfigFile(cfg, { fleetMachine: true }));
    expect(fs.readFileSync(path.join(dir, "infinibot.json"), "utf8")).toContain("whiteboard");
    // Boot after the namespace pin: global user = tenant, no request scope.
    setCurrentUserId("t_mine");
    await writeConfigFile(cfg);
  });

  it("fleet Machine: owner and admin write through the generic path, members never do", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    for (const role of ["owner", "admin", "Owner"]) {
      await runWithTenantScope("t_mine", role, () => writeConfigFile(cfg));
    }
    await expect(
      runWithTenantScope("t_mine", "member", () => writeConfigFile(cfg)),
    ).rejects.toThrow(/Only the workspace owner or an admin/);
    // The plugins.* opt-in does not lift a member either.
    await expect(
      runWithTenantScope("t_mine", "member", () => writeConfigFile(cfg, { fleetMachine: true })),
    ).rejects.toThrow(/Only the workspace owner or an admin/);
  });

  it("fleet Machine: the owner reads the raw file, a member the redacted view", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    const file = path.join(dir, "infinibot.json");
    fs.writeFileSync(file, JSON.stringify({ channels: { telegram: { botToken: "123:abc" } } }));
    const owner = await runWithTenantScope("t_mine", "owner", () => readConfigFileSnapshot());
    expect(owner.path).toBe(file);
    expect(owner.raw).toContain("123:abc");
    const member = await runWithTenantScope("t_mine", "member", () => readConfigFileSnapshot());
    expect(member.path).toBe("tenant://workspace");
    expect(member.raw).not.toContain("123:abc");
  });

  it("fleet Machine: the redacted view and the tenant overlay are never persisted", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    const file = path.join(dir, "infinibot.json");
    const stored = {
      models: {
        providers: { acme: { baseUrl: "https://x.test/v1", apiKey: "sk-real", models: [] } },
      },
      agents: { defaults: { models: { "anthropic/claude-sonnet-5-5": {} } } },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    await expect(
      runWithTenantScope("t_mine", "owner", () =>
        writeConfigFile({
          models: {
            providers: {
              acme: { baseUrl: "https://x.test/v1", apiKey: "__REDACTED__", models: [] },
            },
          },
        } as never),
      ),
    ).rejects.toThrow(/redacted placeholder/);
    // A handler that starts from loadConfig() (overlay applied: API key
    // stripped, tenant workspace path) and changes something unrelated.
    await runWithTenantScope("t_mine", "owner", async () => {
      const view = loadConfig() as Record<string, unknown>;
      expect(JSON.stringify(view)).not.toContain("sk-real");
      clearConfigCacheForTest();
      await writeConfigFile({ ...view, messages: { ackReaction: "👀" } } as never);
    });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.models.providers.acme.apiKey).toBe("sk-real");
    expect(after.agents.defaults.workspace).toBeUndefined();
    expect(after.messages.ackReaction).toBe("👀");
  });

  it("fleet Machine: platform-managed env and listener settings are not the tenant's", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    const file = path.join(dir, "infinibot.json");
    fs.writeFileSync(file, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
    await runWithTenantScope("t_mine", "owner", () =>
      writeConfigFile({
        env: { FLEET_HOSTED_CRON: "1", MY_API: "ok", vars: { CLERK_SECRET_KEY: "x", OTHER: "y" } },
        gateway: { port: 1, auth: { mode: "password" }, controlUi: { enabled: true } },
      } as never),
    );
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.env).toEqual({ MY_API: "ok", vars: { OTHER: "y" } });
    expect(after.gateway.port).toBeUndefined();
    expect(after.gateway.auth).toEqual({ mode: "token" });
    expect(after.gateway.controlUi).toEqual({ enabled: true });
    // A hand-edited file cannot switch a plan-gated subsystem on at load either.
    fs.writeFileSync(file, JSON.stringify({ env: { FLEET_HOSTED_BROWSER: "1", MY_API: "ok" } }));
    delete process.env.FLEET_HOSTED_BROWSER;
    delete process.env.MY_API;
    clearConfigCacheForTest();
    loadConfig();
    expect(process.env.FLEET_HOSTED_BROWSER).toBeUndefined();
    expect(process.env.MY_API).toBe("ok");
  });

  it("fleet Machine: an owner's default-model edit reaches the tenant overlay", async () => {
    process.env.FLEET_TENANT_ID = "t-1";
    await runWithTenantScope("t_mine", "owner", async () => {
      updateTenantConfig((t) => {
        t.model = { primary: "anthropic/claude-haiku-4-5" };
      });
      await writeConfigFile({
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-5-5" } } },
      } as never);
      expect(readTenantConfig().model?.primary).toBe("anthropic/claude-sonnet-5-5");
      clearConfigCacheForTest();
      const model = loadConfig().agents?.defaults?.model as { primary?: string };
      expect(model.primary).toBe("anthropic/claude-sonnet-5-5");
    });
  });
});
