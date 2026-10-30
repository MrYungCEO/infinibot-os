import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/provider-logo.js";

import { getGatewayClient } from "../gateway-client.js";
import { icon } from "../icons";
import {
  CliRoutingModel,
  canSignIn,
  cliAuthLabel,
  cliErrText,
  cliInstallPhase,
  cliUnsupportedHint,
  cliVersion,
  orderedBackends,
  type CliRoutingBackendView,
  type CliRoutingSetParams,
  type CliRoutingStatus,
} from "../controllers/cli-routing";

/**
 * Setup › Coders › "Use my subscription" (the advanced view of CLI routing).
 *
 * Gateway agents can chat THROUGH the user's signed-in AI accounts (Claude
 * Code, Codex CLI, Gemini CLI, Grok Build, OpenCode) instead of a paid API
 * key. State + actions live in controllers/cli-routing.ts. Off by default:
 * nothing here flips the switch on its own.
 *
 * Rendered at the top of Setup › Coders (/setup?view=coders).
 */

type AgentMode = "follow" | "always" | "never";

const AGENT_MODES: Array<{ id: AgentMode; label: string }> = [
  { id: "follow", label: "Follow switch" },
  { id: "always", label: "Always" },
  { id: "never", label: "Never" },
];

@customElement("cli-routing-settings")
export class CliRoutingSettings extends LitElement {
  /** Called after a one-click install finishes (Setup › Coders refreshes its cards). */
  @property({ attribute: false }) onInstalled: (() => void) | null = null;

