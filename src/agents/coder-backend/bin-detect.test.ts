/**
 * Tests for cross-platform CLI binary detection.
 *
 * The helpers take an injectable BinSearchCtx so we can simulate a Windows
 * environment (and a fake filesystem) while running on Linux/macOS CI — no
 * monkey-patching of process.platform / node:fs required.
 *
 * COORDINATION: win-bin-detect
 */

import { describe, expect, it } from "vitest";
import { candidateBinDirs, resolveBin, describeBinSearch, enrichedPath } from "./bin-detect.js";
import type { BinSearchCtx } from "./bin-detect.js";

// ── Windows fixtures ────────────────────────────────────────────────────────

const WIN_HOME = "C:\\Users\\dev";
const WIN_ENV: NodeJS.ProcessEnv = {
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  USERPROFILE: WIN_HOME,
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ChocolateyInstall: "C:\\ProgramData\\chocolatey",
  // SCOOP intentionally unset → exercises the %USERPROFILE%\scoop default.
  PATH: "C:\\Windows\\System32",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};

/** Build a Windows ctx whose fake fs reports `present` paths as existing. */
function winCtx(present: string[], over?: Partial<BinSearchCtx>): Partial<BinSearchCtx> {
  const set = new Set(present);
  return {
    isWin: true,
    home: WIN_HOME,
    env: WIN_ENV,
    nodeBin: "C:\\Program Files\\nodejs",
    exists: (p: string) => set.has(p),
    isFile: (p: string) => set.has(p),
    readdir: () => [],
    ...over,
  };
}

// ── candidateBinDirs (Windows) ──────────────────────────────────────────────

describe("candidateBinDirs() on Windows", () => {
  it("emits the Windows shim dirs that exist, in priority order", () => {
    const present = [
      "C:\\Program Files\\nodejs",
      "C:\\Users\\dev\\AppData\\Roaming\\npm",
      "C:\\Users\\dev\\AppData\\Local\\pnpm",
      "C:\\Users\\dev\\.bun\\bin",
      "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links",
      "C:\\ProgramData\\chocolatey\\bin",
      "C:\\Users\\dev\\scoop\\shims",
    ];
    const dirs = candidateBinDirs(winCtx(present));
    // Only existing dirs come back (no phantom entries)…
    expect(dirs.length).toBe(present.length);
    for (const p of present) expect(dirs).toContain(p);
    // …and nodeBin is first, npm before pnpm, choco before scoop (priority).
    expect(dirs[0]).toBe("C:\\Program Files\\nodejs");
    expect(dirs.indexOf("C:\\Users\\dev\\AppData\\Roaming\\npm")).toBeLessThan(
      dirs.indexOf("C:\\Users\\dev\\AppData\\Local\\pnpm"),
    );
    expect(dirs.indexOf("C:\\ProgramData\\chocolatey\\bin")).toBeLessThan(
      dirs.indexOf("C:\\Users\\dev\\scoop\\shims"),
    );
  });

  it("synthesizes the SCOOP default from %USERPROFILE% when the env var is unset", () => {
    const scoopDefault = "C:\\Users\\dev\\scoop\\shims";
    const dirs = candidateBinDirs(winCtx([scoopDefault]));
    expect(dirs).toContain(scoopDefault);
  });

  it("silently drops env dirs that do not exist (existsSync filter)", () => {
    // Nothing exists → empty list, no throw.
    expect(candidateBinDirs(winCtx([]))).toEqual([]);
    // Only one exists → only that one is returned.
    const only = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    expect(candidateBinDirs(winCtx([only]))).toEqual([only]);
  });

  it("globs %LOCALAPPDATA%\\Programs\\Python\\Python3*\\Scripts best-effort", () => {
    const pyRoot = "C:\\Users\\dev\\AppData\\Local\\Programs\\Python";
    const py311Scripts = "C:\\Users\\dev\\AppData\\Local\\Programs\\Python\\Python311\\Scripts";
    const dirs = candidateBinDirs(
      winCtx([pyRoot, py311Scripts], {
        readdir: (p: string) => (p === pyRoot ? ["Python311", "Launcher"] : []),
      }),
    );
    expect(dirs).toContain(py311Scripts);
  });

  it("does not crash when the Python root is absent", () => {
    expect(() => candidateBinDirs(winCtx([]))).not.toThrow();
  });
});

// ── candidateBinDirs (Unix — no regression) ─────────────────────────────────

