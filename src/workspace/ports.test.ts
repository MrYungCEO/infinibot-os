import net from "node:net";
import { describe, expect, it } from "vitest";

import { detectPortConflict, findFreePort, isPortFree } from "./ports.js";

function listen(port: number, host: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, host, () => resolve(server));
  });
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("workspace port probing", () => {
  it("treats a port held on 0.0.0.0 as busy and walks upward", async () => {
    const holder = (await listen(0, "0.0.0.0"))!;
    const occupied = (holder.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(occupied)).toBe(false);
      const port = await findFreePort(occupied);
      expect(port).toBeGreaterThan(occupied);
      expect(await isPortFree(port)).toBe(true);
    } finally {
      await close(holder);
    }
  });

  it("treats a port held only on a specific interface address as busy (tailscale serve case)", async () => {
    const holder = await listen(0, "127.0.0.2");
    if (!holder) return; // 127.0.0.2 is not routable on this platform (macOS)
    const occupied = (holder.address() as net.AddressInfo).port;
    try {
      // A loopback-only probe (the old behaviour) sees it as free...
      expect(await isPortFree(occupied, ["127.0.0.1"])).toBe(true);
      // ...but the wildcard probe catches it.
      expect(await isPortFree(occupied)).toBe(false);
      expect(await findFreePort(occupied)).not.toBe(occupied);
    } finally {
      await close(holder);
    }
  });

  it("skips excluded ports and is bounded", async () => {
    const free = async () => true;
    expect(await findFreePort(5000, { exclude: [5000, 5001], isFree: free })).toBe(5002);
    await expect(findFreePort(5000, { maxTries: 3, isFree: async () => false })).rejects.toThrow(
      /No free port/,
    );
  });

  it("recognises dev-server port conflict messages", () => {
    expect(detectPortConflict("› Port 8081 is being used by another process")).toBe(8081);
    expect(detectPortConflict("Port 5173 is in use, trying another one...")).toBe(5173);
    expect(detectPortConflict("Error: listen EADDRINUSE: address already in use :::3000")).toBe(
      3000,
    );
    expect(detectPortConflict("Something is already running on port 3000.")).toBe(3000);
    expect(detectPortConflict("address already in use")).toBe(0);
    expect(detectPortConflict("Waiting on http://localhost:8081")).toBeNull();
  });
});
