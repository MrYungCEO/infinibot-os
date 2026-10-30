/**
 * Local verify harness for the workspace loader — NOT shipped (the vite build
 * only bundles what main.ts imports).
 *
 *   node ui/src/ui/cloud/verify/mock-fleet.mjs <dist-dir> [port]
 *
 * One port plays three roles:
 *   - serves the built cloud UI (<dist-dir>/app, built with base /app) with SPA fallback
 *   - POST /fleet/resolve: a stub orchestrator. The scenario is the Bearer
 *     token's prefix ("<scenario>.<nonce>"), so every page run has its own clock:
 *       warm      200 at once
 *       cold      409 for 20 s, then 200          (first provision, shortened)
 *       wake      409 for 3 s, then 200
 *       hold      the request is held 6 s, then 200 (waking a suspended Machine)
 *       slow      409 forever                       (a provision that drags on)
 *       upgrade   402 {status:"upgrade_required"}
 *       error     500
 *       flaky     500 on the first call, 200 after  (Retry works)
 *     Opening /app/?mock=<scenario> in any browser injects a signed-in Clerk stub
 *     for that scenario, so the page works without the puppeteer harness.
 *   - ws://…/ws: a stub tenant gateway. hello after HELLO_MS, plugins.list after
 *     PLUGINS_MS, so "Starting InfiniBot" and "Loading your agents and plugins"
 *     are both observable. POST /__mock/drop?ms=N closes every socket and
 *     refuses new ones for N ms (a same-tab reconnect).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const [dist = "/tmp/wl-dist", port = "4810"] = process.argv.slice(2);
const HELLO_MS = Number(process.env.MOCK_HELLO_MS ?? 2500);
const PLUGINS_MS = Number(process.env.MOCK_PLUGINS_MS ?? 2000);
const firstSeen = new Map();
const calls = new Map();
let refuseUntil = 0;

function resolve(token) {
  const scenario = token.split(".")[0];
  if (!firstSeen.has(token)) firstSeen.set(token, Date.now());
  const n = (calls.get(token) ?? 0) + 1;
  calls.set(token, n);
  const waited = Date.now() - firstSeen.get(token);
  const ready = { gatewayWsUrl: `ws://127.0.0.1:${port}/ws`, machineId: "mock-machine", region: "sin", status: "ready", tenantId: "t-mock" };
  const provisioning = [409, { status: "provisioning", tenantId: "t-mock" }];
  switch (scenario) {
    case "cold": return waited < 20_000 ? provisioning : [200, ready];
    case "wake": return waited < 3_000 ? provisioning : [200, ready];
    case "hold": return [200, ready, n === 1 ? 6_000 : 0];
    case "slow": return provisioning;
    case "upgrade": return [402, { status: "upgrade_required", error: "Self-host InfiniBot free, or upgrade to a hosted plan", tenantId: "t-mock", plan: "free" }];
    case "error": return [500, { error: "internal" }];
    case "flaky": return n === 1 ? [500, { error: "internal" }] : [200, ready];
    default: return [200, ready];
  }
}

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === "/fleet/resolve") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const [status, body, delay = 0] = token ? resolve(token) : [401, { error: "unauthorized" }];
    console.log("resolve", token, status, delay ? `(held ${delay}ms)` : "");
    return setTimeout(() => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); }, delay + 80);
  }
  if (url.pathname === "/__mock/drop") {
    refuseUntil = Date.now() + Number(url.searchParams.get("ms") ?? 5000);
    for (const c of wss.clients) c.terminate();
    res.writeHead(200, cors); return res.end("ok");
  }
  if (url.pathname.startsWith("/app")) {
    const p = decodeURIComponent(url.pathname);
    let f = path.join(dist, p);
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "app", "index.html");
    const mock = url.searchParams.get("mock");
    if (mock && f.endsWith("index.html")) {
      const stub = `<script>window.Clerk={loaded:true,load:async()=>{},user:{id:"user_stub",fullName:"Mock Member",firstName:"Mock",primaryEmailAddress:{emailAddress:"member@example.com"}},session:{id:"sess_stub",getToken:async()=>${JSON.stringify(`${mock.replace(/[^a-z]/g, "")}.${Date.now()}`)}},addListener:()=>()=>{},redirectToSignIn:async()=>{},signOut:async()=>{}};</script>`;
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      return res.end(fs.readFileSync(f, "utf8").replace("<head>", `<head>${stub}`));
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] ?? "application/octet-stream" });
    return fs.createReadStream(f).pipe(res);
  }
  // Anything else is a tenant-gateway REST call the stub doesn't implement.
  res.writeHead(404, { ...cors, "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (Date.now() < refuseUntil) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  const reply = (id, payload, delay = 0) => setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "res", id, ok: true, payload })), delay);
  ws.on("message", (raw) => {
    let f; try { f = JSON.parse(String(raw)); } catch { return; }
    if (f.type !== "req") return;
    if (f.method === "connect") return reply(f.id, { type: "hello-ok", protocol: 3, features: { methods: [], events: [] }, snapshot: {} }, HELLO_MS);
    if (f.method === "plugins.list") return reply(f.id, { plugins: [], landing: null }, PLUGINS_MS);
    if (f.method === "saas.onboarding.status") return reply(f.id, { required: false }, 300);
    if (f.method === "saas.me") return reply(f.id, { email: "member@example.com" }, 100);
    ws.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { code: "unavailable", message: "mock gateway: not implemented" } }));
  });
});

server.listen(+port, "127.0.0.1", () => console.log(`mock fleet http://127.0.0.1:${port}/app/`));
