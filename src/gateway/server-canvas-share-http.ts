/**
 * HTTP routes for sharing saved canvases (core canvas runtime, B34).
 *
 * Core, not part of the HoloCanvas library plugin: work-review and
 * `canvas.convert` link to /canvas/:id, so these pages must work while the
 * library plugin is off.
 *
 * GET  /api/canvas/:id          — JSON payload (no auth required)
 * GET  /api/canvas/:id/export.html — downloadable single-file HTML
 * GET  /canvas/:id              — standalone share page (no auth, gateway-served)
 *
 * Auth: GET routes are public (no token required) so share links work for
 * non-authed viewers. Pattern mirrors the loopback posture in
 * server-proactive-http.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getSavedCanvasStore } from "../canvas-host/saved-canvases.js";
import { STATE_DIR } from "../config/paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCanvasPath(pathname: string): {
  id: string | null;
  sub: string | null;
  isApi: boolean;
} {
  // /api/canvas/:id or /api/canvas/:id/export.html
  const apiMatch = /^\/api\/canvas\/([^/]+)(\/(.+))?$/.exec(pathname);
  if (apiMatch) {
    return { id: apiMatch[1], sub: apiMatch[3] ?? null, isApi: true };
  }
  // /canvas/:id (share page)
  const shareMatch = /^\/canvas\/([^/]+)$/.exec(pathname);
  if (shareMatch) {
    return { id: shareMatch[1], sub: null, isApi: false };
  }
  return { id: null, sub: null, isApi: false };
}

export async function handleCanvasShareHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  const { id, sub, isApi } = parseCanvasPath(pathname);
  if (!id) return false;

  // /canvas/:id or /api/canvas/:id — only GET
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  // Validate id looks like a UUID
  if (!UUID_RE.test(id)) return false;

  const entry = getSavedCanvasStore(STATE_DIR).get(id);

  if (!entry) {
    if (isApi) {
      sendJson(res, 404, { ok: false, error: `canvas ${id} not found` });
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!DOCTYPE html><html><body style="background:#05060b;color:#f5eacd;font-family:sans-serif;padding:2rem">
         <h1 style="color:#d4af37">Canvas not found</h1>
         <p>This canvas walkthrough link may have expired or been deleted.</p></body></html>`,
      );
    }
    return true;
  }

  if (isApi && sub === "export.html") {
    const html = buildShareHtml(entry.payload, entry.title, { inlineAudio: false });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="canvas-${id.slice(0, 8)}.html"`,
    });
    res.end(html);
    return true;
  }

  if (isApi) {
    sendJson(res, 200, {
      ok: true,
      id,
      title: entry.title,
      tags: entry.tags,
      sceneCount: entry.payload.scenes?.length ?? 0,
      nodeCount: entry.payload.nodes?.length ?? 0,
      hasBakedAudio:
        entry.bakedAudioManifest != null && Object.keys(entry.bakedAudioManifest).length > 0,
      payload: entry.payload,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
    return true;
  }

  // Share page — standalone HTML
  const html = buildShareHtml(entry.payload, entry.title, { inlineAudio: false });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(html);
  return true;
}

/** Build the standalone share page HTML.
 *
 * The renderer (`<infinite-canvas-walkthrough-overlay>`) is loaded as an ES
 * module from the gateway's own UI bundle. Since the share page is served
 * from the same origin as the InfiniBot control UI, this works for any viewer
 * who opens the link while the gateway is running.
 *
 * For offline use (export.html), the renderer JS would need to be inlined.
 * That is noted as a v1 limitation — audio and the renderer both require the
 * gateway to be running for the best experience. The payload is always inlined.
 */
