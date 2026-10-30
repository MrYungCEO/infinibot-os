/**
 * scrcpy streaming adapter.
 *
 * §3's live grid needs four simultaneous previews with a one-click CONTROL
 * button. scrcpy owns the hard part (low-latency H.264 mirroring + input
 * injection); this adapter's only job is lifecycle: probe the binary, spawn a
 * per-device session, track it, and tear it down.
 *
 * When scrcpy is absent the service swaps in `NullStreamAdapter` and the grid
 * renders its placeholder state — the boundary is the same either way.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { enrichedPathEnv, resolveBin } from "../../agents/coder-backend/bin-detect.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AdapterAvailability, StreamAdapter, StreamSession } from "./types.js";

const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("android-ops");

interface LiveSession {
  session: StreamSession;
  proc: ChildProcess | null;
}

export class ScrcpyStreamAdapter implements StreamAdapter {
  readonly id = "scrcpy";
  readonly kind = "scrcpy" as const;
  private sessions = new Map<string, LiveSession>();

  private bin(): string | null {
    return resolveBin("scrcpy") ?? null;
  }

  async probe(): Promise<AdapterAvailability> {
    const now = Date.now();
    const bin = this.bin();
    if (!bin) {
      return {
        available: false,
        version: null,
        binPath: null,
        reason: "scrcpy not found on PATH",
        checkedAt: now,
      };
    }
    try {
      const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
        env: enrichedPathEnv(),
        timeout: 8000,
      });
      const version = `${stdout}${stderr}`.split("\n")[0]?.trim() || "scrcpy";
      return { available: true, version, binPath: bin, reason: null, checkedAt: now };
    } catch (e) {
      return { available: false, version: null, binPath: bin, reason: String(e), checkedAt: now };
    }
  }

  async startSession(deviceId: string, serial: string): Promise<StreamSession> {
    const bin = this.bin();
    const launchHint = `scrcpy -s ${serial} --window-title "${deviceId}" --stay-awake`;
    if (!bin) {
      return {
        ok: false,
        sessionId: null,
        deviceId,
        endpoint: null,
        launchHint,
        startedAt: null,
        reason: "scrcpy not found on PATH",
      };
    }

    const existing = [...this.sessions.values()].find((s) => s.session.deviceId === deviceId);
    if (existing) return existing.session;

    const sessionId = randomUUID();
    try {
      const proc = spawn(bin, ["-s", serial, "--window-title", deviceId, "--stay-awake"], {
        env: enrichedPathEnv(),
        detached: true,
        stdio: "ignore",
      });
      proc.unref();
      proc.on("exit", () => this.sessions.delete(sessionId));

      const session: StreamSession = {
        ok: true,
        sessionId,
        deviceId,
        endpoint: `scrcpy://${serial}`,
        launchHint,
        startedAt: Date.now(),
        reason: null,
      };
      this.sessions.set(sessionId, { session, proc });
      log.info("scrcpy session started", { deviceId, serial });
      return session;
    } catch (e) {
      return {
        ok: false,
        sessionId: null,
        deviceId,
        endpoint: null,
        launchHint,
        startedAt: null,
        reason: String(e),
      };
    }
  }

  async stopSession(sessionId: string): Promise<{ ok: boolean; reason: string | null }> {
    const live = this.sessions.get(sessionId);
    if (!live) return { ok: false, reason: "no such session" };
    try {
      live.proc?.kill();
    } catch {
      /* already gone */
    }
    this.sessions.delete(sessionId);
    return { ok: true, reason: null };
  }

  listSessions(): StreamSession[] {
    return [...this.sessions.values()].map((s) => s.session);
  }
}
