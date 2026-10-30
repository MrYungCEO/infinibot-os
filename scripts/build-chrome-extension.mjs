import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const source = path.join(root, "assets", "chrome-extension");
const outRoot = path.join(root, "dist", "chrome-extension");
const unpacked = path.join(outRoot, "unpacked");
const zipPath = path.join(outRoot, "infinibot-browser-relay.zip");

if (!fs.existsSync(path.join(source, "manifest.json"))) {
  throw new Error(`Chrome extension source not found: ${source}`);
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });
fs.cpSync(source, unpacked, { recursive: true });

const ignored = new Set(["README.md"]);
for (const entry of ignored) fs.rmSync(path.join(unpacked, entry), { force: true });

let result;
if (process.platform === "win32") {
  result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${unpacked}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  result = spawnSync("zip", ["-q", "-r", zipPath, "."], { cwd: unpacked, stdio: "inherit" });
}
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Extension packaging failed with exit ${result.status}`);

const size = fs.statSync(zipPath).size;
console.log(JSON.stringify({ unpacked, zip: zipPath, sizeBytes: size }, null, 2));
