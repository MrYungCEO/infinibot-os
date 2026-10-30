/**
 * "Use my subscription": shared client state for CLI routing.
 *
 * Gateway agents can chat THROUGH the user's signed-in AI accounts (Claude
 * Code, Codex CLI, Gemini CLI, Grok Build, OpenCode) instead of a paid key.
 * Backed by the gateway's cliRouting.* RPCs (src/gateway/server-methods/
 * cli-routing.ts) plus the Coders installer / sign-in RPCs (coders.*).
 *
 * Used by Setup › Coders (<cli-routing-settings>), the onboarding brain step
 * and the chat "subscription" error card. Nothing here ever switches routing
 * on by itself: only cliRouting.set / cliRouting.connect do, on user action.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

import { awaitGatewayClient, getGatewayClient, type GatewayBrowserClient } from "../gateway-client.js";

export type CliAuth = "signed-in" | "signed-out" | "api-key" | "env" | "unknown" | "n/a";

export interface CliRoutingBackendView {
  id: string;
  label: string;
  vendor: string;
  plan: string;
  command: string;
  installed: boolean;
  version?: string;
  auth: CliAuth;
  ready: boolean;
  localOnly: boolean;
  model: string;
  inOrder: boolean;
  installUrl: string;
  coderId: string | null;
  /** Beginner name of the account ("ChatGPT", "Google account"). */
  account: string;
  /** "Sign in with ChatGPT". */
  signInLabel: string;
  free: boolean;
  recommended: boolean;
  loginMode: "browser" | "terminal";
}

export interface CliRoutingStatus {
  /** False on a shared cloud server: hide every subscription option. */
  available: boolean;
  /** local = this computer; tenant-machine = the workspace's own cloud Machine. */
  where?: "local" | "tenant-machine" | "shared-cloud";
  /** Why it's unavailable here (plain language), when available is false. */
  unavailableReason?: string;
  enabled: boolean;
  /** Route ALL traffic (every agent, every pinned model) through the CLIs. */
  allTraffic?: boolean;
  providers: string[];
  fallbackToApi: boolean;
  tools: boolean;
  active: string | null;
  backends: CliRoutingBackendView[];
  unsupported: Array<{ id: string; label: string; reason: string }>;
  agents: Array<{ id: string; name?: string; routed: boolean; override: boolean | null }>;
}

export interface CliRoutingSetParams {
  enabled?: boolean;
  providers?: string[];
  fallbackToApi?: boolean;
  tools?: boolean;
  allTraffic?: boolean;
  models?: Record<string, string>;
  agentId?: string;
  agentEnabled?: boolean | null;
}

export type LoginStatus = "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";

export interface LoginSessionView {
  sessionId: string;
  coderId?: string;
  status: LoginStatus;
  url?: string;
  userCode?: string;
  needsCode: boolean;
  output?: string;
  error?: string;
}

export type CliLoginResult =
  | { mode: "browser"; session: LoginSessionView }
  | { mode: "terminal"; terminalId: string; command: string };

export type SubscriptionErrorCode =
  | "subscription_limit"
  | "subscription_signed_out"
  | "subscription_missing"
  | "subscription_timeout"
  | "subscription_unsupported"
  | "subscription_plan"
  | "subscription_untrusted"
  | "subscription_failed";

export type CliConnectResult =
  | { ok: true; reply: string; ms: number; status?: CliRoutingStatus }
  | { ok: false; code: SubscriptionErrorCode | string; message: string; ms?: number };

/** Live browser sign-in for one backend. */
export interface CliLoginState {
  backendId: string;
  mode: "browser" | "terminal";
  session: LoginSessionView | null;
  startedAt: number;
  /** When the sign-in URL first arrived (for the "didn't see a window?" nudge). */
  urlAt: number | null;
  /** The sign-in link last handed to the browser. */
  openedUrl?: string;
  /** window.open returned a window (false = blocked: show an explicit open button). */
  opened: boolean;
  submitting: boolean;
  error: string | null;
  /** Terminal mode: the InfiniBot terminal running the sign-in. */
  terminalId?: string;
}

export interface CliInstallJob {
  phase: string;
  running: boolean;
  ok?: boolean;
  /** Plain-language reason + next step, from the gateway. */
  error?: string;
  /** Command that installs it by hand (offered with Try again). */
  manual?: string;
}

/** True when the gateway predates cliRouting.* (older build, restart pending). */
export function isCliRoutingMissing(err: unknown): boolean {
  return /unknown method|method not found|no such method/i.test(String((err as Error)?.message ?? err));
}

