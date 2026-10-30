/**
 * Sidebar update widget.
 *
 * Compact control at the bottom of the nav sidebar that owns the WHOLE
 * update lifecycle for npm-installed instances. State drives the appearance:
 *   - uptodate   → subtle green dot + "vX.Y.Z"            (click = re-check)
 *   - available  → accent badge "Update → vA.B.C"          (click = update now)
 *   - preflight  → "Checking environment…"
 *   - updating   → progress bar "Updating… 42%" + last log line
 *   - updated    → "Restart to apply vA.B.C" CTA           (no auto-restart)
 *   - error      → cause-named red chip (network / permission / rate-limit / …)
 *
 * Source of truth for "is there an update" is the npm registry `latest`,
 * compared to the running version, cached 10 min server-side. Refresh fires on
 * first paint, on a slow poll, and on manual "Check now".
 *
 * Two install paths share ONE service — picked by `installKind` from the
 * check:
 *   - prod (npm install): update.prod.preflight → update.prod.install (streamed)
 *   - dev (source checkout): the existing update.auto.apply (update-runner)
 *
 * Federation: a satellite that knows its master's version is offered a
 * "Match master (vX)" pin as the recommended target.
 *
 * The legacy git-pull / merge-conflict resolver has been removed — it only
 * ever worked for dev checkouts and confused npm-installed users.
 *
 * Desktop (Electron) app: npm `latest` is NOT the source of truth there (it
 * can be older than the desktop build). The widget follows the desktop
 * release feed instead — electron-updater state over the preload bridge, or
 * the feed read directly on shells that predate the bridge. See
 * ../lib/desktop-update.ts.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import { icons } from "../icons.js";
import {
  checkDesktopFeed,
  desktopChipModel,
  detectDesktopMode,
  type DesktopMode,
  type DesktopUpdateState,
} from "../lib/desktop-update";
import { ensureHomeGlassStyles } from "./home-glass";

interface FederationInfo {
  isSatellite: boolean;
  masterVersion: string | null;
  recommendedVersion: string | null;
}

interface ProdUpdateCheck {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  manager: "npm" | "pnpm" | "yarn" | "bun";
  installKind: "dev" | "prod";
  fromCache: boolean;
  error?: string;
  errorKind?: string;
  federation?: FederationInfo | null;
}

type Phase =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "preflight"
  | "updating"
  | "updated"
  | "error";

interface State {
  phase: Phase;
  check: ProdUpdateCheck | null;
  /** Version we're installing toward (latest, or master pin). */
  targetVersion: string | null;
  error: string | null;
  errorKind: string | null;
  /** Remediation command/hint for the current error (e.g. sudo …). */
  hint: string | null;
  progressPct: number;
  progressPhase: string | null;
  lastLine: string | null;
  installId: string | null;
  lastCheckedAt: number | null;
}

const S: State = {
  phase: "idle",
  check: null,
  targetVersion: null,
  error: null,
  errorKind: null,
  hint: null,
  progressPct: 0,
  progressPhase: null,
  lastLine: null,
  installId: null,
  lastCheckedAt: null,
};

let bumpRender: (() => void) | null = null;
let activeClient: GatewayBrowserClient | null = null;
let autoCheckTimer: number | null = null;
let progressUnsub: (() => void) | null = null;

function set<K extends keyof State>(k: K, v: State[K]): void {
  S[k] = v;
  bumpRender?.();
}

function patch(p: Partial<State>): void {
  Object.assign(S, p);
  bumpRender?.();
}

async function call<T>(method: string, params: unknown = {}): Promise<T> {
  if (!activeClient) throw new Error("not-connected");
  return activeClient.request<T>(method, params);
}

// ── Check ────────────────────────────────────────────────────────────────

