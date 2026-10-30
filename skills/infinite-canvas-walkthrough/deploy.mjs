#!/usr/bin/env node
/**
 * Infinite-Canvas Walkthrough — Netlify deploy + Telegram link.
 *
 *   node deploy.mjs --build /tmp/<slug>-canvas-build \
 *                   --site <site-name-or-id> \
 *                   [--config <canvas.json>]
 *
 *   • Netlify CLI is invoked from /tmp with absolute --dir + --site + --prod,
 *     which side-steps the monorepo CLI prompt.
 *   • Creates the site if missing.
 *   • Re-runs verify.mjs against the live URL.
 *   • If --config has `deploy.telegram: true` (or --telegram is passed),
 *     posts a link-only message via sendCanvasLinkToTelegram from
 *     src/reports/index.ts.
 *
 * The "send-pdf" sink is NEVER used here — interactive canvases ship as URLs.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const buildDir = path.resolve(arg("build") || "");
const siteId = arg("site");
const configPath = arg("config");
const wantTelegram = flag("telegram");

if (!buildDir || !siteId) {
  console.error("usage: deploy.mjs --build <dir> --site <name-or-id> [--config canvas.json] [--telegram]");
  process.exit(1);
}
if (!fs.existsSync(path.join(buildDir, "index.html"))) {
  console.error(`no index.html in ${buildDir} — run build.mjs first`);
  process.exit(1);
}

const config = configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
const telegramFromConfig = !!config?.deploy?.telegram;
const sendTelegram = wantTelegram || telegramFromConfig;
const title = config?.title || "Infinite Canvas Walkthrough";

// ── netlify CLI ─────────────────────────────────────────────────
function netlify(args, opts = {}) {
  const res = spawnSync("netlify", args, {
    cwd: "/tmp",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: process.env,
  });
  return res;
}

// Ensure site exists. `netlify sites:list --json` then create if missing.
function ensureSite(name) {
  const list = netlify(["sites:list", "--json"]);
  if (list.status === 0) {
    try {
      const sites = JSON.parse(list.stdout || "[]");
      const found = sites.find((s) => s.name === name || s.id === name);
      if (found) return found.id;
    } catch {}
  }
  console.log(`creating netlify site '${name}'…`);
  const create = netlify(["sites:create", "--name", name, "--json"]);
  if (create.status !== 0) {
    console.error("sites:create failed:", create.stderr || create.stdout);
    process.exit(1);
  }
  try {
    const obj = JSON.parse(create.stdout);
    return obj.id || obj.site_id;
  } catch {
    return name;
  }
}

const realSiteId = ensureSite(siteId);
console.log(`deploying ${buildDir} to netlify site ${siteId} (${realSiteId})…`);

const deploy = netlify([
  "deploy",
  "--dir", buildDir,
  "--site", realSiteId,
  "--prod",
  "--json",
], { stdio: ["ignore", "pipe", "inherit"] });

if (deploy.status !== 0) {
  console.error("netlify deploy failed");
  process.exit(1);
}

let liveUrl = "";
try {
  const obj = JSON.parse(deploy.stdout);
  liveUrl = obj.url || obj.deploy_url || obj.ssl_url || "";
} catch {
  const m = deploy.stdout.match(/https:\/\/\S+\.netlify\.app/);
  if (m) liveUrl = m[0];
}
if (!liveUrl) {
  console.error("could not parse live URL from netlify output");
  console.error(deploy.stdout);
  process.exit(1);
}
console.log(`live: ${liveUrl}`);

// ── re-verify against live URL (best effort) ──────────────────
try {
  console.log("re-verifying against live URL…");
  execFileSync("node", [path.join(__dirname, "verify.mjs"), "--url", liveUrl, "--build", buildDir], {
    stdio: "inherit",
  });
} catch {
  console.error("warning: live verify failed (artifact is deployed; check manually)");
}

// ── Telegram link ────────────────────────────────────────────
if (sendTelegram) {
  console.log("posting link to Telegram…");
  // Resolve the reports module out of the repo's dist (preferred) or src.
  const repoRoot = path.resolve(__dirname, "../..");
  const dist = path.join(repoRoot, "dist/src/reports/index.js");
  const src = path.join(repoRoot, "src/reports/index.ts");
  let mod;
  try {
    if (fs.existsSync(dist)) mod = await import(dist);
    else if (fs.existsSync(src)) {
      // Fall back to tsx if available
      const tsx = path.join(repoRoot, "node_modules/.bin/tsx");
      if (fs.existsSync(tsx)) {
        const r = spawnSync(tsx, ["-e", `
          import('${src}').then(async m => {
            const r = await m.sendCanvasLinkToTelegram(${JSON.stringify(liveUrl)}, ${JSON.stringify(title)});
            process.stdout.write(JSON.stringify(r));
          }).catch(e => { console.error(e); process.exit(1); });
        `], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
        if (r.status === 0) console.log("telegram:", r.stdout.trim());
        else console.error("telegram (tsx) failed");
      } else {
        console.error("no dist/, no tsx — skip telegram");
      }
    }
    if (mod?.sendCanvasLinkToTelegram) {
      const r = await mod.sendCanvasLinkToTelegram(liveUrl, title);
      console.log("telegram:", JSON.stringify(r));
    }
  } catch (e) {
    console.error("telegram send failed:", e.message);
  }
}

console.log(`\n${liveUrl}`);
