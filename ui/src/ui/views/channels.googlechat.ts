import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { GoogleChatStatus } from "../types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";
import type { ChannelsProps } from "./channels.types";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googlechat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googlechat, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: googlechat?.configured ?? null,
    running: googlechat?.running ?? null,
    connected: googlechat?.running ?? null,
    hasError: Boolean(googlechat?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${googlechat ? (googlechat.configured ? "Yes" : "No") : "n/a"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${googlechat ? (googlechat.running ? "Yes" : "No") : "n/a"}</span>
      </div>
      <div>
        <span class="label">Credential</span>
        <span>${googlechat?.credentialSource ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Audience</span>
        <span>
          ${googlechat?.audienceType
            ? `${googlechat.audienceType}${googlechat.audience ? ` · ${googlechat.audience}` : ""}`
            : "n/a"}
        </span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${googlechat?.lastStartAt ? formatAgo(googlechat.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${googlechat?.lastProbeAt ? formatAgo(googlechat.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${googlechat?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${googlechat.lastError}
        </div>`
      : nothing}

    ${googlechat?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${googlechat.probe.ok ? "ok" : "failed"} ·
          ${googlechat.probe.status ?? ""} ${googlechat.probe.error ?? ""}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: "googlechat", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "googlechat", state, body });
}
