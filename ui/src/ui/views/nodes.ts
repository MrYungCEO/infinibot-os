import { html, nothing } from "lit";

import { clampText, formatAgo, formatList } from "../format";
import type {
  ExecApprovalsAllowlistEntry,
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "../controllers/exec-approvals";
import type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../controllers/devices";
import { opsIcon, renderOpsSharedStyles, renderOpsTelemetryRail } from "./ops-glass";

// Device rename state
let renamingDeviceId: string | null = null;
let deviceRenameValue: string = "";

function startDeviceRename(deviceId: string, currentName: string) {
  renamingDeviceId = deviceId;
  deviceRenameValue = currentName;
}

function cancelDeviceRename() {
  renamingDeviceId = null;
  deviceRenameValue = "";
}

export type NodesProps = {
  loading: boolean;
  nodes: Array<Record<string, unknown>>;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  configFormMode: "form" | "raw";
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  onRefresh: () => void;
  onDevicesRefresh: () => void;
  onDeviceApprove: (requestId: string) => void;
  onDeviceReject: (requestId: string) => void;
  onDeviceRotate: (deviceId: string, role: string, scopes?: string[]) => void;
  onDeviceRevoke: (deviceId: string, role: string) => void;
  onDeviceRename?: (deviceId: string, displayName: string) => void;
  onRequestUpdate?: () => void;
  onLoadConfig: () => void;
  onLoadExecApprovals: () => void;
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSaveBindings: () => void;
  onExecApprovalsTargetChange: (kind: "gateway" | "node", nodeId: string | null) => void;
  onExecApprovalsSelectAgent: (agentId: string) => void;
  onExecApprovalsPatch: (path: Array<string | number>, value: unknown) => void;
  onExecApprovalsRemove: (path: Array<string | number>) => void;
  onSaveExecApprovals: () => void;
};

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  const connectedCount = props.nodes.filter((node) => Boolean(node.connected)).length;
  const pairedCount = props.nodes.filter((node) => Boolean(node.paired)).length;
  const devices = props.devicesList ?? { pending: [], paired: [] };
  const pendingCount = Array.isArray(devices.pending) ? devices.pending.length : 0;
  const deviceCount = Array.isArray(devices.paired) ? devices.paired.length : 0;
  return html`
    <div class="ops-page ops-nodes-page" aria-busy=${props.loading || props.devicesLoading ? "true" : "false"}>
      ${renderOpsSharedStyles()}
      ${renderNodesStyles()}
      <header class="ops-hero">
        <div class="ops-hero-copy">
          <div class="ops-eyebrow">Infrastructure / Secure fabric</div>
          <h1 class="ops-title">Node <em>operations</em></h1>
          <p class="ops-subtitle">Command policy, execution routing, device trust, and live node health—composed into one secure operator console.</p>
        </div>
        <div class="ops-live-badge"><span class="ops-status-dot ${connectedCount === 0 ? "offline" : ""}"></span>${connectedCount} connected</div>
      </header>

      <div class="ops-metrics" aria-label="Node summary">
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("server", 13)}Nodes</span><strong class="ops-metric-value accent">${props.nodes.length}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("link", 13)}Connected</span><strong class="ops-metric-value">${connectedCount}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("shield", 13)}Paired</span><strong class="ops-metric-value">${pairedCount + deviceCount}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("radio", 13)}Pending trust</span><strong class="ops-metric-value">${pendingCount}</strong></div>
      </div>

      ${renderOpsTelemetryRail("Node fabric telemetry", [
        { label: "mesh", value: connectedCount > 0 ? "online" : "standby", tone: connectedCount > 0 ? "success" : "warning" },
        { label: "connectivity", value: props.nodes.length ? `${connectedCount}/${props.nodes.length}` : "0/0", tone: connectedCount > 0 ? "accent" : undefined },
        { label: "trust queue", value: pendingCount, tone: pendingCount > 0 ? "warning" : "success" },
        { label: "policy", value: props.execApprovalsDirty ? "unsaved" : "committed", tone: props.execApprovalsDirty ? "warning" : "success" },
      ])}

      <div class="ops-nodes-grid">
        ${renderExecApprovals(approvalsState)}
        ${renderBindings(bindingState)}
      </div>
      ${renderDevices(props)}
      <section class="card ops-nodes-list" data-learn-id="nodes-list">
        <div class="ops-section-head">
          <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("server", 19)}</span><div><h2 class="ops-heading">Live nodes</h2><p class="ops-kicker">Paired execution surfaces and their active capabilities.</p></div></div>
          <button class="btn ops-icon-btn" ?disabled=${props.loading} @click=${props.onRefresh}>${opsIcon("refresh", 15)}${props.loading ? "Loading…" : "Refresh nodes"}</button>
        </div>
        <div class="list ops-node-network" style="margin-top: 20px;">
          ${
            props.loading && props.nodes.length === 0
              ? Array.from(
                  { length: 3 },
                  () =>
                    html`
                      <div class="ops-skeleton" style="min-height: 150px"></div>
                    `,
                )
              : props.nodes.length === 0
                ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("server", 23)}</span><strong>No nodes connected</strong><span>Paired execution nodes will appear here with live capability and connection status.</span></div></div>`
                : props.nodes.map((node) => renderNode(node))
          }
        </div>
      </section>
    </div>
  `;
}

function renderNodesStyles() {
  return html`
    <style>
      .ops-nodes-page .ops-nodes-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
        align-items: start;
      }
      .ops-nodes-page .card {
        position: relative;
        overflow: hidden;
        margin: 0;
        padding: clamp(18px, 2.4vw, 28px);
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius-lg);
        background:
          linear-gradient(
            135deg,
            color-mix(in srgb, var(--g-surface-strong) 78%, transparent),
            color-mix(in srgb, var(--g-surface) 92%, transparent)
          ),
          var(--g-gradient-surface);
        box-shadow:
          var(--g-shadow),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 12%, transparent),
          inset 0 -1px 0 color-mix(in srgb, var(--g-bg-deep) 40%, transparent);
        backdrop-filter: var(--g-blur-heavy);
        -webkit-backdrop-filter: var(--g-blur-heavy);
      }
      .ops-nodes-page .card::before {
        content: "";
        position: absolute;
        inset: 0 12% auto;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in srgb, var(--g-primary) 68%, var(--g-fg)),
          transparent
        );
        opacity: 0.62;
        pointer-events: none;
      }
      .ops-nodes-page .card > .row:first-child {
        align-items: flex-start !important;
        gap: 16px;
      }
      .ops-nodes-page .card-title {
        color: var(--g-fg);
        font-size: 15px;
        font-weight: 650;
        letter-spacing: -0.01em;
      }
      .ops-nodes-page .card-sub {
        margin-top: 5px;
        color: var(--g-fg-dim);
        font-size: 11px;
        line-height: 1.5;
      }
      .ops-nodes-page .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .ops-nodes-page .list {
        display: grid;
        gap: 9px;
      }
      .ops-nodes-page .list-item {
        position: relative;
        align-items: center;
        gap: 18px;
        margin: 0;
        padding: 14px;
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius);
        background: color-mix(in srgb, var(--g-surface) 88%, transparent);
        box-shadow: inset 0 1px 0 color-mix(in srgb, var(--g-fg) 8%, transparent);
        transition:
          transform 160ms ease,
          border-color 160ms ease,
          background 160ms ease,
          box-shadow 160ms ease;
      }
      .ops-nodes-page .list-item:hover {
        transform: translateY(-1px);
        border-color: var(--g-border-strong);
        background: var(--g-surface-hover);
        box-shadow:
          var(--g-shadow-sm),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 11%, transparent);
      }
      .ops-nodes-page .list-title {
        color: var(--g-fg);
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }
      .ops-nodes-page .list-sub,
      .ops-nodes-page .muted {
        color: var(--g-fg-faint);
        font-size: 10px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .ops-nodes-page .list-meta {
        min-width: 180px;
        max-width: 100%;
      }
      .ops-nodes-page .field {
        min-width: 0;
        max-width: 100%;
      }
      .ops-nodes-page .field > span,
      .ops-nodes-page .label {
        color: var(--g-fg-faint);
        font-size: 8px;
        font-weight: 750;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .ops-nodes-page select,
      .ops-nodes-page input:not([type="checkbox"]) {
        min-height: 38px;
      }
      .ops-nodes-page input[type="checkbox"] {
        accent-color: var(--g-primary);
      }
      .ops-nodes-page .chip-row {
        gap: 6px;
      }
      .ops-nodes-page .chip {
        border-color: var(--g-border);
        background: var(--g-surface);
        color: var(--g-fg-dim);
        font-size: 8px;
        font-weight: 650;
      }
      .ops-nodes-page .btn.active {
        border-color: var(--g-border-strong);
        background: var(--g-primary-soft);
        color: var(--g-primary);
        box-shadow: 0 0 18px color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .ops-nodes-page .btn.danger {
        border-color: var(--g-danger-border);
        color: var(--g-danger);
      }
      .ops-nodes-page .btn.danger:hover:not(:disabled) {
        background: var(--g-danger-soft);
        border-color: var(--g-danger-border);
        color: var(--g-danger);
      }
      .ops-nodes-page .callout {
        border-color: var(--g-border);
        border-radius: var(--g-radius-sm);
        background: var(--g-surface);
        color: var(--g-fg-dim);
      }
      .ops-nodes-page .callout.warn {
        border-color: var(--g-warning-border);
        background: var(--g-warning-soft);
      }
      .ops-nodes-page .callout.danger {
        border-color: var(--g-danger-border);
        background: var(--g-danger-soft);
      }
      .ops-nodes-page .ops-device-group-label {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 5px 0 2px;
        color: var(--g-primary);
        font-size: 9px;
        font-weight: 750;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .ops-nodes-page .ops-device-group-label::after {
        content: "";
        height: 1px;
        flex: 1;
        background: linear-gradient(90deg, var(--g-border), transparent);
      }
      .ops-nodes-page .ops-device-card {
        overflow: hidden;
      }
      .ops-nodes-page .ops-device-card::before {
        content: "";
        position: absolute;
        left: 0;
        top: 16px;
        bottom: 16px;
        width: 2px;
        border-radius: 2px;
        background: var(--g-primary);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 56%, transparent);
        opacity: 0.72;
      }
      .ops-nodes-page .ops-token-stack {
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin-top: 8px;
      }
      .ops-nodes-page .ops-token-row {
        padding: 9px 10px;
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius-sm);
        background: color-mix(in srgb, var(--g-bg-deep) 30%, var(--g-surface));
      }
      .ops-nodes-page .device-rename-input {
        width: min(100%, 240px) !important;
        border-color: var(--g-border-strong) !important;
        border-radius: var(--g-radius-sm) !important;
        background: var(--g-surface) !important;
        color: var(--g-primary) !important;
      }
      .ops-nodes-page .ops-node-network {
        position: relative;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        padding-top: 20px;
      }
      .ops-nodes-page .ops-node-network::before {
        content: "";
        position: absolute;
        top: 0;
        left: 8%;
        right: 8%;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent,
          var(--g-border-strong),
          var(--g-primary),
          var(--g-border-strong),
          transparent
        );
        box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 24%, transparent);
      }
      .ops-nodes-page .ops-node-card {
        display: block;
        min-width: 0;
        padding: 17px;
      }
      .ops-nodes-page .ops-node-card::before {
        content: "";
        position: absolute;
        top: -21px;
        left: 50%;
        width: 1px;
        height: 20px;
        background: var(--g-border-strong);
      }
      .ops-nodes-page .ops-node-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .ops-nodes-page .ops-node-identity {
        display: flex;
        align-items: center;
        gap: 11px;
        min-width: 0;
      }
      .ops-nodes-page .ops-node-icon {
        position: relative;
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        flex: none;
        border: 1px solid var(--g-border-strong);
        border-radius: var(--g-radius-sm);
        background: var(--g-primary-soft);
        color: var(--g-primary);
        box-shadow:
          0 0 22px color-mix(in srgb, var(--g-primary) 12%, transparent),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 12%, transparent);
      }
      .ops-nodes-page .ops-node-icon .ops-status-dot {
        position: absolute;
        right: -2px;
        bottom: -2px;
        border: 2px solid var(--g-bg);
      }
      .ops-nodes-page .ops-node-meta {
        margin-top: 13px;
        padding: 10px 11px;
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius-sm);
        background: color-mix(in srgb, var(--g-bg-deep) 36%, var(--g-surface));
      }
      .ops-nodes-page .ops-node-health {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 98px;
        gap: 12px;
        align-items: end;
        margin-top: 13px;
        padding-top: 12px;
        border-top: 1px solid var(--g-border);
      }
      .ops-nodes-page .ops-health-vector {
        display: flex;
        align-items: flex-end;
        justify-content: flex-end;
        gap: 5px;
        height: 34px;
      }
      .ops-nodes-page .ops-health-vector span {
        width: 8px;
        min-height: 4px;
        border-radius: 3px 3px 1px 1px;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--g-primary) 80%, var(--g-fg)),
          var(--g-primary)
        );
        box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 25%, transparent);
      }
      .ops-nodes-page .ops-health-copy {
        color: var(--g-fg-faint);
        font-size: 9px;
        line-height: 1.5;
      }
      .ops-nodes-page .ops-health-copy strong {
        display: block;
        margin-bottom: 4px;
        color: var(--g-fg);
        font-size: 10px;
      }
      @media (max-width: 1100px) {
        .ops-nodes-page .ops-nodes-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 700px) {
        .ops-nodes-page .list-item {
          align-items: stretch;
          flex-direction: column;
        }
        .ops-nodes-page .list-meta {
          width: 100%;
          min-width: 0;
          overflow: hidden;
        }
        .ops-nodes-page .list-meta .field,
        .ops-nodes-page .list-meta select,
        .ops-nodes-page .list-meta input:not([type="checkbox"]) {
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
        }
        .ops-nodes-page .list-meta .field {
          display: block;
          overflow: hidden;
        }
        .ops-nodes-page .ops-node-network {
          grid-template-columns: 1fr;
        }
        .ops-nodes-page .ops-node-network::before,
        .ops-nodes-page .ops-node-card::before {
          display: none;
        }
      }
      @media (max-width: 390px) {
        .ops-nodes-page .card > .row:first-child {
          flex-direction: column;
          align-items: stretch !important;
        }
        .ops-nodes-page .card > .row:first-child > .btn {
          width: 100%;
        }
        .ops-nodes-page .ops-node-health {
          grid-template-columns: 1fr;
        }
        .ops-nodes-page .ops-health-vector {
          justify-content: flex-start;
        }
        .ops-nodes-page .row {
          max-width: 100%;
        }
        .ops-nodes-page .btn {
          white-space: normal;
        }
        .ops-nodes-page .ops-token-row {
          align-items: stretch !important;
          flex-direction: column;
        }
      }
      @media (prefers-reduced-transparency: reduce) {
        .ops-nodes-page .card,
        .ops-nodes-page .list-item {
          background: var(--g-surface-strong);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
      }
    </style>
  `;
}

function renderDevices(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  return html`
    <section class="card" data-learn-id="nodes-devices">
      <div class="ops-section-head">
        <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("chip", 19)}</span><div><h2 class="ops-heading">Trusted devices</h2><p class="ops-kicker">Pairing requests, role tokens, and credential lifecycle.</p></div></div>
        <button class="btn" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
          ${opsIcon("refresh", 15)}${props.devicesLoading ? "Loading…" : "Refresh devices"}
        </button>
      </div>
      ${
        props.devicesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.devicesError}</div>`
          : nothing
      }
      <div class="list" style="margin-top: 16px;">
        ${
          pending.length > 0
            ? html`
              <div class="ops-device-group-label">Pending trust</div>
              ${pending.map((req) => renderPendingDevice(req, props))}
            `
            : nothing
        }
        ${
          paired.length > 0
            ? html`
              <div class="ops-device-group-label" style="margin-top: 12px;">Paired devices</div>
              ${paired.map((device) => renderPairedDevice(device, props))}
            `
            : nothing
        }
        ${
          pending.length === 0 && paired.length === 0
            ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("chip", 23)}</span><strong>No paired devices</strong><span>New pairing requests and trusted device tokens will appear here.</span></div></div>`
            : nothing
        }
      </div>
    </section>
  `;
}

function renderPendingDevice(req: PendingDevice, props: NodesProps) {
  const name = req.displayName?.trim() || req.deviceId;
  const age = typeof req.ts === "number" ? formatAgo(req.ts) : "n/a";
  const role = req.role?.trim() ? `role: ${req.role}` : "role: -";
  const repair = req.isRepair ? " · repair" : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item ops-device-card">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${req.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          ${role} · requested ${age}${repair}
        </div>
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${() => props.onDeviceApprove(req.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPairedDevice(device: PairedDevice, props: NodesProps) {
  const name = device.displayName?.trim() || device.deviceId;
  const ip = device.remoteIp ? ` · ${device.remoteIp}` : "";
  const roles = `roles: ${formatList(device.roles)}`;
  const scopes = `scopes: ${formatList(device.scopes)}`;
  const tokens = Array.isArray(device.tokens) ? device.tokens : [];
  const isRenaming = renamingDeviceId === device.deviceId;

  const handleDoubleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startDeviceRename(device.deviceId, name);
    props.onRequestUpdate?.();
    setTimeout(() => {
      const input = document.querySelector(".device-rename-input") as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 10);
  };

  const commitRename = () => {
    const trimmed = deviceRenameValue.trim();
    if (trimmed && trimmed !== name && props.onDeviceRename) {
      props.onDeviceRename(device.deviceId, trimmed);
    }
    cancelDeviceRename();
    props.onRequestUpdate?.();
  };

  return html`
    <div class="list-item ops-device-card">
      <div class="list-main">
        ${
          isRenaming
            ? html`
          <input
            type="text"
            class="device-rename-input"
            style="font-size: 14px; font-weight: 600; padding: 4px 8px; border: 1px solid var(--g-primary); border-radius: var(--g-radius-sm); background: var(--g-surface); color: var(--g-primary); width: 200px;"
            .value=${deviceRenameValue}
            @input=${(e: Event) => {
              deviceRenameValue = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                cancelDeviceRename();
                props.onRequestUpdate?.();
              }
            }}
            @blur=${commitRename}
            @click=${(e: Event) => e.stopPropagation()}
          />
        `
            : html`
          <div class="list-title" 
            title="Double-click to rename"
            style="cursor: pointer;"
            @dblclick=${handleDoubleClick}
          >${name}</div>
        `
        }
        <div class="list-sub">${device.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">${roles} · ${scopes}</div>
        ${
          tokens.length === 0
            ? html`
                <div class="muted" style="margin-top: 6px">Tokens: none</div>
              `
            : html`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div class="ops-token-stack">
                ${tokens.map((token) => renderTokenRow(device.deviceId, token, props))}
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? "revoked" : "active";
  const scopes = `scopes: ${formatList(token.scopes)}`;
  const when = formatAgo(token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null);
  return html`
    <div class="row ops-token-row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${token.role} · ${status} · ${scopes} · ${when}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          Rotate
        </button>
        ${
          token.revokedAtMs
            ? nothing
            : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                Revoke
              </button>
            `
        }
      </div>
    </div>
  `;
}

type BindingAgent = {
  id: string;
  name?: string;
  index: number;
  isDefault: boolean;
  binding?: string | null;
};

type BindingNode = {
  id: string;
  label: string;
};

type BindingState = {
  ready: boolean;
  disabled: boolean;
  configDirty: boolean;
  configLoading: boolean;
  configSaving: boolean;
  defaultBinding?: string | null;
  agents: BindingAgent[];
  nodes: BindingNode[];
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSave: () => void;
  onLoadConfig: () => void;
  formMode: "form" | "raw";
};

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";

type ExecApprovalsResolvedDefaults = {
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecSecurity;
  autoAllowSkills: boolean;
};

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsTargetNode = {
  id: string;
  label: string;
};

type ExecApprovalsState = {
  ready: boolean;
  disabled: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  form: ExecApprovalsFile | null;
  defaults: ExecApprovalsResolvedDefaults;
  selectedScope: string;
  selectedAgent: Record<string, unknown> | null;
  agents: ExecApprovalsAgentOption[];
  allowlist: ExecApprovalsAllowlistEntry[];
  target: "gateway" | "node";
  targetNodeId: string | null;
  targetNodes: ExecApprovalsTargetNode[];
  onSelectScope: (agentId: string) => void;
  onSelectTarget: (kind: "gateway" | "node", nodeId: string | null) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
  onLoad: () => void;
  onSave: () => void;
};

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; label: string }> = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; label: string }> = [
  { value: "off", label: "Off" },
  { value: "on-miss", label: "On miss" },
  { value: "always", label: "Always" },
];

