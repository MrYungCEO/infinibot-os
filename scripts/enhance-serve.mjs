// Static SPA server for the worktree's built control-ui, so we can screenshot
// our branch's UI without touching the live gateway's dist.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || "/tmp/ib-enhance-wt/dist/control-ui");
const PORT = Number(process.argv[3] || 18999);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".ico": "image/x-icon", ".map": "application/json", ".wasm": "application/wasm",
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  try {
    const s = await stat(p);
    if (s.isDirectory()) p = path.join(p, "index.html");
  } catch {
    p = path.join(ROOT, "index.html"); // SPA path-route fallback
  }
  try {
    const buf = await readFile(p);
    res.writeHead(200, {
      "content-type": MIME[path.extname(p)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
