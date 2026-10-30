/**
 * One-click "Add InfiniBot MCP" for desktop AI apps.
 *
 * Detects Claude Code, Claude Desktop, Cursor, Codex and VS Code, and writes
 * an `infinibot` stdio server into each app's own MCP config:
 *
 *   - backs the file up first (`<file>.infinibot-backup-<stamp>`),
 *   - merges: only our own `infinibot` key is touched, every other server and
 *     top-level setting is kept byte-for-byte in meaning,
 *   - refuses to touch a file it can't parse (no clobbering a hand-edited
 *     config), and writes atomically (temp file + rename, mode kept),
 *   - never writes the gateway password/token: the entry carries only the
 *     gateway URL and `INFINIBOT_MCP_AUTH=config`, and `mcp-stdio` reads the
 *     credential from the InfiniBot config at start-up. Nothing secret ends
 *     up in another app's config, in our logs, or in RPC responses.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepoRoot } from "../config/paths.js";

export const MCP_SERVER_KEY = "infinibot";
/** Marks an entry whose credential is resolved from the InfiniBot config. */
export const MCP_AUTH_FROM_CONFIG_ENV = "INFINIBOT_MCP_AUTH";

export type McpClientId = "claude-code" | "claude-desktop" | "cursor" | "codex" | "vscode";

export const MCP_CLIENT_IDS: readonly McpClientId[] = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "vscode",
];

type ConfigFormat = "json-mcpServers" | "json-servers" | "toml-codex";

export type McpClientDef = {
  id: McpClientId;
  name: string;
  format: ConfigFormat;
  /** Primary config file the entry is written to. */
  configPath: string;
  /** Folders/binaries whose presence means the app is installed. */
  markers: string[];
  bins: string[];
  /** Short "how to see it" note shown after adding. */
  after: string;
};

export type McpEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type McpClientStatus = {
  id: McpClientId;
  name: string;
  detected: boolean;
  configPath: string;
  configExists: boolean;
  /** An `infinibot` entry is already present. */
  configured: boolean;
  /** Present entry points at this install's mcp-stdio. */
  current: boolean;
  /** Present entry embeds a gateway secret (older auto-register). */
  embedsSecret: boolean;
  /** Config exists but can't be parsed; one-click is disabled for it. */
  unreadable?: string;
  after: string;
};

export type McpClientAddResult = {
  id: McpClientId;
  configPath: string;
  changed: boolean;
  backupPath?: string;
  created: boolean;
};

export type ClientSetupEnv = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Override binary detection (tests). */
  which?: (bin: string) => boolean;
};

function homeOf(opts?: ClientSetupEnv): string {
  return opts?.home ?? opts?.env?.HOME ?? os.homedir();
}

function appDataDir(opts?: ClientSetupEnv): string {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const home = homeOf(opts);
  if (platform === "win32") return env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  return env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
}

export function mcpClientDefs(opts?: ClientSetupEnv): McpClientDef[] {
  const home = homeOf(opts);
  const appData = appDataDir(opts);
  const join = (opts?.platform ?? process.platform) === "win32" ? path.win32.join : path.join;
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      format: "json-mcpServers",
      configPath: join(home, ".claude.json"),
      markers: [join(home, ".claude"), join(home, ".claude.json")],
      bins: ["claude"],
      after: "Start a new `claude` session and run /mcp to see infinibot.",
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      format: "json-mcpServers",
      configPath: join(appData, "Claude", "claude_desktop_config.json"),
      markers: [join(appData, "Claude")],
      bins: [],
      after: "Quit and reopen Claude Desktop; InfiniBot appears under the tools menu.",
    },
    {
      id: "cursor",
      name: "Cursor",
      format: "json-mcpServers",
      configPath: join(home, ".cursor", "mcp.json"),
      markers: [join(home, ".cursor")],
      bins: ["cursor"],
      after: "Open Cursor → Settings → MCP; infinibot is listed (toggle it on if needed).",
    },
    {
      id: "codex",
      name: "Codex",
      format: "toml-codex",
      configPath: join(home, ".codex", "config.toml"),
      markers: [join(home, ".codex")],
      bins: ["codex"],
      after: "Start a new `codex` session; run /mcp to see infinibot.",
    },
    {
      id: "vscode",
      name: "VS Code",
      format: "json-servers",
      configPath: join(appData, "Code", "User", "mcp.json"),
      markers: [join(appData, "Code", "User")],
      bins: ["code"],
      after: "In VS Code run “MCP: List Servers” and start infinibot (Copilot agent mode).",
    },
  ];
}

