/**
 * Pure model for "Reach InfiniBot from anywhere" (Tailscale + MagicDNS) and
 * the phone install chooser. Shared by <ib-remote-access-setup>,
 * <ib-phone-app-setup>, the onboarding Phone step and Setup › Remote access.
 * Backend: network.tailscale.remote.* (src/infra/tailscale-remote.ts).
 */

export type RemoteNextStep = "install" | "start" | "login" | "approve" | "magicdns" | "https" | "create" | "ready";

export type ServeMapping = {
  hostPort: string;
  host: string;
  port: number;
  path: string;
  target: string;
  url: string;
  funnel: boolean;
};

export type RemoteStatus = {
  platform: string;
  installed: boolean;
  binary: string | null;
  running: boolean;
  backendState: string;
  loggedIn: boolean;
  authUrl: string | null;
  magicDns: boolean | null;
  httpsCerts: boolean | null;
  dnsName: string | null;
  tailnet: string | null;
  account: string | null;
  gatewayPort: number;
  mappings: ServeMapping[];
  gatewayMapping: ServeMapping | null;
  savedUrl: string | null;
  nextStep: RemoteNextStep;
  message: string;
  downloadUrl: string;
  adminDnsUrl: string;
  error?: string;
};

export type VerifyResult = {
  ok: boolean;
  url: string;
  ms: number;
  checks: Array<{ path: string; ok: boolean; status: number | null; detail: string }>;
};

export const REMOTE_LINK_EVENT = "remote-link";

/** The four checks shown as a checklist, in order. */
export type CheckRow = { id: "installed" | "signed-in" | "magicdns" | "https"; label: string; state: "ok" | "todo" | "unknown" };

export function checklist(s: RemoteStatus | null): CheckRow[] {
  const st = (v: boolean | null | undefined): CheckRow["state"] => (v === true ? "ok" : v === false ? "todo" : "unknown");
  if (!s) {
    return [
      { id: "installed", label: "Tailscale installed", state: "unknown" },
      { id: "signed-in", label: "Signed in", state: "unknown" },
      { id: "magicdns", label: "MagicDNS on", state: "unknown" },
      { id: "https", label: "HTTPS certificates on", state: "unknown" },
    ];
  }
  const signedIn = s.installed && s.running ? s.backendState === "Running" : s.installed ? null : false;
  return [
    { id: "installed", label: s.installed ? "Tailscale installed" : "Tailscale not installed", state: st(s.installed) },
    { id: "signed-in", label: s.backendState === "Running" ? `Signed in${s.account ? ` as ${s.account}` : ""}` : "Signed in", state: st(signedIn) },
    { id: "magicdns", label: "MagicDNS on", state: st(s.backendState === "Running" ? s.magicDns : null) },
    { id: "https", label: "HTTPS certificates on", state: st(s.backendState === "Running" ? s.httpsCerts : null) },
  ];
}

export function osLabel(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return "your computer";
}

/** The link the phone should use: this gateway's serve mapping, else the saved one. */
export function linkFor(s: RemoteStatus | null): string | null {
  if (!s) return null;
  if (s.gatewayMapping) return s.gatewayMapping.port === 443 ? `https://${s.gatewayMapping.host}` : `https://${s.gatewayMapping.host}:${s.gatewayMapping.port}`;
  return null;
}

/** Mappings that belong to something else on this machine (shown read-only). */
export function otherMappings(s: RemoteStatus | null): ServeMapping[] {
  if (!s) return [];
  const mine = s.gatewayMapping?.hostPort;
  return s.mappings.filter((m) => m.hostPort !== mine);
}

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/**
 * Open a link in the user's EXTERNAL browser.
 * 1. A desktop-shell bridge when present (Electron shell.openExternal).
 * 2. On this computer (loopback UI, which is how the desktop app loads it):
 *    the gateway opens it with the OS browser (network.tailscale.remote.open).
 * 3. Otherwise a new browser tab.
 */