export function cliErrText(err: unknown): string {
  return String((err as Error)?.message ?? err)
    .replace(/^Error:\s*/, "")
    .slice(0, 220);
}

export function isSubscriptionCode(code: unknown): code is SubscriptionErrorCode {
  return typeof code === "string" && code.startsWith("subscription_");
}

/** Backends sorted the way the route tries them: the fallback order first, then the rest. */
export function orderedBackends(st: CliRoutingStatus): CliRoutingBackendView[] {
  const rank = (id: string) => {
    const i = st.providers.indexOf(id);
    return i < 0 ? 1000 : i;
  };
  return [...st.backends].sort((a, b) => rank(a.id) - rank(b.id));
}

/** First version-looking token ("2.1.4") out of a `--version` string. */
export function cliVersion(v?: string): string {
  return v?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? v ?? "";
}

export function cliAuthLabel(b: CliRoutingBackendView): { text: string; tone: "ok" | "warn" | "muted" } {
  if (!b.installed) return { text: "Not set up", tone: "muted" };
  switch (b.auth) {
    case "signed-in":
      return { text: "Signed in", tone: "ok" };
    case "api-key":
      return { text: "Using a key", tone: "ok" };
    case "env":
      return { text: "Key from environment", tone: "ok" };
    case "signed-out":
      return { text: "Sign in needed", tone: "warn" };
    case "n/a":
      return { text: "No sign-in needed", tone: "ok" };
    default:
      return { text: "Sign-in not checked", tone: "muted" };
  }
}

/** The account's own sign-in can run when the app is installed and not signed in yet. */
export function canSignIn(b: CliRoutingBackendView): boolean {
  return b.installed && b.auth !== "signed-in" && b.auth !== "n/a";
}

export function signedIn(b: CliRoutingBackendView): boolean {
  return b.installed && (b.auth === "signed-in" || b.auth === "n/a" || b.auth === "api-key" || b.auth === "env");
}

/** Extra hint for an unsupported tool (Antigravity → use Gemini CLI). */
export function cliUnsupportedHint(u: { id: string; label: string; reason?: string }): string | null {
  if (!/antigravity/i.test(`${u.id} ${u.label}`)) return null;
  // Newer gateways already say it in the reason.
  if (/google users|gemini/i.test(u.reason ?? "")) return null;
  return 'Google users: use "Sign in with Google" instead.';
}

const INSTALL_PHASE: Record<string, string> = {
  queued: "Queued",
  checking: "Checking disk",
  downloading: "Downloading",
  linking: "Linking",
  verifying: "Verifying",
  done: "Installed",
  failed: "Failed",
};

export function cliInstallPhase(j: CliInstallJob): string {
  return INSTALL_PHASE[j.phase] ?? j.phase;
}

type DesktopBridge = { openExternal?: (url: string) => Promise<{ ok?: boolean } | undefined> };

function desktopBridge(): DesktopBridge | null {
  const api = (globalThis as { api?: DesktopBridge }).api;
  return api && typeof api.openExternal === "function" ? api : null;
}

/**
 * Open a sign-in page in the user's default browser. Desktop app: through the
 * main process (shell.openExternal), never an in-app window. Web: a new tab.
 * False when it couldn't be opened (popup blocked): the UI then shows an
 * explicit "Open in browser" button plus the link to copy.
 */
export function openSignInWindow(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const bridge = desktopBridge();
  if (bridge) {
    void bridge.openExternal!(url).catch(() => {});
    return true;
  }
  try {
    const w = window.open(url, "_blank");
    if (!w) return false;
    try {
      w.opener = null;
    } catch {
      /* cross-origin already */
    }
    return true;
  } catch {
    return false;
  }
}

/** Copy text to the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type AppHost = { setTab?: (t: never) => void; requestUpdate?: () => void } & Record<string, unknown>;

function appElement(): AppHost | null {
  return (document.querySelector("infinibot-app") ?? document.querySelector("infinibot-control-ui")) as unknown as AppHost | null;
}

/** Switch the app to a tab (best effort; same as the rest of the app's cross-view hops). */
export function setAppTab(tab: string): void {
  const app = appElement();
  try {
    app?.setTab?.(tab as never);
  } catch {
    /* best effort */
  }
  app?.requestUpdate?.();
}

