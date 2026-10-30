/**
 * visual_verify child process — runs OUTSIDE the gateway so a browser crash
 * can never take the gateway down.
 *
 *   node dist/verification/visual/runner-cli.js <config.json>
 *
 * Reads a {@link VisualRunConfig}, optionally serves a worktree's
 * `dist/control-ui` on a free loopback port (SPA fallback, `/assets/` at any
 * depth like src/gateway/control-ui.ts, and `/api/*` proxied to the target
 * gateway with the credential injected), drives headless Chrome through every
 * route × viewport × theme, and writes `report.json` next to the screenshots.
 *
 * Handles the setup every agent used to rediscover:
 *   - gateway auth in localStorage `infinibot.control.settings.v1`
 *   - sessionStorage `infinibot.profiles.gatePassed=1` (profile picker)
 *   - WebGL via SwiftShader (--use-gl=angle --use-angle=swiftshader …)
 *   - hides proactive / missions / toast overlays that cover the view
 *   - captures console errors, page exceptions, failed requests, failed RPCs
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { isBenignConsoleMessage } from "../console-noise.js";
import net, { type AddressInfo } from "node:net";
import path from "node:path";

export interface VisualAction {
  /** click | type | press | wait | scroll | hover | eval */
  type: "click" | "type" | "press" | "wait" | "scroll" | "hover" | "eval";
  /** CSS selector; pierces shadow roots (searched depth-first). */
  selector?: string;
  text?: string;
  key?: string;
  ms?: number;
  /** eval: JS expression evaluated in the page. */
  script?: string;
  y?: number;
}

export interface VisualCrop {
  name: string;
  /** Selector (shadow-piercing) to crop to, or an explicit clip. */
  selector?: string;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface VisualRunConfig {
  outDir: string;
  routes: string[];
  viewports: Array<{ width: number; height: number; name?: string }>;
  themes: string[];
  /** Static dir to serve (worktree dist/control-ui). Omit to use `baseUrl` directly. */
  serveDir?: string | null;
  /** Base URL to load when not serving (live gateway http origin). */
  baseUrl?: string | null;
  /** Gateway WS URL the page should connect to. */
  gatewayUrl: string;
  /** Gateway HTTP origin for the /api proxy. */
  gatewayHttp: string;
  password?: string;
  token?: string;
  actions?: VisualAction[];
  crops?: VisualCrop[];
  waitFor?: string | null;
  settleMs?: number;
  chromePath?: string | null;
  hideSelectors?: string[];
  fullPage?: boolean;
}

export interface VisualShot {
  route: string;
  viewport: string;
  theme: string;
  path: string;
  crops: Array<{ name: string; path: string }>;
  consoleErrors: string[];
  /** Headless GPU/GL driver chatter and similar noise — not counted as errors. */
  benignConsole?: string[];
  pageErrors: string[];
  failedRequests: string[];
  failedRpcs: Array<{ method: string; error: string }>;
  finalUrl: string;
  waitForFound: boolean | null;
  error?: string;
}

export interface VisualRunReport {
  ok: boolean;
  base: string;
  served: boolean;
  shots: VisualShot[];
  startedAt: number;
  finishedAt: number;
  error?: string;
}

const DEFAULT_HIDE = [
  "learn-missions-panel",
  "learn-mission-card",
  "proactive-overlay-host",
  "proactive-popups",
  "proactive-toast",
  "proactive-presenter",
  "proactive-lightbox",
  "proactive-modal",
  "live-action-toast",
];

const TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".onnx": "application/octet-stream",
};

