/**
 * Hosted tenant Machine: the RPCs a workspace owner uses to manage their own
 * gateway (model allowlist, config.set / config.patch) write the config; the
 * same calls from a plain member are refused with a clear message.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useBundledPlugins } from "../../../test/helpers/bundled-plugins.js";

import { runWithTenantScope, setCurrentUserId } from "../../config/paths.js";
import { configHandlers } from "./config.js";
import { modelsHandlers } from "./models.js";
import type { GatewayRequestHandlers } from "./types.js";

useBundledPlugins();

let dir: string;
let file: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-fleet-owner-"));
  file = path.join(dir, "infinibot.json");
  process.env.INFINIBOT_STATE_DIR = dir;
  process.env.SAAS_MODE = "1";
  process.env.SAAS_ENV_FILE = path.join(dir, "none.env");
  process.env.FLEET_TENANT_ID = "t-1";
  process.env.INFINIBOT_DISABLE_CONFIG_CACHE = "1";
  fs.writeFileSync(
    file,
    JSON.stringify({ agents: { defaults: { models: { "anthropic/claude-sonnet-5-5": {} } } } }),
  );
});
afterEach(() => {
  process.env = { ...saved };
  setCurrentUserId("default");
  fs.rmSync(dir, { recursive: true, force: true });
});

const catalog = [
  { id: "claude-sonnet-5-5", name: "Sonnet", provider: "anthropic" },
  { id: "claude-opus-5-5", name: "Opus", provider: "anthropic" },
];

type Reply = { ok: boolean; payload?: unknown; error?: { message?: string } };

async function call(
  handlers: GatewayRequestHandlers,
  method: string,
  params: unknown,
  role: string,
): Promise<Reply> {
  return await runWithTenantScope("t_mine", role, async () => {
    let reply: Reply | undefined;
    await handlers[method]({
      params,
      client: null,
      respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => {
        reply = { ok, payload, error };
      },
      context: { loadGatewayModelCatalog: async () => catalog },
    } as never);
    if (!reply) throw new Error(`${method} did not respond`);
    return reply;
  });
}

const stored = () => JSON.parse(fs.readFileSync(file, "utf8"));

describe("owner-managed gateway config on a hosted tenant Machine", () => {
  it("models.allowlist.add / remove: owner and admin succeed", async () => {
    const add = await call(
      modelsHandlers,
      "models.allowlist.add",
      { model: "anthropic/claude-opus-5-5" },
      "owner",
    );
    expect(add.error?.message).toBeUndefined();
    expect(add.ok).toBe(true);
    expect(Object.keys(stored().agents.defaults.models)).toContain("anthropic/claude-opus-5-5");
    const remove = await call(
      modelsHandlers,
      "models.allowlist.remove",
      { model: "anthropic/claude-opus-5-5" },
      "admin",
    );
    expect(remove.ok).toBe(true);
    expect(Object.keys(stored().agents.defaults.models)).not.toContain("anthropic/claude-opus-5-5");
  });

  it("models.allowlist.add: a member is refused and nothing is written", async () => {
    const before = fs.readFileSync(file, "utf8");
    const res = await call(
      modelsHandlers,
      "models.allowlist.add",
      { model: "anthropic/claude-opus-5-5" },
      "member",
    );
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("config.get + config.set / config.patch: owner round-trips, member is refused", async () => {
    const get = await call(configHandlers, "config.get", {}, "owner");
    const hash = (get.payload as { hash: string }).hash;
    const set = await call(
      configHandlers,
      "config.set",
      { raw: JSON.stringify({ ...stored(), messages: { ackReaction: "👀" } }), baseHash: hash },
      "owner",
    );
    expect(set.error?.message).toBeUndefined();
    expect(stored().messages.ackReaction).toBe("👀");

    const memberGet = await call(configHandlers, "config.get", {}, "member");
    const denied = await call(
      configHandlers,
      "config.set",
      { raw: "{}", baseHash: (memberGet.payload as { hash: string }).hash },
      "member",
    ).catch((err: unknown) => ({ ok: false, error: { message: String(err) } }) as Reply);
    expect(denied.ok).toBe(false);
    expect(denied.error?.message).toMatch(/Only the workspace owner or an admin/);
    expect(stored().messages.ackReaction).toBe("👀");
  });
});