async function runCheck(force = false): Promise<void> {
  if (S.phase === "checking" || S.phase === "updating" || S.phase === "preflight") return;
  set("phase", "checking");
  patch({ error: null, errorKind: null, hint: null });
  try {
    const check = await call<ProdUpdateCheck>("update.prod.check", { force });
    if (!check || typeof check.currentVersion !== "string") {
      throw new Error("malformed response");
    }
    if (check.error) {
      patch({
        check,
        phase: "error",
        error: check.error,
        errorKind: check.errorKind ?? "registry",
      });
      return;
    }
    patch({
      check,
      phase: check.hasUpdate ? "available" : "uptodate",
      targetVersion: check.latestVersion,
      lastCheckedAt: Date.now(),
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "not-connected") {
      set("phase", "idle");
      return;
    }
    patch({ phase: "error", error: msg, errorKind: "registry" });
  }
}

// ── Update (prod npm path) ─────────────────────────────────────────────────

async function runUpdate(version?: string | null): Promise<void> {
  if (S.phase === "updating" || S.phase === "preflight") return;
  const check = S.check;
  const target = version ?? S.targetVersion ?? check?.latestVersion ?? "latest";

  // Dev checkout: the npm path can't help — use the source updater.
  if (check?.installKind === "dev") {
    return runDevUpdate();
  }

  if (
    !confirm(
      `Update InfiniBot from ${check?.currentVersion ?? "current"} to ${target}?\n\nThe new version installs globally. You'll restart InfiniBot afterwards to apply it.`,
    )
  ) {
    return;
  }

  patch({ phase: "preflight", error: null, errorKind: null, hint: null });
  try {
    const pre = await call<{
      ok: boolean;
      hint?: string;
      writable?: { errorKind?: string };
      network?: { ok: boolean };
      disk?: { ok: boolean };
    }>("update.prod.preflight");
    if (!pre.ok) {
      const kind = !pre.network?.ok
        ? "network"
        : pre.writable?.errorKind === "permission"
          ? "permission"
          : !pre.disk?.ok
            ? "disk"
            : "unknown";
      patch({
        phase: "error",
        error: pre.hint ?? "Pre-flight checks failed",
        errorKind: kind,
        hint: pre.hint ?? null,
      });
      return;
    }
  } catch (err) {
    patch({ phase: "error", error: (err as Error).message, errorKind: "unknown" });
    return;
  }

  // Subscribe to streamed progress before kicking off the install.
  subscribeProgress();
  patch({
    phase: "updating",
    targetVersion: target,
    progressPct: 5,
    progressPhase: "Starting",
    lastLine: null,
    installId: null,
  });

  try {
    const result = await call<{
      ok: boolean;
      exitCode: number | null;
      errorKind?: string;
      hint?: string;
      commandLine?: string;
    }>("update.prod.install", { version: target });
    if (result.ok) {
      patch({ phase: "updated", progressPct: 100, progressPhase: "Done" });
    } else {
      patch({
        phase: "error",
        error: result.hint ?? `Install failed (exit ${result.exitCode ?? "?"})`,
        errorKind: result.errorKind ?? "unknown",
        hint: result.hint ?? null,
      });
    }
  } catch (err) {
    patch({ phase: "error", error: (err as Error).message, errorKind: "unknown" });
  } finally {
    unsubscribeProgress();
  }
}

// ── Update (dev source path — existing update-runner) ───────────────────────

async function runDevUpdate(): Promise<void> {
  if (
    !confirm(
      "This is a source/dev checkout. Run the source updater (git rebase + rebuild)?\n\nThe gateway will restart afterwards.",
    )
  ) {
    return;
  }
  patch({ phase: "updating", progressPct: 50, progressPhase: "Building…", lastLine: null });
  try {
    const r = await call<{ result?: { applied?: boolean; error?: string } }>(
      "update.auto.apply",
      {},
    );
    const applied = r?.result?.applied;
    if (applied) {
      patch({ phase: "updated", progressPct: 100, progressPhase: "Done" });
      window.setTimeout(() => void runCheck(true), 8000);
    } else {
      patch({
        phase: "error",
        error: r?.result?.error ?? "Source update failed",
        errorKind: "unknown",
      });
    }
  } catch (err) {
    patch({ phase: "error", error: (err as Error).message, errorKind: "unknown" });
  }
}

// ── Streamed install progress ───────────────────────────────────────────────

function subscribeProgress(): void {
  if (progressUnsub || !activeClient) return;
  progressUnsub = activeClient.subscribe((evt: GatewayEventFrame) => {
    if (evt.event !== "update.prod.progress") return;
    const p = evt.payload as {
      installId?: string;
      kind?: string;
      pct?: number;
      phase?: string;
      line?: string;
      ok?: boolean;
      errorKind?: string;
      hint?: string;
    };
    if (!p || typeof p !== "object") return;
    // Lock onto the first installId we see for this session.
    if (p.kind === "start" && p.installId) {
      patch({ installId: p.installId });
      return;
    }
    if (S.installId && p.installId && p.installId !== S.installId) return;
    if (p.kind === "phase") {
      patch({
        progressPct: typeof p.pct === "number" ? p.pct : S.progressPct,
        progressPhase: p.phase ?? S.progressPhase,
      });
    } else if (p.kind === "line") {
      if (p.line) set("lastLine", p.line);
    } else if (p.kind === "end") {
      // Authoritative result still comes from the RPC response; this just
      // keeps the bar honest if the response is slow.
      if (p.ok) patch({ progressPct: 100, progressPhase: "Done" });
    }
  });
}

function unsubscribeProgress(): void {
  progressUnsub?.();
  progressUnsub = null;
}

function startAutoCheckPolling(): void {
  if (autoCheckTimer !== null) return;
  // Quiet 30-min poll — the badge appears within an hour of release without
  // hammering the registry (server caches each check for 10 min regardless).
  autoCheckTimer = window.setInterval(() => void runCheck(false), 30 * 60 * 1000);
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderSidebarUpdateWidget(host: {
  requestUpdate?: () => void;
  client?: GatewayBrowserClient | null;
}): TemplateResult {
  ensureHomeGlassStyles();
  bumpRender = () => host.requestUpdate?.();
  activeClient = host.client ?? null;
  const desktop = detectDesktopMode(window);
  if (desktop) return renderDesktopWidget(desktop);
  // Refresh on first paint (force = always re-check on sidebar open).
  if (S.phase === "idle" && activeClient !== null) {
    queueMicrotask(() => void runCheck(true));
    startAutoCheckPolling();
  }
  return html`
    ${STYLE}
    ${renderButton()}
    ${renderFederationPin()}
    ${renderProgress()}
  `;
}

// ── Desktop app (electron-updater feed) ─────────────────────────────────────

const D: {
  mode: DesktopMode | null;
  state: DesktopUpdateState | null;
  busy: boolean;
  unsub: (() => void) | null;
  timer: number | null;
} = { mode: null, state: null, busy: false, unsub: null, timer: null };

function setDesktopState(next: DesktopUpdateState | null): void {
  D.state = next;
  bumpRender?.();
}

async function desktopCurrentVersion(): Promise<string | null> {
  try {
    const check = await call<ProdUpdateCheck>("update.prod.check", { force: false });
    return typeof check?.currentVersion === "string" ? check.currentVersion : null;
  } catch {
    return null;
  }
}

async function desktopRefresh(force: boolean): Promise<void> {
  const mode = D.mode;
  if (!mode || D.busy) return;
  D.busy = true;
  try {
    if (mode.kind === "ipc") {
      if (force) setDesktopState(D.state ? { ...D.state, status: "checking", error: null } : null);
      let next = await mode.bridge.getState();
      if (force || next.status === "idle") next = await mode.bridge.check();
      setDesktopState(next);
      return;
    }
    // Old desktop shell (no bridge): the bundled gateway's version is the
    // desktop version; read the feed and offer a download.
    const current = await desktopCurrentVersion();
    if (!current) return; // gateway not connected yet — retry on next paint/poll
    setDesktopState(D.state ? { ...D.state, status: "checking", error: null } : null);
    setDesktopState(await checkDesktopFeed(mode.platform, current));
  } catch (err) {
    const prev = D.state;
    setDesktopState({
      status: "error",
      currentVersion: prev?.currentVersion ?? "?",
      version: prev?.version ?? null,
      percent: 0,
      error: (err as Error).message,
      canSelfUpdate: false,
      downloadUrl: prev?.downloadUrl ?? "",
    });
  } finally {
    D.busy = false;
  }
}

function startDesktopUpdates(mode: DesktopMode): void {
  if (D.mode) return;
  D.mode = mode;
  if (mode.kind === "ipc") {
    D.unsub = mode.bridge.onState((next) => setDesktopState(next));
  }
  queueMicrotask(() => void desktopRefresh(false));
  // The main process re-checks every 4 h on its own; this keeps the feed
  // path (and a widget left open for days) honest.
  D.timer = window.setInterval(() => void desktopRefresh(false), 60 * 60 * 1000);
}

async function desktopAction(action: ReturnType<typeof desktopChipModel>["action"]): Promise<void> {
  const mode = D.mode;
  const s = D.state;
  if (!mode || !action) return;
  if (action === "check") return desktopRefresh(true);
  if (mode.kind === "ipc") {
    if (action === "download") setDesktopState(await mode.bridge.download());
    else if (action === "open-download") await mode.bridge.openDownload();
    else if (action === "install") await mode.bridge.install();
    return;
  }
  if ((action === "open-download" || action === "download") && s?.downloadUrl) {
    window.open(s.downloadUrl, "_blank", "noopener");
  }
}

function renderDesktopWidget(mode: DesktopMode): TemplateResult {
  startDesktopUpdates(mode);
  const s = D.state;
  // Feed mode needs the gateway for the current version; retry once it's connected.
  if (mode.kind === "feed" && !s && activeClient && !D.busy) {
    queueMicrotask(() => void desktopRefresh(false));
  }
  const m = s
    ? desktopChipModel(s)
    : desktopChipModel({
        status: "checking",
        currentVersion: "",
        version: null,
        percent: 0,
        error: null,
        canSelfUpdate: false,
        downloadUrl: "",
      });
  const icon =
    m.kind === "ok"
      ? (icons.check ?? icons.download)
      : m.kind === "muted" || m.kind === "active"
        ? (icons.refresh ?? icons.download)
        : icons.download;
  const pct = Math.max(0, Math.min(100, Math.round(m.progress ?? 0)));
  return html`
    ${STYLE}
    <div class="sidebar-upd-desktop" data-desktop-update=${s?.status ?? "checking"}>
      ${chip({
        kind: m.kind,
        icon,
        title: m.title,
        text: m.text,
        onClick: m.action ? () => void desktopAction(m.action) : undefined,
        spinning: m.spinning,
        dot: m.kind === "ok" ? "ok" : undefined,
      })}
      ${m.progress !== undefined
        ? html`<div class="sidebar-upd-progress">
            <div class="sidebar-upd-bar"><div class="sidebar-upd-fill" style="width:${pct}%"></div></div>
          </div>`
        : nothing}
    </div>
  `;
}

function masterPinTarget(): string | null {
  const fed = S.check?.federation;
  if (!fed?.isSatellite) return null;
  const mv = fed.recommendedVersion ?? fed.masterVersion;
  if (!mv || !S.check) return null;
  if (mv === S.check.currentVersion) return null;
  return mv;
}

function renderFederationPin(): TemplateResult {
  // Only offered when there's a master version worth matching and we're idle
  // on an actionable state.
  if (S.phase !== "available" && S.phase !== "uptodate") return nothing;
  const mv = masterPinTarget();
  if (!mv) return nothing;
  return chip({
    kind: "highlight",
    icon: icons.download,
    title: `Match the version your master node is running (v${mv}).`,
    text: `Match master → ${mv}`,
    onClick: () => void runUpdate(mv),
  });
}

function renderProgress(): TemplateResult {
  if (S.phase !== "updating") return nothing;
  const pct = Math.max(0, Math.min(100, Math.round(S.progressPct)));
  return html`
    <div class="sidebar-upd-progress" title=${S.lastLine ?? ""}>
      <div class="sidebar-upd-bar"><div class="sidebar-upd-fill" style="width:${pct}%"></div></div>
      ${S.lastLine
        ? html`<div class="sidebar-upd-log">${S.lastLine}</div>`
        : nothing}
    </div>
  `;
}

function errorLabel(kind: string | null): string {
  switch (kind) {
    case "network":
      return "No network — retry";
    case "permission":
      return "Needs permission";
    case "rate-limit":
      return "Registry busy — retry";
    case "version-not-found":
      return "Version missing";
    case "disk":
      return "Low disk space";
    case "registry":
      return "Registry error — retry";
    default:
      return "Update failed — retry";
  }
}

function renderButton(): TemplateResult {
  const c = S.check;
  switch (S.phase) {
    case "idle":
    case "checking":
      return chip({
        kind: "muted",
        icon: icons.refresh ?? icons.download,
        title: "Checking for updates…",
        text: "Checking…",
        onClick: () => void runCheck(true),
        spinning: S.phase === "checking",
      });
    case "uptodate":
      return chip({
        kind: "ok",
        icon: icons.check ?? icons.download,
        title: `v${c?.currentVersion} — up to date. Click to check now.`,
        text: `Up to date — v${c?.currentVersion ?? "?"}`,
        onClick: () => void runCheck(true),
        dot: "ok",
      });
    case "available":
      return chip({
        kind: "highlight",
        icon: icons.download,
        title: `Update available: v${c?.latestVersion}. Click to update now.`,
        text: `Update → ${c?.latestVersion}`,
        onClick: () => void runUpdate(),
      });
    case "preflight":
      return chip({
        kind: "active",
        icon: icons.refresh ?? icons.download,
        title: "Checking environment (network, permissions, disk)…",
        text: "Checking environment…",
        spinning: true,
      });
    case "updating":
      return chip({
        kind: "active",
        icon: icons.refresh ?? icons.download,
        title: S.lastLine ?? "Installing update… do not close.",
        text: `Updating… ${Math.round(S.progressPct)}%`,
        spinning: true,
      });
    case "updated":
      return chip({
        kind: "ok",
        icon: icons.check ?? icons.download,
        title: `Installed v${S.targetVersion}. Quit and relaunch InfiniBot to run it.`,
        text: `Restart to apply v${S.targetVersion ?? ""}`,
        onClick: () => void runCheck(true),
        dot: "ok",
      });
    case "error":
      return chip({
        kind: "error",
        icon: icons.download,
        title: `${S.error ?? "Update error."}${S.hint ? `\n\n${S.hint}` : ""}\n\nClick to retry.`,
        text: errorLabel(S.errorKind),
        onClick: () => void runCheck(true),
      });
  }
}

interface ChipProps {
  kind: "muted" | "highlight" | "active" | "ok" | "error";
  icon: TemplateResult;
  title: string;
  text: string;
  onClick?: () => void;
  spinning?: boolean;
  dot?: "ok";
}

function chip(p: ChipProps): TemplateResult {
  return html`
    <button
      class="sidebar-upd sidebar-upd--${p.kind}"
      title=${p.title}
      ?disabled=${!p.onClick}
      @click=${() => p.onClick?.()}
    >
      <span class="sidebar-upd-icon ${p.spinning ? "spin" : ""}">${p.icon}</span>
      <span class="sidebar-upd-text">${p.text}</span>
      ${p.dot === "ok" ? html`<span class="sidebar-upd-dot"></span>` : nothing}
    </button>
  `;
}

const STYLE = html`
  <style>
    .sidebar-upd {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-top: 8px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: #a1a1aa;
      font: 600 11px/1 'Inter', system-ui, sans-serif;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .sidebar-upd:hover:not(:disabled) {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.14);
      color: #e4e4e7;
    }
    .sidebar-upd:disabled { cursor: default; opacity: 0.85; }
    .sidebar-upd-icon { display: inline-flex; flex-shrink: 0; }
    .sidebar-upd-icon svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; }
    .sidebar-upd-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Desktop labels carry the call to action ("… — Download"): wrap, don't clip. */
    .sidebar-upd-desktop .sidebar-upd-text { white-space: normal; line-height: 1.35; }
    .sidebar-upd-dot {
      width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0;
      background: #22c55e;
      box-shadow: 0 0 8px rgba(34,197,94,0.7);
    }
    .sidebar-upd--ok { color: #86efac; border-color: rgba(34,197,94,0.22); }
    .sidebar-upd--ok:hover:not(:disabled) { color: #bbf7d0; border-color: rgba(34,197,94,0.4); }
    .sidebar-upd--highlight {
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 22%, transparent), color-mix(in srgb, var(--g-primary) 8%, transparent));
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      color: var(--g-primary);
      box-shadow: 0 0 16px color-mix(in srgb, var(--g-primary) 25%, transparent);
      animation: sidebarUpdGlow 2.4s ease-in-out infinite;
    }
    .sidebar-upd--highlight:hover { color: #facc15; }
    .sidebar-upd--active {
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      color: var(--g-primary);
    }
    .sidebar-upd--error {
      background: rgba(239,68,68,0.12);
      border-color: rgba(239,68,68,0.4);
      color: #f87171;
    }
    .sidebar-upd-icon.spin svg { animation: sidebarUpdSpin 1.1s linear infinite; }

    .sidebar-upd-progress { margin-top: 6px; padding: 0 2px; }
    .sidebar-upd-bar {
      height: 5px; border-radius: 999px; overflow: hidden;
      background: rgba(255,255,255,0.08);
    }
    .sidebar-upd-fill {
      height: 100%; border-radius: 999px;
      background: linear-gradient(90deg, var(--g-primary), color-mix(in srgb, var(--g-primary) 60%, #f59e0b 40%));
      transition: width 0.3s ease;
    }
    .sidebar-upd-log {
      margin-top: 4px;
      font: 500 9.5px/1.4 'JetBrains Mono', monospace;
      color: #71717a;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    @keyframes sidebarUpdSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes sidebarUpdGlow {
      0%, 100% { box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 20%, transparent); }
      50%      { box-shadow: 0 0 22px color-mix(in srgb, var(--g-primary) 45%, transparent); }
    }
  </style>
`;