export function startStaticServer(
  root: string,
  gatewayHttp: string,
  auth: { password?: string; token?: string },
): Promise<{ url: string; close: () => void }> {
  const rootAbs = path.resolve(root);
  const target = new URL(gatewayHttp);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(u.pathname);
    const i = p.indexOf("/assets/");
    const rel = i >= 0 ? p.slice(i + 1) : p.slice(1);
    const file = path.join(rootAbs, rel);
    const isFile = file.startsWith(rootAbs) && existsSync(file) && statSync(file).isFile();
    if (isFile) {
      res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
      return;
    }
    const looksLikeApi =
      p.startsWith("/api/") || p.startsWith("/avatar") || (path.extname(p) !== "" && i < 0);
    if (!looksLikeApi) {
      res.setHeader("Content-Type", "text/html");
      createReadStream(path.join(rootAbs, "index.html")).pipe(res);
      return;
    }
    // Proxy to the gateway with the credential injected.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && !["host", "origin", "referer", "cookie"].includes(k))
        headers[k] = v;
    }
    const secret = auth.token || auth.password;
    if (secret) headers.authorization = `Bearer ${secret}`;
    headers["x-infinibot-request"] = "1";
    const proxied = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${u.pathname}${u.search}`,
        method: req.method,
        headers: { ...headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    proxied.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`proxy error: ${err.message}`);
    });
    req.pipe(proxied);
  });
  // WebSocket upgrades are tunnelled to the gateway too, so the page is fully
  // same-origin: the gateway's HTTP gate sends no CORS headers (by design), so a
  // cross-origin page could never mint its session or call /api.
  const sockets = new Set<net.Socket>();
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const k = raw[i];
        const lk = k.toLowerCase();
        if (lk === "host") lines.push(`Host: ${target.host}`);
        else if (lk === "origin") lines.push(`Origin: ${target.origin}`);
        else if (lk === "cookie") continue;
        else lines.push(`${k}: ${raw[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const s of [socket as net.Socket, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

function resolveChrome(explicit?: string | null): string | undefined {
  const candidates = [
    explicit,
    process.env.INFINIBOT_VISUAL_CHROME,
    "/opt/google/chrome/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!));
}

/** Depth-first, shadow-piercing querySelector as page-side source. */
const DEEP_QUERY = `(sel) => {
  const visit = (root) => {
    const hit = root.querySelector ? root.querySelector(sel) : null;
    if (hit) return hit;
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) { if (el.shadowRoot) { const r = visit(el.shadowRoot); if (r) return r; } }
    return null;
  };
  return visit(document);
}`;

function slug(s: string): string {
  return (
    s
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "root"
  );
}

export async function runVisual(config: VisualRunConfig): Promise<VisualRunReport> {
  const startedAt = Date.now();
  mkdirSync(config.outDir, { recursive: true });
  let server: { url: string; close: () => void } | null = null;
  let base = (config.baseUrl ?? "").replace(/\/+$/, "");
  const shots: VisualShot[] = [];
  // Dynamic import keeps puppeteer out of the gateway's module graph.
  const mod = (await import("puppeteer")) as unknown as {
    default?: { launch: Function };
    launch?: Function;
  };
  const puppeteer = (mod.default ?? mod) as { launch: (o: unknown) => Promise<any> };
  let browser: any = null;
  try {
    if (config.serveDir) {
      server = await startStaticServer(config.serveDir, config.gatewayHttp, {
        password: config.password,
        token: config.token,
      });
      base = server.url;
    }
    if (!base) throw new Error("no base URL (serveDir or baseUrl required)");
    browser = await puppeteer.launch({
      headless: true,
      executablePath: resolveChrome(config.chromePath),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
      ],
    });
    const hide = [...DEFAULT_HIDE, ...(config.hideSelectors ?? [])];
    for (const route of config.routes) {
      for (const vp of config.viewports) {
        for (const theme of config.themes) {
          const vpName = vp.name ?? `${vp.width}x${vp.height}`;
          const file = path.join(config.outDir, `${slug(route)}__${vpName}__${theme}.png`);
          const shot: VisualShot = {
            route,
            viewport: vpName,
            theme,
            path: file,
            crops: [],
            consoleErrors: [],
            pageErrors: [],
            failedRequests: [],
            failedRpcs: [],
            finalUrl: "",
            waitForFound: null,
          };
          const context = await browser.createBrowserContext();
          const page = await context.newPage();
          try {
            await page.setViewport({
              width: vp.width,
              height: vp.height,
              deviceScaleFactor: 1,
              isMobile: vp.width < 600,
              hasTouch: vp.width < 600,
            });
            page.on("console", (m: any) => {
              if (m.type() !== "error") return;
              // Keep the source URL: "Failed to load resource" lines carry no URL
              // in their text, and the benign-noise classifier needs it.
              const url = String(m.location?.()?.url ?? "");
              const raw = String(m.text());
              const text = (url && !raw.includes(url) ? `${raw} (${url})` : raw).slice(0, 400);
              if (isBenignConsoleMessage(text)) (shot.benignConsole ??= []).push(text);
              else shot.consoleErrors.push(text);
            });
            page.on("pageerror", (e: unknown) => shot.pageErrors.push(String(e).slice(0, 400)));
            page.on("requestfailed", (r: any) => {
              const url = String(r.url());
              if (!/favicon|\.map$/.test(url))
                shot.failedRequests.push(
                  `${r.failure()?.errorText ?? "failed"} ${url}`.slice(0, 300),
                );
            });
            page.on("response", (r: any) => {
              const s = r.status();
              if (s >= 400 && !/favicon|\.map$/.test(r.url()))
                shot.failedRequests.push(`HTTP ${s} ${r.url()}`.slice(0, 300));
            });
            // Failed gateway RPCs: pair WS req ids with ok:false responses.
            const cdp = await page.createCDPSession();
            await cdp.send("Network.enable");
            const pending = new Map<string, string>();
            cdp.on("Network.webSocketFrameSent", (e: any) => {
              try {
                const f = JSON.parse(e.response.payloadData);
                if (f?.type === "req" && f.id) pending.set(f.id, f.method);
              } catch {
                /* binary / non-json */
              }
            });
            cdp.on("Network.webSocketFrameReceived", (e: any) => {
              try {
                const f = JSON.parse(e.response.payloadData);
                if (f?.type === "res" && f.id) {
                  const method = pending.get(f.id) ?? "?";
                  pending.delete(f.id);
                  if (f.ok === false)
                    shot.failedRpcs.push({
                      method,
                      error: String(f.error?.message ?? "error").slice(0, 200),
                    });
                }
              } catch {
                /* ignore */
              }
            });
            const settings = {
              // Served mode: point the page at the side server (same origin; it
              // tunnels WS + /api to the gateway). Live mode: the gateway itself.
              gatewayUrl: server ? base.replace(/^http/, "ws") : config.gatewayUrl,
              password: config.password ?? "",
              token: config.token ?? "",
              theme,
              navCollapsed: vp.width < 800,
            };
            await page.evaluateOnNewDocument(
              (s: Record<string, unknown>, hideSel: string[]) => {
                try {
                  const KEY = "infinibot.control.settings.v1";
                  const prev = JSON.parse(localStorage.getItem(KEY) || "{}");
                  localStorage.setItem(KEY, JSON.stringify({ ...prev, ...s }));
                  sessionStorage.setItem("infinibot.profiles.gatePassed", "1");
                  localStorage.setItem("infinibot.profiles.gateEnabled.v1", "0");
                } catch {
                  /* storage blocked */
                }
                const css = `${hideSel.join(",")}{display:none!important}`;
                const add = () => {
                  const st = document.createElement("style");
                  st.setAttribute("data-visual-verify", "1");
                  st.textContent = css;
                  (document.head || document.documentElement).appendChild(st);
                };
                if (document.readyState === "loading")
                  document.addEventListener("DOMContentLoaded", add);
                else add();
              },
              settings,
              hide,
            );
            const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
            if (config.waitFor) {
              const deadline = Date.now() + 30_000;
              shot.waitForFound = false;
              while (Date.now() < deadline) {
                const found = await page
                  .evaluate(`(${DEEP_QUERY})(${JSON.stringify(config.waitFor)}) !== null`)
                  .catch(() => false);
                if (found) {
                  shot.waitForFound = true;
                  break;
                }
                await new Promise((r) => setTimeout(r, 400));
              }
            }
            await new Promise((r) => setTimeout(r, config.settleMs ?? 3500));
            for (const action of config.actions ?? []) {
              await runAction(page, action);
            }
            // Click away any "Continue as …" profile chooser that slipped through.
            await page
              .evaluate(() => {
                const deep = (root: ParentNode, out: Element[] = []): Element[] => {
                  root.querySelectorAll("*").forEach((n) => {
                    out.push(n);
                    if ((n as HTMLElement).shadowRoot) deep((n as HTMLElement).shadowRoot!, out);
                  });
                  return out;
                };
                const btn = deep(document).find(
                  (e) =>
                    (e.localName === "button" || e.localName === "a") &&
                    /continue as/i.test(e.textContent || ""),
                ) as HTMLElement | undefined;
                btn?.click();
              })
              .catch(() => {});
            await page.screenshot({ path: file, fullPage: config.fullPage === true });
            for (const crop of config.crops ?? []) {
              const cropFile = file.replace(/\.png$/, `__${slug(crop.name)}.png`);
              let clip = crop.clip;
              if (!clip && crop.selector) {
                clip = await page
                  .evaluate(
                    `(() => { const el = (${DEEP_QUERY})(${JSON.stringify(crop.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height) }; })()`,
                  )
                  .catch(() => null);
              }
              if (clip) {
                await page.screenshot({ path: cropFile, clip });
                shot.crops.push({ name: crop.name, path: cropFile });
              }
            }
            shot.finalUrl = page.url();
          } catch (err) {
            shot.error = err instanceof Error ? err.message : String(err);
            try {
              await page.screenshot({ path: file });
            } catch {
              /* nothing to capture */
            }
          } finally {
            await context.close().catch(() => {});
          }
          shots.push(shot);
        }
      }
    }
    return {
      ok: shots.every((s) => !s.error),
      base,
      served: Boolean(server),
      shots,
      startedAt,
      finishedAt: Date.now(),
    };
  } catch (err) {
    return {
      ok: false,
      base,
      served: Boolean(server),
      shots,
      startedAt,
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    server?.close();
  }
}

async function runAction(page: any, a: VisualAction): Promise<void> {
  const locate = async () => {
    if (!a.selector) return null;
    const handle = await page.evaluateHandle(`(${DEEP_QUERY})(${JSON.stringify(a.selector)})`);
    return handle.asElement();
  };
  switch (a.type) {
    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(a.ms ?? 1000, 30_000)));
      return;
    case "click": {
      const el = await locate();
      if (!el) throw new Error(`click: selector not found: ${a.selector}`);
      await el.click();
      await new Promise((r) => setTimeout(r, a.ms ?? 600));
      return;
    }
    case "hover": {
      const el = await locate();
      if (el) await el.hover();
      await new Promise((r) => setTimeout(r, a.ms ?? 300));
      return;
    }
    case "type": {
      const el = await locate();
      if (el) await el.focus();
      await page.keyboard.type(a.text ?? "", { delay: 5 });
      return;
    }
    case "press":
      await page.keyboard.press(a.key ?? "Enter");
      await new Promise((r) => setTimeout(r, a.ms ?? 400));
      return;
    case "scroll":
      await page.evaluate((y: number) => window.scrollTo(0, y), a.y ?? 0);
      await new Promise((r) => setTimeout(r, a.ms ?? 400));
      return;
    case "eval":
      if (a.script) await page.evaluate(a.script);
      await new Promise((r) => setTimeout(r, a.ms ?? 300));
      return;
  }
}

// ── CLI entry ───────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const cfgPath = process.argv[2];
  const config = JSON.parse(readFileSync(cfgPath, "utf8")) as VisualRunConfig;
  runVisual(config)
    .then((report) => {
      const out = path.join(config.outDir, "report.json");
      writeFileSync(out, JSON.stringify(report, null, 2));
      process.stdout.write(`${out}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(String(err?.stack ?? err));
      process.exit(1);
    });
}
