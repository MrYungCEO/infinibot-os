/**
 * "Reach InfiniBot from anywhere": Tailscale + MagicDNS remote access for the
 * onboarding Phone step and Setup › Remote access.
 *
 * Detects every state a beginner can be in (not installed, daemon not running,
 * logged out, MagicDNS off, HTTPS certificates off, ready) and creates an
 * `https://<machine>.<tailnet>.ts.net[:port]` link for this gateway with
 * `tailscale serve`, WITHOUT touching anything already served:
 *
 * - `tailscale serve status --json` is read first. A mapping that already
 *   proxies "/" to this gateway's port is reused as-is.
 * - 443 is only used when nothing at all is served on it; otherwise the first
 *   free HTTPS port from 8443 upward is chosen (and the caller says so).
 * - Removal is per port (`serve --https=<p> off`) and refused unless that port
 *   proxies to this gateway. `serve reset` is never used here.
 *
 * Every shell-out goes through an injectable `exec` so the states can be unit
 * tested with stubbed CLI output (tailscale-remote.test.ts).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { runExec } from "../process/exec.js";
import { execWithSudoFallback, findTailscaleBinary } from "./tailscale.js";

export type ExecFn = typeof runExec;

export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_HTTPS_DOCS_URL = "https://tailscale.com/kb/1153/enabling-https";
export const TAILSCALE_MAGICDNS_DOCS_URL = "https://tailscale.com/kb/1081/magicdns";

/** Official download page for the OS the gateway runs on. */
export function tailscaleDownloadUrl(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "https://tailscale.com/download/windows";
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  if (platform === "linux") return "https://tailscale.com/download/linux";
  return "https://tailscale.com/download";
}

/** URLs the gateway is willing to open in the host's browser for this flow. */
export function isAllowedExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return h === "tailscale.com" || h === "login.tailscale.com" || h.endsWith(".ts.net");
}

export type ServeMapping = {
  /** "host:port" key from serve status (Web section). */
  hostPort: string;
  host: string;
  port: number;
  path: string;
  /** Proxy target, e.g. http://127.0.0.1:18789 (or a file/text handler label). */
  target: string;
  /** Public URL of this mapping. */
  url: string;
  funnel: boolean;
};

export type RemoteNextStep =
  | "install"
  | "start"
  | "login"
  | "approve"
  | "magicdns"
  | "https"
  | "create"
  | "ready";

export type RemoteStatus = {
  platform: NodeJS.Platform;
  installed: boolean;
  binary: string | null;
  /** tailscaled reachable. */
  running: boolean;
  backendState: string;
  loggedIn: boolean;
  authUrl: string | null;
  magicDns: boolean | null;
  httpsCerts: boolean | null;
  /** MagicDNS name without the trailing dot, e.g. box.tail1234.ts.net */
  dnsName: string | null;
  tailnet: string | null;
  account: string | null;
  gatewayPort: number;
  /** Every Web mapping currently served on this machine (read-only view). */
  mappings: ServeMapping[];
  /** The mapping that serves this gateway at "/", if any. */
  gatewayMapping: ServeMapping | null;
  /** The link saved for phone pairing (mobile.json remoteUrl), if any. */
  savedUrl: string | null;
  nextStep: RemoteNextStep;
  message: string;
  downloadUrl: string;
  adminDnsUrl: string;
  error?: string;
};

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function parseJsonLoose(stdout: string): Json {
  const t = stdout.trim();
  if (!t) return {};
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? t.slice(start, end + 1) : t) as Json;
}

