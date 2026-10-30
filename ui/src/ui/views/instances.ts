import { html, nothing } from "lit";

import { formatPresenceAge, formatPresenceSummary } from "../presenter";
import type { KanbanProject, PresenceEntry } from "../types";
import { opsIcon, renderOpsSharedStyles, renderOpsTelemetryRail } from "./ops-glass";

export type InstanceContextMenu = { entry: PresenceEntry; x: number; y: number } | null;

export type InstancesProps = {
  loading: boolean;
  entries: PresenceEntry[];
  lastError: string | null;
  statusMessage: string | null;
  onRefresh: () => void;
  projects?: KanbanProject[];
  contextMenu?: InstanceContextMenu;
  instanceProjects?: Record<string, string[]>;
  onContextMenu?: (menu: InstanceContextMenu) => void;
  onAssignToProject?: (instanceId: string, projectId: string) => void;
  onUnassignFromProject?: (instanceId: string, projectId: string) => void;
};

function isRecent(entry: PresenceEntry, thresholdSeconds = 120): boolean {
  if (!entry.ts) return true;
  return Date.now() - entry.ts <= thresholdSeconds * 1000;
}

function activityScore(entry: PresenceEntry): number {
  if (entry.lastInputSeconds == null) return 44;
  return Math.max(8, Math.min(100, Math.round(100 - entry.lastInputSeconds / 9)));
}

function renderSignalBars(entry: PresenceEntry) {
  const values = [
    isRecent(entry) ? 96 : 28,
    activityScore(entry),
    entry.platform ? 78 : 34,
    entry.version ? 88 : 38,
  ];
  return html`<div class="ops-signal-bars" role="img" aria-label="Health vector derived from beacon recency, input activity, platform, and version metadata">${values.map((value) => html`<span style="height:${value}%"></span>`)}</div>`;
}

