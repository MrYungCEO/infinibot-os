/**
 * InfiCode — terminal-themed mesh command center (custom element).
 *
 * A single served view (route /inficode) that renders a simplified, live-
 * reactive twin of the isometric Agent Ops map plus side panels, with 1:1
 * control parity to the real map/CLI.
 *
 * Data spine is REUSED verbatim:
 *   • controllers/agent-mesh.ts — loadMeshStatus() 5s polling snapshot + the
 *     module meshState store (nodes/agents/messages/mcp/tasks).
 *   • controllers/agency-data-bridge.ts — AgencyDataBridge live WS stream,
 *     applied as sub-second deltas onto the same meshState maps.
 * Hardware streams via the SSE element <inficode-hardware>. The embedded coder
 * reuses the xterm directive + terminals controller + PTY client.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { INFICODE_STYLES } from "./styles.js";
import { readPluginAppearance } from "../../../../../src/plugin-sdk/appearance-client.js";
import { renderMeshMap } from "./mesh-map.js";
import { renderFleetPanel } from "./fleet-panel.js";
import { renderDevicesPanel } from "./devices-panel.js";
import { renderMeshPanel } from "./mesh-panel.js";
import { renderCoderPanel } from "./coder-panel.js";
import { renderCommandBar } from "./command-bar.js";
import "./hardware-panel.js"; // registers <inficode-hardware>
import * as rpc from "./rpc.js";
import { FleetBridge } from "./fleet-bridge.js";
import type { FleetRecord } from "./fleet-types.js";

import {
  getMeshState,
  loadMeshStatus,
  type MeshNode,
  type MeshAgent,
  type MeshMessage,
} from "../../controllers/agent-mesh.js";
import { AgencyDataBridge, type WorldEvent } from "../../controllers/agency-data-bridge.js";
import { getGatewayClient } from "../../gateway-client.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import type { AppViewState } from "../../app-view-state.js";
import {
  createInitialTerminalsState,
  type TerminalSession,
} from "../../controllers/terminals.js";
import { destroyPtyProcess } from "../../hooks/usePtyProcess.js";

interface PendingDevice {
  requestId: string;
  deviceId: string;
  displayName?: string;
  role?: string;
  remoteIp?: string;
}

const POLL_MS = 5000;

@customElement("inficode-view")
export class InfiCodeView extends LitElement {
  static styles = INFICODE_STYLES;

  // Injected by app-render (`.state` / `.client`). Both optional — we fall
  // back to the shared gateway client so the view works standalone too.
  state: AppViewState | null = null;
  client: GatewayBrowserClient | null = null;

  @state() selectedNodeId: string | null = null;
  @state() selectedSectorId: string | null = null;
  @state() selectedAgentKey: string | null = null;
  @state() view: "agents" | "fleet" = "agents";
  @state() selectedFleetNodeId: string | null = null;
  @state() coderTask = "";
  @state() spawnTask = "";
  @state() spawnAgentId = "coder";
  @state() private toast: { msg: string; err: boolean } | null = null;

  // Device edit drafts, keyed by nodeId (kept in the UI so role/context are
  // always visible + editable — see rpc.persistDeviceContext for the TODO).
  private roleDrafts = new Map<string, string>();
  private scopeDrafts = new Map<string, string>();
  private contexts = new Map<string, string>();

  // Mesh message log + throughput timestamps (live from bridge WorldEvents).
  private msgLog: MeshMessage[] = [];
  private msgTimestamps: number[] = [];

  private bridge: AgencyDataBridge | null = null;
  private unsubBridge: (() => void) | null = null;
  private fleetBridge: FleetBridge | null = null;
  private unsubFleetBridge: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pairing: { pending: PendingDevice[] } = { pending: [] };
  private activeCoderId: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ── lifecycle ─────────────────────────────────────────────────────────
  override connectedCallback(): void {
    super.connectedCallback();
    // Appearance › Layout "Opens on" (manifest layout option "default-view").
    const opensOn = readPluginAppearance(this, { layoutOptions: ["default-view"] }).layout["default-view"];
    if (opensOn === "fleet" || opensOn === "agents") this.view = opensOn;
    const client = this.gwClient();
    if (client) {
      void loadMeshStatus(client, this.meshShim());
      this.bridge = new AgencyDataBridge(client);
      this.unsubBridge = this.bridge.subscribe((events) => this.applyWorldEvents(events));
      this.fleetBridge = new FleetBridge(client);
      this.unsubFleetBridge = this.fleetBridge.subscribe(() => this.requestUpdate());
      this.pollTimer = setInterval(() => {
        void loadMeshStatus(client, this.meshShim());
        void this.refreshPairing();
      }, POLL_MS);
      void this.refreshPairing();
    }
    this.tickTimer = setInterval(() => this.requestUpdate(), 1000);
    this.ensureCoderSession();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubBridge?.();
    this.bridge?.destroy();
    this.bridge = null;
    this.unsubFleetBridge?.();
    this.fleetBridge?.destroy();
    this.fleetBridge = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.teardownCoderSession();
  }

  override willUpdate(): void {
    // Keep the coder PTY session in sync with the selected device before the
    // xterm directive (which reads state.terminalsState) mounts/re-mounts.
    this.ensureCoderSession();
  }

  gwClient(): GatewayBrowserClient | null {
    return this.client ?? this.state?.client ?? getGatewayClient();
  }

  /** Minimal AppViewState shim so loadMeshStatus can requestUpdate us. */
  private meshShim(): AppViewState {
    return { requestUpdate: () => this.requestUpdate(), client: this.gwClient() } as unknown as AppViewState;
  }

  // ── live data ─────────────────────────────────────────────────────────
  private applyWorldEvents(events: WorldEvent[]): void {
    const st = getMeshState();
    for (const e of events) {
      switch (e.kind) {
        case "node.upsert":
          st.nodes.set(e.node.id, { ...st.nodes.get(e.node.id), ...e.node });
          break;
        case "node.remove":
          st.nodes.delete(e.nodeId);
          break;
        case "agent.spawn": {
          const src = e.agent as unknown as Record<string, unknown> & { sessionKey: string };
          const prev = st.agents.get(src.sessionKey);
          st.agents.set(src.sessionKey, this.mergeAgent(prev, src));
          break;
        }
        case "agent.progress": {
          const a = st.agents.get(e.sessionKey);
          if (a) st.agents.set(e.sessionKey, this.mergeAgent(a, e.patch as Record<string, unknown>));
          break;
        }
        case "agent.complete": {
          const a = st.agents.get(e.sessionKey);
          if (a) {
            a.status = e.success ? "completed" : "failed";
            a.progress = 100;
          }
          break;
        }
        case "agent.message":
          this.pushMessage(e.from, e.to, e.type);
          break;
        case "fed.msg.send":
          this.pushMessage(e.fromNodeId, e.toNodeId, e.messageType);
          break;
        default:
          break;
      }
    }
    this.requestUpdate();
  }

  /**
   * Fold a bridge-shaped agent/patch (activity-map MeshAgent — loose `status`,
   * missing the numeric bookkeeping fields) into the richer agent-mesh
   * MeshAgent shape our store + panels expect.
   */
  private mergeAgent(prev: MeshAgent | undefined, src: Record<string, unknown>): MeshAgent {
    const statusMap: Record<string, MeshAgent["status"]> = {
      starting: "starting",
      idle: "idle",
      working: "working",
      checkpoint: "working",
      blocked: "blocked",
      finishing: "finishing",
      completed: "completed",
      failed: "failed",
    };
    const rawStatus = typeof src.status === "string" ? src.status : undefined;
    const backend = typeof src.coderBackend === "string" ? src.coderBackend : prev?.coderBackend;
    return {
      sessionKey: (src.sessionKey as string) ?? prev?.sessionKey ?? "",
      agentId: (src.agentId as string) ?? prev?.agentId ?? "unknown",
      label: (src.label as string) ?? prev?.label ?? (src.sessionKey as string) ?? "",
      nodeId: (src.nodeId as string) ?? prev?.nodeId ?? "local",
      nodeName: (src.nodeName as string) ?? prev?.nodeName ?? "Local",
      status: (rawStatus ? statusMap[rawStatus] : undefined) ?? prev?.status ?? "working",
      progress: typeof src.progress === "number" ? src.progress : prev?.progress ?? 0,
      currentTask: (src.currentTask as string) ?? prev?.currentTask,
      parent: (src.parent as string) ?? prev?.parent,
      children: (src.children as string[]) ?? prev?.children,
      role: (src.role as MeshAgent["role"]) ?? prev?.role,
      coderBackend: backend === "gemini" ? undefined : (backend as MeshAgent["coderBackend"]),
      lastActivityKind: (src.lastActivityKind as string) ?? prev?.lastActivityKind,
      spawnedAt: prev?.spawnedAt ?? Date.now(),
      lastActivity: Date.now(),
      messageCount: prev?.messageCount ?? 0,
    };
  }

  private pushMessage(from: string, to: string, type: string): void {
    const st = getMeshState();
    const label = (k: string) => st.agents.get(k)?.label || st.nodes.get(k)?.name || k;
    const t: MeshMessage["type"] =
      type === "response" ? "response" : type === "broadcast" ? "broadcast" : type === "event" ? "event" : "request";
    const msg: MeshMessage = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      fromLabel: label(from),
      to,
      toLabel: label(to),
      type: t,
      timestamp: Date.now(),
      delivered: true,
      read: false,
    };
    this.msgLog = [msg, ...this.msgLog].slice(0, 60);
    this.msgTimestamps.push(msg.timestamp);
    if (this.msgTimestamps.length > 600) this.msgTimestamps = this.msgTimestamps.slice(-600);
  }

  async refreshPairing(): Promise<void> {
    const res = await rpc.listPairing(this.gwClient());
    if (res.ok && res.payload && typeof res.payload === "object") {
      const p = (res.payload as { pending?: PendingDevice[] }).pending;
      this.pairing = { pending: Array.isArray(p) ? p : [] };
      this.requestUpdate();
    }
  }

  // ── host surface consumed by map/panels ───────────────────────────────
  nodes(): MeshNode[] {
    const st = getMeshState();
    const agents = Array.from(st.agents.values());
    return Array.from(st.nodes.values())
      .map((n) => ({ ...n, agentCount: agents.filter((a) => (a.nodeId || "local") === n.id).length }))
      .sort((a, b) => (a.role === "hub" ? -1 : b.role === "hub" ? 1 : a.name.localeCompare(b.name)));
  }
  nodeById(id: string): MeshNode | undefined {
    return this.nodes().find((n) => n.id === id);
  }
  visibleAgents(): MeshAgent[] {
    const agents = Array.from(getMeshState().agents.values());
    const filtered = this.selectedNodeId
      ? agents.filter((a) => (a.nodeId || "local") === this.selectedNodeId)
      : agents;
    return filtered.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }
  recentMessages(): MeshMessage[] {
    return this.msgLog;
  }
  throughputBuckets(): number[] {
    const now = Date.now();
    const size = 5000;
    const n = 34;
    const buckets = new Array<number>(n).fill(0);
    for (const t of this.msgTimestamps) {
      const age = now - t;
      if (age < 0 || age > size * n) continue;
      const idx = n - 1 - Math.floor(age / size);
      if (idx >= 0 && idx < n) buckets[idx] += 1;
    }
    return buckets;
  }
  messagesPerMinute(): number {
    const cut = Date.now() - 60000;
    return this.msgTimestamps.filter((t) => t >= cut).length;
  }
  connected(): boolean {
    return !!this.gwClient();
  }
  get appState(): AppViewState | null {
    return this.state;
  }

  selectNode(id: string | null): void {
    this.selectedNodeId = id;
  }
  selectSector(id: string | null): void {
    this.selectedSectorId = id;
  }
  fleetNodes(): FleetRecord[] {
    return this.fleetBridge?.list() ?? [];
  }
  selectFleetNode(id: string | null): void {
    this.selectedFleetNodeId = id;
  }
  setView(v: "agents" | "fleet"): void {
    this.view = v;
  }
  /** "Run maintenance now" — queues a trigger only, no task content; the
   *  target device replays whatever it already ran locally. See the plugin's
   *  PendingCommand type for why this is deliberately content-free. */
  async requestMaintenance(nodeId: string): Promise<void> {
    const client = this.gwClient();
    if (!client) return;
    try {
      await client.request("infinicode.command.request", { nodeId });
      this.showToast(`Maintenance queued for ${nodeId}`);
    } catch (err) {
      this.showToast(`Could not queue maintenance: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
  selectAgent(key: string | null): void {
    this.selectedAgentKey = key;
    if (key) {
      const a = getMeshState().agents.get(key);
      const w = window as unknown as { openAgentFocus?: (agent: unknown) => void };
      if (a && typeof w.openAgentFocus === "function") {
        try {
          w.openAgentFocus(a);
        } catch {
          /* focus is best-effort */
        }
      }
    }
  }

  selectedDeviceLabel(): string {
    if (!this.selectedNodeId || this.selectedNodeId === "local") return "local";
    return this.nodeById(this.selectedNodeId)?.name || this.selectedNodeId;
  }

  // ── device drafts + role/context/pairing/invoke ───────────────────────
  roleDraftFor(id: string): string {
    return this.roleDrafts.get(id) ?? this.nodeById(id)?.role ?? "";
  }
  scopeDraftFor(id: string): string {
    return this.scopeDrafts.get(id) ?? "";
  }
  contextFor(id: string): string {
    return this.contexts.get(id) ?? "";
  }
  setRoleDraft(id: string, v: string): void {
    this.roleDrafts.set(id, v);
  }
  setScopeDraft(id: string, v: string): void {
    this.scopeDrafts.set(id, v);
  }
  setContextDraft(id: string, v: string): void {
    this.contexts.set(id, v);
  }
  pairingPending(): PendingDevice[] {
    return this.pairing.pending;
  }
  /** Currently selected agent (for the command bar control actions). */
  selectedAgent(): MeshAgent | undefined {
    return this.selectedAgentKey ? getMeshState().agents.get(this.selectedAgentKey) : undefined;
  }

  // ── embedded coder PTY session lifecycle ──────────────────────────────
  coderTerminalId(): string {
    return `inficode-coder-${this.selectedNodeId || "local"}`;
  }
  private ensureCoderSession(): void {
    const app = this.state;
    if (!app) return; // no AppViewState → coder panel shows "unavailable"
    if (!app.terminalsState) app.terminalsState = createInitialTerminalsState();
    const ts = app.terminalsState;
    const id = this.coderTerminalId();
    if (this.activeCoderId === id && ts.sessions.some((s) => s.id === id)) return;

    // Drop the previous coder session (different device) + its PTY.
    if (this.activeCoderId && this.activeCoderId !== id) {
      const prevNode = this.activeCoderId.replace("inficode-coder-", "");
      void destroyPtyProcess(this.gwClient()!, this.activeCoderId, prevNode);
      ts.sessions = ts.sessions.filter((s) => s.id !== this.activeCoderId);
    }
    if (!ts.sessions.some((s) => s.id === id)) {
      const session: TerminalSession = {
        id,
        title: "InfiCode Coder",
        cli: "claude",
        status: "idle",
        cwd: ".",
        createdAt: new Date().toISOString(),
        expandedView: false,
        nodeId: this.selectedNodeId || "local",
        nodeName: this.selectedDeviceLabel(),
      };
      ts.sessions = [...ts.sessions, session];
    }
    this.activeCoderId = id;
  }
  private teardownCoderSession(): void {
    const ts = this.state?.terminalsState;
    if (ts && this.activeCoderId) {
      const node = this.activeCoderId.replace("inficode-coder-", "");
      const client = this.gwClient();
      if (client) void destroyPtyProcess(client, this.activeCoderId, node);
      ts.sessions = ts.sessions.filter((s) => s.id !== this.activeCoderId);
    }
    this.activeCoderId = null;
  }

  showToast(msg: string, err = false): void {
    this.toast = { msg, err };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 3200);
  }

  // ── render ────────────────────────────────────────────────────────────
  override render() {
    return html`
      <div class="ic-root">
        <div class="ic-left">
          <div class="ic-view-switch" data-learn-id="inficode-view-switch">
            <button
              data-learn-id="inficode-view-agents"
              class="ic-btn ${this.view === "agents" ? "on" : ""}"
              @click=${() => this.setView("agents")}
            >
              agent ops
            </button>
            <button
              data-learn-id="inficode-view-fleet"
              class="ic-btn ${this.view === "fleet" ? "on" : ""}"
              @click=${() => this.setView("fleet")}
            >
              infinicode fleet
            </button>
          </div>
          ${this.view === "fleet" ? renderFleetPanel(this) : renderMeshMap(this)}
          ${renderDevicesPanel(this)}
        </div>
        <div class="ic-right">
          ${renderMeshPanel(this)}
          <inficode-hardware data-learn-id="inficode-hardware" .selectedNodeId=${this.selectedNodeId}></inficode-hardware>
          ${renderCoderPanel(this)}
        </div>
        ${renderCommandBar(this)}
        ${this.toast
          ? html`<div class="ic-toast ${this.toast.err ? "err" : ""}">${this.toast.msg}</div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inficode-view": InfiCodeView;
  }
}
