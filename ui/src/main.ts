import "./styles.css";
import "./styles/low-power.css";
// Set <html class="low-power"> BEFORE the heavy modules below read it, so weak
// devices (older / ~8 GB / integrated GPU) skip animated WebGL backgrounds.
import { applyLowPowerClass } from "./ui/perf";
applyLowPowerClass();
import { mountPerfOverlay } from "./ui/perf-overlay";
mountPerfOverlay(); // ?perf=1 — live FPS / frame-time / draw-call HUD (app-wide)
import "./ui/components/terminal-background"; // WebGL matrix background (gated by low-power)
// SaaS mode: block behind a Clerk sign-in before the app mounts + connects.
// No-op when SAAS_MODE is off. Unauthenticated visitors get the in-app
// branded sign-in (saas-clerk.ts), which reloads once they're signed in.
// Wrapped in an async IIFE (not top-level await) to stay within Vite's default
// build target, and app.ts is dynamically imported so it mounts only after the
// gate resolves.
//
// Hosted cloud build (VITE_INFINIBOT_CLOUD=1): the Clerk keys are baked in at
// build time and the FULL control UI (app.ts) loads, same as a local install.
// Its gateway is the member's own per-tenant gateway: fleet-connect.ts asks the
// orchestrator (/fleet/resolve) where it is, shows "waking your workspace"
// while a suspended Machine starts, then mounts <infinibot-app> on that URL.
// No gateway host is ever baked into the bundle.
import { applyCloudBootGlobals, cloudAppBase } from "./ui/cloud/cloud-env";
import { getClerkToken, isSaasMode, maybeEnforceClerkGate } from "./ui/saas-clerk";
applyCloudBootGlobals();
// Root-absolute app links ("/setup?view=…", "/chat/<id>") keep working when the
// UI is served under a base path (/app on the cloud). No-op at the root.
import { installAppBaseGuard } from "./ui/app-base";
installAppBaseGuard();
// Gateway HTTP routes require the gateway credential. Wrap fetch before any
// view loads and mint the httpOnly session cookie (img/video/EventSource) from
// whatever credential this browser already has; app-gateway.ts refreshes both
// once the WebSocket handshake settles.
import {
  ensureGatewaySession,
  installGatewayFetchAuth,
  setGatewayHttpCredentials,
} from "./ui/gateway-http-auth";
import { loadSettings } from "./ui/storage";
(() => {
  installGatewayFetchAuth();
  try {
    const settings = loadSettings();
    const w = window as unknown as { __INFINIBOT_GATEWAY_PASSWORD__?: string };
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    let electronPassword: string | null = null;
    try {
      electronPassword = sessionStorage.getItem("infinibot-electron-password");
    } catch {
      electronPassword = null;
    }
    setGatewayHttpCredentials({
      gatewayUrl: settings.gatewayUrl,
      token: params.get("token") || hash.get("token") || settings.token || undefined,
      password:
        params.get("password") ||
        hash.get("password") ||
        w.__INFINIBOT_GATEWAY_PASSWORD__ ||
        electronPassword ||
        settings.password ||
        undefined,
      getClerkToken: isSaasMode() ? getClerkToken : undefined,
    });
  } catch {
    // settings unreadable — the WS login flow will supply credentials
  }
  // Only with a credential in hand; tailscale-identity and invite flows get
  // their cookie after the WebSocket hello (app-gateway.ts).
  void ensureGatewaySession({ requireCredential: true });
})();
void (async () => {
  const appRel = window.location.pathname.slice(cloudAppBase().length) || "/";
  const adminRoute = /^\/admin(\/|$)/.test(appRel);
  // Publisher portal (/app/publisher): its own surface too, see ui/src/ui/marketplace/marketplace-boot.ts.
  const marketplaceRoute = /^\/publisher(\/|$)/.test(appRel);
  const affiliateRoute = /^\/affiliates(\/|$)/.test(appRel);
  const affiliatePreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("affiliate-preview");
  // Hosted cloud workspace: the loader names every step from here to a usable
  // app, starting with sign-in (ui/src/ui/cloud/workspace-loader.ts).
  const loader =
    import.meta.env.VITE_INFINIBOT_CLOUD === "1" && !adminRoute && !marketplaceRoute && !affiliateRoute && !/[?&]checkout=/.test(window.location.search)
      ? import("./ui/cloud/workspace-loader").catch(() => null)
      : null;
  void loader?.then((m) => m?.workspaceSignal({ type: "auth-start" }));
  // Screenshot fixtures are available only on loopback and never bypass Clerk
  // on a deployed hostname.
  if (!affiliatePreview) await maybeEnforceClerkGate();
  (await loader)?.workspaceSignal({ type: "auth-done" });
  if (import.meta.env.VITE_INFINIBOT_CLOUD === "1" && !affiliatePreview) {
    void (await import("./ui/cloud/affiliate-capture")).affiliateSyncAttribution();
  }
  // Owner admin console (/app/admin on infinibotos.com, cloud build only): its
  // own surface, never the per-tenant app. See ui/src/ui/admin/admin-boot.ts.
  if (import.meta.env.VITE_INFINIBOT_CLOUD === "1" && adminRoute) {
    (await import("./ui/admin/admin-boot")).runAdminBoot();
    return;
  }
  if (import.meta.env.VITE_INFINIBOT_CLOUD === "1" && marketplaceRoute) {
    (await import("./ui/marketplace/marketplace-boot")).runMarketplaceBoot();
    return;
  }
  if (import.meta.env.VITE_INFINIBOT_CLOUD === "1" && affiliateRoute) {
    (await import("./ui/cloud/affiliate-boot")).runAffiliateBoot();
    return;
  }
  if (import.meta.env.VITE_INFINIBOT_CLOUD === "1") {
    // Pricing "Get started" while signed out lands here as /app?checkout=<plan>.
    if (/[?&]checkout=/.test(window.location.search)) {
      if (await (await import("./ui/cloud/checkout-resume")).maybeResumeCheckout()) return;
    }
    // "Already bought it? Sign in to download" from a paid marketplace plugin page.
    if (/[?&]marketplace=/.test(window.location.search)) {
      if (await (await import("./ui/cloud/marketplace-resume")).maybeResumeMarketplace()) return;
    }
    // Setup first: a member whose plan has no private gateway is set up on the
    // serverless account surface and never reaches the fleet flow (which could
    // only answer "upgrade required"). Everyone else falls straight through.
    const setup = await import("./ui/cloud/cloud-setup").catch(() => null);
    if (setup && (await setup.runCloudSetupGate()) !== "workspace") return;
    const { runFleetBoot } = await import("./ui/cloud/fleet-connect").catch(async () => {
      await new Promise((r) => setTimeout(r, 800)); // one retry on a network blip
      return import("./ui/cloud/fleet-connect");
    });
    await runFleetBoot();
  } else {
    await import("./ui/app");
  }
})();
