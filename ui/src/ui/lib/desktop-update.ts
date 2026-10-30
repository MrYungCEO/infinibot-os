/**
 * Desktop-app update model for the sidebar update widget.
 *
 * Inside the desktop (Electron) app the source of truth is the desktop
 * release feed (electron-updater, MrYungCEO/infinibot-desktop-releases),
 * NOT the npm registry: npm `latest` can be older than the desktop build,
 * which made 2026.10.9 desktop installs say "Up to date" while 2026.10.18
 * was out.
 *
 *   - preload exposes `window.desktopUpdater` (2026.10.19+): the main process
 *     owns the state (checking / available / downloading / ready / …).
 *   - older desktop shells have no bridge: read the feed from the renderer
 *     and offer a download link (no in-place install possible from here).
 */

export const DESKTOP_RELEASES_URL = "https://github.com/MrYungCEO/infinibot-desktop-releases/releases";
const DESKTOP_RELEASES_API =
  "https://api.github.com/repos/MrYungCEO/infinibot-desktop-releases/releases/latest";

export type DesktopPlatform = "win32" | "linux" | "darwin";

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  /** Newest published version, when known. */
  version: string | null;
  percent: number;
  error: string | null;
  /** nsis | appimage | deb | dev | other */
  packageType?: string;
  /** NSIS + AppImage update in place; .deb / old shells need a manual download. */
  canSelfUpdate: boolean;
  downloadUrl: string;
  checkedAt?: number | null;
}

export interface DesktopUpdaterBridge {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<boolean>;
  openDownload(): Promise<boolean>;
  onState(cb: (state: DesktopUpdateState) => void): () => void;
}

export type DesktopMode =
  | { kind: "ipc"; bridge: DesktopUpdaterBridge }
  | { kind: "feed"; platform: DesktopPlatform };

interface DesktopWindowLike {
  desktopUpdater?: Partial<DesktopUpdaterBridge>;
  platform?: { os?: string };
  navigator?: { userAgent?: string };
  document?: { documentElement?: { classList?: { contains(c: string): boolean } } | null };
}

function platformOf(win: DesktopWindowLike): DesktopPlatform {
  const os = win.platform?.os;
  if (os === "win32" || os === "linux" || os === "darwin") return os;
  const ua = win.navigator?.userAgent ?? "";
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
  return "linux";
}

/**
 * null = plain browser / npm install (keep the npm registry path).
 * The preload marks desktop documents with `html.desktop-shell`; the
 * Electron user agent covers shells that predate that class.
 */
export function detectDesktopMode(win: DesktopWindowLike | undefined = globalThis as DesktopWindowLike): DesktopMode | null {
  if (!win) return null;
  const bridge = win.desktopUpdater;
  if (bridge && typeof bridge.getState === "function" && typeof bridge.check === "function") {
    return { kind: "ipc", bridge: bridge as DesktopUpdaterBridge };
  }
  const shellClass = win.document?.documentElement?.classList?.contains("desktop-shell") ?? false;
  const electronUa = /\bElectron\//.test(win.navigator?.userAgent ?? "");
  if (shellClass || electronUa) return { kind: "feed", platform: platformOf(win) };
  return null;
}

/**
 * Semver-style compare for calendar versions (2026.10.18, v2026.10.9,
 * 2026.10.18-beta.1). -1 / 0 / 1; unparseable input → 0 (never claims an update).
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined) => {
    const s = String(v ?? "").trim().replace(/^v/i, "");
    if (!s) return null;
    const [core, pre = ""] = s.split("+")[0].split(/-(.*)/s);
    const nums = core.split(".").map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

export function isNewer(version: string | null | undefined, current: string | null | undefined): boolean {
  return !!version && compareVersions(version, current) > 0;
}

/** `version:` from an electron-updater latest*.yml body. */
export function parseFeedVersion(yml: string): string | null {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yml ?? "");
  return m ? m[1] : null;
}

export function feedUrl(platform: DesktopPlatform): string {
  return `${DESKTOP_RELEASES_URL}/latest/download/${platform === "linux" ? "latest-linux.yml" : "latest.yml"}`;
}

