import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GatewayBrowserClient, GatewayEventFrame } from "../ui/src/ui/gateway";
import { OverlayStore, type OverlayRecord } from "../ui/src/ui/controllers/overlay-store";

class FakeGateway {
  handler: ((frame: GatewayEventFrame) => void) | null = null;
  requests: Array<{ method: string; params: unknown }> = [];

  constructor(private snapshot: OverlayRecord[] = []) {}

  subscribe(handler: (frame: GatewayEventFrame) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "ui.overlay.list") return { overlays: this.snapshot };
    return {};
  }

  push(kind: "spawn" | "update" | "close", record?: OverlayRecord, id?: string): void {
    this.handler?.({
      type: "event",
      event: "overlay.events",
      payload: { kind, record, id },
    } as GatewayEventFrame);
  }
}

function record(overrides: Partial<OverlayRecord> = {}): OverlayRecord {
  return {
    overlayId: "overlay-1",
    type: "task",
    payload: {},
    position: { x: 20, y: 20, w: 320, h: 240 },
    createdAt: Date.now(),
    ttlMs: null,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OverlayStore lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("expires hydrated overlays when their TTL elapses", async () => {
    const gateway = new FakeGateway([record({ ttlMs: 100 })]);
    const store = new OverlayStore();

    store.connect(gateway as unknown as GatewayBrowserClient);
    await settle();
    expect(store.list()).toHaveLength(1);

    vi.advanceTimersByTime(101);
    expect(store.list()).toHaveLength(0);
    store.dispose();
  });

  it("does not resurrect a locally dismissed overlay from stale updates", async () => {
    const gateway = new FakeGateway([record()]);
    const store = new OverlayStore();

    store.connect(gateway as unknown as GatewayBrowserClient);
    await settle();
    store.close("overlay-1");
    gateway.push("update", record({ payload: { stale: true } }));

    expect(store.list()).toHaveLength(0);
    expect(gateway.requests.some((entry) => entry.method === "ui.overlay.close")).toBe(true);
    store.dispose();
  });

  it("supports clearing every visible overlay", async () => {
    const gateway = new FakeGateway([
      record(),
      record({ overlayId: "overlay-2", createdAt: Date.now() + 1 }),
    ]);
    const store = new OverlayStore();

    store.connect(gateway as unknown as GatewayBrowserClient);
    await settle();
    store.clearAll();

    expect(store.list()).toHaveLength(0);
    expect(gateway.requests.filter((entry) => entry.method === "ui.overlay.close")).toHaveLength(2);
    store.dispose();
  });
});
