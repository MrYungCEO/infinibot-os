import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { SignalStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { deriveConnectionState, renderChannelCard } from "./channels.card";
import { renderChannelConfigSection } from "./channels.config";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;

  const state = deriveConnectionState({
    configured: signal?.configured ?? null,
    running: signal?.running ?? null,
    connected: signal?.running ?? null,
    hasError: Boolean(signal?.lastError),
  });

  const body = html`
    ${accountCountLabel}

    <div class="status-list">
      <div>
        <span class="label">Configured</span>
        <span>${signal?.configured ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Running</span>
        <span>${signal?.running ? "Yes" : "No"}</span>
      </div>
      <div>
        <span class="label">Base URL</span>
        <span>${signal?.baseUrl ?? "n/a"}</span>
      </div>
      <div>
        <span class="label">Last start</span>
        <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : "n/a"}</span>
      </div>
      <div>
        <span class="label">Last probe</span>
        <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : "n/a"}</span>
      </div>
    </div>

    ${signal?.lastError
      ? html`<div class="callout danger" style="margin-top: 12px;">
          ${signal.lastError}
        </div>`
      : nothing}

    ${signal?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          Probe ${signal.probe.ok ? "ok" : "failed"} ·
          ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
        </div>`
      : nothing}

    ${renderChannelConfigSection({ channelId: "signal", props })}

    <div class="channel-actions">
      <button class="btn channel-btn" @click=${() => props.onRefresh(true)}>
        Probe
      </button>
    </div>
  `;

  return renderChannelCard({ channelId: "signal", state, body });
}
