/**
 * Static asset handler for the new web-based onboarding flow.
 *
 * Serves a single self-contained HTML page at `/quickstart` that the
 * `infinibot quickstart` CLI command opens in the user's default browser.
 * The page uses the gateway's existing WebSocket RPC layer (auth.*,
 * channels.*, models.*, config.*, hooks.*, federation.*, notion.wizard.*,
 * quickstart.*, wizard.*) to drive every step end-to-end.
 *
 * Self-contained on purpose: no Vite build, no React bundle, no extra
 * pipeline. This means the quickstart can ship in any package mode
 * (npm install, single binary, packaged Mac app) without an asset rebuild.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { CODER_CATALOG } from "../agents/coder-install/catalog.js";
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "../agents/provider-model-defaults.js";

/**
 * Coders offered on the Done step when "Coding agents" was picked: the ones
 * InfiniBot can drive as sub-agents, from the same catalog Setup › Coders
 * uses. Only display fields; the install itself happens in Setup › Coders.
 */
const QUICKSTART_CODERS_JSON = JSON.stringify(
  CODER_CATALOG.filter((c) => c.backend).map((c) => ({
    id: c.id,
    name: c.name,
    vendor: c.vendor,
    monogram: c.monogram,
  })),
).replace(/</g, "\\u003c");

const QUICKSTART_PATHS = new Set(["/quickstart", "/quickstart/", "/quickstart/index.html"]);

export function handleQuickstartHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  const pathname = urlRaw.split("?")[0] ?? "";
  if (!QUICKSTART_PATHS.has(pathname)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  res.end(QUICKSTART_HTML);
  return true;
}

