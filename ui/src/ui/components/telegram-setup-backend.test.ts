import { describe, expect, it, vi } from "vitest";
import { gatewayTelegramSetupBackend } from "./telegram-setup-backend";

describe("gatewayTelegramSetupBackend", () => {
  it("maps each action to its telegram.setup.* RPC and passes params through", async () => {
    const request = vi.fn(async () => ({ ok: true, connected: false }));
    const backend = gatewayTelegramSetupBackend({ request } as never);
    await backend.call("summary");
    await backend.call("capture.start", { sessionId: "s1", mode: "dm" });
    expect(request.mock.calls).toEqual([
      ["telegram.setup.summary", {}],
      ["telegram.setup.capture.start", { sessionId: "s1", mode: "dm" }],
    ]);
  });

  it("turns a dropped connection into a plain-English error instead of throwing", async () => {
    const backend = gatewayTelegramSetupBackend({
      request: async () => {
        throw new Error("socket closed");
      },
    } as never);
    const res = await backend.call("verify", { token: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.fix.length).toBeGreaterThan(10);
  });

  it("says to restart when the gateway is older than the wizard", async () => {
    const backend = gatewayTelegramSetupBackend({
      request: async () => {
        throw new Error("unknown method: telegram.setup.summary");
      },
    } as never);
    const res = await backend.call("summary");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.title).toMatch(/restart/i);
  });
});