function resolveBindingsState(props: NodesProps): BindingState {
  const config = props.configForm;
  const nodes = resolveExecNodes(props.nodes);
  const { defaultBinding, agents } = resolveAgentBindings(config);
  const ready = Boolean(config);
  const disabled = props.configSaving || props.configFormMode === "raw";
  return {
    ready,
    disabled,
    configDirty: props.configDirty,
    configLoading: props.configLoading,
    configSaving: props.configSaving,
    defaultBinding,
    agents,
    nodes,
    onBindDefault: props.onBindDefault,
    onBindAgent: props.onBindAgent,
    onSave: props.onSaveBindings,
    onLoadConfig: props.onLoadConfig,
    formMode: props.configFormMode,
  };
}

function normalizeSecurity(value?: string): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") return value;
  return "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") return value;
  return "on-miss";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  return {
    security: normalizeSecurity(defaults.security),
    ask: normalizeAsk(defaults.ask),
    askFallback: normalizeSecurity(defaults.askFallback ?? "deny"),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? false),
  };
}

function resolveConfigAgents(config: Record<string, unknown> | null): ExecApprovalsAgentOption[] {
  const agentsNode = (config?.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  const agents: ExecApprovalsAgentOption[] = [];
  list.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return;
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const isDefault = record.default === true;
    agents.push({ id, name: name || undefined, isDefault });
  });
  return agents;
}

