/**
 * Device control for a federation satellite, opened from Fleet node cards.
 *
 * Everything runs ON the satellite through `federation.node.invoke`
 * (master → hub → satellite gateway), so it uses the same permission model
 * as every other cross-node call:
 *   - device.info        hostname / OS / CPU / RAM / feature flags
 *   - device.screenshot  the satellite's screen (PNG)
 *   - exec.run           one-shot command, stdout/stderr/exit code
 *   - Terminal           opens Terminals › New with this device preselected
 *   - federation.devices.remove  unpair (the device needs a new invite)
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";

export interface DeviceInfo {
  hostname: string;
  os: { platform: string; type: string; release: string; arch: string };
  cpu: { model: string; cores: number };
  memoryMB: number;
  gpu?: { name: string };
  features: Record<string, boolean>;
  clis: string[];
}

export interface DeviceControlState {
  open: boolean;
  nodeId: string;
  nodeName: string;
  info: DeviceInfo | null;
  infoError: string | null;
  shot: { src: string; width?: number; height?: number; at: number; backend?: string } | null;
  shotLoading: boolean;
  shotError: string | null;
  command: string;
  running: boolean;
  output: { stdout: string; stderr: string; exitCode: number; command: string } | null;
  runError: string | null;
  removing: boolean;
  removed: boolean;
}

export function createDeviceControlState(): DeviceControlState {
  return {
    open: false,
    nodeId: "",
    nodeName: "",
    info: null,
    infoError: null,
    shot: null,
    shotLoading: false,
    shotError: null,
    command: "",
    running: false,
    output: null,
    runError: null,
    removing: false,
    removed: false,
  };
}

type InvokeResult<T> = { status?: string; payload?: T; error?: { message?: string } };

async function invokeOnNode<T>(
  client: GatewayBrowserClient,
  nodeId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await client.request<InvokeResult<T> | T>("federation.node.invoke", { nodeId, method, params });
  const wrapped = res as InvokeResult<T>;
  if (wrapped && typeof wrapped === "object" && "payload" in wrapped) return wrapped.payload as T;
  return res as T;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error:\s*/, "");
}

export function openDeviceControl(
  state: DeviceControlState,
  client: GatewayBrowserClient | null,
  node: { nodeId: string; nodeName: string },
  requestUpdate: () => void,
): void {
  Object.assign(state, createDeviceControlState(), { open: true, nodeId: node.nodeId, nodeName: node.nodeName });
  requestUpdate();
  if (!client) return;
  invokeOnNode<DeviceInfo>(client, node.nodeId, "device.info")
    .then((info) => {
      state.info = info;
      requestUpdate();
    })
    .catch((err) => {
      state.infoError = errText(err);
      requestUpdate();
    });
  void takeScreenshot(state, client, requestUpdate);
}

export async function takeScreenshot(
  state: DeviceControlState,
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): Promise<void> {
  state.shotLoading = true;
  state.shotError = null;
  requestUpdate();
  try {
    const r = await invokeOnNode<{ base64: string; mime: string; width?: number; height?: number; backend?: string }>(
      client,
      state.nodeId,
      "device.screenshot",
      { maxWidth: 1600 },
    );
    state.shot = { src: `data:${r.mime};base64,${r.base64}`, width: r.width, height: r.height, at: Date.now(), backend: r.backend };
  } catch (err) {
    state.shotError = errText(err);
  } finally {
    state.shotLoading = false;
    requestUpdate();
  }
}

async function runCommand(state: DeviceControlState, client: GatewayBrowserClient, requestUpdate: () => void) {
  const command = state.command.trim();
  if (!command || state.running) return;
  state.running = true;
  state.runError = null;
  requestUpdate();
  try {
    const r = await invokeOnNode<{ stdout: string; stderr: string; exitCode: number }>(client, state.nodeId, "exec.run", {
      command,
      timeout: 60,
    });
    state.output = { ...r, command };
  } catch (err) {
    state.runError = errText(err);
  } finally {
    state.running = false;
    requestUpdate();
  }
}

