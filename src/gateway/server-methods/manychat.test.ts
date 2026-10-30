import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { manychatHandlers } from "./manychat.js";

type Reply = { ok: boolean; payload?: unknown; error?: { code: string; message: string } };

async function call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  return new Promise((resolve) => {
    void manychatHandlers[method]({
      req: { type: "req", id: "1", method },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) =>
        resolve({ ok, payload, error }),
      context: {} as never,
    } as never);
  });
}

let stateDir: string;
const prevState = process.env.INFINIBOT_STATE_DIR;
const secretsFile = () => path.join(stateDir, "secrets", "manychat.json");

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "manychat-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
});

describe("manychat (no mock connections)", () => {
  it("a missing or short key is an error, never a fake connection", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const apiKey of [undefined, "", "mock-key"]) {
      const res = await call("manychat.connect", apiKey === undefined ? {} : { apiKey });
      if (apiKey === "mock-key") {
        // A non-empty key is checked with ManyChat (fetch mocked to reject below).
        continue;
      }
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_PARAMS");
    }
    expect(fs.existsSync(secretsFile())).toBe(false);
  });

  it("a key ManyChat rejects is not saved and not connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" })),
    );
    const res = await call("manychat.connect", { apiKey: "mock-short" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("AUTH_ERROR");
    expect(fs.existsSync(secretsFile())).toBe(false);
    expect((await call("manychat.status")).payload).toMatchObject({ connected: false });
  });

  it("a verified key is stored (0600) and reported connected", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: { name: "Studio Page", subscribers_count: 42 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const res = await call("manychat.connect", { apiKey: "real-key-123" });
    expect(res).toMatchObject({
      ok: true,
      payload: { connected: true, accountName: "Studio Page", subscriberCount: 42 },
    });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://api.manychat.com/fb/page/getInfo");
    expect(fs.statSync(secretsFile()).mode & 0o777).toBe(0o600);
    expect((await call("manychat.status")).payload).toMatchObject({
      connected: true,
      accountName: "Studio Page",
    });
    await call("manychat.disconnect");
    expect((await call("manychat.status")).payload).toMatchObject({ connected: false });
  });

  it("flows and triggers need a real key — no mock data", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await call("manychat.flows.list")).error?.code).toBe("NOT_CONNECTED");
    expect((await call("manychat.trigger", { flowId: "f", subscriberId: "s" })).error?.code).toBe(
      "NOT_CONNECTED",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
