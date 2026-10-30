import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { BrowserExtensionGovernance } from "./extension-governance.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";

async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) return port;
  }
}

function rawStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  // fetch() silently drops a custom Host header; http.request does not.
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) return false;
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) clearTimeout(waiterTimer);
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) return;
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) return;
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) clearTimeout(waiterTimer);
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) return resolve(existing);
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

async function waitForListMatch<T>(
  fetchList: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fetchList();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error("timeout waiting for list update");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("refuses web-page origins and foreign Host headers", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl, allowUnpaired: true });

    const fromPage = await fetch(`${cdpUrl}/json/version`, {
      headers: { origin: "https://evil.example" },
    });
    expect(fromPage.status).toBe(403);
    expect(await rawStatus(port, "/json/version", { host: "evil.example" })).toBe(403);
    const fromExtension = await fetch(`${cdpUrl}/json/version`, {
      headers: { origin: "chrome-extension://abcdefghijklmnop" },
    });
    expect(fromExtension.status).toBe(200);

    const wsFromPage = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { origin: "https://evil.example" },
    });
    await expect(waitForOpen(wsFromPage)).rejects.toThrow(/403/);
  });

  it("exchanges a one-time pairing code for an authenticated extension connection", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    const governance = new BrowserExtensionGovernance(
      `${process.env.TMPDIR || "/tmp"}/infinibot-relay-auth-${process.pid}-${port}.json`,
    );
    await ensureChromeExtensionRelayServer({ cdpUrl, governance });

    const rejected = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await expect(waitForOpen(rejected)).rejects.toThrow(/401/);

    const pairing = governance.createPairingCode("Test Chrome");
    const pairResponse = await fetch(`${cdpUrl}/extension/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "chrome-extension://abcdefghijklmnop",
      },
      body: JSON.stringify({
        code: pairing.code,
        name: "Test Chrome",
        extensionId: "abcdefghijklmnop",
      }),
    });
    expect(pairResponse.status).toBe(200);
    const paired = (await pairResponse.json()) as { token: string; profile: { id: string } };
    expect(paired.token.length).toBeGreaterThan(20);

    const ext = new WebSocket(
      `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(paired.token)}`,
      { headers: { origin: "chrome-extension://abcdefghijklmnop" } },
    );
    await waitForOpen(ext);
    const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      profiles: Array<{ id: string }>;
    };
    expect(status.profiles.some((profile) => profile.id === paired.profile.id)).toBe(true);
    ext.close();
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl, allowUnpaired: true });

    const v1 = (await fetch(`${cdpUrl}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const v2 = (await fetch(`${cdpUrl}/json/version`).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("tracks attached page targets and exposes them via CDP + /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl, allowUnpaired: true });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Simulate a tab attach coming from the extension.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const list = (await fetch(`${cdpUrl}/json/list`).then((r) => r.json())) as Array<{
      id?: string;
      url?: string;
      title?: string;
    }>;
    expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

    // Simulate navigation updating tab metadata.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetInfoChanged",
          params: {
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "DER STANDARD",
              url: "https://www.derstandard.at/",
            },
          },
        },
      }),
    );

    const list2 = await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`).then((r) => r.json())) as Array<{
          id?: string;
          url?: string;
          title?: string;
        }>,
      (list) =>
        list.some(
          (t) =>
            t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
        ),
    );
    expect(
      list2.some(
        (t) =>
          t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
      ),
    ).toBe(true);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
    expect(res1.id).toBe(1);
    expect(JSON.stringify(res1.result ?? {})).toContain("t1");

    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "t1" },
      }),
    );
    const received: Array<{
      id?: number;
      method?: string;
      result?: unknown;
      params?: unknown;
    }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const res2 = received.find((m) => m.id === 2);
    expect(res2?.id).toBe(2);
    expect(JSON.stringify(res2?.result ?? {})).toContain("cb-tab-1");

    const evt = received.find((m) => m.method === "Target.attachedToTarget");
    expect(evt?.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(evt?.params ?? {})).toContain("t1");

    cdp.close();
    ext.close();
  }, 15_000);

  it("adopts the tab when createTarget loses the race to the extension's auto-attach", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl, allowUnpaired: true });
    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);
    // Extension <= 0.3.1: tabs.onCreated auto-attaches the new tab, then
    // createTarget's own attach fails with "Another debugger is already attached".
    ext.on("message", (data) => {
      const msg = JSON.parse(String(data)) as {
        id?: number;
        method?: string;
        params?: { method?: string };
      };
      if (msg.method !== "forwardCDPCommand" || msg.params?.method !== "Target.createTarget")
        return;
      ext.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-9",
              targetInfo: {
                targetId: "t-new",
                type: "page",
                title: "",
                url: "https://example.com/",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );
      ext.send(
        JSON.stringify({
          id: msg.id,
          error: "Another debugger is already attached to the tab with id: 5.",
        }),
      );
    });
    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);
    cdp.send(
      JSON.stringify({
        id: 7,
        method: "Target.createTarget",
        params: { url: "https://example.com/" },
      }),
    );
    let res: { id?: number; result?: { targetId?: string }; error?: unknown } = {};
    for (let i = 0; i < 6 && res.id !== 7; i++) res = JSON.parse(await q.next()) as typeof res;
    expect(res.error).toBeUndefined();
    expect(res.result?.targetId).toBe("t-new");
    cdp.close();
    ext.close();
  }, 15_000);

  it("rebroadcasts attach when a session id is reused for a new target", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl, allowUnpaired: true });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "First",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const first = JSON.parse(await q.next()) as { method?: string; params?: unknown };
    expect(first.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(first.params ?? {})).toContain("t1");

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t2",
              type: "page",
              title: "Second",
              url: "https://example.org",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const received: Array<{ method?: string; params?: unknown }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const detached = received.find((m) => m.method === "Target.detachedFromTarget");
    const attached = received.find((m) => m.method === "Target.attachedToTarget");
    expect(JSON.stringify(detached?.params ?? {})).toContain("t1");
    expect(JSON.stringify(attached?.params ?? {})).toContain("t2");

    cdp.close();
    ext.close();
  });
});
