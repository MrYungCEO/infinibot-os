/**
 * Beginner "Which of these do you already have?" setup: pick ChatGPT, Grok,
 * Google or Claude and InfiniBot does the rest as one visible checklist:
 *
 *   1. Getting <account> ready on this computer   coders.install (+ coders.status polling)
 *   2. Sign in with your <account> account         cliRouting.login (browser) + coders.login.poll
 *   3. Connecting InfiniBot                        cliRouting.connect (one real test turn)
 *
 * The runner turns the CliRoutingModel's raw state into a CliSetupView (steps,
 * progress, one plain line, exactly one primary action, nudges, errors with a
 * single fix). The onboarding brain step only renders that view.
 *
 * ?onbCliDemo=<state> renders a fixed state with fake data and makes no RPC
 * calls (states: pick, installing, signin, code, connecting, done,
 * error-limit, error-signin) for visual checks.
 *
 * Copy rules: plain sentences; never "API", "CLI", "token" or "provider".
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

import {
  openCliTerminal,
  signedIn,
  type CliConnectResult,
  type CliRoutingBackendView,
  type CliRoutingModel,
  type CliRoutingStatus,
} from "../controllers/cli-routing";

export type CliSetupStepId = "install" | "signin" | "connect";
export type CliStepState = "todo" | "active" | "done" | "skipped" | "error";
export type CliSetupPhase = "pick" | "installing" | "signin" | "connecting" | "done" | "error";
export type CliFixId = "retry" | "google" | "relogin" | "guide" | "apikey";
export type CliPrimaryId = CliFixId | "reopen" | "check" | "chat" | "busy" | "terminal" | "code";

export interface CliSetupError {
  code: string;
  message: string;
  details?: string;
  /** A command the user can run themselves instead (shown with a Copy button). */
  manual?: string;
  fix: { id: CliFixId; label: string };
}

export interface CliSetupView {
  phase: CliSetupPhase;
  backend: CliRoutingBackendView | null;
  steps: Array<{ id: CliSetupStepId; label: string; state: CliStepState; detail?: string }>;
  progress: number;
  /** What's happening right now, and why. */
  line: string;
  primary: { id: CliPrimaryId; label: string; busy?: boolean } | null;
  login: { url?: string; userCode?: string; needsCode: boolean; opened: boolean; submitting: boolean; error?: string | null } | null;
  nudge: { text: string; action: "reopen" | "relogin" } | null;
  error: CliSetupError | null;
  reply: string | null;
}

/** Beginner cards, in the owner's order. */
export const BEGINNER_CARDS: ReadonlyArray<{ id: string }> = [
  { id: "codex-cli" },
  { id: "grok-cli" },
  { id: "gemini-cli" },
  { id: "claude-cli" },
];

export const GOOGLE_ID = "gemini-cli";
const URL_NUDGE_MS = 10_000;
const SIGNIN_NUDGE_MS = 90_000;

/** "Google account" stays as is; "ChatGPT" → "ChatGPT account". */
export function accountNoun(account: string): string {
  return /account$/i.test(account) ? account : `${account} account`;
}

/**
 * The install error as one plain sentence + next step. The gateway already
 * words its errors that way; raw exit codes are never shown as the message.
 */
export function installFailureMessage(account: string, error?: string): string {
  const head = `We couldn't get ${account} ready on this computer.`;
  const e = (error ?? "").trim();
  if (!e || /\bexit(?: code)? -?\d+\)?$/i.test(e) && !/\. /.test(e)) return `${head} Click Try again.`;
  return `${head} ${e}`;
}

/** One plain line under a beginner card. */
export function cardSubtitle(b: CliRoutingBackendView): string {
  if (b.id === GOOGLE_ID) return "Gemini: API key or paid Google plan";
  if (b.free) return "Free";
  return b.plan;
}

