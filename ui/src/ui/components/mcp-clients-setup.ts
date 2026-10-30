/**
 * <ib-mcp-clients-setup> — "Connect your AI apps (MCP)" step.
 *
 * Finds Claude Code, Claude Desktop, Cursor, Codex and VS Code on this
 * computer and adds InfiniBot to each one's MCP config in one click (the
 * gateway backs the file up first and merges, never overwriting other
 * servers). Copy-paste config covers any other app. "Test connection" runs
 * the exact entry the apps use and calls an InfiniBot tool — plus a browser
 * tool when Chrome is paired.
 *
 * Entries never contain the gateway password/token. Fires `mcp-skip` for
 * Skip and `mcp-added` after a successful add. `?mcpDemo=found|added|tested|cloud`
 * renders a fixture with no RPCs.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "../icons.js";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

type ClientId = "claude-code" | "claude-desktop" | "cursor" | "codex" | "vscode";

type ClientStatus = {
  id: ClientId;
  name: string;
  detected: boolean;
  configPath: string;
  configured: boolean;
  current: boolean;
  embedsSecret: boolean;
  unreadable?: string;
  after: string;
};

type Detect = {
  cloud: boolean;
  gatewayUrl: string;
  clients: ClientStatus[];
  snippets: Record<string, string>;
};

type AddResult =
  | { id: ClientId; ok: true; changed: boolean; configPath: string; backupPath?: string; after: string }
  | { id: ClientId; ok: false; configPath: string; error: string };

type TestResult = {
  ok: boolean;
  toolCount: number;
  hasBrowser: boolean;
  calls: Array<{ tool: string; ok: boolean; ms: number; summary: string }>;
  error?: string;
};

const SNIPPET_TABS: Array<{ id: string; label: string }> = [
  { id: "generic", label: "Any app (JSON)" },
  { id: "claude-code", label: "Claude Code (CLI)" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex (TOML)" },
  { id: "vscode", label: "VS Code" },
];

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err)
    .replace(/^Error:\s*/, "")
    .slice(0, 300);
}

function unknownMethod(err: unknown): boolean {
  return /unknown method|method not found/i.test(errText(err));
}

function demoParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("mcpDemo");
  } catch {
    return null;
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function demoDetect(kind: string): Detect {
  const p = (s: string) => `/home/you/${s}`;
  const added = kind === "added" || kind === "tested";
  const mk = (id: ClientId, name: string, detected: boolean, path: string, after = ""): ClientStatus => ({
    id,
    name,
    detected,
    configPath: p(path),
    configured: added && detected,
    current: added && detected,
    embedsSecret: false,
    after,
  });
  const entry = '{\n  "mcpServers": {\n    "infinibot": {\n      "command": "/usr/bin/node",\n      "args": ["/opt/infinibot/dist/cli/mcp-stdio.js"],\n      "env": {\n        "MOLTBOT_GATEWAY_URL": "ws://127.0.0.1:18789",\n        "INFINIBOT_MCP_AUTH": "config"\n      }\n    }\n  }\n}\n';
  return {
    cloud: kind === "cloud",
    gatewayUrl: "ws://127.0.0.1:18789",
    clients: [
      mk("claude-code", "Claude Code", true, ".claude.json", "Start a new `claude` session and run /mcp."),
      mk("claude-desktop", "Claude Desktop", true, ".config/Claude/claude_desktop_config.json", "Quit and reopen Claude Desktop."),
      mk("cursor", "Cursor", true, ".cursor/mcp.json", "Open Cursor → Settings → MCP."),
      mk("codex", "Codex", false, ".codex/config.toml"),
      mk("vscode", "VS Code", false, ".config/Code/User/mcp.json"),
    ],
    snippets: Object.fromEntries(SNIPPET_TABS.map((t) => [t.id, entry])),
  };
}

@customElement("ib-mcp-clients-setup")
export class McpClientsSetup extends LitElement {
  @property({ attribute: false }) client: Requester | null = null;
  @property({ reflect: true }) context: "onboarding" | "settings" | "cloud" = "onboarding";
  @property({ type: Boolean }) skippable = true;

  @state() private data: Detect | null = null;
  @state() private picked = new Set<ClientId>();
  @state() private results: AddResult[] | null = null;
  @state() private test: TestResult | null = null;
  @state() private busy: "detect" | "add" | "test" | null = null;
  @state() private error: string | null = null;
  @state() private tab = "generic";
  @state() private copied = false;
  @state() private outdated = false;

  private readonly demo = demoParam();

  connectedCallback(): void {
    super.connectedCallback();
    if (this.demo) {
      this.data = demoDetect(this.demo);
      this.pickDefaults();
      if (this.demo === "added" || this.demo === "tested") {
        this.results = this.data.clients
          .filter((c) => c.detected)
          .map((c) => ({
            id: c.id,
            ok: true as const,
            changed: true,
            configPath: c.configPath,
            backupPath: `${c.configPath}.infinibot-backup-2026-10-28T11-02-07-311Z`,
            after: c.after,
          }));
      }
      if (this.demo === "tested") {
        this.test = {
          ok: true,
          toolCount: 214,
          hasBrowser: true,
          calls: [
            { tool: "session_status", ok: true, ms: 41, summary: "answered" },
            { tool: "browser", ok: true, ms: 612, summary: "paired Chrome answered" },
          ],
        };
      }
      return;
    }
    if (this.client) void this.detect();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && !this.data && !this.busy && !this.demo) void this.detect();
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.client) throw new Error("Not connected to InfiniBot yet.");
    return (await this.client.request(method, params ?? {})) as T;
  }

  private pickDefaults(): void {
    const next = new Set<ClientId>();
    for (const c of this.data?.clients ?? []) {
      if (c.detected && !c.unreadable && (!c.current || c.embedsSecret)) next.add(c.id);
    }
    this.picked = next;
  }

  private async detect(): Promise<void> {
    this.busy = "detect";
    this.error = null;
    try {
      this.data = await this.rpc<Detect>("mcp.clients.detect");
      if (this.context === "cloud") this.data = { ...this.data, cloud: true };
      this.pickDefaults();
    } catch (err) {
      if (unknownMethod(err)) {
        this.outdated = true;
        this.data = await this.legacySnippets();
      } else if (this.context === "cloud") {
        this.data = { cloud: true, gatewayUrl: "", clients: [], snippets: {} };
      } else {
        this.error = errText(err);
      }
    } finally {
      this.busy = null;
    }
  }

  /** Gateways that predate mcp.clients.*: build the copy-paste entry from connectInfo. */
  private async legacySnippets(): Promise<Detect> {
    try {
      const info = await this.rpc<{ gatewayPort: number; stdio: { command: string; entry: string } }>("mcp.connectInfo");
      const entry = {
        command: info.stdio.command,
        args: [info.stdio.entry],
        env: { MOLTBOT_GATEWAY_URL: `ws://127.0.0.1:${info.gatewayPort}`, INFINIBOT_MCP_AUTH: "config" },
      };
      const json = `${JSON.stringify({ mcpServers: { infinibot: entry } }, null, 2)}\n`;
      return { cloud: false, gatewayUrl: entry.env.MOLTBOT_GATEWAY_URL, clients: [], snippets: { generic: json } };
    } catch {
      return { cloud: false, gatewayUrl: "", clients: [], snippets: {} };
    }
  }

  private toggle(id: ClientId): void {
    const next = new Set(this.picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.picked = next;
  }

  private async add(): Promise<void> {
    if (this.picked.size === 0) return;
    this.busy = "add";
    this.error = null;
    try {
      const r = await this.rpc<{ results: AddResult[] }>("mcp.clients.add", { ids: [...this.picked] });
      this.results = r.results;
      if (r.results.some((x) => x.ok)) {
        this.dispatchEvent(new CustomEvent("mcp-added", { bubbles: true, composed: true }));
      }
      const fresh = await this.rpc<Detect>("mcp.clients.detect").catch(() => null);
      if (fresh) this.data = { ...fresh, cloud: this.data?.cloud ?? fresh.cloud };
      this.picked = new Set();
    } catch (err) {
      this.error = errText(err);
    } finally {
      this.busy = null;
    }
  }

  private async runTest(): Promise<void> {
    this.busy = "test";
    this.error = null;
    this.test = null;
    try {
      this.test = await this.rpc<TestResult>("mcp.clients.test", { browser: true });
    } catch (err) {
      this.test = { ok: false, toolCount: 0, hasBrowser: false, calls: [], error: errText(err) };
    } finally {
      this.busy = null;
    }
  }

  private skip(): void {
    this.dispatchEvent(new CustomEvent("mcp-skip", { bubbles: true, composed: true }));
  }

  // ── render ────────────────────────────────────────────────────────────────

  private chip(c: ClientStatus): TemplateResult {
    if (c.unreadable) return html`<span class="chip warn" title=${c.unreadable}>Config can't be read</span>`;
    if (c.current && !c.embedsSecret) return html`<span class="chip ok">${icon("check")}Added</span>`;
    if (c.configured) return html`<span class="chip warn">Needs update</span>`;
    if (c.detected) return html`<span class="chip found">Found</span>`;
    return html`<span class="chip idle">Not found</span>`;
  }

  private renderClients(d: Detect): TemplateResult {
    if (d.clients.length === 0) {
      return html`<div class="note" data-testid="mcp-outdated">
        ${icon("alertCircle")}
        <span>
          ${this.outdated
            ? "One-click setup arrives after InfiniBot restarts with this update. Until then, use the copy-paste config below."
            : "No apps to show."}
        </span>
      </div>`;
    }
    const n = this.picked.size;
    return html`
      <ul class="clients" data-testid="mcp-clients">
        ${d.clients.map((c) => {
          const can = c.detected && !c.unreadable;
          return html`<li class=${can ? "" : "is-off"}>
            <label>
              <input
                type="checkbox"
                .checked=${this.picked.has(c.id)}
                ?disabled=${!can}
                data-testid=${`mcp-pick-${c.id}`}
                @change=${() => this.toggle(c.id)}
              />
              <span class="name">${c.name}</span>
            </label>
            ${this.chip(c)}
            <code class="cfg" title=${c.configPath}>${c.configPath}</code>
          </li>`;
        })}
      </ul>
      <div class="row">
        <button
          type="button"
          class="btn btn--primary"
          data-testid="mcp-add"
          ?disabled=${n === 0 || this.busy === "add"}
          @click=${() => void this.add()}
        >
          ${this.busy === "add"
            ? html`<span class="spin"></span>Adding…`
            : html`${icon("plug")}${n ? `Add InfiniBot MCP to ${n} app${n === 1 ? "" : "s"}` : "Add InfiniBot MCP"}`}
        </button>
        <span class="hint">Each config is backed up first. Your other MCP servers stay as they are.</span>
      </div>
      ${this.results
        ? html`<ul class="results" data-testid="mcp-add-results">
            ${this.results.map((r) =>
              r.ok
                ? html`<li class="ok">
                    ${icon("checkCircle")}
                    <div>
                      <b>${d.clients.find((c) => c.id === r.id)?.name ?? r.id}</b>
                      ${r.changed ? "added" : "already set up"}.
                      <span class="sub">${r.after}</span>
                      ${r.backupPath ? html`<span class="sub">Backup: <code>${r.backupPath}</code></span>` : nothing}
                    </div>
                  </li>`
                : html`<li class="bad">${icon("alertCircle")}<div>${r.error}</div></li>`,
            )}
          </ul>`
        : nothing}
    `;
  }

  private renderSnippets(d: Detect): TemplateResult {
    const tabs = SNIPPET_TABS.filter((t) => d.snippets[t.id]);
    if (tabs.length === 0) return html``;
    const active = d.snippets[this.tab] ? this.tab : tabs[0]!.id;
    const text = d.snippets[active] ?? "";
    return html`
      <details class="more" data-testid="mcp-snippets" ?open=${d.clients.length === 0}>
        <summary>Another app, or prefer to paste it yourself?</summary>
        <div class="tabs" role="tablist">
          ${tabs.map(
            (t) => html`<button
              type="button"
              role="tab"
              class="tab ${t.id === active ? "is-on" : ""}"
              aria-selected=${t.id === active ? "true" : "false"}
              @click=${() => (this.tab = t.id)}
            >
              ${t.label}
            </button>`,
          )}
        </div>
        <pre class="snippet" data-testid="mcp-snippet">${text}</pre>
        <div class="row">
          <button
            type="button"
            class="btn"
            data-testid="mcp-copy-snippet"
            @click=${async () => {
              if (await copy(text)) {
                this.copied = true;
                setTimeout(() => (this.copied = false), 1800);
              }
            }}
          >
            ${icon(this.copied ? "check" : "copy")}${this.copied ? "Copied" : "Copy config"}
          </button>
          <span class="hint">No password inside: the server reads it from your InfiniBot settings when it starts.</span>
        </div>
      </details>
    `;
  }

  private renderTest(): TemplateResult {
    const t = this.test;
    return html`<section class="card" data-testid="mcp-test">
      <h4>Test connection</h4>
      <p class="hint">Starts InfiniBot's MCP server exactly the way your apps do and calls a tool${" "}— and a browser tool
        too when Chrome is connected.</p>
      <div class="row">
        <button type="button" class="btn" data-testid="mcp-test-run" ?disabled=${this.busy === "test" || this.outdated} @click=${() => void this.runTest()}>
          ${this.busy === "test" ? html`<span class="spin"></span>Testing…` : html`${icon("play")}Test connection`}
        </button>
      </div>
      ${t
        ? html`<div class="result ${t.ok ? "ok" : "bad"}" data-testid="mcp-test-result">
            ${icon(t.ok ? "checkCircle" : "alertCircle")}
            <div>
              ${t.ok
                ? html`<b>Connected.</b> ${t.toolCount} InfiniBot tools available${t.hasBrowser ? ", including the browser" : ""}.`
                : html`<b>Didn't connect.</b> ${t.error ?? "One of the calls failed."}`}
              ${t.calls.length
                ? html`<ul class="calls">
                    ${t.calls.map(
                      (c) => html`<li>${c.ok ? "✓" : "✗"} <code>${c.tool}</code> — ${c.summary} <span class="sub-i">(${c.ms} ms)</span></li>`,
                    )}
                  </ul>`
                : nothing}
            </div>
          </div>`
        : nothing}
    </section>`;
  }

  private renderCloud(): TemplateResult {
    return html`<div class="card" data-testid="mcp-cloud">
      <p class="lead">
        AI apps like Claude Code, Claude Desktop, Cursor, Codex and VS Code run on your computer, so they connect to
        InfiniBot running there.
      </p>
      <ol class="steps">
        <li><span class="n">1</span><div><b>Install InfiniBot on that computer</b><span class="sub">Desktop app, or <code>npm install -g infinibot</code>.</span></div></li>
        <li><span class="n">2</span><div><b>Open Setup › Connect your AI apps</b><span class="sub">It finds your apps and adds InfiniBot to each in one click, with a backup first.</span></div></li>
      </ol>
      <div class="row">
        <a class="btn btn--primary" href="https://infinibotos.com/#download" target="_blank" rel="noopener">${icon("download")}Get InfiniBot for your computer</a>
      </div>
    </div>`;
  }

  render() {
    const d = this.data;
    return html`
      <div class="wrap" data-testid="mcp-clients-setup">
        <div class="top">
          <span class="lead-s">Use InfiniBot's tools (memory, tasks, agents, your browser) from the AI apps you already use.</span>
          ${this.skippable
            ? html`<button type="button" class="link" data-testid="mcp-skip" @click=${() => this.skip()}>Skip for now</button>`
            : nothing}
        </div>
        ${this.error ? html`<div class="result bad" role="alert">${icon("alertCircle")}${this.error}</div>` : nothing}
        ${!d
          ? html`<div class="hint"><span class="spin"></span>Looking for AI apps on this computer…</div>`
          : d.cloud
            ? this.renderCloud()
            : html`<section class="card">
                  <h4>Your AI apps</h4>
                  ${this.renderClients(d)} ${this.renderSnippets(d)}
                </section>
                ${this.renderTest()}`}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--c-text, #eaeaea);
      font: inherit;
    }
    .wrap {
      display: grid;
      gap: 14px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .lead-s {
      color: var(--c-text-2, #a8a8a8);
      font-size: 13.5px;
      flex: 1 1 260px;
    }
    .lead {
      margin: 0;
      line-height: 1.5;
    }
    .link {
      background: none;
      border: 0;
      color: var(--c-text-2, #a8a8a8);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      min-height: 44px;
    }
    .card {
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      padding: 16px 18px;
      background: rgba(255, 255, 255, 0.025);
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    h4 {
      margin: 0;
      font-size: 15px;
    }
    .clients {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .clients li {
      display: grid;
      grid-template-columns: minmax(150px, auto) auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.06);
      min-width: 0;
    }
    .clients li.is-off {
      opacity: 0.6;
    }
    .clients label {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      min-height: 32px;
    }
    .clients input {
      width: 18px;
      height: 18px;
      accent-color: var(--g-primary, #d4af37);
    }
    .name {
      font-weight: 600;
    }
    .cfg {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: var(--c-text-2, #a8a8a8);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      white-space: nowrap;
      justify-self: start;
    }
    .chip svg {
      width: 12px;
      height: 12px;
    }
    .chip.ok {
      color: #6ee7a8;
      border-color: rgba(110, 231, 168, 0.4);
    }
    .chip.found {
      color: var(--g-primary, #d4af37);
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent);
    }
    .chip.warn {
      color: #f6c56b;
      border-color: rgba(246, 197, 107, 0.4);
    }
    .chip.idle {
      color: var(--c-text-2, #a8a8a8);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .hint {
      margin: 0;
      color: var(--c-text-2, #a8a8a8);
      font-size: 13px;
      line-height: 1.5;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 16px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn svg {
      width: 16px;
      height: 16px;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .btn--primary {
      background: linear-gradient(180deg, #e6c45a, var(--g-primary, #d4af37));
      color: #17130a;
      border-color: transparent;
      font-weight: 600;
    }
    .results,
    .calls {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 8px;
    }
    .results li {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-size: 13.5px;
      min-width: 0;
    }
    .results li > div {
      min-width: 0;
    }
    .results li svg {
      width: 16px;
      height: 16px;
      flex: none;
      margin-top: 2px;
    }
    .results li.ok svg {
      color: #6ee7a8;
    }
    .results li.bad {
      color: #fca5a5;
    }
    .sub {
      display: block;
      color: var(--c-text-2, #a8a8a8);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .sub-i {
      color: var(--c-text-2, #a8a8a8);
    }
    code {
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .more summary {
      cursor: pointer;
      color: var(--c-text-2, #a8a8a8);
      font-size: 13px;
      padding: 6px 0;
      min-height: 32px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0;
    }
    .tab {
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: transparent;
      color: var(--c-text-2, #a8a8a8);
      border-radius: 999px;
      padding: 6px 12px;
      font: inherit;
      font-size: 12.5px;
      cursor: pointer;
      min-height: 36px;
    }
    .tab.is-on {
      color: var(--g-primary, #d4af37);
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
    }
    .snippet {
      margin: 0 0 10px;
      padding: 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-family: ui-monospace, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 260px;
      overflow: auto;
    }
    .note,
    .result {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 13.5px;
      line-height: 1.45;
      background: rgba(246, 197, 107, 0.08);
      color: #f6c56b;
    }
    .note svg,
    .result svg {
      width: 16px;
      height: 16px;
      flex: none;
      margin-top: 2px;
    }
    .result.ok {
      background: rgba(110, 231, 168, 0.1);
      color: #6ee7a8;
    }
    .result.bad {
      background: rgba(248, 113, 113, 0.1);
      color: #fca5a5;
    }
    .calls li {
      font-size: 12.5px;
      color: var(--c-text, #eaeaea);
    }
    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 12px;
    }
    .steps li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .steps .n {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
      color: var(--g-primary, #d4af37);
      font-size: 12px;
      flex: none;
    }
    .spin {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      display: inline-block;
      animation: spin 0.8s linear infinite;
      margin-right: 6px;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (max-width: 720px) {
      .clients li {
        grid-template-columns: 1fr auto;
      }
      .cfg {
        grid-column: 1 / -1;
      }
      .btn {
        flex: 1 1 auto;
        justify-content: center;
      }
      .card {
        padding: 14px;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-mcp-clients-setup": McpClientsSetup;
  }
}