/** Switch the app to Terminals and focus the terminal the gateway just opened. */
export function openCliTerminal(terminalId: string): void {
  const app = appElement();
  if (!app) return;
  setAppTab("terminals");
  const focus = () =>
    void import("./terminals")
      .then(({ setActiveSession }) => setActiveSession(app as never, terminalId))
      .catch(() => undefined);
  focus();
  // The terminal.created event can land after the tab switch; focus again once it has.
  setTimeout(focus, 700);
}

const STATUS_POLL_MS = 3_000;
const STATUS_POLL_MAX_MS = 3 * 60_000;
const BROWSER_POLL_MS = 1_500;
const INSTALL_POLL_MS = 2_000;
const LOGIN_DONE: readonly LoginStatus[] = ["succeeded", "failed", "cancelled", "expired"];

/**
 * Shared state + actions: status, one-click installs (coders.install with
 * coders.status polling), sign-in (browser session via coders.login.poll, or a
 * terminal + cliRouting.status polling) and the connect test. Every timer and
 * open sign-in session stops when the host unmounts.
 */
export class CliRoutingModel implements ReactiveController {
  status: CliRoutingStatus | null = null;
  loading = false;
  missing = false;
  error: string | null = null;
  installs: Record<string, CliInstallJob> = {};
  /** Backend ids whose terminal sign-in we're watching for. */
  watching = new Set<string>();
  logins: Record<string, CliLoginState> = {};

  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchUntil = 0;
  private installTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loginTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private alive = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getClient: () => GatewayBrowserClient | null = () => null,
    private readonly hooks: { onInstalled?: (backendId: string) => void; onSignedIn?: (backendId: string) => void } = {},
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.alive = true;
  }

  hostDisconnected(): void {
    this.alive = false;
    this.stopWatching();
    for (const t of this.installTimers.values()) clearTimeout(t);
    this.installTimers.clear();
    for (const id of Object.keys(this.logins)) void this.cancelLogin(id);
  }

  backend(id: string | null | undefined): CliRoutingBackendView | null {
    return this.status?.backends.find((b) => b.id === id) ?? null;
  }

  private async client(): Promise<GatewayBrowserClient | null> {
    return this.getClient() ?? getGatewayClient() ?? (await awaitGatewayClient(15_000).catch(() => null));
  }

  private changed(): void {
    this.host.requestUpdate();
  }

  async load(quiet = false): Promise<CliRoutingStatus | null> {
    if (!quiet) {
      this.loading = true;
      this.changed();
    }
    const c = await this.client();
    try {
      if (!c) throw new Error("Not connected to InfiniBot yet.");
      this.status = await c.request<CliRoutingStatus>("cliRouting.status", {});
      this.missing = false;
      this.error = null;
    } catch (err) {
      if (isCliRoutingMissing(err)) this.missing = true;
      else if (!quiet) this.error = cliErrText(err);
    } finally {
      this.loading = false;
      this.changed();
    }
    return this.status;
  }

  /** cliRouting.set; throws so the caller can show its own message. */
  async set(params: CliRoutingSetParams): Promise<CliRoutingStatus> {
    const c = await this.client();
    if (!c) throw new Error("Not connected to InfiniBot yet.");
    try {
      this.status = await c.request<CliRoutingStatus>("cliRouting.set", params as Record<string, unknown>);
      return this.status;
    } catch (err) {
      if (isCliRoutingMissing(err)) this.missing = true;
      throw err;
    } finally {
      this.changed();
    }
  }

  /** One real test turn; on success the gateway switches routing on with this account first. */
  async connect(provider: string): Promise<CliConnectResult> {
    const c = await this.client();
    if (!c) return { ok: false, code: "subscription_failed", message: "InfiniBot isn't connected yet. Try again in a moment." };
    try {
      const res = await c.request<CliConnectResult>("cliRouting.connect", { provider }, { timeoutMs: 120_000 });
      if (res.ok && res.status) this.status = res.status;
      return res;
    } catch (err) {
      if (isCliRoutingMissing(err)) this.missing = true;
      return { ok: false, code: "subscription_failed", message: cliErrText(err) };
    } finally {
      this.changed();
    }
  }

  // ── sign-in ───────────────────────────────────────────────────────────

  /**
   * cliRouting.login. Browser mode opens the provider's sign-in page in a new
   * tab and polls the session; terminal mode shows the terminal (unless
   * `showTerminal` is false) and polls cliRouting.status.
   */
  async login(b: CliRoutingBackendView, opts: { mode?: "terminal"; showTerminal?: boolean } = {}): Promise<CliLoginResult> {
    const c = await this.client();
    if (!c) throw new Error("Not connected to InfiniBot yet.");
    await this.cancelLogin(b.id);
    const res = await c.request<CliLoginResult>("cliRouting.login", opts.mode ? { provider: b.id, mode: opts.mode } : { provider: b.id });
    if (res.mode === "browser") {
      this.logins = {
        ...this.logins,
        [b.id]: { backendId: b.id, mode: "browser", session: res.session, startedAt: Date.now(), urlAt: null, opened: false, submitting: false, error: null },
      };
      this.onSession(b.id, res.session);
    } else {
      this.logins = {
        ...this.logins,
        [b.id]: {
          backendId: b.id,
          mode: "terminal",
          session: null,
          startedAt: Date.now(),
          urlAt: null,
          opened: opts.showTerminal !== false,
          submitting: false,
          error: null,
          terminalId: res.terminalId,
        },
      };
      if (opts.showTerminal !== false && res.terminalId) openCliTerminal(res.terminalId);
      this.watching = new Set(this.watching).add(b.id);
      this.watchUntil = Date.now() + STATUS_POLL_MAX_MS;
      this.scheduleWatch();
    }
    this.changed();
    return res;
  }

  /** Re-open the sign-in page (popup blocked or closed). Must run from a click. */
  reopenLogin(backendId: string): boolean {
    const l = this.logins[backendId];
    const url = l?.session?.url;
    if (!l || !url) return false;
    const ok = openSignInWindow(url);
    this.logins = { ...this.logins, [backendId]: { ...l, opened: ok || l.opened, urlAt: Date.now() } };
    this.changed();
    return ok;
  }

  async submitCode(backendId: string, code: string): Promise<void> {
    const l = this.logins[backendId];
    if (!l?.session || !code.trim()) return;
    const c = await this.client();
    if (!c) return;
    this.logins = { ...this.logins, [backendId]: { ...l, submitting: true, error: null } };
    this.changed();
    try {
      await c.request("coders.login.submit", { sessionId: l.session.sessionId, code: code.trim() });
    } catch (err) {
      const cur = this.logins[backendId];
      if (cur) this.logins = { ...this.logins, [backendId]: { ...cur, error: cliErrText(err) } };
    } finally {
      const cur = this.logins[backendId];
      if (cur) this.logins = { ...this.logins, [backendId]: { ...cur, submitting: false } };
      this.changed();
    }
  }

  async cancelLogin(backendId: string): Promise<void> {
    clearTimeout(this.loginTimers.get(backendId));
    this.loginTimers.delete(backendId);
    const l = this.logins[backendId];
    if (!l) return;
    const next = { ...this.logins };
    delete next[backendId];
    this.logins = next;
    if (this.watching.has(backendId)) {
      const w = new Set(this.watching);
      w.delete(backendId);
      this.watching = w;
    }
    const sid = l.session?.sessionId;
    if (sid && !LOGIN_DONE.includes(l.session!.status)) {
      const c = getGatewayClient() ?? this.getClient();
      void c?.request("coders.login.cancel", { sessionId: sid }).catch(() => undefined);
    }
    this.changed();
  }

  private onSession(backendId: string, s: LoginSessionView): void {
    const l = this.logins[backendId];
    if (!l) return;
    let next: CliLoginState = { ...l, session: s };
    if (s.url && s.url !== l.openedUrl) {
      next.urlAt = Date.now();
      // Opened as soon as the link exists (still inside the click's activation
      // window in most browsers), and again if the CLI moves on to a new link.
      next = { ...next, openedUrl: s.url, opened: openSignInWindow(s.url) };
    }
    this.logins = { ...this.logins, [backendId]: next };
    this.changed();
    if (s.status === "succeeded") {
      void this.load(true).then(() => this.hooks.onSignedIn?.(backendId));
      return;
    }
    if (LOGIN_DONE.includes(s.status)) return;
    clearTimeout(this.loginTimers.get(backendId));
    this.loginTimers.set(
      backendId,
      setTimeout(() => void this.pollLogin(backendId), BROWSER_POLL_MS),
    );
  }

  private async pollLogin(backendId: string): Promise<void> {
    this.loginTimers.delete(backendId);
    const l = this.logins[backendId];
    if (!this.alive || !l?.session) return;
    const c = await this.client();
    if (!c) return;
    try {
      const s = await c.request<LoginSessionView>("coders.login.poll", { sessionId: l.session.sessionId });
      if (this.logins[backendId]) this.onSession(backendId, s);
    } catch (err) {
      const cur = this.logins[backendId];
      if (!cur?.session) return;
      this.onSession(backendId, { ...cur.session, status: "failed", error: cliErrText(err) });
    }
  }

  /** Terminal sign-in: watch cliRouting.status until the account is signed in. */
  private scheduleWatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => void this.watchTick(), STATUS_POLL_MS);
  }

  private async watchTick(): Promise<void> {
    this.watchTimer = null;
    if (!this.alive || !this.watching.size) return;
    const st = await this.load(true);
    const done: string[] = [];
    const left = new Set(
      [...this.watching].filter((id) => {
        const b = st?.backends.find((x) => x.id === id);
        const pending = b ? b.auth === "signed-out" || !b.installed : false;
        if (!pending) done.push(id);
        return pending;
      }),
    );
    this.watching = left;
    for (const id of done) {
      const next = { ...this.logins };
      delete next[id];
      this.logins = next;
      this.hooks.onSignedIn?.(id);
    }
    if (left.size && Date.now() < this.watchUntil && this.alive) this.scheduleWatch();
    else this.stopWatching();
    this.changed();
  }

  stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.watching.size) this.watching = new Set();
  }

  /** "Check again": refresh now (and keep watching if a terminal sign-in is pending). */
  async checkAgain(): Promise<void> {
    await this.load();
    for (const [id, l] of Object.entries(this.logins)) {
      if (l.mode === "browser" && l.session && !LOGIN_DONE.includes(l.session.status)) void this.pollLogin(id);
      if (this.backend(id) && signedIn(this.backend(id)!)) {
        void this.cancelLogin(id);
        this.hooks.onSignedIn?.(id);
      }
    }
    if (this.watching.size) {
      this.watchUntil = Math.max(this.watchUntil, Date.now() + STATUS_POLL_MAX_MS);
      await this.watchTick();
    }
  }

  // ── install ───────────────────────────────────────────────────────────

  /** One-click install through Setup › Coders' installer (user prefix, no admin rights). */
  async install(b: CliRoutingBackendView): Promise<boolean> {
    if (!b.coderId) return false;
    const coderId = b.coderId;
    this.installs = { ...this.installs, [b.id]: { phase: "queued", running: true } };
    this.changed();
    const c = await this.client();
    try {
      if (!c) throw new Error("Not connected to InfiniBot yet.");
      await c.request("coders.install", { id: coderId });
      return await new Promise<boolean>((resolve) => this.scheduleInstallPoll(b.id, coderId, resolve));
    } catch (err) {
      this.installs = { ...this.installs, [b.id]: { phase: "failed", running: false, ok: false, error: cliErrText(err) } };
      this.changed();
      return false;
    }
  }

  private scheduleInstallPoll(backendId: string, coderId: string, done: (ok: boolean) => void): void {
    clearTimeout(this.installTimers.get(backendId));
    this.installTimers.set(
      backendId,
      setTimeout(() => void this.installTick(backendId, coderId, done), INSTALL_POLL_MS),
    );
  }

  private async installTick(backendId: string, coderId: string, done: (ok: boolean) => void): Promise<void> {
    this.installTimers.delete(backendId);
    if (!this.alive) return done(false);
    const c = await this.client();
    if (!c) return done(false);
    try {
      const res = await c.request<{
        coder?: { installed?: boolean; job?: { phase: string; ok?: boolean; error?: string; manual?: string; finishedAt?: number } };
      }>("coders.status", { id: coderId }, { timeoutMs: 30_000 });
      const job = res?.coder?.job;
      if (job && !job.finishedAt) {
        this.installs = { ...this.installs, [backendId]: { phase: job.phase, running: true } };
        this.changed();
        this.scheduleInstallPoll(backendId, coderId, done);
        return;
      }
      const ok = job ? job.ok !== false : Boolean(res?.coder?.installed);
      this.installs = {
        ...this.installs,
        [backendId]: {
          phase: ok ? "done" : "failed",
          running: false,
          ok,
          error: ok ? undefined : (job?.error ?? "Install failed"),
          manual: ok ? undefined : job?.manual,
        },
      };
      this.changed();
      await this.load(true);
      if (ok) this.hooks.onInstalled?.(backendId);
      done(ok);
    } catch (err) {
      this.installs = { ...this.installs, [backendId]: { phase: "failed", running: false, ok: false, error: cliErrText(err) } };
      this.changed();
      done(false);
    }
  }
}