async function removeDevice(state: DeviceControlState, client: GatewayBrowserClient, requestUpdate: () => void) {
  if (!confirm(`Remove "${state.nodeName}" from this federation? It disconnects now and needs a new invite to join again.`)) return;
  state.removing = true;
  requestUpdate();
  try {
    await client.request("federation.devices.remove", { id: state.nodeId, nodeId: state.nodeId });
    state.removed = true;
  } catch (err) {
    state.runError = errText(err);
  } finally {
    state.removing = false;
    requestUpdate();
  }
}

export interface DeviceControlProps {
  state: DeviceControlState;
  client: GatewayBrowserClient | null;
  requestUpdate: () => void;
  onOpenTerminal: (nodeId: string) => void;
}

function featureChips(info: DeviceInfo): TemplateResult {
  const labels: Array<[string, string]> = [
    ["terminal", "Terminal"],
    ["exec", "Commands"],
    ["screenshot", "Screenshot"],
    ["input", "Mouse & keys"],
    ["files", "Files"],
    ["browser", "Browser"],
    ["voice", "Voice"],
  ];
  return html`<div class="fdc-chips">
    ${labels.map(([k, l]) => html`<span class="fdc-chip ${info.features?.[k] ? "" : "off"}">${l}</span>`)}
    ${info.clis?.map((c) => html`<span class="fdc-chip cli">${c}</span>`)}
  </div>`;
}

export function renderDeviceControl(props: DeviceControlProps): TemplateResult | typeof nothing {
  const { state, client, requestUpdate } = props;
  if (!state.open) return nothing;
  const close = () => {
    state.open = false;
    requestUpdate();
  };
  const info = state.info;
  return html`
    ${renderDeviceControlStyles()}
    <div class="fdc-overlay" @click=${(e: Event) => e.target === e.currentTarget && close()}>
      <section class="fdc-modal" role="dialog" aria-label="Device ${state.nodeName}">
        <header class="fdc-head">
          <div>
            <div class="fdc-eyebrow">Satellite device</div>
            <h2 class="fdc-title">${state.nodeName}</h2>
            <div class="fdc-sub">
              ${info
                ? `${info.hostname} · ${info.os.type} ${info.os.release} (${info.os.arch}) · ${info.cpu.cores} threads · ${(info.memoryMB / 1024).toFixed(1)} GB RAM${info.gpu?.name ? ` · ${info.gpu.name}` : ""}`
                : state.infoError
                  ? `Could not read device info: ${state.infoError}`
                  : "Reading device info…"}
            </div>
            ${info ? featureChips(info) : nothing}
          </div>
          <button class="fdc-x" title="Close" @click=${close}>✕</button>
        </header>

        ${state.removed
          ? html`<div class="fdc-note ok">Removed. "${state.nodeName}" was disconnected and must join again with a new invite.</div>`
          : html`
              <div class="fdc-actions">
                <button class="fdc-btn primary" @click=${() => props.onOpenTerminal(state.nodeId)}>Open terminal on this device</button>
                <button class="fdc-btn" ?disabled=${state.shotLoading || !client} @click=${() => client && void takeScreenshot(state, client, requestUpdate)}>
                  ${state.shotLoading ? "Capturing…" : "Refresh screenshot"}
                </button>
                <span class="fdc-spacer"></span>
                <button class="fdc-btn danger" ?disabled=${state.removing || !client} @click=${() => client && void removeDevice(state, client, requestUpdate)}>
                  ${state.removing ? "Removing…" : "Remove device"}
                </button>
              </div>

              <div class="fdc-grid">
                <div class="fdc-panel fdc-shot">
                  <div class="fdc-label">Screen</div>
                  ${state.shot
                    ? html`<img class="fdc-img" alt="Screenshot of ${state.nodeName}" src=${state.shot.src} />
                        <div class="fdc-meta">${state.shot.width}×${state.shot.height} · ${new Date(state.shot.at).toLocaleTimeString()} · ${state.shot.backend ?? ""}</div>`
                    : state.shotError
                      ? html`<div class="fdc-note bad">${state.shotError}</div>`
                      : html`<div class="fdc-note">Capturing the screen…</div>`}
                </div>
                <div class="fdc-panel">
                  <div class="fdc-label">Run a command on ${state.nodeName}</div>
                  <form
                    class="fdc-run"
                    @submit=${(e: Event) => {
                      e.preventDefault();
                      if (client) void runCommand(state, client, requestUpdate);
                    }}
                  >
                    <input
                      class="fdc-input"
                      .value=${state.command}
                      placeholder=${info?.os.platform === "win32" ? "e.g. hostname & dir %TEMP%" : "e.g. hostname && ls ~"}
                      @input=${(e: Event) => {
                        state.command = (e.target as HTMLInputElement).value;
                      }}
                    />
                    <button class="fdc-btn primary" type="submit" ?disabled=${state.running || !client}>${state.running ? "Running…" : "Run"}</button>
                  </form>
                  ${state.runError ? html`<div class="fdc-note bad">${state.runError}</div>` : nothing}
                  ${state.output
                    ? html`<pre class="fdc-out"><span class="fdc-cmd">$ ${state.output.command}</span>
${state.output.stdout}${state.output.stderr ? html`<span class="fdc-err">${state.output.stderr}</span>` : nothing}
<span class="fdc-exit">exit ${state.output.exitCode}</span></pre>`
                    : nothing}
                </div>
              </div>
            `}
      </section>
    </div>
  `;
}

