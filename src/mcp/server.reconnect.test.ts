import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { runMcpServer, type McpServerHandle } from "./server.js";

type RemoteTool = { name: string; description?: string; inputSchema?: unknown };

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  return address.port;
}

async function startFakeGateway(port: number, tools: RemoteTool[]) {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as { id?: string; method?: string; type?: string };
      if (msg.type !== "req" || !msg.id) return;
      const payload =
        msg.method === "connect"
          ? { type: "hello-ok" }
          : msg.method === "agent.tools.list"
            ? { tools }
            : msg.method === "mcp.tools.list"
              ? { tools: [] }
              : {};
      socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload }));
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  return {
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function fetchMcpTools(port: number): Promise<{ tools?: RemoteTool[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp/tools`);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { tools?: RemoteTool[] };
}

let handle: McpServerHandle | null = null;
afterEach(async () => {
  await handle?.stop();
  handle = null;
});

test("reconnects gateway calls after the gateway restarts", async () => {
  const gatewayPort = await getFreePort();
  const httpPort = await getFreePort();
  const firstGateway = await startFakeGateway(gatewayPort, [{ name: "before-restart" }]);
  handle = await runMcpServer({
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
    httpPort,
  });

  await expect(fetchMcpTools(httpPort)).resolves.toMatchObject({
    tools: [{ name: "before-restart" }],
  });

  await firstGateway.close();
  const secondGateway = await startFakeGateway(gatewayPort, [{ name: "after-restart" }]);
  try {
    await expect(fetchMcpTools(httpPort)).resolves.toMatchObject({
      tools: [{ name: "after-restart" }],
    });
  } finally {
    await secondGateway.close();
  }
});
