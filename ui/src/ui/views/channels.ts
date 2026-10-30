import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types";
import type {
  ChannelKey,
  ChannelsChannelData,
  ChannelsProps,
} from "./channels.types";
import { channelEnabled, renderChannelAccountCount } from "./channels.shared";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";
import { renderDiscordCard } from "./channels.discord";
import { renderGoogleChatCard } from "./channels.googlechat";
import { renderIMessageCard } from "./channels.imessage";
import { renderNostrCard } from "./channels.nostr";
import { renderSignalCard } from "./channels.signal";
import { renderSlackCard } from "./channels.slack";
import { renderTelegramCard } from "./channels.telegram";
import { renderWhatsAppCard } from "./channels.whatsapp";
import { renderPlanLockedChannelCard } from "./channels.plan-lock";
import { channelsGlassStyles } from "./settings-glass.styles";

const refreshIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6v5h-5"></path><path d="M4 18v-5h5"></path><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8"></path><path d="M5.5 15A7 7 0 0 0 17.8 17.8L20 16"></path></svg>`;

export function renderChannels(props: ChannelsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as
    | WhatsAppStatus
    | undefined;
  const telegram = (channels?.telegram ?? undefined) as
    | TelegramStatus
    | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.order - b.order;
    });
  const activeCount = orderedChannels.filter((entry) => entry.enabled).length;

  return html`
    ${channelsGlassStyles}
    <div class="channels-page glass-settings" aria-busy=${props.loading ? "true" : "false"}>
      <header class="channels-hero">
        <div>
          <div class="channels-hero__eyebrow">Communication matrix</div>
          <h2>Channels</h2>
          <p>Connect every place your people already communicate. Credentials stay scoped to the gateway while live status, setup, and diagnostics remain in one control surface.</p>
        </div>
        <div class="channels-hero__aside">
          <div class="channels-stat"><strong>${activeCount}</strong><span>active</span></div>
          <div class="channels-stat"><strong>${orderedChannels.length}</strong><span>available</span></div>
          <button
            type="button"
            class="channels-refresh"
            aria-label="Refresh channel status"
            title="Refresh channel status"
            ?disabled=${props.loading}
            @click=${() => props.onRefresh(false)}
          >${refreshIcon}</button>
        </div>
      </header>

      <section class="channels-grid" data-learn-id="channels-grid">
        ${props.loading && !props.snapshot
          ? [0, 1, 2, 3, 4, 5].map(() => html`
              <div class="channel-skeleton" role="status" aria-label="Loading channel">
                <div class="channel-skeleton__line"></div>
                <div class="channel-skeleton__line"></div>
                <div class="channel-skeleton__line"></div>
                <div class="channel-skeleton__line"></div>
              </div>
            `)
          : orderedChannels.map((channel) =>
              renderChannel(channel.key, props, {
                whatsapp,
                telegram,
                discord,
                googlechat,
                slack,
                signal,
                imessage,
                nostr,
                channelAccounts: props.snapshot?.channelAccounts ?? null,
              }),
            )}
      </section>

      <section class="card channels-health" data-learn-id="channels-health">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Channel health</div>
            <div class="card-sub">Channel status snapshots from the gateway.</div>
          </div>
          <div class="muted">${props.lastSuccessAt ? formatAgo(props.lastSuccessAt) : "n/a"}</div>
        </div>
        ${props.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.lastError}
            </div>`
          : nothing}
        <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
        </pre>
      </section>
    </div>
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id) as ChannelKey[];
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return [
    "whatsapp",
    "telegram",
    "discord",
    "googlechat",
    "slack",
    "signal",
    "imessage",
    "nostr",
  ];
}

function renderChannel(
  key: ChannelKey,
  props: ChannelsProps,
  data: ChannelsChannelData,
) {
  // Hosted plan without this channel (Free: Telegram, Slack): locked / paused card.
  const planLocked = renderPlanLockedChannelCard(key, props);
  if (planLocked) return planLocked;
  const accountCountLabel = renderChannelAccountCount(
    key,
    data.channelAccounts,
  );
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCountLabel,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCountLabel,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        accountCountLabel,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googlechat: data.googlechat ?? null,
        accountCountLabel,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        accountCountLabel,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        accountCountLabel,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        accountCountLabel,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCountLabel,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);

  const state = deriveConnectionState({
    configured: configured ?? null,
    running: running ?? null,
    connected: connected ?? null,
    hasError: Boolean(lastError),
  });

  const body = html`
    ${accountCountLabel}

    ${accounts.length > 0
      ? html`
          <div class="account-card-list">
            ${accounts.map((account) => renderGenericAccount(account))}
          </div>
        `
      : html`
          <div class="status-list">
            <div>
              <span class="label">Configured</span>
              <span>${configured == null ? "n/a" : configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${running == null ? "n/a" : running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Connected</span>
              <span>${connected == null ? "n/a" : connected ? "Yes" : "No"}</span>
            </div>
          </div>
        `}

    ${lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${lastError}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: key, props })}
  `;

  const snapshotLabel = resolveChannelLabel(props.snapshot, key);
  const labelOverride = snapshotLabel !== key ? snapshotLabel : undefined;
  return renderChannelCard({ channelId: key, state, body, labelOverride });
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) return {};
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(
  snapshot: ChannelsStatusSnapshot | null,
  key: string,
): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) return false;
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) return "Yes";
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) return "Active";
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) return "Yes";
  if (account.connected === false) return "No";
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) return "Active";
  return "n/a";
}

function renderGenericAccount(account: ChannelAccountSnapshot) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);

  return html`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${account.name || account.accountId}</div>
        <div class="account-card-id">${account.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">Running</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${account.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${connectedStatus}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : "n/a"}</span>
        </div>
        ${account.lastError
          ? html`
              <div class="account-card-error">
                ${account.lastError}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