// Exported so the standalone setup-ui server (`src/setup-ui/page.ts`) can
// reuse the same wizard markup with a fetch-based transport instead of the
// gateway's WebSocket. The transforms it applies are listed in that module.
export const QUICKSTART_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>InfiniBot — Quickstart</title>
  <style>
    :root {
      /* Obsidian base */
      --bg: #050507; --bg-deep: #050507; --bg-elev: #101015;
      --bg-card: #121219; --bg-panel: #101015; --card: #121219;
      --line: #ffffff14; --line-strong: #ffffff1f; --hover: #ffffff0d;
      --text: #f6f5f2; --text-dim: #b6b4ad; --text-muted: #76747e;
      /* Brand gold = single interactive accent */
      --accent: #f5b542; --accent-soft: #f5b5421f; --accent-strong: #ffd278;
      --accent-deep: #d4af37; --accent-primary: #f5b542;
      --gold-grad: linear-gradient(135deg, #ffe9b0 0%, #f5b542 42%, #d4af37 100%);
      /* Atmospheric only (gradient-mesh / glow, never interactive) */
      --violet: #8b5cf6; --cyan: #54d6ff; --indigo: #4f46e5;
      /* Status */
      --ok: #5fd17a; --warn: #f5b542; --err: #ef5b5b;
      /* Glass + motion */
      --glass: linear-gradient(165deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012));
      --glass-strong: linear-gradient(165deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
      --glow-gold: 0 0 0 1px rgba(245,181,66,0.18), 0 18px 50px -12px rgba(245,181,66,0.22);
      --radius: 14px; --radius-lg: 22px;
      --shadow: 0 24px 80px -24px rgba(0,0,0,0.7);
      --font-display: "Instrument Serif", ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      --font-body: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Inter", sans-serif;
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      color: var(--text);
      font-family: var(--font-body);
      font-size: 15px;
      line-height: 1.55;
      min-height: 100vh;
      background:
        radial-gradient(900px 600px at 12% -8%, rgba(245,181,66,0.10), transparent 60%),
        radial-gradient(820px 620px at 92% 4%, rgba(139,92,246,0.12), transparent 60%),
        radial-gradient(760px 700px at 78% 102%, rgba(84,214,255,0.08), transparent 60%),
        radial-gradient(ellipse at top, #0c0c12 0%, var(--bg) 60%);
      background-attachment: fixed;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    /* Solid canvas under the fixed gradients (long steps, full-page captures). */
    html { background-color: var(--bg); }
    /* Drifting atmospheric orb behind everything */
    body::before {
      content: ""; position: fixed; inset: -20vmax; z-index: 0; pointer-events: none;
      background:
        radial-gradient(36vmax 36vmax at 22% 26%, rgba(139,92,246,0.10), transparent 62%),
        radial-gradient(30vmax 30vmax at 80% 70%, rgba(84,214,255,0.08), transparent 62%);
      filter: blur(20px);
      animation: meshDrift 26s ease-in-out infinite alternate;
    }
    @keyframes meshDrift {
      0%   { transform: translate3d(0,0,0) scale(1); }
      100% { transform: translate3d(2.5%, -2%, 0) scale(1.08); }
    }
    .layout, .toast { position: relative; z-index: 1; }
    a { color: var(--accent); }
    button {
      font-family: inherit; font-size: 14px;
      cursor: pointer;
      border-radius: var(--radius);
      border: 1px solid var(--line-strong);
      background: var(--bg-elev);
      color: var(--text);
      padding: 10px 16px;
      transition: transform 90ms ease, background 120ms ease, border 120ms ease;
    }
    button:hover { background: #20202a; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.primary {
      background: var(--accent); color: #1a1408; border-color: var(--accent-strong);
      font-weight: 600;
    }
    button.primary:hover { background: var(--accent-strong); }
    button.ghost { background: transparent; }
    button.danger { background: #2a1414; border-color: #4a1d1d; color: #ff9c9c; }
    input[type=text], input[type=password], textarea, select {
      width: 100%;
      background: #0e0e14;
      color: var(--text);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      padding: 10px 12px;
      font-family: inherit; font-size: 14px;
      outline: none;
      transition: border 120ms ease;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); }
    label { display: block; font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 6px 0; }

    .layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: 100vh;
    }
    aside {
      border-right: 1px solid var(--line-strong);
      background: linear-gradient(180deg, #14141c 0%, #0e0e14 100%);
      padding: 28px 22px;
      display: flex; flex-direction: column;
    }
    .brand {
      font-weight: 700; letter-spacing: 0.02em; font-size: 18px; margin-bottom: 4px;
    }
    .brand-sub { color: var(--text-muted); font-size: 13px; margin-bottom: 32px; }
    .step-list { list-style: none; padding: 0; margin: 0; flex: 1; }
    .step-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-radius: 10px;
      cursor: pointer; user-select: none;
      color: var(--text-dim);
    }
    .step-item:hover { background: #1c1c25; color: var(--text); }
    .step-item.active { background: var(--accent-soft); color: var(--accent-strong); }
    .step-item.complete { color: var(--ok); }
    .step-dot {
      width: 22px; height: 22px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600;
      background: #2a2a36; color: var(--text-dim);
      flex-shrink: 0;
    }
    .step-item.active .step-dot { background: var(--accent); color: #1a1408; }
    .step-item.complete .step-dot { background: var(--ok); color: #0a1f10; }
    .footer-status { font-size: 12px; color: var(--text-muted); padding-top: 12px; border-top: 1px solid var(--line-strong); }

    main {
      padding: 48px 64px;
      max-width: 880px;
      width: 100%;
    }
    .h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px 0; letter-spacing: -0.02em; }
    .h2 { font-size: 18px; font-weight: 600; margin: 0 0 8px 0; }
    .lead { color: var(--text-dim); margin: 0 0 28px 0; }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-lg);
      padding: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 16px;
    }
    .row { display: flex; gap: 12px; }
    .row > * { flex: 1; }
    .actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
    .actions.split { justify-content: space-between; }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; padding: 3px 9px; border-radius: 99px;
      background: #20202a; color: var(--text-dim);
      border: 1px solid var(--line-strong);
    }
    .pill.ok { background: #14201a; color: var(--ok); border-color: #1f3322; }
    .pill.err { background: #201414; color: var(--err); border-color: #3d1d1d; }
    .pill.warn { background: #201d14; color: var(--warn); border-color: #3d3318; }
    .check {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 10px 0; border-bottom: 1px solid var(--line-strong);
    }
    .check:last-child { border-bottom: 0; }
    .check-icon { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
    .check-icon.ok { background: var(--ok); color: #0a1f10; }
    .check-icon.err { background: var(--err); color: #2a0a0a; }
    .check-icon.run { background: var(--accent); color: #1a1408; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.5; } }
    .hint { color: var(--text-muted); font-size: 13px; margin-top: 6px; }
    .ok-pill, .warn-pill, .idle-pill { display: inline-block; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; border: 1px solid rgba(255,255,255,0.14); }
    .ok-pill { color: #6ee7a8; border-color: rgba(110,231,168,0.45); background: rgba(110,231,168,0.1); }
    .warn-pill { color: #f6c56b; border-color: rgba(246,197,107,0.4); }
    .idle-pill { color: var(--text-muted); }
    .ok-msg { color: #6ee7a8; font-size: 13px; margin-top: 8px; }
    .br-steps { margin: 12px 0 0; padding-left: 20px; line-height: 1.9; }
    .br-code { font-size: 22px; letter-spacing: 0.12em; padding: 6px 12px; }
    .ai-list { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 8px; }
    .mono { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    #br-body, #ai-body { min-width: 0; max-width: 100%; }
    #br-body pre, #ai-body pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
    #br-body .actions, #ai-body .actions, .actions.split { flex-wrap: wrap; gap: 8px; }
    button.small { padding: 4px 10px; font-size: 12px; }
    .err-msg { color: var(--err); font-size: 13px; margin-top: 6px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .channel-tile {
      display: flex; align-items: center; gap: 12px;
      padding: 14px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: var(--bg-elev);
      cursor: pointer; transition: all 120ms ease;
    }
    .channel-tile:hover { border-color: var(--accent); background: #20202a; }
    .channel-tile.selected { border-color: var(--accent); background: var(--accent-soft); }
    .channel-emoji { font-size: 22px; }
    .channel-name { font-weight: 600; }
    .channel-desc { color: var(--text-dim); font-size: 12px; }
    .page-list { max-height: 360px; overflow-y: auto; padding-right: 4px; }
    .page-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px;
      border-radius: 10px; cursor: pointer;
      transition: background 100ms ease;
    }
    .page-item:hover { background: #1c1c25; }
    .page-item.selected { background: var(--accent-soft); border: 1px solid var(--accent); }
    .page-emoji { font-size: 20px; }
    .page-title { flex: 1; }
    .page-meta { font-size: 12px; color: var(--text-muted); }
    code, pre {
      font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      background: #0a0a0e;
      padding: 1px 5px;
      border-radius: 4px;
    }
    pre {
      padding: 10px;
      border-radius: 10px;
      overflow: auto;
      border: 1px solid var(--line-strong);
    }
    .toast {
      position: fixed; right: 20px; bottom: 20px; z-index: 9999;
      background: var(--bg-card);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      padding: 12px 16px;
      box-shadow: var(--shadow);
      max-width: 320px;
      transform: translateY(20px); opacity: 0;
      transition: transform 180ms ease, opacity 180ms ease;
      pointer-events: none;
    }
    .toast.visible { transform: translateY(0); opacity: 1; pointer-events: auto; }
    .toast.err { border-color: #4a1d1d; }
    .summary-list { list-style: none; padding: 0; margin: 0; }
    .summary-list li { padding: 8px 0; border-bottom: 1px solid var(--line-strong); display: flex; justify-content: space-between; }
    .summary-list li:last-child { border-bottom: 0; }
    .summary-key { color: var(--text-dim); }
    .summary-val { color: var(--text); font-weight: 500; }
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid var(--text-muted);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: -2px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .kanban-edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 6px; }
    .kanban-edit-grid > div > label { color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .option-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
    .option-row { display: grid; grid-template-columns: 36px 1fr auto; gap: 6px; align-items: center; }
    .option-row input[type="color"] { width: 36px; height: 32px; border: 1px solid var(--line-strong); background: transparent; padding: 0; border-radius: 4px; }
    .option-row input[type="text"] { width: 100%; }
    .option-row button { padding: 4px 10px; }
    .import-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px; border-bottom: 1px solid var(--line-strong); cursor: pointer; }
    .import-row:last-child { border-bottom: 0; }
    .import-row:hover { background: #1c1c25; }
    .import-row input[type="checkbox"] { margin-top: 4px; }
    .import-meta { flex: 1; }
    .import-title { color: var(--text); font-weight: 500; }

    /* ── Friendly onboarding steps ──────────────────────────────────────── */
    .welcome-headline { font-size: 40px; font-weight: 800; line-height: 1.15; margin-bottom: 14px; }
    .welcome-sub { font-size: 18px; color: var(--text-dim); max-width: 520px; line-height: 1.6; margin-bottom: 28px; }

    .goal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-top: 14px; }
    .goal-tile { background: var(--card); border: 2px solid var(--line-strong); border-radius: 14px; padding: 20px 18px; cursor: pointer; transition: border-color 0.15s, background 0.15s; outline: none; }
    .goal-tile:hover { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.06); }
    .goal-tile:focus-visible { box-shadow: 0 0 0 3px rgba(79,158,255,0.4); }
    .goal-tile.selected { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.1); }
    .goal-icon { font-size: 28px; display: block; margin-bottom: 10px; }
    .goal-name { font-weight: 700; font-size: 15px; margin-bottom: 5px; }
    .goal-desc { font-size: 13px; color: var(--text-dim); line-height: 1.5; }

    .provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; margin-top: 14px; }
    .provider-card { background: var(--card); border: 2px solid var(--line-strong); border-radius: 16px; padding: 20px 18px; cursor: pointer; transition: border-color 0.15s, background 0.15s; outline: none; }
    .provider-card:hover { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.06); }
    .provider-card:focus-visible { box-shadow: 0 0 0 3px rgba(79,158,255,0.4); }
    .provider-card.selected { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.1); }
    .provider-logo-wrap { width: 52px; height: 52px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-size: 24px; margin-bottom: 12px; }
    .provider-name { font-weight: 800; font-size: 16px; }
    .provider-maker { font-size: 12px; color: var(--text-muted, #8a8a9a); margin-bottom: 8px; }
    .provider-desc { font-size: 13px; color: var(--text-dim); line-height: 1.5; margin-bottom: 10px; }
    .provider-badges { display: flex; flex-wrap: wrap; gap: 6px; }

    .voice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); gap: 10px; margin-top: 8px; }
    .voice-card { background: var(--bg-panel, #151520); border: 2px solid var(--line-strong); border-radius: 12px; padding: 14px 14px; cursor: pointer; outline: none; transition: border-color 0.15s, background 0.15s; }
    .voice-card:hover { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.05); }
    .voice-card:focus-visible { box-shadow: 0 0 0 3px rgba(79,158,255,0.4); }
    .voice-card.selected { border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.1); }
    .voice-card-name { font-weight: 700; font-size: 14px; }
    .voice-card-desc { font-size: 12px; color: var(--text-dim); line-height: 1.45; margin-top: 5px; }

    .key-input-wrap { display: flex; gap: 8px; align-items: stretch; }
    .key-input-wrap input { flex: 1; font-family: monospace; font-size: 14px; letter-spacing: 0.04em; }
    .key-reveal-btn { flex-shrink: 0; padding: 0 14px; background: transparent; border: 1px solid var(--line-strong); border-radius: 8px; color: var(--text-dim); cursor: pointer; font-size: 13px; }
    .key-reveal-btn:hover { background: var(--hover); }

    .validate-ok { color: #34d399; font-size: 13px; }
    .validate-err { color: #f87171; font-size: 13px; }

    .adv-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-dim); font-size: 13px; padding: 8px 0; user-select: none; }
    .adv-toggle:hover { color: var(--text); }
    .step-separator { height: 1px; background: var(--line-strong); margin: 8px 0; }

    .done-feature { display: flex; gap: 14px; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid var(--line-strong); }
    .done-feature:last-child { border-bottom: none; }
    .done-feature-icon { font-size: 24px; flex-shrink: 0; padding-top: 2px; }

    @media (prefers-reduced-motion: reduce) {
      .goal-tile, .provider-card, .voice-card { transition: none; }
    }
    @media (max-width: 600px) {
      .welcome-headline { font-size: 28px; }
      .provider-grid, .goal-grid { grid-template-columns: 1fr 1fr; }
    }

    /* ════════ PREMIUM OVERHAUL (gold-on-obsidian glass) ════════ */
    ::selection { background: rgba(245,181,66,0.28); }
    :focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); border-radius: 8px; }

    /* ── Buttons: spring + gold gradient ── */
    button {
      border-radius: 12px;
      border: 1px solid var(--line-strong);
      background: var(--glass);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      color: var(--text); font-weight: 600;
      padding: 11px 18px;
      transition: transform .14s var(--ease-spring), box-shadow .25s var(--ease-out), background .2s, border-color .2s, color .2s;
    }
    button:hover { background: var(--glass-strong); border-color: rgba(245,181,66,0.4); transform: translateY(-1px); }
    button:active { transform: translateY(0) scale(0.975); }
    button.primary {
      background: var(--gold-grad); color: #1a1408; border: none; font-weight: 700;
      letter-spacing: 0.01em; box-shadow: var(--glow-gold);
    }
    button.primary:hover { transform: translateY(-2px); box-shadow: 0 0 0 1px rgba(245,181,66,.45), 0 26px 64px -16px rgba(245,181,66,.45); }
    button.ghost { background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; color: var(--text-dim); }
    button.ghost:hover { color: var(--text); background: var(--hover); }
    a.primary { background: var(--gold-grad); color: #1a1408; border: none; font-weight: 700; box-shadow: var(--glow-gold); text-decoration: none; display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px; border-radius: 12px; }

    /* ── Inputs: glass + gold focus ── */
    input[type=text], input[type=password], textarea, select {
      background: rgba(8,8,12,0.6);
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      transition: border-color .18s, box-shadow .18s, background .18s;
    }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: rgba(8,8,12,0.85); }
    label { color: var(--text-muted); letter-spacing: 0.09em; }

    /* ── Cards: glass + luminous edge + glow ── */
    .card {
      background: var(--glass);
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-lg);
      -webkit-backdrop-filter: blur(var(--glass-blur)); backdrop-filter: blur(var(--glass-blur));
      box-shadow: var(--shadow);
      position: relative; overflow: hidden;
    }
    .card::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
      background: linear-gradient(150deg, rgba(245,181,66,0.42), rgba(255,255,255,0.06) 30%, transparent 55%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor; mask-composite: exclude;
    }

    /* ── Sidebar glass + logo ── */
    aside {
      border-right: 1px solid var(--line-strong);
      background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012));
      -webkit-backdrop-filter: blur(22px); backdrop-filter: blur(22px);
      padding: 30px 22px; gap: 0;
    }
    .brand-row { display: flex; align-items: center; gap: 13px; margin-bottom: 22px; }
    .brand-mark { border-radius: 11px; box-shadow: 0 8px 22px -6px rgba(245,181,66,0.5); flex-shrink: 0; }
    .brand-text { line-height: 1.15; }
    .brand { font-family: var(--font-display); font-weight: 600; font-size: 22px; letter-spacing: 0.01em; background: var(--gold-grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .brand-sub { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.22em; margin-bottom: 0; }

    .progress-meter { height: 4px; border-radius: 99px; background: rgba(255,255,255,0.06); overflow: hidden; margin: 4px 2px 22px; }
    .progress-fill { height: 100%; width: 0%; border-radius: 99px; background: var(--gold-grad); box-shadow: 0 0 14px rgba(245,181,66,0.6); transition: width .5s var(--ease-out); }

    .step-item { border-radius: 11px; transition: background .16s, color .16s, transform .16s var(--ease-spring); }
    .step-item:hover { background: var(--hover); transform: translateX(2px); }
    .step-item.active { background: var(--accent-soft); color: var(--accent-strong); box-shadow: inset 0 0 0 1px rgba(245,181,66,0.25); }
    .step-dot { background: rgba(255,255,255,0.06); border: 1px solid var(--line-strong); transition: transform .25s var(--ease-spring), background .2s, box-shadow .2s; }
    .step-item.active .step-dot { background: var(--gold-grad); color: #1a1408; border: none; transform: scale(1.12); box-shadow: 0 0 0 4px var(--accent-soft), 0 0 16px rgba(245,181,66,0.55); }
    .step-item.complete .step-dot { background: var(--ok); color: #06210f; border: none; }
    .footer-status { color: var(--text-muted); }

    /* ── Main + display type ── */
    main { padding: 56px 64px; }
    .h1, .welcome-headline { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.01em; font-size: 38px; line-height: 1.1; }
    .h1 { font-size: 34px; margin-bottom: 10px; }
    .lead, .welcome-sub { color: var(--text-dim); font-size: 16px; max-width: 560px; }

    /* ── Step transition ── */
    #main > * { will-change: transform, opacity; }
    .step-enter { animation: stepEnter .34s var(--ease-out) both; }
    @keyframes stepEnter { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }

    /* ── Selectable tiles (goals/providers/voice) glass-up ── */
    .goal-tile, .provider-card, .voice-card { background: var(--glass); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid var(--line-strong); transition: border-color .18s, background .18s, transform .18s var(--ease-spring), box-shadow .25s; }
    .goal-tile:hover, .provider-card:hover, .voice-card:hover { border-color: rgba(245,181,66,0.45); background: var(--glass-strong); transform: translateY(-3px); box-shadow: 0 18px 40px -20px rgba(0,0,0,0.7); }
    .goal-tile.selected, .provider-card.selected, .voice-card.selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: var(--glow-gold); }
    .goal-tile:focus-visible, .provider-card:focus-visible, .voice-card:focus-visible { box-shadow: 0 0 0 3px var(--accent-soft); border-color: var(--accent); }
    .provider-logo-wrap { background: var(--glass-strong); border: 1px solid var(--line-strong); }

    /* ── Pills / checks polish ── */
    .pill { background: var(--glass); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
    .check-icon.ok { box-shadow: 0 0 12px rgba(95,209,122,0.5); }
    .spinner { border-top-color: var(--accent); }

    /* ════════ HERO (welcome) ════════ */
    .hero { min-height: calc(100vh - 112px); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 4px; }
    .hero-logo-wrap { position: relative; width: 168px; height: 168px; display: grid; place-items: center; margin-bottom: 30px; }
    .hero-halo { position: absolute; inset: -22%; border-radius: 50%; background: radial-gradient(circle, rgba(245,181,66,0.32), rgba(139,92,246,0.14) 45%, transparent 70%); filter: blur(8px); animation: haloPulse 4.5s ease-in-out infinite; }
    @keyframes haloPulse { 0%,100% { transform: scale(0.92); opacity: 0.75; } 50% { transform: scale(1.06); opacity: 1; } }
    .hero-logo { position: relative; width: 148px; height: 148px; filter: drop-shadow(0 20px 40px rgba(245,181,66,0.4)); animation: heroFloat 6s ease-in-out infinite; }
    @keyframes heroFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-9px); } }
    .hero-orbit { transform-origin: 256px 276px; animation: orbitSpin 18s linear infinite; }
    @keyframes orbitSpin { to { transform: rotate(360deg); } }
    .hero-crystal { transform-origin: 256px 276px; animation: crystalPulse 3s ease-in-out infinite; }
    @keyframes crystalPulse { 0%,100% { opacity: 0.85; } 50% { opacity: 1; transform: scale(1.06); } }
    .hero-eyebrow { font-size: 12px; letter-spacing: 0.34em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; opacity: 0.9; }
    .hero-title { font-family: var(--font-display); font-weight: 600; font-size: clamp(40px, 6vw, 68px); line-height: 1.02; letter-spacing: -0.015em; margin: 0 0 16px; }
    .hero-title .grad { background: var(--gold-grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .hero-sub { color: var(--text-dim); font-size: 18px; max-width: 480px; margin: 0 auto 34px; line-height: 1.6; }
    .hero-cta { font-size: 16px; padding: 15px 34px; border-radius: 14px; }
    .hero-cta-row { display: flex; gap: 14px; align-items: center; justify-content: center; flex-wrap: wrap; }

    /* ════════ VOICE: premium mode cards + mic meter ════════ */
    .voice-grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
    .voice-card { padding: 18px 16px 16px; border-radius: 16px; display: flex; flex-direction: column; gap: 6px; }
    .voice-card-badge { align-self: flex-start; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; padding: 3px 9px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-strong); border: 1px solid rgba(245,181,66,0.3); margin-bottom: 8px; }
    .voice-card-icon { font-size: 22px; }
    .mic-meter-wrap { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border-radius: 12px; background: rgba(8,8,12,0.5); border: 1px solid var(--line-strong); }
    .mic-meter-label { font-size: 11px; color: var(--text-muted); white-space: nowrap; text-transform: uppercase; letter-spacing: 0.08em; }
    .mic-meter { flex: 1; display: flex; align-items: flex-end; gap: 3px; height: 24px; }
    .mic-bar { flex: 1; min-height: 3px; border-radius: 2px; background: linear-gradient(180deg, var(--accent-strong), var(--accent-deep)); opacity: 0.25; transform-origin: bottom; transition: transform .07s linear, opacity .07s linear; }
    .mic-meter-btn { font-size: 12px; padding: 6px 12px; }

    /* ════════ DONE: animated checkmark + chips ════════ */
    .done-check { width: 84px; height: 84px; margin: 4px 0 22px; }
    .done-check circle { fill: none; stroke: var(--accent); stroke-width: 5; stroke-dasharray: 264; stroke-dashoffset: 264; animation: dashCircle .7s var(--ease-out) forwards; filter: drop-shadow(0 0 12px rgba(245,181,66,0.6)); }
    .done-check path { fill: none; stroke: var(--accent-strong); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 80; stroke-dashoffset: 80; animation: dashCheck .45s var(--ease-out) .55s forwards; }
    @keyframes dashCircle { to { stroke-dashoffset: 0; } }
    @keyframes dashCheck { to { stroke-dashoffset: 0; } }
    .summary-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 4px; }
    .summary-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; padding: 7px 13px; border-radius: 99px; background: var(--glass); border: 1px solid var(--line-strong); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
    .summary-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }

    /* ── Responsive: collapse rail on narrow ── */
    /* Telegram + Import steps */
    .tg-steps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .tg-step { font-size: 11.5px; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--line-strong); color: var(--text-muted); }
    .tg-step.on { color: var(--text); border-color: var(--accent); }
    .tg-step.done { color: var(--ok, #34d399); }
    .tg-howto { margin: 6px 0 14px; padding-left: 20px; color: var(--text-dim); font-size: 13.5px; line-height: 1.7; }
    .tg-ok { color: var(--ok, #34d399); font-size: 14px; margin-bottom: 12px; overflow-wrap: anywhere; }
    .tg-capture { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .tg-qr { width: 148px; height: 148px; border-radius: 12px; background: #fff; padding: 6px; }
    a.tg-open { display: inline-block; padding: 10px 16px; border-radius: 10px; text-decoration: none; font-weight: 600; background: var(--gold-grad, var(--accent)); color: #111; }
    .tg-manual { margin-top: 12px; }
    .tg-manual summary { cursor: pointer; }
    .tg-policy { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
    .tg-opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 12px; cursor: pointer; }
    .tg-opt input { margin-top: 4px; }
    label.tg-opt, label.imp-check, label.import-row { text-transform: none; letter-spacing: normal; font-size: 14px; color: var(--text); font-weight: 400; }
    label.tg-opt strong { font-weight: 600; }
    label.tg-opt .hint, label.imp-check { color: var(--text-dim); }
    .imp-src { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-bottom: 16px; }
    .imp-seg { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; border: 1px solid var(--line-strong); border-radius: 11px; margin-bottom: 12px; }
    .imp-seg-btn { background: transparent; border: 0; padding: 6px 12px; border-radius: 8px; color: var(--text-dim); cursor: pointer; font-size: 13px; }
    .imp-seg-btn.on { background: var(--glass-strong, rgba(255,255,255,0.08)); color: var(--text); }
    .imp-check { display: flex; gap: 8px; align-items: center; margin-top: 12px; font-size: 13.5px; color: var(--text-dim); }
    .imp-job { padding: 10px 0; border-bottom: 1px solid var(--line-strong); }
    .imp-job:last-child { border-bottom: 0; }
    .imp-job-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; overflow-wrap: anywhere; }
    .imp-job .progress-meter { margin: 4px 0 6px; }
    .imp-undo { margin-top: 6px; font-size: 12.5px; padding: 5px 10px; }
    .imp-check code, .tg-howto code { white-space: nowrap; }
    #tg-stage code, #imp-body code { font-size: 12px; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,0.07); }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; align-content: start; }
      aside { flex-direction: row; align-items: center; flex-wrap: wrap; padding: 16px 20px; gap: 14px; border-right: none; border-bottom: 1px solid var(--line-strong); }
      .brand-row { margin-bottom: 0; }
      .progress-meter { order: 5; flex-basis: 100%; margin: 6px 0 0; }
      .step-list { display: none; }
      .footer-status { display: none; }
      main { padding: 32px 24px 64px; }
      .hero { min-height: calc(100vh - 200px); }
    }
    @media (max-width: 480px) {
      main { padding: 24px 18px 56px; }
      .h1, .welcome-headline { font-size: 28px; }
    }

    /* ── Reduced motion: kill non-essential animation ── */
    @media (prefers-reduced-motion: reduce) {
      body::before, .hero-halo, .hero-logo, .hero-orbit, .hero-crystal { animation: none !important; }
      .step-enter { animation: none !important; }
      .done-check circle, .done-check path { animation: none !important; stroke-dashoffset: 0 !important; }
      *, *::before, *::after { transition-duration: 0.001ms !important; }
      .goal-tile:hover, .provider-card:hover, .voice-card:hover, button:hover, .step-item:hover { transform: none !important; }
    }

  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <div class="brand-row">
        <svg class="brand-mark" viewBox="0 0 512 512" width="34" height="34" aria-hidden="true"><defs><linearGradient id="bgS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101014"/><stop offset="1" stop-color="#050507"/></linearGradient><linearGradient id="goldS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d77a"/><stop offset="1" stop-color="#d4af37"/></linearGradient></defs><rect x="16" y="16" width="480" height="480" rx="120" fill="url(#bgS)"/><rect x="16" y="16" width="480" height="480" rx="120" fill="none" stroke="#d4af37" stroke-opacity="0.55" stroke-width="10"/><ellipse cx="256" cy="276" rx="186" ry="76" fill="none" stroke="#d4af37" stroke-opacity="0.65" stroke-width="12" stroke-dasharray="36 22"/><polygon points="256,150 412,276 256,402 100,276" fill="#14110a" stroke="url(#goldS)" stroke-width="16" stroke-linejoin="round"/><polygon points="256,224 308,276 256,328 204,276" fill="url(#goldS)"/><circle cx="430" cy="252" r="16" fill="url(#goldS)"/></svg>
        <div class="brand-text">
          <div class="brand">InfiniBot</div>
          <div class="brand-sub">Quickstart</div>
        </div>
      </div>
      <div class="progress-meter" aria-hidden="true"><div class="progress-fill" id="progress-fill"></div></div>
      <ul id="step-list" class="step-list"></ul>
      <div id="footer-status" class="footer-status">Connecting…</div>
    </aside>
    <main id="main"></main>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    /* Early global error overlay — installed in its OWN script tag, BEFORE the
       main wizard script, so it survives two ways the main script can die:
         1. a runtime ReferenceError (e.g. a function called out of its closure,
            the original "readAuthFromHash is not defined" bug), and
         2. a parse/syntax error in the main script (a handler installed inside
            the same <script> would never run — this one already has).
       It also survives the standalone setup-ui transform (src/setup-ui/page.ts),
       which rewrites only the WebSocket-RPC block lower down, not this tag.
       Errors are SHOWN inline so users + agents can debug without devtools. */
    (function () {
      function ensureBar() {
        var bar = document.getElementById("qs-error-overlay");
        if (bar) return bar;
        bar = document.createElement("div");
        bar.id = "qs-error-overlay";
        bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;max-height:42vh;overflow:auto;background:#2a0d10;color:#ffd7d7;border-bottom:2px solid #ff5b6a;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:10px 40px 10px 14px;box-shadow:0 6px 24px rgba(0,0,0,0.55);white-space:pre-wrap";
        var close = document.createElement("button");
        close.textContent = "×";
        close.setAttribute("aria-label", "Dismiss errors");
        close.style.cssText = "position:absolute;top:6px;right:10px;background:transparent;border:0;color:#ffd7d7;font-size:20px;line-height:1;cursor:pointer";
        close.onclick = function () { bar.remove(); };
        bar.appendChild(close);
        var body = document.createElement("div");
        body.id = "qs-error-overlay-body";
        bar.appendChild(body);
        (document.body || document.documentElement).appendChild(bar);
        return bar;
      }
      function show(title, detail) {
        try {
          ensureBar();
          var body = document.getElementById("qs-error-overlay-body");
          if (!body) return;
          var row = document.createElement("div");
          row.style.marginTop = body.childNodes.length ? "6px" : "0";
          var strong = document.createElement("strong");
          strong.style.color = "#ff8a94";
          strong.textContent = "⚠ " + String(title);
          row.appendChild(strong);
          if (detail) {
            var d = document.createElement("div");
            d.style.opacity = "0.8";
            d.textContent = String(detail);
            row.appendChild(d);
          }
          body.appendChild(row);
        } catch (e) { /* the overlay must never itself throw */ }
      }
      window.__qsShowError = show;
      window.addEventListener("error", function (ev) {
        if (!ev || !ev.message) return;
        var where = ev.filename ? (String(ev.filename).split("/").pop() + ":" + ev.lineno + ":" + ev.colno) : "";
        show(ev.message, where);
      });
      window.addEventListener("unhandledrejection", function (ev) {
        var r = ev ? ev.reason : null;
        var msg = (r && (r.message || r.code)) ? (r.message || r.code) : (typeof r === "string" ? r : "Unhandled promise rejection");
        var at = (r && r.stack) ? String(r.stack).split("\n")[1] : "";
        show("Unhandled rejection: " + msg, at ? at.trim() : "");
      });
    })();
  </script>

  <script>
    /* eslint-disable */
    (function () {
      // Standalone-mode flag. The standalone setup-ui server
      // (src/setup-ui/page.ts) flips this to true via a string transform
      // before serving the page. In standalone mode there is no running
      // gateway, so "needs restart" cards have nothing to act on — the
      // verify helpers below render a "saved to disk" success card instead.
      const IS_STANDALONE = false;
      // ─────── State ───────
      const STEPS = [
        { id: "welcome",     label: "Welcome" },
        { id: "goals",       label: "What you need" },
        { id: "provider",    label: "Pick AI" },
        { id: "apikey",      label: "Connect key" },
        { id: "voice-setup", label: "Voice" },
        { id: "telegram",    label: "Telegram" },
        { id: "import",      label: "Import notes" },
        { id: "browser",     label: "Your browser" },
        { id: "aiapps",      label: "AI apps (MCP)" },
        { id: "done",        label: "All done!" },
        { id: "models",     label: "Models & auth",     advanced: true },
        { id: "gateway",    label: "Gateway",           advanced: true },
        { id: "channels",   label: "Channels",          advanced: true },
        { id: "hooks",      label: "Hooks",             advanced: true },
        { id: "federation", label: "Federation",        advanced: true },
        { id: "notion",     label: "Notion (optional)", advanced: true },
        { id: "kanban",     label: "Kanban",            advanced: true },
        { id: "review",     label: "Review & finish",   advanced: true },
      ];
      // Restore the step the user last viewed so a tab close + reopen
      // doesn't make them re-navigate to where they were. We only persist
      // structural progress (step index, sync-mode preference) — never
      // secrets like API keys or passwords. Server-side status drives
      // completedSteps either way, so localStorage is a UX nicety, not a
      // source of truth.
      const PROGRESS_KEY = "infinibot.setup.progress.v1";
      function loadProgress() {
        try {
          const raw = localStorage.getItem(PROGRESS_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") return null;
          const step = Number(parsed.currentStep);
          if (!Number.isFinite(step)) return null;
          return {
            currentStep: Math.max(0, Math.min(STEPS.length - 1, step)),
            notionSyncMode: typeof parsed.notionSyncMode === "string" ? parsed.notionSyncMode : "",
          };
        } catch (_) { return null; }
      }
      function saveProgress() {
        try {
          localStorage.setItem(PROGRESS_KEY, JSON.stringify({
            currentStep: state.currentStep,
            notionSyncMode: state.notionInput && state.notionInput.syncMode,
            updatedAt: Date.now(),
          }));
        } catch (_) { /* private mode / quota — best-effort */ }
      }
      const __progress = loadProgress();
      const state = {
        ws: null,
        nextId: 1,
        pending: new Map(),
        connected: false,
        currentStep: __progress ? __progress.currentStep : 0,
        completedSteps: new Set(),
        snapshot: null,
        notion: null,
        // Mutable user inputs across steps
        modelChoice: null,
        gatewayPort: 18789,
        gatewayBind: "loopback",
        gatewayAuthMode: "token",
        gatewayPassword: "",
        channels: {},
        hooks: [],
        federation: { mode: "standalone", masterUrl: "", paired: false, mirroredBlocks: [] },
        notionInput: { apiKey: "", parentPageId: "", projectsDbId: "", tasksDbId: "", syncMode: "mirror", integrationName: "", verified: false, clientsDbId: "", leadsDbId: "", companiesDbId: "", dealsDbId: "", contactsDbId: "" },
        // Friendly onboarding state
        userName: "",
        selectedGoals: new Set(),   // "coding" | "voice" | "agents" | "exploring"
        selectedProvider: null,     // chosen provider id from the provider card step
        keyValidated: false,        // true once the server confirmed the key works
        showAdvanced: false,        // sidebar advanced-section toggle
        voiceChoice: { sttProvider: "groq", ttsProvider: "elevenlabs", sttKey: "", ttsKey: "" },
      };

      // ─────── WebSocket RPC ───────
      function readAuthFromHash() {
        // The CLI launches us with #token=<hex> when the gateway is in
        // token-auth mode, or #password=<pw> when it is in password-auth
        // mode. Extract once on load and persist in sessionStorage so
        // manual reloads keep the session. Reading only the token (the
        // earlier behavior) caused password-auth gateways to reject every
        // connect with reason "password_missing", since the wizard had no
        // way to forward the password from the launch URL.
        const STORAGE_KEY = "infinibot.quickstart.auth";
        try {
          const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
          const params = new URLSearchParams(hash);
          const token = params.get("token") || "";
          const password = params.get("password") || "";
          if (token || password) {
            const stored = { token: token || undefined, password: password || undefined };
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
            // Strip the credential from the visible URL bar.
            history.replaceState(null, "", location.pathname);
            return stored;
          }
        } catch (e) { /* ignore */ }
        try {
          const raw = sessionStorage.getItem(STORAGE_KEY);
          if (raw) return JSON.parse(raw);
        } catch (e) { /* ignore */ }
        // Back-compat with the older "token-only" sessionStorage key — older
        // tabs that authenticated before the rename still have a value here.
        const legacy = sessionStorage.getItem("infinibot.quickstart.token") || "";
        return legacy ? { token: legacy } : {};
      }
      try { window.__readAuthFromHash = readAuthFromHash; } catch (e) { /* non-browser */ }
      function connect() {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const auth = readAuthFromHash();
        // The WS handshake URL doesn't authenticate (auth runs on the connect
        // message), so the query string is a hint at best — keep it for
        // the token case so existing logs/proxies still see it, drop it for
        // password (passwords don't belong in URLs).
        const qs = auth.token ? "?token=" + encodeURIComponent(auth.token) : "";
        const url = proto + "//" + location.host + "/" + qs;
        const ws = new WebSocket(url);
        state.ws = ws;
        ws.addEventListener("open", () => {
          state.connected = true;
          updateFooter("connected");
          // ConnectParams shape — see src/gateway/protocol/schema/frames.ts.
          // The gateway validates this strictly; missing minProtocol/maxProtocol
          // or an unknown client.id closes the connection with code 1008.
          // Protocol version must match PROTOCOL_VERSION in
          // src/gateway/protocol/schema/protocol-schemas.ts. Currently 3.
          // Send a range so we tolerate forward/backward bumps.
          // Use webchat-ui rather than infinibot-control-ui: the control-ui
          // path requires a device identity OR HTTPS (secure context) when
          // not running on a published HTTPS origin. Quickstart runs over
          // plain http://127.0.0.1, so we use the webchat-ui client class
          // which is satisfied by the shared-secret token alone.
          const authPayload = auth.password
            ? { password: auth.password }
            : auth.token
              ? { token: auth.token }
              : undefined;
          const connectParams = {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "webchat-ui",
              displayName: "InfiniBot Quickstart",
              version: "1.0.0",
              platform: navigator.platform || "web",
              mode: "webchat",
            },
            auth: authPayload,
          };
          send("connect", connectParams).then(() => {
            loadStatus();
          }).catch((err) => {
            updateFooter("connect failed: " + (err?.message || err?.code || "unknown"));
          });
        });
        ws.addEventListener("close", () => {
          state.connected = false;
          updateFooter("disconnected — retrying in 2s");
          setTimeout(connect, 2000);
        });
        ws.addEventListener("error", () => updateFooter("error — check gateway logs"));
        ws.addEventListener("message", (ev) => {
          let frame;
          try { frame = JSON.parse(ev.data); } catch { return; }
          if (frame && frame.type === "res" && state.pending.has(frame.id)) {
            const { resolve, reject } = state.pending.get(frame.id);
            state.pending.delete(frame.id);
            if (frame.ok) resolve(frame.payload);
            else reject(frame.error || { code: "UNKNOWN", message: "RPC error" });
          }
        });
      }
      function send(method, params) {
        return new Promise((resolve, reject) => {
          if (!state.ws || state.ws.readyState !== 1) {
            reject({ code: "NOT_CONNECTED", message: "Gateway not connected" });
            return;
          }
          // RequestFrame schema requires id as a non-empty string and type="req".
          const id = "rpc_" + (state.nextId++);
          state.pending.set(id, { resolve, reject });
          state.ws.send(JSON.stringify({ type: "req", id, method, params: params || {} }));
        });
      }

      // ─────── Status & step model ───────
      async function loadStatus() {
        try {
          const status = await send("quickstart.status", {});
          state.snapshot = status;
          state.notion = status.notion;
          // Mark completed steps from server-side detection
          state.completedSteps = new Set();
          for (const step of status.steps || []) {
            if (step.state === "complete") state.completedSteps.add(step.id);
          }
          // Re-hydrate the Models step from saved config so the form repopulates
          // on revisit. apiKey is never sent back; we keep an empty string and
          // rely on hasApiKey to show a "saved key in use" hint.
          if (status.modelChoice) {
            state.modelChoice = {
              provider: status.modelChoice.provider,
              model: status.modelChoice.model,
              apiKey: "",
              endpoint: status.modelChoice.endpoint || "",
              hasApiKey: !!status.modelChoice.hasApiKey,
            };
          }
          if (status.notion) {
            state.notionInput.apiKey = "";
            state.notionInput.projectsDbId = status.notion.projectsDbId || "";
            state.notionInput.tasksDbId = status.notion.tasksDbId || "";
            state.notionInput.parentPageId = status.notion.parentPageId || "";
            state.notionInput.integrationName = status.notion.integrationName || "";
            state.notionInput.syncMode = status.notion.syncMode || "off";
            state.notionInput.verified = status.notion.configured && status.notion.reachable !== false;
            state.notionInput.clientsDbId = status.notion.clientsDbId || "";
            state.notionInput.leadsDbId = status.notion.leadsDbId || "";
            state.notionInput.companiesDbId = status.notion.companiesDbId || "";
            state.notionInput.dealsDbId = status.notion.dealsDbId || "";
            state.notionInput.contactsDbId = status.notion.contactsDbId || "";
          }
          // Re-hydrate the Gateway step. The server never sends the password
          // value back; only gatewayHasPassword so we can show "already saved"
          // instead of clobbering it with an empty string on revisit.
          if (status.gateway) {
            if (typeof status.gateway.port === "number") state.gatewayPort = status.gateway.port;
            if (typeof status.gateway.bind === "string") state.gatewayBind = status.gateway.bind;
            if (typeof status.gateway.authMode === "string") state.gatewayAuthMode = status.gateway.authMode;
            // Stash on snapshot so the password-row hint can render lazily.
            state.snapshot.gatewayHasPassword = !!status.gateway.hasPassword;
          }
          // Re-hydrate the Channels step. Token never travels back; only
          // hasToken so the form can render "saved token in use" instead of
          // clobbering with a blank string. allowFrom / groupAllowFrom round-trip
          // as string[] so users don't have to re-paste their allowlist.
          if (status.channels && typeof status.channels === "object") {
            for (const [chId, chSnap] of Object.entries(status.channels)) {
              if (!chSnap || typeof chSnap !== "object") continue;
              state.channels[chId] = {
                enabled: !!chSnap.enabled,
                hasToken: !!chSnap.hasToken,
                dmPolicy: chSnap.dmPolicy || "",
                groupPolicy: chSnap.groupPolicy || "",
                allowFrom: Array.isArray(chSnap.allowFrom) ? chSnap.allowFrom.slice() : [],
                groupAllowFrom: Array.isArray(chSnap.groupAllowFrom) ? chSnap.groupAllowFrom.slice() : [],
              };
            }
          }
          if (state.channels.telegram && state.channels.telegram.hasToken) state.completedSteps.add("telegram");
          // Re-hydrate the Federation step. If this device was previously
          // paired as a satellite, treat it as already paired on this run
          // so the downstream steps render in mirrored / read-only mode
          // without forcing the operator to re-pair.
          if (status.federation) {
            if (status.federation.mode) state.federation.mode = status.federation.mode;
            if (status.federation.masterUrl) state.federation.masterUrl = status.federation.masterUrl;
            state.federation.paired = status.federation.mode === "satellite" && !!status.federation.masterUrl;
          }
        } catch (err) {
          toast(err.message || "Could not load status", true);
        }
        renderSidebar();
        renderMain();
      }

      function updateFooter(s) {
        const el = document.getElementById("footer-status");
        if (el) el.textContent = s;
      }

      // ─────── Save confirmation ───────
      // Central handler for "Save succeeded": mark the step(s) complete, refresh
      // the side-rail/progress meter so the green check appears immediately, and
      // show a persistent inline "Saved ✓" badge that survives until the user
      // navigates (renderMain clears #main, removing the badge). This fixes the
      // "no visible confirmation + step reset on revisit" report: previously the
      // save handlers added to completedSteps but never re-rendered the sidebar,
      // so the meter never updated and revisiting recomputed state from scratch.
      function markSaved(stepIds, label) {
        (stepIds || []).forEach(function (id) { if (id) state.completedSteps.add(id); });
        renderSidebar();
        showSavedBadge(label);
      }
      function showSavedBadge(label) {
        const main = document.getElementById("main");
        if (!main) return;
        const prev = document.getElementById("qs-saved-badge");
        if (prev) prev.remove();
        const badge = document.createElement("div");
        badge.id = "qs-saved-badge";
        badge.setAttribute("role", "status");
        badge.setAttribute("aria-live", "polite");
        badge.style.cssText =
          "display:inline-flex;align-items:center;gap:7px;margin-top:18px;padding:7px 14px;" +
          "border-radius:99px;background:rgba(46,204,113,0.14);border:1px solid rgba(46,204,113,0.42);" +
          "color:var(--ok,#2ecc71);font-size:13px;font-weight:600;animation:step-enter .3s var(--ease-out,ease) both;";
        badge.innerHTML = '<span aria-hidden="true">✓</span><span>' + escapeHtml(label || "Saved") + "</span>";
        main.appendChild(badge);
      }

      // ─────── Sidebar ───────
      function renderSidebar() {
        // Persist the current step every time the sidebar re-renders.
        saveProgress();
        const list = document.getElementById("step-list");
        list.innerHTML = "";
        const mainSteps = STEPS.filter(function (s) { return !s.advanced; });
        const advSteps = STEPS.filter(function (s) { return s.advanced; });
        const curStep = STEPS[state.currentStep];
        const advActive = curStep && curStep.advanced;
        // ── Friendly steps (numbered 1–N) ──
        mainSteps.forEach(function (step) {
          const i = STEPS.indexOf(step);
          const num = mainSteps.indexOf(step) + 1;
          const li = document.createElement("li");
          li.className = "step-item";
          if (i === state.currentStep) li.classList.add("active");
          if (state.completedSteps.has(step.id)) li.classList.add("complete");
          li.innerHTML = '<span class="step-dot">' +
            (state.completedSteps.has(step.id) ? "✓" : num) +
            "</span><span>" + escapeHtml(step.label) + "</span>";
          li.addEventListener("click", function () { state.currentStep = i; renderSidebar(); renderMain(); });
          list.appendChild(li);
        });
        // ── Progress hint ──
        const doneCount = mainSteps.filter(function (s) { return state.completedSteps.has(s.id); }).length;
        const pf = document.getElementById("progress-fill");
        if (pf) pf.style.width = Math.round((doneCount / Math.max(1, mainSteps.length)) * 100) + "%";
        const hint = document.createElement("li");
        hint.style.cssText = "font-size:11px;color:var(--text-muted,#8a8a9a);padding:4px 12px 8px;list-style:none";
        hint.textContent = doneCount + " of " + mainSteps.length + " done";
        list.appendChild(hint);
        // ── Advanced toggle ──
        const sep = document.createElement("li");
        sep.className = "step-separator";
        list.appendChild(sep);
        const toggle = document.createElement("li");
        toggle.className = "adv-toggle";
        toggle.innerHTML = '<span style="font-size:11px">' + (state.showAdvanced || advActive ? "▾" : "▸") + '</span>' +
          '<span>Advanced settings</span>';
        toggle.addEventListener("click", function () {
          state.showAdvanced = !state.showAdvanced;
          renderSidebar();
        });
        list.appendChild(toggle);
        // ── Advanced steps (shown when expanded or one is active) ──
        if (state.showAdvanced || advActive) {
          advSteps.forEach(function (step) {
            const i = STEPS.indexOf(step);
            const li = document.createElement("li");
            li.className = "step-item";
            li.style.paddingLeft = "28px";
            if (i === state.currentStep) li.classList.add("active");
            if (state.completedSteps.has(step.id)) li.classList.add("complete");
            li.innerHTML = '<span class="step-dot">' +
              (state.completedSteps.has(step.id) ? "✓" : "·") +
              "</span><span>" + escapeHtml(step.label) + "</span>";
            li.addEventListener("click", function () { state.currentStep = i; renderSidebar(); renderMain(); });
            list.appendChild(li);
          });
        }
      }

      // ─────── Main router ───────
      function renderMain() {
        if (window.__qsMicStop) { try { window.__qsMicStop(); } catch (e) {} }
        const main = document.getElementById("main");
        main.innerHTML = "";
        const step = STEPS[state.currentStep];
        switch (step.id) {
          case "welcome":    renderWelcome(main); break;
          case "goals":      renderGoals(main); break;
          case "provider":   renderProvider(main); break;
          case "apikey":     renderApiKey(main); break;
          case "voice-setup":renderVoiceSetup(main); break;
          case "telegram":   renderTelegram(main); break;
          case "import":     renderImport(main); break;
          case "browser":    renderBrowserStep(main); break;
          case "aiapps":     renderAiAppsStep(main); break;
          case "done":       renderDone(main); break;
          case "models":     renderModels(main); break;

          case "gateway":    renderGateway(main); break;
          case "channels":   renderChannels(main); break;
          case "hooks":      renderHooks(main); break;
          case "federation": renderFederation(main); break;
          case "notion":     renderNotion(main); break;

          case "kanban":     renderKanban(main); break;
          case "review":     renderReview(main); break;
        }
        // Step transition: fade+slide children in (reduced-motion neutralizes it via CSS).
        for (var ci = 0; ci < main.children.length; ci++) {
          var ch = main.children[ci];
          ch.classList.add("step-enter");
          ch.style.animationDelay = (ci * 45) + "ms";
        }
      }

      function nav(prev, next) {
        const div = document.createElement("div");
        div.className = "actions split";
        div.innerHTML = '<button class="ghost" id="back">← Back</button>' +
          '<button class="primary" id="next">' + (next === "review" ? "Review →" : "Continue →") + '</button>';
        const bk = div.querySelector("#back");
        const nx = div.querySelector("#next");
        if (state.currentStep === 0) bk.style.visibility = "hidden";
        bk.addEventListener("click", () => { state.currentStep = Math.max(0, state.currentStep - 1); renderSidebar(); renderMain(); });
        nx.addEventListener("click", () => { state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1); renderSidebar(); renderMain(); });
        return div;
      }

      // ─────── Browser + AI apps (same RPCs as Setup › Connect your browser / AI apps) ───────
      function qsErrText(e) { return escapeHtml((e && (e.message || e.code)) || String(e)); }
      function qsCopy(text, btn) {
        var done = function () { var t = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = t; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (_) {} ta.remove(); done(); }
      }
      function qsStepNav(root, opts) {
        var actions = document.createElement("div");
        actions.className = "actions split";
        actions.innerHTML = '<button class="ghost" data-act="back">← Back</button><span style="flex:1"></span>' +
          '<button class="ghost" data-act="skip" data-testid="' + opts.testid + '-skip">Skip for now</button>' +
          '<button class="primary" data-act="next" data-testid="' + opts.testid + '-next">Continue →</button>';
        var go = function (d) { if (opts.stop) opts.stop(); state.currentStep = Math.max(0, Math.min(STEPS.length - 1, state.currentStep + d)); renderSidebar(); renderMain(); };
        actions.querySelector('[data-act="back"]').onclick = function () { go(-1); };
        actions.querySelector('[data-act="skip"]').onclick = function () { go(1); };
        actions.querySelector('[data-act="next"]').onclick = function () { go(1); };
        root.appendChild(actions);
      }
      function renderBrowserStep(root) {
        state.br = state.br || { code: null, folder: null, test: null, timer: null, st: null };
        if (state.br.timer) { clearInterval(state.br.timer); state.br.timer = null; }
        root.innerHTML =
          '<h1 class="h1">Connect your browser</h1>' +
          '<p class="lead">Let InfiniBot work in your own Chrome, with your logins: add the InfiniBot Browser Relay extension, pair it, and try it. About a minute. Optional — skip and do it later in Setup.</p>' +
          '<div id="br-body" data-testid="qs-browser"></div>';
        var stop = function () { if (state.br.timer) { clearInterval(state.br.timer); state.br.timer = null; } };
        qsStepNav(root, { testid: "qs-browser", stop: stop });
        var body = root.querySelector("#br-body");
        var paint = function () {
          var st = state.br.st || {};
          var f = state.br.folder;
          var pill = st.connected ? '<span class="ok-pill" data-testid="qs-browser-status">✓ Connected' + (st.name ? ' · ' + escapeHtml(st.name) : '') + '</span>'
            : st.paired ? '<span class="warn-pill" data-testid="qs-browser-status">Paired — waiting for Chrome</span>'
            : '<span class="idle-pill" data-testid="qs-browser-status">Not connected yet</span>';
          var html = '<div class="card">' + pill + '</div>';
          if (!st.paired) {
            html += '<div class="card"><h3>1 · Add the extension to Chrome</h3>' +
              (f && f.path ? '<pre data-testid="qs-browser-path">' + escapeHtml(f.path) + '</pre>' +
                '<div class="actions"><button class="primary" id="br-open">Open extension folder</button><button class="ghost" id="br-copy">Copy path</button></div>'
                : '<p class="hint">' + (f ? 'This install has no extension folder. Reinstall InfiniBot, then reopen this step.' : 'Finding the extension folder…') + '</p>') +
              '<ol class="br-steps"><li><b>Open chrome://extensions</b> in Chrome <button class="ghost small" id="br-copy-url">Copy address</button></li>' +
              '<li><b>Turn on Developer mode</b> (top-right switch)</li>' +
              '<li><b>Click Load unpacked</b> and pick the folder above</li></ol></div>' +
              '<div class="card"><h3>2 · Pair it</h3>' +
              (state.br.code ? '<p><code class="br-code" data-testid="qs-browser-code">' + escapeHtml(state.br.code) + '</code> <button class="ghost small" id="br-copy-code">Copy code</button></p>' +
                '<p class="hint">Paste it into the extension\'s settings page (it opens when you load it, or click the InfiniBot icon → Settings) and click Pair. This page turns green by itself.</p>'
                : '<button class="primary" id="br-code">Get pairing code</button>') + '</div>';
          }
          var t = state.br.test;
          html += '<div class="card"><h3>' + (st.paired ? '' : '3 · ') + 'Try it</h3><p class="hint">Opens example.com in your Chrome, reads the title, closes the tab.</p>' +
            '<button class="' + (st.connected ? 'primary' : 'ghost') + '" id="br-test"' + (st.connected ? '' : ' disabled') + ' data-testid="qs-browser-test">Open example.com and read the title</button>' +
            (t ? (t.ok ? '<div class="ok-msg" data-testid="qs-browser-test-result">✓ It works. Read “' + escapeHtml(t.title || "") + '” in ' + (t.ms / 1000).toFixed(1) + ' s.</div>'
              : '<div class="err-msg" data-testid="qs-browser-test-result">' + escapeHtml(t.error || "The test didn't finish.") + '</div>') : '') + '</div>';
          body.innerHTML = html;
          var q = function (id) { return body.querySelector(id); };
          if (q("#br-open")) q("#br-open").onclick = function () { send("browser.setup.reveal_extension", {}).catch(function () { qsCopy(f.path, q("#br-copy")); }); };
          if (q("#br-copy")) q("#br-copy").onclick = function () { qsCopy(f.path, q("#br-copy")); };
          if (q("#br-copy-url")) q("#br-copy-url").onclick = function () { qsCopy("chrome://extensions", q("#br-copy-url")); };
          if (q("#br-copy-code")) q("#br-copy-code").onclick = function () { qsCopy(state.br.code, q("#br-copy-code")); };
          if (q("#br-code")) q("#br-code").onclick = function () {
            send("browser.extension.pairing.create", { name: "My Chrome" }).then(function (r) { state.br.code = r.code; paint(); }, function (e) { body.insertAdjacentHTML("beforeend", '<div class="err-msg">' + qsErrText(e) + '</div>'); });
          };
          if (q("#br-test")) q("#br-test").onclick = function () {
            q("#br-test").disabled = true; q("#br-test").textContent = "Opening example.com…";
            send("browser.extension.test", {}).then(function (r) { state.br.test = r; paint(); }, function (e) { state.br.test = { ok: false, ms: 0, error: (e && e.message) || "Test failed" }; paint(); });
          };
        };
        var refresh = function () {
          if (STEPS[state.currentStep].id !== "browser") { stop(); return; }
          send("browser.connect.status", {}).then(function (s) {
            var p = (s.connectedProfiles && s.connectedProfiles[0]) || (s.pairedProfiles && s.pairedProfiles[0]);
            state.br.st = { connected: s.connected, paired: s.paired || s.connected, name: p && p.name };
          }, function () {
            return send("browser.extension.status", {}).then(function (g) {
              var ps = g.profiles || []; var live = ps.filter(function (x) { return x.connected; })[0];
              state.br.st = { connected: !!live, paired: ps.length > 0, name: (live || ps[0] || {}).name };
            }, function () {});
          }).then(paint);
        };
        send("browser.setup.status", {}).then(function (s) { state.br.folder = s.extension || { found: false }; }, function () { state.br.folder = { found: false }; }).then(paint);
        refresh();
        state.br.timer = setInterval(refresh, 2500);
      }
      function renderAiAppsStep(root) {
        state.ai = state.ai || { data: null, picked: null, results: null, test: null, tab: "generic" };
        root.innerHTML =
          '<h1 class="h1">Connect your AI apps</h1>' +
          '<p class="lead">Add InfiniBot to Claude Code, Claude Desktop, Cursor, Codex or VS Code in one click, so they can use its memory, tasks, agents and your browser. Each config is backed up first and your other MCP servers stay as they are. No password is written into those files.</p>' +
          '<div id="ai-body" data-testid="qs-aiapps"><p class="hint">Looking for AI apps on this computer…</p></div>';
        qsStepNav(root, { testid: "qs-aiapps" });
        var body = root.querySelector("#ai-body");
        var paint = function () {
          var d = state.ai.data;
          if (!d) return;
          var html = '';
          if (d.clients && d.clients.length) {
            html += '<div class="card"><h3>Your AI apps</h3><ul class="ai-list">' + d.clients.map(function (c) {
              var can = c.detected && !c.unreadable;
              var chip = c.unreadable ? 'config can\'t be read' : (c.current && !c.embedsSecret) ? '✓ added' : c.configured ? 'needs update' : c.detected ? 'found' : 'not found';
              return '<li><label><input type="checkbox" data-id="' + c.id + '"' + (state.ai.picked.has(c.id) ? ' checked' : '') + (can ? '' : ' disabled') + '> <b>' + escapeHtml(c.name) + '</b></label> <span class="hint">' + chip + '</span><div class="hint mono">' + escapeHtml(c.configPath) + '</div></li>';
            }).join("") + '</ul><div class="actions"><button class="primary" id="ai-add" data-testid="qs-aiapps-add"' + (state.ai.picked.size ? '' : ' disabled') + '>Add InfiniBot MCP' + (state.ai.picked.size ? ' to ' + state.ai.picked.size + ' app' + (state.ai.picked.size === 1 ? '' : 's') : '') + '</button></div>';
            if (state.ai.results) html += '<ul class="ai-list">' + state.ai.results.map(function (r) {
              return r.ok ? '<li class="ok-msg">✓ ' + escapeHtml(r.id) + (r.changed ? ' added' : ' already set up') + (r.backupPath ? '<div class="hint mono">Backup: ' + escapeHtml(r.backupPath) + '</div>' : '') + '</li>'
                : '<li class="err-msg">' + escapeHtml(r.error) + '</li>';
            }).join("") + '</ul>';
            html += '</div>';
          }
          var tabs = Object.keys(d.snippets || {});
          if (tabs.length) {
            var tab = d.snippets[state.ai.tab] ? state.ai.tab : tabs[0];
            html += '<div class="card"><h3>Another app? Paste this</h3><select id="ai-tab">' + tabs.map(function (k) { return '<option value="' + k + '"' + (k === tab ? ' selected' : '') + '>' + escapeHtml(k) + '</option>'; }).join("") +
              '</select><pre id="ai-snippet" data-testid="qs-aiapps-snippet">' + escapeHtml(d.snippets[tab]) + '</pre><button class="ghost" id="ai-copy">Copy config</button></div>';
          }
          var t = state.ai.test;
          html += '<div class="card"><h3>Test connection</h3><p class="hint">Starts InfiniBot\'s MCP server the way your apps do and calls a tool (and a browser tool when Chrome is connected).</p><button class="ghost" id="ai-test" data-testid="qs-aiapps-test">Test connection</button>' +
            (t ? (t.ok ? '<div class="ok-msg">✓ Connected. ' + t.toolCount + ' tools' + (t.hasBrowser ? ', including the browser' : '') + '.</div>' : '<div class="err-msg">' + escapeHtml(t.error || "One of the calls failed.") + '</div>') +
              '<ul class="ai-list">' + (t.calls || []).map(function (c) { return '<li class="hint">' + (c.ok ? '✓ ' : '✗ ') + escapeHtml(c.tool) + ' — ' + escapeHtml(c.summary) + ' (' + c.ms + ' ms)</li>'; }).join("") + '</ul>' : '') + '</div>';
          body.innerHTML = html;
          body.querySelectorAll('input[type="checkbox"][data-id]').forEach(function (cb) {
            cb.onchange = function () { if (cb.checked) state.ai.picked.add(cb.dataset.id); else state.ai.picked.delete(cb.dataset.id); paint(); };
          });
          var q = function (id) { return body.querySelector(id); };
          if (q("#ai-tab")) q("#ai-tab").onchange = function () { state.ai.tab = q("#ai-tab").value; paint(); };
          if (q("#ai-copy")) q("#ai-copy").onclick = function () { qsCopy(q("#ai-snippet").textContent, q("#ai-copy")); };
          if (q("#ai-add")) q("#ai-add").onclick = function () {
            q("#ai-add").disabled = true;
            send("mcp.clients.add", { ids: Array.from(state.ai.picked) }).then(function (r) {
              state.ai.results = r.results; state.ai.picked = new Set();
              return send("mcp.clients.detect", {}).then(function (d2) { state.ai.data = d2; });
            }, function (e) { state.ai.results = [{ ok: false, error: (e && e.message) || "Couldn't add" }]; }).then(paint);
          };
          if (q("#ai-test")) q("#ai-test").onclick = function () {
            q("#ai-test").disabled = true; q("#ai-test").textContent = "Testing…";
            send("mcp.clients.test", { browser: true }).then(function (r) { state.ai.test = r; paint(); }, function (e) { state.ai.test = { ok: false, error: (e && e.message) || "Test failed", calls: [] }; paint(); });
          };
        };
        send("mcp.clients.detect", {}).then(function (d) {
          state.ai.data = d;
          if (!state.ai.picked) {
            state.ai.picked = new Set((d.clients || []).filter(function (c) { return c.detected && !c.unreadable && (!c.current || c.embedsSecret); }).map(function (c) { return c.id; }));
          }
          paint();
        }, function (e) {
          body.innerHTML = '<div class="err-msg">Couldn\'t look for AI apps: ' + qsErrText(e) + '. Restart InfiniBot after updating, or skip this step.</div>';
        });
      }

      // ─────── Telegram (guided, same flow as Setup › Channels + cloud onboarding) ───────
      // Uses the shared telegram.setup.* RPCs (src/telegram/setup): getMe check,
      // owner capture via a t.me/<bot>?start=<code> deep link (or a typed user
      // id checked with getChat), DM policy, and a test message.
      function tgErr(el, e) {
        var err = (e && e.error) || e || {};
        el.innerHTML = '<div class="err-msg"><strong>' + escapeHtml(err.title || "Something went wrong") + '</strong> ' +
          escapeHtml(err.message || err.code || "") + (err.fix ? '<div class="hint">' + escapeHtml(err.fix) + '</div>' : "") + '</div>';
      }
      function tgSkip() {
        if (state.tg && state.tg.pollTimer) { clearInterval(state.tg.pollTimer); state.tg.pollTimer = null; }
        state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1);
        renderSidebar(); renderMain();
      }
      function renderTelegram(root) {
        state.tg = state.tg || { stage: "token", sessionId: "", bot: null, owner: null, policy: "allowlist", pollTimer: null };
        if (state.tg.pollTimer) { clearInterval(state.tg.pollTimer); state.tg.pollTimer = null; }
        root.innerHTML =
          '<h1 class="h1">Chat with InfiniBot on Telegram</h1>' +
          '<p class="lead">Connect your own Telegram bot so you can message InfiniBot from your phone. Only you will be able to talk to it. Optional — you can skip and do it later in Settings › Channels.</p>' +
          '<div id="tg-stage" data-testid="qs-telegram"></div>';
        var hasSaved = state.channels.telegram && state.channels.telegram.hasToken;
        if (hasSaved && state.tg.stage === "token" && !state.tg.sessionId) state.tg.stage = "summary";
        renderTelegramStage();
      }
      function tgSteps(n) {
        var labels = ["Bot token", "Find you", "Who can chat", "Test"];
        return '<div class="tg-steps">' + labels.map(function (l, i) {
          return '<span class="tg-step' + (i + 1 === n ? " on" : i + 1 < n ? " done" : "") + '">' + (i + 1 < n ? "✓" : (i + 1)) + ' · ' + escapeHtml(l) + '</span>';
        }).join("") + '</div>';
      }
      function renderTelegramStage() {
        var el = document.getElementById("tg-stage");
        if (!el) return;
        var tg = state.tg;
        if (tg.stage === "summary") {
          el.innerHTML = '<div class="card"><h2 class="h2">Telegram is set up</h2><div id="tg-sum" class="hint"><span class="spinner"></span> Checking…</div>' +
            '<div class="actions split"><button class="ghost" id="tg-redo">Connect a different bot</button><button class="primary" id="tg-next">Continue →</button></div></div>';
          el.querySelector("#tg-redo").onclick = function () { tg.stage = "token"; tg.sessionId = ""; renderTelegramStage(); };
          el.querySelector("#tg-next").onclick = tgSkip;
          send("telegram.setup.summary", {}).then(function (s) {
            var box = document.getElementById("tg-sum");
            if (!box) return;
            if (!s || s.ok === false) { tgErr(box, s); return; }
            box.innerHTML = 'Bot: <strong>' + escapeHtml(s.bot && s.bot.username ? "@" + s.bot.username : (s.tokenMasked || "saved")) + '</strong>' +
              (s.owners && s.owners.length ? ' · owner: ' + escapeHtml(s.owners.map(function (o) { return o.username ? "@" + o.username : String(o.userId); }).join(", ")) : ' · <span class="err-msg" style="display:inline">no owner yet — reconnect to link your account</span>');
            markSaved(["telegram"], "Telegram connected");
          }).catch(function (e) { var b = document.getElementById("tg-sum"); if (b) tgErr(b, e); });
          return;
        }
        if (tg.stage === "token") {
          el.innerHTML = '<div class="card">' + tgSteps(1) +
            '<h2 class="h2">Paste your bot token</h2>' +
            '<ol class="tg-howto"><li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> and send <code>/newbot</code>.</li>' +
            '<li>Pick a name and a username ending in <code>bot</code>.</li><li>Copy the token it sends you (looks like <code>123456:ABC-…</code>).</li></ol>' +
            '<label class="hint" for="tg-token">Bot token</label>' +
            '<input type="password" id="tg-token" data-testid="qs-tg-token" autocomplete="off" placeholder="123456789:AA…" />' +
            '<div id="tg-err"></div>' +
            '<div class="actions split"><button class="ghost" id="tg-skip">Skip for now</button><button class="primary" id="tg-verify" data-testid="qs-tg-verify">Check token</button></div></div>';
          el.querySelector("#tg-skip").onclick = tgSkip;
          var go = function () {
            var token = el.querySelector("#tg-token").value.trim();
            var errEl = el.querySelector("#tg-err");
            if (!token) { errEl.innerHTML = '<div class="err-msg">Paste the token from @BotFather first.</div>'; return; }
            var btn = el.querySelector("#tg-verify");
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Checking…';
            send("telegram.setup.verify", { token: token }).then(function (r) {
              btn.disabled = false; btn.textContent = "Check token";
              if (!r || r.ok === false) { tgErr(errEl, r); return; }
              tg.sessionId = r.sessionId; tg.bot = r.bot; tg.webhookHost = r.webhookHost || null;
              tg.stage = "owner"; renderTelegramStage();
            }).catch(function (e) { btn.disabled = false; btn.textContent = "Check token"; tgErr(errEl, e); });
          };
          el.querySelector("#tg-verify").onclick = go;
          el.querySelector("#tg-token").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
          return;
        }
        if (tg.stage === "owner") {
          var botName = tg.bot && tg.bot.username ? "@" + tg.bot.username : "your bot";
          el.innerHTML = '<div class="card">' + tgSteps(2) +
            '<div class="tg-ok">✓ Token works — this is <strong>' + escapeHtml(botName) + '</strong>' + (tg.bot && tg.bot.name ? ' (' + escapeHtml(tg.bot.name) + ')' : "") + '</div>' +
            (tg.webhookHost ? '<div class="err-msg">Another app (' + escapeHtml(tg.webhookHost) + ') is connected to this bot. <button class="ghost" id="tg-unhook">Disconnect it</button></div>' : "") +
            '<h2 class="h2">Now let InfiniBot find you</h2>' +
            '<p class="hint">Open the bot on your phone and press <strong>Start</strong>. InfiniBot reads your Telegram user id from that message, so only you can chat with it.</p>' +
            '<div id="tg-capture"><button class="primary" id="tg-cap" data-testid="qs-tg-capture">Get my link</button></div>' +
            '<details class="tg-manual"><summary class="hint">Or type your user id</summary>' +
            '<div class="row" style="margin-top:8px"><input type="text" id="tg-id" inputmode="numeric" placeholder="123456789" /><button class="ghost" id="tg-id-go">Use this id</button></div>' +
            '<div class="hint">Message @userinfobot in Telegram to see your id.</div></details>' +
            '<div id="tg-err"></div>' +
            '<div class="actions split"><button class="ghost" id="tg-back">← Different token</button><button class="ghost" id="tg-skip">Skip for now</button></div></div>';
          el.querySelector("#tg-back").onclick = function () { tg.stage = "token"; renderTelegramStage(); };
          el.querySelector("#tg-skip").onclick = tgSkip;
          var unhook = el.querySelector("#tg-unhook");
          if (unhook) unhook.onclick = function () {
            send("telegram.setup.deleteWebhook", { sessionId: tg.sessionId }).then(function (r) {
              if (r && r.ok === false) { tgErr(el.querySelector("#tg-err"), r); return; }
              tg.webhookHost = null; renderTelegramStage();
            }).catch(function (e) { tgErr(el.querySelector("#tg-err"), e); });
          };
          var onFound = function (v) {
            var f = v.capture && v.capture.found;
            if (!f) return;
            if (tg.pollTimer) { clearInterval(tg.pollTimer); tg.pollTimer = null; }
            tg.owner = f; tg.stage = "policy"; renderTelegramStage();
          };
          el.querySelector("#tg-id-go").onclick = function () {
            var id = el.querySelector("#tg-id").value.trim();
            send("telegram.setup.manual", { sessionId: tg.sessionId, mode: "dm", id: id }).then(function (r) {
              if (!r || r.ok === false) { tgErr(el.querySelector("#tg-err"), r); return; }
              onFound(r);
            }).catch(function (e) { tgErr(el.querySelector("#tg-err"), e); });
          };
          el.querySelector("#tg-cap").onclick = function () {
            var box = el.querySelector("#tg-capture");
            box.innerHTML = '<span class="spinner"></span> Making your link…';
            send("telegram.setup.capture.start", { sessionId: tg.sessionId, mode: "dm" }).then(function (r) {
              if (!r || r.ok === false) { tgErr(el.querySelector("#tg-err"), r); box.innerHTML = '<button class="primary" id="tg-cap2">Try again</button>'; box.querySelector("#tg-cap2").onclick = function () { tg.stage = "owner"; renderTelegramStage(); }; return; }
              var link = r.capture && r.capture.deepLink;
              box.innerHTML = '<div class="tg-capture">' +
                (r.qr ? '<img class="tg-qr" alt="QR code for the bot link" src="' + escapeHtml(r.qr) + '" />' : "") +
                '<div><a class="primary tg-open" data-testid="qs-tg-link" href="' + escapeHtml(link || "#") + '" target="_blank" rel="noopener">Open ' + escapeHtml(botName) + ' in Telegram</a>' +
                '<div class="hint">Scan the code with your phone, or click the button. Then press <strong>Start</strong>.</div>' +
                '<div class="hint" id="tg-wait"><span class="spinner"></span> Waiting for your /start message…</div></div></div>';
              tg.pollTimer = setInterval(function () {
                send("telegram.setup.capture.status", { sessionId: tg.sessionId }).then(function (v) {
                  if (!v || v.ok === false) return;
                  var st = v.capture && v.capture.status;
                  if (st === "found") onFound(v);
                  else if (st === "expired" || st === "error" || st === "cancelled") {
                    clearInterval(tg.pollTimer); tg.pollTimer = null;
                    var w = document.getElementById("tg-wait");
                    if (w) w.innerHTML = '<span class="err-msg">' + (st === "expired" ? "The link expired." : "Couldn't read messages from Telegram.") + ' <button class="ghost" id="tg-retry">Try again</button></span>';
                    var rb = document.getElementById("tg-retry");
                    if (rb) rb.onclick = function () { renderTelegramStage(); };
                  } else if (v.capture && v.capture.otherMessages) {
                    var w2 = document.getElementById("tg-wait");
                    if (w2) w2.innerHTML = '<span class="spinner"></span> Got a message, but not the Start link — open the link above and press Start.';
                  }
                }).catch(function () {});
              }, 1500);
            }).catch(function (e) { tgErr(el.querySelector("#tg-err"), e); });
          };
          return;
        }
        if (tg.stage === "policy") {
          var o = tg.owner || {};
          var who = (o.firstName || "") + (o.username ? " (@" + o.username + ")" : "");
          el.innerHTML = '<div class="card">' + tgSteps(3) +
            '<div class="tg-ok">✓ Found you: <strong>' + escapeHtml(who.trim() || "you") + '</strong> · user id <code>' + escapeHtml(String(o.userId || o.chatId || "")) + '</code></div>' +
            '<h2 class="h2">Who can message your bot?</h2>' +
            '<div class="tg-policy">' +
            '<label class="tg-opt"><input type="radio" name="tg-pol" value="allowlist"' + (tg.policy === "allowlist" ? " checked" : "") + ' /> <span><strong>Only me</strong> <span class="pill">recommended</span><br><span class="hint">Everyone else is ignored. You can add people later.</span></span></label>' +
            '<label class="tg-opt"><input type="radio" name="tg-pol" value="pairing"' + (tg.policy === "pairing" ? " checked" : "") + ' /> <span><strong>Me + people I approve</strong><br><span class="hint">New people get a pairing code you approve first.</span></span></label>' +
            '<label class="tg-opt"><input type="radio" name="tg-pol" value="open"' + (tg.policy === "open" ? " checked" : "") + ' /> <span><strong>Anyone</strong><br><span class="hint">Anyone who finds the bot can use your AI credits. Not recommended.</span></span></label>' +
            '</div><div id="tg-err"></div>' +
            '<div class="actions split"><button class="ghost" id="tg-back">← Back</button><button class="primary" id="tg-save" data-testid="qs-tg-save">Save Telegram</button></div></div>';
          el.querySelectorAll('input[name="tg-pol"]').forEach(function (r) { r.onchange = function () { tg.policy = r.value; }; });
          el.querySelector("#tg-back").onclick = function () { tg.stage = "owner"; renderTelegramStage(); };
          el.querySelector("#tg-save").onclick = function () {
            var btn = el.querySelector("#tg-save");
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
            send("telegram.setup.confirm", { sessionId: tg.sessionId, makeDefault: true }).then(function (r) {
              if (!r || r.ok === false) throw r;
              var owner = String(o.userId || o.chatId || "");
              var tgPatch = { enabled: true, dmPolicy: tg.policy };
              if (tg.policy === "open") tgPatch.allowFrom = owner ? [owner, "*"] : ["*"];
              return send("quickstart.applyPatch", { patch: { channels: { telegram: tgPatch } } }).then(function () { return r; });
            }).then(function (r) {
              state.channels.telegram = Object.assign(state.channels.telegram || {}, { enabled: true, hasToken: true, dmPolicy: tg.policy });
              tg.starting = r.starting;
              markSaved(["telegram", "channels"], "Telegram saved");
              tg.stage = "test"; renderTelegramStage();
            }).catch(function (e) { btn.disabled = false; btn.textContent = "Save Telegram"; tgErr(el.querySelector("#tg-err"), e); });
          };
          return;
        }
        if (tg.stage === "test") {
          el.innerHTML = '<div class="card">' + tgSteps(4) +
            '<div class="tg-ok">✓ Saved. ' + (tg.starting === "live" ? "Your bot is live." : "Your bot comes online when InfiniBot starts.") + '</div>' +
            '<h2 class="h2">Send yourself a test message</h2>' +
            '<p class="hint">InfiniBot sends “✅ InfiniBot is connected” to your Telegram.</p>' +
            '<div id="tg-test-res"></div><div id="tg-err"></div>' +
            '<div class="actions split"><button class="ghost" id="tg-test" data-testid="qs-tg-test">Send test message</button><button class="primary" id="tg-next">Continue →</button></div></div>';
          el.querySelector("#tg-next").onclick = tgSkip;
          el.querySelector("#tg-test").onclick = function () {
            var res = el.querySelector("#tg-test-res");
            res.innerHTML = '<span class="spinner"></span> Sending…';
            send("telegram.setup.test", { sessionId: tg.sessionId }).then(function (r) {
              if (!r || r.ok === false) { res.innerHTML = ""; tgErr(el.querySelector("#tg-err"), r); return; }
              res.innerHTML = '<div class="tg-ok" data-testid="qs-tg-test-ok">✓ Sent — check Telegram.</div>';
            }).catch(function (e) { res.innerHTML = ""; tgErr(el.querySelector("#tg-err"), e); });
          };
        }
      }

      // ─────── Import your notes (Obsidian + Notion) ───────
      // Starts background import jobs (documents.obsidian.import /
      // documents.notion.import / ZIP upload). Setup never waits on them:
      // they keep running while you continue, and whatever is unfinished when
      // setup closes is resumed by the gateway when it starts.
      function importUpload(mode, file, extra) {
        var q = "mode=" + encodeURIComponent(mode) + "&name=" + encodeURIComponent(file.name);
        Object.keys(extra || {}).forEach(function (k) { q += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(extra[k]); });
        var parse = function (res) {
          return res.json().catch(function () { return null; }).then(function (j) {
            if (!res.ok || !j || j.ok === false) {
              var msg = (j && j.error && (j.error.message || j.error)) || ("Upload failed (HTTP " + res.status + ")");
              throw { message: String(msg) };
            }
            return j.data || j;
          });
        };
        if (IS_STANDALONE) {
          return fetch("/api/upload?" + q + "&token=" + encodeURIComponent(state.token), {
            method: "POST", body: file, headers: { "X-Setup-Token": state.token, "Content-Type": "application/zip" },
          }).then(parse);
        }
        return send("documents.ticket", {}).then(function (t) {
          return fetch("/api/documents/upload?" + q + "&t=" + encodeURIComponent(t.ticket), {
            method: "POST", body: file, headers: { "Content-Type": "application/zip" }, credentials: "same-origin",
          }).then(parse);
        });
      }
      function renderImport(root) {
        state.imp = state.imp || { src: "obsidian", obs: "zip", notion: "zip", path: "", url: "", tasks: false, results: [], picked: new Set(), timer: null };
        root.innerHTML =
          '<h1 class="h1">Import your notes</h1>' +
          '<p class="lead">Bring your Obsidian vault or Notion workspace into InfiniBot so your agents can use it. Notes land in Documents with their links, tags and attachments, and show up in the knowledge graph. Optional — imports run in the background, so you can keep going.</p>' +
          '<div class="goal-grid imp-src" id="imp-src" data-testid="qs-import"></div>' +
          '<div id="imp-body"></div>' +
          '<div id="imp-jobs"></div>';
        var grid = root.querySelector("#imp-src");
        [{ id: "obsidian", icon: "🟣", name: "Obsidian", desc: "A vault folder, a .zip of it, or a git repo." },
         { id: "notion", icon: "⬛", name: "Notion", desc: "An export ZIP (Markdown & CSV) or your integration token." }].forEach(function (s) {
          var tile = document.createElement("div");
          tile.className = "goal-tile" + (state.imp.src === s.id ? " selected" : "");
          tile.tabIndex = 0;
          tile.setAttribute("data-testid", "qs-import-" + s.id);
          tile.innerHTML = '<span class="goal-icon">' + s.icon + '</span><div class="goal-name">' + escapeHtml(s.name) + '</div><div class="goal-desc">' + escapeHtml(s.desc) + '</div>';
          var pick = function () { state.imp.src = s.id; renderImport(root); };
          tile.addEventListener("click", pick);
          tile.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
          grid.appendChild(tile);
        });
        renderImportBody(root.querySelector("#imp-body"));
        var actions = document.createElement("div");
        actions.className = "actions split";
        actions.innerHTML = '<button class="ghost" id="imp-back">← Back</button><button class="primary" id="imp-next" data-testid="qs-import-next">Continue →</button>';
        actions.querySelector("#imp-back").onclick = function () { state.currentStep = Math.max(0, state.currentStep - 1); renderSidebar(); renderMain(); };
        actions.querySelector("#imp-next").onclick = function () { state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1); renderSidebar(); renderMain(); };
        root.appendChild(actions);
        refreshImportJobs();
      }
      function segHtml(name, options, current) {
        return '<div class="imp-seg" role="tablist">' + options.map(function (o) {
          return '<button type="button" class="imp-seg-btn' + (o[0] === current ? " on" : "") + '" data-seg="' + name + '" data-val="' + o[0] + '">' + escapeHtml(o[1]) + '</button>';
        }).join("") + '</div>';
      }
      function renderImportBody(el) {
        var imp = state.imp;
        var root = el.parentNode;
        var startBtn = '<div id="imp-err"></div>';
        if (imp.src === "obsidian") {
          el.innerHTML = '<div class="card">' +
            segHtml("obs", [["zip", "Upload a ZIP"], ["folder", "Vault folder on this computer"], ["git", "Git repository"]], imp.obs) +
            (imp.obs === "zip"
              ? '<p class="hint">Right-click your vault folder → Compress / Send to ZIP, then choose the file.</p><input type="file" id="imp-file" accept=".zip,application/zip" data-testid="qs-import-file" />'
              : imp.obs === "folder"
                ? '<label class="hint" for="imp-path">Vault folder (the one that contains <code>.obsidian</code>)</label><input type="text" id="imp-path" data-testid="qs-import-path" placeholder="~/Documents/My Vault" value="' + escapeHtml(imp.path) + '" />'
                : '<label class="hint" for="imp-url">Public https git URL</label><input type="text" id="imp-url" placeholder="https://github.com/you/notes.git" value="' + escapeHtml(imp.url) + '" />') +
            '<label class="imp-check"><input type="checkbox" id="imp-tasks"' + (imp.tasks ? " checked" : "") + ' /> Also turn <code>- [ ]</code> checklists into kanban tasks</label>' +
            startBtn + '<div class="actions"><button class="primary" id="imp-start" data-testid="qs-import-start">Start import</button></div></div>';
        } else {
          el.innerHTML = '<div class="card">' +
            segHtml("notion", [["zip", "Export ZIP (recommended)"], ["token", "Integration token"]], imp.notion) +
            (imp.notion === "zip"
              ? '<p class="hint">In Notion: <strong>Settings → Export → Markdown &amp; CSV</strong> (include subpages). Then choose the .zip.</p><input type="file" id="imp-file" accept=".zip,application/zip" />' + startBtn + '<div class="actions"><button class="primary" id="imp-start">Start import</button></div>'
              : '<p class="hint">' + (state.notionInput && state.notionInput.verified ? "Using the Notion connection you set up." : 'Paste an internal integration token (notion.so/my-integrations) and share your pages with it.') + '</p>' +
                (state.notionInput && state.notionInput.verified ? "" : '<input type="password" id="imp-ntoken" placeholder="ntn_… / secret_…" value="' + escapeHtml(imp.ntoken || "") + '" />') +
                '<div class="row" style="margin-top:8px"><input type="text" id="imp-q" placeholder="Search pages & databases" value="' + escapeHtml(imp.q || "") + '" /><button class="ghost" id="imp-search">Search</button></div>' +
                '<div class="page-list" id="imp-results"></div>' + startBtn +
                '<div class="actions"><button class="primary" id="imp-start">Import selected</button></div>') +
            '</div>';
        }
        el.querySelectorAll(".imp-seg-btn").forEach(function (b) {
          b.onclick = function () {
            if (b.getAttribute("data-seg") === "obs") imp.obs = b.getAttribute("data-val"); else imp.notion = b.getAttribute("data-val");
            renderImportBody(el);
          };
        });
        var errEl = el.querySelector("#imp-err");
        var tasksEl = el.querySelector("#imp-tasks");
        if (tasksEl) tasksEl.onchange = function () { imp.tasks = tasksEl.checked; };
        var results = el.querySelector("#imp-results");
        var drawResults = function () {
          if (!results) return;
          results.innerHTML = imp.results.length ? "" : '<div class="hint">Search to list what your integration can see.</div>';
          imp.results.forEach(function (r) {
            var row = document.createElement("label");
            row.className = "import-row";
            row.innerHTML = '<input type="checkbox"' + (imp.picked.has(r.id) ? " checked" : "") + ' /><span class="import-meta"><span class="import-title">' + escapeHtml((r.icon || (r.type === "database" ? "🗃️" : "📄")) + " " + (r.title || "Untitled")) + '</span> <span class="pill">' + (r.type === "database" ? "database" : "page") + '</span></span>';
            row.querySelector("input").onchange = function (e) { if (e.target.checked) imp.picked.add(r.id); else imp.picked.delete(r.id); };
            results.appendChild(row);
          });
        };
        drawResults();
        var search = el.querySelector("#imp-search");
        if (search) search.onclick = function () {
          var tokEl = el.querySelector("#imp-ntoken");
          imp.ntoken = tokEl ? tokEl.value.trim() : "";
          imp.q = el.querySelector("#imp-q").value;
          results.innerHTML = '<span class="spinner"></span> Searching…';
          send("documents.notion.search", { query: imp.q, token: imp.ntoken || undefined }).then(function (r) {
            imp.results = (r && r.results) || []; drawResults();
          }).catch(function (e) { results.innerHTML = ""; errEl.innerHTML = '<div class="err-msg">' + escapeHtml(e.message || "Search failed") + '</div>'; });
        };
        el.querySelector("#imp-start").onclick = function () {
          var btn = el.querySelector("#imp-start");
          errEl.innerHTML = "";
          var started;
          if (imp.src === "obsidian" && imp.obs !== "zip") {
            var pathEl = el.querySelector("#imp-path"), urlEl = el.querySelector("#imp-url");
            if (pathEl) imp.path = pathEl.value.trim();
            if (urlEl) imp.url = urlEl.value.trim();
            var params = imp.obs === "git" ? { source: "git", url: imp.url } : { source: "folder", path: imp.path };
            params.createTasks = imp.tasks;
            started = send("documents.obsidian.import", params);
          } else if (imp.src === "notion" && imp.notion === "token") {
            if (!imp.picked.size) { errEl.innerHTML = '<div class="err-msg">Pick at least one page or database.</div>'; return; }
            started = send("documents.notion.import", { ids: Array.from(imp.picked), parentId: null, token: imp.ntoken || undefined, label: imp.picked.size + " Notion item" + (imp.picked.size === 1 ? "" : "s") });
          } else {
            var f = el.querySelector("#imp-file").files[0];
            if (!f) { errEl.innerHTML = '<div class="err-msg">Choose a .zip file first.</div>'; return; }
            started = importUpload(imp.src === "notion" ? "notion-zip" : "obsidian-zip", f, imp.src === "obsidian" && imp.tasks ? { createTasks: "1" } : {});
          }
          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Starting…';
          started.then(function () {
            btn.disabled = false; btn.textContent = "Start another";
            markSaved(["import"], "Import started — it keeps running in the background");
            refreshImportJobs();
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = "Start import";
            errEl.innerHTML = '<div class="err-msg">' + escapeHtml((e && e.message) || "Couldn't start the import") + '</div>';
          });
        };
      }
      function jobLine(j) {
        var p = j.progress || {}, r = j.report || {};
        var active = j.status === "queued" || j.status === "running";
        var pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : (active ? 5 : 100);
        var kind = j.kind === "obsidian" ? "Obsidian" : j.kind === "notion-zip" ? "Notion ZIP" : j.kind === "map" ? "Mapping" : "Notion";
        var d = j.details || {};
        var extra = j.kind === "obsidian" && !active
          ? ' · ' + (d.notes || 0) + ' notes' + (d.links && d.links.resolved ? ' · ' + d.links.resolved + ' links' : "") + (d.tasks && d.tasks.created ? ' · ' + d.tasks.created + ' tasks' : "")
          : "";
        var status = j.undoneAt ? "Undone" : active ? (p.phase === "discover" ? "Reading…" : "Importing…") : j.status === "done" ? "Done" : j.status === "failed" ? "Failed" : "Cancelled";
        return '<div class="imp-job ' + escapeHtml(j.status) + '" data-testid="qs-import-job">' +
          '<div class="imp-job-head"><span class="pill">' + kind + '</span> <strong>' + escapeHtml(j.label || "") + '</strong> <span class="hint">' + status + '</span></div>' +
          '<div class="progress-meter"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="hint">' + (p.done || 0) + (p.total ? " / " + p.total : "") + ' · ' + (r.created || 0) + ' new · ' + (r.updated || 0) + ' updated · ' + (r.unchanged || 0) + ' unchanged' + extra +
          (j.errorCount ? ' · <span class="err-msg" style="display:inline">' + j.errorCount + ' errors</span>' : "") + '</div>' +
          (j.status === "failed" && j.error ? '<div class="err-msg">' + escapeHtml(j.error) + '</div>' : "") +
          (!active && j.undoable && !j.undoneAt ? '<button class="ghost imp-undo" data-job="' + escapeHtml(j.id) + '">Undo this import</button>' : "") +
          '</div>';
      }
      function refreshImportJobs() {
        var box = document.getElementById("imp-jobs");
        if (!box) { if (state.imp && state.imp.timer) { clearTimeout(state.imp.timer); state.imp.timer = null; } return; }
        send("documents.notion.jobs.list", { limit: 6 }).then(function (r) {
          var jobs = (r && r.jobs) || [];
          box.innerHTML = jobs.length
            ? '<div class="card"><h2 class="h2">Your imports</h2><p class="hint">Running on this computer — you can continue setup; anything unfinished picks up again when InfiniBot starts.</p>' + jobs.map(jobLine).join("") + '</div>'
            : "";
          box.querySelectorAll(".imp-undo").forEach(function (b) {
            b.onclick = function () {
              if (!confirm("Undo this import? Imported notes go to Trash and any tasks it created are removed.")) return;
              b.disabled = true;
              send("documents.import.undo", { jobId: b.getAttribute("data-job") }).then(refreshImportJobs).catch(function (e) { toast((e && e.message) || "Undo failed", true); b.disabled = false; });
            };
          });
          var active = jobs.some(function (j) { return j.status === "queued" || j.status === "running"; });
          if (state.imp.timer) clearTimeout(state.imp.timer);
          state.imp.timer = active ? setTimeout(refreshImportJobs, 1500) : null;
        }).catch(function () {});
      }

      // ─────── Satellite mirror ───────
      // When this device is paired as a satellite, every step downstream
      // of Federation just displays what master pushed via the
      // identity-sync handshake (notion creds, model providers,
      // mcpServers, voice URLs). The operator can walk through the steps
      // for visibility but can't edit — changes happen on the master.
      function inSatelliteMirrorMode() {
        return state.federation.mode === "satellite" && state.federation.paired === true;
      }
      function satelliteMirrorBanner(stepLabel) {
        return '<h1 class="h1">' + escapeHtml(stepLabel) + '</h1>' +
          '<div class="card" style="border-color: var(--accent-primary, #4f9eff); background: rgba(79,158,255,0.04)">' +
            '<div style="display:flex; gap:10px; align-items:center; margin-bottom:8px">' +
              '<span style="font-size:18px">🛰️</span>' +
              '<strong>Mirrored from master</strong>' +
            '</div>' +
            '<p class="hint" style="margin:0">' +
              'This device runs as a satellite of <code>' + escapeHtml(state.federation.masterUrl || "master") + '</code>. ' +
              'Settings for this step come from the master and stay in sync. ' +
              'To change them, update the master and they\'ll re-sync automatically.' +
            '</p>' +
          '</div>';
      }
      function satelliteMirrorAppend(root, summaryHtml) {
        const card = document.createElement("div");
        card.className = "card";
        card.innerHTML = summaryHtml || '<p class="hint" style="margin:0">No values pushed yet — they\'ll appear after the next master sync.</p>';
        root.appendChild(card);
        root.appendChild(nav(null, null));
      }

      // ─────── Steps ───────
      function renderWelcome(root) {
        root.innerHTML =
          '<div class="hero">' +
            '<div class="hero-logo-wrap"><div class="hero-halo"></div>' + HERO_LOGO_SVG + '</div>' +
            '<div class="hero-eyebrow">InfiniBot Setup</div>' +
            '<h1 class="hero-title">Welcome. Let\'s bring <span class="grad">InfiniBot</span> online.</h1>' +
            '<p class="hero-sub">A guided, two-minute setup — your AI, your voice, your channels. Everything stays editable later under Advanced.</p>' +
            '<div class="hero-cta-row">' +
              '<button class="primary hero-cta" id="hero-begin">Begin setup →</button>' +
            '</div>' +
            '<p class="hint" style="margin-top:18px">Takes about 2 minutes · nothing is sent until you confirm</p>' +
          '</div>';
        var begin = root.querySelector("#hero-begin");
        if (begin) begin.addEventListener("click", function () {
          state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1);
          renderSidebar(); renderMain();
        });
      }
      var HERO_LOGO_SVG = '<svg class="hero-logo" viewBox="0 0 512 512" aria-hidden="true"><defs><linearGradient id="bgX" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101014"/><stop offset="1" stop-color="#050507"/></linearGradient><linearGradient id="goldX" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d77a"/><stop offset="1" stop-color="#d4af37"/></linearGradient></defs><rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bgX)"/><rect x="16" y="16" width="480" height="480" rx="112" fill="none" stroke="#d4af37" stroke-opacity="0.5" stroke-width="8"/><circle cx="120" cy="110" r="5" fill="#f4d77a" opacity="0.8"/><circle cx="396" cy="132" r="4" fill="#fff" opacity="0.6"/><circle cx="430" cy="330" r="5" fill="#f4d77a" opacity="0.6"/><circle cx="86" cy="350" r="4" fill="#fff" opacity="0.5"/><g class="hero-orbit"><ellipse cx="256" cy="276" rx="186" ry="76" fill="none" stroke="#d4af37" stroke-opacity="0.65" stroke-width="10" stroke-dasharray="36 22"/><circle cx="430" cy="252" r="16" fill="url(#goldX)"/></g><polygon points="256,150 412,276 256,402 100,276" fill="#14110a" stroke="url(#goldX)" stroke-width="14" stroke-linejoin="round"/><polygon points="256,196 366,276 256,356 146,276" fill="none" stroke="#a87a1e" stroke-width="6" stroke-linejoin="round" opacity="0.8"/><g class="hero-crystal"><polygon points="256,224 308,276 256,328 204,276" fill="url(#goldX)"/><polygon points="256,244 288,276 256,308 224,276" fill="#fff3c4" opacity="0.85"/></g></svg>';

      // ─────── Friendly onboarding steps ───────
      // These five steps (goals → provider → apikey → voice-setup → done) are
      // the simplified first-run flow that sits in front of the Advanced
      // steps. They reuse the same send()/toast()/escapeHtml() helpers and the
      // quickstart.* RPCs as the Advanced steps so there's a single config
      // path. Voice persists to ~/.infinibot/voice.json via quickstart.voice.*.
      function renderGoals(root) {
        const GOALS = [
          { id: "coding",    icon: "💻", name: "Coding agents",     desc: "Spawn AI coders that read, write, and ship code." },
          { id: "voice",     icon: "🎙️", name: "Voice control",      desc: "Talk to your bot — speech in, speech out." },
          { id: "agents",    icon: "🤖", name: "Autonomous agents",  desc: "Background agents that run tasks on their own." },
          { id: "exploring", icon: "🧭", name: "Just exploring",     desc: "Look around first — configure things later." },
        ];
        root.innerHTML =
          '<h1 class="h1">What do you want InfiniBot to do?</h1>' +
          '<p class="lead">Pick anything that sounds useful — this just tailors the tips you see. Everything stays available regardless of what you choose.</p>' +
          '<div class="goal-grid" id="goal-grid"></div>';
        const grid = root.querySelector("#goal-grid");
        GOALS.forEach(function (g) {
          const tile = document.createElement("div");
          tile.className = "goal-tile" + (state.selectedGoals.has(g.id) ? " selected" : "");
          tile.tabIndex = 0;
          tile.innerHTML = '<span class="goal-icon">' + g.icon + '</span>' +
            '<div class="goal-name">' + escapeHtml(g.name) + '</div>' +
            '<div class="goal-desc">' + escapeHtml(g.desc) + '</div>';
          const toggle = function () {
            if (state.selectedGoals.has(g.id)) state.selectedGoals.delete(g.id);
            else state.selectedGoals.add(g.id);
            tile.classList.toggle("selected");
          };
          tile.addEventListener("click", toggle);
          tile.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
          });
          grid.appendChild(tile);
        });
        root.appendChild(nav(null, "provider"));
      }

      // ─────── Unified provider catalog (single source) ───────
      // ONE list drives every provider surface in this wizard — the friendly
      // "Pick your AI" cards, the API-key step, AND the advanced Models step
      // dropdown — so a provider can never be present in one place and missing
      // in another. The Lit Advanced → Providers view (ui/.../api-keys.ts)
      // mirrors this set via KNOWN_PROVIDERS, and both write through the same
      // canonical path: quickstart.applyPatch → infinibot.json::models.providers
      // + agents.defaults.model.primary. baseUrl + api are required by the
      // models schema or the agent loop crashes on first turn.
      const PROV_CATALOG = [
        { id: "anthropic",    name: "Claude",      maker: "Anthropic",   emoji: "🟧", desc: "Best-in-class reasoning and coding.", badge: "Recommended", baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages", defaultModel: "claude-opus-4-7", needsKey: true, signup: "https://console.anthropic.com/settings/keys", envVar: "ANTHROPIC_API_KEY" },
        { id: "openai",       name: "GPT",         maker: "OpenAI",      emoji: "🟢", desc: "GPT-4o / o-series. Great all-rounder.", baseUrl: "https://api.openai.com/v1", api: "openai-responses", defaultModel: "gpt-4o", needsKey: true, signup: "https://platform.openai.com/api-keys", envVar: "OPENAI_API_KEY" },
        { id: "google",       name: "Gemini",      maker: "Google",      emoji: "🔵", desc: "Gemini 2.5 Pro / Flash. Long context.", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai-completions", defaultModel: "gemini-2.5-pro", needsKey: true, signup: "https://aistudio.google.com/apikey", envVar: "GEMINI_API_KEY" },
        // Listed early so it is visible without scrolling (a common no-GPU pick).
        { id: "ollama-cloud", name: "Ollama Cloud", maker: "Turbo",      emoji: "☁️", desc: "Hosted Ollama (Turbo).", baseUrl: "https://ollama.com/v1", api: "openai-completions", defaultModel: "${OLLAMA_CLOUD_DEFAULT_MODEL_ID}", needsKey: true, signup: "https://ollama.com", envVar: "OLLAMA_CLOUD_API_KEY" },
        { id: "mistral",      name: "Mistral",     maker: "Mistral AI",  emoji: "🌬️", desc: "Open-weight European models.", baseUrl: "https://api.mistral.ai/v1", api: "openai-completions", defaultModel: "mistral-large-latest", needsKey: true, signup: "https://console.mistral.ai/api-keys", envVar: "MISTRAL_API_KEY" },
        { id: "groq",         name: "Groq",        maker: "Groq",        emoji: "⚡", desc: "Fastest inference (LPU).", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", defaultModel: "llama-3.3-70b-versatile", needsKey: true, signup: "https://console.groq.com/keys", envVar: "GROQ_API_KEY" },
        { id: "cerebras",     name: "Cerebras",    maker: "Cerebras",    emoji: "🧠", desc: "Wafer-scale ultra-fast inference.", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions", defaultModel: "llama-3.3-70b", needsKey: true, signup: "https://cloud.cerebras.ai", envVar: "CEREBRAS_API_KEY" },
        { id: "together",     name: "Together",    maker: "Together AI", emoji: "🤝", desc: "Hundreds of open models.", baseUrl: "https://api.together.xyz/v1", api: "openai-completions", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", needsKey: true, signup: "https://api.together.xyz/settings/api-keys", envVar: "TOGETHER_API_KEY" },
        { id: "openrouter",   name: "OpenRouter",  maker: "Many models", emoji: "🔀", desc: "One key, hundreds of models.", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", defaultModel: "", needsKey: true, signup: "https://openrouter.ai/keys", envVar: "OPENROUTER_API_KEY" },
        { id: "deepseek",     name: "DeepSeek",    maker: "DeepSeek",    emoji: "🌊", desc: "Strong reasoning at low cost.", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", defaultModel: "deepseek-chat", needsKey: true, signup: "https://platform.deepseek.com/api_keys", envVar: "DEEPSEEK_API_KEY" },
        { id: "xai",          name: "Grok",        maker: "xAI",         emoji: "✖️", desc: "Grok models from xAI.", baseUrl: "https://api.x.ai/v1", api: "openai-completions", defaultModel: "grok-2-latest", needsKey: true, signup: "https://console.x.ai", envVar: "XAI_API_KEY" },
        { id: "zai",          name: "GLM",         maker: "Z.ai",        emoji: "🇿", desc: "GLM-4.5 series.", baseUrl: "https://api.z.ai/api/paas/v4", api: "openai-completions", defaultModel: "glm-4.5", needsKey: true, signup: "https://z.ai", envVar: "ZAI_API_KEY" },
        { id: "ollama",       name: "Ollama",      maker: "Local",       emoji: "🦙", desc: "Run open models locally. No API key.", baseUrl: "http://localhost:11434", api: "openai-completions", defaultModel: "llama3.2", needsKey: false, signup: "", envVar: "" },
        { id: "custom",       name: "Custom",      maker: "Advanced",    emoji: "⚙️", desc: "Any OpenAI-compatible endpoint.", baseUrl: "", api: "openai-completions", defaultModel: "", needsKey: true, signup: "", envVar: "" },
      ];
      function provEntry(id) {
        for (var i = 0; i < PROV_CATALOG.length; i++) if (PROV_CATALOG[i].id === id) return PROV_CATALOG[i];
        return null;
      }
      function provLabel(id) {
        const e = provEntry(id);
        return e ? (e.name + " (" + e.maker + ")") : id;
      }

      function renderProvider(root) {
        const PROVIDERS = PROV_CATALOG.filter(function (p) { return p.id !== "custom"; });
        const current = state.selectedProvider || (state.modelChoice && state.modelChoice.provider) || null;
        root.innerHTML =
          '<h1 class="h1">Pick your AI</h1>' +
          '<p class="lead">Choose the provider that powers your agents. You can change this anytime under Advanced → Models.</p>' +
          '<div class="provider-grid" id="prov-grid"></div>';
        const grid = root.querySelector("#prov-grid");
        PROVIDERS.forEach(function (pr) {
          const card = document.createElement("div");
          card.className = "provider-card" + (current === pr.id ? " selected" : "");
          card.tabIndex = 0;
          card.innerHTML =
            '<div class="provider-logo-wrap" style="background: rgba(255,255,255,0.04)">' + pr.emoji + '</div>' +
            '<div class="provider-name">' + escapeHtml(pr.name) + '</div>' +
            '<div class="provider-maker">' + escapeHtml(pr.maker) + '</div>' +
            '<div class="provider-desc">' + escapeHtml(pr.desc) + '</div>' +
            (pr.badge ? '<div class="provider-badges"><span class="pill ok">' + escapeHtml(pr.badge) + '</span></div>' : '');
          const choose = function () {
            state.selectedProvider = pr.id;
            state.modelChoice = Object.assign({}, state.modelChoice, { provider: pr.id });
            grid.querySelectorAll(".provider-card").forEach(function (c) { c.classList.remove("selected"); });
            card.classList.add("selected");
          };
          card.addEventListener("click", choose);
          card.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); }
          });
          grid.appendChild(card);
        });
        root.appendChild(nav(null, "apikey"));
      }

      function renderApiKey(root) {
        const provider = state.selectedProvider || (state.modelChoice && state.modelChoice.provider) || "anthropic";
        const entry = provEntry(provider) || {};
        const needsKey = entry.needsKey !== false && provider !== "ollama";
        const SIGNUP = {};
        if (entry.signup) SIGNUP[provider] = entry.signup;
        const NAME = {};
        NAME[provider] = provLabel(provider);
        // Catalog-backed helpers (single source = PROV_CATALOG). baseUrl + api
        // are required by the models schema or the agent loop crashes on first
        // turn (see renderModels' captureAndSave).
        function pBaseUrl(p) {
          const e = provEntry(p);
          return (e && e.baseUrl) || "https://api.anthropic.com/v1";
        }
        function pApi(p) {
          const e = provEntry(p);
          return (e && e.api) || "openai-completions";
        }
        root.innerHTML =
          '<h1 class="h1">Connect ' + escapeHtml(NAME[provider] || provider) + '</h1>' +
          '<p class="lead">' + (needsKey
            ? 'Paste your API key. It is stored locally in your config and only sent to the provider.'
            : 'Ollama runs locally — no API key needed. Make sure <code>ollama serve</code> is running.') + '</p>' +
          '<div class="card">' +
            (needsKey
              ? '<label>API key</label>' +
                '<div class="key-input-wrap">' +
                  '<input id="ak-key" type="password" placeholder="paste key here" />' +
                  '<button class="key-reveal-btn" id="ak-reveal" type="button">Show</button>' +
                '</div>' +
                (SIGNUP[provider] ? '<div class="hint">Need one? Get a key at <a href="' + SIGNUP[provider] + '" target="_blank" rel="noopener">' + escapeHtml(SIGNUP[provider]) + '</a></div>' : '') +
                (state.modelChoice && state.modelChoice.hasApiKey ? '<div class="hint">A saved key is in use — leave blank to keep it.</div>' : '')
              : '<label>Ollama host</label><input id="ak-endpoint" type="text" placeholder="http://localhost:11434" />') +
            '<div style="height:12px"></div>' +
            '<div class="actions" style="justify-content:flex-start;margin-top:4px">' +
              '<button class="ghost" id="ak-verify">Verify &amp; load models</button>' +
              '<span id="ak-status" class="hint"></span>' +
            '</div>' +
          '</div>';
        const keyEl = root.querySelector("#ak-key");
        const endpointEl = root.querySelector("#ak-endpoint");
        const statusEl = root.querySelector("#ak-status");
        const revealEl = root.querySelector("#ak-reveal");
        if (revealEl && keyEl) revealEl.addEventListener("click", function () {
          keyEl.type = keyEl.type === "password" ? "text" : "password";
          revealEl.textContent = keyEl.type === "password" ? "Show" : "Hide";
        });
        let fetchedModel = (state.modelChoice && state.modelChoice.model) || "";
        root.querySelector("#ak-verify").addEventListener("click", async function () {
          statusEl.innerHTML = '<span class="spinner"></span> Checking…';
          try {
            const res = await send("quickstart.providers.fetchModels", {
              provider: provider,
              apiKey: keyEl ? keyEl.value : "",
              endpoint: endpointEl ? endpointEl.value : "",
            });
            if (res.error) { statusEl.innerHTML = '<span class="validate-err">' + escapeHtml(res.error) + '</span>'; return; }
            const models = res.models || [];
            if (!models.length) { statusEl.innerHTML = '<span class="validate-err">No models found — check your key.</span>'; return; }
            fetchedModel = providerDefaultModel(provider, models);
            state.keyValidated = true;
            statusEl.innerHTML = '<span class="validate-ok">✓ ' + models.length + ' models — using ' + escapeHtml(fetchedModel) + '</span>';
          } catch (e) {
            statusEl.innerHTML = '<span class="validate-err">' + escapeHtml(e.message || "Verification failed") + '</span>';
          }
        });
        const save = async function () {
          const apiKey = keyEl ? keyEl.value : "";
          const endpoint = endpointEl ? endpointEl.value : "";
          const model = fetchedModel || providerDefaultModel(provider, []);
          state.modelChoice = { provider: provider, apiKey: apiKey, model: model, endpoint: endpoint };
          const patch = { agents: { defaults: { model: { primary: provider + "/" + model } } } };
          if (apiKey || endpoint) {
            const baseUrl = endpoint || pBaseUrl(provider);
            const api = pApi(provider);
            const modelDef = { id: model, name: model, api: api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
            const providerCfg = { baseUrl: baseUrl, api: api, models: [modelDef] };
            if (apiKey) providerCfg.apiKey = apiKey;
            patch.models = { providers: {} };
            patch.models.providers[provider] = providerCfg;
          }
          try {
            await send("quickstart.applyPatch", { patch: patch });
            markSaved(["apikey", "models"], "Saved ✓");
            toast("Saved");
          } catch (e) { toast(e.message || "Save failed", true); }
        };
        const navEl = nav(null, "voice-setup");
        navEl.querySelector("#next").addEventListener("click", save);
        root.appendChild(navEl);
      }

      function renderVoiceSetup(root) {
        const vc = state.voiceChoice;
        let mode = vc.mode || "cloud";
        // Hardcoded fallbacks; overwritten by quickstart.voice.get when it lands.
        const SIGNUP = { groq: "https://console.groq.com/keys", elevenlabs: "https://elevenlabs.io/app/settings/api-keys" };
        let savedHasSttKey = false, savedHasTtsKey = false;
        root.innerHTML =
          '<h1 class="h1">Voice</h1>' +
          '<p class="lead">Choose how InfiniBot listens and speaks. Skip it now and set it up later with <code>infinibot voice up</code> — your call.</p>' +
          '<div class="voice-grid" id="voice-mode-grid"></div>' +
          '<div id="voice-detail"></div>';
        const MODES = [
          { id: "cloud",  icon: "☁️", badge: "Best for instant", name: "Cloud",   desc: "Groq + ElevenLabs. Top quality, free tiers, needs API keys." },
          { id: "native", icon: "🔒", badge: "Best for privacy", name: "On device", desc: "whisper.cpp runs locally. Private, no API key." },
          { id: "docker", icon: "⚙️", badge: "Best for power",   name: "Docker",  desc: "Kokoro + Speaches containers via docker-compose." },
        ];
        const grid = root.querySelector("#voice-mode-grid");
        const detail = root.querySelector("#voice-detail");

        function mountMicUI(host) {
          if (!host) return;
          host.innerHTML =
            '<div class="mic-meter-wrap" id="mic-live" style="display:none">' +
              '<span class="mic-meter-label">Mic level</span>' +
              '<div class="mic-meter" id="mic-bars"></div>' +
              '<button class="mic-meter-btn ghost" type="button" id="mic-stop">Stop</button>' +
            '</div>' +
            '<button class="mic-meter-btn ghost" type="button" id="mic-start" style="margin-top:10px">🎤 Test microphone</button>';
          var startBtn = host.querySelector("#mic-start");
          var liveWrap = host.querySelector("#mic-live");
          var stopBtn = host.querySelector("#mic-stop");
          var barsEl = host.querySelector("#mic-bars");
          var NBARS = 14, bars = [];
          for (var i = 0; i < NBARS; i++) { var b = document.createElement("div"); b.className = "mic-bar"; barsEl.appendChild(b); bars.push(b); }
          startBtn.addEventListener("click", function () {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { startBtn.textContent = "Mic not available"; startBtn.disabled = true; return; }
            navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
              var Ctx = window.AudioContext || window.webkitAudioContext;
              var ctx = new Ctx();
              var srcN = ctx.createMediaStreamSource(stream);
              var an = ctx.createAnalyser(); an.fftSize = 64; srcN.connect(an);
              var data = new Uint8Array(an.frequencyBinCount);
              var raf = 0;
              function loop() {
                an.getByteFrequencyData(data);
                for (var j = 0; j < NBARS; j++) { var v = (data[j + 1] || 0) / 255; bars[j].style.transform = "scaleY(" + Math.max(0.08, v) + ")"; bars[j].style.opacity = String(0.3 + v * 0.7); }
                raf = requestAnimationFrame(loop);
              }
              loop();
              startBtn.style.display = "none"; liveWrap.style.display = "flex";
              window.__qsMicStop = function () {
                if (raf) cancelAnimationFrame(raf);
                try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
                try { ctx.close(); } catch (e) {}
                startBtn.style.display = ""; startBtn.textContent = "🎤 Test microphone";
                if (liveWrap) liveWrap.style.display = "none";
                window.__qsMicStop = null;
              };
            }).catch(function () { startBtn.textContent = "Mic blocked — allow access"; });
          });
          stopBtn.addEventListener("click", function () { if (window.__qsMicStop) window.__qsMicStop(); });
        }

        function renderDetail() {
          if (window.__qsMicStop) { try { window.__qsMicStop(); } catch (e) {} }
          if (mode === "cloud") {
            detail.innerHTML =
              '<div class="card">' +
                '<label>Groq API key — speech-to-text</label>' +
                '<div class="key-input-wrap">' +
                  '<input id="v-stt" type="password" placeholder="gsk_…" />' +
                  '<button class="key-reveal-btn" type="button" data-rev="v-stt">Show</button>' +
                '</div>' +
                '<div class="hint">Get one free at <a id="v-stt-url" href="' + SIGNUP.groq + '" target="_blank" rel="noopener">' + escapeHtml(SIGNUP.groq) + '</a></div>' +
                '<div style="height:14px"></div>' +
                '<label>ElevenLabs API key — text-to-speech</label>' +
                '<div class="key-input-wrap">' +
                  '<input id="v-tts" type="password" placeholder="sk_…" />' +
                  '<button class="key-reveal-btn" type="button" data-rev="v-tts">Show</button>' +
                '</div>' +
                '<div class="hint">Get one free at <a id="v-tts-url" href="' + SIGNUP.elevenlabs + '" target="_blank" rel="noopener">' + escapeHtml(SIGNUP.elevenlabs) + '</a></div>' +
                '<div id="v-status" class="hint" style="margin-top:10px"></div>' +
                '<div id="v-mic-host"></div>' +
              '</div>';
            const sttEl = detail.querySelector("#v-stt");
            const ttsEl = detail.querySelector("#v-tts");
            if (sttEl) sttEl.value = vc.sttKey || "";
            if (ttsEl) ttsEl.value = vc.ttsKey || "";
            detail.querySelectorAll("[data-rev]").forEach(function (btn) {
              btn.addEventListener("click", function () {
                const inp = detail.querySelector("#" + btn.getAttribute("data-rev"));
                if (!inp) return;
                inp.type = inp.type === "password" ? "text" : "password";
                btn.textContent = inp.type === "password" ? "Show" : "Hide";
              });
            });
            if (sttEl) sttEl.addEventListener("input", function () { vc.sttKey = sttEl.value; });
            if (ttsEl) ttsEl.addEventListener("input", function () { vc.ttsKey = ttsEl.value; });
            const st = detail.querySelector("#v-status");
            if (st && (savedHasSttKey || savedHasTtsKey)) {
              st.innerHTML = (savedHasSttKey ? '<span class="validate-ok">✓ speech-to-text key saved</span> ' : '') +
                (savedHasTtsKey ? '<span class="validate-ok">✓ speech key saved</span>' : '');
            }
            mountMicUI(detail.querySelector("#v-mic-host"));
          } else if (mode === "native") {
            detail.innerHTML =
              '<div class="card">' +
                '<p style="margin:0">Speech runs locally with whisper.cpp + Kokoro. No API keys. Installing downloads the model (~150&nbsp;MB) and builds/links the local engine.</p>' +
                '<div class="actions" style="margin-top:12px">' +
                  '<button class="primary" id="v-install" type="button">Install voice (local)</button>' +
                  '<button class="ghost" id="v-reinstall" type="button" style="display:none">Reinstall</button>' +
                '</div>' +
                '<div id="v-install-state" class="hint" style="margin-top:10px"></div>' +
                '<div id="v-mic-host"></div>' +
                '<pre id="v-install-log" style="display:none;margin-top:10px;max-height:180px;overflow:auto;background:#0c0c12;border:1px solid var(--line-strong);border-radius:8px;padding:10px;font-size:11px;line-height:1.4;white-space:pre-wrap"></pre>' +
              '</div>';
            wireNativeInstall();
            mountMicUI(detail.querySelector("#v-mic-host"));
          } else {
            detail.innerHTML =
              '<div class="card">' +
                '<p style="margin:0">Runs LiveKit + Speaches (speech-to-text) + Kokoro (speech) in Docker. Installing pulls the images and starts the stack.</p>' +
                '<p class="hint" style="margin-top:6px">Needs Docker running. The Speaches image is GPU (CUDA) only.</p>' +
                '<div class="actions" style="margin-top:12px">' +
                  '<button class="primary" id="v-dinstall" type="button">Install &amp; start Docker stack</button>' +
                '</div>' +
                '<div id="v-dinstall-state" class="hint" style="margin-top:10px"></div>' +
                '<pre id="v-dinstall-log" style="display:none;margin-top:10px;max-height:180px;overflow:auto;background:#0c0c12;border:1px solid var(--line-strong);border-radius:8px;padding:10px;font-size:11px;line-height:1.4;white-space:pre-wrap"></pre>' +
              '</div>';
            wireDockerInstall();
          }
        }

        // ── SSE install driver (shared by native + docker) ────────────────
        // POSTs to an /api/voice/*/install endpoint and parses the text/event-
        // stream. Calls handlers per event; returns the final done/error data.
        function runInstallSSE(url, body, handlers) {
          return new Promise(function (resolve, reject) {
            // Attach the same shared secret the WS connect uses: every gateway
            // HTTP route requires it (there is no loopback exemption).
            var auth = (typeof readAuthFromHash === "function" ? readAuthFromHash() : (window.__readAuthFromHash ? window.__readAuthFromHash() : {})) || {};
            var headers = { "content-type": "application/json" };
            var bearer = (auth && (auth.token || auth.password)) || "";
            if (bearer) headers["authorization"] = "Bearer " + bearer;
            fetch(url, {
              method: "POST",
              headers: headers,
              body: JSON.stringify(body || {}),
            }).then(function (resp) {
              if (!resp.ok || !resp.body) { reject(new Error("install request failed: HTTP " + resp.status)); return; }
              const reader = resp.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              let settled = false;
              function pump() {
                reader.read().then(function (r) {
                  if (r.done) { if (!settled) reject(new Error("install stream ended without a result")); return; }
                  buf += dec.decode(r.value, { stream: true });
                  const frames = buf.split("\n\n");
                  buf = frames.pop() || "";
                  for (const frame of frames) {
                    let ev = "message", data = "";
                    for (const line of frame.split("\n")) {
                      if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
                      else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
                    }
                    let parsed = {};
                    try { parsed = data ? JSON.parse(data) : {}; } catch (e) {}
                    if (handlers[ev]) handlers[ev](parsed);
                    if (ev === "done") { settled = true; resolve(parsed); }
                    if (ev === "error") { settled = true; reject(new Error(parsed.error || "install failed")); }
                  }
                  pump();
                }).catch(reject);
              }
              pump();
            }).catch(reject);
          });
        }

        function appendInstallLog(pre, line) {
          if (!pre) return;
          pre.style.display = "block";
          pre.textContent += (pre.textContent ? "\n" : "") + line;
          pre.scrollTop = pre.scrollHeight;
        }

        function wireNativeInstall() {
          const btn = detail.querySelector("#v-install");
          const reBtn = detail.querySelector("#v-reinstall");
          const stateEl = detail.querySelector("#v-install-state");
          const logEl = detail.querySelector("#v-install-log");
          if (!btn) return;
          // Re-entrance: detect an existing install and offer use-existing.
          // Gateway HTTP routes need the shared secret (same one the WS uses).
          var qsAuth = (typeof readAuthFromHash === "function" ? readAuthFromHash() : {}) || {};
          var qsBearer = (qsAuth && (qsAuth.token || qsAuth.password)) || "";
          fetch("/api/voice/native/status", {
            headers: qsBearer ? { authorization: "Bearer " + qsBearer } : {},
          }).then(function (r) { return r.json(); }).then(function (s) {
            if (s && s.installed) {
              vc.nativeInstalled = true;
              stateEl.innerHTML = '<span class="validate-ok">✓ Already installed</span> — click Next to use it, or Reinstall.';
              btn.style.display = "none";
              if (reBtn) reBtn.style.display = "inline-block";
            }
          }).catch(function () {});

          function doInstall() {
            vc.nativeInstalled = false;
            btn.disabled = true; if (reBtn) reBtn.disabled = true;
            if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
            stateEl.innerHTML = '<span class="spinner"></span> Installing…';
            runInstallSSE("/api/voice/native/install", { model: "ggml-base.en" }, {
              phase: function (d) { stateEl.innerHTML = '<span class="spinner"></span> ' + escapeHtml(d.phase + ": " + (d.status || "")); },
              log: function (d) { appendInstallLog(logEl, d.line || ""); },
              progress: function (d) {
                if (d.percent != null) stateEl.innerHTML = '<span class="spinner"></span> Downloading model… ' + d.percent + '%' + (d.etaSec != null ? ' (~' + d.etaSec + 's left)' : '');
              },
            }).then(function (done) {
              vc.nativeInstalled = true;
              const warn = (done.notes && done.notes.length) ? ' <span class="hint">(' + escapeHtml(done.notes.join("; ")) + ')</span>' : '';
              stateEl.innerHTML = '<span class="validate-ok">✓ Installed — STT' + (done.ttsReady ? ' + TTS' : '') + ' ready</span>' + warn;
              btn.style.display = "none";
              if (reBtn) { reBtn.style.display = "inline-block"; reBtn.disabled = false; }
            }).catch(function (e) {
              vc.nativeInstalled = false;
              btn.disabled = false; if (reBtn) reBtn.disabled = false;
              stateEl.innerHTML = '<span class="validate-err">✗ ' + escapeHtml(e.message || "Install failed") + '</span> — fix and Retry.';
            });
          }
          btn.addEventListener("click", doInstall);
          if (reBtn) reBtn.addEventListener("click", doInstall);
        }

        function wireDockerInstall() {
          const btn = detail.querySelector("#v-dinstall");
          const stateEl = detail.querySelector("#v-dinstall-state");
          const logEl = detail.querySelector("#v-dinstall-log");
          if (!btn) return;
          btn.addEventListener("click", function () {
            vc.dockerInstalled = false;
            btn.disabled = true;
            if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
            stateEl.innerHTML = '<span class="spinner"></span> Starting Docker voice stack…';
            runInstallSSE("/api/voice/docker/install", {}, {
              phase: function (d) { stateEl.innerHTML = '<span class="spinner"></span> ' + escapeHtml(d.phase + ": " + (d.status || "")); },
              log: function (d) { appendInstallLog(logEl, d.line || ""); },
            }).then(function (done) {
              vc.dockerInstalled = !!done.ok;
              btn.disabled = false;
              const svc = (done.services || []).map(function (s) { return s.name + (s.reachable ? " ✓" : " ✗"); }).join("  ");
              if (done.ok) {
                stateEl.innerHTML = '<span class="validate-ok">✓ Stack running</span> &nbsp;' + escapeHtml(svc);
              } else {
                const notes = (done.notes && done.notes.length) ? ' — ' + escapeHtml(done.notes.join("; ")) : '';
                stateEl.innerHTML = '<span class="validate-err">Stack partially up:</span> ' + escapeHtml(svc) + notes;
              }
            }).catch(function (e) {
              vc.dockerInstalled = false;
              btn.disabled = false;
              stateEl.innerHTML = '<span class="validate-err">✗ ' + escapeHtml(e.message || "Install failed") + '</span> — fix and Retry.';
            });
          });
        }

        MODES.forEach(function (m) {
          const card = document.createElement("div");
          card.className = "voice-card" + (mode === m.id ? " selected" : "");
          card.tabIndex = 0;
          card.innerHTML = '<div class="voice-card-badge">' + escapeHtml(m.badge) + '</div>' +
            '<div class="voice-card-icon">' + m.icon + '</div>' +
            '<div class="voice-card-name">' + escapeHtml(m.name) + '</div>' +
            '<div class="voice-card-desc">' + escapeHtml(m.desc) + '</div>';
          const choose = function () {
            mode = m.id; vc.mode = m.id;
            grid.querySelectorAll(".voice-card").forEach(function (c) { c.classList.remove("selected"); });
            card.classList.add("selected");
            renderDetail();
          };
          card.addEventListener("click", choose);
          card.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); }
          });
          grid.appendChild(card);
        });
        renderDetail();

        // Pull signup URLs + saved key presence from the gateway (best-effort:
        // the step already works with the hardcoded fallbacks above).
        send("quickstart.voice.get", {}).then(function (res) {
          if (!res) return;
          const urls = res.signupUrls || {};
          if (urls.groq) { SIGNUP.groq = urls.groq; const a = detail.querySelector("#v-stt-url"); if (a) { a.href = urls.groq; a.textContent = urls.groq; } }
          if (urls.elevenlabs) { SIGNUP.elevenlabs = urls.elevenlabs; const a = detail.querySelector("#v-tts-url"); if (a) { a.href = urls.elevenlabs; a.textContent = urls.elevenlabs; } }
          const cur = res.catalog && res.catalog.current;
          if (cur) {
            savedHasSttKey = !!(cur.stt && cur.stt.hasKey);
            savedHasTtsKey = !!(cur.tts && cur.tts.hasKey);
            if (mode === "cloud") renderDetail();
          }
        }).catch(function () {});

        // ── Voice brain (conversational LLM) picker ──────────────────────
        // Independent of the STT/TTS stack above: pins the gateway agent's
        // conversational brain to the cloud default or a local Ollama model.
        // Writes agents.defaults.model.primary via the voice.setup.brain RPC.
        const brain = state.voiceBrain || (state.voiceBrain = { provider: "cloud", modelId: "", ollama: { running: false, models: [] } });
        const brainSection = document.createElement("div");
        brainSection.style.marginTop = "28px";
        brainSection.innerHTML =
          '<h2 class="h2" style="font-size:18px;margin:0 0 4px">Voice brain</h2>' +
          '<p class="lead" style="margin:0 0 12px">Which model thinks and replies during a voice chat. The speech-to-text and speech options above are separate.</p>' +
          '<div class="voice-grid" id="brain-mode-grid"></div>' +
          '<div id="brain-detail"></div>';
        root.appendChild(brainSection);
        const brainGrid = brainSection.querySelector("#brain-mode-grid");
        const brainDetail = brainSection.querySelector("#brain-detail");
        const BRAIN_MODES = [
          { id: "cloud",  name: "Cloud (default)", desc: "Use your configured provider (Claude / OpenAI / Gemini). Best quality." },
          { id: "ollama", name: "Local (Ollama)",  desc: "Run the conversation on a local Ollama model. Private, offline, no API cost." },
        ];
        function renderBrainDetail() {
          if (brain.provider === "ollama") {
            const oll = brain.ollama || { running: false, models: [] };
            if (!oll.running) {
              brainDetail.innerHTML = '<div class="card"><p style="margin:0">Ollama not detected' +
                (oll.host ? ' at <code>' + escapeHtml(oll.host) + '</code>' : '') + '. ' +
                escapeHtml(oll.installHint || 'Install from https://ollama.com, run "ollama serve", then "ollama pull llama3.2".') +
                '</p></div>';
              return;
            }
            const opts = (oll.models || []).map(function (m) {
              return '<option value="' + escapeHtml(m) + '"' + (m === brain.modelId ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
            }).join('');
            brainDetail.innerHTML = '<div class="card"><label>Local model</label>' +
              '<select id="brain-model">' + opts + '</select>' +
              '<div class="hint">Pins <code>agents.defaults.model</code>. Takes effect after the gateway restarts.</div></div>';
            const sel = brainDetail.querySelector("#brain-model");
            if (sel) {
              if (!brain.modelId && oll.models && oll.models.length) brain.modelId = oll.models[0];
              if (brain.modelId) sel.value = brain.modelId;
              sel.addEventListener("change", function () { brain.modelId = sel.value; });
            }
          } else {
            brainDetail.innerHTML = '<div class="card"><p style="margin:0">The bot thinks with your configured default provider. Change it any time in the Models step.</p></div>';
          }
        }
        BRAIN_MODES.forEach(function (m) {
          const card = document.createElement("div");
          card.className = "voice-card" + (brain.provider === m.id ? " selected" : "");
          card.tabIndex = 0;
          card.innerHTML = '<div class="voice-card-name">' + escapeHtml(m.name) + '</div><div class="voice-card-desc">' + escapeHtml(m.desc) + '</div>';
          const choose = function () {
            brain.provider = m.id;
            brainGrid.querySelectorAll(".voice-card").forEach(function (c) { c.classList.remove("selected"); });
            card.classList.add("selected");
            renderBrainDetail();
          };
          card.addEventListener("click", choose);
          card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
          brainGrid.appendChild(card);
        });
        renderBrainDetail();
        // Hydrate the current selection, then the local model list (both
        // best-effort: the picker already works with the cloud default).
        send("voice.setup.brainGet", {}).then(function (res) {
          if (res && (res.provider === "ollama" || res.provider === "cloud")) {
            brain.provider = res.provider;
            if (res.provider === "ollama" && res.modelId) brain.modelId = res.modelId;
          }
          brainGrid.querySelectorAll(".voice-card").forEach(function (c, i) {
            c.classList.toggle("selected", BRAIN_MODES[i].id === brain.provider);
          });
          renderBrainDetail();
        }).catch(function () {});
        send("voice.setup.ollamaModels", {}).then(function (res) {
          if (res) { brain.ollama = res; renderBrainDetail(); }
        }).catch(function () {});

        // Custom action bar so Continue can BLOCK on a failed save (missing
        // keys) instead of advancing optimistically like the other steps.
        const bar = document.createElement("div");
        bar.className = "actions split";
        bar.innerHTML =
          '<button class="ghost" id="v-back">← Back</button>' +
          '<div style="display:flex;gap:12px">' +
            '<button class="ghost" id="v-skip">Skip for now</button>' +
            '<button class="primary" id="v-next">Continue →</button>' +
          '</div>';
        bar.querySelector("#v-back").addEventListener("click", function () {
          state.currentStep = Math.max(0, state.currentStep - 1); renderSidebar(); renderMain();
        });
        bar.querySelector("#v-skip").addEventListener("click", function () {
          state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1); renderSidebar(); renderMain();
        });
        bar.querySelector("#v-next").addEventListener("click", async function () {
          vc.mode = mode;
          if (mode === "cloud") {
            const sttEl = detail.querySelector("#v-stt");
            const ttsEl = detail.querySelector("#v-tts");
            vc.sttKey = (sttEl && sttEl.value) || vc.sttKey || "";
            vc.ttsKey = (ttsEl && ttsEl.value) || vc.ttsKey || "";
            // Client-side guard: require a key for each unless one is already
            // saved on disk (server re-validates against config + env vars).
            if ((!vc.sttKey && !savedHasSttKey) || (!vc.ttsKey && !savedHasTtsKey)) {
              const st = detail.querySelector("#v-status");
              if (st) st.innerHTML = '<span class="validate-err">Paste both keys (or click Skip to set them up later).</span>';
              return;
            }
          } else if (mode === "native") {
            // Hard gate: the local engine must be installed + self-tested before
            // we let the step complete. This is the fix for "wizard let me finish
            // native, then STT said the binary wasn't found".
            if (!vc.nativeInstalled) {
              const st = detail.querySelector("#v-install-state");
              if (st) st.innerHTML = '<span class="validate-err">Click "Install voice (local)" and wait for ✓ before continuing (or Skip to set up later).</span>';
              return;
            }
          } else if (mode === "docker") {
            // Hard gate: the Docker stack must be reachable before completing.
            if (!vc.dockerInstalled) {
              const st = detail.querySelector("#v-dinstall-state");
              if (st) st.innerHTML = '<span class="validate-err">Click "Install &amp; start Docker stack" and wait for ✓ before continuing (or Skip to set up later).</span>';
              return;
            }
          }
          try {
            await send("quickstart.voice.save", {
              mode: mode,
              sttProvider: mode === "cloud" ? "groq" : "native",
              ttsProvider: mode === "cloud" ? "elevenlabs" : "native",
              sttKey: vc.sttKey,
              ttsKey: vc.ttsKey,
            });
            // Persist the conversational brain choice (independent of the
            // STT/TTS stack). Cloud with no explicit model is a no-op — it
            // leaves the configured default provider in place.
            try {
              if (brain.provider === "ollama" && brain.modelId) {
                await send("voice.setup.brain", { provider: "ollama", modelId: brain.modelId });
              } else if (brain.provider === "cloud" && brain.modelId) {
                await send("voice.setup.brain", { provider: "cloud", modelId: brain.modelId });
              }
            } catch (be) { /* non-fatal: voice stack already saved */ }
            markSaved(["voice-setup"], "Voice saved ✓");
            toast("Voice saved");
          } catch (e) {
            const st = detail.querySelector("#v-status");
            if (st) st.innerHTML = '<span class="validate-err">' + escapeHtml(e.message || "Could not save voice settings") + '</span>';
            else toast(e.message || "Could not save voice settings", true);
            return; // stay on the step so the user can fix the key
          }
          state.currentStep = Math.min(STEPS.length - 1, state.currentStep + 1);
          renderSidebar(); renderMain();
        });
        root.appendChild(bar);
      }

      // "Pick your coder" (optional): shown when the user wants coding agents.
      // Links into Setup › Coders, which installs into InfiniBot's own folder
      // and handles sign-in; nothing is installed from this page.
      var QS_CODERS = ${QUICKSTART_CODERS_JSON};
      function coderPickerHtml() {
        if (!state.selectedGoals || !state.selectedGoals.has("coding")) return "";
        var base = IS_STANDALONE ? ("http://localhost:" + (state.gatewayPort || 18789)) : "";
        return '<div class="card" id="coder-picker">' +
          '<div style="font-weight:700;margin-bottom:4px">Pick your coder <span class="hint">(optional)</span></div>' +
          '<div class="hint" style="margin-bottom:12px">One click installs it into InfiniBot\'s own folder, then sign in. You can do this any time in Setup › Coders.</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">' +
          QS_CODERS.map(function (c) {
            return '<a class="ghost" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--line-strong);text-decoration:none;color:var(--text)" target="_blank" rel="noopener" href="' +
              base + '/setup?view=coders&amp;coder=' + encodeURIComponent(c.id) + '">' +
              '<span style="display:grid;place-items:center;width:30px;height:30px;border-radius:9px;border:1px solid var(--accent-deep);color:var(--accent);font-weight:700">' + escapeHtml(c.monogram) + '</span>' +
              '<span><span style="display:block;font-weight:600">' + escapeHtml(c.name) + '</span><span class="hint">' + escapeHtml(c.vendor) + '</span></span></a>';
          }).join("") +
          '</div></div>';
      }

      function renderDone(root) {
        const FEAT = [
          { icon: "💬", title: "Chat & channels", desc: 'Connect Telegram, Discord, Slack and more under Advanced → Channels.' },
          { icon: "🎙️", title: "Voice",            desc: 'Talk to your bot — manage it anytime with <code>infinibot voice</code>.' },
          { icon: "🤖", title: "Agents",           desc: 'Spawn coder and autonomous agents from the control UI.' },
        ];
        var chips = [];
        var prov = (state.modelChoice && state.modelChoice.provider) || state.selectedProvider;
        if (prov) chips.push("AI · " + prov);
        var vm = state.voiceChoice && state.voiceChoice.mode;
        var VMAP = { cloud: "Cloud voice", native: "On-device voice", docker: "Docker voice" };
        if (vm) chips.push(VMAP[vm] || vm);
        var goalN = state.selectedGoals ? state.selectedGoals.size : 0;
        if (goalN) chips.push(goalN + " goal" + (goalN > 1 ? "s" : "") + " tailored");
        var chN = state.channels ? Object.keys(state.channels).length : 0;
        if (chN) chips.push(chN + " channel" + (chN > 1 ? "s" : ""));
        if (!chips.length) chips.push("Ready to go");
        var chipsHtml = chips.map(function (c) { return '<span class="summary-chip"><span class="dot"></span>' + escapeHtml(c) + '</span>'; }).join("");
        root.innerHTML =
          '<div style="text-align:center;display:flex;flex-direction:column;align-items:center">' +
            '<svg class="done-check" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42"/><path d="M30 52 L45 67 L72 36"/></svg>' +
            '<h1 class="h1" style="margin-bottom:8px">You\'re all set</h1>' +
            '<p class="lead" style="margin-bottom:18px">InfiniBot is configured. One click builds the control UI and opens it.</p>' +
            '<div class="summary-chips" style="justify-content:center">' + chipsHtml + '</div>' +
          '</div>' +
          '<div style="height:22px"></div>' +
          '<div class="card">' + FEAT.map(function (f) {
            return '<div class="done-feature"><div class="done-feature-icon">' + f.icon + '</div>' +
              '<div><div style="font-weight:700">' + escapeHtml(f.title) + '</div>' +
              '<div class="hint" style="margin-top:2px">' + f.desc + '</div></div></div>';
          }).join("") + '</div>' +
          coderPickerHtml() +
          '<div class="card">' +
            '<div id="done-status">Ready when you are.</div>' +
            '<div class="actions" id="done-actions" style="margin-top:12px">' +
              '<button class="ghost" id="done-back">← Back</button>' +
              '<button class="primary" id="done-finish">Finish &amp; open InfiniBot</button>' +
            '</div>' +
          '</div>';
        root.querySelector("#done-back").addEventListener("click", function () {
          state.currentStep = Math.max(0, state.currentStep - 1); renderSidebar(); renderMain();
        });
        root.querySelector("#done-finish").addEventListener("click", async function () {
          const statusEl = root.querySelector("#done-status");
          const actionsEl = root.querySelector("#done-actions");
          statusEl.innerHTML = '<span class="spinner"></span> Finalizing…';
          try {
            await send("quickstart.finalize", {});
            statusEl.innerHTML = '<span class="spinner"></span> Building the control UI… (first build can take 20–60s)';
            const res = await send("quickstart.buildUi", {});
            const verb = res && res.alreadyBuilt ? "ready" : "built";
            if (IS_STANDALONE) {
              const gwPort = state.gatewayPort || 18789;
              statusEl.innerHTML = '<div style="color:var(--ok)">✓ Setup complete — control UI ' + verb + '. Start InfiniBot with <code>infinibot gateway run</code>, then open <code>http://localhost:' + gwPort + '/</code>.</div>';
              actionsEl.innerHTML = "";
            } else {
              statusEl.innerHTML = '<div style="color:var(--ok)">✓ Control UI ' + verb + '. Opening it now…</div>';
              actionsEl.innerHTML = '<a class="primary" href="/" target="_blank" rel="noopener">Open control UI</a>';
              window.open("/", "_blank", "noopener");
            }
            toast("Setup complete! 🎉");
          } catch (e) {
            statusEl.innerHTML = '<div class="err-msg">' + escapeHtml(e.message || "Finish failed") + '</div>';
          }
        });
      }

      function renderModels(root) {
        if (inSatelliteMirrorMode()) {
          root.innerHTML = satelliteMirrorBanner("Models & auth");
          const mc = state.modelChoice || {};
          const primary = (mc.provider && mc.model) ? (mc.provider + " / " + mc.model) : "(not set on master)";
          const summary =
            '<dl style="margin:0; display:grid; grid-template-columns: max-content 1fr; gap:6px 12px">' +
              '<dt>Primary model</dt><dd>' + escapeHtml(primary) + '</dd>' +
              '<dt>API key</dt><dd>' + (mc.hasApiKey ? '✓ configured on master' : '— not configured') + '</dd>' +
              (mc.endpoint ? '<dt>Endpoint</dt><dd><code>' + escapeHtml(mc.endpoint) + '</code></dd>' : '') +
            '</dl>';
          satelliteMirrorAppend(root, summary);
          return;
        }
        root.innerHTML =
          '<h1 class="h1">Models &amp; auth</h1>' +
          '<p class="lead">Pick a provider, paste your API key, and we will fetch the live model list from the provider.</p>' +
          '<div class="card">' +
            '<label>Primary provider</label>' +
            '<select id="provider">' +
              PROV_CATALOG.map(function (p) {
                return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(provLabel(p.id)) + '</option>';
              }).join("") +
            '</select>' +
            '<div style="height:12px"></div>' +
            '<div id="apikey-wrap">' +
              '<label>API key</label>' +
              '<input id="apikey" type="password" placeholder="paste key here" />' +
              '<div class="hint" id="apikey-hint">Stored locally. Sent only to the providers API.</div>' +
            '</div>' +
            '<div id="endpoint-wrap" style="display:none">' +
              '<div style="height:12px"></div>' +
              '<label>Ollama host</label>' +
              '<input id="endpoint" type="text" placeholder="http://localhost:11434" />' +
              '<div class="hint">Defaults to localhost. Override only if your Ollama server is remote.</div>' +
            '</div>' +
            '<div style="height:12px"></div>' +
            '<div class="actions" style="justify-content: flex-start; margin-top: 6px;">' +
              '<button class="ghost" id="fetch-models">Fetch models</button>' +
              '<span id="fetch-status" class="hint"></span>' +
            '</div>' +
            '<div style="height:12px"></div>' +
            '<label>Primary model</label>' +
            '<select id="model"><option value="">(fetch first)</option></select>' +
            '<div style="height:6px"></div>' +
            '<div class="hint">Tip: smaller models are faster and cheaper; larger models reason better.</div>' +
          '</div>';
        const provEl = root.querySelector("#provider");
        const keyEl = root.querySelector("#apikey");
        const modelEl = root.querySelector("#model");
        const endpointEl = root.querySelector("#endpoint");
        const fetchStatus = root.querySelector("#fetch-status");
        const apikeyWrap = root.querySelector("#apikey-wrap");
        const endpointWrap = root.querySelector("#endpoint-wrap");
        provEl.value = state.modelChoice?.provider || "anthropic";
        keyEl.value = state.modelChoice?.apiKey || "";
        if (state.modelChoice?.endpoint) endpointEl.value = state.modelChoice.endpoint;
        const apikeyHint = root.querySelector("#apikey-hint");
        if (apikeyHint && state.modelChoice?.hasApiKey && !state.modelChoice?.apiKey) {
          apikeyHint.textContent =
            "Saved key in use — leave blank to keep, or paste a new one to replace.";
        }
        // Pre-seed the model dropdown with the saved selection so a revisit
        // without clicking "Fetch models" doesn't silently fall back to the
        // provider default in captureAndSave.
        if (state.modelChoice?.model) {
          const saved = state.modelChoice.model;
          modelEl.innerHTML = "";
          const opt = document.createElement("option");
          opt.value = saved;
          opt.textContent = saved + "  (saved)";
          modelEl.appendChild(opt);
          modelEl.value = saved;
        }

        const updateProviderUI = () => {
          const p = provEl.value;
          // Local Ollama needs no key, just an endpoint.
          if (p === "ollama") {
            apikeyWrap.style.display = "none";
            endpointWrap.style.display = "block";
          } else if (p === "custom") {
            apikeyWrap.style.display = "block";
            endpointWrap.style.display = "block";
          } else {
            apikeyWrap.style.display = "block";
            endpointWrap.style.display = "none";
          }
          // Reset model list when provider changes.
          modelEl.innerHTML = '<option value="">(fetch first)</option>';
          fetchStatus.textContent = "";
        };
        provEl.addEventListener("change", updateProviderUI);
        updateProviderUI();

        const fetchModels = async () => {
          fetchStatus.innerHTML = '<span class="spinner"></span> Fetching models…';
          try {
            const res = await send("quickstart.providers.fetchModels", {
              provider: provEl.value,
              apiKey: keyEl.value,
              endpoint: endpointEl.value,
            });
            if (res.error) {
              fetchStatus.innerHTML = '<span style="color: var(--err)">' + escapeHtml(res.error) + '</span>';
              return;
            }
            const models = res.models || [];
            if (!models.length) {
              fetchStatus.innerHTML = '<span style="color: var(--warn)">No models found. Check your key or endpoint.</span>';
              return;
            }
            modelEl.innerHTML = "";
            for (const m of models) {
              const opt = document.createElement("option");
              opt.value = m.id;
              opt.textContent = m.label || m.id;
              if (m.contextWindow) opt.textContent += "  (" + Math.round(m.contextWindow / 1000) + "k ctx)";
              modelEl.appendChild(opt);
            }
            // Restore previously selected model if still available.
            if (state.modelChoice?.model && models.some((m) => m.id === state.modelChoice.model)) {
              modelEl.value = state.modelChoice.model;
            } else {
              modelEl.value = providerDefaultModel(provEl.value, models);
            }
            fetchStatus.innerHTML = '<span style="color: var(--ok)">' + models.length + ' model(s) loaded</span>';
          } catch (err) {
            fetchStatus.innerHTML = '<span style="color: var(--err)">' + escapeHtml(err.message || "Fetch failed") + '</span>';
          }
        };
        root.querySelector("#fetch-models").addEventListener("click", fetchModels);

        const captureAndSave = async () => {
          const chosenModel = modelEl.value || providerDefaultModel(provEl.value, []);
          const provider = provEl.value;
          state.modelChoice = {
            provider,
            apiKey: keyEl.value,
            model: chosenModel,
            endpoint: endpointEl.value,
          };
          // Schema shapes (see src/config/types.agent-defaults.ts +
          // src/config/types.models.ts):
          //   agents.defaults.model = { primary, fallbacks }
          //   models.providers[<id>] = { apiKey, baseUrl, models[] }
          const patch = {
            agents: { defaults: { model: { primary: providerScopedId(provider, chosenModel) } } },
          };
          if (keyEl.value || endpointEl.value) {
            // Schema (src/config/types.models.ts) requires:
            //   - baseUrl: string
            //   - models: ModelDefinitionConfig[] (non-empty per provider)
            //   - api: ModelApi — pi-ai's mapOptionsForApi switches on this
            //     and crashes the agent loop with "Unhandled API in
            //     mapOptionsForApi: undefined" if it's missing. We set it on
            //     both the provider and the model so any reader (the
            //     pi-embedded-runner inheritance fallback OR a direct model
            //     lookup) finds a value.
            const baseUrl = endpointEl.value || providerDefaultBaseUrl(provider);
            const api = providerDefaultApi(provider);
            const modelDef = {
              id: chosenModel,
              name: chosenModel,
              api,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            };
            const providerCfg = { baseUrl, api, models: [modelDef] };
            if (keyEl.value) providerCfg.apiKey = keyEl.value;
            patch.models = { providers: { [provider]: providerCfg } };
          }
          try {
            await send("quickstart.applyPatch", { patch });
            markSaved(["models"], "Saved ✓");
            toast("Saved");
          } catch (err) { toast(err.message || "Save failed", true); }
        };

        function providerScopedId(provider, modelId) {
          // Agent runtime expects "<provider>/<model>" id format.
          if (!modelId) return "";
          if (modelId.includes("/")) return modelId;
          return provider + "/" + modelId;
        }

        function providerDefaultBaseUrl(provider) {
          // Required by ModelProviderConfig schema. Pick the canonical public
          // endpoint per provider so a user who only supplies an API key
          // gets a working config out of the box.
          switch (provider) {
            case "anthropic":     return "https://api.anthropic.com/v1";
            case "openai":        return "https://api.openai.com/v1";
            case "openrouter":    return "https://openrouter.ai/api/v1";
            case "zai":           return "https://api.z.ai/api/paas/v4";
            case "ollama":        return "http://localhost:11434";
            case "ollama-cloud":  return "https://ollama.com/v1";
            default:              return "https://api.anthropic.com/v1";
          }
        }

        function providerDefaultApi(provider) {
          // ModelApi enum (src/config/types.models.ts):
          //   "openai-completions" | "openai-responses" | "anthropic-messages" |
          //   "google-generative-ai" | "github-copilot" | "bedrock-converse-stream"
          // Without this, the wizard wrote a provider/model with no api
          // field and pi-ai crashed the agent loop on the first turn with
          // "Unhandled API in mapOptionsForApi: undefined".
          switch (provider) {
            case "anthropic":     return "anthropic-messages";
            case "openai":        return "openai-responses";
            case "openrouter":    return "openai-completions";
            case "zai":           return "openai-completions";
            case "ollama":        return "openai-completions";
            case "ollama-cloud":  return "openai-completions";
            case "google":        return "google-generative-ai";
            default:              return "openai-completions";
          }
        }
        const navEl = nav(null, "gateway");
        navEl.querySelector("#next").addEventListener("click", captureAndSave);
        root.appendChild(navEl);
      }

      function providerDefaultModel(p, models) {
        // Prefer something from the fetched list when available.
        if (Array.isArray(models) && models.length) {
          // Heuristic: pick the first "opus" / "gpt-4" / "glm-4.5" / "llama3" match.
          const preferences = ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-4o", "glm-4.5", "gpt-oss:120b", "kimi-k2", "gpt-oss", "qwen3-coder", "deepseek-v3", "llama3.2", "qwen2.5"];
          for (const pref of preferences) {
            const hit = models.find((m) => m.id === pref || m.id.startsWith(pref));
            if (hit) return hit.id;
          }
          return models[0].id;
        }
        const entry = provEntry(p);
        if (entry && entry.defaultModel) return entry.defaultModel;
        return "";
      }

      function renderGateway(root) {
        root.innerHTML =
          '<h1 class="h1">Gateway</h1>' +
          '<p class="lead">The gateway exposes the InfiniBot RPC. Choose where it listens.</p>' +
          '<div class="card">' +
            '<label>Bind</label>' +
            '<select id="bind">' +
              '<option value="loopback">Localhost only (recommended)</option>' +
              '<option value="lan">LAN (other devices on your network can connect)</option>' +
              '<option value="tailnet">Tailscale (private mesh)</option>' +
              '<option value="auto">Auto</option>' +
            '</select>' +
            '<div style="height:12px"></div>' +
            '<label>Port</label>' +
            '<input id="port" type="text" placeholder="18789" />' +
            '<div style="height:12px"></div>' +
            '<label>Auth mode</label>' +
            '<select id="authmode">' +
              '<option value="token">Token (default)</option>' +
              '<option value="password">Password</option>' +
              '<option value="open">Open (loopback only)</option>' +
            '</select>' +
            '<div id="password-row" style="display:none; margin-top:12px">' +
              '<label>Gateway password</label>' +
              '<div style="display:flex; gap:8px; align-items:center">' +
                '<input id="password" type="password" autocomplete="new-password" placeholder="Pick or paste a strong password" style="flex:1" />' +
                '<button class="ghost" type="button" id="show-pw">Show</button>' +
                '<button class="ghost" type="button" id="gen-pw">Generate</button>' +
              '</div>' +
              '<p class="hint" id="pw-hint" style="margin-top:6px">' +
                'Stored in <code>gateway.auth.password</code>. Required to connect when auth mode is Password. ' +
                'Set it in the env (<code>INFINIBOT_GATEWAY_PASSWORD</code>) instead if you would rather not commit it to the config file.' +
              '</p>' +
              '<p class="hint" id="pw-status" style="margin-top:6px"></p>' +
            '</div>' +
          '</div>';
        const b = root.querySelector("#bind");
        const p = root.querySelector("#port");
        const a = root.querySelector("#authmode");
        const pwRow = root.querySelector("#password-row");
        const pw = root.querySelector("#password");
        const pwStatus = root.querySelector("#pw-status");
        const showPwBtn = root.querySelector("#show-pw");
        const genPwBtn = root.querySelector("#gen-pw");
        b.value = state.gatewayBind; p.value = String(state.gatewayPort); a.value = state.gatewayAuthMode;
        pw.value = state.gatewayPassword || "";
        const refreshPwRow = () => {
          const showRow = a.value === "password";
          pwRow.style.display = showRow ? "" : "none";
          if (showRow) {
            // Re-hydrate so the user sees an indicator if a password is already
            // saved without the value ever being sent back from the server.
            if (!pw.value && state.snapshot && state.snapshot.gatewayHasPassword) {
              pwStatus.innerHTML = '<span style="color: var(--text-dim)">A password is already saved. Leave blank to keep it.</span>';
            } else {
              pwStatus.textContent = "";
            }
          }
        };
        a.addEventListener("change", refreshPwRow);
        refreshPwRow();
        showPwBtn.addEventListener("click", () => {
          pw.type = pw.type === "password" ? "text" : "password";
          showPwBtn.textContent = pw.type === "password" ? "Show" : "Hide";
        });
        genPwBtn.addEventListener("click", () => {
          // Generate a 24-byte URL-safe-ish password client-side. crypto is the
          // browser SubtleCrypto namespace; getRandomValues is sync and avoids
          // any network roundtrip.
          const bytes = new Uint8Array(24);
          (window.crypto || window.msCrypto).getRandomValues(bytes);
          let s = "";
          const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
          for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i] % alphabet.length];
          pw.value = s;
          pw.type = "text";
          showPwBtn.textContent = "Hide";
        });
        const navEl = nav(null, "channels");
        navEl.querySelector("#next").addEventListener("click", async () => {
          state.gatewayBind = b.value; state.gatewayPort = parseInt(p.value, 10) || 18789; state.gatewayAuthMode = a.value;
          state.gatewayPassword = pw.value;
          // Validate password mode requires a password to be set (either now or already).
          if (state.gatewayAuthMode === "password") {
            const hasNew = pw.value.trim().length > 0;
            const hasExisting = !!(state.snapshot && state.snapshot.gatewayHasPassword);
            if (!hasNew && !hasExisting) {
              pwStatus.innerHTML = '<span style="color: var(--err)">Set a password (or generate one) before continuing.</span>';
              pw.focus();
              return;
            }
          }
          // Schema (src/config/types.gateway.ts):
          //   gateway.mode, gateway.port, gateway.bind, gateway.auth.mode, gateway.auth.password
          // mode=local is required for "infinibot gateway run" to actually
          // start; without it the CLI blocks with "Gateway start blocked:
          // set gateway.mode=local". The wizard is the configurator, so we
          // hard-code local here. Users who want to point at a remote
          // gateway can flip it later via "infinibot config set".
          const gatewayPatch = {
            mode: "local",
            port: state.gatewayPort,
            bind: state.gatewayBind,
          };
          if (state.gatewayAuthMode === "token" || state.gatewayAuthMode === "password") {
            gatewayPatch.auth = { mode: state.gatewayAuthMode };
            // Only send a password when the user typed one — empty string would
            // overwrite an already-saved value. The server's deepMerge keeps
            // existing fields untouched when we omit them.
            if (state.gatewayAuthMode === "password" && pw.value.trim().length > 0) {
              gatewayPatch.auth.password = pw.value;
            }
          }
          // "open" mode in our UI === no auth.mode set; the gateway treats
          // unset as no auth (loopback only).
          try {
            await send("quickstart.applyPatch", { patch: { gateway: gatewayPatch } });
            markSaved(["gateway"], "Saved ✓");
            // Verify the live gateway picked the new auth up. If it didn't,
            // surface a one-click restart instead of asking the user to read
            // logs or kill processes.
            await verifyGatewayAuthAndPrompt(root, {
              expectedMode: state.gatewayAuthMode,
              expectedHasPassword:
                state.gatewayAuthMode === "password" &&
                (pw.value.trim().length > 0 ||
                  !!(state.snapshot && state.snapshot.gateway && state.snapshot.gateway.hasPassword)),
            });
            // Refresh snapshot so other steps see the saved values.
            try { await loadStatus(); } catch (e) { /* non-fatal */ }
          } catch (err) { toast(err.message || "Save failed", true); }
        });
        root.appendChild(navEl);
      }

      // ─────── Gateway auth post-save verification ───────
      // Asks the gateway "did you actually pick up what we just wrote?" and
      // shows a clear status card instead of leaving the user guessing.
      // Three outcomes:
      //   - Active: live resolver matches the patch we just sent → green check.
      //   - Saved-but-stale: write succeeded but the running gateway is on
      //     older code OR has the value cached → restart button.
      //   - Save-but-invalid-config: write succeeded but the on-disk config
      //     fails strict validation → show the failing field so the user can
      //     fix it instead of being told "something is broken".
      async function verifyGatewayAuthAndPrompt(root, opts) {
        let card = root.querySelector("#gw-verify-card");
        if (!card) {
          card = document.createElement("div");
          card.id = "gw-verify-card";
          card.className = "card";
          card.style.marginTop = "12px";
          root.appendChild(card);
        }
        // Standalone mode: same reasoning as verifyNotionAndPrompt — there's
        // no live gateway to compare on-disk config against, so the "old
        // gateway, restart" branch can't do anything useful. Surface a
        // saved-to-disk acknowledgement and let the wizard advance.
        if (IS_STANDALONE) {
          card.innerHTML =
            '<div style="border-left: 3px solid var(--ok); padding: 8px 12px">' +
              '<strong style="color: var(--ok)">✓ Saved to disk.</strong>' +
              '<p class="hint" style="margin: 6px 0 0">' +
                'Gateway settings are written to your config. They take effect the next time InfiniBot starts.' +
              '</p>' +
            '</div>';
          return;
        }
        card.innerHTML = '<div><span class="spinner"></span> Verifying gateway picked up your changes…</div>';
        let res;
        try {
          res = await send("quickstart.verify", {});
        } catch (err) {
          // Old gateway has no quickstart.verify handler. Treat as stale-needs-restart.
          renderRestartCard(card, {
            heading: "Your gateway is on an older version.",
            body: "Your settings are saved, but this version of InfiniBot needs to be restarted before they take effect.",
          });
          return;
        }
        if (!res || !res.liveAuthSupported) {
          renderRestartCard(card, {
            heading: "Your gateway is on an older version.",
            body: "Your settings are saved, but this version of InfiniBot needs to be restarted before they take effect.",
          });
          return;
        }
        if (!res.validationOk && Array.isArray(res.validationIssues) && res.validationIssues.length > 0) {
          card.innerHTML =
            '<div style="border-left: 3px solid var(--err); padding: 8px 12px">' +
              '<strong>Saved, but your config has an issue InfiniBot can\'t fully understand:</strong>' +
              '<ul style="margin: 6px 0 0; padding-left: 22px">' +
                res.validationIssues.slice(0, 4).map((iss) =>
                  '<li><code>' + escapeHtml(iss.path || "<root>") + '</code>: ' + escapeHtml(iss.message) + '</li>'
                ).join("") +
              '</ul>' +
              '<p class="hint" style="margin-top: 8px">Your changes still apply (InfiniBot now keeps your data instead of dropping it), but please fix the field above when you have a moment.</p>' +
            '</div>';
          return;
        }
        const liveMode = res.gateway && res.gateway.authMode;
        const livePw = !!(res.gateway && res.gateway.hasPassword);
        const matches =
          (opts.expectedMode === "open" && !liveMode) ||
          (liveMode === opts.expectedMode &&
            (opts.expectedMode !== "password" || livePw === opts.expectedHasPassword));
        if (matches) {
          card.innerHTML =
            '<div style="border-left: 3px solid var(--ok); padding: 8px 12px">' +
              '<strong style="color: var(--ok)">✓ Gateway is live with your new settings.</strong>' +
              '<p class="hint" style="margin: 6px 0 0">' +
                (opts.expectedMode === "password"
                  ? 'Anyone connecting to your gateway from now on will need this password.'
                  : opts.expectedMode === "token"
                    ? 'New connections will use the gateway token from your config.'
                    : 'Open auth — connections from this machine only.') +
              '</p>' +
            '</div>';
          return;
        }
        renderRestartCard(card, {
          heading: "Your settings are saved, but the gateway is still using the old ones.",
          body: "Restart InfiniBot to make your new gateway settings active. This dashboard will reconnect on its own.",
        });
      }

      // Notion post-finalize verification — same shape as the gateway one.
      // Confirms quickstart.verify reports notion.configured + the user's
      // chosen syncMode. Returns true when verified so the caller can advance.
      async function verifyNotionAndPrompt(actionsEl, expectedSyncMode) {
        let card = actionsEl.querySelector("#notion-verify-card");
        if (!card) {
          card = document.createElement("div");
          card.id = "notion-verify-card";
          card.style.marginTop = "12px";
          actionsEl.appendChild(card);
        }
        // Standalone setup-ui has no running gateway. quickstart.verify can
        // only report what's on disk, and the restart card has nothing to
        // act on — pretending to "restart" loops the user back to the token
        // step. notion.wizard.finalize already wrote the config, so trust
        // that and tell the user the settings will apply when InfiniBot starts.
        if (IS_STANDALONE) {
          card.innerHTML =
            '<div style="border-left: 3px solid var(--ok); padding: 8px 12px">' +
              '<strong style="color: var(--ok)">✓ Saved to disk.</strong>' +
              '<p class="hint" style="margin: 6px 0 0">' +
                'Your Notion settings are written to your config. They take effect the next time InfiniBot starts.' +
              '</p>' +
            '</div>';
          return true;
        }
        card.innerHTML = '<div class="hint"><span class="spinner"></span> Confirming InfiniBot can see your Notion setup…</div>';
        let res;
        try {
          res = await send("quickstart.verify", {});
        } catch (err) {
          renderRestartCard(card, {
            heading: "Your gateway is on an older version.",
            body: "Your Notion setup is saved, but this version of InfiniBot needs to be restarted before it can read your Notion config without losing it.",
          });
          return false;
        }
        if (!res || !res.liveAuthSupported) {
          renderRestartCard(card, {
            heading: "Your gateway is on an older version.",
            body: "Your Notion setup is saved, but this version of InfiniBot needs to be restarted before it can read your Notion config without losing it.",
          });
          return false;
        }
        const liveConfigured = !!(res.notion && res.notion.configured);
        const liveSyncMode = res.notion && res.notion.syncMode;
        // Tolerate the case where the user picked "off" intentionally — that
        // also means "not configured" for the kanban sync but the row data is
        // still saved. Treat off-mode as a verified outcome.
        if (expectedSyncMode === "off" || (liveConfigured && liveSyncMode === expectedSyncMode)) {
          card.innerHTML = '';
          return true;
        }
        if (!res.validationOk && Array.isArray(res.validationIssues) && res.validationIssues.length > 0) {
          card.innerHTML =
            '<div style="border-left: 3px solid var(--err); padding: 8px 12px">' +
              '<strong>Saved, but your config has an issue InfiniBot can\'t fully understand:</strong>' +
              '<ul style="margin: 6px 0 0; padding-left: 22px">' +
                res.validationIssues.slice(0, 4).map((iss) =>
                  '<li><code>' + escapeHtml(iss.path || "<root>") + '</code>: ' + escapeHtml(iss.message) + '</li>'
                ).join("") +
              '</ul>' +
              '<p class="hint" style="margin-top: 8px">Your Notion config is on disk and InfiniBot now keeps it across restarts. Fix the field above so the warning stops appearing.</p>' +
            '</div>';
          return false;
        }
        renderRestartCard(card, {
          heading: "Notion is saved, but InfiniBot can't see it yet.",
          body: "Restart InfiniBot to pick up your Notion connection. This dashboard will reconnect on its own.",
        });
        return false;
      }

      // Renders a "needs restart" card with a single big button. Clicking it
      // triggers the gateway to exit; the daemon watchdog (when running)
      // brings it back up automatically and the wizard's auto-reconnect
      // re-attaches without the user having to do anything else.
      function renderRestartCard(card, info) {
        card.innerHTML =
          '<div style="border-left: 3px solid var(--warn); padding: 8px 12px">' +
            '<strong>' + escapeHtml(info.heading) + '</strong>' +
            '<p style="margin: 6px 0 10px">' + escapeHtml(info.body) + '</p>' +
            '<div class="actions">' +
              '<button class="primary" id="gw-restart-btn">Restart InfiniBot now</button>' +
            '</div>' +
            '<p class="hint" id="gw-restart-status" style="margin-top: 8px"></p>' +
          '</div>';
        const btn = card.querySelector("#gw-restart-btn");
        const status = card.querySelector("#gw-restart-status");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          status.textContent = "Restarting gateway…";
          // The reconnect loop already exists (see the WebSocket "close"
          // handler at the top of this file). Just trigger a graceful exit
          // and let the watchdog + auto-reconnect handle the rest.
          try { await send("quickstart.restartGateway", {}); } catch (e) { /* expected: server exits */ }
          // Race: poll quickstart.verify until it answers (gateway is back).
          // Bail after ~30s and give the user a manual-restart hint.
          const deadline = Date.now() + 30000;
          let backOnline = false;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
              const probe = await send("quickstart.verify", {});
              if (probe && probe.liveAuthSupported) { backOnline = true; break; }
            } catch (e) { /* still down, keep polling */ }
          }
          if (backOnline) {
            status.innerHTML = '<span style="color: var(--ok)">✓ Gateway is back up. Your settings are now live.</span>';
            try { await loadStatus(); renderMain(); } catch (e) { /* non-fatal */ }
          } else {
            status.innerHTML =
              '<span style="color: var(--err)">Gateway didn\'t come back automatically. Please quit and reopen InfiniBot.</span>';
          }
        });
      }

      function renderChannels(root) {
        if (inSatelliteMirrorMode()) {
          root.innerHTML = satelliteMirrorBanner("Channels");
          const entries = Object.entries(state.channels || {});
          const enabled = entries.filter(function (e) { return e[1] && e[1].enabled; });
          const summary = enabled.length
            ? '<ul style="margin:0; padding-left:18px">' +
                enabled.map(function (e) {
                  return '<li><strong>' + escapeHtml(e[0]) + '</strong>' +
                    (e[1].hasToken ? ' — token configured on master' : '') +
                  '</li>';
                }).join("") +
              '</ul>'
            : '<p class="hint" style="margin:0">No channels configured on master yet.</p>';
          satelliteMirrorAppend(root, summary);
          return;
        }
        const channels = [
          { id: "telegram", name: "Telegram", emoji: "✈️", token: "TELEGRAM_BOT_TOKEN" },
          { id: "discord", name: "Discord", emoji: "🟣", token: "DISCORD_BOT_TOKEN" },
          { id: "slack", name: "Slack", emoji: "🟦", token: "SLACK_BOT_TOKEN" },
          { id: "signal", name: "Signal", emoji: "🔵", token: null },
          { id: "imessage", name: "iMessage", emoji: "💬", token: null },
          { id: "whatsapp", name: "WhatsApp", emoji: "🟢", token: null },
          { id: "msteams", name: "MS Teams", emoji: "🟪", token: null },
          { id: "matrix", name: "Matrix", emoji: "🔶", token: null },
          { id: "voice-call", name: "Voice", emoji: "🎙️", token: null },
        ];
        root.innerHTML =
          '<h1 class="h1">Channels</h1>' +
          '<p class="lead">Pick the messaging channels you want active. You can add more later.</p>' +
          '<div class="card">' +
            '<div class="grid-2" id="channel-grid"></div>' +
          '</div>' +
          '<div id="channel-detail"></div>';
        const grid = root.querySelector("#channel-grid");
        for (const ch of channels) {
          const tile = document.createElement("div");
          tile.className = "channel-tile" + (state.channels[ch.id]?.enabled ? " selected" : "");
          tile.innerHTML = '<div class="channel-emoji">' + ch.emoji + '</div>' +
            '<div><div class="channel-name">' + ch.name + '</div>' +
            '<div class="channel-desc">' + (state.channels[ch.id]?.enabled ? "✓ enabled" : "click to configure") + '</div></div>';
          tile.addEventListener("click", () => {
            renderChannelDetail(ch);
          });
          grid.appendChild(tile);
        }
        root.appendChild(nav(null, "hooks"));
      }

      // Per-channel hint text for what to put in an allowlist. Keep these
      // short — the textarea below always says "comma or newline separated".
      const ALLOW_HINTS = {
        telegram: "Telegram numeric IDs or @usernames (e.g. 123456789, @alice).",
        discord: "Discord numeric user IDs or @usernames (e.g. 987654321, @bob).",
        slack: "Slack user IDs (U…) or @usernames.",
        signal: "E.164 phone numbers (e.g. +15551234567).",
        imessage: "Phone numbers (E.164) or Apple IDs.",
        whatsapp: "E.164 phone numbers (e.g. +15551234567).",
        msteams: "Teams user UPNs (email-shaped) or Azure object IDs.",
        matrix: "Matrix MXIDs (e.g. @alice:matrix.org).",
      };

      function parseAllowList(raw) {
        // Accept comma, newline, or whitespace separated. The runtime
        // allowlist matchers (telegram/discord) already lowercase usernames
        // during compare, so we keep the user's casing here and let the
        // matcher do the normalization. Wildcards ("*") pass through —
        // bot-access.ts treats them as "allow all".
        if (!raw) return [];
        return String(raw)
          .split(/[\s,]+/)
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length > 0; });
      }

      function renderChannelDetail(ch) {
        const detail = document.getElementById("channel-detail");
        const existing = state.channels[ch.id] || {};
        const allowHint = ALLOW_HINTS[ch.id] || "Comma or newline separated user IDs / usernames.";
        const dmPolicy = existing.dmPolicy || "open";
        const groupPolicy = existing.groupPolicy || "open";
        const allowText = (existing.allowFrom || []).join(", ");
        const groupAllowText = (existing.groupAllowFrom || []).join(", ");
        detail.innerHTML =
          '<div class="card">' +
          '<h2 class="h2">' + escapeHtml(ch.name) + '</h2>' +
          (ch.token
            ? ('<label>' + escapeHtml(ch.token) + '</label>' +
               '<input id="ch-token" type="password" placeholder="' +
               (existing.hasToken ? "saved token in use — leave blank to keep" : "paste token here") +
               '" />')
            : '<p class="hint">No token required for ' + escapeHtml(ch.name) + ' — pairing happens after the gateway starts.</p>') +
          '<div style="height:14px"></div>' +
          '<label>Direct messages</label>' +
          '<select id="ch-dm-policy">' +
            '<option value="open"' + (dmPolicy === "open" ? " selected" : "") + '>Open — anyone can DM the bot</option>' +
            '<option value="allowlist"' + (dmPolicy === "allowlist" ? " selected" : "") + '>Allowlist — only the IDs below can DM</option>' +
            '<option value="pairing"' + (dmPolicy === "pairing" ? " selected" : "") + '>Pairing — must pair via /start first</option>' +
            '<option value="disabled"' + (dmPolicy === "disabled" ? " selected" : "") + '>Disabled — bot ignores DMs</option>' +
          '</select>' +
          '<div style="height:6px"></div>' +
          '<label>Allowed DM senders (comma or newline separated)</label>' +
          '<textarea id="ch-allow" rows="3" placeholder="' + escapeHtml(allowHint) + '"></textarea>' +
          '<div class="hint">' + escapeHtml(allowHint) + ' Use <code>*</code> to allow everyone (same as Open).</div>' +
          '<div style="height:14px"></div>' +
          '<label>Group / channel messages</label>' +
          '<select id="ch-group-policy">' +
            '<option value="open"' + (groupPolicy === "open" ? " selected" : "") + '>Open — bot responds in any group it\'s added to</option>' +
            '<option value="allowlist"' + (groupPolicy === "allowlist" ? " selected" : "") + '>Allowlist — only the IDs below can talk to the bot in groups</option>' +
            '<option value="disabled"' + (groupPolicy === "disabled" ? " selected" : "") + '>Disabled — bot ignores groups</option>' +
          '</select>' +
          '<div style="height:6px"></div>' +
          '<label>Allowed group senders (comma or newline separated)</label>' +
          '<textarea id="ch-group-allow" rows="3" placeholder="' + escapeHtml(allowHint) + '"></textarea>' +
          '<div class="hint">Per-sender allowlist for messages inside groups/channels. Empty = use the policy above unrestricted.</div>' +
          '<div class="actions"><button class="ghost" id="ch-disable">Disable</button>' +
          '<button class="primary" id="ch-enable">Save & enable</button></div>' +
          '</div>';
        const tokEl = detail.querySelector("#ch-token");
        // Pre-populate textareas / dropdowns from rehydrated state so
        // revisits show what's already saved instead of an empty form.
        const allowEl = detail.querySelector("#ch-allow");
        const groupAllowEl = detail.querySelector("#ch-group-allow");
        if (allowEl) allowEl.value = allowText;
        if (groupAllowEl) groupAllowEl.value = groupAllowText;
        detail.querySelector("#ch-enable").addEventListener("click", async () => {
          const token = tokEl ? tokEl.value : "";
          const dmPolicyVal = detail.querySelector("#ch-dm-policy").value;
          const groupPolicyVal = detail.querySelector("#ch-group-policy").value;
          const allowFrom = parseAllowList(allowEl ? allowEl.value : "");
          const groupAllowFrom = parseAllowList(groupAllowEl ? groupAllowEl.value : "");
          state.channels[ch.id] = {
            enabled: true,
            hasToken: existing.hasToken || (token && token.length > 0),
            dmPolicy: dmPolicyVal,
            groupPolicy: groupPolicyVal,
            allowFrom,
            groupAllowFrom,
          };
          try {
            // Per-channel schemas in src/config/types.<channel>.ts use
            // different token field names. Map to the right one. Token is
            // omitted when blank so a saved value isn't overwritten.
            const channelPatch = {
              enabled: true,
              dmPolicy: dmPolicyVal,
              groupPolicy: groupPolicyVal,
              allowFrom,
              groupAllowFrom,
            };
            if (token && token.length > 0) {
              const tokenField = ch.id === "telegram" || ch.id === "slack" ? "botToken" : "token";
              channelPatch[tokenField] = token;
            }
            await send("quickstart.applyPatch", { patch: { channels: { [ch.id]: channelPatch } } });
            toast(ch.name + " saved");
            renderMain();
            markSaved(["channels"], ch.name + " saved ✓");
          } catch (err) { toast(err.message || "Save failed", true); }
        });
        detail.querySelector("#ch-disable").addEventListener("click", async () => {
          state.channels[ch.id] = { ...(state.channels[ch.id] || {}), enabled: false };
          try {
            await send("quickstart.applyPatch", { patch: { channels: { [ch.id]: { enabled: false } } } });
            toast(ch.name + " disabled");
            renderMain();
          } catch (err) { toast(err.message || "Save failed", true); }
        });
      }

      function renderHooks(root) {
        if (inSatelliteMirrorMode()) {
          root.innerHTML = satelliteMirrorBanner("Hooks");
          const hookStep = (state.snapshot && Array.isArray(state.snapshot.steps))
            ? state.snapshot.steps.find(function (s) { return s.id === "hooks"; })
            : null;
          const summary = hookStep && hookStep.summary
            ? '<p style="margin:0"><strong>' + escapeHtml(hookStep.summary) + '</strong></p>'
            : '<p class="hint" style="margin:0">No hooks configured on master yet.</p>';
          satelliteMirrorAppend(root, summary);
          return;
        }
        root.innerHTML =
          '<h1 class="h1">Hooks</h1>' +
          '<p class="lead">Hooks fire on events: messages received, agents start, sessions complete. Most users skip this for now.</p>' +
          '<div class="card">' +
            '<label>Custom hook command (optional)</label>' +
            '<input id="hook-cmd" type="text" placeholder="e.g. /usr/local/bin/notify-on-ready" />' +
            '<div class="hint">A single hook to run when InfiniBot finishes onboarding. You can edit this in settings later.</div>' +
          '</div>';
        const navEl = nav(null, "federation");
        navEl.querySelector("#next").addEventListener("click", async () => {
          const cmd = root.querySelector("#hook-cmd").value;
          if (cmd) {
            try {
              // Schema (src/config/types.hooks.ts): internal.entries is a
              // Record<eventName, HookConfig>, NOT an array. HookConfig is
              // open-shaped so we can carry the command under our own key.
              await send("quickstart.applyPatch", {
                patch: {
                  hooks: {
                    internal: {
                      enabled: true,
                      entries: {
                        "onboard.complete": { enabled: true, command: cmd },
                      },
                    },
                  },
                },
              });
              toast("Hook saved");
            } catch (err) { toast(err.message || "Save failed", true); }
          }
          markSaved(["hooks"], "Saved ✓");
        });
        root.appendChild(navEl);
      }

      function renderFederation(root) {
        root.innerHTML =
          '<h1 class="h1">Federation</h1>' +
          '<p class="lead">Run InfiniBot as a single node, or join a federation of nodes that share state.</p>' +
          '<div class="card">' +
            '<label>Mode</label>' +
            '<select id="fed-mode">' +
              '<option value="standalone">Standalone (default)</option>' +
              '<option value="satellite">Satellite (joins a master)</option>' +
            '</select>' +
            '<div id="fed-master" style="display:none">' +
              '<div style="height:12px"></div>' +
              '<label>Master URL</label>' +
              '<input id="fed-url" type="text" placeholder="https://master.example.com" />' +
              '<div style="display:flex;align-items:center;gap:10px;margin:12px 0;">' +
                '<div style="flex:1;height:1px;background:rgba(255,255,255,0.12)"></div>' +
                '<span style="font-size:11px;letter-spacing:0.12em;color:#888;text-transform:uppercase">or paste invite token</span>' +
                '<div style="flex:1;height:1px;background:rgba(255,255,255,0.12)"></div>' +
              '</div>' +
              '<textarea id="fed-invite" placeholder="Paste the invite from the master device" ' +
                'style="width:100%;min-height:72px;font-family:monospace;font-size:11px;box-sizing:border-box;resize:vertical"></textarea>' +
              '<div id="fed-invite-preview" style="margin-top:8px;font-size:12px"></div>' +
              '<div class="hint" style="margin-top:6px;font-size:11px;color:#888">' +
                'On the master, click <strong>Generate Invite</strong> in Federation settings and copy the token here. ' +
                'Pasting an invite takes priority over the Master URL above.' +
              '</div>' +
            '</div>' +
          '</div>';
        const mEl = root.querySelector("#fed-mode");
        const mWrap = root.querySelector("#fed-master");
        const uEl = root.querySelector("#fed-url");
        const iEl = root.querySelector("#fed-invite");
        const ipEl = root.querySelector("#fed-invite-preview");
        mEl.value = state.federation.mode;
        uEl.value = state.federation.masterUrl;
        const sync = () => { mWrap.style.display = mEl.value === "satellite" ? "block" : "none"; };
        sync();
        mEl.addEventListener("change", sync);

        function decodeInviteToken(raw) {
          const txt = (raw || "").trim();
          if (!txt) return null;
          try {
            const json = atob(txt);
            const b = JSON.parse(json);
            if (b && b.v === 1 && b.hubUrl) {
              const minsLeft = b.expiresAt ? Math.max(0, Math.round((b.expiresAt - Date.now()) / 60000)) : null;
              return { hubUrl: String(b.hubUrl), hubName: String(b.hubName || "Hub"), minsLeft: minsLeft };
            }
          } catch (e) { /* fall through */ }
          return null;
        }

        function renderInvitePreview() {
          const raw = iEl.value;
          if (!raw || !raw.trim()) { ipEl.innerHTML = ""; return; }
          const dec = decodeInviteToken(raw);
          if (dec) {
            const expires = dec.minsLeft === null
              ? ""
              : '<div style="margin-top:4px;font-family:monospace;font-size:11px;color:' + (dec.minsLeft <= 1 ? "#f87171" : "#888") + '">' +
                  (dec.minsLeft === 0 ? "Expired" : "Expires in " + dec.minsLeft + " min") + '</div>';
            ipEl.innerHTML =
              '<div style="padding:10px 12px;background:rgba(0,255,0,0.05);border:1px solid rgba(0,255,0,0.25);border-radius:8px;color:#a3e635">' +
                '<div style="font-weight:600;margin-bottom:4px">' + dec.hubName + '</div>' +
                '<div style="font-family:monospace;color:#888;word-break:break-all">' + dec.hubUrl + '</div>' +
                expires +
              '</div>';
          } else {
            ipEl.innerHTML =
              '<div style="padding:10px 12px;background:rgba(255,50,50,0.08);border:1px solid rgba(255,50,50,0.25);border-radius:8px;color:#ff6b6b">' +
                "Couldn't decode this token. Make sure you copied the whole invite string from the master." +
              '</div>';
          }
        }
        iEl.addEventListener("input", renderInvitePreview);

        const navEl = nav(null, "notion");
        navEl.querySelector("#next").addEventListener("click", async () => {
          state.federation.mode = mEl.value; state.federation.masterUrl = uEl.value;
          const invite = (iEl.value || "").trim();
          const decoded = invite ? decodeInviteToken(invite) : null;
          const nextBtn = navEl.querySelector("#next");
          try {
            let connectedUrl = null;
            if (mEl.value === "satellite" && decoded) {
              // Invite path: gateway decodes + connects + persists config itself.
              const res = await send("federation.connect", { invite: invite });
              if (res && res.success === false) {
                throw new Error(res.error || "Invite connect failed");
              }
              await send("quickstart.applyPatch", { patch: { federation: { mode: "satellite" } } });
              state.completedSteps.add("federation");
              state.federation.mode = "satellite";
              state.federation.masterUrl = decoded.hubUrl;
              connectedUrl = decoded.hubUrl;
              toast("Connected via invite");
            } else {
              await send("quickstart.applyPatch", {
                patch: { federation: { mode: mEl.value, masterUrl: state.federation.masterUrl || undefined } },
              });
              state.completedSteps.add("federation");
              if (mEl.value === "satellite" && state.federation.masterUrl) {
                connectedUrl = state.federation.masterUrl;
              }
              toast("Saved");
            }
            // Mirror master's sharedConfig so the downstream steps (Models,
            // Notion, Channels, Hooks, Kanban) render with real values. The
            // identity-sync round-trip happens server-side via the transient
            // FederationSatellite spun up by fetchMasterConfig. Without this,
            // the downstream mirror panels would render empty placeholders
            // until the gateway restarts into satellite mode.
            if (connectedUrl) {
              const prev = nextBtn.textContent;
              nextBtn.disabled = true;
              nextBtn.textContent = "Mirroring config from master…";
              try {
                const fetchRes = await send("quickstart.federation.fetchMasterConfig", {
                  masterUrl: connectedUrl,
                });
                state.federation.paired = true;
                state.federation.mirroredBlocks = (fetchRes && Array.isArray(fetchRes.applied)) ? fetchRes.applied : [];
                await loadStatus();
                toast("Mirrored from master: " + (state.federation.mirroredBlocks.join(", ") || "(no shared blocks)"));
                // Satellite autoskip: every downstream step is mirrored
                // from master, and the operator has nothing meaningful to
                // configure locally. Mark the downstream steps complete
                // and jump straight to Review so finishing the wizard is
                // one click. (User can still click back into any step
                // via the sidebar to see the mirror panels.)
                ["welcome", "models", "gateway", "channels", "hooks", "notion", "kanban"].forEach(function (id) {
                  state.completedSteps.add(id);
                });
                const reviewIdx = STEPS.findIndex(function (s) { return s.id === "review"; });
                if (reviewIdx >= 0) {
                  state.currentStep = reviewIdx;
                  renderSidebar();
                  renderMain();
                  return; // Skip the default "advance one step" behaviour.
                }
              } catch (err) {
                nextBtn.disabled = false;
                nextBtn.textContent = prev;
                toast((err && err.message) ? err.message : "Master unreachable — retry", true);
                return; // Block advance until pairing succeeds.
              }
            }
          } catch (err) { toast(err.message || "Save failed", true); }
        });
        root.appendChild(navEl);
      }

      // ─────── Notion wizard ───────
      function renderNotion(root) {
        if (inSatelliteMirrorMode()) {
          root.innerHTML = satelliteMirrorBanner("Notion");
          const ni = state.notionInput || {};
          const n = state.notion || {};
          const rows = [];
          if (n.configured) rows.push('<dt>Status</dt><dd>✓ configured on master (' + escapeHtml(ni.syncMode || n.syncMode || "mirror") + ' mode)</dd>');
          if (ni.projectsDbId) rows.push('<dt>Projects DB</dt><dd><code>' + escapeHtml(ni.projectsDbId) + '</code></dd>');
          if (ni.tasksDbId) rows.push('<dt>Tasks DB</dt><dd><code>' + escapeHtml(ni.tasksDbId) + '</code></dd>');
          if (ni.clientsDbId) rows.push('<dt>Clients DB</dt><dd><code>' + escapeHtml(ni.clientsDbId) + '</code></dd>');
          const summary = rows.length
            ? '<dl style="margin:0; display:grid; grid-template-columns: max-content 1fr; gap:6px 12px">' + rows.join("") + '</dl>'
            : '<p class="hint" style="margin:0">Notion not configured on master.</p>';
          satelliteMirrorAppend(root, summary);
          return;
        }
        root.innerHTML =
          '<h1 class="h1">Notion (optional)</h1>' +
          '<p class="lead">Connect Notion to mirror your kanban data. Skip this entirely if you don\'t use Notion — kanban works locally either way.</p>' +
          '<div id="notion-stage"></div>';
        // If the user already finished the Notion step on a previous run
        // (status hydrate gave us projects+tasks+CRM ids) jump straight to
        // verify. Walking back through token/page/create would re-prompt
        // for the API key (which we never store back) and, before
        // createSystemDatabases became idempotent, would have spawned a
        // fresh set of Notion dbs every time. Verify is read-only and
        // shows the user's saved sync mode for an easy confirm.
        const hydrated =
          !!(state.notionInput.projectsDbId && state.notionInput.tasksDbId) &&
          !!(state.notion && state.notion.configured);
        renderNotionStage(hydrated ? "verify" : "token");
      }

      function renderNotionStage(stage) {
        const stage_el = document.getElementById("notion-stage");
        if (!stage_el) return;
        if (stage === "token") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Step 1 of 4 — Paste your Notion integration token</h2>' +
              '<p class="hint">Open Notion → <a href="https://www.notion.so/my-integrations" target="_blank">My integrations</a> → New integration → name it "InfiniBot Sync" → Show secret → copy.</p>' +
              '<div style="height:8px"></div>' +
              '<input id="n-token" type="password" placeholder="secret_..." />' +
              '<div id="n-token-err"></div>' +
              '<div class="actions split">' +
                '<button class="ghost" id="skip-notion">Skip Notion</button>' +
                '<button class="primary" id="verify">Verify token</button>' +
              '</div>' +
            '</div>';
          stage_el.querySelector("#n-token").value = state.notionInput.apiKey || "";
          stage_el.querySelector("#skip-notion").addEventListener("click", async () => {
            await send("notion.wizard.disconnect", {}).catch(() => {});
            state.notionInput.verified = false;
            state.completedSteps.delete("notion");
            state.currentStep++;
            renderSidebar(); renderMain();
          });
          stage_el.querySelector("#verify").addEventListener("click", async () => {
            const apiKey = stage_el.querySelector("#n-token").value.trim();
            const errEl = stage_el.querySelector("#n-token-err");
            errEl.innerHTML = '<div class="hint"><span class="spinner"></span> Verifying with Notion…</div>';
            try {
              const res = await send("notion.wizard.verifyToken", { apiKey });
              if (!res.ok) {
                errEl.innerHTML = '<div class="err-msg">' + escapeHtml(res.hint || res.error || "Token rejected") + '</div>';
                return;
              }
              state.notionInput.apiKey = apiKey;
              state.notionInput.integrationName = res.integrationName || "";
              errEl.innerHTML = '<div class="hint" style="color: var(--ok)">✓ Connected to "' + escapeHtml(res.workspace || res.integrationName || "Notion") + '"</div>';
              setTimeout(() => renderNotionStage("choose"), 600);
            } catch (err) {
              errEl.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Verify failed") + '</div>';
            }
          });
        } else if (stage === "choose") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Step 2 of 4 — Connect your databases</h2>' +
              '<p class="hint">InfiniBot needs a Projects and a Tasks database (plus optional CRM databases). Pick databases you already have in Notion, or let InfiniBot create fresh ones for you. <strong>Nothing is saved until you confirm.</strong></p>' +
              '<div style="height:8px"></div>' +
              '<div class="actions" style="flex-direction:column; align-items:stretch; gap:10px">' +
                '<button class="primary" id="choose-existing">Select my existing databases</button>' +
                '<button class="ghost" id="choose-create">Create new databases for me</button>' +
                '<button class="ghost" id="choose-skip">Skip Notion sync — use local kanban only</button>' +
              '</div>' +
            '</div>';
          stage_el.querySelector("#choose-existing").addEventListener("click", () => renderNotionStage("select"));
          stage_el.querySelector("#choose-create").addEventListener("click", () => renderNotionStage("page"));
          stage_el.querySelector("#choose-skip").addEventListener("click", async () => {
            await send("notion.wizard.disconnect", {}).catch(() => {});
            state.notionInput.verified = false;
            state.completedSteps.delete("notion");
            state.currentStep++;
            renderSidebar(); renderMain();
          });
        } else if (stage === "select") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Select your Notion databases</h2>' +
              '<p class="hint">Map each role to one of your existing Notion databases. <strong>Projects</strong> and <strong>Tasks</strong> are required; CRM roles are optional. We pre-select a best guess from the database name — change anything that looks wrong. Nothing is bound until you click Continue.</p>' +
              '<div style="height:8px"></div>' +
              '<div id="db-select-list"><span class="spinner"></span> Loading your databases…</div>' +
              '<div id="db-select-err"></div>' +
              '<div class="actions split">' +
                '<button class="ghost" id="back-choose">← Back</button>' +
                '<button class="primary" id="use-selected" disabled>Continue</button>' +
              '</div>' +
            '</div>';
          stage_el.querySelector("#back-choose").addEventListener("click", () => renderNotionStage("choose"));
          (async () => {
            const normId = (id) => (id || "").replace(/-/g, "").toLowerCase();
            const listEl = stage_el.querySelector("#db-select-list");
            const errEl = stage_el.querySelector("#db-select-err");
            const useBtn = stage_el.querySelector("#use-selected");
            try {
              const res = await send("notion.import.listDatabases", {});
              const dbs = (res && res.databases) || [];
              if (!dbs.length) {
                listEl.innerHTML = '<div class="hint">No databases are shared with this integration yet. In Notion, open each database → ••• menu → Connections → add "' + escapeHtml(state.notionInput.integrationName || "InfiniBot Sync") + '", then Reload — or go back and let InfiniBot create them for you.</div>' +
                  '<div class="actions"><button class="ghost" id="reload-dbs">Reload</button></div>';
                const rl = listEl.querySelector("#reload-dbs"); if (rl) rl.addEventListener("click", () => renderNotionStage("select"));
                return;
              }
              const ROLES = [
                { key: "projectsDbId", role: "projects", label: "Projects DB", required: true },
                { key: "tasksDbId", role: "tasks", label: "Tasks DB", required: true },
                { key: "clientsDbId", role: "clients", label: "Clients DB (optional)", required: false },
                { key: "leadsDbId", role: "leads", label: "Leads DB (optional)", required: false },
                { key: "companiesDbId", role: "companies", label: "Companies DB (optional)", required: false },
                { key: "dealsDbId", role: "deals", label: "Deals DB (optional)", required: false },
                { key: "contactsDbId", role: "contacts", label: "Contacts DB (optional)", required: false },
              ];
              const fmtDate = (ts) => { try { return ts ? new Date(ts).toLocaleDateString() : "—"; } catch (e) { return "—"; } };
              const optionsFor = (selectedId) => '<option value="">— none —</option>' + dbs.map((d) =>
                '<option value="' + escapeHtml(d.id) + '"' + (normId(d.id) === normId(selectedId) ? ' selected' : '') + '>' +
                  escapeHtml(d.title || "Untitled") + ' — edited ' + escapeHtml(fmtDate(d.lastEditedAt)) +
                '</option>').join("");
              // Pre-suggest: honor an existing saved binding first (revisit),
              // else the first DB whose heuristic suggestedRole matches. This
              // is a UI suggestion only — nothing is persisted until Continue.
              const suggestFor = (role, savedId) => {
                if (savedId) { const hit = dbs.find((d) => normId(d.id) === normId(savedId)); if (hit) return hit.id; }
                const s = dbs.find((d) => d.suggestedRole === role);
                return s ? s.id : "";
              };
              listEl.innerHTML = ROLES.map((r) =>
                '<div style="margin-bottom:10px">' +
                  '<label style="display:block; font-weight:500; margin-bottom:4px">' + escapeHtml(r.label) + (r.required ? ' <span style="color:var(--warn)">*</span>' : '') + '</label>' +
                  '<select data-role-key="' + r.key + '">' + optionsFor(suggestFor(r.role, state.notionInput[r.key])) + '</select>' +
                '</div>').join("");
              const pick = (k) => { const el = listEl.querySelector('select[data-role-key="' + k + '"]'); return el ? el.value : ""; };
              const recompute = () => { useBtn.disabled = !(pick("projectsDbId") && pick("tasksDbId")); };
              listEl.querySelectorAll("select[data-role-key]").forEach((el) => el.addEventListener("change", recompute));
              recompute();
              useBtn.addEventListener("click", () => {
                if (!pick("projectsDbId") || !pick("tasksDbId")) {
                  errEl.innerHTML = '<div class="err-msg">Select both a Projects and a Tasks database to continue.</div>';
                  return;
                }
                ROLES.forEach((r) => { state.notionInput[r.key] = pick(r.key) || ""; });
                renderNotionStage("verify");
              });
            } catch (err) {
              errEl.innerHTML = '<div class="err-msg">' + escapeHtml((err && err.message) || "Could not load databases") + '</div>' +
                '<div class="actions"><button class="ghost" id="retry-dbs">Retry</button></div>';
              const rb = errEl.querySelector("#retry-dbs"); if (rb) rb.addEventListener("click", () => renderNotionStage("select"));
            }
          })();
        } else if (stage === "page") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Step 2 of 4 — Pick a parent page</h2>' +
              '<p class="hint">We\'ll create your "Projects", "Tasks" and the InfiniBot CRM (Clients, Leads, Companies, Deals, Contacts) under a Notion page you choose. The page must be shared with your integration first (in Notion: page menu → Connections → InfiniBot Sync).</p>' +
              '<div style="height:8px"></div>' +
              '<div id="page-list" class="page-list"><span class="spinner"></span> Loading…</div>' +
              '<div class="actions split">' +
                '<button class="ghost" id="back-stage">← Back</button>' +
                '<button class="primary" id="reload-pages">Reload</button>' +
              '</div>' +
            '</div>';
          stage_el.querySelector("#back-stage").addEventListener("click", () => renderNotionStage("choose"));
          stage_el.querySelector("#reload-pages").addEventListener("click", () => renderNotionStage("page"));
          loadPages();
        } else if (stage === "create") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Step 3 of 4 — Creating Notion databases</h2>' +
              '<div id="create-progress">' +
                '<span class="spinner"></span> Creating Projects, Tasks, and the InfiniBot CRM (Clients, Leads, Companies, Deals, Contacts) under your page…' +
                '<div class="hint" style="margin-top: 8px">This takes ~10 seconds — Notion needs a separate API call per database, plus a second pass to wire CRM relations.</div>' +
              '</div>' +
            '</div>';
          (async () => {
            try {
              const result = await send("notion.wizard.createSystemDbs", { apiKey: state.notionInput.apiKey, parentPageId: state.notionInput.parentPageId });
              state.notionInput.projectsDbId = result.projectsDbId;
              state.notionInput.tasksDbId = result.tasksDbId;
              if (result.crm) {
                state.notionInput.clientsDbId = result.crm.clientsDbId || "";
                state.notionInput.leadsDbId = result.crm.leadsDbId || "";
                state.notionInput.companiesDbId = result.crm.companiesDbId || "";
                state.notionInput.dealsDbId = result.crm.dealsDbId || "";
                state.notionInput.contactsDbId = result.crm.contactsDbId || "";
              }
              renderNotionStage("verify");
            } catch (err) {
              const wrap = stage_el.querySelector("#create-progress");
              wrap.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Create failed") + '</div>' +
                '<div class="actions"><button class="ghost" id="back-page">← Back to pages</button></div>';
              wrap.querySelector("#back-page").addEventListener("click", () => renderNotionStage("page"));
            }
          })();
        } else if (stage === "verify") {
          stage_el.innerHTML =
            '<div class="card">' +
              '<h2 class="h2">Step 4 of 4 — Verify & connect</h2>' +
              '<div id="verify-list"></div>' +
              '<div style="height:12px"></div>' +
              '<label>Sync mode</label>' +
              '<select id="sync-mode">' +
                '<option value="mirror">Mirror — local SQLite is source of truth, changes mirror to Notion (recommended)</option>' +
                '<option value="import-once">Import once — pull existing Notion data into local SQLite, then stop syncing</option>' +
                '<option value="off">Off — save the connection but don\'t sync. You can flip this on later.</option>' +
              '</select>' +
              '<div class="hint">You can change this anytime in Settings → Notion.</div>' +
              '<div style="height:14px"></div>' +
              // Schema reconciliation panel — useful when the user has
              // imported existing Notion DBs whose property names don\'t
              // match InfiniBot\'s expected shape. The diff RPC is
              // read-only; nothing here mutates Notion until the user
              // clicks Apply / Apply renames.
              '<details id="schema-reconcile" style="border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 12px">' +
                '<summary style="cursor: pointer; font-weight: 500">Schema reconciliation (advanced)</summary>' +
                '<p class="hint" style="margin: 8px 0">Check whether your Projects + Tasks databases have every property InfiniBot writes. Add missing properties additively, or use AI to map renamed properties from an imported DB.</p>' +
                '<div class="actions"><button class="ghost" id="schema-check">Run schema check</button></div>' +
                '<div id="schema-result" style="margin-top: 10px"></div>' +
              '</details>' +
              '<div style="height:14px"></div>' +
              '<div id="verify-actions" class="actions"></div>' +
            '</div>';
          // Wire the schema-reconcile panel.
          (function setupSchemaReconcile() {
            const checkBtn = stage_el.querySelector("#schema-check");
            const resultEl = stage_el.querySelector("#schema-result");
            if (!checkBtn || !resultEl) return;
            const renderRoleDiff = function (role, dbId, diff) {
              const missing = (diff.diffs || []).filter(function (d) { return d.missing; });
              const mismatch = (diff.diffs || []).filter(function (d) { return d.typeMismatch; });
              const okCount = (diff.diffs || []).length - missing.length - mismatch.length;
              const badgeColor = missing.length === 0 && mismatch.length === 0 ? "var(--ok)" : "var(--warn)";
              let html = '<div style="border-left: 3px solid ' + badgeColor + '; padding: 6px 10px; margin-bottom: 10px">' +
                '<strong>' + escapeHtml(role) + '</strong> — ' +
                okCount + ' ok, ' +
                missing.length + ' missing, ' +
                mismatch.length + ' type mismatch';
              if (missing.length > 0) {
                html += '<div class="hint" style="margin-top: 4px">Missing: ' +
                  missing.map(function (d) { return '<code>' + escapeHtml(d.canonical) + '</code>'; }).join(", ") +
                  '</div>' +
                  '<div class="actions" style="margin-top: 6px">' +
                    '<button class="ghost" data-action="apply-patch" data-role="' + escapeHtml(role) + '" data-db="' + escapeHtml(dbId) + '">Add missing properties</button>' +
                    '<button class="ghost" data-action="ai-suggest" data-role="' + escapeHtml(role) + '" data-db="' + escapeHtml(dbId) + '">AI-suggest renames</button>' +
                  '</div>';
              }
              if (mismatch.length > 0) {
                html += '<div class="hint" style="margin-top: 4px; color: var(--warn)">Type mismatches need manual fix in Notion: ' +
                  mismatch.map(function (d) { return '<code>' + escapeHtml(d.canonical) + '</code> (got ' + escapeHtml(d.actualType || "?") + ', expected ' + escapeHtml(d.type) + ')'; }).join(", ") +
                  '</div>';
              }
              html += '</div>';
              return html;
            };
            const runCheck = async function () {
              checkBtn.disabled = true;
              resultEl.innerHTML = '<div class="hint"><span class="spinner"></span> Checking…</div>';
              try {
                const targets = [];
                if (state.notionInput.projectsDbId) targets.push({ role: "projects", dbId: state.notionInput.projectsDbId });
                if (state.notionInput.tasksDbId) targets.push({ role: "tasks", dbId: state.notionInput.tasksDbId });
                if (state.notionInput.clientsDbId) targets.push({ role: "clients", dbId: state.notionInput.clientsDbId });
                if (state.notionInput.leadsDbId) targets.push({ role: "leads", dbId: state.notionInput.leadsDbId });
                if (state.notionInput.companiesDbId) targets.push({ role: "companies", dbId: state.notionInput.companiesDbId });
                if (state.notionInput.dealsDbId) targets.push({ role: "deals", dbId: state.notionInput.dealsDbId });
                if (state.notionInput.contactsDbId) targets.push({ role: "contacts", dbId: state.notionInput.contactsDbId });
                if (targets.length === 0) {
                  resultEl.innerHTML = '<div class="hint">No database ids configured yet.</div>';
                  return;
                }
                let html = "";
                for (let i = 0; i < targets.length; i++) {
                  const t = targets[i];
                  try {
                    const diff = await send("notion.schema.diff", { dbId: t.dbId, role: t.role });
                    html += renderRoleDiff(t.role, t.dbId, diff);
                  } catch (e) {
                    html += '<div class="err-msg" style="margin-bottom: 8px">' + escapeHtml(t.role) + ': ' + escapeHtml(e.message || "diff failed") + '</div>';
                  }
                }
                resultEl.innerHTML = html;
                // Wire the per-role action buttons.
                const buttons = resultEl.querySelectorAll("button[data-action]");
                buttons.forEach(function (btn) {
                  btn.addEventListener("click", async function () {
                    const action = btn.getAttribute("data-action");
                    const role = btn.getAttribute("data-role");
                    const dbId = btn.getAttribute("data-db");
                    btn.disabled = true;
                    try {
                      if (action === "apply-patch") {
                        const out = await send("notion.schema.applyPatch", { dbId: dbId, role: role });
                        toast("Added " + (out.applied?.length || 0) + " properties to " + role);
                        runCheck();
                      } else if (action === "ai-suggest") {
                        const sugg = await send("notion.schema.aiSuggest", { dbId: dbId, role: role });
                        const entries = Object.entries(sugg.mapping || {});
                        if (entries.length === 0) {
                          toast("No renames suggested for " + role);
                          btn.disabled = false;
                          return;
                        }
                        // Show the suggestion inline with an Apply button.
                        const card = document.createElement("div");
                        card.style.cssText = "margin-top: 8px; padding: 8px; border: 1px solid var(--line-strong); border-radius: 6px";
                        card.innerHTML = '<strong>AI-suggested renames for ' + escapeHtml(role) + '</strong>' +
                          (sugg.rationale ? '<p class="hint" style="margin: 4px 0">' + escapeHtml(sugg.rationale) + '</p>' : '') +
                          '<ul style="margin: 4px 0; padding-left: 20px">' +
                            entries.map(function (e) { return '<li><code>' + escapeHtml(e[0]) + '</code> → <code>' + escapeHtml(e[1]) + '</code></li>'; }).join("") +
                          '</ul>' +
                          '<div class="actions"><button class="primary" data-confirm-rename="1">Apply renames</button><button class="ghost" data-cancel-rename="1">Cancel</button></div>';
                        btn.parentElement.parentElement.appendChild(card);
                        const confirmBtn = card.querySelector("[data-confirm-rename]");
                        const cancelBtn = card.querySelector("[data-cancel-rename]");
                        confirmBtn.addEventListener("click", async function () {
                          confirmBtn.disabled = true;
                          try {
                            const out = await send("notion.schema.applyRename", { dbId: dbId, role: role, mapping: sugg.mapping });
                            toast("Renamed " + (out.applied?.length || 0) + " properties on " + role);
                            card.remove();
                            runCheck();
                          } catch (e) {
                            toast(e.message || "Rename failed", true);
                            confirmBtn.disabled = false;
                          }
                        });
                        cancelBtn.addEventListener("click", function () { card.remove(); btn.disabled = false; });
                      }
                    } catch (e) {
                      toast(e.message || "Action failed", true);
                      btn.disabled = false;
                    }
                  });
                });
              } finally {
                checkBtn.disabled = false;
              }
            };
            checkBtn.addEventListener("click", runCheck);
          })();
          const syncEl = stage_el.querySelector("#sync-mode");
          syncEl.value = state.notionInput.syncMode || "mirror";
          syncEl.addEventListener("change", () => { state.notionInput.syncMode = syncEl.value; });
          (async () => {
            const list = stage_el.querySelector("#verify-list");
            const actions = stage_el.querySelector("#verify-actions");
            list.innerHTML = '<div class="hint"><span class="spinner"></span> Running checks…</div>';
            try {
              const res = await send("notion.wizard.verifySetup", {
                apiKey: state.notionInput.apiKey,
                projectsDbId: state.notionInput.projectsDbId,
                tasksDbId: state.notionInput.tasksDbId,
              });
              renderChecks(list, res.checks);
              if (res.ok) {
                actions.innerHTML = '<button class="primary" id="finalize">Save & connect</button>' +
                  '<button class="ghost" id="change-dbs">← Change databases</button>';
                actions.querySelector("#change-dbs").addEventListener("click", () => renderNotionStage("choose"));
                actions.querySelector("#finalize").addEventListener("click", async () => {
                  try {
                    await send("notion.wizard.finalize", {
                      apiKey: state.notionInput.apiKey,
                      syncMode: state.notionInput.syncMode,
                      projectsDbId: state.notionInput.projectsDbId,
                      tasksDbId: state.notionInput.tasksDbId,
                      parentPageId: state.notionInput.parentPageId,
                      integrationName: state.notionInput.integrationName,
                      clientsDbId: state.notionInput.clientsDbId,
                      leadsDbId: state.notionInput.leadsDbId,
                      companiesDbId: state.notionInput.companiesDbId,
                      dealsDbId: state.notionInput.dealsDbId,
                      contactsDbId: state.notionInput.contactsDbId,
                    });
                    state.notionInput.verified = true;
                    state.completedSteps.add("notion");
                    // Confirm the gateway actually sees notion as configured.
                    // If it doesn't (older gateway code, or a config issue
                    // makes the notion block invisible to readers), surface a
                    // restart card right here instead of letting the user hit
                    // a confusing "Notion: off" on the Review screen.
                    const ok = await verifyNotionAndPrompt(actions, state.notionInput.syncMode);
                    if (ok) {
                      toast("Notion connected!");
                      state.currentStep++;
                      renderSidebar(); renderMain();
                    }
                  } catch (err) { toast(err.message || "Finalize failed", true); }
                });
              } else {
                actions.innerHTML = '<button class="ghost" id="retry">Retry checks</button>' +
                  '<button class="ghost" id="back-create">← Change databases</button>';
                actions.querySelector("#retry").addEventListener("click", () => renderNotionStage("verify"));
                actions.querySelector("#back-create").addEventListener("click", () => renderNotionStage("choose"));
              }
            } catch (err) {
              list.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Verify failed") + '</div>';
            }
          })();
        }
      }

      async function loadPages() {
        const wrap = document.getElementById("page-list");
        if (!wrap) return;
        try {
          const res = await send("notion.wizard.listPages", { apiKey: state.notionInput.apiKey });
          const pages = res.pages || [];
          if (!pages.length) {
            wrap.innerHTML = '<div class="err-msg">No pages accessible. Open Notion, find the page where you want InfiniBot to create its databases, click "..." → Connections → invite "InfiniBot Sync", then click Reload.</div>';
            return;
          }
          wrap.innerHTML = "";
          for (const p of pages) {
            const item = document.createElement("div");
            item.className = "page-item" + (state.notionInput.parentPageId === p.id ? " selected" : "");
            item.innerHTML = '<div class="page-emoji">📄</div>' +
              '<div class="page-title">' + escapeHtml(p.title) + '<div class="page-meta">' + escapeHtml(p.parentTitle || "") + '</div></div>';
            item.addEventListener("click", () => {
              state.notionInput.parentPageId = p.id;
              renderNotionStage("create");
            });
            wrap.appendChild(item);
          }
        } catch (err) {
          wrap.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Could not list pages") + '</div>';
        }
      }

      function renderChecks(list, checks) {
        list.innerHTML = "";
        for (const c of checks) {
          const row = document.createElement("div");
          row.className = "check";
          row.innerHTML = '<div class="check-icon ' + (c.ok ? "ok" : "err") + '">' + (c.ok ? "✓" : "!") + '</div>' +
            '<div><div>' + escapeHtml(c.label) + '</div>' +
            (c.detail ? '<div class="hint">' + escapeHtml(c.detail) + '</div>' : '') +
            (c.hint ? '<div class="hint" style="color: var(--warn)">' + escapeHtml(c.hint) + '</div>' : '') + '</div>';
          list.appendChild(row);
        }
      }

      function renderKanban(root) {
        if (inSatelliteMirrorMode()) {
          root.innerHTML = satelliteMirrorBanner("Kanban");
          const kb = (state.snapshot && state.snapshot.kanban) || {};
          const summary =
            '<p style="margin:0 0 8px">Kanban UI on this satellite reads from the master\'s databases.</p>' +
            '<dl style="margin:0; display:grid; grid-template-columns: max-content 1fr; gap:6px 12px">' +
              '<dt>Sync mode</dt><dd>' + escapeHtml(kb.syncMode || "local") + '</dd>' +
              '<dt>Notion mirror</dt><dd>' + (kb.notionConfigured ? '✓ configured on master' : '— not configured') + '</dd>' +
            '</dl>';
          satelliteMirrorAppend(root, summary);
          return;
        }
        root.innerHTML =
          '<h1 class="h1">Kanban</h1>' +
          '<p class="lead">Your kanban is local-first — it works without Notion. If you connected Notion above, changes mirror there too.</p>' +
          '<div class="card">' +
            '<h2 class="h2">Current setup</h2>' +
            '<ul class="summary-list" id="kanban-summary"></ul>' +
            '<div class="actions">' +
              '<button class="ghost" id="migrate-legacy">Import legacy Notion kanban</button>' +
            '</div>' +
            '<div class="hint">Use this if you previously had data in the old built-in Notion DBs. Idempotent and safe to re-run.</div>' +
          '</div>' +
          '<div class="card">' +
            '<h2 class="h2">Customize statuses &amp; priorities</h2>' +
            '<p class="hint">These options apply to both the local kanban and the Notion mirror. Renaming preserves existing rows; removing an option leaves rows that referenced it with an empty value.</p>' +
            '<div id="kanban-settings"><span class="spinner"></span> Loading current settings…</div>' +
            '<div class="actions">' +
              '<button class="primary" id="save-kanban-settings">Save kanban settings</button>' +
              '<span id="save-kanban-status" class="hint"></span>' +
            '</div>' +
          '</div>' +
          '<div class="card" id="notion-import-card" style="display:none">' +
            '<h2 class="h2">Import additional Notion databases</h2>' +
            '<p class="hint">Pull existing Notion databases into the InfiniBot synced store as <code>notion-import</code> sources. The system DBs we just created (Projects, Tasks, Clients, Leads, Companies, Deals, Contacts) are excluded — pick anything else you want managed alongside them.</p>' +
            '<div id="notion-import-list"><span class="spinner"></span> Listing your Notion databases…</div>' +
            '<div class="actions">' +
              '<button class="primary" id="run-notion-import" disabled>Import selected</button>' +
              '<span id="notion-import-status" class="hint"></span>' +
            '</div>' +
          '</div>';
        const summary = root.querySelector("#kanban-summary");
        const k = state.snapshot?.kanban;
        if (k) {
          summary.innerHTML =
            '<li><span class="summary-key">Sync mode</span><span class="summary-val">' + escapeHtml(k.syncMode) + '</span></li>' +
            '<li><span class="summary-key">Notion configured</span><span class="summary-val">' + (k.notionConfigured ? "Yes" : "No") + '</span></li>' +
            '<li><span class="summary-key">Projects DB</span><span class="summary-val"><code>' + escapeHtml(k.projects?.databaseId || "—") + '</code></span></li>' +
            '<li><span class="summary-key">Tasks DB</span><span class="summary-val"><code>' + escapeHtml(k.tasks?.databaseId || "—") + '</code></span></li>';
        } else {
          summary.innerHTML = '<li><span class="summary-key">Status</span><span class="summary-val">loading…</span></li>';
        }
        root.querySelector("#migrate-legacy").addEventListener("click", async () => {
          try {
            const res = await send("quickstart.migrateLegacyNotion", {});
            if (res.skipped) toast("Migration skipped: " + res.skipped);
            else if (res.imported) toast("Imported " + res.imported.projects + " projects + " + res.imported.tasks + " tasks");
            else toast("Migration done");
            await loadStatus();
          } catch (err) { toast(err.message || "Migration failed", true); }
        });
        // Show the Notion import panel only when Notion is configured —
        // otherwise the import RPC would error and the panel would be dead UI.
        if (state.snapshot?.notion?.configured || state.notionInput.apiKey) {
          root.querySelector("#notion-import-card").style.display = "";
          loadNotionImportList(root);
        }
        root.querySelector("#run-notion-import").addEventListener("click", async () => {
          await runNotionImport(root);
        });
        loadKanbanSettings(root);
        root.querySelector("#save-kanban-settings").addEventListener("click", async () => {
          await saveKanbanSettings(root);
        });
        root.appendChild(nav(null, "review"));
      }

      // ── Kanban settings editor ─────────────────────────────────────
      const kanbanEditState = { projects: null, tasks: null };

      async function loadKanbanSettings(root) {
        const wrap = root.querySelector("#kanban-settings");
        try {
          const res = await send("quickstart.kanban.getSettings", {});
          kanbanEditState.projects = res.projects;
          kanbanEditState.tasks = res.tasks;
          wrap.innerHTML =
            '<h3 class="h3" style="margin-top: 4px">Projects</h3>' +
            '<div class="kanban-edit-grid">' +
              '<div><label>Status</label><div id="proj-status"></div></div>' +
              '<div><label>Priority</label><div id="proj-priority"></div></div>' +
            '</div>' +
            '<h3 class="h3" style="margin-top: 14px">Tasks</h3>' +
            '<div class="kanban-edit-grid">' +
              '<div><label>Status</label><div id="task-status"></div></div>' +
              '<div><label>Priority</label><div id="task-priority"></div></div>' +
            '</div>';
          renderOptionEditor(wrap.querySelector("#proj-status"), res.projects.status, "projects.status");
          renderOptionEditor(wrap.querySelector("#proj-priority"), res.projects.priority, "projects.priority");
          renderOptionEditor(wrap.querySelector("#task-status"), res.tasks.status, "tasks.status");
          renderOptionEditor(wrap.querySelector("#task-priority"), res.tasks.priority, "tasks.priority");
        } catch (err) {
          wrap.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Could not load kanban settings") + '</div>';
        }
      }

      function renderOptionEditor(host, options, path) {
        host.innerHTML = "";
        const list = document.createElement("div");
        list.className = "option-list";
        host.appendChild(list);
        const draw = () => {
          list.innerHTML = "";
          for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const row = document.createElement("div");
            row.className = "option-row";
            row.innerHTML =
              '<input type="color" value="' + (opt.color || "#94a3b8") + '" />' +
              '<input type="text" value="' + escapeHtml(opt.name) + '" placeholder="Option name" />' +
              '<button class="ghost" type="button" title="Remove">✕</button>';
            const colorEl = row.querySelector('input[type="color"]');
            const nameEl = row.querySelector('input[type="text"]');
            const delEl = row.querySelector("button");
            colorEl.addEventListener("change", () => { opt.color = colorEl.value; });
            nameEl.addEventListener("input", () => { opt.name = nameEl.value; });
            delEl.addEventListener("click", () => { options.splice(i, 1); draw(); });
            list.appendChild(row);
          }
          const addBtn = document.createElement("button");
          addBtn.className = "ghost";
          addBtn.type = "button";
          addBtn.textContent = "+ Add option";
          addBtn.addEventListener("click", () => {
            options.push({ name: "New option", color: "#94a3b8" });
            draw();
          });
          list.appendChild(addBtn);
        };
        draw();
      }

      async function saveKanbanSettings(root) {
        const status = root.querySelector("#save-kanban-status");
        status.innerHTML = '<span class="spinner"></span> Saving…';
        try {
          await send("quickstart.kanban.saveSettings", {
            projects: {
              status: kanbanEditState.projects?.status || [],
              priority: kanbanEditState.projects?.priority || [],
            },
            tasks: {
              status: kanbanEditState.tasks?.status || [],
              priority: kanbanEditState.tasks?.priority || [],
            },
          });
          status.innerHTML = '<span style="color: var(--ok)">✓ Saved</span>';
          state.completedSteps.add("kanban");
          setTimeout(() => { status.innerHTML = ""; }, 1800);
        } catch (err) {
          status.innerHTML = '<span style="color: var(--err)">' + escapeHtml(err.message || "Save failed") + '</span>';
        }
      }

      // ── Notion database import picker ──────────────────────────────
      const notionImportState = { databases: [], selected: new Set() };

      async function loadNotionImportList(root) {
        const wrap = root.querySelector("#notion-import-list");
        try {
          const res = await send("quickstart.notion.listDatabases", {
            apiKey: state.notionInput.apiKey || undefined,
          });
          const dbs = (res.databases || []).filter((d) => !d.isSystemManaged);
          notionImportState.databases = dbs;
          notionImportState.selected = new Set();
          if (!dbs.length) {
            wrap.innerHTML = '<div class="hint">No additional Notion databases visible to your integration. Share more pages with the InfiniBot Sync integration in Notion to surface their databases here, then return and re-open this step.</div>';
            return;
          }
          wrap.innerHTML = "";
          for (const db of dbs) {
            const row = document.createElement("label");
            row.className = "import-row";
            row.innerHTML =
              '<input type="checkbox" />' +
              '<div class="import-meta">' +
                '<div class="import-title">' + escapeHtml(db.title) + '</div>' +
                '<div class="hint">' + db.propertyCount + ' columns · last edited ' + (db.lastEditedAt ? new Date(db.lastEditedAt).toLocaleDateString() : "—") + '</div>' +
              '</div>';
            const cb = row.querySelector("input");
            cb.addEventListener("change", () => {
              if (cb.checked) notionImportState.selected.add(db.id);
              else notionImportState.selected.delete(db.id);
              root.querySelector("#run-notion-import").disabled = notionImportState.selected.size === 0;
            });
            wrap.appendChild(row);
          }
        } catch (err) {
          wrap.innerHTML = '<div class="err-msg">' + escapeHtml(err.message || "Could not list Notion databases") + '</div>';
        }
      }

      async function runNotionImport(root) {
        const status = root.querySelector("#notion-import-status");
        const ids = Array.from(notionImportState.selected);
        if (!ids.length) return;
        status.innerHTML = '<span class="spinner"></span> Importing ' + ids.length + ' database(s)…';
        try {
          const res = await send("quickstart.notion.import", {
            apiKey: state.notionInput.apiKey || undefined,
            databaseIds: ids,
          });
          const totalRows = (res.imported || []).reduce((a, b) => a + (b.rowCount || 0), 0);
          status.innerHTML = '<span style="color: var(--ok)">✓ Imported ' + (res.imported?.length || 0) + ' database(s), ' + totalRows + ' row(s)</span>';
          // Reload picker so the imported DBs reflect their managed status (won't re-show as importable).
          await loadNotionImportList(root);
        } catch (err) {
          status.innerHTML = '<span style="color: var(--err)">' + escapeHtml(err.message || "Import failed") + '</span>';
        }
      }

      function renderReview(root) {
        const k = state.snapshot?.kanban || {};
        const n = state.snapshot?.notion || {};
        root.innerHTML =
          '<h1 class="h1">Review &amp; finish</h1>' +
          '<p class="lead">All set? Hit Finalize to mark setup complete and start using InfiniBot.</p>' +
          '<div class="card">' +
            '<h2 class="h2">Summary</h2>' +
            '<ul class="summary-list">' +
              '<li><span class="summary-key">Primary model</span><span class="summary-val">' + escapeHtml(state.modelChoice?.provider || "—") + '</span></li>' +
              '<li><span class="summary-key">Gateway port</span><span class="summary-val">' + state.gatewayPort + ' (' + escapeHtml(state.gatewayBind) + ')</span></li>' +
              '<li><span class="summary-key">Channels enabled</span><span class="summary-val">' + Object.keys(state.channels).filter(k => state.channels[k]?.enabled).join(", ") + '</span></li>' +
              '<li><span class="summary-key">Federation</span><span class="summary-val">' + escapeHtml(state.federation.mode) + '</span></li>' +
              '<li><span class="summary-key">Notion</span><span class="summary-val">' + (n.configured ? escapeHtml(n.syncMode) : "off") + '</span></li>' +
              '<li><span class="summary-key">Kanban</span><span class="summary-val">local-first' + (n.configured ? " + mirror" : "") + '</span></li>' +
            '</ul>' +
            '<div class="actions">' +
              '<button class="primary" id="finalize-all">✓ Finalize</button>' +
            '</div>' +
          '</div>';
        root.querySelector("#finalize-all").addEventListener("click", async () => {
          try {
            await send("quickstart.finalize", {});
            toast("Setup complete! 🎉");
            // Render done state with a build-and-open flow. The control UI
            // ships as a separate Vite bundle (pnpm ui:build → dist/control-ui),
            // which the gateway serves at /. We build it now so the link
            // actually loads something instead of a 404 on a clean checkout,
            // then auto-open it.
            // The running gateway captured its auth config (token vs password,
            // password value, bind, port) at startup. Auth changes made during
            // setup only take effect after the gateway restarts — so warn now
            // if the user just switched on password auth or rotated their pw.
            const authChanged =
              state.gatewayAuthMode === "password" &&
              (!state.snapshot ||
                !state.snapshot.gateway ||
                state.snapshot.gateway.authMode !== "password" ||
                (state.gatewayPassword && state.gatewayPassword.length > 0));
            const main = document.getElementById("main");
            main.innerHTML =
              '<h1 class="h1">All done.</h1>' +
              '<p class="lead">' +
                (IS_STANDALONE
                  ? 'Setup is finalized. Building the control UI assets so they are ready when you start InfiniBot…'
                  : 'Setup is finalized. Building the control UI so it is ready to open…') +
              '</p>' +
              (authChanged && !IS_STANDALONE
                ? '<div class="card" style="border-color: var(--warn); background: rgba(245,181,66,0.06)">' +
                    '<h2 class="h2" style="margin-top:0">Restart the gateway to apply your password</h2>' +
                    '<p style="margin: 6px 0 10px">Gateway auth is resolved at startup, so the password you just set will not be enforced until the gateway restarts.</p>' +
                    '<p class="hint" style="margin: 0">macOS app: quit + reopen InfiniBot. Server: <code>pkill -9 -f infinibot-gateway</code> then relaunch (or <code>infinibot gateway run --force</code>).</p>' +
                  '</div>'
                : '') +
              '<div class="card">' +
                '<div id="build-status"><span class="spinner"></span> Preparing the control UI… (a first build from source can take 20-60s)</div>' +
                '<div id="build-actions" class="actions" style="margin-top: 12px"></div>' +
              '</div>';
            const statusEl = document.getElementById("build-status");
            const actionsEl = document.getElementById("build-actions");
            try {
              const res = await send("quickstart.buildUi", {});
              const verb = res.alreadyBuilt ? "ready" : "built";
              if (IS_STANDALONE) {
                // Standalone mode: there is no gateway yet. The Control UI
                // lives on the gateway at gateway.port — not on this setup
                // server (port 18790). Auto-opening "/" here would just
                // open another tab pointed at the *setup* server, which
                // would render an empty wizard (no token in the new tab's
                // URL hash). Show next-step instructions instead.
                const gwPort = state.gatewayPort || 18789;
                statusEl.innerHTML =
                  '<div style="color: var(--ok)">✓ Control UI assets ' + verb + '.</div>';
                actionsEl.innerHTML =
                  '<div style="border-left: 3px solid var(--accent); padding: 8px 12px; margin-top: 4px">' +
                    '<strong>Next: start InfiniBot</strong>' +
                    '<ol style="margin: 6px 0 0; padding-left: 22px">' +
                      '<li style="margin-bottom: 4px">Close this tab.</li>' +
                      '<li style="margin-bottom: 4px">In a terminal, run <code>infinibot gateway run</code>.</li>' +
                      '<li>Then run <code>infinibot ui open</code> (or visit <code>http://localhost:' + gwPort + '/</code>) to open the Control UI.</li>' +
                    '</ol>' +
                  '</div>';
              } else {
                statusEl.innerHTML =
                  '<div style="color: var(--ok)">✓ Control UI ' + verb + '. Opening it now…</div>';
                actionsEl.innerHTML =
                  '<a class="primary" href="/" target="_blank" rel="noopener" id="open-ui-btn">Open control UI</a>' +
                  '<button class="ghost" id="rebuild-ui">Rebuild</button>';
                actionsEl.querySelector("#rebuild-ui").addEventListener("click", async () => {
                  statusEl.innerHTML = '<span class="spinner"></span> Rebuilding…';
                  try {
                    await send("quickstart.buildUi", { force: true });
                    statusEl.innerHTML = '<div style="color: var(--ok)">✓ Rebuilt.</div>';
                  } catch (e) {
                    statusEl.innerHTML = '<div class="err-msg">' + escapeHtml(e.message || "Rebuild failed") + '</div>';
                  }
                });
                // Auto-open in a new tab so the user keeps this wizard tab open
                // for reference; popup blockers usually allow same-origin window.open
                // triggered from a click handler chain like this.
                window.open("/", "_blank", "noopener");
              }
            } catch (err) {
              statusEl.innerHTML =
                '<div class="err-msg">Build failed: ' + escapeHtml(err.message || String(err)) + '</div>' +
                (IS_STANDALONE
                  ? '<div class="hint" style="margin-top: 8px">Installed from npm? Reinstall with <code>npm i -g infinibot</code>. From a source checkout, run <code>pnpm ui:build</code>. Then start the gateway with <code>infinibot gateway run</code>.</div>'
                  : '<div class="hint" style="margin-top: 8px">Installed from npm? Reinstall with <code>npm i -g infinibot</code>. From a source checkout, run <code>pnpm ui:build</code>. Then open <a href="/">the control UI</a> manually.</div>');
              actionsEl.innerHTML = '<button class="ghost" id="retry-build">Retry build</button>';
              actionsEl.querySelector("#retry-build").addEventListener("click", async () => {
                statusEl.innerHTML = '<span class="spinner"></span> Retrying…';
                try {
                  await send("quickstart.buildUi", { force: true });
                  if (IS_STANDALONE) {
                    statusEl.innerHTML = '<div style="color: var(--ok)">✓ Built. Now run <code>infinibot gateway run</code>.</div>';
                  } else {
                    statusEl.innerHTML = '<div style="color: var(--ok)">✓ Built. <a href="/" target="_blank">Open control UI</a></div>';
                    window.open("/", "_blank", "noopener");
                  }
                } catch (e) {
                  statusEl.innerHTML = '<div class="err-msg">' + escapeHtml(e.message || "Retry failed") + '</div>';
                }
              });
            }
          } catch (err) { toast(err.message || "Finalize failed", true); }
        });
      }

      // ─────── Helpers ───────
      function escapeHtml(s) {
        return String(s ?? "")
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      }
      function toast(msg, isErr) {
        const t = document.getElementById("toast");
        t.textContent = msg;
        t.classList.toggle("err", !!isErr);
        t.classList.add("visible");
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => t.classList.remove("visible"), 2500);
      }

      // ─────── Boot ───────
      connect();
    })();
  </script>
</body>
</html>`;
