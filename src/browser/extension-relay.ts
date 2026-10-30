import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { rawDataToString } from "../infra/ws.js";
import {
  type BrowserExtensionGovernance,
  type BrowserExtensionProfile,
  getBrowserExtensionGovernance,
} from "./extension-governance.js";

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type ExtensionForwardCommandMessage = {
  id: number;
  method: "forwardCDPCommand";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionResponseMessage = {
  id: number;
  result?: unknown;
  error?: string;
};

type ExtensionForwardEventMessage = {
  method: "forwardCDPEvent";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionPingMessage = { method: "ping" };
type ExtensionPongMessage = { method: "pong" };

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionForwardEventMessage
  | ExtensionPongMessage;

type TargetInfo = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

type ConnectedTarget = {
  profileId: string;
  sessionId: string;
  rawSessionId: string;
  targetId: string;
  rawTargetId: string;
  targetInfo: TargetInfo;
  /** When the extension reported this target attached (ms epoch). */
  attachedAt?: number;
};

export type ChromeExtensionRelayServer = {
  host: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

type ExtensionConnection = {
  profile: BrowserExtensionProfile;
  ws: WebSocket;
  targets: Set<string>;
};

function scopedId(profileId: string, raw: string): string {
  return profileId === "legacy-test" ? raw : `${profileId}:${raw}`;
}

function isLoopbackHost(host: string) {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "::1" ||
    h === "[::]" ||
    h === "::"
  );
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Browsers always stamp an Origin on cross-origin fetches and on every
 * WebSocket handshake, and page script cannot forge it. The only browser
 * origin allowed to talk to the relay is the InfiniBot Chrome extension;
 * Node CDP clients (playwright/puppeteer) send no Origin at all.
 */
export function isAllowedRelayOrigin(origin: string | string[] | undefined): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) return true;
  return value.trim().toLowerCase().startsWith("chrome-extension://");
}

/** Reject DNS-rebinding: the Host header must name a loopback host. */
export function isAllowedRelayHostHeader(hostHeader: string | undefined): boolean {
  const raw = (hostHeader ?? "").trim().toLowerCase();
  if (!raw) return true;
  let host = raw;
  if (host.startsWith("[")) {
    host = host.slice(0, host.indexOf("]") + 1);
  } else if (host.includes(":")) {
    host = host.slice(0, host.lastIndexOf(":"));
  }
  return (
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.startsWith("127.")
  );
}

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res: Duplex, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
  );
  res.write(body);
  res.end();
}

