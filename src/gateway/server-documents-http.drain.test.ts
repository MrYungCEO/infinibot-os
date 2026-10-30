/**
 * An oversized Documents upload is refused with 413 AND the connection does
 * not stall: the gateway drains (bounded) the body it refused, so a client
 * that keeps sending — a browser behind a TLS proxy — gets the reply instead
 * of hanging until it times out.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir: string;
let server: http.Server;
let port: number;
const saved = { ...process.env };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-docs-drain-"));
  process.env.INFINIBOT_STATE_DIR = dir;
  process.env.INFINIBOT_DOCUMENTS_MAX_UPLOAD_BYTES = "1024";
  delete process.env.SAAS_MODE;
  const { handleDocumentsHttpRequest } = await import("./server-documents-http.js");
  server = http.createServer((req, res) => void handleDocumentsHttpRequest(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("documents upload over the limit", () => {
  it("answers 413 with Connection: close and lets the client finish sending (no stall)", async () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 1);
    const result = await new Promise<{ status?: number; conn?: string; sent: boolean }>(
      (resolve, reject) => {
        let status: number | undefined;
        let conn: string | undefined;
        let sent = false;
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/documents/upload?name=big.bin",
            headers: { "Content-Length": body.length },
          },
          (res) => {
            status = res.statusCode;
            conn = String(res.headers.connection ?? "");
            res.resume();
            res.on("end", () => setTimeout(() => resolve({ status, conn, sent }), 200));
          },
        );
        req.on("finish", () => (sent = true));
        req.on("error", (e) => (status ? resolve({ status, conn, sent }) : reject(e)));
        req.setTimeout(10_000, () => reject(new Error("upload stalled")));
        req.end(body);
      },
    );
    expect(result.status).toBe(413);
    expect(result.conn).toBe("close");
    expect(result.sent).toBe(true);
  });
});
