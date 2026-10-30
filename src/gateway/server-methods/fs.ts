import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

// ── Background process registry (for terminal sessions) ─────
const bgProcesses = new Map<string, { proc: ReturnType<typeof spawn>; output: string[]; running: boolean }>();
let bgCounter = 0;

export const fsHandlers: GatewayRequestHandlers = {
  "fs.listDir": async ({ params, respond }) => {
    try {
      const targetPath = typeof params.path === "string" ? params.path.trim() : "";
      if (!targetPath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "path is required" });
        return;
      }

      const resolved = path.resolve(targetPath);

      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch {
        respond(false, undefined, { code: "NOT_FOUND", message: `Directory not found: ${resolved}` });
        return;
      }

      if (!stat.isDirectory()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: `Not a directory: ${resolved}` });
        return;
      }

      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      respond(true, { currentPath: resolved, directories: dirs });
    } catch (e: any) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e?.message || "Failed to list directory",
      });
    }
  },

  /**
   * Return a list of common system directories (Home, Desktop, Documents,
   * Downloads, Project root, Temp) plus optional recents the caller passes
   * along. Used by the terminals page so the user can quickly pick where to
   * spawn a shell without browsing the FS dialog.
   */
  "fs.systemDirs": async ({ params, respond }) => {
    try {
      const home = os.homedir();
      const projectRoot = process.cwd();
      const candidates: Array<{ key: string; label: string; path: string; icon: string }> = [
        { key: "home", label: "Home", icon: "⌂", path: home },
        { key: "desktop", label: "Desktop", icon: "▤", path: path.join(home, "Desktop") },
        { key: "documents", label: "Documents", icon: "▢", path: path.join(home, "Documents") },
        { key: "downloads", label: "Downloads", icon: "↓", path: path.join(home, "Downloads") },
        { key: "project", label: "Project", icon: "◆", path: projectRoot },
        { key: "temp", label: "Temp", icon: "⏱", path: os.tmpdir() },
      ];

      // Filter out paths that don't exist (e.g. if Documents was redirected away)
      const existing = candidates.filter((c) => {
        try { return fs.statSync(c.path).isDirectory(); } catch { return false; }
      });

      // Caller may pass recents to merge in (deduped by absolute path)
      const seen = new Set(existing.map((c) => path.resolve(c.path).toLowerCase()));
      const recentsRaw = Array.isArray(params?.recents) ? params.recents : [];
      const recents: Array<{ key: string; label: string; path: string; icon: string }> = [];
      for (const r of recentsRaw) {
        if (typeof r !== "string") continue;
        const abs = path.resolve(r);
        const lower = abs.toLowerCase();
        if (seen.has(lower)) continue;
        try {
          if (!fs.statSync(abs).isDirectory()) continue;
        } catch { continue; }
        seen.add(lower);
        recents.push({ key: `recent:${abs}`, label: path.basename(abs) || abs, icon: "⟲", path: abs });
        if (recents.length >= 6) break;
      }

      respond(true, {
        platform: process.platform,
        home,
        projectRoot,
        dirs: existing,
        recents,
      });
    } catch (e: any) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e?.message || "Failed to resolve system dirs",
      });
    }
  },

  "fs.browseFolder": async ({ params, respond }) => {
    try {
      const initialDir = typeof params.initialDir === "string" ? params.initialDir.trim() : "";

      // Use PowerShell to open the native Windows folder browser dialog
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select a folder"
$dialog.ShowNewFolderButton = $true
${initialDir ? `$dialog.SelectedPath = '${initialDir.replace(/'/g, "''")}'` : ""}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  Write-Output "::CANCELLED::"
}
`.trim();

      const stdout = execSync(
        `powershell -NoProfile -STA -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, "; ")}"`,
        { timeout: 120000, encoding: "utf-8" },
      ).trim();

      if (stdout === "::CANCELLED::" || !stdout) {
        respond(true, { cancelled: true, path: null });
      } else {
        respond(true, { cancelled: false, path: stdout });
      }
    } catch (e: any) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e?.message || "Failed to open folder dialog",
      });
    }
  },

  /** Run a command synchronously and return stdout/stderr/exitCode */
  "exec.run": async ({ params, respond }) => {
    try {
      const command = typeof params.command === "string" ? params.command : "";
      if (!command) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "command is required" });
        return;
      }
      const timeout = typeof params.timeout === "number" ? params.timeout * 1000 : 30000;
      const cwd = typeof params.cwd === "string" ? params.cwd : undefined;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        stdout = execSync(command, {
          timeout,
          encoding: "utf-8",
          cwd: cwd || undefined,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e: any) {
        stdout = e.stdout || "";
        stderr = e.stderr || "";
        exitCode = e.status ?? 1;
      }

      respond(true, { stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e?.message || "exec failed" });
    }
  },

  /** Start a background process (for interactive CLI agents) */
  "exec.bg": async ({ params, respond }) => {
    try {
      const command = typeof params.command === "string" ? params.command : "";
      if (!command) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "command is required" });
        return;
      }
      const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
      const sessionId = `bg-${++bgCounter}-${Date.now()}`;

      // Split command for spawn — on Windows use cmd /c
      const proc = spawn("cmd", ["/c", command], {
        cwd: cwd || undefined,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });

      const entry = { proc, output: [] as string[], running: true };
      bgProcesses.set(sessionId, entry);

      proc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n");
        entry.output.push(...lines);
        // Cap at 1000 lines
        if (entry.output.length > 1000) entry.output.splice(0, entry.output.length - 1000);
      });
      proc.stderr?.on("data", (data: Buffer) => {
        const lines = data.toString().split("\n").map((l) => `[stderr] ${l}`);
        entry.output.push(...lines);
        if (entry.output.length > 1000) entry.output.splice(0, entry.output.length - 1000);
      });
      proc.on("close", (code) => {
        entry.running = false;
        entry.output.push(`[process exited with code ${code}]`);
      });
      proc.on("error", (err) => {
        entry.running = false;
        entry.output.push(`[error] ${err.message}`);
      });

      respond(true, { sessionId, pid: proc.pid });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e?.message || "exec.bg failed" });
    }
  },

  /** Read output from a background process */
  "exec.bg.log": async ({ params, respond }) => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const entry = bgProcesses.get(sessionId);
    if (!entry) {
      respond(false, undefined, { code: "NOT_FOUND", message: "session not found" });
      return;
    }
    // Return and clear buffered output
    const log = [...entry.output];
    entry.output.length = 0;
    respond(true, { log, running: entry.running });
  },

  /** Write input to a background process */
  "exec.bg.write": async ({ params, respond }) => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const data = typeof params.data === "string" ? params.data : "";
    const entry = bgProcesses.get(sessionId);
    if (!entry) {
      respond(false, undefined, { code: "NOT_FOUND", message: "session not found" });
      return;
    }
    if (!entry.running) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "process not running" });
      return;
    }
    entry.proc.stdin?.write(data);
    respond(true, { ok: true });
  },

  /** Kill a background process */
  "exec.bg.kill": async ({ params, respond }) => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const entry = bgProcesses.get(sessionId);
    if (!entry) {
      respond(false, undefined, { code: "NOT_FOUND", message: "session not found" });
      return;
    }
    entry.proc.kill();
    entry.running = false;
    bgProcesses.delete(sessionId);
    respond(true, { ok: true });
  },

  /** Read a file from arbitrary path (for workspace files) */
  "fs.read": async ({ params, respond }) => {
    try {
      const filePath = typeof params.path === "string" ? params.path.trim() : "";
      if (!filePath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "path is required" });
        return;
      }
      
      // Expand ~ to user home
      const resolved = filePath.startsWith("~") 
        ? path.join(process.env.HOME || process.env.USERPROFILE || "", filePath.slice(1))
        : path.resolve(filePath);
      
      if (!fs.existsSync(resolved)) {
        respond(false, undefined, { code: "NOT_FOUND", message: `File not found: ${resolved}` });
        return;
      }
      
      const content = fs.readFileSync(resolved, "utf-8");
      respond(true, { path: resolved, content });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e?.message || "Failed to read file" });
    }
  },

  /** Write a file to arbitrary path (for workspace files) */
  "fs.write": async ({ params, respond }) => {
    try {
      const filePath = typeof params.path === "string" ? params.path.trim() : "";
      const content = typeof params.content === "string" ? params.content : "";
      
      if (!filePath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "path is required" });
        return;
      }
      
      // Expand ~ to user home
      const resolved = filePath.startsWith("~") 
        ? path.join(process.env.HOME || process.env.USERPROFILE || "", filePath.slice(1))
        : path.resolve(filePath);
      
      // Ensure parent directory exists
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(resolved, content, "utf-8");
      
      const stat = fs.statSync(resolved);
      respond(true, { 
        path: resolved, 
        size: stat.size,
        created: true 
      });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e?.message || "Failed to write file" });
    }
  },

  /** Check if a file exists */
  "fs.exists": async ({ params, respond }) => {
    try {
      const filePath = typeof params.path === "string" ? params.path.trim() : "";
      if (!filePath) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "path is required" });
        return;
      }
      
      // Expand ~ to user home
      const resolved = filePath.startsWith("~") 
        ? path.join(process.env.HOME || process.env.USERPROFILE || "", filePath.slice(1))
        : path.resolve(filePath);
      
      const exists = fs.existsSync(resolved);
      respond(true, { path: resolved, exists });
    } catch (e: any) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: e?.message || "Failed to check file" });
    }
  },
};