export async function openExternal(url: string, client: Requester | null): Promise<"desktop" | "gateway" | "tab"> {
  const w = window as unknown as Record<string, { openExternal?: (u: string) => unknown } | undefined>;
  for (const key of ["infinibotDesktop", "desktopShell", "api"]) {
    const fn = w[key]?.openExternal;
    if (typeof fn === "function") {
      try {
        await fn(url);
        return "desktop";
      } catch {
        // try the next way
      }
    }
  }
  if (client && isLoopbackHost(window.location.hostname)) {
    try {
      const res = (await client.request("network.tailscale.remote.open", { url })) as { opened?: boolean } | null;
      if (res?.opened) return "gateway";
    } catch {
      // fall through to a tab
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
  return "tab";
}

// ── phone install paths (what actually exists today) ─────────────────────

export type PhoneOs = "android" | "iphone";

export type InstallPath = {
  id: string;
  title: string;
  body: string;
  status: "available" | "needs-setup" | "coming-soon";
};

export function installPaths(os: PhoneOs, apk: { available: boolean; version?: string; error?: string } | null): InstallPath[] {
  if (os === "android") {
    return [
      {
        id: "apk",
        title: "InfiniBot app for Android (APK)",
        body: apk?.available
          ? `Version ${apk.version ?? "latest"}, downloaded straight from this computer. Android will ask you to allow installs from your browser once.`
          : apk?.error
            ? `Couldn't check for the Android app (${apk.error}). Use the web app below, or see the Mobile page.`
            : "No Android app has been published on this computer yet. Use the web app below, or publish the APK from the Mobile page.",
        status: apk?.available ? "available" : "needs-setup",
      },
      {
        id: "pwa",
        title: "Web app in Chrome",
        body: "Works on any Android phone. Open the link in Chrome, then add it to your Home Screen.",
        status: "available",
      },
      { id: "play", title: "Google Play Store", body: "Coming soon.", status: "coming-soon" },
    ];
  }
  return [
    {
      id: "pwa",
      title: "Web app in Safari",
      body: "This is the way to use InfiniBot on iPhone today. Open the link in Safari, then add it to your Home Screen so it opens like an app.",
      status: "available",
    },
    { id: "appstore", title: "App Store / TestFlight", body: "Coming soon.", status: "coming-soon" },
  ];
}

export function homeScreenSteps(os: PhoneOs): string[] {
  if (os === "iphone") {
    return [
      "Open the link in Safari (other browsers on iPhone can't add web apps).",
      "Tap the Share button (the square with an arrow pointing up) at the bottom of the screen.",
      "Scroll down and tap Add to Home Screen.",
      "Tap Add. InfiniBot now opens from your Home Screen like an app.",
    ];
  }
  return [
    "Open the link in Chrome.",
    "Tap the three-dot menu at the top right.",
    "Tap Add to Home screen (or Install app), then Add.",
    "InfiniBot now opens from your Home Screen like an app.",
  ];
}

/** The phone web app URL on a gateway base (https ts.net link or LAN http). */
export function phoneWebAppUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/mobile-web/`;
}

/** LAN fallback base from mobile.config.get suggested addresses. */
export function lanBase(lanAddress: string | null | undefined, port: number): string | null {
  return lanAddress ? `http://${lanAddress}:${port}` : null;
}

// ── demo fixtures (?remoteDemo=<state>) for visual checks of states this
// machine can't be put in safely; nothing is called or saved ──────────────

export function remoteDemoState(): RemoteNextStep | null {
  try {
    const v = new URLSearchParams(window.location.search).get("remoteDemo");
    return v && ["install", "start", "login", "approve", "magicdns", "https", "create", "ready"].includes(v) ? (v as RemoteNextStep) : null;
  } catch {
    return null;
  }
}

export function demoStatus(step: RemoteNextStep, platform = "win32"): RemoteStatus {
  const host = "your-pc.your-tailnet.ts.net";
  const running = !["install", "start", "login", "approve"].includes(step);
  const mapping: ServeMapping = { hostPort: `${host}:8443`, host, port: 8443, path: "/", target: "http://127.0.0.1:18789", url: `https://${host}:8443`, funnel: false };
  const messages: Record<RemoteNextStep, string> = {
    install: "Tailscale isn't installed on this computer yet.",
    start: "Tailscale is installed but not running. Open the Tailscale app (or start the tailscaled service).",
    login: "Sign in to Tailscale to continue.",
    approve: "This computer is waiting for approval in the Tailscale admin console (Machines).",
    magicdns: "MagicDNS is off for your tailnet. Turn it on in the Tailscale admin console.",
    https: "HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin console (DNS page).",
    create: "Tailscale is ready. Create your private link.",
    ready: "Your private link is set up.",
  };
  return {
    platform,
    installed: step !== "install",
    binary: step === "install" ? null : "C:\\Program Files\\Tailscale\\tailscale.exe",
    running: step !== "install" && step !== "start",
    backendState: step === "install" ? "NotInstalled" : step === "start" ? "NotRunning" : step === "login" ? "NeedsLogin" : step === "approve" ? "NeedsMachineAuth" : "Running",
    loggedIn: running,
    authUrl: null,
    magicDns: running ? step !== "magicdns" : null,
    httpsCerts: running ? step !== "magicdns" && step !== "https" : null,
    dnsName: running && step !== "magicdns" ? host : null,
    tailnet: running ? "your-tailnet.ts.net" : null,
    account: running ? "you@example.com" : null,
    gatewayPort: 18789,
    mappings: step === "ready" ? [{ ...mapping, hostPort: `${host}:443`, port: 443, target: "http://127.0.0.1:3000", url: `https://${host}` }, mapping] : [],
    gatewayMapping: step === "ready" ? mapping : null,
    savedUrl: step === "ready" ? mapping.url : null,
    nextStep: step,
    message: messages[step],
    downloadUrl: platform === "win32" ? "https://tailscale.com/download/windows" : platform === "darwin" ? "https://tailscale.com/download/mac" : "https://tailscale.com/download/linux",
    adminDnsUrl: "https://login.tailscale.com/admin/dns",
  };
}
