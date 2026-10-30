import { handleVerificationHttpRequest } from "./verification-http.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  handleMediaFileRequest,
} from "./control-ui.js";
import { handleMobileWebHttpRequest } from "./mobile-web-static.js";
import { handleBackupHttpRequest } from "./backup-http.js";
import { handleQuickstartHttpRequest } from "./quickstart-ui.js";
import { handleVoiceConnectionRequest } from "./server-voice-connection.js";
import { handleVoiceChatRequest } from "./server-voice-chat.js";
import { handleVoiceConfigRequest } from "./server-voice-config.js";
import { handleVoiceNativeRequest } from "./server-voice-native.js";
import { handleDocsRequest } from "./server-docs.js";
import {
  documentsTicketAuthorizesRead,
  handleDocumentsHttpRequest,
} from "./server-documents-http.js";
import {
  handleVoiceChatStreamRequest,
  handleVoiceChatCancelRequest,
} from "./server-voice-stream.js";
import { handleVoiceSttRequest } from "./server-voice-stt.js";
import { handleVoiceTurnRequest } from "./server-voice-turn.js";
import { handleDesignPreviewRequest } from "./server-design-static.js";
import { handleWorkspacePreviewRequest } from "./workspace-preview-http.js";
import {
  handleWorkspaceDevProxyRequest,
  handleWorkspaceDevProxyUpgrade,
} from "../workspace/preview-proxy.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { exportAuthProfilesToEnv } from "../agents/auth-profiles/env-export.js";
import { migrateConfigKeysToAuthProfiles } from "../agents/auth-profiles/migrate-from-config.js";
import { handleVoiceTtsRequest } from "./server-voice-tts.js";
import { handleVoiceSpawnRequest, handleVoiceTasksRequest } from "./server-voice-spawn.js";
import { handlePagesPublicRequest } from "./server-pages-public.js";
import {
  extractHookToken,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { applyHookMappings } from "./hooks-mapping.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";
import { handleInstallScriptRequest } from "./install-scripts.js";
import { handleVideoSwiftHttpRequest } from "./video-swift-http.js";
import { handleCompositionAssetsUploadRequest } from "./compositions-assets-http.js";
import { handleCompositionPreviewRequest } from "./compositions-preview-http.js";
import { handleCompositionThumbnailRequest } from "./composition-thumbs-http.js";
import { handlePluginAssetRequest } from "./plugin-assets-http.js";
import { handleGlassesLiveRequest } from "./glasses-live-http.js";
import { handleLoopsWebhookRequest } from "./loops-webhook-http.js";
import { handleWhopWebhookRequest } from "./whop-webhook-http.js";
import { handleGmailOauthCallback } from "./gmail-oauth-http.js";
import { handleCanvaOauthRequest } from "./canva-oauth-http.js";
import { handleHardwareHttpRequest } from "./server-hardware-http.js";
import { handleOllamaHealthRequest } from "./ollama-health-http.js";
import { handleKokoroHealthRequest } from "./kokoro-health-http.js";
// COORDINATION: opencode-swap — coder backend selection API
import { handleCoderBackendRequest } from "./server-coder-backend.js";
import { handlePushTokensRequest } from "./server-push-tokens.js";
import { handleProactiveEmitRequest } from "./server-proactive-http.js";
import { handleProactiveAudioRequest } from "./server-proactive-audio-http.js";
import { handleMobileApkHttpRequest } from "./server-mobile-apk-http.js";
import { handleCanvasShareHttpRequest } from "./server-canvas-share-http.js";
import { handleDeepLinkOpenerRequest } from "./server-deeplink-http.js";
import { handleAgentMcpDefaultsRequest } from "./agent-mcp-defaults-http.js";
import { handleReportsHttpRequest } from "./reports-http.js";
import { handlePairingRequest } from "./server-pairing-http.js";
import { handleRunStreamRequest } from "./server-runs-http.js";
import { handleWorkflowEngineRequest } from "./server-workflow-engine-http.js";
import { handleUsersLoginRequest } from "./users-login-http.js";
import { handleAccessHttpRequest } from "./access-http.js";
import type { PluginHttpRequestHandler } from "./server/plugins-http.js";
import { startMobilePushDispatcher } from "../notifications/mobile-push.js";
import { getTunnelState } from "./server-cloudflare-tunnel.js";
import {
  authenticateHttpRequest,
  checkCsrf,
  classifyHttpRoute,
  clientKey,
  enforceNoWildcardCors,
  handleAuthSessionRequest,
  handleProtectedPreflight,
  httpAuthFailureLimiter,
  isAllowedHostHeader,
  sendHttpForbidden,
  sendHttpUnauthorized,
  sendTooManyRequests,
  type HttpAuthContext,
} from "./http-auth.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hookTokenMatches(given: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) return false;
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    const { token, fromQuery } = extractHookToken(req, url);
    if (!token || !hookTokenMatches(token, hooksConfig.token)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    if (fromQuery) {
      logHooks.warn(
        "Hook token provided via query parameter is deprecated for security reasons. " +
          "Tokens in URLs appear in logs, browser history, and referrer headers. " +
          "Use Authorization: Bearer <token> or X-InfiniBot-Token header instead.",
      );
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const runId = dispatchAgentHook(normalized.value);
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            wakeMode: mapped.action.wakeMode,
            sessionKey: mapped.action.sessionKey ?? "",
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  resolvedAuth: import("./auth.js").ResolvedGatewayAuth;
  tlsOptions?: TlsOptions;
  port?: number;
  /** Host the gateway was bound to — joins the Host-header allowlist. */
  bindHost?: string;
}): HttpServer {
  const {
    canvasHost,
    controlUiEnabled,
    controlUiBasePath,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
  } = opts;

  // Start the agent-lifecycle → mobile push dispatcher (idempotent).
  // Pass no stateDir so it falls back to the canonical STATE_DIR. The
  // previous override resolved to a bare "state" relative path, which
  // diverged from the notification history-store and pushed entries into
  // a different SQLite file from the one the mobile Alerts page reads.
  startMobilePushDispatcher();

  // One-time migration: copy legacy config-stored credentials (Notion,
  // Loops, ElevenLabs, Telegram, Brave, every models.providers.*.apiKey)
  // into the auth profile store so the /apikeys page surfaces every
  // configured key in one place. Idempotent — never overwrites a profile
  // that's already there.
  try {
    migrateConfigKeysToAuthProfiles(loadConfig());
  } catch {
    // Config may not be readable on a brand-new install; skip silently.
  }
  // Export saved profiles into process.env so spawned agent `exec`
  // calls + every consumer that reads process.env.NOTION_API_KEY /
  // OPENAI_API_KEY / etc. see them. Operator-set env always wins.
  try {
    exportAuthProfilesToEnv(ensureAuthProfileStore());
  } catch {
    // Auth store may not exist on a brand-new install; skip silently.
  }

  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") return;

    // Federation path normalization — mobile clients on the
    // feat/web-terminals-reliable-glass build use the satellite's
    // `manifest.gatewayUrl` (ws://host:port/federation) directly to
    // construct HTTP endpoints, producing URLs like
    // `/federation/api/voice/stt`. Strip the `/federation` prefix here
    // so they hit the same handlers as `/api/voice/stt`. The federation
    // WebSocket path is handled by the separate upgrade listener and is
    // unaffected.
    if (req.url && req.url.startsWith("/federation/")) {
      req.url = req.url.slice("/federation".length);
    }

    // Hosted cloud: the control UI is a static site on another origin
    // (Netlify) calling this tenant gateway's /api/* directly. Off unless
    // INFINIBOT_UI_ORIGINS is set, so local installs are unaffected.
    if (applyUiOriginCors(req, res)) return;

    try {
      // Serve install scripts first (no auth required)
      if (handleInstallScriptRequest(req, res)) return;

      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const pathname = safePathname(req.url);
      const method = (req.method ?? "GET").toUpperCase();

      // Self-authenticating inbound integrations run before the gate: hooks
      // (hook token), Slack (signing secret) and channel-plugin webhooks such
      // as /bluebubbles-webhook or /line/webhook (each verifies its own
      // signature). Manifest-declared plugin UI entry modules are public static
      // assets because dynamic import() cannot attach the gateway bearer token.
      // Routes a v2 plugin declared in contributes.selfAuthHttp (scoped-token
      // endpoints) authenticate themselves, like webhooks. Every other
      // /plugins/ and /api/ route remains protected.
      const pluginRouteIsGated =
        (pathname.startsWith("/plugins/") || pathname.startsWith("/api/")) &&
        !handlePluginRequest?.isSelfAuthRoute?.(pathname);
      const publicPluginAsset = handlePluginRequest?.isPublicAsset(pathname, method) === true;
      if (await handleHooksRequest(req, res)) return;
      if (await handleSlackHttpRequest(req, res)) return;
      if (
        handlePluginRequest &&
        (!pluginRouteIsGated || publicPluginAsset) &&
        (await handlePluginRequest(req, res))
      )
        return;

      // ── HTTP security gate ──────────────────────────────────────────────
      const routeClass = classifyHttpRoute(method, pathname);
      const authCtx: HttpAuthContext = {
        auth: resolvedAuth,
        trustedProxies,
        // Cookie names are per port; the listening socket knows it even when
        // the caller didn't pass one.
        port: opts.port ?? req.socket?.localPort,
      };
      if (routeClass !== "public") {
        const tunnelUrl = getTunnelState().url;
        const extraHosts: string[] = [];
        if (tunnelUrl) {
          try {
            extraHosts.push(new URL(tunnelUrl).hostname);
          } catch {
            // ignore malformed tunnel URL
          }
        }
        const customBindHost = (configSnapshot.gateway as { customBindHost?: string } | undefined)
          ?.customBindHost;
        if (customBindHost) extraHosts.push(customBindHost);
        if (!isAllowedHostHeader(req.headers.host, { bindHost: opts.bindHost, extraHosts })) {
          sendHttpForbidden(res, "host_not_allowed");
          return;
        }
        enforceNoWildcardCors(req, res);
      }
      const ticketRead =
        routeClass === "protected" &&
        documentsTicketAuthorizesRead(method, new URL(req.url ?? "/", "http://gateway.local"));
      if (routeClass === "protected" && !ticketRead) {
        if (method === "OPTIONS") {
          handleProtectedPreflight(req, res);
          return;
        }
        {
          const limiterKey = clientKey(req, trustedProxies);
          const retryAfter = httpAuthFailureLimiter.check(limiterKey);
          if (retryAfter > 0) {
            sendTooManyRequests(res, retryAfter);
            return;
          }
          const authResult = await authenticateHttpRequest(req, authCtx);
          if (!authResult.ok) {
            if (authResult.presentedCredential) httpAuthFailureLimiter.fail(limiterKey);
            sendHttpUnauthorized(res, authResult.reason);
            return;
          }
          const csrfError = checkCsrf(req, authResult.via);
          if (csrfError) {
            sendHttpForbidden(res, csrfError);
            return;
          }
        }
      }

      // Session bootstrap: exchange a credential for the httpOnly cookie.
      if (await handleAuthSessionRequest(req, res, authCtx)) return;

      // Everything below this line is either on the reviewed public
      // allowlist (see classifyHttpRoute) or has passed the gate above.
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          preAuthorized: routeClass === "protected",
        })
      )
        return;
      // Setup › Plugins listing images (declared files only; gated like all /api/).
      if (handlePluginAssetRequest(req, res)) return;
      if (
        handlePluginRequest &&
        pluginRouteIsGated &&
        !publicPluginAsset &&
        (await handlePluginRequest(req, res))
      )
        return;
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
          })
        )
          return;
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
          })
        )
          return;
      }
      if (await handleVerificationHttpRequest(req, res)) return;
      if (await handleVideoSwiftHttpRequest(req, res)) return;
      if (await handleCompositionAssetsUploadRequest(req, res)) return;
      if (await handleCompositionPreviewRequest(req, res)) return;
      if (await handleCompositionThumbnailRequest(req, res)) return;
      if (await handleGlassesLiveRequest(req, res)) return;
      if (await handleLoopsWebhookRequest(req, res)) return;
      if (await handleWhopWebhookRequest(req, res)) return;
      if (await handleGmailOauthCallback(req, res)) return;
      if (await handleCanvaOauthRequest(req, res)) return;
      if (await handleHardwareHttpRequest(req, res)) return;
      // Per-node Ollama availability (running + installed models) for federation.
      if (await handleOllamaHealthRequest(req, res)) return;

      // Per-node Kokoro TTS container availability (selected + reachable).
      if (await handleKokoroHealthRequest(req, res)) return;

      // Voice onboarding: catalog / status / docker-check / config / native install (SSE).
      // Install routes use the same loopback-or-bearer auth as /tools/invoke.
      if (
        await handleVoiceNativeRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          preAuthorized: routeClass === "protected",
        })
      )
        return;
      // COORDINATION: opencode-swap
      if (await handleCoderBackendRequest(req, res)) return;

      // Agent MCP defaults + workflow arc visualization endpoints.
      if (await handleAgentMcpDefaultsRequest(req, res)) return;

      // Reports PDF download / streaming endpoint.
      if (await handleReportsHttpRequest(req, res)) return;

      // User login: validate gateway password, find/create profile, set session cookie.
      if (await handleUsersLoginRequest(req, res, authCtx)) return;

      // Multi-user workspaces: workspace-user login + invite signup.
      if (await handleAccessHttpRequest(req, res, authCtx)) return;

      // Node pairing handshake endpoint.
      if (await handlePairingRequest(req, res, { port: opts.port ?? 18789 })) return;

      // Agent run output stream (SSE).
      if (await handleRunStreamRequest(req, res)) return;

      // Mobile push token registration / management
      if (await handlePushTokensRequest(req, res)) return;

      // Proactive emit HTTP shortcut (gateway-token-guarded, same shape as RPC).
      if (
        await handleProactiveEmitRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          preAuthorized: routeClass === "protected",
        })
      )
        return;

      // Baked per-scene narration audio for infinite-canvas walkthroughs
      // (content-addressed mp3s under <stateDir>/proactive-audio/).
      if (await handleProactiveAudioRequest(req, res)) return;

      // Android APK: gated manifest/download/link under /api/mobile/apk*, plus the
      // HMAC-signed public /mobile-apk/<file> link (must beat the SPA fallback).
      if (await handleMobileApkHttpRequest(req, res)) return;

      // Proactive WorkflowEngine REST API (/api/workflow-engine/*)
      if (
        await handleWorkflowEngineRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          preAuthorized: routeClass === "protected",
        })
      )
        return;

      // Saved canvases (core canvas runtime): share pages (/canvas/:id) and API (/api/canvas/:id).
      // Must run BEFORE the control-ui SPA fallback so /canvas/:id serves the
      // standalone share page rather than the SPA index.html.
      if (await handleCanvasShareHttpRequest(req, res)) return;

      // Public landing-page endpoints (analytics + form submit) — no auth, CORS-permissive on these specific paths.
      if (await handlePagesPublicRequest(req, res)) return;
      if (canvasHost) {
        if (await handleA2uiHttpRequest(req, res)) return;
        if (await canvasHost.handleHttpRequest(req, res)) return;
      }
      // Attempt to proxy voice API requests BEFORE UI handles them (to avoid SPA fallback)
      // Voice connection endpoint (standalone services)
      if (await handleVoiceConnectionRequest(req, res)) return;

      // Barge-in cancel endpoint. Must run BEFORE both the stream handler and
      // the non-streaming chat handler (which match broader `/api/voice/chat`
      // prefixes) so `/api/voice/chat/cancel` isn't swallowed.
      if (await handleVoiceChatCancelRequest(req, res)) return;

      // Voice chat streaming endpoint (SSE for faster TTS).
      // Must run BEFORE the non-streaming chat handler because that one uses
      // `startsWith("/api/voice/chat")` and would otherwise swallow /stream.
      if (await handleVoiceChatStreamRequest(req, res)) return;

      // Local voice call turns (Voice page, built-in provider): SSE reply from
      // the voice-turn seam — direct CLI routing, gateway agent, spawn updates.
      if (await handleVoiceTurnRequest(req, res)) return;

      // Kokoro TTS proxy for the browser.
      if (await handleVoiceTtsRequest(req, res)) return;

      // Speaches STT proxy for the browser (same-origin, dodges CORS).
      if (await handleVoiceSttRequest(req, res)) return;

      // Design page — static artifact serving for the iframe preview.
      if (await handleDesignPreviewRequest(req, res)) return;

      // Workspace UI — static file serving for the Preview pane iframe.
      if (await handleWorkspaceDevProxyRequest(req, res)) return;
      if (await handleWorkspacePreviewRequest(req, res)) return;

      // Documents workspace — uploads, original files, embedded assets.
      if (await handleDocumentsHttpRequest(req, res)) return;

      // In-app docs API — list tree + serve raw markdown from /docs.
      if (await handleDocsRequest(req, res)) return;

      // Voice chat endpoint (for agent LLM requests)
      if (await handleVoiceChatRequest(req, res)) return;

      // Voice task spawn endpoint (async task dispatch)
      if (await handleVoiceSpawnRequest(req, res)) return;

      // Voice active tasks endpoint (debugging)
      if (await handleVoiceTasksRequest(req, res)) return;

      // Voice configuration endpoints (settings, voices)
      if (await handleVoiceConfigRequest(req, res)) return;

      // (The old /api/settings|voices|wake|setup proxy to ROBOVOICE_URL stays gone:
      // Robovoice is reached only through the linked plugin.)

      // Serve media files (browser screenshots, etc.)
      if (handleMediaFileRequest(req, res, { basePath: controlUiBasePath })) return;

      // Quickstart onboarding UI — served before control-UI so its `/quickstart`
      // route wins even when the React control UI base path is `/`.
      if (handleQuickstartHttpRequest(req, res)) return;

      // Deep-link web opener /m/<path> (public, carries no data) — must beat the
      // control-UI SPA fallback. docs/mobile/DEEP-LINKS.md
      if (await handleDeepLinkOpenerRequest(req, res, { basePath: controlUiBasePath })) return;

      // Bundled Expo web export — `/mobile-web/*` serves the
      // production mobile UI built via `pnpm mobile:web:build`. Lives
      // ahead of control-UI so the prefix doesn't fall into its SPA
      // fallback and end up rendering the desktop UI.
      if (handleMobileWebHttpRequest(req, res)) return;

      // Backup download/restore — GET /backup/download streams a
      // zip; POST /backup/restore accepts a multipart upload and
      // rotates the existing install to .bak-<ts>.
      if (await handleBackupHttpRequest(req, res)) return;

      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        )
          return;
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
          })
        )
          return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  skipFederationPath?: boolean;
  workspaceAuth: HttpAuthContext;
}) {
  const { httpServer, wss, canvasHost, skipFederationPath, workspaceAuth } = opts;
  const gwDebug = (msg: string) => {
    if (process.env.INFINIBOT_GATEWAY_UPGRADE_DEBUG !== "1") return;
    try {
      appendFileSync("C:\\tmp\\gw-upgrade-debug.log", `${new Date().toISOString()} ${msg}\n`);
    } catch {
      // Diagnostic logging must never prevent the gateway from starting.
    }
  };

  gwDebug(`Attaching upgrade handler, skipFederationPath=${skipFederationPath}`);

  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      gwDebug(
        `Upgrade request: url=${req.url}, pathname=${url.pathname}, skipFed=${skipFederationPath}`,
      );

      if (canvasHost?.handleUpgrade(req, socket, head)) {
        gwDebug("Handled by canvasHost");
        return;
      }

      // Workspace HMR sockets are authenticated before they ever touch the
      // localhost-only project server. The preview route is deliberately not
      // handled by the generic gateway WebSocket server.
      if (await handleWorkspaceDevProxyUpgrade(req, socket, head, workspaceAuth)) return;

      // Skip /federation path if FederationHub handles it (master mode)
      if (skipFederationPath) {
        if (url.pathname === "/federation") {
          gwDebug("Skipping /federation - letting hub handle");
          // Let the FederationHub's upgrade handler handle this
          return;
        }
      }

      gwDebug("Handling with wss.handleUpgrade");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => socket.destroy());
  });
}

/**
 * CORS for the hosted control UI (INFINIBOT_UI_ORIGINS, comma-separated exact
 * origins, e.g. "https://infinibot-cloud.netlify.app"). Echoes a matching
 * Origin (never "*" for the allow-list) with Allow-Credentials. Auth is the
 * Clerk Bearer header (the SameSite=Strict session cookie never crosses
 * sites); the http-auth gate treats these origins as CORS/CSRF-allowed too. Answers the preflight itself. Returns true when the
 * request was fully handled (OPTIONS preflight).
 */
export function applyUiOriginCors(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const allowed = (env.INFINIBOT_UI_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!allowed.length || !origin || !allowed.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  // The UI's fetch-auth wrapper sends cross-origin gateway calls with
  // credentials: "include"; the browser drops the response without this.
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  if (req.method !== "OPTIONS") return false;
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    String(req.headers["access-control-request-headers"] ?? "authorization, content-type"),
  );
  res.setHeader("Access-Control-Max-Age", "600");
  res.statusCode = 204;
  res.end();
  return true;
}