export function cliDemoState(search: string = typeof location === "undefined" ? "" : location.search): string | null {
  try {
    return new URLSearchParams(search).get("onbCliDemo");
  } catch {
    return null;
  }
}

export class CliSetupRunner implements ReactiveController {
  backendId: string | null = null;
  phase: CliSetupPhase = "pick";
  error: CliSetupError | null = null;
  reply: string | null = null;
  showDetails = false;
  private installedAtStart = false;
  private signedInAtStart = false;
  private signinAt = 0;
  private run = 0;
  private tick: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly model: CliRoutingModel,
    readonly demo: string | null = null,
    private readonly hooks: {
      onConnected?: (b: CliRoutingBackendView, reply: string) => void;
      /** The account type is not allowed for this CLI: open the paste-an-API-key panel. */
      onUseApiKey?: (b: CliRoutingBackendView | null) => void;
    } = {},
  ) {
    host.addController(this);
    if (demo) this.applyDemo(demo);
  }

  hostDisconnected(): void {
    this.stopTick();
    if (this.backendId && this.phase === "signin") void this.model.cancelLogin(this.backendId);
  }

  get active(): boolean {
    return this.phase !== "pick";
  }

  private changed(): void {
    this.host.requestUpdate();
  }

  private startTick(): void {
    if (!this.tick) this.tick = setInterval(() => this.onTick(), 1000);
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  private onTick(): void {
    if (this.phase !== "signin" || !this.backendId) return this.stopTick();
    const s = this.model.logins[this.backendId]?.session;
    if (s && (s.status === "failed" || s.status === "expired" || s.status === "cancelled")) {
      const b = this.model.backend(this.backendId);
      this.fail({
        code: `signin_${s.status}`,
        message: s.status === "expired" ? "The sign-in took too long and timed out." : "The sign-in didn't finish.",
        details: s.error,
        fix: { id: "relogin", label: `${b?.signInLabel ?? "Sign in"} again` },
      });
      return;
    }
    this.changed();
  }

  private fail(e: CliSetupError): void {
    this.stopTick();
    this.phase = "error";
    this.error = e;
    this.showDetails = false;
    this.changed();
  }

  /** Back to the cards (cancels a sign-in in flight). */
  reset(): void {
    if (this.demo) return this.applyDemo("pick");
    this.run++;
    this.stopTick();
    if (this.backendId) void this.model.cancelLogin(this.backendId);
    this.phase = "pick";
    this.error = null;
    this.reply = null;
    this.changed();
  }

  /** Picking a card: install → sign in → connect, all automatic. */
  async start(id: string): Promise<void> {
    if (this.demo) {
      this.backendId = id;
      return this.applyDemo("installing");
    }
    const my = ++this.run;
    this.backendId = id;
    this.error = null;
    this.reply = null;
    let b = this.model.backend(id);
    if (!b) return;
    this.installedAtStart = b.installed;
    this.signedInAtStart = signedIn(b);
    if (!b.installed) {
      if (!b.coderId) {
        return this.fail({
          code: "install_unavailable",
          message: `InfiniBot can't set up ${b.account} on this computer by itself. The guide shows the one step to do it.`,
          fix: { id: "guide", label: "Open the guide" },
        });
      }
      this.phase = "installing";
      this.changed();
      const ok = await this.model.install(b);
      if (my !== this.run) return;
      if (!ok) {
        const job = this.model.installs[id];
        const message = installFailureMessage(b.account, job?.error);
        return this.fail({
          code: "install_failed",
          message,
          details: job?.error && !message.includes(job.error) ? job.error : undefined,
          manual: job?.manual,
          fix: { id: "retry", label: "Try again" },
        });
      }
      b = this.model.backend(id) ?? b;
    }
    // "unknown" sign-in: try connecting; a signed-out answer comes back as an error with "Sign in again".
    if (signedIn(b) || b.auth === "unknown") return this.connectStep(my);
    return this.signinStep(my);
  }

  private async signinStep(my = ++this.run): Promise<void> {
    const b = this.model.backend(this.backendId);
    if (!b) return;
    this.phase = "signin";
    this.error = null;
    this.signinAt = Date.now();
    this.startTick();
    this.changed();
    try {
      await this.model.login(b, { showTerminal: false });
    } catch (err) {
      if (my !== this.run) return;
      this.fail({
        code: "signin_start",
        message: `The ${b.account} sign-in couldn't start.`,
        details: String((err as Error)?.message ?? err),
        fix: { id: "relogin", label: "Try again" },
      });
    }
  }

  /** The model saw the account become signed in (browser poll or status watch). */
  onSignedIn(id: string): void {
    if (this.demo || id !== this.backendId || this.phase !== "signin") return;
    void this.connectStep(this.run);
  }

  private async connectStep(my: number): Promise<void> {
    const b = this.model.backend(this.backendId);
    if (!b) return;
    this.stopTick();
    this.phase = "connecting";
    this.changed();
    const res: CliConnectResult = await this.model.connect(b.id);
    if (my !== this.run) return;
    if (res.ok) {
      this.phase = "done";
      this.reply = res.reply?.trim() || "Hello! I'm ready.";
      this.changed();
      this.hooks.onConnected?.(b, this.reply);
      return;
    }
    this.fail(this.connectError(b, res));
  }

  private connectError(b: CliRoutingBackendView, res: Extract<CliConnectResult, { ok: false }>): CliSetupError {
    const details = `${res.code}${res.ms ? ` after ${Math.round(res.ms / 1000)} s` : ""}`;
    const google = b.id !== GOOGLE_ID && Boolean(this.model.backend(GOOGLE_ID));
    switch (res.code) {
      case "subscription_limit":
        return {
          code: res.code,
          message: res.message || `Your ${b.account} has hit its usage limit for now.`,
          details,
          fix: google ? { id: "google", label: "Use Gemini instead" } : { id: "retry", label: "Try again" },
        };
      case "subscription_signed_out":
        return { code: res.code, message: res.message || `You're signed out of ${b.account}.`, details, fix: { id: "relogin", label: `${b.signInLabel} again` } };
      case "subscription_unsupported":
        // Google ended Gemini CLI for free accounts: a Gemini API key is the way forward.
        return {
          code: res.code,
          message: res.message || `${b.account} can't be used this way any more.`,
          details,
          fix: b.id === GOOGLE_ID ? { id: "apikey", label: "Use a Gemini API key" } : { id: "retry", label: "Try again" },
        };
      default:
        return { code: res.code, message: res.message || "InfiniBot couldn't reach your account just now.", details, fix: { id: "retry", label: "Try again" } };
    }
  }

  /** The one fix button on an error. */
  fix(id: CliFixId): void {
    if (this.demo) return this.applyDemo(id === "relogin" ? "signin" : "connecting");
    const b = this.model.backend(this.backendId);
    if (id === "google") return void this.start(GOOGLE_ID);
    if (id === "apikey") {
      this.reset();
      this.hooks.onUseApiKey?.(b);
      return;
    }
    if (id === "relogin") return void this.signinStep();
    if (id === "guide" && b) {
      window.open(b.installUrl, "_blank");
      return;
    }
    if (this.backendId) void this.start(this.backendId);
  }

  /** Primary button while signing in. */
  primary(id: CliPrimaryId): void {
    if (this.demo) {
      if (id === "check" || id === "reopen") return this.applyDemo("connecting");
      return;
    }
    const bid = this.backendId;
    if (!bid) return;
    if (id === "reopen") {
      if (!this.model.reopenLogin(bid)) void this.signinStep();
      return;
    }
    if (id === "terminal") {
      const t = this.model.logins[bid]?.terminalId;
      if (t) openCliTerminal(t);
      return;
    }
    if (id === "check") void this.model.checkAgain();
  }

  nudge(action: "reopen" | "relogin"): void {
    if (this.demo) return;
    if (action === "reopen" && this.backendId && this.model.reopenLogin(this.backendId)) {
      this.signinAt = Date.now();
      this.changed();
      return;
    }
    void this.signinStep();
  }

  async submitCode(code: string): Promise<void> {
    if (this.demo) return this.applyDemo("connecting");
    if (this.backendId) await this.model.submitCode(this.backendId, code);
  }

  toggleDetails(): void {
    this.showDetails = !this.showDetails;
    this.changed();
  }

  // ── view ─────────────────────────────────────────────────────────────

  view(): CliSetupView {
    if (this.demo) return this.demoView();
    const b = this.model.backend(this.backendId);
    const login = this.backendId ? this.model.logins[this.backendId] : undefined;
    return buildView({
      phase: this.phase,
      backend: b,
      installedAtStart: this.installedAtStart,
      signedInAtStart: this.signedInAtStart,
      installPhase: this.backendId ? this.model.installs[this.backendId]?.phase : undefined,
      login: login
        ? {
            terminal: login.mode === "terminal",
            url: login.session?.url,
            userCode: login.session?.userCode,
            needsCode: Boolean(login.session?.needsCode),
            opened: login.opened,
            submitting: login.submitting,
            error: login.error,
            urlAt: login.urlAt,
          }
        : null,
      signinAt: this.signinAt,
      error: this.error,
      reply: this.reply,
      lastStepFailed: this.lastFailedStep(),
    });
  }

  private lastFailedStep(): CliSetupStepId | null {
    if (this.phase !== "error" || !this.error) return null;
    if (this.error.code.startsWith("install")) return "install";
    if (this.error.code.startsWith("signin") || this.error.code === "subscription_signed_out") return "signin";
    return "connect";
  }

  // ── demo ─────────────────────────────────────────────────────────────

  private demoPhase = "pick";

  private applyDemo(state: string): void {
    this.demoPhase = state;
    const map: Record<string, CliSetupPhase> = {
      pick: "pick",
      installing: "installing",
      signin: "signin",
      code: "signin",
      connecting: "connecting",
      done: "done",
      "error-limit": "error",
      "error-signin": "error",
      "error-unsupported": "error",
    };
    this.phase = map[state] ?? "pick";
    this.backendId = state === "error-unsupported" ? GOOGLE_ID : (this.backendId ?? "codex-cli");
    this.reply = state === "done" ? "Hi! I'm connected through your ChatGPT account and ready to help. What would you like to do first?" : null;
    this.error =
      state === "error-limit"
        ? {
            code: "subscription_limit",
            message: "Your ChatGPT plan has reached its usage limit. It resets in about 2 hours.",
            details: "subscription_limit after 4 s",
            fix: { id: "google", label: "Use Gemini instead" },
          }
        : state === "error-unsupported"
          ? {
              code: "subscription_unsupported",
              message:
                "Google no longer lets free Google accounts use Gemini CLI. Use a Gemini API key (free from aistudio.google.com/apikey) or a paid Google AI Pro/Ultra or Code Assist Standard account.",
              details: "subscription_unsupported after 5 s",
              fix: { id: "apikey", label: "Use a Gemini API key" },
            }
          : state === "error-signin"
          ? { code: "signin_failed", message: "The sign-in didn't finish.", details: "The sign-in window was closed.", fix: { id: "relogin", label: "Sign in with ChatGPT again" } }
          : null;
    this.host.requestUpdate();
  }

  private demoView(): CliSetupView {
    const st = demoStatus();
    const b = st.backends.find((x) => x.id === this.backendId) ?? st.backends[0]!;
    const s = this.demoPhase;
    return buildView({
      phase: this.phase,
      backend: b,
      installedAtStart: false,
      signedInAtStart: false,
      installPhase: s === "installing" ? "downloading" : "done",
      login:
        s === "signin" || s === "code"
          ? {
              terminal: false,
              url: "https://auth.openai.com/device",
              userCode: s === "signin" ? "WXYZ-1234" : undefined,
              needsCode: s === "code",
              opened: true,
              submitting: false,
              error: null,
              urlAt: Date.now(),
            }
          : null,
      signinAt: Date.now(),
      error: this.error,
      reply: this.reply,
      lastStepFailed: s === "error-limit" ? "connect" : s === "error-signin" ? "signin" : null,
    });
  }
}

