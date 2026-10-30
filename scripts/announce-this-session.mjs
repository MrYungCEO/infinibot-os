#!/usr/bin/env node
/**
 * Announce the current Claude Code session to the local gateway so it
 * surfaces on the agent world map. Heartbeats every 30 s until killed.
 *
 * Use after a gateway restart that registers `sessions.announceExternal`:
 *   node scripts/announce-this-session.mjs &
 *
 * Stop:  kill %1   (or SIGINT)
 */
import os from "node:os";
import { callGateway } from "../dist/gateway/call.js";

const sessionKey = process.env.EXTERNAL_SESSION_KEY
  || `external:claude:${os.hostname()}:${process.ppid || process.pid}`;
const label = process.env.EXTERNAL_SESSION_LABEL
  || `Claude Code · ${os.hostname()} · pid ${process.ppid || process.pid}`;
const ttlSeconds = Number(process.env.EXTERNAL_SESSION_TTL || 90);

async function announce(initial) {
  try {
    const method = initial ? "sessions.announceExternal" : "sessions.heartbeatExternal";
    const params = initial
      ? {
          sessionKey,
          label,
          nodeId: "local",
          status: "working",
          coderBackend: "claude-code",
          ttlSeconds,
        }
      : { sessionKey, status: "working" };
    const r = await callGateway({ method, params, timeoutMs: 5000 });
    console.log(`[announce] ${initial ? "ANNOUNCED" : "heartbeat"} ${sessionKey}`, r);
  } catch (e) {
    console.error("[announce]", e?.message || e);
  }
}

async function end() {
  try {
    await callGateway({ method: "sessions.endExternal", params: { sessionKey }, timeoutMs: 3000 });
    console.log(`[announce] ENDED ${sessionKey}`);
  } catch {}
  process.exit(0);
}

process.on("SIGINT", end);
process.on("SIGTERM", end);

await announce(true);
setInterval(() => { void announce(false); }, Math.max(15_000, (ttlSeconds * 1000) / 3));
