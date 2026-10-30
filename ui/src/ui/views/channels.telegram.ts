import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";
import "../components/telegram-setup";

export function renderTelegramCard(params: {
  props: ChannelsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, telegram, telegramAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;

  const aggConnected = hasMultipleAccounts
    ? telegramAccounts.some((a) => a.running)
    : Boolean(telegram?.running);
  const aggConfigured = hasMultipleAccounts
    ? telegramAccounts.some((a) => a.configured)
    : Boolean(telegram?.configured);
  // A bot that was disconnected on purpose is "not configured", not an error.
  const aggError = hasMultipleAccounts
    ? telegramAccounts.some((a) => a.configured && Boolean(a.lastError))
    : Boolean(telegram?.configured && telegram?.lastError);
  const state = deriveConnectionState({
    configured: aggConfigured,
    running: aggConnected,
    connected: aggConnected,
    hasError: aggError,
  });

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">
            ${botUsername ? `@${botUsername}` : label}
          </div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${account.running ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${account.configured ? "Yes" : "No"}</span>
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
  };

  // The guided setup saves straight to the gateway config, so the raw config
  // form below must be re-read afterwards (a stale form would save old values).
  const onSetupChanged = () => {
    props.onConfigReload();
    props.onRefresh(true);
  };

  const body = html`
    ${accountCountLabel}

    <telegram-setup
      data-learn-id="telegram-guided-setup"
      @telegram-setup-changed=${onSetupChanged}
    ></telegram-setup>

    ${hasMultipleAccounts
      ? html`
          <div class="account-card-list">
            ${telegramAccounts.map((account) => renderAccountCard(account))}
          </div>
        `
      : nothing}

    ${telegram?.lastError && telegram.configured
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${telegram.lastError}
        </div>`
      : nothing}

    <details class="channel-advanced" style="margin-top: 12px;">
      <summary style="cursor: pointer; padding: 8px 0; color: var(--muted);">
        Advanced settings and status
      </summary>
      ${hasMultipleAccounts
        ? nothing
        : html`
            <div class="status-list">
              <div>
                <span class="label">Configured</span>
                <span>${telegram?.configured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${telegram?.running ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Mode</span>
                <span>${telegram?.mode ?? "n/a"}</span>
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${telegram?.lastStartAt ? formatAgo(telegram.lastStartAt) : "n/a"}</span>
              </div>
              <div>
                <span class="label">Last probe</span>
                <span>${telegram?.lastProbeAt ? formatAgo(telegram.lastProbeAt) : "n/a"}</span>
              </div>
            </div>
          `}

      ${telegram?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${telegram.probe.ok ? "ok" : "failed"} ·
            ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
          </div>`
        : nothing}

      ${renderChannelConfigSection({ channelId: "telegram", props })}

      <div class="channel-actions">
        <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
          Probe
        </button>
      </div>
    </details>
  `;

  return renderChannelCard({ channelId: "telegram", state, body });
}