interface BuildInput {
  phase: CliSetupPhase;
  backend: CliRoutingBackendView | null;
  installedAtStart: boolean;
  signedInAtStart: boolean;
  installPhase?: string;
  login: {
    terminal: boolean;
    url?: string;
    userCode?: string;
    needsCode: boolean;
    opened: boolean;
    submitting: boolean;
    error?: string | null;
    urlAt: number | null;
  } | null;
  signinAt: number;
  error: CliSetupError | null;
  reply: string | null;
  lastStepFailed: CliSetupStepId | null;
}

const INSTALL_WORDS: Record<string, string> = {
  queued: "Starting",
  checking: "Checking space on this computer",
  downloading: "Downloading",
  linking: "Finishing up",
  verifying: "Checking it works",
};

function buildView(i: BuildInput): CliSetupView {
  const b = i.backend;
  const acct = b ? b.account : "your account";
  const order: CliSetupStepId[] = ["install", "signin", "connect"];
  const at: Record<CliSetupPhase, number> = { pick: -1, installing: 0, signin: 1, connecting: 2, done: 3, error: -1 };
  const failedIdx = i.lastStepFailed ? order.indexOf(i.lastStepFailed) : -1;
  const cur = i.phase === "error" ? failedIdx : at[i.phase];
  const stateOf = (idx: number): CliStepState => {
    if (i.phase === "error" && idx === failedIdx) return "error";
    if (idx < cur || i.phase === "done") {
      if (idx === 0 && i.installedAtStart) return "skipped";
      if (idx === 1 && i.signedInAtStart) return "skipped";
      return "done";
    }
    return idx === cur ? "active" : "todo";
  };
  const steps: CliSetupView["steps"] = [
    {
      id: "install",
      label: `Getting ${acct} ready on this computer`,
      state: stateOf(0),
      detail: stateOf(0) === "skipped" ? "Already set up" : stateOf(0) === "active" ? `${INSTALL_WORDS[i.installPhase ?? ""] ?? "Working"}…` : undefined,
    },
    {
      id: "signin",
      label:
        stateOf(1) === "active"
          ? `Sign in with your ${accountNoun(acct)} in the window that just opened, then come back here`
          : `Sign in with your ${accountNoun(acct)}`,
      state: stateOf(1),
      detail: stateOf(1) === "skipped" ? "Already signed in" : undefined,
    },
    {
      id: "connect",
      label: "Connecting InfiniBot",
      state: stateOf(2),
      detail: stateOf(2) === "active" ? "Sending a quick test message. This can take up to a minute." : undefined,
    },
  ];
  const done = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const activeBonus = steps.some((s) => s.state === "active") ? 0.5 : 0;
  const progress = i.phase === "done" ? 1 : Math.min(0.97, (done + activeBonus) / steps.length);

  let line = "";
  let primary: CliSetupView["primary"] = null;
  let nudge: CliSetupView["nudge"] = null;
  const now = Date.now();
  switch (i.phase) {
    case "installing":
      line = `InfiniBot is adding the free ${acct} app to this computer so it can talk to your account. No admin password needed.`;
      primary = { id: "busy", label: "Getting ready…", busy: true };
      break;
    case "signin": {
      const l = i.login;
      if (l?.terminal) {
        line = `Open the sign-in window and follow the steps for your ${accountNoun(acct)}. InfiniBot moves on by itself when you're done.`;
        primary = { id: "terminal", label: "Open the sign-in window" };
      } else if (!l?.url) {
        line = `Opening the ${acct} sign-in page…`;
        primary = { id: "busy", label: "Opening the sign-in window…", busy: true };
        if (now - i.signinAt > URL_NUDGE_MS) nudge = { text: "Didn't see a sign-in window? Click here to open it again", action: "relogin" };
      } else if (!l.opened) {
        line = "Your browser stopped the sign-in window from opening. Click the button to open it.";
        primary = { id: "reopen", label: "Open the sign-in window" };
      } else if (l.needsCode) {
        line = `After you sign in, ${acct} shows a code. Paste it here so InfiniBot can finish.`;
        primary = { id: "code", label: l.submitting ? "Checking…" : "Finish sign-in", busy: l.submitting };
      } else {
        line = l.userCode
          ? `Enter the code below on the ${acct} page. InfiniBot notices when you're signed in and moves on by itself.`
          : `Finish signing in on the ${acct} page. InfiniBot notices when you're done and moves on by itself.`;
        primary = { id: "check", label: "I've signed in" };
      }
      if (l?.url && l.opened && l.urlAt && now - l.urlAt > SIGNIN_NUDGE_MS) {
        nudge = { text: "Didn't see a sign-in window? Click here to open it again", action: "reopen" };
      }
      break;
    }
    case "connecting":
      line = `Checking that InfiniBot can chat through your ${accountNoun(acct)}.`;
      primary = { id: "busy", label: "Connecting…", busy: true };
      break;
    case "done":
      line = `You're all set. InfiniBot now chats through your ${accountNoun(acct)}, so there's nothing extra to pay.`;
      primary = { id: "chat", label: "Start chatting" };
      break;
    case "error":
      line = i.error?.message ?? "Something went wrong.";
      primary = i.error ? { id: i.error.fix.id, label: i.error.fix.label } : null;
      break;
    default:
      break;
  }
  return {
    phase: i.phase,
    backend: b,
    steps,
    progress,
    line,
    primary,
    login: i.login && !i.login.terminal ? { url: i.login.url, userCode: i.login.userCode, needsCode: i.login.needsCode, opened: i.login.opened, submitting: i.login.submitting, error: i.login.error } : null,
    nudge,
    error: i.error,
    reply: i.reply,
  };
}

