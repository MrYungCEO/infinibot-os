/**
 * Satellite setup for the local wizard: read a pairing invite, test it
 * against the master, and build the exact `federation` config block.
 *
 * Two invite formats exist and both are accepted:
 *   - Web/RPC (`federation.generateInvite`, the master's Federation page):
 *     plain base64 of `{v:1, hubUrl, hubUrls[], hubName, satelliteName, token, expiresAt}`.
 *   - CLI (`infinibot federation invite`): `infinibot-invite-v1:` + base64url of
 *     `{v:1, masterUrl, satelliteToken, satelliteName?, label?, expiresAt, iss}`.
 *
 * Pure except `probeMaster`, which opens one WebSocket.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import WebSocket from "ws";

import {
  decodeInvite,
  ExpiredInviteError,
  INVITE_PREFIX,
  InvalidInviteError,
} from "../federation/invite.js";
import { satelliteTokenFromConfig, type SatelliteToken } from "../federation/security.js";
import { normalizeShare, type FederationShare } from "../federation/share-policy.js";

export type PairingInvite = {
  format: "web" | "cli";
  /** Candidate master URLs, best first, each normalized to ws(s)://…/federation. */
  masterUrls: string[];
  token: SatelliteToken;
  hubName: string | null;
  satelliteName: string | null;
  expiresAt: number | null;
};

/** `host:port`, `http(s)://…` or `ws(s)://…` → `ws(s)://host:port/federation`. */
export function normalizeMasterUrl(raw: string): string {
  let u = raw.trim();
  if (!u) throw new Error("Enter the master's address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `ws://${u}`;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`"${raw.trim()}" is not a valid address.`);
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `Unsupported address scheme "${parsed.protocol}". Use ws://, wss://, http:// or https://.`,
    );
  }
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/federation";
  parsed.hash = "";
  return parsed.toString();
}

function uniqueUrls(urls: unknown[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || !u.trim()) continue;
    try {
      const n = normalizeMasterUrl(u);
      if (!out.includes(n)) out.push(n);
    } catch {
      /* skip unusable candidates */
    }
  }
  return out;
}

/** Decode either invite format. Throws a user-readable Error. */
export function parsePairingInvite(raw: string, now: number = Date.now()): PairingInvite {
  const input = raw.trim();
  if (!input) throw new Error("Paste the invite from your master.");

  if (input.startsWith(INVITE_PREFIX)) {
    try {
      const inv = decodeInvite(input, now);
      const token = satelliteTokenFromConfig(inv.satelliteToken);
      if (!token) throw new Error("This invite carries no usable token.");
      return {
        format: "cli",
        masterUrls: uniqueUrls([inv.masterUrl]),
        token,
        hubName: inv.label ?? inv.iss ?? null,
        satelliteName: inv.satelliteName ?? null,
        expiresAt: inv.expiresAt,
      };
    } catch (err) {
      if (err instanceof ExpiredInviteError)
        throw new Error("This invite has expired. Create a new one on the master.");
      if (err instanceof InvalidInviteError)
        throw new Error(`This invite can't be read: ${err.message}.`);
      throw err;
    }
  }

  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(Buffer.from(input, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(
      "That doesn't look like an InfiniBot invite. Copy the whole invite code from the master.",
    );
  }
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.v !== 1 ||
    typeof bundle.hubUrl !== "string"
  ) {
    throw new Error(
      "That doesn't look like an InfiniBot invite. Copy the whole invite code from the master.",
    );
  }
  const expiresAt = typeof bundle.expiresAt === "number" ? bundle.expiresAt : null;
  if (expiresAt !== null && expiresAt <= now) {
    throw new Error("This invite has expired. Create a new one on the master.");
  }
  const token = satelliteTokenFromConfig(bundle.token);
  if (!token) throw new Error("This invite carries no usable token.");
  const candidates = [bundle.hubUrl, ...(Array.isArray(bundle.hubUrls) ? bundle.hubUrls : [])];
  return {
    format: "web",
    masterUrls: uniqueUrls(candidates),
    token,
    hubName:
      typeof bundle.hubName === "string" && bundle.hubName.trim() ? bundle.hubName.trim() : null,
    satelliteName:
      typeof bundle.satelliteName === "string" && bundle.satelliteName.trim()
        ? bundle.satelliteName.trim().slice(0, 48)
        : null,
    expiresAt,
  };
}

export type SatelliteConfigInput = {
  masterUrl: string;
  token: SatelliteToken | null;
  nodeName: string;
  share: unknown;
  label?: string | null;
};

/**
 * The `federation` block a satellite runs with. Read at gateway start by
 * server-runtime-state (mode + masterUrl start the satellite; authToken is
 * presented on register; share gates what the master may use here).
 */
export function buildSatelliteConfig(input: SatelliteConfigInput): {
  enabled: true;
  mode: "satellite";
  masterUrl: string;
  nodeName: string;
  share: FederationShare;
  authToken?: SatelliteToken;
  label?: string;
} {
  const nodeName = input.nodeName.trim().slice(0, 48) || hostname();
  return {
    enabled: true,
    mode: "satellite",
    masterUrl: normalizeMasterUrl(input.masterUrl),
    nodeName,
    share: normalizeShare(input.share),
    ...(input.token ? { authToken: input.token } : {}),
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 80) } : {}),
  };
}

