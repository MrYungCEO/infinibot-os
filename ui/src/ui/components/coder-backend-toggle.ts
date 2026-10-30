/**
 * CoderBackendToggle — settings panel widget for selecting the active coding backend.
 *
 * Used in Setup → Coding Backend section (setup.ts).
 * COORDINATION: opencode-swap — new file.
 */

import { html, nothing } from "lit";
import "./provider-logo.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type CoderBackendId = "claude-code" | "opencode" | "codex" | "gemini" | "grok";

interface CoderCapabilities {
  supportsStreamJson?: boolean;
  supportsMcpConfig?: boolean;
  supportsSessionResume?: boolean;
  supportsParallelSessions?: boolean;
  modelFormat?: "name" | "provider/name";
}

interface CoderBackendEntry {
  id: CoderBackendId;
  displayName: string;
  description: string;
  installed: boolean;
  version?: string;
  binPath?: string;
  installHint?: string;
  capabilities?: CoderCapabilities;
  mcpRegistered?: boolean;
  mcpPath?: string;
}

const BACKEND_DISPLAY_NAME: Record<CoderBackendId, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

/** "grok 0.1.42" / "2.1.0 (Claude Code)" → the x.y.z part. */
function shortVersion(raw: string): string {
  return raw.match(/\d+\.\d+[\w.+-]*/)?.[0] ?? raw;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _state: {
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  active: CoderBackendId;
  backends: CoderBackendEntry[];
  error: string | null;
  success: string | null;
  testResult: "idle" | "running" | "pass" | "fail";
  testMessage: string;
  copiedInstall: CoderBackendId | null;
  mcpInstalling: CoderBackendId | null;
} = {
  loading: true,
  refreshing: false,
  saving: false,
  active: "claude-code",
  mcpInstalling: null,
  backends: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      description: "Anthropic's official CLI coding agent. Deep tool-use, InfiniBot skill/memory integration, and native Claude model support.",
      installed: true,
      installHint: "npm i -g @anthropic-ai/claude-code",
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      description: "Open-source coding agent supporting 75+ providers — Anthropic, OpenAI, Gemini, Ollama, local models, and more.",
      installed: false,
      installHint: "npm install -g opencode-ai@latest",
    },
    {
      id: "codex",
      displayName: "Codex CLI",
      description: "OpenAI's official CLI coding agent. Supports GPT-5 and ChatGPT OAuth authentication.",
      installed: false,
      installHint: "npm install -g @openai/codex",
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      description: "Google's official CLI coding agent. Needs a Gemini API key or a paid Google plan (free Google accounts are rejected).",
      installed: false,
      installHint: "npm install -g @google/gemini-cli",
    },
    {
      id: "grok",
      displayName: "Grok Build",
      description: "xAI's Grok Build CLI. Runs grok-* models on your SuperGrok / X Premium+ sign-in or an xAI API key.",
      installed: false,
      installHint: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
  ],
  error: null,
  success: null,
  testResult: "idle",
  testMessage: "",
  copiedInstall: null,
};

let _loaded = false;
let _focusBound = false;
// Keep the latest requestUpdate so the focus/visibility listeners can re-render.
let _lastRequestUpdate: (() => void) | null = null;

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Fetch live detection state from the gateway.
 *
 * `silent` keeps the already-rendered cards visible during a refresh (used by
 * refresh-on-focus and the manual Refresh button) so the panel doesn't flash
 * back to a "Loading…" skeleton on every tab focus. The very first load is
 * non-silent so the skeleton shows while we have nothing real yet.
 */
