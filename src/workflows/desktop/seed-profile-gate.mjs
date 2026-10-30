#!/usr/bin/env node
// Seed localStorage on the InfiniBot gateway origin so Brave/Chrome --app windows
// skip the profile-picker gate. Run by the multi-monitor-wall workflow before
// launching the wall.
//
// Usage: node seed-profile-gate.mjs <browserBin> <gatewayUrl>

import { spawn } from "node:child_process";
import WebSocket from "ws";

const [, , browserBin, gatewayUrl] = process.argv;
if (!browserBin || !gatewayUrl) {
  console.error("usage: seed-profile-gate.mjs <browserBin> <gatewayUrl>");
  process.exit(2);
}

const PORT = 9222 + Math.floor(Math.random() * 1000);

const child = spawn(
  browserBin,
  [
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    `--app=${gatewayUrl}/`,
  ],
  { detached: true, stdio: "ignore" },
);
child.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const arr = await res.json();
      const tgt = arr.find(
        (t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(gatewayUrl),
      );
      if (tgt) return tgt;
    } catch {}
    await sleep(200);
  }
  return null;
}

const target = await findTarget();
if (!target) {
  console.error("CDP target not found");
  try {
    process.kill(-child.pid);
  } catch {}
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once("open", res);
  ws.once("error", rej);
});

function send(id, method, params = {}) {
  return new Promise((res, rej) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.off("message", onMsg);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Wait for page load to settle so localStorage is accessible
await send(1, "Page.enable");
await sleep(500);
await send(2, "Runtime.evaluate", {
  expression: `(() => {
    try {
      localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
      sessionStorage.setItem("infinibot.profiles.gatePassed", "1");
      return "ok";
    } catch (e) { return String(e); }
  })()`,
  returnByValue: true,
});

ws.close();
// Close the seeder window
try {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
} catch {}
await sleep(200);
try {
  process.kill(-child.pid);
} catch {}
console.log("seeded");
