#!/usr/bin/env node
/**
 * Voice Terminal HUD layout check — screenshots the HUD at several viewports
 * and asserts that no HUD region overlaps another (or the orb) and that every
 * visible region sits fully inside the viewport.
 *
 *   node scripts/voice-hud-overlap-check.mjs [--serve <dist/control-ui>] [--base http://127.0.0.1:18789]
 *        [--out <dir>] [--route /voice] [--audit]
 *
 * --serve   serve a worktree build on a loopback port (WS + /api tunnelled to
 *           the gateway) instead of loading the live gateway origin.
 * --audit   don't assert; dump every visible fixed/absolute element inside the
 *           HUD layers (tag/class/rect/text) so the current layout can be read.
 *
 * Regions checked: every element marked `data-hud-region` inside
 * <voice-floating-hud> / <voice-hud-panels> (shadow-piercing) plus the orb
 * (`data-hud-region="orb"`). Exit code 1 when any assertion fails.
 *
 * Auth: gateway password/token from ~/.infinibot/infinibot.json (or
 * INFINIBOT_GATEWAY_PASSWORD), written into the control UI's localStorage.
 */
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const AUDIT = args.includes("--audit");
const SERVE = opt("--serve", null);
const GW = opt("--gateway", "http://127.0.0.1:18789");
const ROUTE = opt("--route", "/voice");
const OUT = path.resolve(opt("--out", path.join(os.tmpdir(), `voice-hud-check-${Date.now().toString(36)}`)));
const VIEWPORTS = (opt("--viewports", "1440x900,1920x1080,1280x720,390x844"))
  .split(",")
  .map((s) => s.split("x").map(Number))
  .map(([width, height]) => ({ width, height }));
const SETTLE = Number(opt("--settle", "6000"));

export function resolveAuth() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(os.homedir(), ".infinibot", "infinibot.json"), "utf8"));
    const a = cfg.gateway?.auth ?? {};
    return { password: process.env.INFINIBOT_GATEWAY_PASSWORD || a.password || "", token: a.token || "" };
  } catch {
    return { password: process.env.INFINIBOT_GATEWAY_PASSWORD || "", token: "" };
  }
}

const TYPES = {
  ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css",
  ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
  ".wasm": "application/wasm", ".woff2": "font/woff2", ".woff": "font/woff", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".mp3": "audio/mpeg", ".onnx": "application/octet-stream", ".ico": "image/x-icon",
};

/** Same contract as src/verification/visual/runner-cli.ts startStaticServer. */
export function serve(root, gatewayHttp, auth) {
  const rootAbs = path.resolve(root);
  const target = new URL(gatewayHttp);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(u.pathname);
    const i = p.indexOf("/assets/");
    const rel = i >= 0 ? p.slice(i + 1) : p.slice(1);
    const file = path.join(rootAbs, rel);
    if (file.startsWith(rootAbs) && existsSync(file) && statSync(file).isFile()) {
      res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
      return;
    }
    const looksLikeApi = p.startsWith("/api/") || p.startsWith("/avatar") || (path.extname(p) !== "" && i < 0);
    if (!looksLikeApi) {
      res.setHeader("Content-Type", "text/html");
      createReadStream(path.join(rootAbs, "index.html")).pipe(res);
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string" && !["host", "origin", "referer", "cookie"].includes(k)) headers[k] = v;
    const secret = auth.token || auth.password;
    if (secret) headers.authorization = `Bearer ${secret}`;
    headers["x-infinibot-request"] = "1";
    const up = http.request(
      { hostname: target.hostname, port: target.port || 80, path: `${u.pathname}${u.search}`, method: req.method, headers: { ...headers, host: target.host } },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  });
  const sockets = new Set();
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const lk = raw[i].toLowerCase();
        if (lk === "host") lines.push(`Host: ${target.host}`);
        else if (lk === "origin") lines.push(`Origin: ${target.origin}`);
        else if (lk !== "cookie") lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const s of [socket, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); } });
    });
  });
}

