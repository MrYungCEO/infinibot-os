// Same-origin read-only proxy: serves THIS branch's dist/control-ui on :18978
// and forwards every other HTTP request + WebSocket upgrade to the LIVE
// gateway on 127.0.0.1:18789, so the browser sees one origin (no CORS) and the
// UI authenticates exactly as it does on the live host (?password=).
import http from "node:http";
import net from "node:net";
import { existsSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize } from "node:path";
const ROOT = `${process.env.INFINIBOT_WORKTREE || "/tmp/ib-mesh-plugin-rooms"}/dist/control-ui`;
const PORT = 18978, UP = { host: "127.0.0.1", port: 18789 };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wasm": "application/wasm" };
const API = ["/api", "/ws", "/plugins", "/health", "/hooks", "/canvas", "/proactive", "/artifacts", "/agent-mcp", "/uploads", "/reports"];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = normalize(url.pathname);
  const file = join(ROOT, p);
  const isApi = API.some((a) => p === a || p.startsWith(a + "/"));
  if (!isApi && existsSync(file) && statSync(file).isFile()) { res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }); createReadStream(file).pipe(res); return; }
  if (!isApi && !extname(p)) { res.writeHead(200, { "content-type": "text/html" }); createReadStream(join(ROOT, "index.html")).pipe(res); return; }
  const h = { ...req.headers, host: `127.0.0.1:18789` };
  if (h.origin) h.origin = "http://127.0.0.1:18789";
  if (h.referer) h.referer = h.referer.replace(/^http:\/\/127\.0\.0\.1:18978/, "http://127.0.0.1:18789");
  const up = http.request({ ...UP, path: req.url, method: req.method, headers: h }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});
server.on("upgrade", (req, socket, head) => {
  const s = net.connect(UP.port, UP.host, () => {
    const hh = { ...req.headers, host: "127.0.0.1:18789" };
    if (hh.origin) hh.origin = "http://127.0.0.1:18789";
    const hdr = Object.entries(hh).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    s.write(`${req.method} ${req.url} HTTP/1.1\r\n${hdr}\r\n\r\n`); if (head?.length) s.write(head);
    s.pipe(socket); socket.pipe(s);
  });
  s.on("error", () => socket.destroy()); socket.on("error", () => s.destroy());
});
server.listen(PORT, "127.0.0.1", () => console.log(`live-proxy on ${PORT} → ${UP.host}:${UP.port}`));