export function manualDownloadUrl(platform: DesktopPlatform): string {
  if (platform === "win32") return "https://infinibotos.com/download/windows";
  if (platform === "linux") return "https://infinibotos.com/download/linux";
  return `${DESKTOP_RELEASES_URL}/latest`;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Latest desktop version without the main-process bridge. latest.yml first
 * (the real updater feed); github.com release downloads send no CORS header,
 * so a renderer usually falls through to the GitHub API, which does.
 */
export async function fetchLatestDesktopVersion(
  platform: DesktopPlatform,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<string> {
  let lastError: unknown = null;
  try {
    const res = await fetchImpl(feedUrl(platform), { redirect: "follow", cache: "no-store" });
    if (res.ok) {
      const v = parseFeedVersion(await res.text());
      if (v) return v;
    }
    lastError = new Error(`feed HTTP ${res.status}`);
  } catch (err) {
    lastError = err;
  }
  try {
    const res = await fetchImpl(DESKTOP_RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (res.ok) {
      const tag = (JSON.parse(await res.text()) as { tag_name?: string }).tag_name;
      if (tag) return tag.replace(/^v/i, "");
    }
    lastError = new Error(`releases API HTTP ${res.status}`);
  } catch (err) {
    lastError = err;
  }
  throw lastError instanceof Error ? lastError : new Error("update feed unreachable");
}

/** Feed-mode check → the same state shape the main process reports. */
export async function checkDesktopFeed(
  platform: DesktopPlatform,
  currentVersion: string,
  fetchImpl?: FetchLike,
): Promise<DesktopUpdateState> {
  const base: DesktopUpdateState = {
    status: "checking",
    currentVersion,
    version: null,
    percent: 0,
    error: null,
    canSelfUpdate: false,
    downloadUrl: manualDownloadUrl(platform),
    checkedAt: Date.now(),
  };
  try {
    const latest = await fetchLatestDesktopVersion(platform, fetchImpl);
    return { ...base, status: isNewer(latest, currentVersion) ? "available" : "up-to-date", version: latest };
  } catch (err) {
    return { ...base, status: "error", error: (err as Error).message };
  }
}

export type DesktopChipAction = "check" | "download" | "open-download" | "install" | null;

export interface DesktopChipModel {
  kind: "muted" | "highlight" | "active" | "ok" | "error";
  text: string;
  title: string;
  action: DesktopChipAction;
  spinning?: boolean;
  progress?: number;
}

/** What the sidebar chip shows for a desktop update state. Never "up to date" on error. */
export function desktopChipModel(s: DesktopUpdateState): DesktopChipModel {
  const v = s.version;
  switch (s.status) {
    case "idle":
    case "checking":
      return { kind: "muted", text: "Checking…", title: "Checking for desktop updates…", action: null, spinning: true };
    case "available":
      if (!isNewer(v, s.currentVersion)) {
        return upToDate(s);
      }
      return s.canSelfUpdate
        ? {
            kind: "highlight",
            text: `Update → ${v}`,
            title: `InfiniBot ${v} is available (you have v${s.currentVersion}). Click to download it.`,
            action: "download",
          }
        : {
            kind: "highlight",
            text: `Download v${v}`,
            title: `InfiniBot ${v} is available (you have v${s.currentVersion}). This install can't update itself — download and run the new installer.`,
            action: "open-download",
          };
    case "downloading":
      return {
        kind: "active",
        text: `Downloading ${v ?? "update"}… ${Math.round(s.percent)}%`,
        title: `Downloading InfiniBot ${v ?? ""}…`,
        action: null,
        spinning: true,
        progress: s.percent,
      };
    case "ready":
      return {
        kind: "highlight",
        text: `Restart to update → ${v ?? ""}`,
        title: `InfiniBot ${v} is downloaded. Click to restart and install it.`,
        action: "install",
      };
    case "up-to-date":
      return upToDate(s);
    case "error":
      if (isNewer(v, s.currentVersion)) {
        return {
          kind: "highlight",
          text: `Update v${v} available — Download`,
          title: `InfiniBot ${v} is available, but the automatic update failed${s.error ? `:\n${s.error}` : "."}\n\nClick to download the installer.`,
          action: "open-download",
        };
      }
      return {
        kind: "error",
        text: "Update check failed — retry",
        title: `${s.error ?? "Couldn't reach the desktop update feed."}\n\nClick to retry.`,
        action: "check",
      };
  }
}

function upToDate(s: DesktopUpdateState): DesktopChipModel {
  return {
    kind: "ok",
    text: `Up to date — v${s.currentVersion}`,
    title: `v${s.currentVersion} is the latest desktop release. Click to check now.`,
    action: "check",
  };
}
