/**
 * The Docker side effects of the one-click voice setup. Every command names an
 * explicit container / image / volume from the plan, so unrelated containers
 * are never listed, stopped or removed.
 *
 * Image downloads go through the Docker Engine API (unix socket / Windows named
 * pipe) because only it streams byte-level progress; when the API isn't
 * reachable (remote TCP context, odd setups) it falls back to `docker pull`.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";

import type { Exec, HostOs } from "./detect.js";
import type { DockerStartPlan, ExistingContainer, PullEvent } from "./plan.js";

export class DockerOps {
  constructor(
    readonly cli: string,
    private exec: Exec,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  async inspectContainer(name: string): Promise<ExistingContainer | null> {
    const r = await this.exec(this.cli, ["container", "inspect", name, "--format", "{{json .}}"], {
      timeoutMs: 8000,
    });
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.stdout.trim()) as {
        Name?: string;
        State?: { Status?: string };
        Config?: { Labels?: Record<string, string> };
        HostConfig?: { RestartPolicy?: { Name?: string } };
      };
      return {
        name: (j.Name ?? name).replace(/^\//, ""),
        status: j.State?.Status ?? "unknown",
        labels: j.Config?.Labels ?? {},
        restartPolicy: j.HostConfig?.RestartPolicy?.Name,
      };
    } catch {
      return null;
    }
  }

  async imagePresent(image: string): Promise<boolean> {
    return (
      await this.exec(this.cli, ["image", "inspect", image, "--format", "{{.Id}}"], {
        timeoutMs: 8000,
      })
    ).ok;
  }

  async run(args: string[]): Promise<{ ok: boolean; error: string }> {
    const r = await this.exec(this.cli, args, { timeoutMs: 120_000 });
    return { ok: r.ok, error: r.ok ? "" : (r.stderr || r.stdout).trim() };
  }

  async start(container: string): Promise<{ ok: boolean; error: string }> {
    return this.run(["start", container]);
  }

  /** Make sure our container comes back after a reboot. */
  async ensureRestartPolicy(container: string): Promise<void> {
    await this.exec(this.cli, ["update", "--restart", "unless-stopped", container], {
      timeoutMs: 15_000,
    });
  }

  /** Remove ONLY the named containers + volumes (used by tests / explicit uninstall). */
  async remove(containers: string[], volumes: string[]): Promise<void> {
    for (const c of containers) await this.exec(this.cli, ["rm", "-f", c], { timeoutMs: 60_000 });
    for (const v of volumes)
      await this.exec(this.cli, ["volume", "rm", "-f", v], { timeoutMs: 60_000 });
  }

  /** Engine API endpoint: unix socket path or Windows named pipe, else null. */
  async engineSocket(): Promise<string | null> {
    let host = (this.env.DOCKER_HOST ?? "").trim();
    if (!host) {
      const r = await this.exec(
        this.cli,
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        {
          timeoutMs: 5000,
        },
      );
      host = r.ok ? r.stdout.trim() : "";
    }
    return socketFromDockerHost(host);
  }

  /**
   * Pull an image, streaming Docker's JSON progress events. Resolves when the
   * image is present; rejects with Docker's own error text.
   */
  async pull(image: string, onEvent: (e: PullEvent) => void, signal?: AbortSignal): Promise<void> {
    const socket = await this.engineSocket();
    if (socket) {
      try {
        await pullViaEngine(socket, image, onEvent, signal);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        // Socket refused (permissions, odd context) → fall back to the CLI.
        if (!(err as { engineUnreachable?: boolean }).engineUnreachable) throw err;
      }
    }
    await pullViaCli(this.cli, image, onEvent, signal);
  }
}

export function socketFromDockerHost(host: string): string | null {
  if (!host) return null;
  if (host.startsWith("unix://")) return host.slice("unix://".length);
  if (host.startsWith("npipe://")) {
    // npipe:////./pipe/docker_engine → \\.\pipe\docker_engine
    return host.slice("npipe://".length).replace(/\//g, "\\").replace(/^\\*/, "\\\\");
  }
  return null;
}

export function splitImage(image: string): { repo: string; tag: string } {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { repo: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repo: image, tag: "latest" };
}

function pullViaEngine(
  socketPath: string,
  image: string,
  onEvent: (e: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { repo, tag } = splitImage(image);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let buf = "";
        let failed: string | null = null;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as PullEvent & { message?: string };
              if (ev.error) failed = ev.error;
              else if (res.statusCode && res.statusCode >= 400 && ev.message) failed = ev.message;
              else onEvent(ev);
            } catch {
              /* partial / non-JSON noise */
            }
          }
        });
        res.on("end", () => {
          if (!failed && res.statusCode && res.statusCode >= 400)
            failed = buf.trim() || `HTTP ${res.statusCode}`;
          if (failed) reject(new Error(failed));
          else resolve();
        });
        res.on("error", reject);
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      const e = new Error(err.message) as Error & { engineUnreachable?: boolean };
      e.engineUnreachable = ["EACCES", "ENOENT", "ECONNREFUSED", "EPERM"].includes(err.code ?? "");
      reject(e);
    });
    signal?.addEventListener("abort", () => req.destroy(new Error("cancelled")), { once: true });
    req.end();
  });
}

function pullViaCli(
  cli: string,
  image: string,
  onEvent: (e: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["pull", image], { windowsHide: true });
    let err = "";
    const pump = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const m = line.match(/^([0-9a-f]{12,}): (.+)$/i);
        if (m) onEvent({ id: m[1], status: m[2] });
      }
    };
    child.stdout.on("data", pump);
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `docker pull exited ${code}`)),
    );
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

/** True when nothing can bind the port (another app holds it). */
export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "0.0.0.0");
  });
}

/**
 * Try to start Docker without asking for a password. Returns "started" when
 * the command went through (caller then waits for the engine), "needs-sudo"
 * when only an admin can start it, "failed" otherwise.
 */
export async function startDocker(
  osId: HostOs,
  plan: DockerStartPlan,
  exec: Exec,
): Promise<{ result: "started" | "needs-sudo" | "failed"; detail: string }> {
  if (plan.kind === "open-desktop") {
    try {
      if (osId === "darwin") {
        const r = await exec("open", plan.app ? ["-a", plan.app] : ["-a", "Docker"], {
          timeoutMs: 15_000,
        });
        return { result: r.ok ? "started" : "failed", detail: r.stderr };
      }
      const app = plan.app ?? "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
      const child = spawn(app, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => undefined);
      child.unref();
      return { result: "started", detail: "" };
    } catch (e) {
      return { result: "failed", detail: String(e) };
    }
  }
  if (plan.kind === "systemctl-user") {
    const r = await exec("systemctl", ["--user", "start", plan.unit], { timeoutMs: 60_000 });
    return { result: r.ok ? "started" : "failed", detail: r.stderr };
  }
  if (plan.kind === "systemctl-system") {
    const r = await exec("systemctl", ["start", "--no-ask-password", "docker"], {
      timeoutMs: 60_000,
    });
    if (r.ok) return { result: "started", detail: "" };
    const needsAuth =
      /interactive authentication|access denied|authentication is required|not authorized/i.test(
        r.stderr,
      );
    return { result: needsAuth ? "needs-sudo" : "failed", detail: r.stderr };
  }
  return { result: "needs-sudo", detail: "" };
}
