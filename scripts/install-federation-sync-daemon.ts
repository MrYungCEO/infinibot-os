#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, platform } from "node:os";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const SERVICES_DIR = join(SCRIPTS_DIR, "services");
// Normalize to a clean absolute path (no trailing "/scripts/..") so the
// generated systemd/launchd/Windows unit references the project by absolute path.
const REPO_DIR = resolve(SCRIPTS_DIR, "..");

function installSystemd() {
  const service = readFileSync(join(SERVICES_DIR, "federation-sync.service"), "utf-8")
    .replace(/\/path\/to\/InfiniBot-fresh/g, REPO_DIR)
    .replace(/%i/g, process.env.USER || "nobody");

  const timer = readFileSync(join(SERVICES_DIR, "federation-sync.timer"), "utf-8");
  const timerPath = "/etc/systemd/system/federation-sync.timer";
  const servicePath = "/etc/systemd/system/federation-sync.service";

  writeFileSync(servicePath, service, "utf-8");
  writeFileSync(timerPath, timer, "utf-8");

  execSync("systemctl daemon-reload", { stdio: "inherit" });
  execSync("systemctl enable federation-sync.timer", { stdio: "inherit" });
  execSync("systemctl start federation-sync.timer", { stdio: "inherit" });
  console.log("✓ systemd timer installed and started");
}

function installLaunchd() {
  let plist = readFileSync(join(SERVICES_DIR, "com.infinibot.federation-sync.plist"), "utf-8");
  plist = plist.replace(/\/path\/to\/InfiniBot-fresh/g, REPO_DIR);
  plist = plist.replace(/__HOME__/g, process.env.HOME || "/Users/Shared");

  const dest = join(process.env.HOME || "/tmp", "Library/LaunchAgents/com.infinibot.federation-sync.plist");
  writeFileSync(dest, plist, "utf-8");
  execSync(`launchctl load ${dest}`, { stdio: "inherit" });
  console.log("✓ launchd agent installed and loaded");
}

function installScheduledTask() {
  const task = readFileSync(join(SERVICES_DIR, "federation-sync-windows.xml"), "utf-8")
    .replace(/C:\\path\\to\\InfiniBot-fresh/g, REPO_DIR.replace(/\//g, "\\"));

  const taskFile = join(process.env.TEMP || "C:\\Temp", "federation-sync-task.xml");
  writeFileSync(taskFile, task, "utf-8");
  execSync(`schtasks /create /tn "InfiniBot Federation Sync" /xml "${taskFile}" /f`, { stdio: "inherit" });
  console.log("✓ Windows scheduled task installed");
}

function main() {
  const p = platform();
  console.log(`Installing federation-sync daemon for ${p} on ${hostname()}...`);

  try {
    if (p === "linux") {
      installSystemd();
    } else if (p === "darwin") {
      installLaunchd();
    } else if (p === "win32") {
      installScheduledTask();
    } else {
      console.error(`Unsupported platform: ${p}`);
      process.exit(1);
    }
    console.log("Done.");
  } catch (e) {
    console.error("Installation failed:", (e as Error).message);
    process.exit(1);
  }
}

main();