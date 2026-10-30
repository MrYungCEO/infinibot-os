import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { WhatsAppStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";
import { formatDuration } from "./channels.shared";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: whatsapp?.configured ?? null,
    running: whatsapp?.running ?? null,
    connected: whatsapp?.connected ?? whatsapp?.linked ?? null,
    hasError: Boolean(whatsapp?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${whatsapp?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Linked</span>
        <span>${whatsapp?.linked ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${whatsapp?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Connected</span>
        <span>${whatsapp?.connected ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last connect</span>
        <span>
          ${whatsapp?.lastConnectedAt
            ? formatAgo(whatsapp.lastConnectedAt)
            : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Last message</span>
        <span>
          ${whatsapp?.lastMessageAt ? formatAgo(whatsapp.lastMessageAt) : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Auth age</span>
        <span>
          ${whatsapp?.authAgeMs != null
            ? formatDuration(whatsapp.authAgeMs)
            : "n/a"}
        </span>
      </div>
    </div>

    ${whatsapp?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${whatsapp.lastError}
        </div>`
      : nothing}

    ${props.whatsappMessage
      ? html`<div class="callout" style="margin-top: 12px;">
          ${props.whatsappMessage}
        </div>`
      : nothing}

    ${props.whatsappQrDataUrl
      ? html`<div class="qr-wrap">
          <img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" />
          <div class="qr-hint">
            Open WhatsApp → <strong>Linked Devices</strong> → scan this code. It
            links automatically once scanned — no need to click anything else.
          </div>
        </div>`
      : nothing}

    <div class="channel-actions" data-learn-id="channels-whatsapp-actions">
      <button
        class="btn channel-btn primary"
        data-learn-id="channels-whatsapp-connect"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppStart(false)}
      >
        ${props.whatsappBusy ? "Working…" : "Connect (Show QR)"}
      </button>
      <button
        class="btn channel-btn"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppStart(true)}
      >
        Relink
      </button>
      <button
        class="btn channel-btn"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppWait()}
      >
        Wait for scan
      </button>
      <button
        class="btn channel-btn danger"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppLogout()}
      >
        Logout
      </button>
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Refresh
      </button>
    </div>

    ${renderChannelConfigSection({ channelId: "whatsapp", props })}
  `;

  return renderChannelCard({ channelId: "whatsapp", state, body });
}
