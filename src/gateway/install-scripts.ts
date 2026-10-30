/**
 * Install Scripts Handler
 * Serves Infinibot install scripts at /install.sh and /install.ps1
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the scripts directory
 */
function resolveScriptsDir(): string | null {
  const candidates = [
    // From dist: dist/gateway/install-scripts.js -> ../../scripts
    path.resolve(__dirname, "../../scripts"),
    // From source: src/gateway/install-scripts.ts -> ../../scripts
    path.resolve(__dirname, "../../../scripts"),
    // Fallback to cwd
    path.resolve(process.cwd(), "scripts"),
    // Another fallback: relative to infinibot root (common case)
    path.resolve(process.cwd(), "../scripts"),
  ];
  
  for (const dir of candidates) {
    // Check for both .sh and .ps1 to be flexible
    if (fs.existsSync(path.join(dir, "install-infinibot.sh")) || 
        fs.existsSync(path.join(dir, "install-infinibot.ps1"))) {
      return dir;
    }
  }
  console.warn("[install-scripts] Scripts directory not found. Tried:", candidates);
  return null;
}

/**
 * Handle install script requests
 * Routes:
 *   GET /install.sh     -> install-infinibot.sh
 *   GET /install.ps1    -> install-infinibot.ps1
 *   GET /install        -> redirect based on User-Agent
 */
export function handleInstallScriptRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  
  const urlPath = req.url?.split("?")[0] ?? "";
  
  // Only handle /install paths
  if (
    urlPath !== "/install.sh" &&
    urlPath !== "/install.ps1" &&
    urlPath !== "/install" &&
    urlPath !== "/install/"
  ) {
    return false;
  }
  
  console.log(`[install-scripts] Handling path: ${urlPath}`);
  
  const scriptsDir = resolveScriptsDir();
  if (!scriptsDir) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Install scripts not found");
    return true;
  }
  
  // Auto-detect platform from User-Agent for /install
  if (urlPath === "/install" || urlPath === "/install/") {
    const ua = (req.headers["user-agent"] ?? "").toLowerCase();
    if (ua.includes("powershell") || ua.includes("windows")) {
      return serveScript(req, res, path.join(scriptsDir, "install-infinibot.ps1"), "ps1");
    }
    return serveScript(req, res, path.join(scriptsDir, "install-infinibot.sh"), "sh");
  }
  
  // Serve specific script
  if (urlPath === "/install.sh") {
    return serveScript(req, res, path.join(scriptsDir, "install-infinibot.sh"), "sh");
  }
  
  if (urlPath === "/install.ps1") {
    return serveScript(req, res, path.join(scriptsDir, "install-infinibot.ps1"), "ps1");
  }
  
  return false;
}

function serveScript(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  type: "sh" | "ps1",
): boolean {
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Script not found");
    return true;
  }
  
  const stat = fs.statSync(filePath);
  const contentType = type === "ps1" 
    ? "text/plain; charset=utf-8"  // PowerShell expects text/plain
    : "text/x-shellscript; charset=utf-8";
  
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-cache, max-age=0");
  res.setHeader("Content-Disposition", `inline; filename="install-infinibot.${type}"`);
  
  // Allow cross-origin requests for curl/wget
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  return true;
}
