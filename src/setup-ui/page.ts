/**
 * Renders the setup wizard for the standalone setup-ui HTTP server.
 *
 * We reuse the markup, CSS, and ~1500 lines of step-rendering JS from the
 * gateway-hosted version (`src/gateway/quickstart-ui.ts:QUICKSTART_HTML`)
 * verbatim — every renderModels/renderChannels/etc. function is
 * transport-agnostic and behaves identically whether `send()` rides on a
 * WebSocket or a `fetch()`. Only the bottom-left transport plumbing
 * differs, so `renderSetupPage` does the following surgical string transforms:
 *
 *   1. Replace the WebSocket `connect()` + `send()` block with a fetch-based
 *      equivalent that posts to `/api/<method>` with the launcher-minted
 *      token in an `X-Setup-Token` header.
 *   2. Replace the boot call (`connect();`) with `init();` so it lines up
 *      with the new transport.
 *   3. Flip the `IS_STANDALONE` flag from `false` to `true` so the wizard's
 *      post-finalize verify helpers know not to render "Restart InfiniBot"
 *      cards (there's no running gateway here for them to act on).
 *   4. Re-title the page and brand-sub from "Quickstart" to "Setup".
 *   5. Inject a standalone-mode banner directly after `<body>`.
 *
 * Caching: the transform is pure string work, so we do it once on module
 * import. The result is sealed with `Object.freeze` to make accidental
 * mutation loud.
 */
import { QUICKSTART_HTML } from "../gateway/quickstart-ui.js";

const WS_BLOCK_START = "      // ─────── WebSocket RPC ───────";
const WS_BLOCK_END = "      // ─────── Status & step model ───────";
const BOOT_LINE = "      connect();";

/**
 * Fetch-based transport. Provides the same `send(method, params)` Promise
 * interface the wizard already calls, plus a token bootstrap that matches
 * the WebSocket version's `readTokenFromHash`. Differences from the WS
 * version are intentional and called out inline:
 *
 *   - No reconnect loop. HTTP is request/response; if a request fails the
 *     wizard surfaces a toast like any other error and the user retries.
 *   - No `connect()` handshake. The standalone server has no auth-mode
 *     handshake; the token in `X-Setup-Token` is the entire credential.
 *   - `state.connected` is set to true once `loadStatus()` succeeds, so the
 *     existing footer still flips from "Connecting…" to "connected".
 */
const FETCH_TRANSPORT_BLOCK = `      // ─────── HTTP transport (standalone setup-ui) ───────
      // The launcher minted a one-shot token and put it in the URL hash.
      // We extract it once on load, persist it in sessionStorage so reloads
      // stay authenticated, and ship it on every /api/* request.
      function readTokenFromHash() {
        try {
          const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
          const params = new URLSearchParams(hash);
          const t = params.get("token");
          if (t) {
            sessionStorage.setItem("infinibot.setup.token", t);
            // Strip the token from the visible URL so it doesn't sit in
            // browser history.
            history.replaceState(null, "", location.pathname);
            return t;
          }
        } catch (e) { /* ignore */ }
        return sessionStorage.getItem("infinibot.setup.token") || "";
      }

      function send(method, params) {
        // Per-call timeout: the wizard's Notion / model-fetch steps can
        // be slow, but anything above 60s is almost certainly a hung
        // request the user wants to know about rather than wait on.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        return fetch("/api/" + encodeURIComponent(method) + "?token=" + encodeURIComponent(state.token), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Setup-Token": state.token,
            "Accept": "application/json",
          },
          body: JSON.stringify(params || {}),
          signal: ctrl.signal,
          credentials: "same-origin",
        }).then(async (res) => {
          clearTimeout(timer);
          let parsed = null;
          try { parsed = await res.json(); } catch (e) { /* fall through */ }
          if (!res.ok) {
            const msg = (parsed && parsed.error && parsed.error.message) ||
              ("HTTP " + res.status + " " + res.statusText);
            const code = (parsed && parsed.error && parsed.error.code) || "HTTP_" + res.status;
            throw { code, message: msg };
          }
          if (!parsed) throw { code: "BAD_RESPONSE", message: "Server returned non-JSON response" };
          if (parsed.ok === false) {
            throw parsed.error || { code: "UNKNOWN", message: "RPC failed" };
          }
          // Server answers with { ok: true, data: <handler payload> }.
          // The wizard expects the handler payload at the top level (same
          // shape as the WebSocket res.payload), so unwrap.
          return parsed.data;
        }).catch((err) => {
          clearTimeout(timer);
          // AbortController throws DOMException name="AbortError"; reshape
          // it so the wizard's existing { code, message } handlers work.
          if (err && err.name === "AbortError") {
            throw { code: "TIMEOUT", message: "Setup server did not respond in time." };
          }
          // TypeErrors from fetch (network failure, server gone) become a
          // friendly "reload page" cue.
          if (err instanceof TypeError) {
            updateFooter("disconnected — reload this page if it doesn't recover");
            throw { code: "NETWORK", message: "Lost connection to the setup server. Reload the page." };
          }
          throw err;
        });
      }

      function init() {
        state.token = readTokenFromHash();
        if (!state.token) {
          updateFooter("missing setup token — restart \\\`infinibot setup-ui\\\`");
          return;
        }
        state.connected = true;
        updateFooter("connected");
        loadStatus();
      }
`;

