import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { awaitGatewayClient, getGatewayClient } from "../gateway-client.js";
import "./cli-routing-settings.js";
import "../components/provider-logo.js";

/**
 * Setup › Coders — install, sign in and configure CLI coding agents
 * (Claude Code, Codex, OpenCode, Gemini, …) from one place.
 *
 * Backed by the gateway's coders.* RPCs (src/gateway/server-methods/coders.ts),
 * so it works the same in the browser, the desktop app and on a hosted cloud
 * gateway. Installs land in an InfiniBot-managed prefix (no sudo); a coder
 * installed here is picked up by the next sub-agent spawn without a restart.
 *
 * Deep links: /setup?view=coders, /setup?view=coders&coder=codex (highlights
 * the card; ⌘K "Install Claude Code" uses this).
 */

type AuthState = "signed-in" | "api-key" | "env" | "signed-out" | "unknown" | "n/a";

interface CatalogEntry {
  id: string;
  name: string;
  vendor: string;
  description: string;
  monogram: string;
  logo?: string;
  homepage: string;
  bin: string;
  backend: string | null;
  approxSizeMb: number;
  install: Array<{ kind: string; package?: string; url?: string; reason?: string }>;
  auth: Array<{ kind: "api-key" | "oauth-login"; label: string; envVars?: string[]; acceptsCode?: boolean }>;
  keyEnvVars: string[];
}

interface Job {
  action: "install" | "update" | "uninstall";
  phase: string;
  ok?: boolean;
  error?: string;
  finishedAt?: number;
  startedAt: number;
  log: string[];
}

interface CoderStatus {
  id: string;
  installed: boolean;
  managed: boolean;
  binPath?: string;
  version?: string;
  managedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  auth: AuthState;
  keys: string[];
  envKeys: string[];
  isDefault: boolean;
  installable: boolean;
  installBlocked?: { code: string; message: string; url?: string };
  job?: Job;
  error?: string;
}

interface StatusPayload {
  coders: CoderStatus[];
  policy: { allowed: boolean; mode: string; reason?: string };
  root: string;
  prerequisites: { npm: boolean; uv: boolean; pipx: boolean; node: string };
}

interface LoginView {
  sessionId: string;
  status: "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
  url?: string;
  userCode?: string;
  needsCode: boolean;
  output: string;
  error?: string;
}

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  checking: "Checking disk",
  downloading: "Downloading",
  linking: "Linking",
  verifying: "Verifying",
  removing: "Removing",
  done: "Done",
  failed: "Failed",
};

const BACKEND_TOOL: Record<string, string> = {
  "claude-code": "claude_coder",
  codex: "codex_coder",
  opencode: "opencode_coder",
  gemini: "claude_coder (backend gemini)",
  grok: "grok_coder",
};

const uiIcons = {
  external: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"></path><path d="M7 7h10v10"></path></svg>`,
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>`,
  close: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>`,
};

/** "2.1.284" from the package, else the first x.y.z in `--version` output. */
function shortVersion(s: CoderStatus): string {
  if (s.managedVersion && s.managedVersion !== "unknown") return s.managedVersion;
  return s.version?.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? s.version ?? "";
}

function client() {
  return getGatewayClient();
}

@customElement("coders-settings")
export class CodersSettings extends LitElement {
  @state() private catalog: CatalogEntry[] = [];
  @state() private status: StatusPayload | null = null;
  @state() private error = "";
  @state() private notice: Record<string, { ok: boolean; text: string }> = {};
  @state() private busy: Record<string, string> = {};
  @state() private openLog: Record<string, boolean> = {};
  @state() private highlight = "";
  // Sign-in modal
  @state() private login: { coder: CatalogEntry; view: LoginView | null; code: string; err: string } | null = null;
  // API-key modal
  @state() private keyModal: { coder: CatalogEntry; envVar: string; value: string; err: string; saving: boolean } | null =
    null;

  private pollTimer?: ReturnType<typeof setTimeout>;
  private loginTimer?: ReturnType<typeof setTimeout>;
  private checkedUpdates = false;