export function renderInstances(props: InstancesProps) {
  const activeCount = props.entries.filter((entry) => isRecent(entry)).length;
  const interactiveCount = props.entries.filter(
    (entry) => entry.lastInputSeconds != null && entry.lastInputSeconds < 300,
  ).length;
  const platformCount = new Set(props.entries.map((entry) => entry.platform).filter(Boolean)).size;

  return html`
    <div class="ops-page ops-instances-page" aria-busy=${props.loading ? "true" : "false"} @click=${() => props.onContextMenu?.(null)}>
      ${renderOpsSharedStyles()}
      <style>
        .ops-instances-page .ops-toolbar .btn { display:inline-flex;align-items:center;gap:8px; }
        .ops-instances-page .ops-instance-network { position:relative;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:20px;padding-top:22px; }
        .ops-instances-page .ops-instance-network::before { content:"";position:absolute;top:0;left:8%;right:8%;height:1px;background:linear-gradient(90deg,transparent,var(--g-border-strong),var(--g-primary),var(--g-border-strong),transparent);box-shadow:0 0 16px color-mix(in srgb,var(--g-primary) 25%,transparent); }
        .ops-instances-page .ops-instance-card { position:relative;min-width:0;padding:18px;border:1px solid var(--g-border);border-radius:var(--g-radius);background:linear-gradient(145deg,color-mix(in srgb,var(--g-surface-strong) 78%,transparent),color-mix(in srgb,var(--g-surface) 88%,transparent));box-shadow:var(--g-shadow),inset 0 1px 0 color-mix(in srgb,var(--g-fg) 10%,transparent),inset 0 -1px 0 color-mix(in srgb,var(--g-bg-deep) 38%,transparent);backdrop-filter:var(--g-blur);-webkit-backdrop-filter:var(--g-blur);cursor:context-menu;transition:transform 180ms ease,border-color 180ms ease,box-shadow 180ms ease; }
        .ops-instances-page .ops-instance-card::before { content:"";position:absolute;top:-23px;left:50%;width:1px;height:23px;background:linear-gradient(var(--g-primary),var(--g-border));opacity:.7; }
        .ops-instances-page .ops-instance-card::after { content:"";position:absolute;top:-27px;left:calc(50% - 4px);width:8px;height:8px;border:1px solid var(--g-border-strong);border-radius:50%;background:var(--g-bg);box-shadow:0 0 10px color-mix(in srgb,var(--g-primary) 55%,transparent); }
        .ops-instances-page .ops-instance-card:hover { transform:translateY(-3px);border-color:var(--g-border-strong);box-shadow:var(--g-shadow-lg),0 0 38px color-mix(in srgb,var(--g-primary) 10%,transparent),inset 0 1px 0 color-mix(in srgb,var(--g-fg) 15%,transparent); }
        .ops-instances-page .ops-instance-head { display:flex;align-items:flex-start;justify-content:space-between;gap:14px; }
        .ops-instances-page .ops-instance-identity { display:flex;align-items:center;gap:12px;min-width:0; }
        .ops-instances-page .ops-instance-glyph { position:relative;display:grid;place-items:center;width:44px;height:44px;flex:none;border:1px solid var(--g-border-strong);border-radius:var(--g-radius);background:var(--g-primary-soft);color:var(--g-primary);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 12%,transparent),0 0 24px color-mix(in srgb,var(--g-primary) 14%,transparent); }
        .ops-instances-page .ops-instance-glyph .ops-status-dot { position:absolute;right:-2px;bottom:-2px;border:2px solid var(--g-bg); }
        .ops-instances-page .ops-instance-title { overflow:hidden;color:var(--g-fg);font-size:14px;font-weight:700;letter-spacing:-.01em;text-overflow:ellipsis;white-space:nowrap; }
        .ops-instances-page .ops-instance-id { margin-top:4px;overflow:hidden;color:var(--g-fg-faint);font:500 9px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap; }
        .ops-instances-page .ops-age { flex:none;padding:5px 8px;border:1px solid var(--g-border);border-radius:999px;background:var(--g-surface);color:var(--g-fg-dim);font:650 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .ops-instances-page .ops-summary { margin-top:15px;padding:11px 12px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:color-mix(in srgb,var(--g-bg-deep) 38%,var(--g-surface));color:var(--g-fg-dim);font-size:10px;line-height:1.55; }
        .ops-instances-page .ops-instance-health { display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:12px;align-items:end;margin-top:14px;padding-top:13px;border-top:1px solid var(--g-border); }
        .ops-instances-page .ops-health-meta { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px; }
        .ops-instances-page .ops-health-item small { display:block;color:var(--g-fg-faint);font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase; }.ops-instances-page .ops-health-item strong{display:block;margin-top:4px;overflow:hidden;color:var(--g-fg-dim);font:600 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
        .ops-instances-page .ops-signal-bars { display:flex;align-items:flex-end;justify-content:flex-end;gap:5px;height:35px; }
        .ops-instances-page .ops-signal-bars span { width:7px;min-height:5px;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,color-mix(in srgb,var(--g-primary) 78%,var(--g-fg)),var(--g-primary));box-shadow:0 0 9px color-mix(in srgb,var(--g-primary) 24%,transparent); }
        .ops-instances-page .chip-row { gap:6px;margin-top:13px; }.ops-instances-page .chip { border-color:var(--g-border);background:var(--g-surface);color:var(--g-fg-dim);font-size:9px; }
        .ops-instances-page .instance-projects-badge { display:flex;gap:5px;flex-wrap:wrap;margin-top:10px; }
        .ops-instances-page .instance-project-chip { display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid var(--g-border-strong);border-radius:999px;background:var(--g-primary-soft);color:var(--g-primary);font-size:9px; }
        .ops-instances-page .instance-context-overlay { position:fixed;inset:0;z-index:1000; }
        .ops-instances-page .instance-context-menu { position:fixed;z-index:1001;min-width:230px;max-width:min(320px,calc(100vw - 24px));overflow:hidden;padding:6px;border:1px solid var(--g-border-strong);border-radius:var(--g-radius);background:color-mix(in srgb,var(--g-bg-deep) 88%,var(--g-surface-strong));box-shadow:var(--g-shadow-lg),inset 0 1px 0 color-mix(in srgb,var(--g-fg) 12%,transparent);backdrop-filter:var(--g-blur-heavy);-webkit-backdrop-filter:var(--g-blur-heavy);animation:contextMenuIn .15s ease-out; }
        @keyframes contextMenuIn { from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)} }
        .ops-instances-page .context-menu-header { padding:8px 10px;color:var(--g-fg-faint);font-size:9px;font-weight:750;letter-spacing:.11em;text-transform:uppercase; }.ops-instances-page .context-menu-header:first-child{padding-bottom:10px;border-bottom:1px solid var(--g-border);color:var(--g-fg);font-size:11px;letter-spacing:0;text-transform:none}
        .ops-instances-page .context-menu-item { display:flex;align-items:center;gap:9px;padding:9px 10px;border-radius:var(--g-radius-sm);color:var(--g-fg-dim);cursor:pointer;font-size:11px;transition:background 120ms ease,color 120ms ease; }.ops-instances-page .context-menu-item:hover{background:var(--g-surface-hover);color:var(--g-primary)}.ops-instances-page .context-menu-item.assigned{color:var(--g-primary);background:var(--g-primary-soft)}.ops-instances-page .context-menu-item .check{display:grid;place-items:center;width:18px;height:18px;flex:none}.ops-instances-page .context-menu-separator{height:1px;margin:4px 0;background:var(--g-border)}
        @media(max-width:700px){.ops-instances-page .ops-instance-network{grid-template-columns:1fr}.ops-instances-page .ops-instance-network::before{left:50%;right:auto;height:100%;width:1px;background:linear-gradient(transparent,var(--g-border-strong),transparent)}.ops-instances-page .ops-instance-card::before,.ops-instances-page .ops-instance-card::after{display:none}}
        @media(max-width:390px){.ops-instances-page .ops-toolbar,.ops-instances-page .ops-toolbar .btn{width:100%}.ops-instances-page .ops-instance-card{padding:15px 13px}.ops-instances-page .ops-instance-health{grid-template-columns:1fr}.ops-instances-page .ops-signal-bars{justify-content:flex-start}.ops-instances-page .instance-context-menu{left:12px!important;right:12px!important;top:auto!important;bottom:12px}}
      </style>

      <header class="ops-hero"><div class="ops-hero-copy"><div class="ops-eyebrow">Network / Presence mesh</div><h1 class="ops-title">Connected <em>instances</em></h1><p class="ops-subtitle">A live view of every gateway and client beacon, with operator context, activity recency, and project assignment.</p></div><div class="ops-live-badge"><span class="ops-status-dot ${props.lastError ? "warn" : ""}"></span>${props.lastError ? "Presence issue" : `${activeCount} live`}</div></header>

      <div class="ops-metrics" aria-label="Instance summary"><div class="ops-metric"><span class="ops-metric-label">${opsIcon("server", 13)}Instances</span><strong class="ops-metric-value accent">${props.entries.length}</strong></div><div class="ops-metric"><span class="ops-metric-label">${opsIcon("radio", 13)}Recent beacons</span><strong class="ops-metric-value">${activeCount}</strong></div><div class="ops-metric"><span class="ops-metric-label">${opsIcon("activity", 13)}Recently active</span><strong class="ops-metric-value">${interactiveCount}</strong></div><div class="ops-metric"><span class="ops-metric-label">${opsIcon("chip", 13)}Platforms</span><strong class="ops-metric-value">${platformCount}</strong></div></div>

      ${renderOpsTelemetryRail("Presence fabric telemetry", [
        { label: "fabric", value: props.lastError ? "degraded" : "synchronized", tone: props.lastError ? "danger" : "success" },
        { label: "availability", value: props.entries.length ? `${Math.round((activeCount / props.entries.length) * 100)}%` : "—", tone: activeCount > 0 ? "accent" : "warning" },
        { label: "interaction", value: interactiveCount > 0 ? "active" : "idle" },
        { label: "assignment", value: props.projects?.length ? "enabled" : "standby" },
      ])}

      <section class="ops-panel">
        <div class="ops-section-head"><div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("link", 19)}</span><div><h2 class="ops-heading">Presence fabric</h2><p class="ops-kicker">Right-click an instance card to assign it to a project.</p></div></div><div class="ops-toolbar"><button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>${opsIcon("refresh", 15)}${props.loading ? "Loading…" : "Refresh fabric"}</button></div></div>
        ${props.lastError ? html`<div class="callout danger" style="margin-top:14px">${props.lastError}</div>` : nothing}${props.statusMessage ? html`<div class="callout" style="margin-top:14px">${props.statusMessage}</div>` : nothing}
        ${
          props.loading && props.entries.length === 0
            ? html`<div class="ops-instance-network">${Array.from(
                { length: 3 },
                () =>
                  html`
                    <div class="ops-skeleton" style="min-height: 230px"></div>
                  `,
              )}</div>`
            : props.entries.length === 0
              ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("radio", 23)}</span><strong>No instance beacons yet</strong><span>Connected gateways and clients will assemble here automatically.</span></div></div>`
              : html`<div class="ops-instance-network">${props.entries.map((entry) => renderEntry(entry, props))}</div>`
        }
      </section>
      ${renderContextMenu(props)}
    </div>
  `;
}

function renderEntry(entry: PresenceEntry, props: InstancesProps) {
  const lastInput = entry.lastInputSeconds != null ? `${entry.lastInputSeconds}s ago` : "n/a";
  const mode = entry.mode ?? "unknown";
  const roles = Array.isArray((entry as unknown as { roles?: unknown[] }).roles)
    ? (entry as unknown as { roles: unknown[] }).roles.filter(Boolean)
    : [];
  const scopes = Array.isArray((entry as unknown as { scopes?: unknown[] }).scopes)
    ? (entry as unknown as { scopes: unknown[] }).scopes.filter(Boolean)
    : [];
  const scopesLabel =
    scopes.length > 0
      ? scopes.length > 3
        ? `${scopes.length} scopes`
        : `scopes: ${scopes.join(", ")}`
      : null;
  const instanceId = entry.instanceId || entry.host || "unknown";
  const assignedProjectIds = props.instanceProjects?.[instanceId] || [];
  const assignedProjects = (props.projects || []).filter((project) =>
    assignedProjectIds.includes(project.id),
  );
  const recent = isRecent(entry);
  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    props.onContextMenu?.({ entry, x: event.clientX, y: event.clientY });
  };

  return html`<article class="ops-instance-card" aria-label="${entry.host ?? "Unknown host"}, ${recent ? "online" : "offline"}" @contextmenu=${handleContextMenu}>
    <div class="ops-instance-head"><div class="ops-instance-identity"><span class="ops-instance-glyph">${opsIcon("server", 21)}<span class="ops-status-dot ${recent ? "" : "offline"}"></span></span><div style="min-width:0"><div class="ops-instance-title">${entry.host ?? "unknown host"}</div><div class="ops-instance-id">${instanceId}</div></div></div><span class="ops-age">${formatPresenceAge(entry)}</span></div>
    <div class="ops-summary">${formatPresenceSummary(entry)}</div>
    ${assignedProjects.length > 0 ? html`<div class="instance-projects-badge">${assignedProjects.map((project) => html`<span class="instance-project-chip">${opsIcon("project", 11)}${project.name}</span>`)}</div>` : nothing}
    <div class="chip-row"><span class="chip">${mode}</span>${roles.map((role) => html`<span class="chip">${String(role)}</span>`)}${scopesLabel ? html`<span class="chip">${scopesLabel}</span>` : nothing}${entry.platform ? html`<span class="chip">${entry.platform}</span>` : nothing}${entry.deviceFamily ? html`<span class="chip">${entry.deviceFamily}</span>` : nothing}${entry.modelIdentifier ? html`<span class="chip">${entry.modelIdentifier}</span>` : nothing}${entry.version ? html`<span class="chip">${entry.version}</span>` : nothing}</div>
    <div class="ops-instance-health"><div class="ops-health-meta"><div class="ops-health-item"><small>Last input</small><strong>${lastInput}</strong></div><div class="ops-health-item"><small>Reason</small><strong>${entry.reason || "presence"}</strong></div></div>${renderSignalBars(entry)}</div>
  </article>`;
}

function renderContextMenu(props: InstancesProps) {
  const { contextMenu, projects, instanceProjects } = props;
  if (!contextMenu) return nothing;
  const instanceId = contextMenu.entry.instanceId || contextMenu.entry.host || "unknown";
  const assignedProjectIds = instanceProjects?.[instanceId] || [];
  const handleAssign = (projectId: string) => {
    if (assignedProjectIds.includes(projectId))
      props.onUnassignFromProject?.(instanceId, projectId);
    else props.onAssignToProject?.(instanceId, projectId);
    props.onContextMenu?.(null);
  };
  return html`<div class="instance-context-overlay" @click=${() => props.onContextMenu?.(null)}></div><div class="instance-context-menu" style="left:${contextMenu.x}px;top:${contextMenu.y}px"><div class="context-menu-header">${contextMenu.entry.host ?? "Instance"}</div><div class="context-menu-header">Assign to project</div>${
    (projects || []).length === 0
      ? html`<div class="context-menu-item" style="color:var(--g-fg-faint)">${opsIcon("project", 15)}No projects available</div>`
      : (projects || []).map((project) => {
          const assigned = assignedProjectIds.includes(project.id);
          return html`<div class="context-menu-item ${assigned ? "assigned" : ""}" @click=${() => handleAssign(project.id)}><span class="check">${assigned ? opsIcon("check", 14) : nothing}</span><span>${project.name}</span></div>`;
        })
  }</div>`;
}