function renderDeviceControlStyles(): TemplateResult {
  return html`<style>
    .fdc-overlay { position: fixed; inset: 0; z-index: 9000; background: rgba(0,0,0,.55); backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center; padding: 24px; }
    .fdc-modal { width: min(1180px, 96vw); max-height: 92vh; overflow: auto; border-radius: 18px; padding: 20px 22px;
      background: linear-gradient(180deg, rgba(22,22,26,.96), rgba(12,12,14,.96)); border: 1px solid rgba(246,200,115,.22);
      box-shadow: 0 30px 80px rgba(0,0,0,.55); color: var(--g-text, #e4e4e7); }
    .fdc-head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
    .fdc-eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: rgba(246,200,115,.8); }
    .fdc-title { margin: 2px 0 4px; font-size: 22px; font-weight: 650; }
    .fdc-sub { font-size: 12.5px; color: #a1a1aa; }
    .fdc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .fdc-chip { font-size: 11.5px; padding: 3px 9px; border-radius: 8px; border: 1px solid rgba(246,200,115,.25); }
    .fdc-chip.off { color: #71717a; border-color: rgba(113,113,122,.3); text-decoration: line-through; }
    .fdc-chip.cli { color: #f6c873; }
    .fdc-x { background: none; border: 0; color: #a1a1aa; font-size: 18px; cursor: pointer; }
    .fdc-actions { display: flex; gap: 8px; align-items: center; margin: 16px 0 12px; flex-wrap: wrap; }
    .fdc-spacer { flex: 1; }
    .fdc-btn { font: 600 13px/1 inherit; padding: 9px 13px; border-radius: 10px; border: 1px solid rgba(246,200,115,.25);
      background: rgba(39,39,42,.7); color: inherit; cursor: pointer; }
    .fdc-btn:hover { border-color: rgba(246,200,115,.6); }
    .fdc-btn.primary { background: linear-gradient(180deg,#f6c873,#d9a441); color: #141414; border-color: transparent; }
    .fdc-btn.danger { color: #fca5a5; border-color: rgba(239,68,68,.4); }
    .fdc-btn:disabled { opacity: .55; cursor: default; }
    .fdc-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 14px; }
    @media (max-width: 860px) { .fdc-grid { grid-template-columns: 1fr; } }
    .fdc-panel { border: 1px solid rgba(246,200,115,.14); border-radius: 14px; padding: 12px; background: rgba(255,255,255,.02); min-width: 0; }
    .fdc-label { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #a1a1aa; margin-bottom: 8px; }
    .fdc-img { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid rgba(255,255,255,.08); background: #000; }
    .fdc-meta { font-size: 11.5px; color: #71717a; margin-top: 6px; }
    .fdc-run { display: flex; gap: 8px; }
    .fdc-input { flex: 1; min-width: 0; padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(246,200,115,.2);
      background: rgba(0,0,0,.35); color: inherit; font: 13px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .fdc-out { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,.45); max-height: 340px; overflow: auto;
      font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
    .fdc-cmd { color: #f6c873; } .fdc-err { color: #fca5a5; } .fdc-exit { color: #71717a; }
    .fdc-note { font-size: 13px; color: #a1a1aa; padding: 10px; } .fdc-note.bad { color: #fca5a5; } .fdc-note.ok { color: #86efac; }
  </style>`;
}
