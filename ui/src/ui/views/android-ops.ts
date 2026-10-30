import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import {
  ensureSystemGlass,
  sgAurora,
  sgChip,
  sgEmpty,
  sgGauge,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgSkeleton,
  type SgStat,
  type SgTone,
} from "./system-glass";

type Device = {
  id: string;
  label: string;
  slot: number;
  model: string;
  status: string;
  batteryPct: number;
  charging: boolean;
  storageFreeMb: number;
  storageTotalMb: number;
  tailscaleIp: string | null;
  tailscaleUp: boolean;
  adbState: string;
  scrcpyState: string;
  lastHeartbeatAt: number | null;
};

type Account = {
  id: string;
  handle: string;
  platform: string;
  displayName: string;
  deviceId: string | null;
  lifecycle: string;
  sessionHealth: string;
  recoveryEmail: string;
  twoFactorEnabled: boolean;
  recoveryCodesVaulted: boolean;
  lastPostAt: number | null;
};

type UrgentItem = {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  section: string;
  at: number;
};

type DashboardSummary = {
  devices: {
    total: number;
    online: number;
    degraded: number;
    offline: number;
    stale: number;
    lowBattery: number;
    lowStorage: number;
  };
  accounts: {
    total: number;
    active: number;
    actionRequired: number;
    sessionHealthy: number;
    sessionStale: number;
    loggedOut: number;
    unassigned: number;
    twoFactorGaps: number;
  };
  jobs: {
    scheduled: number;
    dispatched: number;
    prepared: number;
    actionRequired: number;
    posted: number;
    failed: number;
    overdue: number;
    dueNextHour: number;
    postedToday: number;
    retryPending: number;
  };
  loads: Array<{ deviceId: string; label: string; assignedAccounts: number; activeJobs: number; scheduledJobs: number }>;
  workload: Array<{ day: string; scheduled: number; posted: number; failed: number; actionRequired: number }>;
  urgent: UrgentItem[];
  openAlerts: number;
  inboxNew: number;
  successRate7d: number | null;
};

/** Mirrors `AdapterStatus` (src/android-ops/adapters/types.ts). */
type AdapterAvailability = {
  available: boolean;
  version?: string | null;
  binPath?: string | null;
  reason?: string | null;
  checkedAt?: number;
};

type AdapterSnapshot = {
  device: AdapterAvailability & { kind: string };
  stream: AdapterAvailability & { kind: string };
  storage: AdapterAvailability & { backend: string };
  tailscale?: AdapterAvailability;
};

type AndroidOpsData = {
  summary: DashboardSummary;
  adapters: AdapterSnapshot;
  devices: Device[];
  accounts: Account[];
};

type ViewState = {
  loading: boolean;
  data: AndroidOpsData | null;
  error: string | null;
  updatedAt: number | null;
};

const states = new WeakMap<object, ViewState>();

function getState(host: object): ViewState {
  let state = states.get(host);
  if (!state) {
    state = { loading: false, data: null, error: null, updatedAt: null };
    states.set(host, state);
  }
  return state;
}

