import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { IMessageStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: imessage?.configured ?? null,
    running: imessage?.running ?? null,
    connected: imessage?.running ?? null,
    hasError: Boolean(imessage?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${imessage?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${imessage?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${imessage?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${imessage.lastError}
        </div>`
      : nothing}

    ${imessage?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${imessage.probe.ok ? "ok" : "failed"} ·
          ${imessage.probe.error ?? ""}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: "imessage", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "imessage", state, body });
}