const STANDALONE_FLAG_SOURCE = "const IS_STANDALONE = false;";
const STANDALONE_FLAG_TARGET = "const IS_STANDALONE = true;";

const STANDALONE_BANNER = `<div style="position:relative; z-index:2; background: linear-gradient(90deg, rgba(245,181,66,0.12), rgba(139,92,246,0.08)); border-bottom: 1px solid var(--line-strong); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); padding: 9px 16px; font-size: 13px; color: var(--text-dim); text-align: center; letter-spacing: 0.01em;">✦ Standalone setup — settings are written to your config and take effect the next time InfiniBot starts.</div>`;

function applyFetchTransport(html: string): string {
  const startIdx = html.indexOf(WS_BLOCK_START);
  const endIdx = html.indexOf(WS_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // Markers moved — fail fast at module load rather than serving a broken
    // page. The build step will catch this; in dev we want a hard error.
    throw new Error(
      "setup-ui/page: could not locate WebSocket transport markers in the wizard source. " +
        "If you renamed the section banners in src/gateway/quickstart-ui.ts, " +
        "update WS_BLOCK_START / WS_BLOCK_END here too.",
    );
  }
  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx);
  let out = before + FETCH_TRANSPORT_BLOCK + after;

  // Swap the boot call. There's exactly one in the source.
  if (!out.includes(BOOT_LINE)) {
    throw new Error("setup-ui/page: boot line `connect();` not found in wizard source");
  }
  out = out.replace(BOOT_LINE, "      init();");

  // Flip the standalone flag so verifyNotionAndPrompt / verifyGatewayAuthAndPrompt
  // skip the "needs restart" branch — there's no running gateway to restart, and
  // pretending otherwise loops the user back to step 1 of the affected step.
  if (!out.includes(STANDALONE_FLAG_SOURCE)) {
    throw new Error(
      "setup-ui/page: could not find IS_STANDALONE flag in wizard source. " +
        "If you renamed it in src/gateway/quickstart-ui.ts, update STANDALONE_FLAG_SOURCE here too.",
    );
  }
  out = out.replace(STANDALONE_FLAG_SOURCE, STANDALONE_FLAG_TARGET);

  // Re-title the page so users can tell which surface they're on.
  out = out.replace("<title>InfiniBot — Quickstart</title>", "<title>InfiniBot — Setup</title>");
  out = out.replace(
    '<div class="brand-sub">Quickstart</div>',
    '<div class="brand-sub">Setup</div>',
  );

  // Inject the standalone banner immediately after <body> so it sits above
  // the wizard chrome on every step.
  if (!out.includes("<body>")) {
    throw new Error("setup-ui/page: <body> tag not found in wizard source");
  }
  out = out.replace("<body>", "<body>\n  " + STANDALONE_BANNER);

  return out;
}

const RENDERED = Object.freeze({ html: applyFetchTransport(QUICKSTART_HTML) });

export function renderSetupPage(): string {
  return RENDERED.html;
}