function resolveExecApprovalsAgents(
  config: Record<string, unknown> | null,
  form: ExecApprovalsFile | null,
): ExecApprovalsAgentOption[] {
  const configAgents = resolveConfigAgents(config);
  const approvalsAgents = Object.keys(form?.agents ?? {});
  const merged = new Map<string, ExecApprovalsAgentOption>();
  configAgents.forEach((agent) => merged.set(agent.id, agent));
  approvalsAgents.forEach((id) => {
    if (merged.has(id)) return;
    merged.set(id, { id });
  });
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    const aLabel = a.name?.trim() ? a.name : a.id;
    const bLabel = b.name?.trim() ? b.name : b.id;
    return aLabel.localeCompare(bLabel);
  });
  return agents;
}

function resolveExecApprovalsScope(
  selected: string | null,
  agents: ExecApprovalsAgentOption[],
): string {
  if (selected === EXEC_APPROVALS_DEFAULT_SCOPE) return EXEC_APPROVALS_DEFAULT_SCOPE;
  if (selected && agents.some((agent) => agent.id === selected)) return selected;
  return EXEC_APPROVALS_DEFAULT_SCOPE;
}

function resolveExecApprovalsState(props: NodesProps): ExecApprovalsState {
  const form = props.execApprovalsForm ?? props.execApprovalsSnapshot?.file ?? null;
  const ready = Boolean(form);
  const defaults = resolveExecApprovalsDefaults(form);
  const agents = resolveExecApprovalsAgents(props.configForm, form);
  const targetNodes = resolveExecApprovalsNodes(props.nodes);
  const target = props.execApprovalsTarget;
  let targetNodeId =
    target === "node" && props.execApprovalsTargetNodeId ? props.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? (((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ?? null)
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ?? [])
    : [];
  return {
    ready,
    disabled: props.execApprovalsSaving || props.execApprovalsLoading,
    dirty: props.execApprovalsDirty,
    loading: props.execApprovalsLoading,
    saving: props.execApprovalsSaving,
    form,
    defaults,
    selectedScope,
    selectedAgent,
    agents,
    allowlist,
    target,
    targetNodeId,
    targetNodes,
    onSelectScope: props.onExecApprovalsSelectAgent,
    onSelectTarget: props.onExecApprovalsTargetChange,
    onPatch: props.onExecApprovalsPatch,
    onRemove: props.onExecApprovalsRemove,
    onLoad: props.onLoadExecApprovals,
    onSave: props.onSaveExecApprovals,
  };
}

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  return html`
    <section class="card">
      <div class="ops-section-head">
        <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("link", 19)}</span><div><h2 class="ops-heading">Execution routing</h2><p class="ops-kicker">Pin agents to a node for <span class="mono">exec host=node</span>.</p></div></div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.configDirty}
          @click=${state.onSave}
        >
          ${state.configSaving ? "Saving…" : "Save"}
        </button>
      </div>

      ${
        state.formMode === "raw"
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                Switch the Config tab to <strong>Form</strong> mode to edit bindings here.
              </div>
            `
          : nothing
      }

      ${
        !state.ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load config to edit bindings.</div>
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? "Loading…" : "Load config"}
            </button>
          </div>`
          : html`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">Default binding</div>
                  <div class="list-sub">Used when agents do not override a node binding.</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>Node</span>
                    <select
                      ?disabled=${state.disabled || !supportsBinding}
                      @change=${(event: Event) => {
                        const target = event.target as HTMLSelectElement;
                        const value = target.value.trim();
                        state.onBindDefault(value ? value : null);
                      }}
                    >
                      <option value="" ?selected=${defaultValue === ""}>Any node</option>
                      ${state.nodes.map(
                        (node) =>
                          html`<option
                            value=${node.id}
                            ?selected=${defaultValue === node.id}
                          >
                            ${node.label}
                          </option>`,
                      )}
                    </select>
                  </label>
                  ${
                    !supportsBinding
                      ? html`
                          <div class="muted">No nodes with system.run available.</div>
                        `
                      : nothing
                  }
                </div>
              </div>

              ${
                state.agents.length === 0
                  ? html`
                      <div class="muted">No agents found.</div>
                    `
                  : state.agents.map((agent) => renderAgentBinding(agent, state))
              }
            </div>
          `
      }
    </section>
  `;
}

