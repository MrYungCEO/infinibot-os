/**
 * <telegram-setup> — the guided Telegram setup, used everywhere a Telegram bot
 * is connected (Channels page, Comms Hub, setup wizard, cloud onboarding).
 *
 *   1 Create your bot   BotFather steps + token field (shape-checked as you type)
 *   2 Check the token   the gateway calls getMe; shows the bot or how to fix it
 *   3 Find you          t.me/<bot>?start=<code> link + QR; the gateway hears the
 *                       first message and reads your user id / chat id
 *   4 Test it           "✅ InfiniBot is connected" to the found chat
 *   5 Done              summary card: bot, owner, default chat; Edit / Disconnect
 *
 * The token is typed here once, sent to the gateway to verify, and dropped from
 * this element's state. Only a session id and a masked token come back.
 *
 * Events (bubbling, composed), detail { connected }:
 *   telegram-setup-ready    once, when the saved state has loaded
 *   telegram-setup-changed  after save / disconnect
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { checkTelegramTokenFormat } from "../../../../src/telegram/setup/token-format.js";
import type { GatewayBrowserClient } from "../gateway-client";
import {
  gatewayTelegramSetupBackend,
  type TelegramSetupBackend,
  type TgFound,
  type TgSession,
  type TgSetupAction,
  type TgSetupError,
  type TgSummary,
} from "./telegram-setup-backend";

type Step = "loading" | "summary" | "create" | "verify" | "find" | "test" | "done";
type FindTab = "dm" | "group";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "create", label: "Create bot" },
  { id: "verify", label: "Check token" },
  { id: "find", label: "Find you" },
  { id: "test", label: "Test" },
  { id: "done", label: "Done" },
];

const POLL_MS = 1500;
/** Survives the page being re-mounted while the gateway reloads (never holds the token). */
const PENDING_KEY = "infinibot.telegramSetup.pending";
const PENDING_MAX_MS = 3 * 60 * 1000;

function readPending(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    const p = JSON.parse(raw) as { sessionId?: string; at?: number };
    return p.sessionId && Date.now() - (p.at ?? 0) < PENDING_MAX_MS ? p.sessionId : null;
  } catch {
    return null;
  }
}
function writePending(sessionId: string | null) {
  try {
    if (sessionId) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId, at: Date.now() }));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode: the wizard just won't resume */
  }
}

const CHECK = html`<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path
    d="M3 8.5l3.2 3.2L13 4.8"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>`;


function who(found: TgFound | null | undefined): string {
  if (!found) return "";
  if (found.chatType !== "private") return found.chatTitle || "your group";
  if (found.username) return `@${found.username}`;
  return found.firstName || "you";
}

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

@customElement("telegram-setup")
export class TelegramSetup extends LitElement {
  /** Gateway client; falls back to the app's own client. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Custom data source (same actions as the gateway RPCs). */
  @property({ attribute: false }) backend: TelegramSetupBackend | null = null;
  /** Skip the summary card and open the steps even when a bot is saved. */
  @property({ type: Boolean }) fresh = false;

