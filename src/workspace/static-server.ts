import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export function startStaticWorkspaceServer(rootInput: string, port: number) {
  const root = path.resolve(rootInput);
  return http
    .createServer((req, res) => {
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
      } catch {}
      const relative = pathname.replace(/^\/+/, "");
      let file = path.resolve(root, relative || "index.html");
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      } catch {
        // SPA fallback keeps in-app routes useful for plain HTML applications.
        file = path.join(root, "index.html");
      }
      try {
        const stat = fs.statSync(file);
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") res.end();
        else fs.createReadStream(file).pipe(res);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      }
    })
    .listen(port, "127.0.0.1", () => {
      process.stdout.write(`InfiniBot static workspace ready on http://127.0.0.1:${port}\n`);
    });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2];
  const port = Number(process.argv[3]);
  if (!root || !Number.isInteger(port)) throw new Error("usage: static-server <root> <port>");
  startStaticWorkspaceServer(root, port);
}