function renderExecApprovals(state: ExecApprovalsState) {
  const ready = state.ready;
  const targetReady = state.target !== "node" || Boolean(state.targetNodeId);
  return html`
    <section class="card" data-learn-id="nodes-exec-approvals">
      <div class="ops-section-head">
        <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("shield", 19)}</span><div><h2 class="ops-heading">Execution policy</h2><p class="ops-kicker">Approval and allowlist policy for <span class="mono">exec host=gateway/node</span>.</p></div></div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.dirty || !targetReady}
          @click=${state.onSave}
        >
          ${state.saving ? "Saving…" : "Save"}
        </button>
      </div>

      ${renderExecApprovalsTarget(state)}

      ${
        !ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
              ${state.loading ? "Loading…" : "Load approvals"}
            </button>
          </div>`
          : html`
            ${renderExecApprovalsTabs(state)}
            ${renderExecApprovalsPolicy(state)}
            ${
              state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
                ? nothing
                : renderExecApprovalsAllowlist(state)
            }
          `
      }
    </section>
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";
  return html`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Target</div>
          <div class="list-sub">
            Gateway edits local approvals; node edits the selected node.
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Host</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (value === "node") {
                  const first = state.targetNodes[0]?.id ?? null;
                  state.onSelectTarget("node", nodeValue || first);
                } else {
                  state.onSelectTarget("gateway", null);
                }
              }}
            >
              <option value="gateway" ?selected=${state.target === "gateway"}>Gateway</option>
              <option value="node" ?selected=${state.target === "node"}>Node</option>
            </select>
          </label>
          ${
            state.target === "node"
              ? html`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${state.disabled || !hasNodes}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLSelectElement;
                      const value = target.value.trim();
                      state.onSelectTarget("node", value ? value : null);
                    }}
                  >
                    <option value="" ?selected=${nodeValue === ""}>Select node</option>
                    ${state.targetNodes.map(
                      (node) =>
                        html`<option
                          value=${node.id}
                          ?selected=${nodeValue === node.id}
                        >
                          ${node.label}
                        </option>`,
                    )}
                  </select>
                </label>
              `
              : nothing
          }
        </div>
      </div>
      ${
        state.target === "node" && !hasNodes
          ? html`
              <div class="muted">No nodes advertise exec approvals yet.</div>
            `
          : nothing
      }
    </div>
  `;
}