function defaultWhich(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(cmd, [bin], { stdio: "ignore", timeout: 2_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ── entry ───────────────────────────────────────────────────────────────────

/** Absolute path of this install's `dist/cli/mcp-stdio.js`. */
export function resolveMcpStdioEntry(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  const add = (p: string) => {
    if (!candidates.includes(p)) candidates.push(p);
  };
  add(path.join(resolveRepoRoot(env), "dist", "cli", "mcp-stdio.js"));
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
      add(path.join(dir, "dist", "cli", "mcp-stdio.js"));
      add(path.join(dir, "cli", "mcp-stdio.js"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* non-file module URL */
  }
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

/**
 * The stdio entry every client gets. No secrets: `mcp-stdio` resolves the
 * gateway credential from the InfiniBot config (INFINIBOT_STATE_DIR) itself.
 */
export function buildMcpClientEntry(opts: {
  gatewayUrl: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  entryPath?: string;
  electron?: boolean;
}): McpEntry {
  const env = opts.env ?? process.env;
  const out: Record<string, string> = {
    MOLTBOT_GATEWAY_URL: opts.gatewayUrl,
    [MCP_AUTH_FROM_CONFIG_ENV]: "config",
  };
  const stateDir = env.INFINIBOT_STATE_DIR?.trim();
  if (stateDir) out.INFINIBOT_STATE_DIR = stateDir;
  // Packaged desktop app: the "node" binary is the Electron executable.
  const electron = opts.electron ?? Boolean(process.versions.electron || env.ELECTRON_RUN_AS_NODE);
  if (electron) out.ELECTRON_RUN_AS_NODE = "1";
  return {
    command: opts.execPath ?? process.execPath,
    args: [opts.entryPath ?? resolveMcpStdioEntry(env)],
    env: out,
  };
}

const SECRET_ENV_RE = /(TOKEN|PASSWORD|SECRET|API_KEY|APIKEY|AUTH_KEY)$/i;

/** Copy of an entry/config fragment with every secret-looking env value masked. */
export function redactMcpEntry<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && SECRET_ENV_RE.test(key) && v) return "••••••";
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

function entryForFormat(def: McpClientDef, entry: McpEntry): Record<string, unknown> {
  // Claude Code and VS Code want an explicit transport type.
  if (def.id === "claude-code" || def.id === "vscode") return { type: "stdio", ...entry };
  return { ...entry };
}

// ── JSON configs ────────────────────────────────────────────────────────────

/** JSON with // and /* comments and trailing commas (VS Code style). */
export function parseJsonc(raw: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

type ReadResult =
  | { ok: true; exists: boolean; raw: string; data: Record<string, unknown> }
  | { ok: false; exists: true; error: string };

function readJsonConfig(file: string, jsonc: boolean): ReadResult {
  if (!fs.existsSync(file)) return { ok: true, exists: false, raw: "", data: {} };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { ok: true, exists: true, raw, data: {} };
  try {
    const parsed = jsonc ? parseJsonc(raw) : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, exists: true, error: "top level is not a JSON object" };
    }
    return { ok: true, exists: true, raw, data: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      exists: true,
      error: `not valid JSON (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    };
  }
}

function serversKey(def: McpClientDef): "mcpServers" | "servers" {
  return def.format === "json-servers" ? "servers" : "mcpServers";
}

// ── Codex TOML ──────────────────────────────────────────────────────────────

const CODEX_TABLE = `mcp_servers.${MCP_SERVER_KEY}`;

function isOurCodexHeader(line: string): boolean {
  const m = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  if (!m) return false;
  const name = m[1]!.replace(/"/g, "");
  return name === CODEX_TABLE || name.startsWith(`${CODEX_TABLE}.`);
}

function isAnyTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line);
}

/** Remove our `[mcp_servers.infinibot]` (+ sub-tables) and return the rest. */
export function stripCodexEntry(raw: string): { text: string; had: boolean } {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  let had = false;
  for (const line of lines) {
    if (isAnyTableHeader(line)) {
      skipping = isOurCodexHeader(line);
      if (skipping) {
        had = true;
        continue;
      }
    }
    if (!skipping) out.push(line);
  }
  return { text: out.join("\n").replace(/\n{3,}$/g, "\n\n"), had };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexBlock(entry: McpEntry): string {
  const lines = [
    `[${CODEX_TABLE}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    "",
    `[${CODEX_TABLE}.env]`,
    ...Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`),
  ];
  return `${lines.join("\n")}\n`;
}

function readCodexEntry(raw: string): { present: boolean; text: string } {
  const lines = raw.split(/\r?\n/);
  let inside = false;
  const mine: string[] = [];
  for (const line of lines) {
    if (isAnyTableHeader(line)) inside = isOurCodexHeader(line);
    if (inside) mine.push(line);
  }
  return { present: mine.length > 0, text: mine.join("\n") };
}

// ── status / add ────────────────────────────────────────────────────────────

function entryPointsAt(existing: unknown, expected: McpEntry): boolean {
  if (!existing || typeof existing !== "object") return false;
  const e = existing as { command?: unknown; args?: unknown };
  const args = Array.isArray(e.args) ? e.args : [];
  return args.includes(expected.args[0]);
}

function embedsSecret(existing: unknown): boolean {
  if (!existing || typeof existing !== "object") return false;
  const env = (existing as { env?: unknown }).env;
  if (!env || typeof env !== "object") return false;
  return Object.entries(env as Record<string, unknown>).some(
    ([k, v]) => SECRET_ENV_RE.test(k) && typeof v === "string" && v.length > 0,
  );
}

export function mcpClientStatus(
  def: McpClientDef,
  expected: McpEntry,
  opts?: ClientSetupEnv,
): McpClientStatus {
  const which = opts?.which ?? defaultWhich;
  const detected = def.markers.some((m) => fs.existsSync(m)) || def.bins.some((b) => which(b));
  const base: McpClientStatus = {
    id: def.id,
    name: def.name,
    detected,
    configPath: def.configPath,
    configExists: fs.existsSync(def.configPath),
    configured: false,
    current: false,
    embedsSecret: false,
    after: def.after,
  };
  try {
    if (def.format === "toml-codex") {
      if (!base.configExists) return base;
      const raw = fs.readFileSync(def.configPath, "utf8");
      const found = readCodexEntry(raw);
      return {
        ...base,
        configured: found.present,
        current: found.present && found.text.includes(JSON.stringify(expected.args[0])),
        embedsSecret: /(TOKEN|PASSWORD)\s*=\s*"[^"]+"/.test(found.text),
      };
    }
    const read = readJsonConfig(def.configPath, def.format === "json-servers");
    if (!read.ok) return { ...base, unreadable: read.error };
    const servers = read.data[serversKey(def)];
    const existing =
      servers && typeof servers === "object" && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)[MCP_SERVER_KEY]
        : undefined;
    return {
      ...base,
      configured: existing !== undefined,
      current: entryPointsAt(existing, expected),
      embedsSecret: embedsSecret(existing),
    };
  } catch (err) {
    return { ...base, unreadable: err instanceof Error ? err.message : String(err) };
  }
}

function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = `${file}.infinibot-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

function backup(file: string, now?: Date): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const dest = `${file}.infinibot-backup-${backupStamp(now)}`;
  fs.copyFileSync(file, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* windows */
  }
  return dest;
}

/**
 * Upsert the `infinibot` server in one client's config. Throws (without
 * touching the file) when the existing config can't be parsed.
 */
export function addInfinibotToClient(
  def: McpClientDef,
  entry: McpEntry,
  opts?: { now?: Date },
): McpClientAddResult {
  const file = def.configPath;
  if (def.format === "toml-codex") {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const stripped = stripCodexEntry(raw);
    const body = stripped.text.trimEnd();
    const next = `${body ? `${body}\n\n` : ""}${codexBlock(entry)}`;
    if (next === raw) return { id: def.id, configPath: file, changed: false, created: false };
    const backupPath = backup(file, opts?.now);
    atomicWrite(file, next);
    return { id: def.id, configPath: file, changed: true, backupPath, created: !raw };
  }
  const read = readJsonConfig(file, def.format === "json-servers");
  if (!read.ok) {
    throw new Error(
      `${def.name} config at ${file} is ${read.error}; not changing it. Use the copy-paste config instead.`,
    );
  }
  const key = serversKey(def);
  const current = read.data[key];
  if (current !== undefined && (typeof current !== "object" || Array.isArray(current))) {
    throw new Error(`${def.name} config "${key}" is not an object; not changing it.`);
  }
  const servers = { ...(current as Record<string, unknown> | undefined) };
  const value = entryForFormat(def, entry);
  if (JSON.stringify(servers[MCP_SERVER_KEY]) === JSON.stringify(value)) {
    return { id: def.id, configPath: file, changed: false, created: false };
  }
  servers[MCP_SERVER_KEY] = value;
  const next = { ...read.data, [key]: servers };
  const backupPath = backup(file, opts?.now);
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  return { id: def.id, configPath: file, changed: true, backupPath, created: !read.exists };
}

/** Copy-paste text for a client (or the generic mcpServers JSON). */
export function mcpClientSnippet(id: McpClientId | "generic", entry: McpEntry): string {
  if (id === "codex") return codexBlock(entry);
  if (id === "vscode") {
    return `${JSON.stringify({ servers: { [MCP_SERVER_KEY]: { type: "stdio", ...entry } } }, null, 2)}\n`;
  }
  if (id === "claude-code") {
    const envFlags = Object.entries(entry.env)
      .map(([k, v]) => `-e ${k}=${shellQuote(v)}`)
      .join(" ");
    return `claude mcp add --scope user ${envFlags} ${MCP_SERVER_KEY} -- ${[entry.command, ...entry.args].map(shellQuote).join(" ")}\n`;
  }
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2)}\n`;
}

function shellQuote(v: string): string {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}
