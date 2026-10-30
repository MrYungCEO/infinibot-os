import { html, nothing, type TemplateResult } from "lit";

import { getChannelBrand, renderChannelLogo } from "./channels.logos";

export type ChannelConnectionState = "connected" | "disconnected" | "error" | "pending" | "unconfigured";

export type ChannelStatusInput = {
  configured?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  hasError?: boolean | null;
};

/** Derive the visual state for the pill from the raw channel snapshot booleans. */
export function deriveConnectionState(input: ChannelStatusInput): ChannelConnectionState {
  if (input.hasError) return "error";
  if (input.connected) return "connected";
  if (input.running && input.configured) return "pending";
  if (input.configured) return "disconnected";
  return "unconfigured";
}

const STATE_LABEL: Record<ChannelConnectionState, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
  pending: "Connecting",
  unconfigured: "Not Configured",
};

/** Render the status pill (dot + label, tinted by state). */
export function renderStatusPill(state: ChannelConnectionState): TemplateResult {
  return html`
    <span class="channel-status-pill ${state}" role="status">
      <span class="dot" aria-hidden="true"></span>
      <span>${STATE_LABEL[state]}</span>
    </span>
  `;
}

/**
 * Standard card chrome (logo + title + tagline + status pill). The per-channel
 * cards wrap their own body content with this so we get consistent glass-
 * morphism styling and brand-tinted accents across all channels.
 */
export function renderChannelCard(params: {
  channelId: string;
  state: ChannelConnectionState;
  /** Override the brand label (otherwise pulled from CHANNEL_BRANDS). */
  labelOverride?: string;
  /** Override the brand tagline (otherwise pulled from CHANNEL_BRANDS). */
  taglineOverride?: string;
  /** Body markup (status grid, errors, config form, action buttons, …). */
  body: TemplateResult | TemplateResult[] | typeof nothing;
}): TemplateResult {
  const brand = getChannelBrand(params.channelId);
  const label = params.labelOverride ?? brand.label;
  const tagline = params.taglineOverride ?? brand.tagline;
  const isDisconnected =
    params.state === "disconnected" || params.state === "unconfigured";
  return html`
    <div
      class="channel-card is-${params.state} ${isDisconnected ? "is-disconnected" : ""}"
      data-ib-target=${`control:channels/${params.channelId}`}
      style="--brand: ${brand.color};"
      data-channel-id="${params.channelId}"
    >
      <div class="channel-card-header">
        ${renderChannelLogo(params.channelId, 44)}
        <div class="channel-card-heading">
          <div class="channel-title">${label}</div>
          <div class="channel-tagline">${tagline}</div>
        </div>
        ${renderStatusPill(params.state)}
      </div>
      ${params.body}
    </div>
  `;
}

/** Render a labelled "Where do I find this?" link row (used in setup notes). */
export function renderHelpLink(params: {
  href: string;
  label: string;
}): TemplateResult {
  return html`
    <a href="${params.href}" target="_blank" rel="noopener noreferrer">
      ${params.label}
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"></path><path d="M7 7h10v10"></path></svg>
    </a>
  `;
}