function jsonResponse(res: import("node:http").ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 16_384) throw new Error("request too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function rejectUpgrade(socket: Duplex, status: number, bodyText: string) {
  text(socket, status, bodyText);
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

const serversByPort = new Map<number, ChromeExtensionRelayServer>();

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
  /** Unit-test compatibility only. Production callers must pair first. */
  allowUnpaired?: boolean;
  /** Isolated registry for tests and non-production harnesses. */
  governance?: BrowserExtensionGovernance;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }

  const existing = serversByPort.get(info.port);
  if (existing) return existing;

  const governance = opts.governance ?? getBrowserExtensionGovernance();
  const extensions = new Map<string, ExtensionConnection>();
  const cdpClients = new Set<WebSocket>();
  const connectedTargets = new Map<string, ConnectedTarget>();

  const pendingExtension = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      profileId: string;
    }
  >();
  let nextExtensionId = 1;

  const connectionForCommand = (
    payload: ExtensionForwardCommandMessage,
  ): ExtensionConnection | null => {
    const sessionId = payload.params.sessionId;
    if (sessionId) {
      const target = connectedTargets.get(sessionId);
      if (target) return extensions.get(target.profileId) ?? null;
    }
    const targetId = (payload.params.params as { targetId?: unknown } | undefined)?.targetId;
    if (typeof targetId === "string") {
      const target = Array.from(connectedTargets.values()).find((t) => t.targetId === targetId);
      if (target) return extensions.get(target.profileId) ?? null;
    }
    return extensions.values().next().value ?? null;
  };

  const sendToExtension = async (payload: ExtensionForwardCommandMessage): Promise<unknown> => {
    const connection = connectionForCommand(payload);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension not connected");
    }
    const ws = connection.ws;
    const target = payload.params.sessionId
      ? connectedTargets.get(payload.params.sessionId)
      : Array.from(connectedTargets.values()).find(
          (t) =>
            t.targetId === (payload.params.params as { targetId?: unknown } | undefined)?.targetId,
        );
    const rawParams = payload.params.params as Record<string, unknown> | undefined;
    const sentAt = Date.now();
    ws.send(
      JSON.stringify({
        ...payload,
        params: {
          ...payload.params,
          sessionId: target?.rawSessionId ?? payload.params.sessionId,
          params:
            rawParams && target?.rawTargetId
              ? { ...rawParams, targetId: target.rawTargetId }
              : rawParams,
        },
      }),
    );
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtension.delete(payload.id);
        reject(new Error(`extension request timeout: ${payload.params.method}`));
      }, 30_000);
      pendingExtension.set(payload.id, {
        resolve: (value) => {
          if (
            payload.params.method === "Target.createTarget" &&
            connection &&
            value &&
            typeof value === "object" &&
            typeof (value as { targetId?: unknown }).targetId === "string"
          ) {
            const rawTargetId = String((value as { targetId: string }).targetId);
            // A page target id is also its initial main-frame id. Rewriting it
            // breaks Playwright because Page.getFrameTree correctly returns the
            // raw frame id and the synthetic initial frame is then detached.
            // Chrome target ids are random enough to share safely across paired
            // profiles; session ids remain profile-scoped for routing.
            resolve({ ...value, targetId: rawTargetId });
            return;
          }
          resolve(value);
        },
        reject: (err) => {
          // Extension <= 0.3.1 race: Chrome's tabs.onCreated auto-attach grabs
          // the new tab first, so createTarget's own attach fails with
          // "Another debugger is already attached". The tab exists and is
          // attached; hand back the target that just appeared.
          if (
            payload.params.method === "Target.createTarget" &&
            connection &&
            /already attached/i.test(err.message)
          ) {
            const wantUrl = typeof rawParams?.url === "string" ? rawParams.url : "";
            void findFreshTarget(connection.profile.id, sentAt, wantUrl).then((found) =>
              found ? resolve({ targetId: found.rawTargetId }) : reject(err),
            );
            return;
          }
          reject(err);
        },
        timer,
        profileId: connection.profile.id,
      });
    });
  };

  const findFreshTarget = async (
    profileId: string,
    since: number,
    url: string,
  ): Promise<ConnectedTarget | null> => {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const fresh = [...connectedTargets.values()].filter(
        (t) => t.profileId === profileId && (t.attachedAt ?? 0) >= since - 50,
      );
      const match =
        fresh.find((t) => url && t.targetInfo?.url === url) ??
        fresh.find((t) => !t.targetInfo?.url || t.targetInfo.url === "about:blank") ??
        fresh[0];
      if (match) return match;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const broadcastToCdpClients = (evt: CdpEvent) => {
    const msg = JSON.stringify(evt);
    for (const ws of cdpClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(msg);
    }
  };

  const sendResponseToCdp = (ws: WebSocket, res: CdpResponse) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(res));
  };

  const ensureTargetEventsForClient = (ws: WebSocket, mode: "autoAttach" | "discover") => {
    for (const target of connectedTargets.values()) {
      if (mode === "autoAttach") {
        ws.send(
          JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: target.sessionId,
              targetInfo: { ...target.targetInfo, attached: true },
              waitingForDebugger: false,
            },
          } satisfies CdpEvent),
        );
      } else {
        ws.send(
          JSON.stringify({
            method: "Target.targetCreated",
            params: { targetInfo: { ...target.targetInfo, attached: true } },
          } satisfies CdpEvent),
        );
      }
    }
  };

  const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
    switch (cmd.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/InfiniBot-Extension-Relay",
          revision: "0",
          userAgent: "InfiniBot-Extension-Relay",
          jsVersion: "V8",
        };
      case "Browser.setDownloadBehavior":
        return {};
      case "Target.setAutoAttach":
      case "Target.setDiscoverTargets":
        return {};
      case "Target.getTargets":
        return {
          targetInfos: Array.from(connectedTargets.values()).map((t) => ({
            ...t.targetInfo,
            attached: true,
          })),
        };
      case "Target.getTargetInfo": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (targetId) {
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) return { targetInfo: t.targetInfo };
          }
        }
        if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
          const t = connectedTargets.get(cmd.sessionId);
          if (t) return { targetInfo: t.targetInfo };
        }
        const first = Array.from(connectedTargets.values())[0];
        return { targetInfo: first?.targetInfo };
      }
      case "Target.attachToTarget": {
        const params = (cmd.params ?? {}) as { targetId?: string };
        const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
        if (!targetId) throw new Error("targetId required");
        for (const t of connectedTargets.values()) {
          if (t.targetId === targetId) return { sessionId: t.sessionId };
        }
        throw new Error("target not found");
      }
      default: {
        const id = nextExtensionId++;
        return await sendToExtension({
          id,
          method: "forwardCDPCommand",
          params: {
            method: cmd.method,
            sessionId: cmd.sessionId,
            params: cmd.params,
          },
        });
      }
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const path = url.pathname;

    if (
      !isLoopbackAddress(req.socket.remoteAddress) ||
      !isAllowedRelayHostHeader(req.headers.host) ||
      !isAllowedRelayOrigin(req.headers.origin)
    ) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (req.method === "HEAD" && path === "/") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
      return;
    }

    if (path === "/extension/status") {
      jsonResponse(res, 200, {
        connected: extensions.size > 0,
        profiles: [...extensions.values()].map((connection) => ({
          id: connection.profile.id,
          name: connection.profile.name,
        })),
      });
      return;
    }

    if (path === "/extension/pair" && req.method === "POST") {
      void readJsonBody(req)
        .then((body) => {
          const paired = governance.pair({
            code: String(body.code ?? ""),
            name: String(body.name ?? ""),
            extensionId: String(body.extensionId ?? ""),
          });
          jsonResponse(res, 200, paired);
        })
        .catch((err) =>
          jsonResponse(res, 401, { error: err instanceof Error ? err.message : String(err) }),
        );
      return;
    }

    if (path === "/extension/claim" && req.method === "POST") {
      void readJsonBody(req)
        .then(async (body) => {
          const targetId = String(body.targetId ?? "").trim();
          if (!targetId) throw new Error("targetId required");
          const result = await sendToExtension({
            id: nextExtensionId++,
            method: "forwardCDPCommand",
            params: {
              method: "InfiniBot.claimTab",
              params: {
                targetId,
                runId: String(body.runId ?? "agent"),
                label: String(body.label ?? body.runId ?? "agent"),
              },
            },
          });
          jsonResponse(res, 200, result ?? { claimed: true });
        })
        .catch((err) =>
          jsonResponse(res, 400, { error: err instanceof Error ? err.message : String(err) }),
        );
      return;
    }

    const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
    const wsHost = `ws://${hostHeader}`;
    const cdpWsUrl = `${wsHost}/cdp`;

    if (
      (path === "/json/version" || path === "/json/version/") &&
      (req.method === "GET" || req.method === "PUT")
    ) {
      const payload: Record<string, unknown> = {
        Browser: "InfiniBot/extension-relay",
        "Protocol-Version": "1.3",
      };
      // Only advertise the WS URL if a real extension is connected.
      if (extensions.size > 0) payload.webSocketDebuggerUrl = cdpWsUrl;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
    if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
      const list = Array.from(connectedTargets.values()).map((t) => ({
        id: t.targetId,
        type: t.targetInfo.type ?? "page",
        title: t.targetInfo.title ?? "",
        description: t.targetInfo.title ?? "",
        url: t.targetInfo.url ?? "",
        webSocketDebuggerUrl: cdpWsUrl,
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    const activateMatch = path.match(/^\/json\/activate\/(.+)$/);
    if (activateMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(activateMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          await sendToExtension({
            id: nextExtensionId++,
            method: "forwardCDPCommand",
            params: { method: "Target.activateTarget", params: { targetId } },
          });
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    const closeMatch = path.match(/^\/json\/close\/(.+)$/);
    if (closeMatch && (req.method === "GET" || req.method === "PUT")) {
      const targetId = decodeURIComponent(closeMatch[1] ?? "").trim();
      if (!targetId) {
        res.writeHead(400);
        res.end("targetId required");
        return;
      }
      void (async () => {
        try {
          await sendToExtension({
            id: nextExtensionId++,
            method: "forwardCDPCommand",
            params: { method: "Target.closeTarget", params: { targetId } },
          });
        } catch {
          // ignore
        }
      })();
      res.writeHead(200);
      res.end("OK");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wssExtension = new WebSocketServer({ noServer: true });
  const wssCdp = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", info.baseUrl);
    const pathname = url.pathname;
    const remote = req.socket.remoteAddress;

    if (
      !isLoopbackAddress(remote) ||
      !isAllowedRelayHostHeader(req.headers.host) ||
      !isAllowedRelayOrigin(req.headers.origin)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (pathname === "/extension") {
      const token = url.searchParams.get("token") ?? "";
      const paired = token ? governance.authenticate(token) : null;
      const profile: BrowserExtensionProfile | null =
        paired ??
        (opts.allowUnpaired
          ? {
              id: "legacy-test",
              name: "Legacy test Chrome",
              extensionId: "test",
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
              connected: false,
            }
          : null);
      if (!profile) {
        rejectUpgrade(socket, 401, "Pair this Chrome profile in InfiniBot first");
        return;
      }
      const existingConnection = extensions.get(profile.id);
      if (existingConnection) existingConnection.ws.close(4001, "replaced by a newer connection");
      (req as typeof req & { infinibotProfile?: BrowserExtensionProfile }).infinibotProfile =
        profile;
      wssExtension.handleUpgrade(req, socket, head, (ws) => {
        wssExtension.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/cdp") {
      if (extensions.size === 0) {
        rejectUpgrade(socket, 503, "Extension not connected");
        return;
      }
      wssCdp.handleUpgrade(req, socket, head, (ws) => {
        wssCdp.emit("connection", ws, req);
      });
      return;
    }

    rejectUpgrade(socket, 404, "Not Found");
  });

  wssExtension.on("connection", (ws, req) => {
    const profile = (req as typeof req & { infinibotProfile?: BrowserExtensionProfile })
      .infinibotProfile;
    if (!profile) {
      ws.close(1008, "pairing required");
      return;
    }
    const connection: ExtensionConnection = { profile, ws, targets: new Set() };
    extensions.set(profile.id, connection);
    governance.setConnected(profile.id, true);

    // Any message counts as life. A Chrome whose service worker was killed
    // without a close frame stops answering pings; drop it after ~30 s so
    // status reads "not connected" and the extension's reconnect takes over.
    let lastHeardAt = Date.now();
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastHeardAt > 30_000) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
    }, 5000);

    ws.on("message", (data) => {
      lastHeardAt = Date.now();
      let parsed: ExtensionMessage | null = null;
      try {
        parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
      } catch {
        return;
      }

      if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "number") {
        const pending = pendingExtension.get(parsed.id);
        if (!pending) return;
        pendingExtension.delete(parsed.id);
        clearTimeout(pending.timer);
        if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
          pending.reject(new Error(parsed.error));
        } else {
          pending.resolve((parsed as ExtensionResponseMessage).result);
        }
        return;
      }

      if (parsed && typeof parsed === "object" && "method" in parsed) {
        if ((parsed as ExtensionPongMessage).method === "pong") return;
        if ((parsed as ExtensionForwardEventMessage).method !== "forwardCDPEvent") return;
        const evt = parsed as ExtensionForwardEventMessage;
        const method = evt.params?.method;
        const params = evt.params?.params;
        const sessionId = evt.params?.sessionId;
        if (!method || typeof method !== "string") return;

        if (method === "Target.attachedToTarget") {
          const attached = (params ?? {}) as AttachedToTargetEvent;
          const targetType = attached?.targetInfo?.type ?? "page";
          if (targetType !== "page") return;
          if (attached?.sessionId && attached?.targetInfo?.targetId) {
            const globalSessionId = scopedId(profile.id, attached.sessionId);
            const rawTargetId = attached.targetInfo.targetId;
            const nextTargetId = rawTargetId;
            const targetInfo = { ...attached.targetInfo, targetId: nextTargetId };
            const prev = connectedTargets.get(globalSessionId);
            const prevTargetId = prev?.targetId;
            const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
            connectedTargets.set(globalSessionId, {
              profileId: profile.id,
              sessionId: globalSessionId,
              rawSessionId: attached.sessionId,
              targetId: nextTargetId,
              rawTargetId,
              targetInfo,
              attachedAt: prev?.attachedAt ?? Date.now(),
            });
            connection.targets.add(globalSessionId);
            if (changedTarget && prevTargetId) {
              broadcastToCdpClients({
                method: "Target.detachedFromTarget",
                params: { sessionId: globalSessionId, targetId: prevTargetId },
              });
            }
            if (!prev || changedTarget) {
              broadcastToCdpClients({
                method,
                params: { ...attached, sessionId: globalSessionId, targetInfo },
                // Root-page attachment is a browser-session event. Adding an outer
                // sessionId makes Playwright route it to the new page before that
                // page session exists, so BrowserContext.newPage() never resolves.
                sessionId: sessionId ? scopedId(profile.id, sessionId) : undefined,
              });
            }
            return;
          }
        }

        if (method === "Target.detachedFromTarget") {
          const detached = (params ?? {}) as DetachedFromTargetEvent;
          const globalSessionId = detached?.sessionId
            ? scopedId(profile.id, detached.sessionId)
            : undefined;
          const target = globalSessionId ? connectedTargets.get(globalSessionId) : undefined;
          if (globalSessionId) {
            connectedTargets.delete(globalSessionId);
            connection.targets.delete(globalSessionId);
          }
          broadcastToCdpClients({
            method,
            params: {
              ...detached,
              sessionId: globalSessionId,
              targetId: target?.targetId,
            },
            sessionId: sessionId ? scopedId(profile.id, sessionId) : undefined,
          });
          return;
        }

        // Keep cached tab metadata fresh for /json/list.
        // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
        if (method === "Target.targetInfoChanged") {
          const changed = (params ?? {}) as { targetInfo?: { targetId?: string; type?: string } };
          const targetInfo = changed?.targetInfo;
          const rawTargetId = targetInfo?.targetId;
          const targetId = rawTargetId;
          if (targetId && (targetInfo?.type ?? "page") === "page") {
            for (const [sid, target] of connectedTargets) {
              if (target.targetId !== targetId) continue;
              connectedTargets.set(sid, {
                ...target,
                targetInfo: { ...target.targetInfo, ...(targetInfo as object), targetId },
              });
            }
          }
        }

        const globalSessionId = sessionId ? scopedId(profile.id, sessionId) : undefined;
        broadcastToCdpClients({ method, params, sessionId: globalSessionId });
      }
    });

    ws.on("close", () => {
      clearInterval(ping);
      if (extensions.get(profile.id)?.ws === ws) extensions.delete(profile.id);
      governance.setConnected(profile.id, false);
      for (const [id, pending] of pendingExtension) {
        if (pending.profileId !== profile.id) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("extension disconnected"));
        pendingExtension.delete(id);
      }
      for (const sessionId of connection.targets) {
        const target = connectedTargets.get(sessionId);
        connectedTargets.delete(sessionId);
        if (target) {
          broadcastToCdpClients({
            method: "Target.detachedFromTarget",
            params: { sessionId, targetId: target.targetId },
            sessionId,
          });
        }
      }
    });
  });

  wssCdp.on("connection", (ws) => {
    cdpClients.add(ws);

    ws.on("message", async (data) => {
      let cmd: CdpCommand | null = null;
      try {
        cmd = JSON.parse(rawDataToString(data)) as CdpCommand;
      } catch {
        return;
      }
      if (!cmd || typeof cmd !== "object") return;
      if (typeof cmd.id !== "number" || typeof cmd.method !== "string") return;

      if (extensions.size === 0) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: "Extension not connected" },
        });
        return;
      }

      try {
        const result = await routeCdpCommand(cmd);

        if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
          ensureTargetEventsForClient(ws, "autoAttach");
        }
        if (cmd.method === "Target.setDiscoverTargets") {
          const discover = (cmd.params ?? {}) as { discover?: boolean };
          if (discover.discover === true) {
            ensureTargetEventsForClient(ws, "discover");
          }
        }
        if (cmd.method === "Target.attachToTarget") {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (targetId) {
            const target = Array.from(connectedTargets.values()).find(
              (t) => t.targetId === targetId,
            );
            if (target) {
              ws.send(
                JSON.stringify({
                  method: "Target.attachedToTarget",
                  params: {
                    sessionId: target.sessionId,
                    targetInfo: { ...target.targetInfo, attached: true },
                    waitingForDebugger: false,
                  },
                } satisfies CdpEvent),
              );
            }
          }
        }

        sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
      } catch (err) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    ws.on("close", () => {
      cdpClients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(info.port, info.host, () => resolve());
    server.once("error", reject);
  });

  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? info.port;
  const host = info.host;
  const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

  const relay: ChromeExtensionRelayServer = {
    host,
    port,
    baseUrl,
    cdpWsUrl: `ws://${host}:${port}/cdp`,
    extensionConnected: () => extensions.size > 0,
    stop: async () => {
      serversByPort.delete(port);
      try {
        for (const connection of extensions.values()) {
          connection.ws.close(1001, "server stopping");
        }
      } catch {
        // ignore
      }
      for (const ws of cdpClients) {
        try {
          ws.close(1001, "server stopping");
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      wssExtension.close();
      wssCdp.close();
    },
  };

  serversByPort.set(port, relay);
  return relay;
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = serversByPort.get(info.port);
  if (!existing) return false;
  await existing.stop();
  return true;
}