/** Page-side: collect HUD regions (shadow-piercing). */
const COLLECT = `(() => {
  const out = [];
  const visit = (root, depth) => {
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      const region = el.getAttribute && el.getAttribute("data-hud-region");
      if (region) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const visible = cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.width > 0 && r.height > 0;
        out.push({ region, visible, x: r.x, y: r.y, w: r.width, h: r.height,
          // a region may opt out of the "inside viewport" rule only when it is the decorative orb halo
          text: (el.innerText || "").replace(/\\s+/g, " ").slice(0, 80) });
      }
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
    }
  };
  visit(document, 0);
  // App chrome the HUD must stay clear of.
  const deep = (sel) => { const v = (root) => { const h = root.querySelector(sel); if (h) return h; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const r = v(el.shadowRoot); if (r) return r; } return null; }; return v(document); };
  const tb = deep(".topbar");
  const ph = deep("voice-hud-panels");
  if (ph) out.push({ region: "__vars", visible: false, x: 0, y: 0, w: 0, h: 0, text: ph.getAttribute("style") || "" });
  if (tb) { const r = tb.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push({ region: "topbar", visible: true, x: r.x, y: r.y, w: r.width, h: r.height, text: "" }); }
  // The orb must actually render: a sized canvas inside the orb region.
  const cv = deep(".blob-host canvas");
  const cr = cv ? cv.getBoundingClientRect() : null;
  out.push({ region: "__orbCanvas", visible: false, x: cr?.x ?? 0, y: cr?.y ?? 0, w: cr?.width ?? 0, h: cr?.height ?? 0, text: "" });
  return out;
})()`;

/** Page-side audit: every visible positioned element under the HUD hosts. */
const AUDIT_JS = `(() => {
  const hosts = ["voice-floating-hud","voice-controls-dock","voice-edge-hud","voice-live-pipeline","voice-claude-terminal","voice-hud-insights","voice-hud-panels"];
  const found = [];
  const deep = (root, fn) => { for (const el of root.querySelectorAll("*")) { fn(el); if (el.shadowRoot) deep(el.shadowRoot, fn); } };
  deep(document, (el) => { if (hosts.includes(el.tagName.toLowerCase())) found.push(el); });
  const res = [];
  for (const host of found) {
    const hr = host.getBoundingClientRect();
    res.push({ host: host.tagName.toLowerCase(), self: true, x: hr.x, y: hr.y, w: hr.width, h: hr.height });
    if (!host.shadowRoot) continue;
    for (const el of host.shadowRoot.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (!["fixed","absolute"].includes(cs.position)) continue;
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      res.push({ host: host.tagName.toLowerCase(), tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0,60),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        text: (el.innerText||"").replace(/\\s+/g," ").slice(0,90) });
    }
  }
  return res;
})()`;

const TAB_COUNT = `(() => { const h = (function f(root){ const x = root.querySelector("voice-hud-panels"); if (x) return x; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const r = f(el.shadowRoot); if (r) return r; } return null; })(document); return h?.shadowRoot?.querySelectorAll(".tab").length ?? 0; })()`;
const CLICK_TAB = (i) => {
  const f = (root) => { const x = root.querySelector("voice-hud-panels"); if (x) return x; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const r = f(el.shadowRoot); if (r) return r; } return null; };
  f(document)?.shadowRoot?.querySelectorAll(".tab")[i]?.click();
};

