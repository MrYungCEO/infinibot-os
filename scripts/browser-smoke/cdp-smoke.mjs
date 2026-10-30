/**
 * Browser-relay CDP smoke harness.
 *
 * Verifies the InfiniBot Browser Relay (ws://127.0.0.1:18792/cdp) end-to-end
 * against the user's real running Chrome (InfiniBot profile) via the relay
 * extension. This is the reproducible form of the 7 smoke checks in the
 * browser-control-tool deliverable.
 *
 * Usage:
 *   node scripts/browser-smoke/cdp-smoke.mjs                # full flow
 *   node scripts/browser-smoke/cdp-smoke.mjs --list         # just list targets
 *   node scripts/browser-smoke/cdp-smoke.mjs --url https://infinitybotos.com
 *
 * Requires: the relay extension (assets/chrome-extension, >= 0.2.2) loaded in
 * the running Chrome and the gateway relay listening on :18792. With 0 tabs
 * attached the harness bootstraps one via Target.createTarget (which the
 * 0.2.2 fix makes possible from cold start).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Resolve ws from the repo's own install (works under pnpm's nested layout).
const WebSocket = require(require.resolve("ws", { paths: [repoRoot] }));

const RELAY = process.env.RELAY_CDP_URL || "ws://127.0.0.1:18792/cdp";
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const urlArg = (() => {
  const i = args.indexOf("--url");
  return i >= 0 ? args[i + 1] : "https://example.com/";
})();

function connect() {
  const ws = new WebSocket(RELAY);
  let id = 0;
  const pending = new Map();
  const cmd = (method, params, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
    });
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.method || ""} ${JSON.stringify(m.error)}`)) : res(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", (e) => rej(e));
  });
  return { ws, cmd, ready };
}

async function main() {
  const { ws, cmd, ready } = connect();
  const timer = setTimeout(() => {
    console.error("TIMEOUT after 25s");
    process.exit(1);
  }, 25_000);
  try {
    await ready;
    const targets = await cmd("Target.getTargets");
    const pages = (targets.targetInfos || []).filter((t) => t.type === "page");
    console.log(`[1] list_tabs → ${pages.length} attached page target(s)`);
    for (const p of pages) console.log(`      - ${p.title || "(untitled)"} :: ${p.url}`);
    if (listOnly) return done(ws, timer, 0);

    let targetId = pages[0]?.targetId;
    let created = false;
    if (!targetId) {
      const r = await cmd("Target.createTarget", { url: urlArg });
      targetId = r.targetId;
      created = true;
      console.log(`[*] cold-bootstrap → created+attached ${targetId} (${urlArg})`);
      await new Promise((r2) => setTimeout(r2, 1500));
    }

    const att = await cmd("Target.attachToTarget", { targetId, flatten: true });
    const sid = att.sessionId;
    await cmd("Runtime.enable", {}, sid);
    const ev = await cmd(
      "Runtime.evaluate",
      { expression: 'document.title + " | " + location.href', returnByValue: true },
      sid,
    );
    console.log(`[2] eval → ${JSON.stringify(ev.result && ev.result.value)}`);

    if (created) {
      await cmd("Target.closeTarget", { targetId });
      console.log(`[*] cleanup → closed bootstrap tab`);
    }
    done(ws, timer, 0);
  } catch (e) {
    console.error("SMOKE_FAIL:", e.message);
    done(ws, timer, 2);
  }
}

function done(ws, timer, code) {
  clearTimeout(timer);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

void main();
