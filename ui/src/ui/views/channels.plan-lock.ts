/**
 * A channel card for a channel the hosted plan leaves out (Free: Telegram,
 * Slack). No connect / edit form: a lock and the upgrade. When credentials are
 * already saved (a downgrade) the card says "Paused on Free" and nothing is
 * removed. Only rendered when /api/me listed the channel in `channelsExcluded`,
 * so self-hosted and paid workspaces never see it.
 */
import { html, type TemplateResult } from "lit";

import { channelLockView, channelsExcluded } from "../cloud/plan-channels";
import { openUpgrade } from "../cloud/upgrade";
import { icon } from "../icons";
import { getChannelBrand, renderChannelLogo } from "./channels.logos";
import { channelEnabled } from "./channels.shared";
import type { ChannelKey, ChannelsProps } from "./channels.types";

/** Saved credentials the plan has paused (configured / accounts / the server's `disabled`). */
function hasSavedConnection(key: ChannelKey, props: ChannelsProps): boolean {
  const status = (props.snapshot?.channels as Record<string, { disabled?: unknown }> | null | undefined)?.[key];
  return status?.disabled === true || channelEnabled(key, props);
}

/** The locked / paused card, or null when the plan includes this channel (render the normal card). */
export function renderPlanLockedChannelCard(key: ChannelKey, props: ChannelsProps): TemplateResult | null {
  const lock = channelLockView(key, channelsExcluded(), hasSavedConnection(key, props));
  if (!lock) return null;
  const brand = getChannelBrand(key);
  return html`
    <div
      class="channel-card channel-card--plan-locked is-disconnected"
      data-ib-target=${`control:channels/${key}`}
      style="--brand: ${brand.color};"
      data-channel-id=${key}
      data-plan-lock=${lock.kind}
      data-testid=${`channel-plan-lock-${key}`}
    >
      <div class="channel-card-header">
        ${renderChannelLogo(key, 44)}
        <div class="channel-card-heading">
          <div class="channel-title">${brand.label}</div>
          <div class="channel-tagline">${brand.tagline}</div>
        </div>
        <span class="channel-status-pill plan-locked" role="status">
          ${icon("lock")}<span>${lock.kind === "paused" ? "Paused" : "Locked"}</span>
        </span>
      </div>
      <div class="channel-plan-lock">
        <div class="channel-plan-lock__title">${lock.title}</div>
        <p class="channel-plan-lock__body">${lock.body}</p>
        <div class="channel-actions">
          <button
            class="btn channel-btn channel-plan-lock__cta"
            data-testid="channel-plan-upgrade"
            @click=${() => void openUpgrade("pro", { source: `channels:${key}` })}
          >
            ${icon("zap")}${lock.cta}
          </button>
        </div>
      </div>
    </div>
  `;
}
