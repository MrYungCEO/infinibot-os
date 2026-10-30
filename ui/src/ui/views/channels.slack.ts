import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { SlackStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: slack?.configured ?? null,
    running: slack?.running ?? null,
    connected: slack?.running ?? null,
    hasError: Boolean(slack?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${slack?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${slack?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${slack?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${slack.lastError}
        </div>`
      : nothing}

    ${slack?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${slack.probe.ok ? "ok" : "failed"} ·
          ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: "slack", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "slack", state, body });
}