const intersects = (a, b) => {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ix > 0.5 && iy > 0.5 ? { ix, iy } : null;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const auth = resolveAuth();
  let srv = null;
  let base = GW;
  if (SERVE) {
    if (!existsSync(path.join(SERVE, "index.html"))) throw new Error(`${SERVE}/index.html missing — build first`);
    srv = await serve(SERVE, GW, auth);
    base = srv.url;
  }
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: ["/opt/google/chrome/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(existsSync),
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage", "--use-fake-ui-for-media-stream"],
  });
  let failures = 0;
  const report = [];
  try {
    for (const vp of VIEWPORTS) {
      const name = `${vp.width}x${vp.height}`;
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
      await page.setViewport({ ...vp, deviceScaleFactor: 1, isMobile: vp.width < 600, hasTouch: vp.width < 600 });
      await page.evaluateOnNewDocument((s) => {
        try {
          const KEY = "infinibot.control.settings.v1";
          const prev = JSON.parse(localStorage.getItem(KEY) || "{}");
          localStorage.setItem(KEY, JSON.stringify({ ...prev, ...s }));
          sessionStorage.setItem("infinibot.profiles.gatePassed", "1");
          localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
          localStorage.setItem("voice-chat:floatingHud", "1");
        } catch {}
        const hide = "learn-missions-panel,learn-mission-card,proactive-overlay-host,proactive-popups,proactive-toast,proactive-presenter,proactive-lightbox,proactive-modal,live-action-toast{display:none!important}";
        const add = () => { const st = document.createElement("style"); st.textContent = hide; (document.head || document.documentElement).appendChild(st); };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
      }, { gatewayUrl: srv ? base.replace(/^http/, "ws") : GW.replace(/^http/, "ws"), password: auth.password, token: auth.token, theme: "dark", navCollapsed: vp.width < 800 });
      await page.goto(`${base}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await new Promise((r) => setTimeout(r, SETTLE));
      const shot = path.join(OUT, `voice-hud__${name}.png`);
      await page.screenshot({ path: shot });
      const entry = { viewport: name, screenshot: shot, pageErrors: errors };
      if (AUDIT) {
        entry.audit = await page.evaluate(AUDIT_JS);
      } else {
        const check = (regions, label) => {
          const vis = regions.filter((r) => r.visible);
          const problems = [];
          const orb = vis.find((r) => r.region === "orb");
          if (!orb) problems.push("orb region not found/visible");
          const canvas = regions.find((r) => r.region === "__orbCanvas");
          if (!canvas || canvas.w < 60 || canvas.h < 60) problems.push("orb canvas missing or not sized");
          else if (orb && !intersects(canvas, orb)) problems.push("orb canvas is outside the orb region");
          if (vis.filter((r) => !["orb", "topbar", "dock", "tabs"].includes(r.region)).length < 1) problems.push(`no panels visible`);
          for (const r of vis) {
            if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > vp.width + 0.5 || r.y + r.h > vp.height + 0.5)
              problems.push(`${r.region} outside viewport (${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)})`);
          }
          for (let i = 0; i < vis.length; i++)
            for (let j = i + 1; j < vis.length; j++) {
              const hit = intersects(vis[i], vis[j]);
              if (hit) problems.push(`${vis[i].region} overlaps ${vis[j].region} by ${Math.round(hit.ix)}x${Math.round(hit.iy)}px`);
            }
          console.log(`[${label}] ${problems.length ? "FAIL" : "PASS"} ${vis.length} regions: ${vis.map((r) => r.region).join(", ")}${problems.length ? `\n  - ${problems.join("\n  - ")}` : ""}`);
          return { regions: vis.map((r) => `${r.region}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`), problems };
        };
        const collected = await page.evaluate(COLLECT);
        entry.hudVars = collected.find((r) => r.region === "__vars")?.text ?? null;
        const first = check(collected, name);
        entry.regions = first.regions;
        entry.problems = first.problems;
        failures += first.problems.length;
        // Narrow layout: every panel must be reachable through its tab and
        // still obey the same contract once shown.
        const tabCount = await page.evaluate(TAB_COUNT);
        const seen = new Set();
        for (let t = 0; t < tabCount; t++) {
          await page.evaluate(CLICK_TAB, t);
          await new Promise((r) => setTimeout(r, 350));
          const res = check(await page.evaluate(COLLECT), `${name} tab ${t + 1}/${tabCount}`);
          for (const r of res.regions) seen.add(r.split("@")[0]);
          failures += res.problems.length;
          entry.problems.push(...res.problems.map((p) => `tab ${t + 1}: ${p}`));
          const tabShot = path.join(OUT, `voice-hud__${name}__tab${t + 1}.png`);
          await page.screenshot({ path: tabShot });
        }
        if (tabCount) {
          const missing = ["call", "transcript", "agents", "today", "projects", "system", "actions"].filter((id) => !seen.has(id));
          if (missing.length) {
            failures += 1;
            entry.problems.push(`panels never shown via tabs: ${missing.join(", ")}`);
            console.log(`[${name}] FAIL panels never shown via tabs: ${missing.join(", ")}`);
          }
        }
      }
      report.push(entry);
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv?.close();
  }
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(OUT, "report.json")}`);
  if (!AUDIT && failures) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(2); });