function errText(err: unknown): string {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [e?.stderr, e?.stdout, e?.message]
    .map((x) => (typeof x === "string" ? x : Buffer.isBuffer(x) ? x.toString("utf8") : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function splitHostPort(key: string): { host: string; port: number } {
  const i = key.lastIndexOf(":");
  if (i < 0) return { host: key, port: 443 };
  const port = Number.parseInt(key.slice(i + 1), 10);
  return { host: key.slice(0, i), port: Number.isFinite(port) ? port : 443 };
}

export function httpsUrlFor(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** Flatten `tailscale serve status --json` into one row per path handler. */
export function parseServeMappings(serve: Json): ServeMapping[] {
  const web = obj(serve.Web) ?? {};
  const funnel = obj(serve.AllowFunnel) ?? {};
  const out: ServeMapping[] = [];
  for (const [hostPort, svc] of Object.entries(web)) {
    const { host, port } = splitHostPort(hostPort);
    const handlers = obj(obj(svc)?.Handlers) ?? {};
    for (const [path, h] of Object.entries(handlers)) {
      const handler = obj(h) ?? {};
      const target =
        str(handler.Proxy) ??
        (str(handler.Path) ? `path:${str(handler.Path)}` : str(handler.Text) ? "text" : "unknown");
      out.push({
        hostPort,
        host,
        port,
        path,
        target,
        url: httpsUrlFor(host, port) + (path === "/" ? "" : path),
        funnel: funnel[hostPort] === true,
      });
    }
  }
  return out.sort((a, b) => a.port - b.port || a.path.localeCompare(b.path));
}

/** Every TCP port serve/funnel has claimed (Web, TCP forwarders, funnel). */
export function usedServePorts(serve: Json): Set<number> {
  const used = new Set<number>();
  for (const k of Object.keys(obj(serve.TCP) ?? {})) {
    const n = Number.parseInt(k, 10);
    if (Number.isFinite(n)) used.add(n);
  }
  for (const k of [
    ...Object.keys(obj(serve.Web) ?? {}),
    ...Object.keys(obj(serve.AllowFunnel) ?? {}),
  ]) {
    used.add(splitHostPort(k).port);
  }
  return used;
}

/** Does `target` proxy to localhost:<port> (and nothing more specific than "/")? */
export function proxiesToPort(target: string, port: number): boolean {
  const m =
    /^(?:https?(?:\+insecure)?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)?:(\d+)(?:\/?$)/i.exec(
      target.trim(),
    );
  if (m) return Number(m[1]) === port;
  return target.trim() === String(port);
}

export function findGatewayMapping(
  mappings: ServeMapping[],
  gatewayPort: number,
): ServeMapping | null {
  return mappings.find((m) => m.path === "/" && proxiesToPort(m.target, gatewayPort)) ?? null;
}

export const HTTPS_PORT_CANDIDATES: readonly number[] = [
  8443,
  ...Array.from({ length: 56 }, (_, i) => 8444 + i),
];

/**
 * Where to serve this gateway. Reuse an existing mapping to it; else 443 when
 * nothing is on 443; else the first free candidate. Never a used port.
 */
export function chooseHttpsPort(
  serve: Json,
  gatewayPort: number,
): { port: number; reuse: ServeMapping | null; reason: string } {
  const mappings = parseServeMappings(serve);
  const reuse = findGatewayMapping(mappings, gatewayPort);
  if (reuse) return { port: reuse.port, reuse, reason: "already-served" };
  const used = usedServePorts(serve);
  if (!used.has(443)) return { port: 443, reuse: null, reason: "443-free" };
  const free = HTTPS_PORT_CANDIDATES.find((p) => !used.has(p));
  if (free === undefined)
    throw new Error("No free HTTPS port between 8443 and 8499 on this machine's Tailscale Serve.");
  return { port: free, reuse: null, reason: "443-taken" };
}

// ── saved link (mobile.json, shared with the Mobile page) ───────────────

function mobileConfigPath(): string {
  return join(resolveStateDir(), "mobile.json");
}

function readMobileJson(): Json {
  const p = mobileConfigPath();
  if (!existsSync(p)) return {};
  try {
    return obj(JSON.parse(readFileSync(p, "utf8"))) ?? {};
  } catch {
    return {};
  }
}

/** The https link created by this flow, if one is saved. */
export function readSavedRemoteUrl(): string | null {
  const v = str(readMobileJson().remoteUrl);
  return v && /^https:\/\//i.test(v) ? v.replace(/\/+$/, "") : null;
}

/**
 * Save the link as the phone pairing URL: `gatewayUrlOverride` (wss, used by
 * the pairing QR on the Mobile page and onboarding) + `remoteUrl` (https, used
 * by invite links). Pass null to clear both, but only if they still point at
 * `onlyIf` (so a hand-set override is never wiped).
 */
export function saveRemoteUrl(url: string | null, onlyIf?: string): void {
  const cfg = readMobileJson();
  if (url) {
    const u = new URL(url);
    cfg.remoteUrl = `https://${u.host}`;
    cfg.gatewayUrlOverride = `wss://${u.host}`;
  } else {
    const cur = str(cfg.remoteUrl);
    if (onlyIf && cur && cur.replace(/\/+$/, "") !== onlyIf.replace(/\/+$/, "")) return;
    const host = cur ? new URL(cur).host : null;
    delete cfg.remoteUrl;
    if (host && str(cfg.gatewayUrlOverride) === `wss://${host}`) delete cfg.gatewayUrlOverride;
  }
  const p = mobileConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

// ── status ───────────────────────────────────────────────────────────────

export type RemoteDeps = {
  exec: ExecFn;
  findBinary: () => Promise<string | null>;
  platform: NodeJS.Platform;
  savedUrl: () => string | null;
};

export function defaultRemoteDeps(): RemoteDeps {
  return {
    exec: runExec,
    findBinary: findTailscaleBinary,
    platform: process.platform,
    savedUrl: readSavedRemoteUrl,
  };
}

const DAEMON_DOWN =
  /failed to connect to local tailscale|tailscaled|connect: no such file|connection refused|is tailscale running|the system cannot find the file/i;

export async function readRemoteStatus(
  gatewayPort: number,
  deps: RemoteDeps = defaultRemoteDeps(),
): Promise<RemoteStatus> {
  const base: RemoteStatus = {
    platform: deps.platform,
    installed: false,
    binary: null,
    running: false,
    backendState: "NotInstalled",
    loggedIn: false,
    authUrl: null,
    magicDns: null,
    httpsCerts: null,
    dnsName: null,
    tailnet: null,
    account: null,
    gatewayPort,
    mappings: [],
    gatewayMapping: null,
    savedUrl: deps.savedUrl(),
    nextStep: "install",
    message: "Tailscale isn't installed on this computer yet.",
    downloadUrl: tailscaleDownloadUrl(deps.platform),
    adminDnsUrl: TAILSCALE_ADMIN_DNS_URL,
  };
  const binary = await deps.findBinary();
  if (!binary) return base;
  base.installed = true;
  base.binary = binary;

  let status: Json;
  try {
    const { stdout } = await deps.exec(binary, ["status", "--json"], {
      timeoutMs: 6_000,
      maxBuffer: 2_000_000,
    });
    status = parseJsonLoose(stdout);
  } catch (err) {
    // `tailscale status` exits 1 when logged out/stopped but still prints JSON.
    const e = err as { stdout?: unknown };
    const out = typeof e?.stdout === "string" ? e.stdout : "";
    try {
      status = out.trim().startsWith("{") ? parseJsonLoose(out) : {};
    } catch {
      status = {};
    }
    if (!str(status.BackendState)) {
      const detail = errText(err);
      return {
        ...base,
        backendState: "NotRunning",
        nextStep: "start",
        message: DAEMON_DOWN.test(detail)
          ? "Tailscale is installed but not running. Open the Tailscale app (or start the tailscaled service)."
          : "Tailscale is installed but didn't answer. Open the Tailscale app and try again.",
        error: detail.slice(0, 400) || undefined,
      };
    }
  }

  const backend = str(status.BackendState) ?? "Unknown";
  const self = obj(status.Self);
  const tailnetInfo = obj(status.CurrentTailnet);
  const dnsName = str(self?.DNSName)?.replace(/\.$/, "") ?? null;
  const certDomains = Array.isArray(status.CertDomains)
    ? (status.CertDomains as unknown[]).filter((d) => typeof d === "string" && d)
    : [];
  const magicDns =
    typeof tailnetInfo?.MagicDNSEnabled === "boolean"
      ? (tailnetInfo.MagicDNSEnabled as boolean)
      : dnsName
        ? true
        : null;
  const userId = self?.UserID;
  const users = obj(status.User);
  const account =
    str(tailnetInfo?.Name) ??
    (userId !== undefined ? str(obj(users?.[String(userId)])?.LoginName) : undefined) ??
    null;

  const out: RemoteStatus = {
    ...base,
    running: true,
    backendState: backend,
    loggedIn: backend === "Running" || backend === "Stopped" || backend === "Starting",
    authUrl: str(status.AuthURL) ?? null,
    magicDns,
    httpsCerts: backend === "Running" ? certDomains.length > 0 : null,
    dnsName,
    tailnet: str(status.MagicDNSSuffix) ?? str(tailnetInfo?.MagicDNSSuffix) ?? null,
    account,
  };

  if (backend === "NeedsLogin" || backend === "NoState") {
    return {
      ...out,
      loggedIn: false,
      nextStep: "login",
      message: "Sign in to Tailscale to continue.",
    };
  }
  if (backend === "NeedsMachineAuth") {
    return {
      ...out,
      nextStep: "approve",
      message: "This computer is waiting for approval in the Tailscale admin console (Machines).",
    };
  }
  if (backend === "Stopped") {
    return {
      ...out,
      nextStep: "login",
      message: "Tailscale is signed in but turned off. Turn it on to continue.",
    };
  }
  if (backend !== "Running") {
    return {
      ...out,
      nextStep: "start",
      message: `Tailscale is ${backend.toLowerCase()}. Give it a moment, then check again.`,
    };
  }

  try {
    const { stdout } = await deps.exec(binary, ["serve", "status", "--json"], {
      timeoutMs: 6_000,
      maxBuffer: 1_000_000,
    });
    const serve = parseJsonLoose(stdout);
    out.mappings = parseServeMappings(serve);
    out.gatewayMapping = findGatewayMapping(out.mappings, gatewayPort);
  } catch (err) {
    out.error = `Couldn't read tailscale serve status: ${errText(err).slice(0, 300)}`;
  }

  if (!out.magicDns) {
    return {
      ...out,
      nextStep: "magicdns",
      message: "MagicDNS is off for your tailnet. Turn it on in the Tailscale admin console.",
    };
  }
  if (!out.httpsCerts) {
    return {
      ...out,
      nextStep: "https",
      message:
        "HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin console (DNS page).",
    };
  }
  if (out.gatewayMapping) {
    return { ...out, nextStep: "ready", message: "Your private link is set up." };
  }
  return { ...out, nextStep: "create", message: "Tailscale is ready. Create your private link." };
}

// ── create / remove ──────────────────────────────────────────────────────

export type CreateResult = {
  url: string;
  httpsPort: number;
  reused: boolean;
  /** Plain-English note, e.g. "443 is used by something else, so…". */
  note: string | null;
  /** Mappings that existed before; identical after (checked). */
  preserved: number;
};

function mappingKey(m: ServeMapping): string {
  return `${m.hostPort} ${m.path} ${m.target} ${m.funnel}`;
}

export async function createRemoteLink(
  gatewayPort: number,
  deps: RemoteDeps = defaultRemoteDeps(),
): Promise<CreateResult> {
  const status = await readRemoteStatus(gatewayPort, deps);
  if (status.nextStep !== "create" && status.nextStep !== "ready") {
    throw new Error(status.message);
  }
  const binary = status.binary!;
  const host = status.dnsName;
  if (!host) throw new Error("This computer has no MagicDNS name yet.");

  const { stdout } = await deps.exec(binary, ["serve", "status", "--json"], {
    timeoutMs: 6_000,
    maxBuffer: 1_000_000,
  });
  const before = parseJsonLoose(stdout);
  const beforeKeys = parseServeMappings(before).map(mappingKey);
  const pick = chooseHttpsPort(before, gatewayPort);
  if (pick.reuse) {
    saveRemoteUrl(pick.reuse.url);
    return {
      url: httpsUrlFor(pick.reuse.host, pick.reuse.port),
      httpsPort: pick.port,
      reused: true,
      note: null,
      preserved: beforeKeys.length,
    };
  }

  await execWithSudoFallback(
    deps.exec,
    binary,
    ["serve", "--bg", "--yes", `--https=${pick.port}`, `http://127.0.0.1:${gatewayPort}`],
    { timeoutMs: 20_000, maxBuffer: 200_000 },
  );

  const afterRaw = await deps.exec(binary, ["serve", "status", "--json"], {
    timeoutMs: 6_000,
    maxBuffer: 1_000_000,
  });
  const after = parseServeMappings(parseJsonLoose(afterRaw.stdout));
  const afterKeys = new Set(after.map(mappingKey));
  const lost = beforeKeys.filter((k) => !afterKeys.has(k));
  if (lost.length) {
    throw new Error(
      `Tailscale changed existing mappings while adding the link (${lost.join("; ")}). Nothing else was touched by InfiniBot.`,
    );
  }
  const ours = after.find(
    (m) => m.port === pick.port && m.path === "/" && proxiesToPort(m.target, gatewayPort),
  );
  if (!ours)
    throw new Error(`tailscale serve ran but port ${pick.port} doesn't proxy to this gateway.`);
  const url = httpsUrlFor(ours.host, ours.port);
  saveRemoteUrl(url);
  return {
    url,
    httpsPort: pick.port,
    reused: false,
    note:
      pick.reason === "443-taken"
        ? `Port 443 is already used by something else on this computer, so InfiniBot uses port ${pick.port}. Your existing links are unchanged.`
        : null,
    preserved: beforeKeys.length,
  };
}

/** Remove ONLY the mapping on `httpsPort`, and only if it serves this gateway. */
export async function removeRemoteLink(
  gatewayPort: number,
  httpsPort: number,
  deps: RemoteDeps = defaultRemoteDeps(),
): Promise<{ removed: boolean; preserved: number }> {
  const binary = await deps.findBinary();
  if (!binary) throw new Error("Tailscale isn't installed.");
  const { stdout } = await deps.exec(binary, ["serve", "status", "--json"], {
    timeoutMs: 6_000,
    maxBuffer: 1_000_000,
  });
  const mappings = parseServeMappings(parseJsonLoose(stdout));
  const onPort = mappings.filter((m) => m.port === httpsPort);
  if (!onPort.length) {
    saveRemoteUrl(null);
    return { removed: false, preserved: mappings.length };
  }
  const onlyOurs =
    onPort.length === 1 && onPort[0]!.path === "/" && proxiesToPort(onPort[0]!.target, gatewayPort);
  if (!onlyOurs) {
    throw new Error(
      `Port ${httpsPort} serves something other than this gateway, so InfiniBot won't remove it.`,
    );
  }
  await execWithSudoFallback(deps.exec, binary, ["serve", `--https=${httpsPort}`, "off"], {
    timeoutMs: 20_000,
    maxBuffer: 200_000,
  });
  saveRemoteUrl(null, onPort[0]!.url);
  return { removed: true, preserved: mappings.length - 1 };
}

// ── sign in ──────────────────────────────────────────────────────────────

export type SpawnFn = (
  bin: string,
  args: string[],
) => {
  onOutput: (cb: (chunk: string) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
};

function defaultSpawn(bin: string, args: string[]): ReturnType<SpawnFn> {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: true,
  });
  return {
    onOutput: (cb) => {
      child.stdout?.on("data", (d: Buffer) => cb(d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => cb(d.toString("utf8")));
    },
    onExit: (cb) => {
      child.on("exit", (code) => cb(code));
      child.on("error", () => cb(-1));
    },
  };
}

export const AUTH_URL_RE = /https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+/;

/**
 * Start sign-in. Logged out → `tailscale login` (prints an auth URL and waits
 * for the browser); signed in but off → `tailscale up`. Resolves with the auth
 * URL as soon as one appears (output or status AuthURL), or `{connected}` when
 * the command finishes without needing one.
 */
export async function startTailscaleLogin(
  deps: RemoteDeps & { spawn?: SpawnFn; waitMs?: number } = defaultRemoteDeps(),
): Promise<{ authUrl: string | null; connected: boolean; output: string }> {
  const binary = await deps.findBinary();
  if (!binary) throw new Error("Tailscale isn't installed.");
  const status = await readRemoteStatus(0, deps);
  if (status.authUrl) return { authUrl: status.authUrl, connected: false, output: "" };
  if (status.backendState === "Running") return { authUrl: null, connected: true, output: "" };
  const args = status.backendState === "Stopped" ? ["up"] : ["login"];
  const proc = (deps.spawn ?? defaultSpawn)(binary, args);
  let output = "";
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v: { authUrl: string | null; connected: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...v, output: output.slice(-2000) });
    };
    proc.onOutput((chunk) => {
      output += chunk;
      const m = AUTH_URL_RE.exec(output);
      if (m) finish({ authUrl: m[0], connected: false });
    });
    proc.onExit((code) => {
      const m = AUTH_URL_RE.exec(output);
      finish({ authUrl: m?.[0] ?? null, connected: code === 0 && !m });
    });
    const timer = setTimeout(() => {
      void readRemoteStatus(0, deps)
        .then((s) => finish({ authUrl: s.authUrl, connected: s.backendState === "Running" }))
        .catch(() => finish({ authUrl: null, connected: false }));
    }, deps.waitMs ?? 12_000);
  });
}

// ── verify ───────────────────────────────────────────────────────────────

export type VerifyResult = {
  ok: boolean;
  url: string;
  ms: number;
  checks: Array<{ path: string; ok: boolean; status: number | null; detail: string }>;
};

/**
 * Prove the link answers: an InfiniBot public route (`/api/access/status`
 * returns `{"enabled":…}`) and the phone web app shell (`/mobile-web/`).
 */
export async function verifyRemoteLink(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<VerifyResult> {
  const base = url.replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+\.ts\.net(:\d+)?$/i.test(base))
    throw new Error("Only https://*.ts.net links can be checked.");
  const t0 = Date.now();
  const probe = async (path: string, accept: (status: number, body: string) => boolean) => {
    try {
      const res = await fetchImpl(base + path, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      const body = await res.text().catch(() => "");
      const ok = accept(res.status, body);
      return {
        path,
        ok,
        status: res.status,
        detail: ok ? "answered" : `unexpected reply (${res.status})`,
      };
    } catch (err) {
      return {
        path,
        ok: false,
        status: null,
        detail: String((err as Error)?.message ?? err).slice(0, 200),
      };
    }
  };
  const checks = [
    await probe("/api/access/status", (s, b) => s === 200 && /"enabled"\s*:/.test(b)),
    await probe("/mobile-web/", (s, b) => s === 200 && /<html/i.test(b)),
  ];
  return { ok: checks.every((c) => c.ok), url: base, ms: Date.now() - t0, checks };
}
