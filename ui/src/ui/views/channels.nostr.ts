import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { ChannelAccountSnapshot, NostrStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";
import {
  renderNostrProfileForm,
  type NostrProfileFormState,
  type NostrProfileFormCallbacks,
} from "./channels.nostr-profile-form";

/**
 * Truncate a pubkey for display (shows first and last 8 chars)
 */
function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) return "n/a";
  if (pubkey.length <= 20) return pubkey;
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export function renderNostrCard(params: {
  props: ChannelsProps;
  nostr?: NostrStatus | null;
  nostrAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
  /** Profile form state (optional - if provided, shows form) */
  profileFormState?: NostrProfileFormState | null;
  /** Profile form callbacks */
  profileFormCallbacks?: NostrProfileFormCallbacks | null;
  /** Called when Edit Profile is clicked */
  onEditProfile?: () => void;
}) {
  const {
    props,
    nostr,
    nostrAccounts,
    accountCountLabel,
    profileFormState,
    profileFormCallbacks,
    onEditProfile,
  } = params;
  const primaryAccount = nostrAccounts[0];
  const summaryConfigured = nostr?.configured ?? primaryAccount?.configured ?? false;
  const summaryRunning = nostr?.running ?? primaryAccount?.running ?? false;
  const summaryPublicKey =
    nostr?.publicKey ??
    (primaryAccount as { publicKey?: string } | undefined)?.publicKey;
  const summaryLastStartAt = nostr?.lastStartAt ?? primaryAccount?.lastStartAt ?? null;
  const summaryLastError = nostr?.lastError ?? primaryAccount?.lastError ?? null;
  const hasMultipleAccounts = nostrAccounts.length > 1;
  const showingForm = profileFormState !== null && profileFormState !== undefined;

  const state = deriveConnectionState({
    configured: summaryConfigured,
    running: summaryRunning,
    connected: summaryRunning,
    hasError: Boolean(summaryLastError),
  });

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const publicKey = (account as { publicKey?: string }).publicKey;
    const profile = (account as { profile?: { name?: string; displayName?: string } }).profile;
    const displayName = profile?.displayName ?? profile?.name ?? account.name ?? account.accountId;

    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${displayName}</div>
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
            <span class="label">Public Key</span>
            <span class="monospace" title="${publicKey ?? ""}">${truncatePubkey(publicKey)}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : "n/a"}</span>
          </div>
          ${account.lastError
            ? html`
                <div class="account-card-error">${account.lastError}</div>
              `
            : nothing}
        </div>
      </div>
    `;
  };

  const renderProfileSection = () => {
    // If showing form, render the form instead of the read-only view
    if (showingForm && profileFormCallbacks) {
      return renderNostrProfileForm({
        state: profileFormState,
        callbacks: profileFormCallbacks,
        accountId: nostrAccounts[0]?.accountId ?? "default",
      });
    }

    const profile =
      (primaryAccount as
        | {
            profile?: {
              name?: string;
              displayName?: string;
              about?: string;
              picture?: string;
              nip05?: string;
            };
          }
        | undefined)?.profile ?? nostr?.profile;
    const { name, displayName, about, picture, nip05 } = profile ?? {};
    const hasAnyProfileData = name || displayName || about || picture || nip05;

    return html`
      <div class="nostr-profile">
        <div class="nostr-profile__header">
          <div class="nostr-profile__title">Profile</div>
          ${summaryConfigured
            ? html`
                <button
                  class="btn btn-sm"
                  @click=${onEditProfile}
                >
                  Edit Profile
                </button>
              `
            : nothing}
        </div>
        ${hasAnyProfileData
          ? html`
              <div class="status-list">
                ${picture
                  ? html`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${picture}
                          alt="Profile picture"
                          class="nostr-profile__avatar"
                          @error=${(e: Event) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    `
                  : nothing}
                ${name ? html`<div><span class="label">Name</span><span>${name}</span></div>` : nothing}
                ${displayName
                  ? html`<div><span class="label">Display Name</span><span>${displayName}</span></div>`
                  : nothing}
                ${about
                  ? html`<div><span class="label">About</span><span>${about}</span></div>`
                  : nothing}
                ${nip05 ? html`<div><span class="label">NIP-05</span><span>${nip05}</span></div>` : nothing}
              </div>
            `
          : html`
              <div class="nostr-profile__empty">
                No profile set. Click "Edit Profile" to add your name, bio, and avatar.
              </div>
            `}
      </div>
    `;
  };

  const body = html`
    ${accountCountLabel}

    ${hasMultipleAccounts
      ? html`
          <div class="account-card-list">
            ${nostrAccounts.map((account) => renderAccountCard(account))}
          </div>
        `
      : html`
          <div class="status-list">
            <div>
              <span class="label">Configured</span>
              <span>${summaryConfigured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${summaryRunning ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Public Key</span>
              <span class="monospace" title="${summaryPublicKey ?? ""}"
                >${truncatePubkey(summaryPublicKey)}</span
              >
            </div>
            <div>
              <span class="label">Last start</span>
              <span>${summaryLastStartAt ? formatAgo(summaryLastStartAt) : "n/a"}</span>
            </div>
          </div>
        `}

    ${summaryLastError
      ? html`<div class="callout danger" style="margin-top: 12px;">${summaryLastError}</div>`
      : nothing}

    ${renderProfileSection()}

    ${renderChannelConfigSection({ channelId: "nostr", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(false)}>
        Refresh
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "nostr", state, body });
}