describe("candidateBinDirs() on Unix", () => {
  it("returns the original Unix list verbatim", () => {
    const dirs = candidateBinDirs({
      isWin: false,
      home: "/home/dev",
      env: { PATH: "/usr/bin" },
      nodeBin: "/usr/lib/node/bin",
      exists: () => true,
    });
    expect(dirs).toEqual([
      "/home/dev/.infinibot/android-build-tools/adb-compat/platform-tools-35.0.2",
      "/home/dev/.infinibot/android-build-tools/android-sdk/platform-tools",
      "/home/dev/.infinibot/android-build-tools/android-sdk/cmdline-tools/latest/bin",
      "/home/dev/.local/bin",
      "/home/dev/.npm-global/bin",
      "/home/dev/.bun/bin",
      "/home/dev/.deno/bin",
      "/home/dev/.local/share/pnpm",
      "/home/dev/.yarn/bin",
      "/home/dev/.cargo/bin",
      "/usr/lib/node/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("does not emit any Windows-flavored dirs on Unix", () => {
    const dirs = candidateBinDirs({
      isWin: false,
      home: "/home/dev",
      env: { PATH: "/usr/bin" },
    });
    expect(dirs.some((d) => /WinGet|chocolatey|scoop|AppData/.test(d))).toBe(false);
  });
});

// ── resolveBin / PATHEXT ────────────────────────────────────────────────────

describe("resolveBin() on Windows respects PATHEXT", () => {
  it("prefers .EXE (PATHEXT order) when the caller passes a bare name", () => {
    const exeOnly = "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.EXE";
    const ctx = winCtx(["C:\\Users\\dev\\AppData\\Roaming\\npm", exeOnly]);
    expect(resolveBin("claude", ctx)).toBe(exeOnly);
  });

  it("resolves an explicit .exe name without doubling the extension", () => {
    const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const exe = "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe";
    expect(resolveBin("claude.exe", winCtx([npmDir, exe]))).toBe(exe);
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveBin("nope", winCtx(["C:\\Users\\dev\\AppData\\Roaming\\npm"]))).toBeUndefined();
  });

  it("honors a .COM-first PATHEXT ordering", () => {
    const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const com = "C:\\Users\\dev\\AppData\\Roaming\\npm\\tool.COM";
    const exe = "C:\\Users\\dev\\AppData\\Roaming\\npm\\tool.EXE";
    // Both exist → .COM wins because PATHEXT lists it first.
    expect(resolveBin("tool", winCtx([npmDir, com, exe]))).toBe(com);
  });
});

// ── describeBinSearch ───────────────────────────────────────────────────────

describe("describeBinSearch()", () => {
  it("returns an ordered list of every absolute path inspected", () => {
    const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const exe = "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.EXE";
    const { tried, resolved } = describeBinSearch("claude", winCtx([npmDir, exe]));
    expect(resolved).toBe(exe);
    expect(tried.length).toBeGreaterThan(0);
    // The winning path is among the tried paths…
    expect(tried).toContain(exe);
    // …and tried covers PATHEXT variants for the npm dir in order.
    const npmTries = tried.filter((p) => p.startsWith(npmDir + "\\"));
    expect(npmTries[0]).toBe(npmDir + "\\claude.COM");
    expect(npmTries[1]).toBe(npmDir + "\\claude.EXE");
  });

  it("short-circuits an explicit absolute path", () => {
    const abs = "C:\\tools\\claude.exe";
    const { tried, resolved } = describeBinSearch(abs, winCtx([abs]));
    expect(tried).toEqual([abs]);
    expect(resolved).toBe(abs);
  });
});

// ── enrichedPath ────────────────────────────────────────────────────────────

describe("enrichedPath()", () => {
  it("keeps existing PATH entries first, then appends new candidate dirs", () => {
    const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const path = enrichedPath(winCtx([npmDir]));
    const parts = path.split(";");
    expect(parts[0]).toBe("C:\\Windows\\System32"); // pre-existing entry stays first
    expect(parts).toContain(npmDir);
  });

  it("does not duplicate a dir already on PATH", () => {
    const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
    const ctx = winCtx([npmDir], {
      env: { ...WIN_ENV, PATH: `C:\\Windows\\System32;${npmDir}` },
    });
    const parts = enrichedPath(ctx).split(";");
    expect(parts.filter((p) => p === npmDir).length).toBe(1);
  });
});

// ── Managed coders shim dir (Setup › Coders) ────────────────────────────────

describe("enrichedPath() with the managed coders dir", () => {
  const base = {
    isWin: false,
    home: "/home/dev",
    env: { PATH: "/usr/bin:/home/dev/.infinibot/coders/bin" },
    nodeBin: "/usr/lib/node/bin",
  };

  it("puts an existing managed dir first, once", () => {
    const parts = enrichedPath({
      ...base,
      managedBinDir: "/home/dev/.infinibot/coders/bin",
      exists: () => true,
    }).split(":");
    expect(parts[0]).toBe("/home/dev/.infinibot/coders/bin");
    expect(parts.filter((p) => p === "/home/dev/.infinibot/coders/bin")).toHaveLength(1);
    expect(parts[1]).toBe("/usr/bin");
  });

  it("skips a managed dir that doesn't exist, or when disabled", () => {
    const missing = enrichedPath({
      ...base,
      env: { PATH: "/usr/bin" },
      managedBinDir: "/nope/coders/bin",
      exists: (p) => p !== "/nope/coders/bin",
    });
    expect(missing.split(":")[0]).toBe("/usr/bin");
    expect(missing).not.toContain("/nope/coders/bin");
    const off = enrichedPath({
      ...base,
      env: { PATH: "/usr/bin" },
      managedBinDir: null,
      exists: () => true,
    });
    expect(off.split(":")[0]).toBe("/usr/bin");
  });
});
