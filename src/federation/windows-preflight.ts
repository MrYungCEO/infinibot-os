/**
 * Windows preflight checks for federation hardening.
 *
 * Called by the desktop app's first-run flow AND by
 * scripts/federation-windows-selftest.mjs.  No duplication of the OS probes.
 *
 * On non-Windows the call returns immediately with all checks ok=true and a
 * "not Windows" note so callers don't need to guard on platform themselves.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface FirewallCheck {
  ok: boolean;
  ruleName?: string;
  error?: string;
  hint?: string;
}

export interface LongPathsCheck {
  ok: boolean;
  hint?: string;
}

export interface NamedPipeCheck {
  ok: boolean;
  note?: string;
}

export interface DefenderCheck {
  ok: boolean;
  note?: string;
}

export interface WindowsPreflightResult {
  firewallRule: FirewallCheck;
  longPaths: LongPathsCheck;
  namedPipeIPC: NamedPipeCheck;
  defenderExclusion: DefenderCheck;
  /** True only if all blocking checks (firewallRule, longPaths) pass. */
  allCriticalOk: boolean;
}

export interface WindowsPreflightOpts {
  /** Gateway port to check for a firewall rule. Defaults to 47913 (desktop). */
  gatewayPort?: number;
  /** Repo/install directory to check for Defender exclusion. Defaults to cwd. */
  repoPath?: string;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function checkWindowsPreflight(opts: WindowsPreflightOpts = {}): WindowsPreflightResult {
  if (platform() !== "win32") {
    const skip = { ok: true, note: "not Windows" };
    return {
      firewallRule: skip,
      longPaths: skip,
      namedPipeIPC: skip,
      defenderExclusion: skip,
      allCriticalOk: true,
    };
  }

  const port = opts.gatewayPort ?? 47913;
  const repoPath = opts.repoPath ?? process.cwd();

  const firewallRule = checkFirewallRule(port);
  const longPaths = checkLongPaths();
  const namedPipeIPC = checkNamedPipeIPC();
  const defenderExclusion = checkDefenderExclusion(repoPath);

  return {
    firewallRule,
    longPaths,
    namedPipeIPC,
    defenderExclusion,
    allCriticalOk: firewallRule.ok && longPaths.ok,
  };
}

// ─── Individual checks ────────────────────────────────────────────────────────

function checkFirewallRule(port: number): FirewallCheck {
  try {
    const out = execSync("netsh advfirewall firewall show rule name=all dir=in protocol=tcp", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    const portStr = String(port);
    const lines = out.split("\n");
    let currentRuleName = "";
    let matched = false;
    let matchedName = "";

    for (const line of lines) {
      if (line.startsWith("Rule Name:")) {
        currentRuleName = line.split(":").slice(1).join(":").trim();
      }
      if (line.includes("LocalPort") && line.includes(portStr)) {
        matched = true;
        matchedName = currentRuleName;
        break;
      }
    }

    return {
      ok: matched,
      ruleName: matched ? matchedName : undefined,
      hint: matched
        ? undefined
        : `netsh advfirewall firewall add rule name="InfiniBot Gateway" protocol=TCP dir=in localport=${port} action=allow`,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: err, hint: "Run as Administrator to check firewall rules." };
  }
}

function checkLongPaths(): LongPathsCheck {
  try {
    const out = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 },
    );
    return {
      ok: out.includes("0x1"),
      hint: out.includes("0x1")
        ? undefined
        : 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f',
    };
  } catch {
    return {
      ok: false,
      hint: 'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f',
    };
  }
}

function checkNamedPipeIPC(): NamedPipeCheck {
  // Named pipes are always available on Windows; no registry check needed.
  return { ok: true, note: "native named-pipe IPC available on all Windows versions" };
}

function checkDefenderExclusion(dir: string): DefenderCheck {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 8_000 },
    );
    const excluded = out.toLowerCase().includes(dir.toLowerCase());
    return {
      ok: excluded,
      note: excluded
        ? `Defender exclusion found for ${dir}`
        : `No Defender exclusion — federation spawn performance may be degraded.\n  Fix: Add-MpPreference -ExclusionPath "${dir}"`,
    };
  } catch {
    return {
      ok: false,
      note: "Could not query Defender preferences (may need elevation) — exclusion status unknown",
    };
  }
}
