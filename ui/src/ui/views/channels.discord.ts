import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { DiscordStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: discord?.configured ?? null,
    running: discord?.running ?? null,
    connected: discord?.running ?? null,
    hasError: Boolean(discord?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${discord?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${discord?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${discord?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${discord.lastError}
        </div>`
      : nothing}

    ${discord?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${discord.probe.ok ? "ok" : "failed"} ·
          ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: "discord", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "discord", state, body });
}