export type ProbeResult =
  | { ok: true; masterUrl: string; latencyMs: number; permission: string | null }
  | {
      ok: false;
      masterUrl: string;
      code:
        | "UNREACHABLE"
        | "UNAUTHORIZED"
        | "TOKEN_REQUIRED"
        | "NOT_A_MASTER"
        | "TIMEOUT"
        | "ERROR";
      error: string;
    };

/**
 * Register once with the master using the token, then disconnect. This is
 * exactly what the satellite will do at gateway start, so "it worked here"
 * means "it will work there". The master drops the probe node on close.
 */
export function probeMaster(
  masterUrl: string,
  token: SatelliteToken | null,
  opts: { timeoutMs?: number; nodeName?: string } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = Date.now();
  const nodeId = `setup-probe-${randomBytes(4).toString("hex")}`;
  return new Promise<ProbeResult>((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close(1000, "setup probe complete");
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          masterUrl,
          code: "TIMEOUT",
          error: `No answer from ${masterUrl} within ${Math.round(timeoutMs / 1000)}s. Check the address and that the master's gateway is running.`,
        }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(masterUrl, { handshakeTimeout: timeoutMs });
    } catch (err) {
      finish({
        ok: false,
        masterUrl,
        code: "ERROR",
        error: `Invalid master address: ${String((err as Error).message ?? err)}`,
      });
      return;
    }
    ws.on("unexpected-response", (_req, res) => {
      finish({
        ok: false,
        masterUrl,
        code: "NOT_A_MASTER",
        error: `${masterUrl} answered HTTP ${res.statusCode}, not a federation hub. Is that machine running in master mode?`,
      });
    });
    ws.on("error", (err) => {
      finish({
        ok: false,
        masterUrl,
        code: "UNREACHABLE",
        error: `Couldn't reach ${masterUrl} (${(err as NodeJS.ErrnoException).code ?? err.message}).`,
      });
    });
    ws.on("open", () => {
      const frame = {
        type: "node.register",
        nodeId,
        timestamp: Date.now(),
        messageId: `msg_${randomBytes(6).toString("hex")}`,
        payload: {
          protocolVersion: 1,
          ...(token ? { token } : {}),
          manifest: {
            id: nodeId,
            name: `${opts.nodeName?.trim() || hostname()} (setup check)`,
            hostname: hostname(),
            workspace: "",
            capabilities: {},
          },
        },
      };
      ws!.send(JSON.stringify(frame));
    });
    ws.on("message", (data) => {
      let msg: { type?: string; payload?: Record<string, unknown> };
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "node.register.ack") {
        if (msg.payload?.success === false) {
          finish({
            ok: false,
            masterUrl,
            code: "UNAUTHORIZED",
            error: textOf(msg.payload?.error, "The master refused this node."),
          });
          return;
        }
        finish({
          ok: true,
          masterUrl,
          latencyMs: Date.now() - started,
          permission: (token?.permissions as { level?: string } | undefined)?.level ?? null,
        });
        return;
      }
      if (msg.type === "error") {
        const code = textOf(msg.payload?.code, "");
        const message = textOf(msg.payload?.message, "The master refused the connection.");
        if (/token required|requires a valid registration token/i.test(message)) {
          finish({
            ok: false,
            masterUrl,
            code: "TOKEN_REQUIRED",
            error:
              "This master only accepts invited nodes. Create an invite on the master and paste it here.",
          });
        } else if (code === "UNAUTHORIZED" || /auth/i.test(message)) {
          finish({
            ok: false,
            masterUrl,
            code: "UNAUTHORIZED",
            error:
              "The master rejected this invite (expired, revoked, or issued by a different master). Create a new invite on the master.",
          });
        } else {
          finish({ ok: false, masterUrl, code: "ERROR", error: message });
        }
      }
    });
    ws.on("close", (code, reason) => {
      if (done) return;
      finish({
        ok: false,
        masterUrl,
        code: code === 1008 ? "UNAUTHORIZED" : "ERROR",
        error: `The master closed the connection${reason?.length ? `: ${String(reason)}` : ""}.`,
      });
    });
  });
}

function textOf(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

/** Try each candidate URL; return the first success, else the most useful failure. */
export async function probeFirstReachable(
  urls: string[],
  token: SatelliteToken | null,
  opts: { timeoutMs?: number; nodeName?: string } = {},
): Promise<ProbeResult & { tried: string[] }> {
  const tried: string[] = [];
  let best: ProbeResult | null = null;
  for (const url of urls) {
    tried.push(url);
    const r = await probeMaster(url, token, opts);
    if (r.ok) return { ...r, tried };
    // An auth answer means we reached the right master: stop and report it.
    if (r.code === "UNAUTHORIZED" || r.code === "TOKEN_REQUIRED") return { ...r, tried };
    if (!best || best.code === "UNREACHABLE") best = r;
  }
  return {
    ...(best ?? { ok: false, masterUrl: "", code: "ERROR", error: "No master address to try." }),
    tried,
  } as ProbeResult & { tried: string[] };
}