  connectedCallback(): void {
    super.connectedCallback();
    const params = new URLSearchParams(window.location.search);
    this.highlight = params.get("coder") ?? "";
    void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.pollTimer);
    clearTimeout(this.loginTimer);
  }

  protected updated(): void {
    // Modals live in the browser top layer (<dialog>.showModal()), so they
    // center on the viewport even inside transformed/zoomed page containers.
    for (const d of this.renderRoot.querySelectorAll<HTMLDialogElement>("dialog.dlg")) {
      if (!d.open) d.showModal();
    }
  }

  private async load(): Promise<void> {
    const c = client() ?? (await awaitGatewayClient(15_000).catch(() => null));
    if (!c) {
      this.error = "Not connected to the gateway.";
      return;
    }
    try {
      const cat = await c.request<{ coders: CatalogEntry[] }>("coders.catalog", {});
      this.catalog = cat.coders;
      await this.refresh();
      await this.updateComplete;
      // On phones Setup stacks its section list above the content, so the
      // deep link / nav tap would leave this panel below the fold.
      if (!this.highlight && this.getBoundingClientRect().top > window.innerHeight * 0.6) {
        this.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      if (this.highlight) {
        await this.updateComplete;
        this.renderRoot.querySelector(`[data-coder="${CSS.escape(this.highlight)}"]`)?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }
    } catch (e) {
      this.error = this.msg(e);
    }
  }

  private msg(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    if (/unknown method: coders\./.test(m)) {
      return "This gateway doesn't have the Coders installer yet. Restart the gateway after updating InfiniBot.";
    }
    return m;
  }

  private async refresh(): Promise<void> {
    const c = client();
    if (!c) return;
    try {
      const withUpdates = !this.checkedUpdates;
      this.status = await c.request<StatusPayload>(
        "coders.status",
        { checkUpdates: withUpdates },
        { timeoutMs: 60_000 },
      );
      if (withUpdates) this.checkedUpdates = true;
      this.error = "";
    } catch (e) {
      this.error = this.msg(e);
    }
    this.schedulePoll();
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    const active = this.status?.coders.some((s) => s.job && !s.job.finishedAt);
    if (active) this.pollTimer = setTimeout(() => void this.refresh(), 1200);
  }

  private st(id: string): CoderStatus | undefined {
    return this.status?.coders.find((s) => s.id === id);
  }

  private setNotice(id: string, ok: boolean, text: string) {
    this.notice = { ...this.notice, [id]: { ok, text } };
  }

  private async run(id: string, label: string, fn: () => Promise<void>) {
    this.busy = { ...this.busy, [id]: label };
    try {
      await fn();
    } catch (e) {
      this.setNotice(id, false, this.msg(e));
    } finally {
      this.busy = { ...this.busy, [id]: "" };
    }
  }

  private async job(entry: CatalogEntry, action: "install" | "update" | "uninstall") {
    if (action === "uninstall" && !confirm(`Uninstall ${entry.name}? Its sign-in and keys are kept.`)) return;
    await this.run(entry.id, action, async () => {
      this.setNotice(entry.id, true, "");
      await client()!.request(`coders.${action}`, { id: entry.id });
      this.openLog = { ...this.openLog, [entry.id]: true };
      await this.refresh();
    });
  }

  private async test(entry: CatalogEntry) {
    await this.run(entry.id, "test", async () => {
      const r = await client()!.request<{ ok: boolean; version?: string; ms?: number; error?: string }>("coders.test", {
        id: entry.id,
      });
      this.setNotice(entry.id, r.ok, r.ok ? `Runs: ${r.version} (${r.ms} ms)` : (r.error ?? "Test failed"));
    });
  }

  private async setDefault(entry: CatalogEntry) {
    await this.run(entry.id, "default", async () => {
      await client()!.request("coders.setDefault", { id: entry.id });
      this.setNotice(entry.id, true, `${entry.name} is now the default coder.`);
      await this.refresh();
    });
  }

  // ── Sign-in modal ────────────────────────────────────────────────────────

  private async startLogin(entry: CatalogEntry) {
    this.login = { coder: entry, view: null, code: "", err: "" };
    try {
      const view = await client()!.request<LoginView>("coders.login.start", { id: entry.id });
      this.login = { ...this.login, view };
      this.pollLogin();
    } catch (e) {
      this.login = { ...this.login!, err: this.msg(e) };
    }
  }

  private pollLogin() {
    clearTimeout(this.loginTimer);
    const l = this.login;
    if (!l?.view || ["succeeded", "failed", "cancelled", "expired"].includes(l.view.status)) return;
    this.loginTimer = setTimeout(async () => {
      if (!this.login?.view) return;
      try {
        const view = await client()!.request<LoginView>("coders.login.poll", { sessionId: this.login.view.sessionId });
        this.login = { ...this.login, view };
        if (view.status === "succeeded") void this.refresh();
      } catch (e) {
        this.login = { ...this.login, err: this.msg(e) };
      }
      this.pollLogin();
    }, 1500);
  }

  private async submitCode() {
    const l = this.login;
    if (!l?.view || !l.code.trim()) return;
    try {
      await client()!.request("coders.login.submit", { sessionId: l.view.sessionId, code: l.code });
      this.login = { ...l, code: "", err: "", view: { ...l.view, status: "verifying" } };
    } catch (e) {
      this.login = { ...l, err: this.msg(e) };
    }
  }

  private closeLogin() {
    const id = this.login?.view?.sessionId;
    const done = ["succeeded", "failed", "cancelled", "expired"].includes(this.login?.view?.status ?? "");
    if (id && !done) void client()?.request("coders.login.cancel", { sessionId: id }).catch(() => {});
    clearTimeout(this.loginTimer);
    this.login = null;
    void this.refresh();
  }

  // ── Key modal ────────────────────────────────────────────────────────────

  private openKey(entry: CatalogEntry) {
    const apiVars = entry.auth.flatMap((a) => (a.kind === "api-key" ? (a.envVars ?? []) : []));
    this.keyModal = { coder: entry, envVar: apiVars[0] ?? entry.keyEnvVars[0], value: "", err: "", saving: false };
  }

  private async saveKey() {
    const k = this.keyModal;
    if (!k || !k.value.trim()) return;
    this.keyModal = { ...k, saving: true, err: "" };
    try {
      await client()!.request("coders.setKey", { id: k.coder.id, envVar: k.envVar, key: k.value.trim() });
      this.setNotice(k.coder.id, true, `${k.envVar} saved. It's passed only to ${k.coder.name}.`);
      this.keyModal = null;
      await this.refresh();
    } catch (e) {
      this.keyModal = { ...k, saving: false, err: this.msg(e) };
    }
  }

  private async clearKey(entry: CatalogEntry, envVar: string) {
    await this.run(entry.id, "key", async () => {
      await client()!.request("coders.clearKey", { id: entry.id, envVar });
      await this.refresh();
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────

  private chip(entry: CatalogEntry, s: CoderStatus | undefined) {
    const job = s?.job;
    if (job && !job.finishedAt) {
      return html`<span class="chip busy"><span class="dot pulse"></span>${
        job.action === "uninstall" ? "Removing" : PHASE_LABEL[job.phase] ?? job.phase
      }…</span>`;
    }
    if (!s?.installed) {
      if (entry.install.every((m) => m.kind === "manual")) return html`<span class="chip muted">Manual install</span>`;
      return html`<span class="chip muted">Not installed</span>`;
    }
    if (s.updateAvailable) return html`<span class="chip warn">Update ${s.latestVersion}</span>`;
    if (s.auth === "signed-out") {
      const oauth = entry.auth.some((a) => a.kind === "oauth-login");
      return html`<span class="chip warn">${oauth ? "Needs sign-in" : "Needs API key"}</span>`;
    }
    return html`<span class="chip ok"><span class="dot"></span>Ready</span>`;
  }

  private authLine(entry: CatalogEntry, s: CoderStatus) {
    const map: Record<AuthState, string> = {
      "signed-in": "Signed in",
      "api-key": `API key saved (${s.keys.join(", ")})`,
      env: `Using ${s.envKeys.join(", ")} from the gateway environment`,
      "signed-out": entry.auth.some((a) => a.kind === "oauth-login") ? "Not signed in" : "No API key yet",
      unknown: "Sign-in state unknown",
      "n/a": "",
    };
    return map[s.auth];
  }

  private renderCard(entry: CatalogEntry) {
    const s = this.st(entry.id);
    const job = s?.job;
    const running = Boolean(job && !job.finishedAt);
    const busy = this.busy[entry.id];
    const note = this.notice[entry.id];
    const hasOauth = entry.auth.some((a) => a.kind === "oauth-login");
    const hasKey = entry.auth.some((a) => a.kind === "api-key");
    const manual = entry.install.find((m) => m.kind === "manual");
    const policyBlocked = s?.installBlocked?.code === "POLICY";
    const disabled = running || Boolean(busy);
    const logOpen = this.openLog[entry.id] && job;

    return html`<article class="card ${this.highlight === entry.id ? "hl" : ""} ${s?.installed ? "installed" : ""}" data-coder=${entry.id} data-ib-target=${`control:coders/${entry.id}`}>
      <header>
        ${entry.logo
          ? html`<img class="mono" src=${entry.logo} alt="" width="40" height="40" />`
          : html`<ib-provider-logo class="mono" provider=${entry.id} letters=${entry.monogram} size="40"></ib-provider-logo>`}
        <div class="title">
          <h3>${entry.name}</h3>
          <div class="sub">${entry.vendor} · <code>${entry.bin}</code></div>
        </div>
        ${this.chip(entry, s)}
      </header>
      <p class="desc">${entry.description}</p>
      <div class="meta">
        ${entry.backend
          ? html`<span class="tag gold">Sub-agents · ${BACKEND_TOOL[entry.backend] ?? entry.backend}</span>`
          : html`<span class="tag">Terminal only</span>`}
        ${s?.isDefault ? html`<span class="tag gold solid">Default coder</span>` : nothing}
        ${s?.installed && (s.managedVersion || s.version)
          ? html`<span class="tag" title=${s.version ?? ""}>v${shortVersion(s)}</span>`
          : nothing}
        ${s?.installed ? html`<span class="tag">${s.managed ? "Installed by InfiniBot" : "System install"}</span>` : nothing}
        ${!s?.installed && !manual ? html`<span class="tag">~${entry.approxSizeMb} MB</span>` : nothing}
      </div>
      ${s?.installed && s.auth !== "n/a"
        ? html`<div class="auth ${s.auth === "signed-out" ? "warn" : ""}">${this.authLine(entry, s)}</div>`
        : nothing}
      ${running
        ? html`<div class="progress" role="progressbar" aria-label="${entry.name} ${job!.phase}"><span></span></div>`
        : nothing}
      ${job?.finishedAt && job.ok === false
        ? html`<div class="note err">${job.error ?? "Install failed"}</div>`
        : nothing}
      ${note?.text ? html`<div class="note ${note.ok ? "ok" : "err"}">${note.text}</div>` : nothing}
      ${s?.installBlocked && !s.installed && s.installBlocked.code !== "MANUAL"
        ? html`<div class="note ${policyBlocked ? "err" : "warn"}">${s.installBlocked.message}</div>`
        : nothing}

      <div class="actions">
        ${!s?.installed && !manual
          ? html`<button class="btn primary" ?disabled=${disabled || !s?.installable} @click=${() => this.job(entry, "install")}>
              ${running ? "Installing…" : "Install"}
            </button>`
          : nothing}
        ${manual && !s?.installed
          ? html`<a class="btn primary" href=${manual.url!} target="_blank" rel="noopener">Install guide ${uiIcons.external}</a>`
          : nothing}
        ${s?.installed && s.managed && s.updateAvailable
          ? html`<button class="btn primary" ?disabled=${disabled} @click=${() => this.job(entry, "update")}>Update</button>`
          : nothing}
        ${s?.installed && hasOauth && s.auth !== "signed-in"
          ? html`<button class="btn ${s.auth === "signed-out" ? "primary" : ""}" ?disabled=${disabled} @click=${() => this.startLogin(entry)}>Sign in</button>`
          : nothing}
        ${s?.installed && hasKey
          ? html`<button class="btn" ?disabled=${disabled} @click=${() => this.openKey(entry)}>
              ${s.keys.length ? "Keys" : "Add API key"}
            </button>`
          : nothing}
        ${s?.installed && entry.backend && !s.isDefault
          ? html`<button class="btn" ?disabled=${disabled} @click=${() => this.setDefault(entry)}>Set default</button>`
          : nothing}
        ${s?.installed
          ? html`<button class="btn ghost" ?disabled=${disabled} @click=${() => this.test(entry)}>${busy === "test" ? "Testing…" : "Test"}</button>`
          : nothing}
        ${s?.installed && s.managed
          ? html`<button class="btn ghost danger" ?disabled=${disabled} @click=${() => this.job(entry, "uninstall")}>Uninstall</button>`
          : nothing}
        ${job
          ? html`<button class="btn link" @click=${() => (this.openLog = { ...this.openLog, [entry.id]: !this.openLog[entry.id] })}>
              ${logOpen ? "Hide log" : "Log"}
            </button>`
          : nothing}
      </div>
      ${logOpen
        ? html`<pre class="log" aria-live="polite">${job!.log.length ? job!.log.join("\n") : "Starting…"}</pre>`
        : nothing}
      ${s?.binPath ? html`<div class="path" title=${s.binPath}>${s.binPath}</div>` : nothing}
    </article>`;
  }

  private renderLoginModal() {
    const l = this.login;
    if (!l) return nothing;
    const v = l.view;
    const done = v && ["succeeded", "failed", "cancelled", "expired"].includes(v.status);
    return html`<dialog
      class="dlg"
      aria-label="Sign in to ${l.coder.name}"
      @cancel=${(e: Event) => (e.preventDefault(), this.closeLogin())}
      @click=${(e: Event) => e.target === e.currentTarget && this.closeLogin()}
    >
      <div class="modal">
        <header>
          <h3>Sign in to ${l.coder.name}</h3>
          <button class="x" aria-label="Close" @click=${() => this.closeLogin()}>${uiIcons.close}</button>
        </header>
        ${!v && !l.err ? html`<p class="muted">Starting the ${l.coder.bin} sign-in…</p>` : nothing}
        ${v?.status === "succeeded"
          ? html`<div class="done ok"><span class="done-icon">${uiIcons.check}</span> Signed in. ${l.coder.name} is ready to use.</div>`
          : nothing}
        ${v && !done
          ? html`
              <ol class="steps">
                <li>
                  <span>Open the sign-in page and approve access.</span>
                  ${v.url
                    ? html`<div class="row">
                        <a class="btn primary" href=${v.url} target="_blank" rel="noopener">Open sign-in page ${uiIcons.external}</a>
                        <button class="btn ghost" @click=${() => navigator.clipboard?.writeText(v.url!)}>Copy link</button>
                      </div>`
                    : html`<div class="muted">Waiting for the link…</div>`}
                </li>
                ${v.userCode
                  ? html`<li>
                      <span>Enter this one-time code on that page:</span>
                      <div class="code">
                        <strong>${v.userCode}</strong>
                        <button class="btn ghost" @click=${() => navigator.clipboard?.writeText(v.userCode!)}>Copy</button>
                      </div>
                    </li>`
                  : nothing}
                ${v.needsCode || l.coder.auth.some((a) => a.acceptsCode)
                  ? html`<li>
                      <span>Paste the authorization code shown after you approve:</span>
                      <form class="row" @submit=${(e: Event) => (e.preventDefault(), this.submitCode())}>
                        <input
                          type="text"
                          autocomplete="off"
                          spellcheck="false"
                          placeholder="Authorization code"
                          .value=${l.code}
                          @input=${(e: Event) => (this.login = { ...l, code: (e.target as HTMLInputElement).value })}
                        />
                        <button class="btn primary" type="submit" ?disabled=${!l.code.trim()}>Submit</button>
                      </form>
                    </li>`
                  : nothing}
              </ol>
              <p class="muted small">
                ${v.status === "verifying" ? "Checking the code…" : "Waiting for you to finish in the browser…"}
                The credential is stored by ${l.coder.bin} itself; InfiniBot never sees it.
              </p>
            `
          : nothing}
        ${v && ["failed", "expired", "cancelled"].includes(v.status)
          ? html`<div class="done err">${v.error ?? `Sign-in ${v.status}.`}</div>`
          : nothing}
        ${l.err ? html`<div class="done err">${l.err}</div>` : nothing}
        ${v?.output && (done || v.status === "starting")
          ? html`<details><summary>CLI output</summary><pre class="log">${v.output}</pre></details>`
          : nothing}
        <footer>
          ${done && v?.status !== "succeeded"
            ? html`<button class="btn" @click=${() => this.startLogin(l.coder)}>Try again</button>`
            : nothing}
          <button class="btn ${done ? "primary" : "ghost"}" @click=${() => this.closeLogin()}>${done ? "Done" : "Cancel"}</button>
        </footer>
      </div>
    </dialog>`;
  }

  private renderKeyModal() {
    const k = this.keyModal;
    if (!k) return nothing;
    const s = this.st(k.coder.id);
    const vars = k.coder.auth.flatMap((a) => (a.kind === "api-key" ? (a.envVars ?? []) : []));
    return html`<dialog
      class="dlg"
      aria-label="${k.coder.name} API key"
      @cancel=${(e: Event) => (e.preventDefault(), (this.keyModal = null))}
      @click=${(e: Event) => e.target === e.currentTarget && (this.keyModal = null)}
    >
      <div class="modal">
        <header>
          <h3>${k.coder.name} API key</h3>
          <button class="x" aria-label="Close" @click=${() => (this.keyModal = null)}>${uiIcons.close}</button>
        </header>
        <p class="muted small">
          Stored in InfiniBot's credential store and passed only to ${k.coder.name} when it runs. It is never shown
          again.
        </p>
        ${s?.keys.length
          ? html`<ul class="keys">
              ${s.keys.map(
                (name) => html`<li>
                  <code>${name}</code><span class="muted">saved</span>
                  <button class="btn link danger" @click=${() => this.clearKey(k.coder, name)}>Remove</button>
                </li>`,
              )}
            </ul>`
          : nothing}
        <form @submit=${(e: Event) => (e.preventDefault(), this.saveKey())}>
          ${vars.length > 1
            ? html`<label>Variable
                <select @change=${(e: Event) => (this.keyModal = { ...k, envVar: (e.target as HTMLSelectElement).value })}>
                  ${vars.map((v) => html`<option value=${v} ?selected=${v === k.envVar}>${v}</option>`)}
                </select>
              </label>`
            : html`<div class="muted small var">Variable: <code>${k.envVar}</code></div>`}
          <label>Key
            <input
              type="password"
              autocomplete="off"
              placeholder="Paste key"
              .value=${k.value}
              @input=${(e: Event) => (this.keyModal = { ...k, value: (e.target as HTMLInputElement).value })}
            />
          </label>
          ${k.err ? html`<div class="done err">${k.err}</div>` : nothing}
          <footer>
            <button class="btn ghost" type="button" @click=${() => (this.keyModal = null)}>Cancel</button>
            <button class="btn primary" type="submit" ?disabled=${k.saving || !k.value.trim()}>
              ${k.saving ? "Saving…" : "Save key"}
            </button>
          </footer>
        </form>
      </div>
    </dialog>`;
  }

  render() {
    const st = this.status;
    const ready = st?.coders.filter((c) => c.installed).length ?? 0;
    return html`
      <section class="wrap">
        <div class="head">
          <div>
            <div class="kicker">Setup · Coders</div>
            <h2>Coding agents</h2>
            <p class="lede">
              Install a CLI coding agent in one click, sign in, and InfiniBot can run it as a sub-agent. Installs go
              into InfiniBot's own folder: no admin rights, nothing else on the machine touched.
            </p>
          </div>
          <div class="stat" aria-label="Installed coders"><strong>${ready}</strong><span>installed</span></div>
        </div>

        ${st && !st.policy.allowed ? html`<div class="banner err">${st.policy.reason}</div>` : nothing}
        ${st && st.policy.allowed && !st.prerequisites.npm
          ? html`<div class="banner warn">npm wasn't found next to Node.js ${st.prerequisites.node}; npm-based coders can't be installed.</div>`
          : nothing}
        ${this.error ? html`<div class="banner err">${this.error}</div>` : nothing}

        <cli-routing-settings .onInstalled=${() => void this.refresh()}></cli-routing-settings>

        ${!this.catalog.length && !this.error
          ? html`<div class="grid">${[0, 1, 2, 3].map(() => html`<div class="card skeleton"></div>`)}</div>`
          : html`<div class="grid">${this.catalog.map((e) => this.renderCard(e))}</div>`}

        ${st
          ? html`<p class="foot">
              Installed to <code>${st.root}</code>${st.policy.mode === "fleet" ? " on your cloud volume (kept across restarts)" : ""}.
              ${st.policy.mode === "fleet"
                ? "On InfiniBot Cloud coders run inside your own workspace and always ask before acting — permission bypass is off."
                : ""}
              ${st.prerequisites.uv || st.prerequisites.pipx ? "" : "Python-based coders need uv or pipx."}
            </p>`
          : nothing}
      </section>
      ${this.renderLoginModal()} ${this.renderKeyModal()}
    `;
  }

  static styles = css`
    :host {
      display: block;
      --gs-gold: var(--glass-gold, var(--g-primary, #d4af37));
      color: var(--text);
      --gold: var(--gs-gold);
      --line: color-mix(in srgb, var(--text) 9%, transparent);
      --gs-1: var(--glass-1, color-mix(in srgb, var(--panel) 76%, transparent));
      --gs-2: var(--glass-2, color-mix(in srgb, var(--panel) 87%, transparent));
      --gs-3: var(--glass-3, color-mix(in srgb, var(--bg-elevated) 94%, transparent));
      --gs-stroke: var(--glass-stroke, color-mix(in srgb, var(--gold) 18%, var(--border)));
      --gs-stroke-strong: var(--glass-stroke-strong, color-mix(in srgb, var(--gold) 42%, var(--border-strong)));
      --gs-glow: color-mix(in srgb, var(--gold) 26%, transparent);
      --gs-shadow: 0 22px 62px color-mix(in srgb, var(--bg) 54%, transparent), inset 0 1px 0 color-mix(in srgb, var(--text) 9%, transparent);
      font-size: 14px;
      position: relative;
      isolation: isolate;
    }
    :host::before { content: ""; position: absolute; inset: -18px; z-index: -1; pointer-events: none; background: radial-gradient(circle at 8% 0%, var(--gs-glow), transparent 34%), radial-gradient(circle at 94% 20%, color-mix(in srgb, var(--gold) 8%, transparent), transparent 32%); }
    .wrap { max-width: 1180px; position: relative; }
    .head {
      display: flex; gap: 16px; align-items: flex-end; justify-content: space-between; margin-bottom: 18px;
      padding: 22px 24px; border: 1px solid var(--gs-stroke); border-radius: 20px;
      background: linear-gradient(125deg, color-mix(in srgb, var(--gold) 9%, transparent), var(--gs-2));
      box-shadow: var(--gs-shadow); backdrop-filter: blur(22px) saturate(145%);
    }
    .kicker { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); }
    h2 { margin: 4px 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
    .lede { margin: 0; color: var(--muted); max-width: 62ch; line-height: 1.5; }
    .stat {
      flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
      min-width: 84px; padding: 10px 14px; border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--gold) 30%, transparent);
      background: color-mix(in srgb, var(--gold) 7%, var(--gs-2));
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent), 0 12px 28px var(--gs-glow);
    }
    .stat strong { font-size: 24px; color: var(--gold); line-height: 1; }
    .stat span { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .banner { padding: 10px 14px; border-radius: 12px; margin-bottom: 14px; line-height: 1.45; }
    .banner.err { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); color: var(--danger); }
    .banner.warn { border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); color: var(--warn); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
    .card {
      position: relative; display: flex; flex-direction: column; gap: 10px; min-width: 0;
      padding: 17px; border-radius: 18px;
      border: 1px solid var(--gs-stroke);
      background: linear-gradient(150deg, color-mix(in srgb, var(--gold) 6%, var(--gs-3)), var(--gs-1) 64%);
      box-shadow: var(--gs-shadow);
      backdrop-filter: blur(22px) saturate(145%);
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .card.installed { border-color: color-mix(in srgb, var(--gold) 22%, var(--line)); }
    .card:hover { transform: translateY(-3px); border-color: var(--gs-stroke-strong); box-shadow: 0 28px 70px color-mix(in srgb, var(--bg) 60%, transparent), 0 0 34px var(--gs-glow), inset 0 1px 0 color-mix(in srgb, var(--text) 11%, transparent); }
    .card.hl { border-color: var(--gold); box-shadow: 0 0 0 1px var(--gold), 0 0 32px -6px color-mix(in srgb, var(--gold) 50%, transparent); }
    .card.skeleton { min-height: 190px; opacity: 0.5; animation: pulse 1.4s ease-in-out infinite; }
    .card header { display: flex; align-items: center; gap: 12px; }
    .mono { width: 40px; height: 40px; border-radius: 12px; flex: none; }
    .mono.letter {
      display: grid; place-items: center; font-weight: 700; font-size: 18px; color: var(--gold);
      background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gold) 16%, var(--gs-3)), var(--gs-1) 70%);
      border: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
    }
    .title { min-width: 0; flex: 1; }
    h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    .desc { margin: 0; color: var(--muted); line-height: 1.45; }
    .chip {
      flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
      padding: 4px 9px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap;
    }
    .chip.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 7%, transparent); }
    .chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); }
    .chip.busy { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 45%, transparent); background: color-mix(in srgb, var(--gold) 9%, transparent); }
    .chip.muted { color: var(--muted); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .dot.pulse { animation: pulse 1s ease-in-out infinite; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .tag { font-size: 11px; padding: 3px 8px; border-radius: 8px; color: var(--muted); border: 1px solid var(--line); background: color-mix(in srgb, var(--text) 2%, transparent); }
    .tag.gold { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 30%, transparent); }
    .tag.gold.solid { color: var(--bg); background: var(--gold); border-color: var(--gold); font-weight: 600; }
    .auth { font-size: 12px; color: var(--ok); }
    .auth.warn { color: var(--warn); }
    .progress { height: 4px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--text) 6%, transparent); }
    .progress span {
      display: block; height: 100%; width: 35%; border-radius: 4px;
      background: linear-gradient(90deg, transparent, var(--gold), transparent);
      animation: slide 1.2s ease-in-out infinite;
    }
    .note { font-size: 12px; line-height: 1.4; padding: 7px 10px; border-radius: 10px; overflow-wrap: anywhere; }
    .note.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 6%, transparent); }
    .note.err { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .note.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 7%, transparent); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 2px; }
    .btn {
      appearance: none; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
      min-height: 36px; padding: 0 14px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center;
      color: var(--text); border: 1px solid var(--gs-stroke); background: var(--gs-2);
      transition: background 0.15s, border-color 0.15s, transform 0.1s;
    }
    .btn:hover:not([disabled]) { border-color: color-mix(in srgb, var(--gold) 50%, transparent); background: var(--gs-3); box-shadow: 0 10px 24px var(--gs-glow); }
    .btn:active:not([disabled]) { transform: translateY(1px); }
    .btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
    .btn.primary { color: var(--bg); border-color: var(--gold); background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 82%, var(--text)), var(--gold)); }
    .btn.primary:hover:not([disabled]) { background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 72%, var(--text)), var(--gold)); }
    .btn.ghost { background: transparent; }
    .btn.danger { color: var(--danger); }
    .btn svg { width: 14px; height: 14px; margin-left: 6px; }
    .btn.link { background: none; border: none; padding: 0 6px; color: var(--muted); font-weight: 500; }
    .log {
      margin: 0; max-height: 180px; overflow: auto; padding: 10px; border-radius: 10px; font-size: 11px; line-height: 1.45;
      background: color-mix(in srgb, var(--bg) 55%, transparent); border: 1px solid var(--line); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .path { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0.8; }
    .foot { margin-top: 16px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    /* Modals: native <dialog> in the top layer */
    dialog.dlg {
      padding: 0; border: none; background: transparent; color: inherit;
      width: min(520px, calc(100vw - 24px)); max-width: none; max-height: calc(100dvh - 24px); overflow: visible;
    }
    dialog.dlg::backdrop { background: color-mix(in srgb, var(--bg) 68%, transparent); backdrop-filter: blur(8px); }
    .modal {
      box-sizing: border-box; width: 100%; max-height: calc(100dvh - 24px); overflow: auto;
      padding: 20px; border-radius: 20px; color: var(--text);
      border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent);
      background: linear-gradient(170deg, color-mix(in srgb, var(--gold) 6%, var(--gs-3)), var(--gs-2) 55%);
      box-shadow: 0 30px 80px -20px color-mix(in srgb, var(--bg) 90%, transparent), 0 0 0 1px color-mix(in srgb, var(--text) 3%, transparent) inset;
      backdrop-filter: blur(28px) saturate(150%);
    }
    .modal header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .modal h3 { font-size: 18px; }
    .x { display: grid; place-items: center; background: none; border: none; color: var(--muted); cursor: pointer; width: 36px; height: 36px; border-radius: 10px; }
    .x svg { width: 18px; height: 18px; }
    .x:hover { color: var(--text); background: var(--gs-3); }
    .steps { margin: 0 0 12px; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; }
    .steps li > span { display: block; margin-bottom: 8px; line-height: 1.45; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .code { display: flex; align-items: center; gap: 10px; }
    .code strong {
      font-family: ui-monospace, monospace; font-size: 24px; letter-spacing: 0.12em; color: var(--gold);
      padding: 8px 14px; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--gold) 50%, transparent);
    }
    input, select {
      flex: 1; min-width: 0; min-height: 40px; padding: 0 12px; border-radius: 10px; font: inherit; color: inherit;
      border: 1px solid var(--gs-stroke); background: var(--gs-2); width: 100%; box-sizing: border-box;
    }
    input:focus, select:focus { outline: none; border-color: var(--gold); }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
    .modal footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    .muted { color: var(--muted); }
    .small { font-size: 12px; line-height: 1.45; }
    .done { padding: 10px 12px; border-radius: 12px; margin: 8px 0; line-height: 1.45; }
    .done.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent); }
    .done.err { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
    .done-icon { display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: 5px; border: 1px solid currentColor; border-radius: var(--radius-full); }
    .done-icon svg { width: 12px; height: 12px; }
    .var { margin-bottom: 12px; }
    .keys { list-style: none; padding: 0; margin: 0 0 12px; }
    .keys li { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); }
    .keys li .btn { margin-left: auto; }
    details summary { cursor: pointer; color: var(--muted); font-size: 12px; margin: 8px 0; }
    @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @media (max-width: 640px) {
      .head { flex-direction: column; align-items: stretch; padding: 19px 17px; }
      .stat { flex-direction: row; gap: 8px; justify-content: flex-start; align-self: flex-start; }
      .grid { grid-template-columns: 1fr; }
      .card { padding: 14px; }
      .actions .btn { flex: 1 1 auto; }
      .code strong { font-size: 20px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .progress span, .dot.pulse, .card.skeleton { animation: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .head, .card, .modal { backdrop-filter: none; background: var(--panel); }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "coders-settings": CodersSettings;
  }
}