function buildShareHtml(payload: object, title: string, _opts: { inlineAudio: boolean }): string {
  const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const payloadJson = JSON.stringify(payload);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} · InfiniBot Holo-Canvas</title>
  <meta name="description" content="Interactive spatial walkthrough powered by InfiniBot Holo-Canvas." />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #05060b; overflow: hidden; }
    #loading {
      position: fixed; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: #05060b; color: #f5eacd; font-family: system-ui, sans-serif; z-index: 9999;
    }
    #loading h1 { color: #d4af37; font-size: 1.2rem; font-weight: 700; margin-bottom: 0.5rem; }
    #loading p { font-size: 0.85rem; opacity: 0.6; }
    infinite-canvas-walkthrough-overlay { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="loading">
    <h1>${safeTitle}</h1>
    <p>Loading Holo-Canvas…</p>
  </div>

  <script type="module">
    // Payload is inlined at serve-time.
    const payload = ${payloadJson};

    // Try loading the renderer from the gateway's UI bundle (same origin).
    // Falls back to a minimal text-only view if the module is unavailable.
    let loaded = false;

    try {
      // The InfiniBot control UI bundles all Lit components at /assets/.
      // We import the component definition so the custom element is registered.
      // On a standalone export (opened without a live gateway), this import
      // will fail and we fall back to the text reader below.
      await import('./src/ui/components/walkthroughs/infinite-canvas-walkthrough.js')
        .catch(() => null);

      // Also try the bundled dist path used in production.
      if (!customElements.get('infinite-canvas-walkthrough-overlay')) {
        // Gateway serves the UI dist at the root; try to load via dynamic import.
        // This path depends on the vite build output having a stable chunk name.
        // If that's not available, we fall through to the fallback below.
        await import('/assets/infinite-canvas-walkthrough.js').catch(() => null);
      }

      if (customElements.get('infinite-canvas-walkthrough-overlay')) {
        loaded = true;
      }
    } catch {
      loaded = false;
    }

    const loading = document.getElementById('loading');

    if (loaded) {
      loading?.remove();
      const el = document.createElement('infinite-canvas-walkthrough-overlay');
      el.payload = payload;
      el.addEventListener('pmedia-dismiss', () => {
        // On dismiss in share mode, restart from scene 0.
        el.index = 0;
      });
      document.body.appendChild(el);
    } else {
      // Fallback: text-only scene reader.
      renderFallback(payload, loading);
    }

    function renderFallback(p, container) {
      if (!container) return;
      container.innerHTML = '';
      container.style.cssText = 'position:fixed;inset:0;background:#05060b;color:#f5eacd;font-family:system-ui,sans-serif;overflow-y:auto;padding:2rem;display:block';

      const h = document.createElement('h1');
      h.style.cssText = 'color:#d4af37;font-size:1.6rem;margin-bottom:1rem';
      h.textContent = p.title || '${safeTitle}';
      container.appendChild(h);

      const note = document.createElement('p');
      note.style.cssText = 'opacity:0.5;font-size:0.8rem;margin-bottom:2rem';
      note.textContent = 'Open this link while InfiniBot gateway is running for the full interactive experience.';
      container.appendChild(note);

      for (const scene of (p.scenes || [])) {
        const node = (p.nodes || []).find(n => n.id === scene.focusNodeId) || (p.nodes || [])[0];
        if (!node) continue;
        const card = document.createElement('div');
        card.style.cssText = 'background:rgba(212,175,55,0.06);border:1px solid rgba(212,175,55,0.25);border-radius:12px;padding:1.2rem;margin-bottom:1rem';
        const title = node.h1 || node.h2 || node.title || node.kicker || node.id;
        card.innerHTML = '<div style="color:#d4af37;font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:0.5rem">'
          + (node.kicker || 'Scene') + '</div>'
          + '<div style="font-size:1.1rem;font-weight:700;margin-bottom:0.4rem">' + (title || '') + '</div>'
          + '<div style="opacity:0.75;font-size:0.9rem;line-height:1.5">' + (node.body || node.sub || '') + '</div>';
        if (scene.narration?.captionMd) {
          const cap = document.createElement('div');
          cap.style.cssText = 'margin-top:0.6rem;font-size:0.8rem;color:#d4af37;opacity:0.8';
          cap.textContent = '▶ ' + scene.narration.captionMd;
          card.appendChild(cap);
        }
        container.appendChild(card);
      }
    }
  </script>
</body>
</html>`;
}