  @state() private step: Step = "loading";
  @state() private summary: TgSummary | null = null;
  @state() private session: TgSession | null = null;
  @state() private tokenInput = "";
  @state() private showToken = false;
  @state() private busy: string | null = null;
  @state() private error: TgSetupError | null = null;
  @state() private findTab: FindTab = "dm";
  @state() private qr: string | null = null;
  @state() private manualId = "";
  @state() private manualOpen = false;
  @state() private makeDefault = false;
  @state() private testResult: "sent" | null = null;
  @state() private confirmDisconnect = false;
  @state() private copied = false;
  @state() private now = Date.now();
  /** The gateway is switching Telegram on (first bot on this install: a short reload). */
  @state() private starting = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadSummary();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
    // Leaving the page stops the gateway listening for this setup.
    if (this.session?.capture?.status === "waiting") {
      void this.api("capture.cancel", { sessionId: this.session.sessionId });
    }
  }

  // ── data ─────────────────────────────────────────────────────────────────

  private api<T>(action: TgSetupAction, params?: Record<string, unknown>) {
    const backend = this.backend ?? gatewayTelegramSetupBackend(this.client);
    return backend.call<T>(action, params);
  }

  private async run<T>(
    label: string,
    action: TgSetupAction,
    params?: Record<string, unknown>,
  ): Promise<({ ok: true } & T) | null> {
    if (this.busy) return null;
    this.busy = label;
    this.error = null;
    try {
      const res = await this.api<T>(action, params);
      if (!res.ok) {
        this.error = res.error;
        return null;
      }
      return res;
    } finally {
      this.busy = null;
    }
  }

  private async loadSummary() {
    const res = await this.api<TgSummary>("summary");
    if (!res.ok) {
      this.error = res.error;
      this.step = "create";
      return;
    }
    this.summary = res;
    this.step = res.connected && !this.fresh ? "summary" : "create";
    this.changed("telegram-setup-ready");
    void this.resumeAfterReload();
  }

  /**
   * The first bot on an install makes InfiniBot reload, which re-mounts this
   * page mid-setup. Pick the wizard back up at "Test" instead of dropping it.
   */
  private async resumeAfterReload() {
    const sessionId = readPending();
    if (!sessionId) return;
    const res = await this.api<TgSession>("capture.status", { sessionId });
    if (!res.ok || !res.owner) return;
    this.session = res;
    this.testResult = null;
    this.step = "test";
    await this.waitUntilRunning();
    this.changed();
  }

  private changed(name = "telegram-setup-changed") {
    this.dispatchEvent(
      new CustomEvent(name, {
        detail: { connected: Boolean(this.summary?.connected) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async verify(useSaved: boolean) {
    const params = useSaved ? { useSaved: true } : { token: this.tokenInput };
    const res = await this.run<TgSession>("verify", "verify", params);
    if (!res) return;
    // The token has done its job; don't keep it in the page.
    this.tokenInput = "";
    this.showToken = false;
    this.session = res;
    this.step = "verify";
  }

  private async removeWebhook() {
    if (!this.session) return;
    const res = await this.run<TgSession>("webhook", "deleteWebhook", {
      sessionId: this.session.sessionId,
    });
    if (!res) return;
    this.session = res;
    if (this.step === "find") void this.startCapture(this.findTab);
  }

  private async startCapture(mode: FindTab) {
    if (!this.session) return;
    this.findTab = mode;
    this.stopPolling();
    const res = await this.run<TgSession>("capture", "capture.start", {
      sessionId: this.session.sessionId,
      mode,
    });
    if (!res) {
      this.session = { ...this.session, capture: null };
      return;
    }
    this.session = res;
    this.qr = res.qr ?? null;
    this.startPolling();
  }

  private startPolling() {
    this.stopPolling();
    this.now = Date.now();
    this.tickTimer = setInterval(() => (this.now = Date.now()), 1000);
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.pollTimer = this.tickTimer = null;
  }

  private async pollOnce() {
    const session = this.session;
    if (!session || session.capture?.status !== "waiting") return this.stopPolling();
    const res = await this.api<TgSession>("capture.status", { sessionId: session.sessionId });
    if (this.session?.sessionId !== session.sessionId) return;
    if (!res.ok) {
      this.stopPolling();
      this.error = res.error;
      return;
    }
    this.session = res;
    if (res.capture?.status !== "waiting") this.stopPolling();
  }

  private async useManual() {
    if (!this.session) return;
    const res = await this.run<TgSession>("manual", "manual", {
      sessionId: this.session.sessionId,
      mode: this.findTab,
      id: this.manualId,
    });
    if (!res) return;
    this.stopPolling();
    this.session = res;
    this.manualId = "";
  }

  private async confirm() {
    if (!this.session) return;
    const mode = this.session.capture?.mode ?? "dm";
    if (mode === "dm") writePending(this.session.sessionId);
    const res = await this.run<
      TgSession & { summary: TgSummary; starting?: "live" | "reload" | "saved" }
    >("confirm", "confirm", {
      sessionId: this.session.sessionId,
      makeDefault: mode === "group" && this.makeDefault,
    });
    if (!res) return writePending(null);
    this.session = res;
    this.summary = res.summary;
    this.testResult = null;
    this.step = mode === "group" ? "done" : "test";
    if (res.starting !== "saved") await this.waitUntilRunning();
    if (this.isConnected) writePending(null);
    this.changed();
  }

  /**
   * After saving, wait for the bot to come online. Usually instant; the first
   * Telegram bot on an install makes InfiniBot reload itself for a few seconds
   * (this page's connection drops and comes back), so errors here just mean
   * "not back yet".
   */
  private async waitUntilRunning() {
    this.starting = true;
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const res = await this.api<TgSummary>("summary").catch(() => null);
        if (res?.ok) {
          this.summary = res;
          if (res.running) return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      this.starting = false;
    }
  }

  private async sendTest(chatId?: string) {
    const res = await this.run<{ chatId: string }>("test", "test", {
      sessionId: this.session?.sessionId ?? "",
      ...(chatId ? { chatId } : {}),
    });
    if (res) this.testResult = "sent";
  }

  /** Summary card actions need a session: open one on the saved bot. */
  private async openSaved(then: "find-dm" | "find-group") {
    const res = await this.run<TgSession>("verify", "verify", { useSaved: true });
    if (!res) return;
    this.session = res;
    this.step = "find";
    void this.startCapture(then === "find-group" ? "group" : "dm");
  }

  private testFromSummary() {
    this.testResult = null;
    this.step = "test";
    void this.sendTest(this.summary?.defaultChatId ?? undefined);
  }

  private async disconnect() {
    const res = await this.run<TgSummary>("disconnect", "disconnect", {
      sessionId: this.session?.sessionId ?? "",
    });
    if (!res) return;
    this.confirmDisconnect = false;
    this.session = null;
    this.summary = res;
    this.step = "create";
    this.changed();
  }

  private async copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1600);
    } catch {
      /* clipboard blocked: the code is on screen to type */
    }
  }

  private goFind() {
    this.error = null;
    this.step = "find";
    void this.startCapture("dm");
  }

  private restart() {
    this.stopPolling();
    if (this.session?.capture?.status === "waiting") {
      void this.api("capture.cancel", { sessionId: this.session.sessionId });
    }
    this.session = null;
    this.error = null;
    this.step = "create";
  }

  // ── render ───────────────────────────────────────────────────────────────

  render() {
    if (this.step === "loading") {
      return html`<div class="tgs"><div class="quiet">Checking Telegram…</div></div>`;
    }
    if (this.step === "summary") return html`<div class="tgs">${this.renderSummary(false)}</div>`;
    return html`
      <div class="tgs">
        ${this.renderStepper()}
        <div class="body" aria-live="polite">
          ${this.step === "create" ? this.renderCreate() : nothing}
          ${this.step === "verify" ? this.renderVerify() : nothing}
          ${this.step === "find" ? this.renderFind() : nothing}
          ${this.step === "test" ? this.renderTest() : nothing}
          ${this.step === "done" ? this.renderSummary(true) : nothing}
        </div>
      </div>
    `;
  }

  private renderStepper() {
    const index = STEPS.findIndex((s) => s.id === this.step);
    return html`
      <ol class="stepper" aria-label="Telegram setup progress">
        ${STEPS.map(
          (s, i) => html`
            <li
              class=${i < index ? "is-done" : i === index ? "is-now" : ""}
              aria-current=${i === index ? "step" : "false"}
            >
              <span class="num">${i < index ? CHECK : i + 1}</span>
              <span class="lbl">${s.label}</span>
            </li>
          `,
        )}
      </ol>
      <div class="stepper-mini">Step ${index + 1} of ${STEPS.length} · ${STEPS[index]?.label}</div>
    `;
  }

  private renderError(extra?: TemplateResult | typeof nothing) {
    const e = this.error;
    if (!e) return nothing;
    return html`
      <div class="alert" role="alert" data-code=${e.code}>
        <div class="alert-title">${e.title}</div>
        <div class="alert-msg">${e.message}</div>
        <div class="alert-fix"><b>What to do:</b> ${e.fix}</div>
        ${e.action === "deleteWebhook" && this.session
          ? html`<div class="row">
              <button
                class="btn gold"
                ?disabled=${Boolean(this.busy)}
                @click=${() => this.removeWebhook()}
              >
                ${this.busy === "webhook" ? "Disconnecting…" : "Disconnect the other app"}
              </button>
            </div>`
          : nothing}
        ${extra ?? nothing}
      </div>
    `;
  }

  private renderCreate() {
    const typed = this.tokenInput.trim();
    const format = typed ? checkTelegramTokenFormat(typed) : null;
    const saved = this.summary?.connected;
    return html`
      <h3>Create your Telegram bot</h3>
      <p class="lead">
        Your assistant talks to you through its own Telegram bot. Making one is free and takes
        about a minute.
      </p>

      <div class="split">
        <ol class="howto">
          <li>
            <span>Open <b>BotFather</b>, Telegram's official bot for making bots.</span>
            <a
              class="btn gold"
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              data-tgs="botfather"
              >Open BotFather</a
            >
          </li>
          <li><span>Send it <code>/newbot</code></span></li>
          <li><span>Type a <b>name</b> for your bot. Anything works, like “My Assistant”.</span></li>
          <li>
            <span
              >Type a <b>username</b> that ends in <code>bot</code>, like
              <code>my_helper_bot</code>. If it's taken, try another.</span
            >
          </li>
          <li>
            <span
              >BotFather replies with a long line of numbers and letters. That's your
              <b>token</b>. Tap it to copy.</span
            >
          </li>
        </ol>

        <div class="hint" aria-hidden="true">
          <div class="hint-cap">What you'll see in Telegram</div>
          <div class="bubble me">/newbot</div>
          <div class="bubble">Alright, a new bot. How are we going to call it?</div>
          <div class="bubble me">My Assistant</div>
          <div class="bubble">
            Done! Use this token to access the HTTP API:
            <span class="tok">123456789:AAHdqTcvCH1vGWJxfSeo…</span>
          </div>
        </div>
      </div>

      <label class="field">
        <span class="field-label">Paste your bot token here</span>
        <div class="input-wrap">
          <input
            data-tgs="token"
            .type=${this.showToken ? "text" : "password"}
            .value=${this.tokenInput}
            placeholder="123456789:AAH…"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            @input=${(e: Event) => {
              this.tokenInput = (e.target as HTMLInputElement).value;
              this.error = null;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && format?.ok) void this.verify(false);
            }}
          />
          <button
            type="button"
            class="ghost-in"
            @click=${() => (this.showToken = !this.showToken)}
            aria-label=${this.showToken ? "Hide token" : "Show token"}
          >
            ${this.showToken ? "Hide" : "Show"}
          </button>
        </div>
        ${format && !format.ok
          ? html`<span class="field-msg bad" data-tgs="format-error">${format.message}</span>`
          : format?.ok
            ? html`<span class="field-msg good">Looks like a bot token. Press “Check my token”.</span>`
            : html`<span class="field-msg"
                >It's only sent to your InfiniBot to check it. Keep it private, like a password.</span
              >`}
      </label>

      ${this.renderError()}

      <div class="row">
        <button
          class="btn gold"
          data-tgs="verify"
          ?disabled=${!format?.ok || Boolean(this.busy)}
          @click=${() => this.verify(false)}
        >
          ${this.busy === "verify" ? "Checking with Telegram…" : "Check my token"}
        </button>
        ${saved
          ? html`<button class="btn" ?disabled=${Boolean(this.busy)} @click=${() => this.verify(true)}>
                Use the bot that's already saved
              </button>
              <button class="btn link" @click=${() => (this.step = "summary")}>Cancel</button>`
          : nothing}
      </div>
    `;
  }

  private renderBotCard(session: TgSession) {
    const bot = session.bot;
    const initial = (bot.name || bot.username || "B").slice(0, 1).toUpperCase();
    return html`
      <div class="botcard" data-tgs="botcard">
        ${bot.avatar
          ? html`<img class="avatar" src=${bot.avatar} alt="" />`
          : html`<div class="avatar mono">${initial}</div>`}
        <div class="botmeta">
          <div class="botname">${bot.name ?? "Your bot"}</div>
          <div class="botuser">${bot.username ? `@${bot.username}` : ""}</div>
          <div class="bottoken">Token ${session.tokenMasked}</div>
        </div>
        <span class="pill ok">${CHECK} Token works</span>
      </div>
    `;
  }

  private renderVerify() {
    const session = this.session;
    if (!session) return nothing;
    return html`
      <h3>Is this your bot?</h3>
      <p class="lead">Telegram recognised the token. Check it's the bot you just made.</p>
      ${this.renderBotCard(session)}
      ${session.webhookHost
        ? html`<div class="alert warn" data-code="webhook_active">
            <div class="alert-title">This bot is connected to another app</div>
            <div class="alert-msg">
              Telegram is sending this bot's messages to <b>${session.webhookHost}</b>. A bot can
              only talk to one app at a time.
            </div>
            <div class="alert-fix">
              <b>What to do:</b> if you're moving this bot to InfiniBot, disconnect the other app.
              It will stop getting this bot's messages. Otherwise go back and make a new bot.
            </div>
            <div class="row">
              <button
                class="btn gold"
                data-tgs="delete-webhook"
                ?disabled=${Boolean(this.busy)}
                @click=${() => this.removeWebhook()}
              >
                ${this.busy === "webhook" ? "Disconnecting…" : "Disconnect the other app"}
              </button>
            </div>
          </div>`
        : nothing}
      ${this.renderError()}
      <div class="row">
        <button
          class="btn gold"
          data-tgs="continue"
          ?disabled=${Boolean(session.webhookHost) || Boolean(this.busy)}
          @click=${() => this.goFind()}
        >
          Yes, continue
        </button>
        <button class="btn" @click=${() => this.restart()}>Use a different token</button>
      </div>
    `;
  }

  private renderFind() {
    const session = this.session;
    if (!session) return nothing;
    const capture = session.capture;
    const tab = this.findTab;
    const bot = session.bot.username ? `@${session.bot.username}` : "your bot";
    return html`
      <h3>${tab === "dm" ? "Let InfiniBot find you" : "Add your bot to a group"}</h3>
      <p class="lead">
        ${tab === "dm"
          ? "Your assistant should only answer you. Send your bot one message and InfiniBot will read your Telegram ID from it. No typing numbers."
          : "Want your assistant in a group chat too? Add the bot to the group and InfiniBot will read the group's ID."}
      </p>

      <div class="tabs" role="tablist">
        <button
          role="tab"
          aria-selected=${tab === "dm"}
          class=${tab === "dm" ? "on" : ""}
          @click=${() => tab !== "dm" && this.startCapture("dm")}
        >
          Just me
        </button>
        <button
          role="tab"
          data-tgs="tab-group"
          aria-selected=${tab === "group"}
          class=${tab === "group" ? "on" : ""}
          @click=${() => tab !== "group" && this.startCapture("group")}
        >
          A group
        </button>
      </div>

      ${capture?.status === "found" && capture.found
        ? this.renderFound(capture.found, capture.mode)
        : capture?.status === "waiting"
          ? this.renderWaiting(session, bot)
          : capture?.status === "expired"
            ? html`<div class="alert warn">
                <div class="alert-title">That took a little too long</div>
                <div class="alert-msg">
                  For safety InfiniBot only listens for 5 minutes. Nothing was saved.
                </div>
                <div class="row">
                  <button class="btn gold" @click=${() => this.startCapture(tab)}>Try again</button>
                </div>
              </div>`
            : capture?.status === "error" && capture.error
              ? html`<div class="alert" role="alert" data-code=${capture.error.code}>
                  <div class="alert-title">${capture.error.title}</div>
                  <div class="alert-msg">${capture.error.message}</div>
                  <div class="alert-fix"><b>What to do:</b> ${capture.error.fix}</div>
                  <div class="row">
                    ${capture.error.action === "deleteWebhook"
                      ? html`<button class="btn gold" @click=${() => this.removeWebhook()}>
                          Disconnect the other app
                        </button>`
                      : html`<button class="btn gold" @click=${() => this.startCapture(tab)}>
                          Try again
                        </button>`}
                  </div>
                </div>`
              : this.error
                ? this.renderError(
                    this.error.action !== "deleteWebhook"
                      ? html`<div class="row">
                          <button class="btn gold" @click=${() => this.startCapture(tab)}>
                            Try again
                          </button>
                        </div>`
                      : nothing,
                  )
                : html`<div class="quiet">Getting your link ready…</div>`}
      ${capture?.status === "found" ? nothing : this.renderManual()}

      <div class="row foot">
        <button class="btn link" @click=${() => this.restart()}>Start over</button>
        ${session.owner && tab === "group"
          ? html`<button class="btn link" @click=${() => (this.stopPolling(), (this.step = "done"))}>
              Skip the group
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderWaiting(session: TgSession, bot: string) {
    const capture = session.capture;
    if (!capture) return nothing;
    const left = capture.expiresAt - this.now;
    const group = capture.mode === "group";
    return html`
      <div class="find">
        <div class="find-main">
          <ol class="howto tight">
            ${group
              ? html`<li><span>Tap the button and pick the group to add ${bot} to.</span></li>
                  <li>
                    <span
                      >Telegram posts a start message in the group for you. If nothing appears,
                      send <code>/start@${session.bot.username ?? "yourbot"} ${capture.code}</code>
                      in the group.</span
                    >
                  </li>`
              : html`<li><span>Tap the button to open ${bot} in Telegram.</span></li>
                  <li><span>Press <b>Start</b> at the bottom of the chat.</span></li>`}
          </ol>
          ${capture.deepLink
            ? html`<a
                class="btn gold big"
                data-tgs="deeplink"
                href=${capture.deepLink}
                target="_blank"
                rel="noopener noreferrer"
                >${group ? "Add bot to a group" : `Open ${bot} in Telegram`}</a
              >`
            : nothing}
          <div class="code-row">
            <span
              >${group ? "The code for this group:" : "Already chatting with it? Send it this code:"}</span
            >
            <button
              class="code"
              data-tgs="code"
              title="Copy"
              @click=${() => this.copyCode(capture.code)}
            >
              ${capture.code}
            </button>
            <span class="copied">${this.copied ? "Copied" : ""}</span>
          </div>
          <div class="waiting" data-tgs="waiting">
            <span class="spinner" aria-hidden="true"></span>
            <span>Waiting for your message… <b>${clock(left)}</b> left</span>
          </div>
          ${capture.otherMessages > 0
            ? html`<div class="note" data-tgs="other-messages">
                The bot got a message, but it didn't include your code, so it was ignored. Tap the
                button above again, or send the code <b>${capture.code}</b>.
              </div>`
            : nothing}
          ${group ? this.renderPrivacy(session) : nothing}
        </div>
        ${this.qr
          ? html`<div class="qr">
              <img src=${this.qr} alt="QR code that opens your bot in Telegram" data-tgs="qr" />
              <div class="qr-cap">Telegram on your phone? Scan this with the camera.</div>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderPrivacy(session: TgSession) {
    const sees = session.bot.canReadAllGroupMessages === true;
    return html`
      <details class="more" ?open=${false}>
        <summary>The bot doesn't see messages in the group?</summary>
        <div class="more-body">
          ${sees
            ? html`<p>This bot can read all group messages, so that part is fine.</p>`
            : html`<p>
                Telegram bots start in <b>privacy mode</b>: in a group they only see messages that
                start with <code>/</code> or mention the bot by name. That's why the start message
                works but ordinary chat doesn't.
              </p>`}
          <p>To let your assistant read everything in the group:</p>
          <ol>
            <li>Open <b>@BotFather</b> and send <code>/setprivacy</code></li>
            <li>Pick your bot, then choose <b>Disable</b></li>
            <li>Remove the bot from the group and add it again (Telegram needs this to apply it)</li>
          </ol>
          <p>Or leave privacy on and just mention the bot when you want it.</p>
        </div>
      </details>
    `;
  }

  private renderManual() {
    const dm = this.findTab === "dm";
    return html`
      <details
        class="more"
        ?open=${this.manualOpen}
        @toggle=${(e: Event) => (this.manualOpen = (e.target as HTMLDetailsElement).open)}
      >
        <summary data-tgs="manual-toggle">Can't use the link? Enter the ID by hand</summary>
        <div class="more-body">
          ${dm
            ? html`<ol>
                <li>In Telegram, search for <b>@userinfobot</b> and press Start.</li>
                <li>It replies with your <b>Id</b>, a number like <code>123456789</code>.</li>
                <li>
                  Also press Start in your own bot once, so it's allowed to message you. Then paste
                  the number here.
                </li>
              </ol>`
            : html`<ol>
                <li>Add your bot to the group.</li>
                <li>
                  Add <b>@userinfobot</b> to the group too. It posts the group's ID, a number that
                  starts with a minus like <code>-1001234567890</code>.
                </li>
                <li>Paste it here (keep the minus), then remove @userinfobot.</li>
              </ol>`}
          <div class="row">
            <input
              class="plain"
              data-tgs="manual-id"
              inputmode="numeric"
              placeholder=${dm ? "123456789" : "-1001234567890"}
              .value=${this.manualId}
              @input=${(e: Event) => (this.manualId = (e.target as HTMLInputElement).value)}
            />
            <button
              class="btn"
              data-tgs="manual-use"
              ?disabled=${!this.manualId.trim() || Boolean(this.busy)}
              @click=${() => this.useManual()}
            >
              ${this.busy === "manual" ? "Checking…" : "Use this ID"}
            </button>
          </div>
          ${this.error && this.session?.capture?.status === "waiting" ? this.renderError() : nothing}
        </div>
      </details>
    `;
  }

  private renderFound(found: TgFound, mode: FindTab) {
    const group = mode === "group";
    return html`
      <div class="found" data-tgs="found">
        <div class="found-badge">${CHECK}</div>
        <div class="found-text">
          <div class="found-title">
            ${group ? "Found your group: " : "Found you: "}<b>${who(found)}</b>
          </div>
          <div class="found-sub">
            ${group
              ? html`Group ID <code>${found.chatId}</code>`
              : html`${found.firstName ? `${found.firstName} · ` : ""}User ID
                  <code>${found.userId}</code>`}
          </div>
        </div>
      </div>
      <p class="lead small">
        ${group
          ? "Confirm to let your assistant work in this group."
          : "Confirm to make this account the owner. Only you will be able to talk to your assistant, and its reports will come to this chat."}
      </p>
      ${group && this.session?.owner
        ? html`<label class="check">
            <input
              type="checkbox"
              .checked=${this.makeDefault}
              @change=${(e: Event) => (this.makeDefault = (e.target as HTMLInputElement).checked)}
            />
            <span>Send reports and alerts to this group instead of my private chat</span>
          </label>`
        : nothing}
      ${this.renderError()}
      <div class="row">
        <button
          class="btn gold"
          data-tgs="confirm"
          ?disabled=${Boolean(this.busy)}
          @click=${() => this.confirm()}
        >
          ${this.busy === "confirm" ? "Saving…" : group ? "Confirm group" : "Yes, that's me"}
        </button>
        <button class="btn" ?disabled=${Boolean(this.busy)} @click=${() => this.startCapture(mode)}>
          ${group ? "Not this group" : "That's not me"}
        </button>
      </div>
    `;
  }

  private renderTest() {
    const sent = this.testResult === "sent";
    return html`
      <h3>Send a test message</h3>
      <p class="lead">
        Let's make sure your bot can reach you. InfiniBot will send
        <b>“✅ InfiniBot is connected”</b> to your Telegram.
      </p>
      ${this.starting
        ? html`<div class="waiting" data-tgs="starting">
            <span class="spinner" aria-hidden="true"></span>
            <span>Saved. Switching your bot on… this takes a few seconds.</span>
          </div>`
        : nothing}
      ${sent
        ? html`<div class="found" data-tgs="test-ok">
            <div class="found-badge">${CHECK}</div>
            <div class="found-text">
              <div class="found-title">Sent. Check Telegram.</div>
              <div class="found-sub">You should see “✅ InfiniBot is connected” from your bot.</div>
            </div>
          </div>`
        : nothing}
      ${this.renderError()}
      <div class="row">
        ${sent
          ? html`<button class="btn gold" data-tgs="finish" @click=${() => (this.step = "done")}>
                I got it, finish
              </button>
              <button class="btn" ?disabled=${Boolean(this.busy)} @click=${() => this.sendTest()}>
                Send again
              </button>`
          : html`<button
                class="btn gold"
                data-tgs="send-test"
                ?disabled=${Boolean(this.busy) || this.starting}
                @click=${() => this.sendTest()}
              >
                ${this.busy === "test" ? "Sending…" : "Send test message"}
              </button>
              <button class="btn link" @click=${() => (this.step = "done")}>Skip</button>`}
      </div>
    `;
  }

  private renderSummary(justFinished: boolean) {
    const s = this.summary;
    if (!s) return nothing;
    const session = this.session;
    const botUser = session?.bot.username ?? s.bot?.username ?? null;
    const botName = session?.bot.name ?? s.bot?.name ?? null;
    const ownerName = session?.owner ? who(session.owner) : null;
    const groupNames = new Map(
      (session?.groups ?? []).map((g) => [String(g.chatId), g.chatTitle ?? ""]),
    );
    return html`
      ${justFinished
        ? html`<h3>You're all set</h3>
            <p class="lead">
              ${s.note
                ? "Your bot is saved."
                : "Telegram is connected and running. Open your bot and say hello: your assistant will answer."}
            </p>`
        : nothing}
      <div class="summary" data-tgs="summary">
        <div class="sum-head">
          ${session?.bot.avatar
            ? html`<img class="avatar" src=${session.bot.avatar} alt="" />`
            : html`<div class="avatar mono">${(botName || botUser || "T").slice(0, 1).toUpperCase()}</div>`}
          <div class="botmeta">
            <div class="botname">${botName ?? "Telegram bot"}</div>
            <div class="botuser">${botUser ? `@${botUser}` : "Connected"}</div>
          </div>
          <span class="pill ${s.running ? "ok" : "idle"}" data-tgs="status">
            ${s.running
              ? html`${CHECK} Running`
              : this.starting
                ? "Starting…"
                : s.note
                  ? "Saved"
                  : "Saved, not running"}
          </span>
        </div>
        <dl>
          <div>
            <dt>Bot token</dt>
            <dd><code>${s.tokenMasked ?? "—"}</code></dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>
              ${s.owners.length
                ? html`${ownerName ? html`${ownerName} · ` : nothing}ID
                    <code>${s.owners.join(", ")}</code>`
                : html`<span class="warn-text">Not set yet. Anyone who finds the bot has to be approved first.</span>`}
            </dd>
          </div>
          <div>
            <dt>Reports go to</dt>
            <dd>
              ${s.defaultChatId
                ? html`<code>${s.defaultChatId}</code>
                    ${s.defaultChatId.startsWith("-") ? "(group)" : "(your private chat)"}`
                : html`<span class="warn-text">Not set yet</span>`}
            </dd>
          </div>
          <div>
            <dt>Groups</dt>
            <dd>
              ${s.groups.length
                ? s.groups.map(
                    (g) => html`<span class="chip"
                      >${groupNames.get(g) ? `${groupNames.get(g)} · ` : ""}<code>${g}</code></span
                    >`,
                  )
                : "None"}
            </dd>
          </div>
        </dl>
        ${s.note ? html`<div class="note" data-tgs="note">${s.note}</div>` : nothing}
        ${s.lastError && !s.running && !s.note
          ? html`<div class="note bad">Last problem: ${s.lastError}</div>`
          : nothing}
        ${this.renderError()}
        ${this.confirmDisconnect
          ? html`<div class="alert warn">
              <div class="alert-title">Disconnect Telegram?</div>
              <div class="alert-msg">
                Your assistant will stop answering on Telegram and the saved token is removed. The
                bot itself stays in BotFather, so you can connect it again later.
              </div>
              <div class="row">
                <button
                  class="btn danger"
                  data-tgs="disconnect-yes"
                  ?disabled=${Boolean(this.busy)}
                  @click=${() => this.disconnect()}
                >
                  ${this.busy === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
                </button>
                <button class="btn" @click=${() => (this.confirmDisconnect = false)}>Keep it</button>
              </div>
            </div>`
          : html`<div class="row">
              <button
                class="btn"
                data-tgs="edit"
                ?disabled=${Boolean(this.busy)}
                @click=${() => this.openSaved("find-dm")}
              >
                ${s.owners.length ? "Change owner" : "Find my ID"}
              </button>
              <button
                class="btn"
                data-tgs="add-group"
                ?disabled=${Boolean(this.busy)}
                @click=${() => this.openSaved("find-group")}
              >
                Add a group
              </button>
              <button
                class="btn"
                ?disabled=${Boolean(this.busy) || !s.defaultChatId}
                @click=${() => this.testFromSummary()}
              >
                Send test message
              </button>
              <button class="btn" data-tgs="new-token" @click=${() => this.restart()}>
                Use a different bot
              </button>
              <button
                class="btn link danger-text"
                data-tgs="disconnect"
                @click=${() => (this.confirmDisconnect = true)}
              >
                Disconnect
              </button>
            </div>`}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      /* Layout follows the wizard's own width (it often sits in a narrow card). */
      container-type: inline-size;
      --tgs-gold: var(--accent, #d4af37);
      --tgs-gold-2: var(--accent-hover, #fdb931);
      --tgs-bg: var(--card, #0f0f0f);
      --tgs-bg-2: var(--bg-elevated, #111111);
      --tgs-line: var(--border, #27272a);
      --tgs-text: var(--text, #e4e4e7);
      --tgs-strong: var(--text-strong, #ffffff);
      --tgs-muted: var(--muted, #a1a1aa);
      --tgs-ok: var(--ok, #22c55e);
      --tgs-danger: var(--danger, #ef4444);
      --tgs-warn: var(--warn, #f59e0b);
      color: var(--tgs-text);
      font-size: 14px;
      line-height: 1.5;
      text-align: left;
    }
    * {
      box-sizing: border-box;
    }
    .tgs {
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--tgs-gold) 5%, var(--tgs-bg)),
        var(--tgs-bg) 140px
      );
      border: 1px solid color-mix(in srgb, var(--tgs-gold) 28%, var(--tgs-line));
      border-radius: 14px;
      padding: 18px;
      min-width: 0;
    }
    h3 {
      margin: 0 0 4px;
      font-size: 18px;
      font-weight: 650;
      color: var(--tgs-strong);
      letter-spacing: -0.01em;
    }
    .lead {
      margin: 0 0 14px;
      color: var(--tgs-muted);
      max-width: 62ch;
    }
    .lead.small {
      margin-top: 12px;
    }
    .quiet {
      color: var(--tgs-muted);
      padding: 8px 0;
    }
    code {
      font-family: var(--font-mono, "JetBrains Mono", ui-monospace, monospace);
      font-size: 0.92em;
      background: color-mix(in srgb, var(--tgs-gold) 12%, transparent);
      color: var(--tgs-gold-2);
      padding: 1px 6px;
      border-radius: 5px;
      overflow-wrap: anywhere;
    }

    /* stepper */
    .stepper {
      list-style: none;
      display: flex;
      gap: 6px;
      padding: 0;
      margin: 0 0 16px;
    }
    .stepper li {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding-bottom: 10px;
      border-bottom: 2px solid var(--tgs-line);
      color: var(--tgs-muted);
      font-size: 12.5px;
    }
    .stepper .num {
      flex: none;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      border: 1px solid var(--tgs-line);
      font-size: 11.5px;
      font-weight: 600;
    }
    .stepper .num svg {
      width: 12px;
      height: 12px;
    }
    .stepper .lbl {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .stepper li.is-now {
      color: var(--tgs-strong);
      border-bottom-color: var(--tgs-gold);
    }
    .stepper li.is-now .num {
      background: var(--tgs-gold);
      border-color: var(--tgs-gold);
      color: #000;
    }
    .stepper li.is-done {
      border-bottom-color: color-mix(in srgb, var(--tgs-gold) 55%, transparent);
    }
    .stepper li.is-done .num {
      border-color: var(--tgs-gold);
      color: var(--tgs-gold);
    }
    .stepper-mini {
      display: none;
      font-size: 12px;
      color: var(--tgs-gold);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    /* how-to list */
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
      margin-bottom: 16px;
    }
    .howto {
      list-style: none;
      counter-reset: n;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .howto li {
      counter-increment: n;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .howto li::before {
      content: counter(n);
      width: 24px;
      height: 24px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 650;
      color: var(--tgs-gold);
      background: color-mix(in srgb, var(--tgs-gold) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--tgs-gold) 30%, transparent);
    }
    .howto li > * {
      grid-column: 2;
    }
    .howto li > .btn {
      justify-self: start;
      margin-top: 6px;
    }
    .howto.tight {
      margin-bottom: 14px;
    }

    /* chat hint */
    .hint {
      border: 1px solid var(--tgs-line);
      border-radius: 12px;
      padding: 12px;
      background: var(--tgs-bg-2);
      display: grid;
      gap: 6px;
    }
    .hint-cap {
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tgs-muted);
      margin-bottom: 2px;
    }
    .bubble {
      justify-self: start;
      max-width: 92%;
      padding: 6px 10px;
      border-radius: 12px 12px 12px 3px;
      background: color-mix(in srgb, var(--tgs-text) 9%, transparent);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .bubble.me {
      justify-self: end;
      border-radius: 12px 12px 3px 12px;
      background: color-mix(in srgb, var(--tgs-gold) 22%, transparent);
      color: var(--tgs-strong);
    }
    .tok {
      display: block;
      margin-top: 4px;
      font-family: var(--font-mono, ui-monospace, monospace);
      color: var(--tgs-gold-2);
      border: 1px dashed color-mix(in srgb, var(--tgs-gold) 60%, transparent);
      border-radius: 6px;
      padding: 2px 6px;
    }

    /* fields */
    .field {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
    }
    .field-label {
      font-weight: 600;
      color: var(--tgs-strong);
    }
    .input-wrap {
      display: flex;
      align-items: stretch;
      border: 1px solid var(--tgs-line);
      border-radius: 10px;
      background: var(--input, #18181b);
      overflow: hidden;
    }
    .input-wrap:focus-within {
      border-color: var(--tgs-gold);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--tgs-gold) 22%, transparent);
    }
    input {
      font: inherit;
      color: var(--tgs-strong);
    }
    .input-wrap input {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: 0;
      background: transparent;
      padding: 11px 12px;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 13.5px;
    }
    .ghost-in {
      border: 0;
      border-left: 1px solid var(--tgs-line);
      background: transparent;
      color: var(--tgs-muted);
      padding: 0 12px;
      cursor: pointer;
      font: inherit;
      font-size: 12.5px;
    }
    .ghost-in:hover {
      color: var(--tgs-gold);
    }
    input.plain {
      flex: 1 1 180px;
      min-width: 0;
      border: 1px solid var(--tgs-line);
      border-radius: 10px;
      background: var(--input, #18181b);
      padding: 9px 12px;
      outline: 0;
    }
    input.plain:focus {
      border-color: var(--tgs-gold);
    }
    .field-msg {
      font-size: 12.5px;
      color: var(--tgs-muted);
    }
    .field-msg.bad {
      color: var(--tgs-danger);
    }
    .field-msg.good {
      color: var(--tgs-ok);
    }

    /* buttons */
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }
    .row.foot {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--tgs-line);
    }
    .btn {
      appearance: none;
      font: inherit;
      font-weight: 600;
      font-size: 13.5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 40px;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid var(--tgs-line);
      background: var(--tgs-bg-2);
      color: var(--tgs-text);
      cursor: pointer;
      text-decoration: none;
      transition:
        border-color 0.15s,
        background 0.15s,
        transform 0.05s;
    }
    .btn:hover {
      border-color: var(--tgs-gold);
      color: var(--tgs-strong);
    }
    .btn:active {
      transform: translateY(1px);
    }
    .btn:focus-visible,
    .ghost-in:focus-visible,
    .code:focus-visible,
    summary:focus-visible,
    .tabs button:focus-visible {
      outline: 2px solid var(--tgs-gold);
      outline-offset: 2px;
    }
    .btn[disabled] {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn.gold {
      background: linear-gradient(180deg, var(--tgs-gold-2), var(--tgs-gold));
      border-color: var(--tgs-gold);
      color: #0a0a0a;
    }
    .btn.gold:hover {
      color: #000;
      filter: brightness(1.06);
    }
    .btn.big {
      min-height: 46px;
      padding: 10px 18px;
      font-size: 14.5px;
    }
    .btn.link {
      border-color: transparent;
      background: transparent;
      color: var(--tgs-muted);
      padding-inline: 6px;
    }
    .btn.link:hover {
      color: var(--tgs-gold);
    }
    .btn.danger {
      border-color: var(--tgs-danger);
      color: #fff;
      background: color-mix(in srgb, var(--tgs-danger) 70%, #000);
    }
    .danger-text {
      margin-left: auto;
    }
    .danger-text:hover {
      color: var(--tgs-danger) !important;
    }

    /* alerts */
    .alert {
      border: 1px solid color-mix(in srgb, var(--tgs-danger) 55%, transparent);
      background: color-mix(in srgb, var(--tgs-danger) 9%, transparent);
      border-radius: 12px;
      padding: 12px 14px;
      margin-top: 12px;
      display: grid;
      gap: 4px;
    }
    .alert.warn {
      border-color: color-mix(in srgb, var(--tgs-warn) 55%, transparent);
      background: color-mix(in srgb, var(--tgs-warn) 9%, transparent);
    }
    .alert-title {
      font-weight: 650;
      color: var(--tgs-strong);
    }
    .alert-fix {
      color: var(--tgs-text);
    }
    .alert .row {
      margin-top: 8px;
    }
    .note {
      margin-top: 10px;
      padding: 9px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--tgs-warn) 45%, transparent);
      background: color-mix(in srgb, var(--tgs-warn) 8%, transparent);
      font-size: 13px;
    }
    .note.bad {
      border-color: color-mix(in srgb, var(--tgs-danger) 45%, transparent);
      background: color-mix(in srgb, var(--tgs-danger) 8%, transparent);
      overflow-wrap: anywhere;
    }
    .warn-text {
      color: var(--tgs-warn);
    }

    /* bot card + summary */
    .botcard,
    .sum-head {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .botcard {
      border: 1px solid var(--tgs-line);
      background: var(--tgs-bg-2);
      border-radius: 12px;
      padding: 12px;
    }
    .avatar {
      flex: none;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      border: 1px solid color-mix(in srgb, var(--tgs-gold) 55%, transparent);
    }
    .avatar.mono {
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 19px;
      color: var(--tgs-gold);
      background: color-mix(in srgb, var(--tgs-gold) 12%, #000);
    }
    .botmeta {
      min-width: 0;
      flex: 1;
    }
    .botname {
      font-weight: 650;
      color: var(--tgs-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .botuser {
      color: var(--tgs-gold);
      font-size: 13px;
    }
    .bottoken {
      color: var(--tgs-muted);
      font-size: 12px;
      font-family: var(--font-mono, ui-monospace, monospace);
      overflow-wrap: anywhere;
    }
    .pill {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--tgs-line);
      color: var(--tgs-muted);
      white-space: nowrap;
    }
    .pill svg {
      width: 12px;
      height: 12px;
    }
    .pill.ok {
      color: var(--tgs-ok);
      border-color: color-mix(in srgb, var(--tgs-ok) 45%, transparent);
      background: color-mix(in srgb, var(--tgs-ok) 10%, transparent);
    }
    .summary dl {
      margin: 14px 0 0;
      display: grid;
      gap: 0;
      border-top: 1px solid var(--tgs-line);
    }
    .summary dl > div {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--tgs-line);
    }
    dt {
      color: var(--tgs-muted);
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .chip {
      display: inline-block;
      margin: 0 6px 4px 0;
    }

    /* find */
    .tabs {
      display: inline-flex;
      padding: 3px;
      gap: 3px;
      border: 1px solid var(--tgs-line);
      border-radius: 10px;
      margin-bottom: 14px;
      background: var(--tgs-bg-2);
    }
    .tabs button {
      font: inherit;
      font-weight: 600;
      font-size: 13px;
      border: 0;
      border-radius: 7px;
      padding: 7px 14px;
      min-height: 34px;
      background: transparent;
      color: var(--tgs-muted);
      cursor: pointer;
    }
    .tabs button.on {
      background: color-mix(in srgb, var(--tgs-gold) 18%, transparent);
      color: var(--tgs-gold-2);
    }
    .find {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: start;
    }
    .find-main {
      min-width: 0;
    }
    .qr {
      width: 172px;
      text-align: center;
    }
    .qr img {
      width: 172px;
      height: 172px;
      image-rendering: pixelated;
      border-radius: 10px;
      border: 4px solid #fff;
      background: #fff;
      display: block;
    }
    .qr-cap {
      font-size: 12px;
      color: var(--tgs-muted);
      margin-top: 6px;
    }
    .code-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      color: var(--tgs-muted);
      font-size: 13px;
    }
    .code {
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.14em;
      color: var(--tgs-gold-2);
      background: color-mix(in srgb, var(--tgs-gold) 10%, transparent);
      border: 1px dashed color-mix(in srgb, var(--tgs-gold) 60%, transparent);
      border-radius: 8px;
      padding: 5px 10px;
      cursor: pointer;
    }
    .copied {
      color: var(--tgs-ok);
      font-size: 12px;
      min-width: 44px;
    }
    .waiting {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--tgs-gold) 30%, transparent);
      background: color-mix(in srgb, var(--tgs-gold) 6%, transparent);
    }
    .waiting b {
      color: var(--tgs-gold-2);
      font-variant-numeric: tabular-nums;
    }
    .spinner {
      flex: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--tgs-gold) 30%, transparent);
      border-top-color: var(--tgs-gold);
      animation: tgs-spin 0.9s linear infinite;
    }
    @keyframes tgs-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation-duration: 2.4s;
      }
    }
    .found {
      display: flex;
      gap: 12px;
      align-items: center;
      border: 1px solid color-mix(in srgb, var(--tgs-ok) 50%, transparent);
      background: color-mix(in srgb, var(--tgs-ok) 9%, transparent);
      border-radius: 12px;
      padding: 12px 14px;
    }
    .found-badge {
      flex: none;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--tgs-ok);
      color: #04130a;
    }
    .found-badge svg {
      width: 18px;
      height: 18px;
    }
    .found-text {
      min-width: 0;
    }
    .found-title {
      font-size: 15.5px;
      color: var(--tgs-strong);
      overflow-wrap: anywhere;
    }
    .found-sub {
      color: var(--tgs-muted);
      font-size: 13px;
    }
    .check {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin-top: 4px;
      cursor: pointer;
    }
    .check input {
      margin-top: 3px;
      accent-color: var(--tgs-gold);
    }
    .more {
      margin-top: 14px;
      border: 1px solid var(--tgs-line);
      border-radius: 10px;
      background: var(--tgs-bg-2);
    }
    .more summary {
      cursor: pointer;
      padding: 10px 12px;
      color: var(--tgs-muted);
      font-size: 13px;
      min-height: 40px;
    }
    .more summary:hover {
      color: var(--tgs-gold);
    }
    .more-body {
      padding: 0 12px 12px;
      font-size: 13px;
    }
    .more-body ol {
      margin: 6px 0;
      padding-left: 20px;
      display: grid;
      gap: 4px;
    }
    .more-body p {
      margin: 6px 0;
    }

    @container (max-width: 640px) {
      .stepper li:not(.is-now) .lbl {
        display: none;
      }
      .stepper li:not(.is-now) {
        flex: 0 0 auto;
      }
      .split {
        grid-template-columns: minmax(0, 1fr);
      }
      .find {
        grid-template-columns: minmax(0, 1fr);
      }
      .qr {
        width: auto;
        display: flex;
        gap: 12px;
        align-items: center;
        text-align: left;
      }
      .qr img {
        width: 120px;
        height: 120px;
        flex: none;
      }
    }
    @container (max-width: 460px) {
      .tgs {
        padding: 14px;
        border-radius: 12px;
      }
      .stepper .lbl {
        display: none;
      }
      .stepper {
        margin-bottom: 8px;
      }
      .howto li > .btn {
        justify-self: stretch;
      }
      .stepper li {
        justify-content: center;
      }
      .stepper-mini {
        display: block;
      }
      .btn {
        min-height: 44px;
      }
      .row > .btn.gold,
      .btn.big {
        flex: 1 1 100%;
      }
      .summary dl > div {
        grid-template-columns: minmax(0, 1fr);
        gap: 2px;
      }
      .sum-head,
      .botcard {
        flex-wrap: wrap;
      }
      .danger-text {
        margin-left: 0;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "telegram-setup": TelegramSetup;
  }
}
