import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveStateDir } from "../config/paths.js";
import { isSaasMode } from "../saas/config.js";
import { resolveTmuxSocketName } from "../terminal/tmux-socket.js";
import { detectWorkspace, planWorkspaceCommand } from "./detector.js";
import { detectPortConflict, findFreePort } from "./ports.js";
import type { WorkspaceDetection, WorkspaceServerRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export type DevServerManagerDeps = {
  runTmux: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  hasSession: (sessionId: string) => Promise<boolean>;
  killSession: (sessionId: string) => Promise<void>;
  probePort: (port: number) => Promise<boolean>;
  /**
   * Pick a free port at or above `preferred`, never returning a port in
   * `exclude` (ports held by other workspace runtimes or that already failed).
   */
  findPort: (preferred: number, exclude: ReadonlySet<number>) => Promise<number>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearSchedule: (id: NodeJS.Timeout | number) => void;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sessionName(directoryId: string): string {
  return `workspace_${directoryId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48)}`;
}

function defaultDeps(stateDir: string): DevServerManagerDeps {
  const socket = resolveTmuxSocketName(stateDir);
  const tmux = (args: string[]) =>
    execFileAsync("tmux", ["-L", socket, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  return {
    runTmux: tmux,
    async hasSession(id) {
      try {
        await tmux(["has-session", "-t", id]);
        return true;
      } catch {
        return false;
      }
    },
    async killSession(id) {
      try {
        await tmux(["kill-session", "-t", id]);
      } catch {}
    },
    probePort: (port) =>
      new Promise((resolve) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        const done = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(350);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
      }),
    // Bind-probes loopback AND wildcard (v4 + v6): a port held on a single
    // interface (e.g. `tailscale serve` on 100.x:8081) still breaks dev
    // servers that listen on all interfaces, such as Expo/Metro.
    findPort: (preferred, exclude) => findFreePort(preferred, { exclude }),
    now: Date.now,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearSchedule: (id) => clearTimeout(id as NodeJS.Timeout),
  };
}

function resolveNodeBin(versionHint: string | null): string | null {
  const base = path.join(os.homedir(), ".nvm", "versions", "node");
  let versions: string[] = [];
  try {
    versions = fs
      .readdirSync(base)
      .filter((name) => fs.existsSync(path.join(base, name, "bin", "node")));
  } catch {
    return null;
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const major = versionHint?.match(/(?:^|[^0-9])(\d{2})(?:\.|\D|$)/)?.[1];
  const selected =
    (major ? versions.find((item) => item.replace(/^v/, "").startsWith(`${major}.`)) : null) ??
    versions.find((item) => item.replace(/^v/, "").startsWith("22.")) ??
    versions[0];
  return selected ? path.join(base, selected, "bin") : null;
}

function ensureHostExecutionAllowed(projectPath: string): void {
  if (!isSaasMode()) return;
  const sandboxRoot = process.env.INFINIBOT_WORKSPACE_SANDBOX_ROOT?.trim();
  if (!sandboxRoot)
    throw new Error(
      "Workspace dev servers are disabled in SaaS/cloud mode without a tenant sandbox",
    );
  const root = path.resolve(sandboxRoot);
  const target = path.resolve(projectPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Project directory is outside the configured tenant sandbox");
  }
}

export class WorkspaceDevServerManager {
  private readonly stateFile: string;
  private readonly logDir: string;
  private readonly deps: DevServerManagerDeps;
  private readonly records = new Map<string, WorkspaceServerRecord>();
  private readonly monitors = new Map<string, NodeJS.Timeout | number>();
  private readonly maxServers: number;
  private readonly defaultIdleMs: number;
  private readonly maxPortAttempts: number;
  private readonly preferredPort: ((detection: WorkspaceDetection) => number) | null;
  /** Ports chosen by an in-flight launch that has not been recorded yet. */
  private readonly reservedPorts = new Set<number>();

  constructor(
    opts: {
      stateDir?: string;
      deps?: Partial<DevServerManagerDeps>;
      maxServers?: number;
      idleTimeoutMs?: number;
      /** Total launch attempts when the dev server reports a port conflict. */
      maxPortAttempts?: number;
      /** Override the framework-default preferred port (tests). */
      preferredPort?: (detection: WorkspaceDetection) => number;
    } = {},
  ) {
    const stateDir = opts.stateDir ?? resolveStateDir();
    this.stateFile = path.join(stateDir, "workspace-dev-servers.json");
    this.logDir = path.join(stateDir, "workspace-dev-logs");
    fs.mkdirSync(this.logDir, { recursive: true });
    this.deps = { ...defaultDeps(stateDir), ...opts.deps };
    this.maxServers = opts.maxServers ?? Number(process.env.INFINIBOT_WORKSPACE_MAX_SERVERS || 4);
    this.defaultIdleMs =
      opts.idleTimeoutMs ?? Number(process.env.INFINIBOT_WORKSPACE_IDLE_MS || 30 * 60_000);
    this.maxPortAttempts = Math.max(1, opts.maxPortAttempts ?? 4);
    this.preferredPort = opts.preferredPort ?? null;
    this.load();
  }

  private load(): void {
    try {
      const rows = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as WorkspaceServerRecord[];
      for (const row of rows) this.records.set(row.directoryId, row);
    } catch {}
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify([...this.records.values()], null, 2));
    fs.renameSync(temp, this.stateFile);
  }

  detect(projectPath: string, directoryId: string, appPath?: string): WorkspaceDetection {
    return detectWorkspace(projectPath, {
      appPath,
      previewPrefix: `/api/workspace/dev/${encodeURIComponent(directoryId)}/`,
    });
  }

  get(directoryId: string): WorkspaceServerRecord | null {
    return this.records.get(directoryId) ?? null;
  }

  list(): WorkspaceServerRecord[] {
    return [...this.records.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  touch(directoryId: string): void {
    const record = this.records.get(directoryId);
    if (!record) return;
    record.lastAccessAt = this.deps.now();
    this.persist();
  }

  async reconcile(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.status === "stopped") continue;
      // A port conflict must be checked before readiness: when another
      // process owns the port, the TCP readiness probe would connect to IT
      // and wrongly mark the preview ready.
      if (
        (record.status === "starting" || record.status === "installing") &&
        this.portConflictIn(record) !== null
      ) {
        await this.retryAfterPortConflict(record);
        continue;
      }
      const live = await this.deps.hasSession(record.sessionId);
      const portReady = record.port ? await this.deps.probePort(record.port) : false;
      if (portReady) {
        record.status = "ready";
        record.readyAt ??= this.deps.now();
        record.error = null;
      } else if (!live) {
        record.status = "error";
        record.error = this.lastError(record.logPath) || "Dev server exited before becoming ready";
      }
      if (
        record.status === "ready" &&
        this.deps.now() - record.lastAccessAt >= record.idleTimeoutMs
      ) {
        await this.stop(record.directoryId, "Stopped after idle timeout");
      }
    }
    this.persist();
  }

  private scheduleMonitor(directoryId: string): void {
    const previous = this.monitors.get(directoryId);
    if (previous) this.deps.clearSchedule(previous);
    const tick = async () => {
      this.monitors.delete(directoryId);
      await this.reconcile();
      const record = this.records.get(directoryId);
      if (record && ["installing", "starting", "ready"].includes(record.status)) {
        this.monitors.set(
          directoryId,
          this.deps.schedule(() => void tick(), record.status === "ready" ? 30_000 : 800),
        );
      }
    };
    this.monitors.set(
      directoryId,
      this.deps.schedule(() => void tick(), 100),
    );
  }

  private commandScript(
    command: { command: string; args: string[]; env: Record<string, string> },
    logPath: string,
    nodeBin: string | null,
  ): string {
    let executable = command.command;
    let args = [...command.args];
    if (args[0] === "__INFINIBOT_STATIC_SERVER__") {
      executable = process.execPath;
      args = [fileURLToPath(new URL("./static-server.js", import.meta.url)), ...args.slice(1)];
    }
    const env = { ...command.env };
    if (nodeBin) env.PATH = `${nodeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    const envPart = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    return `ulimit -n 1024; exec ${envPart ? `env ${envPart} ` : ""}nice -n 5 ${shellQuote(executable)} ${args.map(shellQuote).join(" ")} >> ${shellQuote(logPath)} 2>&1`;
  }

  async start(params: {
    directoryId: string;
    projectPath: string;
    appPath?: string;
    install?: boolean;
    idleTimeoutMs?: number;
  }): Promise<{ record: WorkspaceServerRecord; detection: WorkspaceDetection }> {
    ensureHostExecutionAllowed(params.projectPath);
    const existing = this.records.get(params.directoryId);
    if (
      existing &&
      existing.status !== "stopped" &&
      (await this.deps.hasSession(existing.sessionId))
    ) {
      this.touch(params.directoryId);
      return {
        record: existing,
        detection: this.detect(params.projectPath, params.directoryId, params.appPath),
      };
    }
    const running = [...this.records.values()].filter(
      (item) => !["stopped", "error"].includes(item.status),
    );
    if (running.length >= this.maxServers)
      throw new Error(
        `Workspace dev-server limit reached (${this.maxServers}); stop one before starting another`,
      );
    const initial = this.detect(params.projectPath, params.directoryId, params.appPath);
    if (initial.kind === "unknown" || !initial.command)
      throw new Error("Could not determine how to start this project");
    if (initial.missingDependencies && !params.install)
      throw new Error(
        `Dependencies are missing. Run ${initial.installCmd ?? "the project install command"} first.`,
      );
    return this.launch(params, initial, { priorAttempts: [], install: params.install === true });
  }

  /** Ports held by other live workspace runtimes plus in-flight reservations. */
  private allocatedPorts(exceptDirectoryId: string): Set<number> {
    const ports = new Set(this.reservedPorts);
    for (const row of this.records.values()) {
      if (row.directoryId === exceptDirectoryId || row.port == null) continue;
      if (["installing", "starting", "ready"].includes(row.status)) ports.add(row.port);
    }
    return ports;
  }

  private async launch(
    params: { directoryId: string; projectPath: string; idleTimeoutMs?: number },
    initial: WorkspaceDetection,
    ctx: { priorAttempts: number[]; install: boolean },
  ): Promise<{ record: WorkspaceServerRecord; detection: WorkspaceDetection }> {
    const exclude = this.allocatedPorts(params.directoryId);
    for (const port of ctx.priorAttempts) exclude.add(port);
    const preferred = this.preferredPort?.(initial) ?? initial.expectedPort;
    const port = await this.deps.findPort(preferred, exclude);
    this.reservedPorts.add(port);
    try {
      return await this.launchOnPort(params, initial, ctx, port);
    } finally {
      this.reservedPorts.delete(port);
    }
  }

  private async launchOnPort(
    params: { directoryId: string; projectPath: string; idleTimeoutMs?: number },
    initial: WorkspaceDetection,
    ctx: { priorAttempts: number[]; install: boolean },
    port: number,
  ): Promise<{ record: WorkspaceServerRecord; detection: WorkspaceDetection }> {
    const detection = detectWorkspace(params.projectPath, {
      appPath: initial.appPath,
      port,
      previewPrefix: `/api/workspace/dev/${encodeURIComponent(params.directoryId)}/`,
    });
    const command = planWorkspaceCommand(
      detection,
      port,
      `/api/workspace/dev/${encodeURIComponent(params.directoryId)}/`,
    );
    if (!command) throw new Error("No runnable development command was detected");
    const id = sessionName(params.directoryId);
    const logPath = path.join(this.logDir, `${id}.log`);
    const attempt = ctx.priorAttempts.length + 1;
    const header = `# ${new Date().toISOString()} ${command.display}${attempt > 1 ? ` (attempt ${attempt}/${this.maxPortAttempts}, port ${port})` : ""}\n`;
    if (attempt > 1) fs.appendFileSync(logPath, header);
    else fs.writeFileSync(logPath, header);
    const logOffset = fs.statSync(logPath).size;
    const nodeBin = resolveNodeBin(detection.nodeVersion);
    let script = this.commandScript(command, logPath, nodeBin);
    let status: WorkspaceServerRecord["status"] = "starting";
    if (ctx.install && detection.missingDependencies && detection.installCmd) {
      status = "installing";
      const install = `${detection.installCmd} >> ${shellQuote(logPath)} 2>&1`;
      script = `${nodeBin ? `export PATH=${shellQuote(`${nodeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`)}; ` : ""}${install} && ${script}`;
    }
    await this.deps.runTmux([
      "new-session",
      "-d",
      "-s",
      id,
      "-c",
      detection.appPath,
      "bash",
      "-lc",
      script,
    ]);
    const now = this.deps.now();
    const record: WorkspaceServerRecord = {
      directoryId: params.directoryId,
      projectPath: path.resolve(params.projectPath),
      appPath: detection.appPath,
      kind: detection.kind,
      status,
      port,
      previewPath: `/api/workspace/dev/${encodeURIComponent(params.directoryId)}/`,
      sessionId: id,
      logPath,
      command: command.display,
      startedAt: now,
      readyAt: null,
      lastAccessAt: now,
      idleTimeoutMs: params.idleTimeoutMs ?? this.defaultIdleMs,
      error: null,
      portAttempts: [...ctx.priorAttempts, port],
      logOffset,
    };
    this.records.set(params.directoryId, record);
    this.persist();
    this.scheduleMonitor(params.directoryId);
    return { record, detection };
  }

  /** Port-conflict message in the current attempt's output, if any. */
  private portConflictIn(record: WorkspaceServerRecord): number | null {
    try {
      const text = fs.readFileSync(record.logPath, "utf8");
      return detectPortConflict(text.slice(record.logOffset ?? 0));
    } catch {
      return null;
    }
  }

  /**
   * The dev server said its port is taken (race with another process, or a
   * holder our bind probe could not see). Relaunch on a new free port,
   * excluding every port already tried, up to `maxPortAttempts` launches.
   */
  private async retryAfterPortConflict(record: WorkspaceServerRecord): Promise<void> {
    const attempts = record.portAttempts?.length
      ? [...record.portAttempts]
      : record.port != null
        ? [record.port]
        : [];
    const reported = this.portConflictIn(record);
    if (reported && !attempts.includes(reported)) attempts.push(reported);
    const failedPort = record.port ?? reported ?? 0;
    const monitor = this.monitors.get(record.directoryId);
    if (monitor) this.deps.clearSchedule(monitor);
    this.monitors.delete(record.directoryId);
    await this.deps.killSession(record.sessionId);
    const launches = record.portAttempts?.length ?? 1;
    if (launches >= this.maxPortAttempts) {
      const message = `Port conflict: tried ${attempts.join(", ")}; giving up after ${launches} attempts`;
      try {
        fs.appendFileSync(record.logPath, `# ${message}\n`);
      } catch {}
      record.status = "error";
      record.error = `${message}\n${this.lastError(record.logPath)}`;
      this.persist();
      return;
    }
    try {
      fs.appendFileSync(
        record.logPath,
        `# port ${failedPort} is in use (reported by the dev server); retrying on a new port (attempt ${launches + 1}/${this.maxPortAttempts})\n`,
      );
    } catch {}
    try {
      const initial = this.detect(record.projectPath, record.directoryId, record.appPath);
      await this.launch(
        {
          directoryId: record.directoryId,
          projectPath: record.projectPath,
          idleTimeoutMs: record.idleTimeoutMs,
        },
        initial,
        { priorAttempts: attempts, install: false },
      );
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      this.persist();
    }
  }

  async stop(
    directoryId: string,
    reason = "Stopped by operator",
  ): Promise<WorkspaceServerRecord | null> {
    const record = this.records.get(directoryId);
    if (!record) return null;
    const monitor = this.monitors.get(directoryId);
    if (monitor) this.deps.clearSchedule(monitor);
    this.monitors.delete(directoryId);
    await this.deps.killSession(record.sessionId);
    record.status = "stopped";
    record.error = reason;
    record.port = null;
    record.previewPath = null;
    this.persist();
    return record;
  }

  async restart(params: {
    directoryId: string;
    projectPath: string;
    appPath?: string;
    install?: boolean;
    idleTimeoutMs?: number;
  }) {
    await this.stop(params.directoryId, "Restarting");
    return this.start(params);
  }

  async stopAll(): Promise<WorkspaceServerRecord[]> {
    const stopped: WorkspaceServerRecord[] = [];
    for (const row of this.records.values()) {
      if (row.status === "stopped") continue;
      const result = await this.stop(row.directoryId, "Stopped by operator (all)");
      if (result) stopped.push(result);
    }
    return stopped;
  }

  logs(
    directoryId: string,
    cursor = 0,
    limit = 64 * 1024,
  ): { text: string; cursor: number; truncated: boolean } {
    const record = this.records.get(directoryId);
    if (!record) return { text: "", cursor: 0, truncated: false };
    try {
      const stat = fs.statSync(record.logPath);
      const start = Math.max(0, Math.min(cursor, stat.size));
      const length = Math.min(limit, stat.size - start);
      const fd = fs.openSync(record.logPath, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      fs.closeSync(fd);
      return {
        text: buffer.toString("utf8"),
        cursor: start + length,
        truncated: start + length < stat.size,
      };
    } catch {
      return { text: "", cursor: 0, truncated: false };
    }
  }

  private lastError(logPath: string): string {
    try {
      return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
    } catch {
      return "";
    }
  }
}

let singleton: WorkspaceDevServerManager | null = null;
export function getWorkspaceDevServerManager(): WorkspaceDevServerManager {
  singleton ??= new WorkspaceDevServerManager();
  return singleton;
}

export function resetWorkspaceDevServerManagerForTest(): void {
  singleton = null;
}