async function loadAndroidOps(host: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const state = getState(host);
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  host.requestUpdate?.();
  try {
    state.data = await client.request<AndroidOpsData>("androidops.dashboard", {});
    state.updatedAt = Date.now();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    host.requestUpdate?.();
  }
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

function timeAgo(ts: number | null): string {
  if (!ts) return "never";
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

type Tone = "ok" | "warn" | "bad" | "muted";

function statusTone(value: string): Tone {
  if (/online|healthy|ready|streaming|posted|active/i.test(value)) return "ok";
  if (/degraded|stale|scheduled|prepared|warning|maintenance/i.test(value)) return "warn";
  if (/offline|failed|logged_out|critical|action|required|absent|unavailable/i.test(value)) return "bad";
  return "muted";
}

function chip(value: string, tone: Tone = statusTone(value)): TemplateResult {
  const label = value.replaceAll("_", " ");
  return tone === "muted" ? sgChip(label) : sgChip(label, tone, true);
}

function ledTone(tone: Tone): SgTone {
  return tone === "muted" ? "off" : tone;
}

/** Ring gauge for battery / free storage (high = good, so tone is set explicitly). */
function ringMeter(
  valuePct: number,
  label: string,
  detail: string,
  tone: "green" | "amber" | "red" = "green",
): TemplateResult {
  const safe = Math.max(0, Math.min(100, Math.round(valuePct)));
  const cls = tone === "green" ? "" : tone === "amber" ? "ao-gauge--warn" : "ao-gauge--bad";
  return html`
    <div class="ao-meter ${cls}">
      ${sgGauge(safe / 100, { size: 58, autoTone: false, caption: label })}
      <span class="ao-meter__detail">${detail}</span>
    </div>
  `;
}

/* Inline SVG workload bar chart (fills come from CSS so both themes work). */
function workloadChart(workload: DashboardSummary["workload"]): TemplateResult {
  if (!workload.slice(-7).some((d) => d.scheduled + d.posted + d.failed > 0)) {
    return sgEmpty({ icon: "activity", title: "No workload yet", body: "Scheduled, posted and failed jobs show here once the rack starts working." });
  }
  const days = workload.slice(-7);
  const maxVal = Math.max(...days.flatMap((d) => [d.scheduled, d.posted, d.failed]), 1);
  const BAR = 32;
  const GAP = 12;
  const CH = 72;
  const LABEL_H = 20;
  const W = days.length * (BAR + GAP) - GAP;
  const H = CH + LABEL_H;

  return html`
    <svg class="ao-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet"
         style="max-height:${H * 1.6}px" role="img"
         aria-label="Workload over the last ${days.length} days">
      ${days.map((d, i) => {
        const x = i * (BAR + GAP);
        const sH = Math.max(2, Math.round((d.scheduled / maxVal) * CH));
        const pH = d.posted > 0 ? Math.max(2, Math.round((d.posted / maxVal) * CH)) : 0;
        const fH = d.failed > 0 ? Math.max(2, Math.round((d.failed / maxVal) * CH)) : 0;
        const dayLabel = d.day.slice(0, 3).toUpperCase();
        return html`
          <rect class="ao-bar-sched" x="${x}" y="${CH - sH}" width="${BAR}" height="${sH}" rx="4"/>
          ${pH > 0 ? html`<rect class="ao-bar-posted" x="${x}" y="${CH - pH}" width="${BAR}" height="${pH}" rx="4"/>` : nothing}
          ${fH > 0 ? html`<rect class="ao-bar-failed" x="${x + BAR * 0.6}" y="${CH - fH}" width="${BAR * 0.4}" height="${fH}" rx="3"/>` : nothing}
          <text class="ao-bar-label" x="${x + BAR / 2}" y="${CH + 15}" text-anchor="middle">${dayLabel}</text>
        `;
      })}
    </svg>
  `;
}

function deviceTile(
  device: Device,
  accounts: Account[],
  load?: DashboardSummary["loads"][number],
): TemplateResult {
  const assigned = accounts.filter((a) => a.deviceId === device.id);
  const storagePct = device.storageTotalMb
    ? Math.round((device.storageFreeMb / device.storageTotalMb) * 100)
    : 0;
  const battTone: "green" | "amber" | "red" =
    device.batteryPct >= 40 ? "green" : device.batteryPct >= 20 ? "amber" : "red";
  const storeTone: "green" | "amber" | "red" =
    storagePct >= 30 ? "green" : storagePct >= 15 ? "amber" : "red";
  const tone = statusTone(device.status);

  return html`
    <article class="sg-card sg-card--interactive ao-phone ao-phone--${tone}" @pointermove=${sgGloss}>
      <header class="ao-phone__head">
        ${sgLed(ledTone(tone))}
        <div class="ao-phone__name">
          <strong>${device.label}</strong>
          <span>${device.model}</span>
        </div>
        ${chip(device.status)}
      </header>
      <div class="ao-screen">
        <span class="ao-screen__state">${device.scrcpyState === "ready" ? "Ready" : device.scrcpyState}</span>
        <span class="ao-screen__ip sg-mono">${device.tailscaleIp ?? "Tailscale pending"}</span>
      </div>
      <div class="ao-meters">
        ${ringMeter(device.batteryPct, "Battery", device.charging ? "charging" : `${device.batteryPct}%`, battTone)}
        ${ringMeter(storagePct, "Free", gb(device.storageFreeMb), storeTone)}
      </div>
      <footer class="ao-phone__foot">
        <span><b>${assigned.length}</b> accts</span>
        <span><b>${load?.scheduledJobs ?? 0}</b> sched</span>
        <span><b>${load?.activeJobs ?? 0}</b> active</span>
      </footer>
      <div class="ao-phone__chips">
        ${chip(`ADB ${device.adbState}`, statusTone(device.adbState))}
        ${chip(device.tailscaleUp ? "Tailscale up" : "Tailscale down", device.tailscaleUp ? "ok" : "bad")}
        ${chip(`HB ${timeAgo(device.lastHeartbeatAt)}`, device.lastHeartbeatAt ? "muted" : "bad")}
      </div>
    </article>
  `;
}

function urgentRows(items: UrgentItem[]): TemplateResult {
  if (!items.length) {
    return sgEmpty({ icon: "check", title: "All clear", body: "No operator checkpoints waiting." });
  }
  return html`
    <div class="ao-list">
      ${items.slice(0, 8).map(
        (item) => html`
          <article class="ao-urgent ao-urgent--${item.severity}">
            ${sgLed(item.severity === "critical" ? "bad" : "warn")}
            <div class="ao-urgent__copy">
              <strong>${item.title}</strong>
              <p>${item.detail}</p>
            </div>
            ${sgChip(item.section)}
          </article>
        `,
      )}
    </div>
  `;
}

function accountRows(accounts: Account[], devices: Device[]): TemplateResult {
  if (!accounts.length) {
    return sgEmpty({ icon: "users", title: "No accounts yet", body: "Accounts appear here with their stable phone assignment once they are added to the rack." });
  }
  const deviceName = (id: string | null) =>
    devices.find((d) => d.id === id)?.label ?? "Unassigned";
  return html`
    <div class="ao-accounts">
      ${accounts.slice(0, 12).map(
        (account) => html`
          <div class="ao-acct">
            <div class="ao-acct__who">
              <strong>@${account.handle}</strong>
              <span>${account.displayName} · ${account.platform}</span>
            </div>
            <span class="ao-acct__dev">${sgIcon("phone", 13)} ${deviceName(account.deviceId)}</span>
            ${chip(account.sessionHealth)}
            ${chip(account.lifecycle)}
          </div>
        `,
      )}
    </div>
  `;
}

function panelHead(iconName: Parameters<typeof sgIcon>[0], title: string, hint: string): TemplateResult {
  return html`
    <header class="ao-panel__head">
      <span class="ao-panel__icon">${sgIcon(iconName, 15)}</span>
      <h2 class="sg-h2">${title}</h2>
      <span class="ao-panel__hint">${hint}</span>
    </header>
  `;
}

function rackStatus(view: ViewState, summary: DashboardSummary | undefined, gatewayMissing: boolean): { tone: SgTone; label: string } {
  if (gatewayMissing) return { tone: "bad", label: "RPCs missing" };
  if (view.error) return { tone: "bad", label: "Unreachable" };
  if (!summary) return { tone: "off", label: view.loading ? "Connecting" : "No data" };
  const d = summary.devices;
  if (d.total === 0) return { tone: "off", label: "No phones" };
  if (d.offline > 0) return { tone: "bad", label: `${d.offline} offline` };
  if (d.degraded > 0 || d.stale > 0) return { tone: "warn", label: `${d.online}/${d.total} online` };
  return { tone: "ok", label: `${d.online}/${d.total} online` };
}

export function renderAndroidOps(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  ensureSystemGlass();
  ensureAndroidOpsStyles();
  const view = getState(state);
  if (!view.data && !view.loading && !view.error) void loadAndroidOps(state, client);
  const data = view.data;
  const summary = data?.summary;
  const gatewayMissing =
    client.serverMethods !== null && !client.supports("androidops.dashboard");

  const stats: SgStat[] = summary
    ? [
        {
          icon: "phone",
          label: "Phones online",
          value: `${summary.devices.online}/${summary.devices.total}`,
          foot: `${summary.devices.degraded} degraded · ${summary.devices.offline} offline`,
          tone: summary.devices.offline ? "bad" : "ok",
          meter: summary.devices.total ? summary.devices.online / summary.devices.total : undefined,
          meterKind: "health",
        },
        {
          icon: "users",
          label: "Accounts healthy",
          value: `${summary.accounts.sessionHealthy}/${summary.accounts.total}`,
          foot: `${summary.accounts.loggedOut} logged out · ${summary.accounts.unassigned} unassigned`,
          tone: summary.accounts.loggedOut ? "bad" : "ok",
        },
        {
          icon: "activity",
          label: "Posts due",
          value: summary.jobs.dueNextHour,
          foot: `${summary.jobs.scheduled} scheduled · ${summary.jobs.overdue} overdue`,
          tone: summary.jobs.overdue ? "bad" : "warn",
        },
        {
          icon: "alert",
          label: "Action required",
          value: summary.jobs.actionRequired + summary.accounts.actionRequired,
          foot: `${summary.urgent.length} urgent queue items`,
          tone: summary.urgent.length ? "bad" : "ok",
        },
        {
          icon: "bolt",
          label: "Posted today",
          value: summary.jobs.postedToday,
          foot: `7d success ${pct(summary.successRate7d)}`,
          tone: "ok",
        },
        {
          icon: "network",
          label: "Inbox",
          value: summary.inboxNew,
          foot: `${summary.openAlerts} open alerts`,
          tone: summary.openAlerts ? "warn" : "ok",
        },
      ]
    : [];

  const adapters = data?.adapters;
  const actions = html`
    ${adapters
      ? html`
          ${chip(`Dev ${adapters.device?.kind ?? "—"}`, adapters.device?.available ? "ok" : "bad")}
          ${chip(`Scr ${adapters.stream?.kind ?? "—"}`, adapters.stream?.available ? "ok" : "bad")}
          ${chip(`Str ${adapters.storage?.backend ?? "—"}`, adapters.storage?.available ? "ok" : "bad")}
        `
      : nothing}
    <button
      class="sg-btn sg-btn--primary"
      ?disabled=${view.loading}
      @click=${() => void loadAndroidOps(state, client)}
    >
      ${sgIcon("refresh", 15)}
      ${view.loading ? "Refreshing…" : "Refresh"}
    </button>
  `;

  return html`
    <div class="sg-page sg-android-ops">
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Droid swarm · 4-phone v1",
        title: "Phone Rack",
        accent: "Operations",
        icon: "android",
        sub: "Stable device assignment, scheduled media jobs, human checkpoints, and live control boundaries.",
        status: rackStatus(view, summary, gatewayMissing),
        actions,
        stats,
      })}

      ${gatewayMissing
        ? html`
            <div class="ao-callout ao-callout--bad" role="alert">
              <span class="ao-callout__icon">${sgIcon("alert", 16)}</span>
              <span>Gateway is running but has not advertised Android Ops RPCs — rebuild the backend then reload.</span>
            </div>
          `
        : nothing}
      ${view.error
        ? html`
            <div class="ao-callout ao-callout--bad" role="alert">
              <span class="ao-callout__icon">${sgIcon("alert", 16)}</span>
              <span>${view.error}</span>
            </div>
          `
        : nothing}
      ${view.loading && !data
        ? html`
            <div class="ao-callout" role="status">
              <span class="ao-callout__icon">${sgIcon("refresh", 16)}</span>
              <span>Loading rack telemetry…</span>
            </div>
            <div class="sg-grid sg-grid--3">${sgSkeleton(1, true)}${sgSkeleton(1, true)}${sgSkeleton(1, true)}</div>
          `
        : nothing}

      ${summary
        ? html`
            ${summary.workload.length
              ? html`
                  <section class="sg-panel ao-workload sg-enter">
                    <header class="ao-panel__head">
                      <span class="ao-panel__icon">${sgIcon("activity", 15)}</span>
                      <h2 class="sg-h2">Workload trend — last ${Math.min(summary.workload.length, 7)} days</h2>
                      <div class="ao-legend">
                        <span class="sg-chip"><i class="ao-swatch ao-swatch--sched"></i>Scheduled</span>
                        <span class="sg-chip"><i class="ao-swatch ao-swatch--posted"></i>Posted</span>
                        <span class="sg-chip"><i class="ao-swatch ao-swatch--failed"></i>Failed</span>
                      </div>
                    </header>
                    ${workloadChart(summary.workload)}
                  </section>
                `
              : nothing}

            <div class="ao-grid">
              <section class="sg-panel ao-wide">
                ${panelHead("phone", "Live grid", "Four simultaneous phone tiles")}
                ${(data?.devices ?? []).length
                  ? html`
                      <div class="ao-phones">
                        ${[...(data?.devices ?? [])]
                          .sort((a, b) => a.slot - b.slot)
                          .map((device) =>
                            deviceTile(
                              device,
                              data?.accounts ?? [],
                              summary.loads.find((l) => l.deviceId === device.id),
                            ),
                          )}
                      </div>
                    `
                  : sgEmpty({
                      icon: "android",
                      title: "No phones on the rack",
                      body: "Plug a phone in over USB with ADB enabled, or pair one over Tailscale. Each slot shows its battery, storage and stream state here.",
                    })}
              </section>

              <section class="sg-panel">
                ${panelHead("alert", "Action required", "Human checkpoints only")}
                ${urgentRows(summary.urgent)}
              </section>

              <section class="sg-panel">
                ${panelHead("activity", "Pipeline", "Explicit state machine")}
                <div class="ao-states">
                  ${(
                    [
                      ["Scheduled", summary.jobs.scheduled],
                      ["Dispatched", summary.jobs.dispatched],
                      ["Prepared", summary.jobs.prepared],
                      ["Retry pending", summary.jobs.retryPending],
                      ["Failed", summary.jobs.failed],
                    ] as [string, number][]
                  ).map(
                    ([label, value]) => html`
                      <div class="ao-state ${label === "Failed" && value > 0 ? "ao-state--bad" : ""}">
                        <span>${label}</span>
                        <strong>${value}</strong>
                      </div>
                    `,
                  )}
                </div>
                <div class="ao-callout ao-callout--gold ao-compliance">
                  <span class="ao-callout__icon">${sgIcon("shield", 16)}</span>
                  <span>
                    <b>Compliance boundary.</b>
                    No CAPTCHA bypass, artificial engagement, fake identity,
                    anti-detection, or signal falsification paths are exposed.
                    Platform verification remains an operator checkpoint.
                  </span>
                </div>
              </section>

              <section class="sg-panel ao-wide">
                ${panelHead("users", "Accounts", "Stable account-to-device assignment")}
                ${accountRows(data?.accounts ?? [], data?.devices ?? [])}
              </section>
            </div>
          `
        : nothing}
    </div>
  `;
}

// ── Page styles (on top of the system-glass kit) ────────────

const AO_STYLE_ID = "ao-glass-styles";

function ensureAndroidOpsStyles(): void {
  if (typeof document === "undefined" || document.getElementById(AO_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = AO_STYLE_ID;
  el.textContent = AO_CSS;
  document.head.appendChild(el);
}

const AO_CSS = `
.sg-android-ops { padding: clamp(14px, 2vw, 24px); }
.sg-android-ops .sg-hero__side .sg-actions { justify-content: flex-end; }

/* Glass callouts (banners) */
.ao-callout {
  --tone: var(--sg-gold);
  position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px;
  border-radius: var(--sg-radius-md); color: var(--sg-fg-2); font-size: 13px; line-height: 1.5;
  background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 12%, transparent), transparent 70%), var(--glass-2);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 30%, transparent), var(--glass-specular, none), var(--glass-elev-1, none);
  backdrop-filter: var(--glass-blur-sm, blur(12px)); -webkit-backdrop-filter: var(--glass-blur-sm, blur(12px));
}
.ao-callout::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 3px; background: var(--tone); box-shadow: 0 0 10px var(--tone); }
.ao-callout__icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
.ao-callout > span:last-child { align-self: center; min-width: 0; overflow-wrap: anywhere; }
.ao-callout--bad { --tone: var(--sg-bad); }
.ao-callout--bad > span:last-child { color: var(--sg-fg); }
.ao-callout--gold { --tone: var(--sg-gold); }
.sg-panel .ao-callout { backdrop-filter: none; -webkit-backdrop-filter: none; background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 10%, transparent), transparent 80%); }
.ao-callout b { color: var(--sg-fg); }

/* Panel heads */
.ao-panel__head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; margin-bottom: 16px; }
.ao-panel__icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 10px; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }
.ao-panel__hint { margin-left: auto; color: var(--sg-fg-3); font-size: 12px; }

/* Workload */
.ao-legend { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; }
.ao-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 3px; }
.ao-swatch--sched { background: var(--glass-gold-a24); box-shadow: inset 0 0 0 1px var(--glass-gold-a40); }
.ao-swatch--posted { background: var(--sg-gold); box-shadow: 0 0 6px var(--glass-gold-a40); }
.ao-swatch--failed { background: var(--sg-bad); }
.ao-chart { display: block; width: 100%; }
.ao-bar-sched { fill: var(--glass-gold-a16); }
.ao-bar-posted { fill: var(--sg-gold); filter: drop-shadow(0 0 4px var(--glass-gold-a40)); }
.ao-bar-failed { fill: var(--sg-bad); }
.ao-bar-label { fill: var(--sg-fg-3); font: 700 8.5px var(--glass-font, system-ui); letter-spacing: 0.06em; }

/* Main grid */
.ao-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.ao-wide { grid-column: 1 / -1; }

/* Phone tiles */
.ao-phones { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.ao-phone { display: flex; flex-direction: column; gap: 12px; cursor: default; }
.ao-phone__head { display: flex; align-items: center; gap: 10px; }
.ao-phone__name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ao-phone__name strong { color: var(--sg-fg); font-size: 14px; font-weight: 640; }
.ao-phone__name span { color: var(--sg-fg-3); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ao-screen {
  position: relative; display: grid; place-items: center; gap: 4px; aspect-ratio: 16 / 10; padding: 12px; border-radius: 14px; overflow: hidden;
  background: radial-gradient(80% 90% at 50% 0%, var(--glass-gold-a10), transparent 70%), color-mix(in srgb, var(--glass-base, #07070a) 70%, transparent);
  box-shadow: inset 0 0 0 1px var(--glass-stroke), inset 0 8px 24px rgba(0, 0, 0, 0.35);
}
:root[data-theme="light"] .ao-screen { background: radial-gradient(80% 90% at 50% 0%, var(--glass-gold-a10), transparent 70%), rgba(30, 26, 20, 0.88); }
.ao-screen__state { color: var(--sg-gold-hi); font-size: 13px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; text-shadow: 0 0 12px var(--glass-gold-a40); }
.ao-screen__ip { color: rgba(244, 241, 234, 0.55); font-size: 11px; }
.ao-phone--bad .ao-screen__state { color: var(--sg-bad); text-shadow: none; }
.ao-meters { display: flex; justify-content: space-around; gap: 10px; }
.ao-meter { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.ao-meter__detail { color: var(--sg-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.ao-gauge--warn .sg-gauge__arc { stroke: var(--sg-warn); }
.ao-gauge--bad .sg-gauge__arc { stroke: var(--sg-bad); }
.ao-phone__foot { display: flex; justify-content: space-between; gap: 8px; padding-top: 10px; border-top: 1px solid var(--glass-stroke); color: var(--sg-fg-3); font-size: 11.5px; }
.ao-phone__foot b { color: var(--sg-fg); font-weight: 650; font-variant-numeric: tabular-nums; }
.ao-phone__chips { display: flex; flex-wrap: wrap; gap: 6px; }

/* Urgent list */
.ao-list { display: grid; gap: 8px; }
.ao-urgent { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-radius: var(--sg-radius-sm); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
.ao-urgent .sg-led { margin-top: 6px; }
.ao-urgent--critical { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 30%, transparent); }
.ao-urgent__copy { flex: 1; min-width: 0; }
.ao-urgent__copy strong { color: var(--sg-fg); font-size: 13px; }
.ao-urgent__copy p { margin: 2px 0 0; color: var(--sg-fg-2); font-size: 12px; line-height: 1.45; }

/* Pipeline */
.ao-states { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ao-state { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: var(--sg-radius-sm); background: var(--glass-hover); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
.ao-state span { color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.ao-state strong { color: var(--sg-fg); font: 650 22px/1 var(--font-ui-display, system-ui); font-variant-numeric: tabular-nums; }
.ao-state--bad strong { color: var(--sg-bad); }

/* Accounts */
.ao-accounts { display: grid; }
.ao-acct { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 11px 6px; border-bottom: 1px solid var(--glass-stroke); transition: background var(--sg-dur) var(--sg-ease); border-radius: 8px; }
.ao-acct:last-child { border-bottom: 0; }
.ao-acct:hover { background: var(--glass-gold-a06); }
.ao-acct__who { display: flex; flex-direction: column; min-width: 0; }
.ao-acct__who strong { color: var(--sg-fg); font-size: 13px; }
.ao-acct__who span, .ao-acct__dev { color: var(--sg-fg-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ao-acct__dev { display: inline-flex; align-items: center; gap: 6px; }

@media (max-width: 960px) {
  .ao-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .sg-android-ops { padding: 12px; }
  .ao-panel__hint { display: none; }
  .ao-legend { margin-left: 0; width: 100%; }
  .ao-acct { grid-template-columns: minmax(0, 1fr) auto; }
  .ao-acct__dev { grid-column: 1 / -1; order: 3; }
  .sg-android-ops .sg-hero__side .sg-actions { justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .ao-acct { transition: none; }
}
`;
