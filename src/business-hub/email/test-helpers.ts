/**
 * Business hub email — test helpers: an in-process SMTP sink (node:net) so
 * the sender loop is exercised end-to-end through nodemailer without any
 * mail ever leaving the process, plus a tiny HTTP harness for the public
 * routes. Test-only (excluded from the build by tsconfig).
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export type SinkMessage = { from: string; to: string[]; raw: string };

export type SmtpSink = {
  port: number;
  messages: SinkMessage[];
  /** Reject the next N RCPT commands with 550. */
  failNext: (n: number) => void;
  close: () => Promise<void>;
};

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  let failures = 0;
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    let inData = false;
    let data: string[] = [];
    let from = "";
    let to: string[] = [];
    const reply = (s: string) => sock.write(`${s}\r\n`);
    reply("220 sink.test ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ from, to, raw: data.join("\r\n") });
            data = [];
            reply("250 2.0.0 queued");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-sink.test\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n");
        else if (cmd === "HELO") reply("250 sink.test");
        else if (cmd === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          to = [];
          reply("250 2.1.0 ok");
        } else if (cmd === "RCPT") {
          if (failures > 0) {
            failures--;
            reply("550 5.1.1 no such user");
          } else {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
            reply("250 2.1.5 ok");
          }
        } else if (cmd === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (cmd === "RSET" || cmd === "NOOP") reply("250 ok");
        else if (cmd === "QUIT") {
          reply("221 bye");
          sock.end();
        } else reply("502 not implemented");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    failNext: (n) => {
      failures = n;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export async function startHttp(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => Promise<boolean>,
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createHttpServer((req, res) => {
    handler(req, res)
      .then((handled) => {
        if (!handled && !res.headersSent) res.writeHead(404).end();
      })
      .catch((err) => {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
