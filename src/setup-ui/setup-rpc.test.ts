import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERMISSIONS } from "../federation/security.js";
import { ALLOWED_METHODS, dispatchSetupRpc } from "./dispatch.js";

function configPath(): string {
  return path.join(process.env.INFINIBOT_STATE_DIR!, "infinibot.json");
}
function readConfigFile(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath(), "utf8"));
}

async function call(method: string, params: Record<string, unknown> = {}) {
  const res = await dispatchSetupRpc(method, params);
  if (!res.ok) throw new Error(`${method}: ${res.error.message}`);
  return res.data as Record<string, any>;
}

const TOKEN = {
  satelliteId: "sat-1",
  permissions: DEFAULT_PERMISSIONS.full,
  issuedAt: 1,
  expiresAt: 4_000_000_000_000,
  signature: "sig",
};
const INVITE = Buffer.from(
  JSON.stringify({
    v: 1,
    hubUrl: "ws://10.1.2.3:18789/federation",
    hubName: "Studio",
    token: TOKEN,
    expiresAt: 4_000_000_000_000,
  }),
).toString("base64");

describe("setup.* RPCs (standalone setup server)", () => {
  beforeAll(() => {
    // The test sandbox has no bundled plugins (test/setup.ts), so the default
    // memory slot ("memory-core") wouldn't resolve during config validation.
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ plugins: { slots: { memory: "none" } } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are all allowlisted on the standalone server", () => {
    for (const m of [
      "setup.status",
      "setup.provider.save",
      "setup.channel.save",
      "setup.satellite.test",
      "setup.satellite.save",
      "setup.finalize",
    ]) {
      expect(ALLOWED_METHODS.has(m)).toBe(true);
    }
  });

  it("rejects a key the provider refuses and writes nothing", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("setup.provider.save", {
      provider: "ollama-cloud",
      apiKey: "bogus-key-123",
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/rejected this key/);
    // The authenticated chat endpoint, not the public /api/tags listing.
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://ollama.com/api/chat");
    const cfg = fs.existsSync(configPath()) ? readConfigFile() : {};
    expect(cfg.models?.providers?.["ollama-cloud"]).toBeUndefined();
  });

  it("saves a verified key as the primary model and reports it masked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    const res = await call("setup.provider.save", {
      provider: "ollama-cloud",
      apiKey: "good-key-abcdef",
    });
    expect(res).toMatchObject({ ok: true, verified: true, maskedKey: "good…cdef" });
    const cfg = readConfigFile();
    expect(cfg.models.providers["ollama-cloud"]).toMatchObject({
      apiKey: "good-key-abcdef",
      baseUrl: "https://ollama.com/v1",
    });
    expect(cfg.agents.defaults.model.primary).toBe("ollama-cloud/gpt-oss:120b");
    const status = await call("setup.status");
    expect(status.providers.find((p: { id: string }) => p.id === "ollama-cloud")).toMatchObject({
      configured: true,
    });
    expect(JSON.stringify(status)).not.toContain("good-key-abcdef");
  });

  it("checks a Telegram token with the platform before enabling the channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, result: { username: "atlas_bot" } })),
    );
    const res = await call("setup.channel.save", {
      channel: "telegram",
      values: { token: "123:ABC" },
    });
    expect(res).toEqual({ ok: true, account: "atlas_bot" });
    expect(readConfigFile().channels.telegram).toMatchObject({
      enabled: true,
      botToken: "123:ABC",
    });
  });

  it("writes the satellite federation block from an invite, replacing any old token", async () => {
    const res = await call("setup.satellite.save", {
      invite: INVITE,
      nodeName: "Laptop",
      share: { terminals: true, coders: true, agents: false, compute: true },
    });
    expect(res.error ?? null).toBeNull();
    expect(readConfigFile().federation).toEqual({
      enabled: true,
      mode: "satellite",
      masterUrl: "ws://10.1.2.3:18789/federation",
      nodeName: "Laptop",
      share: { terminals: true, coders: true, agents: false, compute: true },
      authToken: TOKEN,
      label: "Studio",
    });
    const status = await call("setup.status");
    expect(status.installMode).toBe("satellite");
    expect(status.satellite).toMatchObject({
      paired: true,
      masterUrl: "ws://10.1.2.3:18789/federation",
    });

    await call("setup.satellite.clear");
    expect(readConfigFile().federation).toEqual({
      enabled: true,
      mode: "standalone",
      nodeName: "Laptop",
    });
  });

  it("explains a bad invite instead of throwing", async () => {
    const res = await call("setup.satellite.test", { invite: "not an invite" });
    expect(res).toMatchObject({ ok: false, code: "BAD_INVITE" });
  });
});