  private model = new CliRoutingModel(this, () => getGatewayClient(), { onInstalled: () => this.onInstalled?.() });
  @state() private codes: Record<string, string> = {};
  @state() private busy: string | null = null;
  @state() private note: { ok: boolean; text: string } | null = null;
  @state() private models: Record<string, string> = {};
  private seenStatus: CliRoutingStatus | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.model.load();
  }

  protected willUpdate(): void {
    // Keep the model inputs in step with fresh status (unless the user is mid-edit).
    const st = this.model.status;
    if (st && st !== this.seenStatus) {
      this.seenStatus = st;
      const next = { ...this.models };
      for (const b of st.backends) if (!(b.id in next) || next[b.id] === "") next[b.id] = b.model;
      this.models = next;
    }
  }

  private async set(params: CliRoutingSetParams, key: string, ok?: string): Promise<void> {
    this.busy = key;
    this.note = null;
    try {
      await this.model.set(params);
      if (ok) this.note = { ok: true, text: ok };
    } catch (err) {
      if (!this.model.missing) this.note = { ok: false, text: cliErrText(err) };
    } finally {
      this.busy = null;
    }
  }

  private async login(b: CliRoutingBackendView): Promise<void> {
    this.busy = `login:${b.id}`;
    this.note = null;
    try {
      const res = await this.model.login(b);
      this.note = {
        ok: true,
        text:
          res.mode === "browser"
            ? `Finish signing in with your ${b.account} in the new tab. This page updates by itself.`
            : `Opened the ${b.label} sign-in in Terminals. Finish it there; this page updates by itself when you're signed in.`,
      };
    } catch (err) {
      this.note = { ok: false, text: cliErrText(err) };
    } finally {
      this.busy = null;
    }
  }

  private move(id: string, delta: -1 | 1): void {
    const order = [...(this.model.status?.providers ?? [])];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void this.set({ providers: order }, `move:${id}`);
  }

  private include(id: string, on: boolean): void {
    const order = (this.model.status?.providers ?? []).filter((p) => p !== id);
    if (on) order.push(id);
    void this.set({ providers: order }, `include:${id}`);
  }

  private saveModel(b: CliRoutingBackendView): void {
    const m = (this.models[b.id] ?? "").trim();
    if (!m || m === b.model) return;
    void this.set({ models: { [b.id]: m } }, `model:${b.id}`, `${b.label} now uses ${m}.`);
  }

  private agentMode(o: boolean | null): AgentMode {
    return o === true ? "always" : o === false ? "never" : "follow";
  }

  private switchEl(
    on: boolean,
    label: string,
    testid: string,
    key: string,
    onToggle: () => void,
  ): TemplateResult {
    return html`<button
      type="button"
      role="switch"
      class="sw ${on ? "on" : ""}"
      aria-checked=${on ? "true" : "false"}
      aria-label=${label}
      data-testid=${testid}
      ?disabled=${this.busy !== null && this.busy !== key}
      @click=${onToggle}
    ><span></span></button>`;
  }

  private renderBackend(b: CliRoutingBackendView, st: CliRoutingStatus): TemplateResult {
    const pos = st.providers.indexOf(b.id);
    const included = pos >= 0;
    const auth = cliAuthLabel(b);
    const busy = this.busy !== null;
    const job = this.model.installs[b.id];
    const login = this.model.logins[b.id];
    const watching = this.model.watching.has(b.id) || (login?.mode === "browser" && Boolean(login.session));
    return html`<li class="be ${included ? "in" : ""}" data-testid=${`cli-routing-backend-${b.id}`}>
      <div class="be-main">
        <label class="inc">
          <input
            type="checkbox"
            .checked=${included}
            ?disabled=${busy}
            aria-label=${`Include ${b.label} in the fallback order`}
            data-testid=${`cli-routing-include-${b.id}`}
            @change=${(e: Event) => this.include(b.id, (e.target as HTMLInputElement).checked)}
          />
          <span class="pos" aria-hidden="true">${included ? pos + 1 : "–"}</span>
          <ib-provider-logo provider=${b.id} label=${b.label} size="28"></ib-provider-logo>
          <span class="be-name">
            <strong>${b.signInLabel}${
              b.free
                ? html`
                    <span class="chip free">Free</span>
                  `
                : nothing
            }</strong>
            <span class="muted small">${b.label} · ${b.plan}</span>
          </span>
        </label>
        <div class="order">
          <button
            type="button"
            class="ib"
            aria-label=${`Move ${b.label} up`}
            ?disabled=${busy || !included || pos === 0}
            @click=${() => this.move(b.id, -1)}
          >${icon("arrowUp")}</button>
          <button
            type="button"
            class="ib"
            aria-label=${`Move ${b.label} down`}
            ?disabled=${busy || !included || pos === st.providers.length - 1}
            @click=${() => this.move(b.id, 1)}
          >${icon("arrowDown")}</button>
        </div>
      </div>
      <div class="chips">
        ${
          b.installed
            ? html`<span class="chip ok">Installed${b.version ? ` v${cliVersion(b.version)}` : ""}</span>`
            : job?.running
              ? html`<span class="chip gold-line"><span class="dot pulse"></span>${cliInstallPhase(job)}</span>`
              : html`
                  <span class="chip muted">Not installed</span>
                `
        }
        ${b.installed ? html`<span class="chip ${auth.tone}" data-testid=${`cli-routing-auth-${b.id}`}>${auth.text}</span>` : nothing}
        ${
          watching
            ? html`
                <span class="chip gold-line"><span class="dot pulse"></span>Waiting for sign-in</span>
              `
            : nothing
        }
        ${
          st.active === b.id
            ? html`
                <span class="chip gold">Active</span>
              `
            : nothing
        }
        ${
          b.localOnly
            ? html`
                <span class="chip ok">Local only</span>
              `
            : nothing
        }
      </div>
      ${job?.running ? html`<div class="progress" role="progressbar" aria-label=${`Installing ${b.label}: ${cliInstallPhase(job)}`}><span></span></div>` : nothing}
      ${
        job && !job.running && job.ok === false
          ? html`<div class="note err">${job.error ?? "Install failed"} <a href=${b.installUrl} target="_blank" rel="noopener">Install guide</a></div>`
          : nothing
      }
      ${login?.mode === "browser" && login.session ? this.renderBrowserLogin(b) : nothing}
      <div class="be-row">
        <label class="model">
          <span class="muted small">Model</span>
          <input
            type="text"
            spellcheck="false"
            .value=${this.models[b.id] ?? b.model}
            data-testid=${`cli-routing-model-${b.id}`}
            @input=${(e: Event) => (this.models = { ...this.models, [b.id]: (e.target as HTMLInputElement).value })}
            @change=${() => this.saveModel(b)}
          />
        </label>
        <div class="acts">
          ${
            canSignIn(b)
              ? html`<button
                type="button"
                class="btn ${b.auth === "signed-out" ? "primary" : ""}"
                data-testid=${`cli-routing-login-${b.id}`}
                ?disabled=${busy}
                @click=${() => void this.login(b)}
              >${icon("key")}${this.busy === `login:${b.id}` ? "Opening…" : b.signInLabel}</button>`
              : nothing
          }
          ${
            watching
              ? html`<button type="button" class="btn ghost" data-testid=${`cli-routing-check-${b.id}`} ?disabled=${this.model.loading} @click=${() => void this.model.checkAgain()}>
                ${icon("refresh")}Check again
              </button>`
              : nothing
          }
          ${
            !b.installed
              ? b.coderId
                ? html`<button
                  type="button"
                  class="btn primary"
                  data-testid=${`cli-routing-install-${b.id}`}
                  ?disabled=${busy || Boolean(job?.running)}
                  @click=${() => void this.model.install(b)}
                >${icon("download")}${job?.running ? "Installing…" : `Install ${b.label}`}</button>`
                : html`<a class="btn" href=${b.installUrl} target="_blank" rel="noopener">${icon("externalLink")}Install guide</a>`
              : nothing
          }
        </div>
      </div>
    </li>`;
  }

  /** Browser sign-in in progress: open link, device code, paste box. */
  private renderBrowserLogin(b: CliRoutingBackendView): TemplateResult {
    const l = this.model.logins[b.id]!;
    const s = l.session!;
    const failed = s.status === "failed" || s.status === "expired" || s.status === "cancelled";
    return html`<div class="login" data-testid=${`cli-routing-browser-${b.id}`}>
      ${failed
        ? html`<div class="note err">${s.error ?? `Sign-in ${s.status}.`}</div>`
        : s.status === "succeeded"
          ? html`<div class="note ok">Signed in.</div>`
          : html`<p class="small muted">${s.url ? `Sign in with your ${b.account} in the tab that opened.` : "Getting the sign-in link…"}</p>`}
      ${s.url && !failed && s.status !== "succeeded"
        ? html`<div class="row">
            <button type="button" class="btn ${l.opened ? "" : "primary"}" @click=${() => this.model.reopenLogin(b.id)}>
              ${icon("externalLink")}${l.opened ? "Open the sign-in page again" : "Open the sign-in page"}
            </button>
            ${s.userCode ? html`<span class="code" aria-label="Code to enter">${s.userCode}</span>` : nothing}
          </div>`
        : nothing}
      ${s.needsCode && !failed && s.status !== "succeeded"
        ? html`<form class="row" @submit=${(e: Event) => (e.preventDefault(), void this.model.submitCode(b.id, this.codes[b.id] ?? ""))}>
            <input
              class="paste"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste the code from the sign-in page"
              .value=${this.codes[b.id] ?? ""}
              @input=${(e: Event) => (this.codes = { ...this.codes, [b.id]: (e.target as HTMLInputElement).value })}
            />
            <button class="btn primary" type="submit" ?disabled=${l.submitting || !(this.codes[b.id] ?? "").trim()}>Submit</button>
          </form>`
        : nothing}
      ${l.error ? html`<div class="note err">${l.error}</div>` : nothing}
      <div class="row">
        ${failed ? html`<button type="button" class="btn primary" @click=${() => void this.login(b)}>${icon("refresh")}Try again</button>` : nothing}
        <button type="button" class="btn ghost sm" @click=${() => void this.model.cancelLogin(b.id)}>${failed || s.status === "succeeded" ? "Close" : "Cancel"}</button>
      </div>
    </div>`;
  }

  private renderAgents(st: CliRoutingStatus): TemplateResult | typeof nothing {
    if (!st.agents.length) return nothing;
    return html`<details class="agents">
      <summary>${icon("users")}Per-agent overrides <span class="muted small">(${st.agents.filter((a) => a.routed).length} of ${st.agents.length} routed)</span></summary>
      ${st.allTraffic ? html`<p class="muted small" data-testid="cli-routing-agents-all">"Use it for everything" is on, so every agent uses your subscription.</p>` : nothing}
      <ul class="agent-list">
        ${st.agents.map((a) => {
          const mode = this.agentMode(a.override);
          return html`<li class="agent" data-testid=${`cli-routing-agent-${a.id}`}>
            <span class="agent-name">
              <strong>${a.name || a.id}</strong>
              <span class="small ${a.routed ? "ok-text" : "muted"}">${a.routed ? "Uses your subscription" : "Uses its API model"}</span>
            </span>
            <div class="seg" role="radiogroup" aria-label=${`CLI routing for ${a.name || a.id}`}>
              ${AGENT_MODES.map(
                (m) => html`<button
                  type="button"
                  role="radio"
                  class=${mode === m.id ? "sel" : ""}
                  aria-checked=${mode === m.id ? "true" : "false"}
                  data-testid=${`cli-routing-agent-${a.id}-${m.id}`}
                  ?disabled=${this.busy !== null || st.allTraffic === true}
                  @click=${() =>
                    mode === m.id
                      ? undefined
                      : void this.set(
                          {
                            agentId: a.id,
                            agentEnabled:
                              m.id === "always" ? true : m.id === "never" ? false : null,
                          },
                          `agent:${a.id}`,
                        )}
                >${m.label}</button>`,
              )}
            </div>
          </li>`;
        })}
      </ul>
    </details>`;
  }

  render() {
    const m = this.model;
    const st = m.status;
    if (st && st.available === false) {
      return html`<section class="card" data-testid="cli-routing-settings">
        <p class="muted small" data-testid="cli-routing-unavailable">${st.unavailableReason ?? "Using your own AI subscription works in the InfiniBot desktop and self-hosted app, not on this server."}</p>
      </section>`;
    }
    const activeLabel = st?.active
      ? (st.backends.find((b) => b.id === st.active)?.label ?? st.active)
      : null;
    return html`<section class="card" data-testid="cli-routing-settings" data-ib-target="control:coders/cli-routing">
      <header class="top">
        <span class="badge">${icon("key")}</span>
        <div class="top-text">
          <div class="kicker">Use my subscription</div>
          <h3>Chat through the AI plan you already pay for</h3>
          <p class="muted lede">
            Use the Claude, ChatGPT, Gemini or Grok plan you already pay for. InfiniBot runs your agents' chats through the
            official CLI, so no API key is needed.
          </p>
        </div>
        ${
          st && !m.missing
            ? this.switchEl(
                st.enabled,
                "Use my subscription (CLI routing)",
                "cli-routing-toggle",
                "enabled",
                () =>
                  void this.set(
                    { enabled: !st.enabled },
                    "enabled",
                    st.enabled
                      ? "Off. Agents use their API models again."
                      : `On${activeLabel ? `: chats go through ${activeLabel}` : ""}.`,
                  ),
              )
            : nothing
        }
      </header>

      ${
        m.missing
          ? html`
              <p class="muted small" data-testid="cli-routing-missing">
                Needs a gateway update. Update InfiniBot and restart the gateway to use your subscription here.
              </p>
            `
          : m.error && !st
            ? html`<div class="note err">${m.error} <button type="button" class="btn ghost sm" @click=${() => void m.load()}>${icon("refresh")}Try again</button></div>`
            : !st
              ? html`
                  <p class="muted small">Checking your AI apps…</p>
                `
              : html`
                ${
                  st.enabled && !st.active
                    ? html`<div class="note warn">${icon("alertCircle")}<span>On, but none of the ticked options is ready yet. Install one and sign in below.</span></div>`
                    : nothing
                }
                <div class="sub-h">
                  <span>Order to try</span>
                  <button type="button" class="btn ghost sm" data-testid="cli-routing-refresh" ?disabled=${m.loading} @click=${() => void m.checkAgain()}>
                    ${icon("refresh")}${m.loading ? "Checking…" : "Check again"}
                  </button>
                </div>
                <p class="muted small">Ticked options are tried top to bottom. The first one that's ready answers.</p>
                <ol class="be-list">${orderedBackends(st).map((b) => this.renderBackend(b, st))}</ol>
                ${
                  st.unsupported.length
                    ? html`<ul class="unsup" data-testid="cli-routing-unsupported">
                      ${st.unsupported.map((u) => {
                        const hint = cliUnsupportedHint(u);
                        return html`<li><strong>${u.label}</strong> <span class="chip">Not supported</span> <span>${u.reason}</span>${hint ? html` <span class="hint">${hint}</span>` : nothing}</li>`;
                      })}
                    </ul>`
                    : nothing
                }
                <div class="opts">
                  <div class="opt">
                    <span class="opt-text"><strong>Use it for everything</strong><span class="muted small">Every agent and every chat, channel, voice call, group chat, sub-agent and scheduled job, even ones set to a specific model. Secure Mode chats still stay on this computer.</span></span>
                    ${this.switchEl(
                      st.allTraffic === true,
                      "Use it for everything",
                      "cli-routing-all-traffic",
                      "allTraffic",
                      () =>
                        void this.set(
                          st.allTraffic ? { allTraffic: false } : { enabled: true, allTraffic: true },
                          "allTraffic",
                        ),
                    )}
                  </div>
                  <div class="opt">
                    <span class="opt-text"><strong>Fall back to my API model if every account fails</strong><span class="muted small">Otherwise the chat explains what went wrong.</span></span>
                    ${this.switchEl(
                      st.fallbackToApi,
                      "Fall back to my API model if every account fails",
                      "cli-routing-fallback",
                      "fallback",
                      () => void this.set({ fallbackToApi: !st.fallbackToApi }, "fallback"),
                    )}
                  </div>
                  <div class="opt">
                    <span class="opt-text"><strong>Let the CLI use InfiniBot tools (memory, kanban, …)</strong><span class="muted small">Connects the CLI to InfiniBot over MCP.</span></span>
                    ${this.switchEl(st.tools, "Let the CLI use InfiniBot tools", "cli-routing-tools", "tools", () => void this.set({ tools: !st.tools }, "tools"))}
                  </div>
                </div>
                ${this.renderAgents(st)}
                <p class="secure">${icon("shield")}<span>Messages go to that company's servers (Anthropic, OpenAI, Google, xAI). Secure Mode chats never use this; they stay on models on this computer.</span></p>
              `
      }
      ${this.note ? html`<div class="note ${this.note.ok ? "ok" : "err"}" role=${this.note.ok ? "status" : "alert"}>${this.note.text}</div>` : nothing}
    </section>`;
  }

  static styles = css`
    :host {
      display: block;
      margin-bottom: 18px;
      --gold: var(--glass-gold, var(--g-primary, #d4af37));
      --line: color-mix(in srgb, var(--text) 9%, transparent);
      --gs-1: var(--glass-1, color-mix(in srgb, var(--panel) 76%, transparent));
      --gs-2: var(--glass-2, color-mix(in srgb, var(--panel) 87%, transparent));
      --gs-3: var(--glass-3, color-mix(in srgb, var(--bg-elevated) 94%, transparent));
      --gs-stroke: var(--glass-stroke, color-mix(in srgb, var(--gold) 18%, var(--border)));
      --gs-glow: color-mix(in srgb, var(--gold) 26%, transparent);
      color: var(--text);
      font-size: 14px;
    }
    svg {
      width: 14px;
      height: 14px;
      flex: none;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.92em;
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 12px;
      line-height: 1.45;
    }
    .ok-text {
      color: var(--ok);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid var(--gs-stroke);
      background: linear-gradient(
        150deg,
        color-mix(in srgb, var(--gold) 7%, var(--gs-3)),
        var(--gs-1) 64%
      );
      box-shadow:
        0 22px 62px color-mix(in srgb, var(--bg) 54%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
      backdrop-filter: blur(22px) saturate(145%);
    }
    .top {
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .badge {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      flex: none;
      display: grid;
      place-items: center;
      color: var(--gold);
      border: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
      background: radial-gradient(
        circle at 30% 25%,
        color-mix(in srgb, var(--gold) 16%, var(--gs-3)),
        var(--gs-1) 70%
      );
    }
    .badge svg {
      width: 18px;
      height: 18px;
    }
    .top-text {
      flex: 1;
      min-width: 0;
    }
    .kicker {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--gold);
    }
    h3 {
      margin: 3px 0 4px;
      font-size: 17px;
      font-weight: 600;
    }
    .lede {
      margin: 0;
      line-height: 1.5;
      max-width: 66ch;
    }
    .sw {
      appearance: none;
      position: relative;
      width: 46px;
      height: 26px;
      border-radius: 999px;
      cursor: pointer;
      flex: none;
      padding: 0;
      border: 1px solid var(--gs-stroke);
      background: color-mix(in srgb, var(--text) 6%, transparent);
      margin-top: 2px;
    }
    .sw span {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--muted);
      transition:
        transform 0.2s,
        background 0.2s;
    }
    .sw.on {
      background: color-mix(in srgb, var(--gold) 30%, transparent);
      border-color: var(--gold);
    }
    .sw.on span {
      transform: translateX(20px);
      background: var(--gold);
    }
    .sw:focus-visible {
      outline: 2px solid var(--gold);
      outline-offset: 3px;
    }
    .sw:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .sub-h {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--gold);
      margin-top: 4px;
    }
    .sub-h + p {
      margin: -6px 0 0;
    }
    .be-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .be {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--text) 2%, transparent);
      min-width: 0;
    }
    .be.in {
      border-color: color-mix(in srgb, var(--gold) 28%, var(--line));
    }
    .be-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .inc {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }
    .inc input {
      accent-color: var(--gold);
      width: 18px;
      height: 18px;
      margin: 0;
      flex: none;
    }
    .pos {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      flex: none;
      display: grid;
      place-items: center;
      font:
        600 11px/1 ui-monospace,
        monospace;
      color: var(--muted);
      border: 1px solid var(--line);
    }
    .be.in .pos {
      color: var(--bg);
      background: var(--gold);
      border-color: var(--gold);
    }
    .be-name {
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .be-name .small {
      overflow-wrap: anywhere;
    }
    .order {
      display: flex;
      gap: 4px;
      flex: none;
    }
    .ib {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      cursor: pointer;
      color: var(--text);
      border: 1px solid var(--gs-stroke);
      background: var(--gs-2);
    }
    .ib:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .ib:focus-visible,
    .btn:focus-visible,
    .seg button:focus-visible {
      outline: 2px solid var(--gold);
      outline-offset: 2px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      white-space: nowrap;
    }
    .chip.ok {
      color: var(--ok);
      border-color: color-mix(in srgb, var(--ok) 35%, transparent);
      background: color-mix(in srgb, var(--ok) 7%, transparent);
    }
    .chip.warn {
      color: var(--warn);
      border-color: color-mix(in srgb, var(--warn) 35%, transparent);
      background: color-mix(in srgb, var(--warn) 7%, transparent);
    }
    .chip.gold {
      color: var(--bg);
      background: var(--gold);
      border-color: var(--gold);
    }
    .chip.muted {
      color: var(--muted);
    }
    .chip.gold-line {
      color: var(--gold);
      border-color: color-mix(in srgb, var(--gold) 45%, transparent);
      background: color-mix(in srgb, var(--gold) 9%, transparent);
    }
    .chip.free {
      color: var(--bg);
      background: var(--ok);
      border-color: var(--ok);
      padding: 2px 7px;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      vertical-align: 1px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .dot.pulse {
      animation: pulse 1s ease-in-out infinite;
    }
    .progress {
      height: 4px;
      border-radius: 4px;
      overflow: hidden;
      background: color-mix(in srgb, var(--text) 6%, transparent);
    }
    .progress span {
      display: block;
      height: 100%;
      width: 35%;
      border-radius: 4px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
      animation: slide 1.2s ease-in-out infinite;
    }
    .note a {
      color: inherit;
      font-weight: 600;
    }
    .unsup .hint {
      color: var(--gold);
    }
    .login { display: grid; gap: 8px; padding: 10px; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--gold) 40%, transparent); }
    .login p { margin: 0; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .code { font: 600 18px/1 ui-monospace, monospace; letter-spacing: 0.14em; color: var(--gold); padding: 8px 12px; border-radius: 10px; border: 1px dashed color-mix(in srgb, var(--gold) 50%, transparent); }
    .paste { flex: 1 1 200px; min-width: 0; min-height: 36px; padding: 0 10px; border-radius: 10px; font: inherit; color: inherit; border: 1px solid var(--gs-stroke); background: var(--gs-2); }
    .paste:focus { outline: none; border-color: var(--gold); }
    @keyframes slide {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(300%);
      }
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    .be-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: flex-end;
    }
    .model {
      flex: 1 1 180px;
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .model input {
      min-height: 36px;
      padding: 0 10px;
      border-radius: 10px;
      font: inherit;
      font-family: ui-monospace, monospace;
      font-size: 12.5px;
      color: inherit;
      border: 1px solid var(--gs-stroke);
      background: var(--gs-2);
      width: 100%;
      box-sizing: border-box;
    }
    .model input:focus {
      outline: none;
      border-color: var(--gold);
    }
    .acts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .btn {
      appearance: none;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      gap: 6px;
      min-height: 36px;
      padding: 0 14px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text);
      border: 1px solid var(--gs-stroke);
      background: var(--gs-2);
    }
    .btn:hover:not([disabled]) {
      border-color: color-mix(in srgb, var(--gold) 50%, transparent);
      background: var(--gs-3);
      box-shadow: 0 10px 24px var(--gs-glow);
    }
    .btn[disabled] {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .btn.primary {
      color: var(--bg);
      border-color: var(--gold);
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--gold) 82%, var(--text)),
        var(--gold)
      );
    }
    .btn.ghost {
      background: transparent;
    }
    .btn.sm {
      min-height: 30px;
      padding: 0 10px;
      font-size: 12px;
      letter-spacing: normal;
      text-transform: none;
    }
    .unsup {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      opacity: 0.8;
    }
    .unsup strong {
      font-weight: 600;
    }
    .opts {
      display: grid;
      gap: 4px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .opt {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 0;
    }
    .opt-text {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .opt-text strong {
      font-weight: 600;
      font-size: 13.5px;
    }
    .agents {
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .agents summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13.5px;
      list-style: none;
      flex-wrap: wrap;
    }
    .agents summary::-webkit-details-marker {
      display: none;
    }
    .agent-list {
      list-style: none;
      margin: 10px 0 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .agent {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
    }
    .agent-name {
      flex: 1 1 160px;
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--gs-stroke);
      border-radius: 10px;
      overflow: hidden;
    }
    .seg button {
      appearance: none;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      min-height: 32px;
      padding: 0 10px;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .seg button + button {
      border-left: 1px solid var(--gs-stroke);
    }
    .seg button.sel {
      color: var(--bg);
      background: var(--gold);
    }
    .seg button:disabled {
      cursor: not-allowed;
    }
    .secure {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
    .secure svg {
      color: var(--gold);
      margin-top: 1px;
    }
    .note {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-size: 12px;
      line-height: 1.4;
      padding: 7px 10px;
      border-radius: 10px;
      overflow-wrap: anywhere;
    }
    .note.ok {
      color: var(--ok);
      background: color-mix(in srgb, var(--ok) 6%, transparent);
    }
    .note.err {
      color: var(--danger);
      background: color-mix(in srgb, var(--danger) 8%, transparent);
    }
    .note.warn {
      color: var(--warn);
      background: color-mix(in srgb, var(--warn) 7%, transparent);
    }
    @media (max-width: 640px) {
      .card {
        padding: 14px;
      }
      /* Phones: the reorder arrows drop under the name so the title and
         description get the full row instead of ~90px. */
      .be {
        padding: 10px;
      }
      .be-main {
        flex-wrap: wrap;
        row-gap: 6px;
      }
      .inc {
        flex: 1 1 100%;
      }
      .order {
        margin-left: auto;
      }
      .acts,
      .acts .btn {
        flex: 1 1 100%;
      }
      .seg {
        width: 100%;
      }
      .seg button {
        flex: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sw span {
        transition: none;
      }
      .dot.pulse,
      .progress span {
        animation: none;
      }
    }
    @media (prefers-reduced-transparency: reduce) {
      .card {
        backdrop-filter: none;
        background: var(--panel);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "cli-routing-settings": CliRoutingSettings;
  }
}