function renderExecApprovalsTabs(state: ExecApprovalsState) {
  return html`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE ? "active" : ""}"
          @click=${() => state.onSelectScope(EXEC_APPROVALS_DEFAULT_SCOPE)}
        >
          Defaults
        </button>
        ${state.agents.map((agent) => {
          const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
          return html`
            <button
              class="btn btn--sm ${state.selectedScope === agent.id ? "active" : ""}"
              @click=${() => state.onSelectScope(agent.id)}
            >
              ${label}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function renderExecApprovalsPolicy(state: ExecApprovalsState) {
  const isDefaults = state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE;
  const defaults = state.defaults;
  const agent = state.selectedAgent ?? {};
  const basePath = isDefaults ? ["defaults"] : ["agents", state.selectedScope];
  const agentSecurity = typeof agent.security === "string" ? agent.security : undefined;
  const agentAsk = typeof agent.ask === "string" ? agent.ask : undefined;
  const agentAskFallback = typeof agent.askFallback === "string" ? agent.askFallback : undefined;
  const securityValue = isDefaults ? defaults.security : (agentSecurity ?? "__default__");
  const askValue = isDefaults ? defaults.ask : (agentAsk ?? "__default__");
  const askFallbackValue = isDefaults ? defaults.askFallback : (agentAskFallback ?? "__default__");
  const autoOverride =
    typeof agent.autoAllowSkills === "boolean" ? agent.autoAllowSkills : undefined;
  const autoEffective = autoOverride ?? defaults.autoAllowSkills;
  const autoIsDefault = autoOverride == null;

  return html`
    <div class="list" style="margin-top: 16px;" data-learn-id="nodes-exec-policy">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${isDefaults ? "Default security mode." : `Default: ${defaults.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "security"]);
                } else {
                  state.onPatch([...basePath, "security"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${securityValue === "__default__"}>
                    Use default (${defaults.security})
                  </option>`
                  : nothing
              }
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option
                    value=${option.value}
                    ?selected=${securityValue === option.value}
                  >
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${isDefaults ? "Default prompt policy." : `Default: ${defaults.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "ask"]);
                } else {
                  state.onPatch([...basePath, "ask"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askValue === "__default__"}>
                    Use default (${defaults.ask})
                  </option>`
                  : nothing
              }
              ${ASK_OPTIONS.map(
                (option) =>
                  html`<option
                    value=${option.value}
                    ?selected=${askValue === option.value}
                  >
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${
              isDefaults
                ? "Applied when the UI prompt is unavailable."
                : `Default: ${defaults.askFallback}.`
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "askFallback"]);
                } else {
                  state.onPatch([...basePath, "askFallback"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askFallbackValue === "__default__"}>
                    Use default (${defaults.askFallback})
                  </option>`
                  : nothing
              }
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option
                    value=${option.value}
                    ?selected=${askFallbackValue === option.value}
                  >
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${
              isDefaults
                ? "Allow skill executables listed by the Gateway."
                : autoIsDefault
                  ? `Using default (${defaults.autoAllowSkills ? "on" : "off"}).`
                  : `Override (${autoEffective ? "on" : "off"}).`
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${state.disabled}
              .checked=${autoEffective}
              @change=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                state.onPatch([...basePath, "autoAllowSkills"], target.checked);
              }}
            />
          </label>
          ${
            !isDefaults && !autoIsDefault
              ? html`<button
                class="btn btn--sm"
                ?disabled=${state.disabled}
                @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
              >
                Use default
              </button>`
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;
  return html`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${state.disabled}
        @click=${() => {
          const next = [...entries, { pattern: "" }];
          state.onPatch(allowlistPath, next);
        }}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${
        entries.length === 0
          ? html`
              <div class="muted">No allowlist entries yet.</div>
            `
          : entries.map((entry, index) => renderAllowlistEntry(state, entry, index))
      }
    </div>
  `;
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatAgo(entry.lastUsedAt) : "never";
  const lastCommand = entry.lastUsedCommand ? clampText(entry.lastUsedCommand, 120) : null;
  const lastPath = entry.lastResolvedPath ? clampText(entry.lastResolvedPath, 120) : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.pattern?.trim() ? entry.pattern : "New pattern"}</div>
        <div class="list-sub">Last used: ${lastUsed}</div>
        ${lastCommand ? html`<div class="list-sub mono">${lastCommand}</div>` : nothing}
        ${lastPath ? html`<div class="list-sub mono">${lastPath}</div>` : nothing}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${entry.pattern ?? ""}
            ?disabled=${state.disabled}
            @input=${(event: Event) => {
              const target = event.target as HTMLInputElement;
              state.onPatch(
                ["agents", state.selectedScope, "allowlist", index, "pattern"],
                target.value,
              );
            }}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${state.disabled}
          @click=${() => {
            if (state.allowlist.length <= 1) {
              state.onRemove(["agents", state.selectedScope, "allowlist"]);
              return;
            }
            state.onRemove(["agents", state.selectedScope, "allowlist", index]);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  `;
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  const supportsBinding = state.nodes.length > 0;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${label}</div>
        <div class="list-sub">
          ${agent.isDefault ? "default agent" : "agent"} ·
          ${
            bindingValue === "__default__"
              ? `uses default (${state.defaultBinding ?? "any"})`
              : `override: ${agent.binding}`
          }
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${state.disabled || !supportsBinding}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value.trim();
              state.onBindAgent(agent.index, value === "__default__" ? null : value);
            }}
          >
            <option value="__default__" ?selected=${bindingValue === "__default__"}>
              Use default
            </option>
            ${state.nodes.map(
              (node) =>
                html`<option
                  value=${node.id}
                  ?selected=${bindingValue === node.id}
                >
                  ${node.label}
                </option>`,
            )}
          </select>
        </label>
      </div>
    </div>
  `;
}

function resolveExecNodes(nodes: Array<Record<string, unknown>>): BindingNode[] {
  const list: BindingNode[] = [];
  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some((cmd) => String(cmd) === "system.run");
    if (!supports) continue;
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) continue;
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  const list: ExecApprovalsTargetNode[] = [];
  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some(
      (cmd) =>
        String(cmd) === "system.execApprovals.get" || String(cmd) === "system.execApprovals.set",
    );
    if (!supports) continue;
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) continue;
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

function resolveAgentBindings(config: Record<string, unknown> | null): {
  defaultBinding?: string | null;
  agents: BindingAgent[];
} {
  const fallbackAgent: BindingAgent = {
    id: "main",
    name: undefined,
    index: 0,
    isDefault: true,
    binding: null,
  };
  if (!config || typeof config !== "object") {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = (config.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  const defaultBinding =
    typeof exec.node === "string" && exec.node.trim() ? exec.node.trim() : null;

  const agentsNode = (config.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  if (list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents: BindingAgent[] = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return;
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const isDefault = record.default === true;
    const toolsEntry = (record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    agents.push({
      id,
      name: name || undefined,
      index,
      isDefault,
      binding,
    });
  });

  if (agents.length === 0) {
    agents.push(fallbackAgent);
  }

  return { defaultBinding, agents };
}

function renderNode(node: Record<string, unknown>) {
  const connected = Boolean(node.connected);
  const paired = Boolean(node.paired);
  const title =
    (typeof node.displayName === "string" && node.displayName.trim()) ||
    (typeof node.nodeId === "string" ? node.nodeId : "unknown");
  const caps = Array.isArray(node.caps) ? (node.caps as unknown[]) : [];
  const commands = Array.isArray(node.commands) ? (node.commands as unknown[]) : [];
  const healthVector = [
    connected ? 100 : 18,
    paired ? 92 : 30,
    Math.min(100, 24 + caps.length * 7),
    Math.min(100, 24 + commands.length * 6),
  ];
  return html`
    <article class="list-item ops-node-card">
      <div class="ops-node-head">
        <div class="ops-node-identity">
          <span class="ops-node-icon">${opsIcon("server", 20)}<span class="ops-status-dot ${connected ? "" : "offline"}"></span></span>
          <div style="min-width:0"><div class="list-title">${title}</div><div class="list-sub">${typeof node.nodeId === "string" ? node.nodeId : "unknown node"}</div></div>
        </div>
        <span class="chip ${connected ? "chip-ok" : "chip-warn"}">${connected ? "connected" : "offline"}</span>
      </div>
      <div class="ops-node-meta list-sub">
        ${typeof node.remoteIp === "string" ? node.remoteIp : "Local route"}
        ${typeof node.version === "string" ? ` · ${node.version}` : ""}
      </div>
      <div class="chip-row" style="margin-top: 10px;">
        <span class="chip">${paired ? "paired" : "unpaired"}</span>
        ${caps.slice(0, 12).map((capability) => html`<span class="chip">${String(capability)}</span>`)}
        ${commands.slice(0, 8).map((command) => html`<span class="chip">${String(command)}</span>`)}
      </div>
      <div class="ops-node-health">
        <div class="ops-health-copy"><strong>${commands.length} commands · ${caps.length} capabilities</strong>Health vector uses live connection, trust, and advertised capability counts.</div>
        <div class="ops-health-vector" role="img" aria-label="Node health vector">${healthVector.map((value) => html`<span style="height:${value}%"></span>`)}</div>
      </div>
    </article>
  `;
}
