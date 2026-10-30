import { execFile } from "node:child_process";

/** Side-effect seams, injected so the swap state machine is testable without a GPU. */
export type ExecResult = { code: number; stdout: string; stderr: string };

export type RuntimeDeps = {
  exec: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type GpuInfo = { name: string; totalMb: number; usedMb: number; freeMb: number };

export type OllamaLoaded = { name: string; sizeVramMb: number; expiresAt?: string };

function userBusEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // `systemctl --user` needs the user bus; the gateway can be spawned with a scrubbed env.
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined) {
    env.XDG_RUNTIME_DIR ||= `/run/user/${uid}`;
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=/run/user/${uid}/bus`;
  }
  return env;
}

export function realDeps(): RuntimeDeps {
  return {
    exec: (cmd, args, opts) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { timeout: opts?.timeoutMs ?? 120_000, env: userBusEnv(), maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as { code?: unknown }).code === "number"
                ? (err as { code: number }).code
                : err
                  ? 1
                  : 0;
            resolve({
              code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? err?.message ?? ""),
            });
          },
        );
      }),
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    // Not unref()d: an awaited swap must keep a CLI process alive.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function httpOk(deps: RuntimeDeps, url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function systemdActiveState(deps: RuntimeDeps, unit: string): Promise<string> {
  const r = await deps.exec("systemctl", ["--user", "is-active", unit], { timeoutMs: 10_000 });
  return r.stdout.trim().split("\n")[0] || (r.code === 0 ? "active" : "unknown");
}

/** SubState — "auto-restart" while Restart=on-failure is crash-looping the unit. */
export async function systemdSubState(deps: RuntimeDeps, unit: string): Promise<string> {
  const r = await deps.exec("systemctl", ["--user", "show", "-p", "SubState", "--value", unit], {
    timeoutMs: 10_000,
  });
  return r.stdout.trim();
}

export async function systemdStart(deps: RuntimeDeps, unit: string): Promise<ExecResult> {
  // --no-block: Type=simple returns at once anyway; health polling decides readiness.
  return deps.exec("systemctl", ["--user", "start", "--no-block", unit], { timeoutMs: 30_000 });
}

export async function systemdStop(deps: RuntimeDeps, unit: string): Promise<ExecResult> {
  // Blocks until the process has exited (and released its VRAM).
  return deps.exec("systemctl", ["--user", "stop", unit], { timeoutMs: 150_000 });
}

export async function systemdJournalTail(
  deps: RuntimeDeps,
  unit: string,
  lines = 6,
): Promise<string> {
  const r = await deps.exec(
    "journalctl",
    ["--user", "-u", unit, "-n", String(lines), "--no-pager", "-o", "cat"],
    { timeoutMs: 10_000 },
  );
  return r.code === 0 ? r.stdout.trim() : "";
}

/** The most telling line of a crashed unit's recent log (the exception, not the traceback frames). */
export async function systemdLastError(deps: RuntimeDeps, unit: string): Promise<string> {
  const tail = await systemdJournalTail(deps, unit, 80);
  const lines = tail
    .split("\n")
    .map((l) => l.replace(/^\([^)]*\)\s*/, "").trim())
    .filter(Boolean);
  const hit = [...lines]
    .reverse()
    .find((l) => /(Error|Exception)\b.*:|out of memory|CUDA error/i.test(l));
  return (hit ?? lines.at(-1) ?? "").slice(0, 240);
}

export async function ollamaLoaded(
  deps: RuntimeDeps,
  base: string,
): Promise<OllamaLoaded[] | null> {
  try {
    const res = await deps.fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      models?: Array<{ name?: string; model?: string; size_vram?: number; expires_at?: string }>;
    };
    return (body.models ?? []).map((m) => ({
      name: String(m.name ?? m.model ?? ""),
      sizeVramMb: Math.round((m.size_vram ?? 0) / (1024 * 1024)),
      expiresAt: m.expires_at,
    }));
  } catch {
    return null;
  }
}

async function ollamaGenerate(
  deps: RuntimeDeps,
  base: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  const res = await deps.fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ollama ${res.status}: ${text.slice(0, 200)}`);
  }
  await res.text().catch(() => "");
}

/** Unload one model (`keep_alive: 0`) — the API form of `ollama stop <model>`. */
export function ollamaUnload(deps: RuntimeDeps, base: string, model: string): Promise<void> {
  return ollamaGenerate(deps, base, { model, keep_alive: 0 }, 60_000);
}

/** Load a model into VRAM without generating (empty prompt). */
export function ollamaLoad(
  deps: RuntimeDeps,
  base: string,
  model: string,
  opts: { keepAlive?: string; timeoutMs: number },
): Promise<void> {
  return ollamaGenerate(
    deps,
    base,
    { model, ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}) },
    opts.timeoutMs,
  );
}

export async function gpuInfo(deps: RuntimeDeps, index = 0): Promise<GpuInfo | null> {
  const r = await deps.exec(
    "nvidia-smi",
    [
      `--id=${index}`,
      "--query-gpu=name,memory.total,memory.used,memory.free",
      "--format=csv,noheader,nounits",
    ],
    { timeoutMs: 10_000 },
  );
  if (r.code !== 0) return null;
  const parts =
    r.stdout
      .trim()
      .split("\n")[0]
      ?.split(",")
      .map((s) => s.trim()) ?? [];
  if (parts.length < 4) return null;
  const [name, total, used, free] = parts;
  const n = (s: string | undefined) => Number.parseInt(s ?? "", 10);
  if (![total, used, free].every((v) => Number.isFinite(n(v)))) return null;
  return { name: name ?? "GPU", totalMb: n(total), usedMb: n(used), freeMb: n(free) };
}
