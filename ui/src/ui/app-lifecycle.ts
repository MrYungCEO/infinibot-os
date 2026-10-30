import { attachDesktopDeepLinks } from "./deep-link-route.js";
import { contentTabOf, type Tab } from "./navigation";
import { connectGateway } from "./app-gateway";
import { initLightningBackground } from "./lightning-background";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling";

// ============================================================
// OAuth Callback Handler
// ============================================================

function handleOAuthCallback(): boolean {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  
  // Check if this is an OAuth callback
  if (!path.includes("/oauth/callback")) {
    return false;
  }
  
  console.log("[OAuth] Detected callback URL:", window.location.href);
  
  const code = params.get("code");
  const error = params.get("error");
  const errorDescription = params.get("error_description");
  
  if (error) {
    console.error("[OAuth] Error:", error, errorDescription);
    if (window.opener) {
      window.opener.postMessage({ type: "oauth_callback", error, errorDescription }, "*");
      setTimeout(() => window.close(), 1000);
    }
    return true;
  }
  
  if (code) {
    console.log("[OAuth] Got authorization code, sending to opener...");
    if (window.opener) {
      window.opener.postMessage({ type: "oauth_callback", code }, "*");
      console.log("[OAuth] Message sent to opener");
      
      // Show success and close
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#22c55e;font-family:system-ui;">
          <div style="text-align:center;">
            <div style="font-size:48px;margin-bottom:16px;">✓</div>
            <div style="font-size:18px;font-weight:600;">Connected!</div>
            <div style="color:#888;margin-top:8px;">You can close this window.</div>
          </div>
        </div>
      `;
      setTimeout(() => window.close(), 1500);
    } else {
      console.warn("[OAuth] No opener window found, using localStorage fallback");
      // Fallback: store in localStorage for the parent to pick up
      localStorage.setItem("infinibot-oauth-callback", JSON.stringify({ code, timestamp: Date.now() }));
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:var(--g-primary);font-family:system-ui;">
          <div style="text-align:center;">
            <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
            <div style="font-size:18px;font-weight:600;">Almost there!</div>
            <div style="color:#888;margin-top:8px;">Please close this window and return to the Schedule settings.</div>
          </div>
        </div>
      `;
    }
    return true;
  }
  
  console.warn("[OAuth] Callback without code or error");
  return true;
}

type LifecycleHost = {
  basePath: string;
  tab: Tab;
  chatHasAutoScrolled: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
};

let desktopDeepLinkOff: (() => void) | null = null;

export function handleConnected(host: LifecycleHost) {
  // Check for OAuth callback first - if this is a callback, handle it and stop
  if (handleOAuthCallback()) {
    console.log("[OAuth] Handled callback, stopping normal app initialization");
    return;
  }
  
  host.basePath = inferBasePath();
  syncTabWithLocation(
    host as unknown as Parameters<typeof syncTabWithLocation>[0],
    true,
  );
  syncThemeWithSettings(
    host as unknown as Parameters<typeof syncThemeWithSettings>[0],
  );
  attachThemeListener(
    host as unknown as Parameters<typeof attachThemeListener>[0],
  );
  window.addEventListener("popstate", host.popStateHandler);
  // Desktop shell: infinibot:// links (e.g. the marketplace's "Open in the desktop app").
  desktopDeepLinkOff?.();
  desktopDeepLinkOff = attachDesktopDeepLinks(
    () => host.basePath,
    () => (host as unknown as { requestUpdate?: () => void }).requestUpdate?.(),
  );
  applySettingsFromUrl(
    host as unknown as Parameters<typeof applySettingsFromUrl>[0],
  );
  connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (contentTabOf(host as never) === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (contentTabOf(host as never) === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  // Initialize lightning background
  try {
    const hostEl = host as unknown as HTMLElement;
    
    let shellEl: HTMLElement | null = null;
    if (hostEl.classList?.contains('shell')) {
      shellEl = hostEl;
    } else {
      shellEl = hostEl.querySelector('.shell');
    }
    
    if (shellEl instanceof HTMLElement) {
      initLightningBackground(shellEl);
    }
  } catch (e) {
    console.error('[Lifecycle] Error initializing lightning background:', e);
  }
  
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  desktopDeepLinkOff?.();
  desktopDeepLinkOff = null;
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  detachThemeListener(
    host as unknown as Parameters<typeof detachThemeListener>[0],
  );
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(
  host: LifecycleHost,
  changed: Map<PropertyKey, unknown>,
) {
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") &&
      changed.get("chatLoading") === true &&
      host.chatLoading === false;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    contentTabOf(host as never) === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab") || changed.has("hostView"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
