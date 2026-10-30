import { beforeEach, describe, expect, it } from "vitest";

/**
 * A socket that is OPEN but has not finished the connect handshake must not
 * carry any other request: the gateway answers "first request must be connect"
 * and closes it (1008). On a hosted gateway the handshake takes seconds, so a
 * poller firing in that window used to kill every reconnect.
 */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<{ id: string; method: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  reply(id: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: "res", id, ok: true, payload }) });
  }
}

const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
// sendConnect reads navigator.platform/userAgent/language; Node has no navigator.
g.navigator ??= { platform: "test", userAgent: "vitest", language: "en" };
g.WebSocket = FakeSocket;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.document ??= { hidden: false, addEventListener() {}, removeEventListener() {} };

const { GatewayBrowserClient } = await import("./gateway");

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  FakeSocket.instances.length = 0;
});

describe("GatewayBrowserClient: nothing is sent before hello", () => {
  it("rejects a request on an open socket whose handshake is still running, then lets it through after hello", async () => {
    let hello = 0;
    const client = new GatewayBrowserClient({ url: "ws://gw.test/ws", token: "t", onHello: () => void hello++ });
    client.start();
    const ws = FakeSocket.instances[0];
    ws.open();

    // Open, handshake not done: a poller's request must fail locally, not reach the gateway.
    await expect(client.request("approvals.list", {})).rejects.toThrow("gateway not connected");
    expect(ws.sent.filter((f) => f.method !== "connect")).toEqual([]);

    await until(() => ws.sent.some((f) => f.method === "connect"));
    expect(ws.sent.map((f) => f.method)).toEqual(["connect"]);
    await expect(client.request("setup.status", {})).rejects.toThrow("gateway not connected");

    ws.reply(ws.sent[0].id, { features: { methods: ["setup.status"] } });
    await until(() => hello === 1);
    const pending = client.request<{ ok: boolean }>("setup.status", {});
    await until(() => ws.sent.length === 2);
    expect(ws.sent[1].method).toBe("setup.status");
    ws.reply(ws.sent[1].id, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    client.stop();
  });

  it("a reconnect starts a new handshake: requests wait for the next hello", async () => {
    let hello = 0;
    const client = new GatewayBrowserClient({ url: "ws://gw.test/ws", token: "t", onHello: () => void hello++ });
    client.start();
    const first = FakeSocket.instances[0];
    first.open();
    await until(() => first.sent.length === 1);
    first.reply(first.sent[0].id, {});
    await until(() => hello === 1);
    first.close(1006);
    await until(() => FakeSocket.instances.length === 2, 6000);
    const second = FakeSocket.instances[1];
    second.open();
    await expect(client.request("approvals.list", {})).rejects.toThrow("gateway not connected");
    expect(second.sent.filter((f) => f.method !== "connect")).toEqual([]);
    client.stop();
  });
});