/** Fake status for ?onbCliDemo (no RPC calls). */
export function demoStatus(): CliRoutingStatus {
  const mk = (id: string, label: string, vendor: string, account: string, plan: string, extra: Partial<CliRoutingBackendView> = {}): CliRoutingBackendView => ({
    id,
    label,
    vendor,
    plan,
    command: id.replace(/-cli$/, ""),
    installed: false,
    auth: "signed-out",
    ready: false,
    localOnly: false,
    model: "default",
    inOrder: false,
    installUrl: "https://example.invalid/install",
    coderId: id,
    account,
    signInLabel: `Sign in with ${account === "Google account" ? "Google" : account}`,
    free: false,
    recommended: false,
    loginMode: "browser",
    ...extra,
  });
  return {
    available: true,
    enabled: false,
    providers: [],
    fallbackToApi: true,
    tools: true,
    active: null,
    backends: [
      mk("codex-cli", "Codex CLI", "OpenAI", "ChatGPT", "ChatGPT Plus, Pro or Business plan"),
      mk("grok-cli", "Grok Build", "xAI", "Grok", "SuperGrok or X Premium+ subscription"),
      mk("gemini-cli", "Gemini CLI", "Google", "Google account", "Google account", { free: false, recommended: true, installed: true, version: "0.9.0" }),
      mk("claude-cli", "Claude Code", "Anthropic", "Claude", "Claude Pro or Max subscription", { installed: true, auth: "signed-in", ready: true }),
    ],
    unsupported: [{ id: "antigravity", label: "Google Antigravity", reason: "It has no way for InfiniBot to send it messages yet." }],
    agents: [],
  };
}