async function loadToggleState(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  opts: { silent?: boolean } = {},
): Promise<void> {
  if (opts.silent) {
    if (_state.refreshing) return; // coalesce concurrent refreshes
    _state = { ..._state, refreshing: true };
  } else {
    _state = { ..._state, loading: true };
  }
  requestUpdate();
  try {
    // The gateway RPC carries the connection's own credential; the plain
    // /api/coder/* fetches are rejected on a token-auth gateway (no cookie),
    // which left every card on the "not installed" placeholders.
    let active: unknown;
    let backends: unknown;
    try {
      const res = await client.request<{ backends?: unknown; active?: unknown }>(
        "coder.backends.list",
        {},
      );
      active = res?.active;
      backends = res?.backends;
    } catch {
      // Older gateway without the RPC: fall back to the HTTP routes.
      // Cache-bust so a focus refresh never serves a stale detection result.
      const bust = `?_=${Date.now()}`;
      const [backendRes, backendsRes] = await Promise.all([
        fetch(`/api/coder/backend${bust}`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/coder/backends${bust}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      active = (backendRes as Record<string, unknown>)?.backend;
      backends = (backendsRes as Record<string, unknown>)?.backends;
    }
    _state.active = (active as CoderBackendId) ?? "claude-code";
    if (Array.isArray(backends)) {
      _state.backends = (backends as Record<string, unknown>[]).map((b) => {
        const mcp = b.mcp as Record<string, unknown> | undefined;
        const install = b.install as Record<string, unknown> | undefined;
        return {
          id: b.id as CoderBackendId,
          displayName: (b.displayName ?? b.id) as string,
          description: (b.description ?? "") as string,
          installed: (install?.installed ?? false) as boolean,
          version: install?.version as string | undefined,
          binPath: install?.binPath as string | undefined,
          installHint: install?.installHint as string | undefined,
          capabilities: b.capabilities as CoderCapabilities | undefined,
          mcpRegistered: (mcp?.registered ?? false) as boolean,
          mcpPath: mcp?.path as string | undefined,
        };
      });
    }
    _state = { ..._state, error: null };
  } catch {
    // keep defaults / last-known state on network error
  } finally {
    _state = { ..._state, loading: false, refreshing: false };
    requestUpdate();
  }
}

/**
 * Re-run detection whenever the user returns to this tab/window. CLIs are often
 * installed in another terminal while this page sits open; without this the
 * panel would show a stale "not installed" until a full reload.
 */
function bindFocusRefresh(client: GatewayBrowserClient): void {
  if (_focusBound || typeof window === "undefined") return;
  _focusBound = true;
  const refresh = () => {
    if (!_loaded) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (_lastRequestUpdate) void loadToggleState(client, _lastRequestUpdate, { silent: true });
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function switchBackend(
  id: CoderBackendId,
  requestUpdate: () => void,
): Promise<void> {
  const backend = _state.backends.find((b) => b.id === id);
  if (backend && !backend.installed) {
    _state = {
      ..._state,
      error: `${backend.displayName} is not installed.\n\nRun: ${backend.installHint ?? "see docs"}`,
    };
    requestUpdate();
    return;
  }
  _state = { ..._state, saving: true, error: null, success: null };
  requestUpdate();
  try {
    const res = await fetch("/api/coder/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: id }),
    });
    const body = (await res.json()) as { backend?: string; error?: string; installHint?: string };
    if (!res.ok) {
      let msg = body.error ?? `HTTP ${res.status}`;
      if (body.installHint) msg += `\n\nInstall: ${body.installHint}`;
      _state = { ..._state, error: msg };
    } else {
      _state = {
        ..._state,
        active: (body.backend as CoderBackendId) ?? id,
        success: `Switched to ${BACKEND_DISPLAY_NAME[id] ?? id}.`,
      };
      // Notify the topbar pill to refresh its label
      window.dispatchEvent(
        new CustomEvent("infinibot:coder-backend-changed", { detail: { backend: _state.active } }),
      );
      setTimeout(() => {
        _state = { ..._state, success: null };
        requestUpdate();
      }, 3000);
    }
  } catch (e) {
    _state = { ..._state, error: (e as Error).message };
  } finally {
    _state = { ..._state, saving: false };
    requestUpdate();
  }
}

async function installInfinibotMcp(
  id: CoderBackendId,
  requestUpdate: () => void,
  opts: { force?: boolean } = {},
): Promise<void> {
  _state = { ..._state, mcpInstalling: id, error: null, success: null };
  requestUpdate();
  try {
    const res = await fetch("/api/coder/mcp-install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: id, force: opts.force === true }),
    });
    const body = (await res.json()) as {
      backend?: string;
      path?: string;
      changed?: boolean;
      registered?: boolean;
      error?: string;
    };
    if (!res.ok) {
      _state = { ..._state, error: body.error ?? `HTTP ${res.status}` };
    } else {
      _state.backends = _state.backends.map((b) =>
        b.id === id ? { ...b, mcpRegistered: true, mcpPath: body.path ?? b.mcpPath } : b,
      );
      _state = {
        ..._state,
        success: body.changed
          ? `Installed InfiniBot MCP into ${id}.`
          : `InfiniBot MCP already registered in ${id}.`,
      };
      setTimeout(() => {
        _state = { ..._state, success: null };
        requestUpdate();
      }, 3000);
    }
  } catch (e) {
    _state = { ..._state, error: (e as Error).message };
  } finally {
    _state = { ..._state, mcpInstalling: null };
    requestUpdate();
  }
}

async function runTestSpawn(requestUpdate: () => void): Promise<void> {
  _state = { ..._state, testResult: "running", testMessage: "Spawning test task…" };
  requestUpdate();
  try {
    const res = await fetch("/api/coder/test-spawn", { method: "POST" });
    const body = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    if (res.ok && body.ok) {
      _state = { ..._state, testResult: "pass", testMessage: body.message ?? "Backend responded successfully." };
    } else {
      _state = {
        ..._state,
        testResult: "fail",
        testMessage: body.error ?? body.message ?? `HTTP ${res.status}`,
      };
    }
  } catch (e) {
    _state = { ..._state, testResult: "fail", testMessage: (e as Error).message };
  }
  requestUpdate();
}

// ── Capability chips ──────────────────────────────────────────────────────────

function renderCapabilityChips(caps: CoderCapabilities) {
  const chips: Array<{ label: string; active: boolean }> = [
    { label: "Stream JSON", active: !!caps.supportsStreamJson },
    { label: "MCP Config", active: !!caps.supportsMcpConfig },
    { label: "Session Resume", active: !!caps.supportsSessionResume },
    { label: "Parallel Sessions", active: !!caps.supportsParallelSessions },
    {
      label: caps.modelFormat === "provider/name" ? "Multi-provider" : "Anthropic native",
      active: true,
    },
  ];
  return html`
    <div class="cbs-caps-row">
      ${chips.map(
        (c) => html`
        <span class="cbs-cap ${c.active ? "cbs-cap--on" : "cbs-cap--off"}">${c.label}</span>
      `,
      )}
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────────────────────

export function renderCoderBackendToggle(
  state: AppViewState,
  client: GatewayBrowserClient,
): ReturnType<typeof html> {
  const requestUpdate = () => state.requestUpdate?.();
  _lastRequestUpdate = requestUpdate;
  bindFocusRefresh(client);

  if (!_loaded) {
    _loaded = true;
    void loadToggleState(client, requestUpdate);
  }

  const s = _state;

  return html`
    <div class="cbs-root">
      <div class="cbs-header">
        <div class="cbs-header-row">
          <h2 class="cbs-title">Coding Backend</h2>
          <button
            class="cbs-refresh-btn"
            ?disabled=${s.loading || s.refreshing}
            title="Re-detect installed CLIs"
            @click=${() => loadToggleState(client, requestUpdate, { silent: true })}
          >
            ${s.refreshing ? "Detecting…" : "↻ Refresh"}
          </button>
        </div>
        <p class="cbs-subtitle">
          Choose which CLI coding agent powers
          <code class="cbs-code">claude_coder</code> spawns.
          Switching takes effect immediately — no restart required.
          Detection re-runs automatically when you return to this tab.
        </p>
      </div>

      ${s.loading
        ? html`<div class="loading-spinner">Loading…</div>`
        : html`
          <div class="cbs-cards">
            ${s.backends.map(
              (b) => html`
              <div class="cbs-card ${s.active === b.id ? "cbs-card--active" : ""} ${!b.installed ? "cbs-card--uninstalled" : ""}">
                <div class="cbs-card-body">
                  <div class="cbs-name-row">
                    <ib-provider-logo provider=${b.id} label=${b.displayName} size="28"></ib-provider-logo>
                    <span class="cbs-name">${b.displayName}</span>
                    ${b.installed
                      ? html`<span class="cbs-badge cbs-badge--ok">${b.version ? `v${shortVersion(b.version)}` : "✓ installed"}</span>`
                      : html`<span class="cbs-badge cbs-badge--warn">✗ not installed</span>`}
                    ${s.active === b.id
                      ? html`<span class="cbs-badge cbs-badge--active">active</span>`
                      : nothing}
                  </div>
                  <p class="cbs-desc">${b.description}</p>
                  ${b.installed && b.binPath
                    ? html`<div class="cbs-binpath" title=${b.binPath}>
                        <span class="cbs-binpath-label">Detected at</span>
                        <code class="cbs-binpath-val">${b.binPath}</code>
                      </div>`
                    : nothing}
                  ${b.capabilities ? renderCapabilityChips(b.capabilities) : nothing}
                  ${!b.installed && b.installHint
                    ? html`
                      <div class="cbs-install-row">
                        <code class="cbs-install-cmd">${b.installHint}</code>
                        <button
                          class="cbs-copy-btn"
                          title="Copy install command"
                          @click=${async () => {
                            await navigator.clipboard.writeText(b.installHint ?? "");
                            _state = { ..._state, copiedInstall: b.id };
                            requestUpdate();
                            setTimeout(() => {
                              _state = { ..._state, copiedInstall: null };
                              requestUpdate();
                            }, 1800);
                          }}
                        >${s.copiedInstall === b.id ? "Copied!" : "Copy"}</button>
                      </div>
                    `
                    : nothing}
                  <div class="cbs-mcp-row" title=${b.mcpPath ?? ""}>
                    <span class="cbs-mcp-label">InfiniBot MCP</span>
                    ${b.mcpRegistered
                      ? html`<span class="cbs-badge cbs-badge--ok">✓ installed</span>`
                      : html`<span class="cbs-badge cbs-badge--warn">✗ not installed</span>`}
                    <button
                      class="cbs-mcp-btn"
                      ?disabled=${!b.installed || s.mcpInstalling === b.id}
                      title=${!b.installed
                        ? `${b.displayName} must be installed first`
                        : b.mcpRegistered
                          ? `Rewrite InfiniBot entry in ${b.mcpPath ?? "config"}`
                          : `Install InfiniBot MCP into ${b.mcpPath ?? b.displayName}`}
                      @click=${() =>
                        installInfinibotMcp(b.id, requestUpdate, { force: b.mcpRegistered })}
                    >
                      ${s.mcpInstalling === b.id
                        ? "Installing…"
                        : b.mcpRegistered
                          ? "Reinstall"
                          : "Install"}
                    </button>
                  </div>
                </div>
                <div class="cbs-card-action">
                  ${s.active !== b.id
                    ? html`
                      <button
                        class="cbs-use-btn ${!b.installed ? "cbs-use-btn--warn" : ""}"
                        ?disabled=${s.saving}
                        @click=${() => switchBackend(b.id, requestUpdate)}
                      >
                        ${s.saving ? "Switching…" : b.installed ? "Use this" : "Not installed"}
                      </button>
                    `
                    : html`
                      <button class="cbs-use-btn cbs-use-btn--active" disabled>Active</button>
                    `}
                </div>
              </div>
            `,
            )}
          </div>

          ${s.error
            ? html`<div class="cbs-msg cbs-msg--error">${s.error}</div>`
            : nothing}
          ${s.success
            ? html`<div class="cbs-msg cbs-msg--ok">${s.success}</div>`
            : nothing}

          <!-- Test spawn -->
          <div class="cbs-test-panel">
            <div class="cbs-test-panel-title">Test Backend</div>
            <p class="cbs-test-panel-desc">
              Verify the active backend can spawn. Checks install status and binary health.
            </p>
            <div class="cbs-test-row">
              <button
                class="cbs-test-btn"
                ?disabled=${s.testResult === "running"}
                @click=${() => runTestSpawn(requestUpdate)}
              >
                ${s.testResult === "running" ? "Running…" : "Test spawn"}
              </button>
              ${s.testResult === "pass"
                ? html`<span class="cbs-test-result cbs-test-result--pass">✓ ${s.testMessage}</span>`
                : nothing}
              ${s.testResult === "fail"
                ? html`<span class="cbs-test-result cbs-test-result--fail">✗ ${s.testMessage}</span>`
                : nothing}
            </div>
          </div>
        `}
    </div>
  `;
}

/** Reset cached state — for testing or wizard re-entry. */
export function resetCoderBackendToggle(): void {
  _loaded = false;
  _state = {
    ..._state,
    loading: true,
    refreshing: false,
    error: null,
    success: null,
    testResult: "idle",
    mcpInstalling: null,
  };
}
