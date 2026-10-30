#!/usr/bin/env node
/**
 * Push a normalized test diagram through the same path the MCP server uses:
 *  - normalizeBatch fills in runtime-required Excalidraw fields (seed,
 *    versionNonce, groupIds, version, updated, roundness, …) plus per-type
 *    defaults (stroke, fillStyle, roughness, …).
 *  - WS to gateway, handshake as backend with password.
 *  - send canvas.clear → canvas.update { elements } → canvas.view { fit }.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { normalizeBatch } from "./dist/elements.js";

const cfg = JSON.parse(readFileSync(join(homedir(), ".infinibot/mcp-servers.json"), "utf8"));
const ex = (cfg.mcpServers ?? cfg).excalidraw;
const URL = ex.env.INFINIBOT_GATEWAY_URL;
const PASSWORD = ex.env.INFINIBOT_GATEWAY_PASSWORD;
const PROTOCOL_VERSION = 3;

const raw = [
  { id: "title-1", type: "text", x: 120, y: 40, text: "InfiniBot — Canvas Test Diagram",
    fontSize: 28, strokeColor: "#d97706" },
  { id: "box-agent",   type: "rectangle", x: 80,  y: 140, width: 180, height: 80,
    text: "Agent",          backgroundColor: "#fef3c7", strokeColor: "#d97706" },
  { id: "box-mcp",     type: "rectangle", x: 320, y: 140, width: 180, height: 80,
    text: "MCP excalidraw", backgroundColor: "#ede9fe", strokeColor: "#7c3aed" },
  { id: "box-canvas",  type: "rectangle", x: 560, y: 140, width: 180, height: 80,
    text: "Web Whiteboard", backgroundColor: "#d1fae5", strokeColor: "#059669" },
  { id: "arrow-1", type: "arrow", x: 260, y: 180,
    points: [[0, 0], [60, 0]], strokeColor: "#d97706" },
  { id: "arrow-2", type: "arrow", x: 500, y: 180,
    points: [[0, 0], [60, 0]], strokeColor: "#7c3aed" },
  { id: "caption", type: "text", x: 120, y: 260,
    text: "Agent → MCP server → gateway broadcast → live canvas",
    fontSize: 16, strokeColor: "#6b7280" },
];

const elements = normalizeBatch(raw);
console.log(`normalized ${elements.length} elements`);

const ws = new WebSocket(URL);
let reqId = 1;
const nextId = () => `test-canvas-${reqId++}`;
const send = (m, p) => ws.send(JSON.stringify({ type: "req", id: nextId(), method: m, params: p }));

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "req", id: nextId(), method: "connect",
    params: {
      minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
      client: { id: "infinibot-mcp", version: "0.1.0", platform: "node", mode: "backend" },
      auth: { password: PASSWORD }, role: "operator",
    },
  }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "res" && msg.payload?.type === "hello-ok") {
    console.log("✓ connected");
    send("canvas.clear", {});
    send("canvas.update", { elements });
    send("canvas.view", { fitToContent: true });
    setTimeout(() => { ws.close(); process.exit(0); }, 800);
  } else if (msg.type === "res" && msg.ok === false) {
    console.error("rpc error:", msg.error);
  } else if (msg.type === "res" && msg.payload?.count !== undefined) {
    console.log(`✓ canvas.update accepted (count=${msg.payload.count})`);
  }
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 5000);
