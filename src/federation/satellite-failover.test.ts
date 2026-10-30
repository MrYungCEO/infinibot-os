import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { FederationSatellite } from "./satellite.js";
import {
  buildHeartbeatAckMessage,
  buildRegisterAckMessage,
  deserializeMessage,
} from "./protocol.js";
import { createMessageOptimizer } from "./message-optimizer.js";

type MockMaster = {
  url: string;
  wss: WebSocketServer;
  sockets: Set<WebSocket>;
  close: () => Promise<void>;
};

async function createMockMaster(nodeId: string): Promise<MockMaster> {
  const wss = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  const optimizer = createMessageOptimizer(nodeId, {
    batchingEnabled: false,
    compressionEnabled: false,
  });

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      void (async () => {
        const messages = await optimizer.processReceived(data.toString());
        for (const message of messages) {
          const msg = deserializeMessage(message);
          if (msg.type === "node.register") {
            socket.send(buildRegisterAckMessage(true, nodeId));
          } else if (msg.type === "node.heartbeat") {
            const payload = msg.payload as { timestamp?: number };
            socket.send(buildHeartbeatAckMessage(payload.timestamp ?? Date.now()));
          }
        }
      })();
    });
    socket.on("close", () => {
      if (sockets.size === 0) {
        optimizer.shutdown();
      }
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("mock master did not bind to a TCP port");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    wss,
    sockets,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe("FederationSatellite master failover", () => {
  const masters: MockMaster[] = [];
  const satellites: FederationSatellite[] = [];

  afterEach(async () => {
    await Promise.allSettled(satellites.splice(0).map((satellite) => satellite.disconnect()));
    await Promise.allSettled(masters.splice(0).map((master) => master.close()));
  });

  it("switches to the next configured master after the primary goes away", async () => {
    const primary = await createMockMaster("primary");
    const fallback = await createMockMaster("fallback");
    masters.push(primary, fallback);

    const satellite = new FederationSatellite({
      masterUrl: primary.url,
      masters: [primary.url, fallback.url],
      nodeName: "failover-sat",
      autoReconnect: true,
      enablePeerMesh: false,
      heartbeatIntervalMs: 20,
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      masterFailoverTimeoutMs: 50,
    });
    satellites.push(satellite);
    satellite.on("error", () => {
      // Expected while the satellite retries the yanked primary before
      // the failover timeout advances it to the fallback master.
    });

    await satellite.connect();
    expect(satellite.getState()).toBe("connected");

    const auditEntry = new Promise<{ from: string; to: string; reason: string; ts: number }>(
      (resolve) => satellite.once("audit-log", resolve),
    );
    const reconnected = new Promise<void>((resolve) =>
      satellite.once("connected", () => resolve()),
    );

    await primary.close();

    await expect(auditEntry).resolves.toMatchObject({
      from: primary.url,
      to: fallback.url,
    });
    await expect(reconnected).resolves.toBeUndefined();
    expect(satellite.getState()).toBe("connected");
  });
});
