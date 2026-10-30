import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";

export type ChannelBrand = {
  /** Display name shown in the header. */
  label: string;
  /** Short tagline used for the card subhead. */
  tagline: string;
  /** Brand colour used for the logo + glow halo. */
  color: string;
  /** Inline `<path>` / `<g>` markup rendered inside a 24×24 viewBox. */
  pathMarkup: string;
  /**
   * true = the brand's own mark, used under its published guidelines. It is
   * drawn on the card background with no tinted tile, gradient, border or
   * glow (brand rules forbid enclosing or altering marks). Generic glyphs
   * leave this unset and keep the tile.
   */
  officialMark?: boolean;
};

/**
 * Channel glyphs. Single-colour, scalable, viewBox 0 0 24 24, `currentColor`.
 *
 * Only Telegram shows its own mark (Telegram allows its logo for "send to
 * Telegram"-style uses). Every other channel uses a generic chat glyph and
 * is named in plain text: Discord, Slack and Microsoft Teams require a
 * licence for their logos, and WhatsApp may only be shown with Meta's
 * supplied asset, unmodified, which is not bundled here.
 * See docs/licensing/BRAND-USAGE.md.
 */
export const CHANNEL_BRANDS: Record<string, ChannelBrand> = {
  whatsapp: {
    label: "WhatsApp",
    tagline: "Personal & business messaging via WhatsApp Web",
    color: "#25D366",
    pathMarkup: `
      <path fill="currentColor" d="M4.5 3.5h15a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.6c-.5.4-1.2 0-1.2-.6v-3H4.5A2.5 2.5 0 0 1 2 15V6a2.5 2.5 0 0 1 2.5-2.5zM7 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>
    `,
  },
  telegram: {
    label: "Telegram",
    tagline: "Bot API messaging with channels, groups & DMs",
    color: "#229ED9",
    officialMark: true,
    pathMarkup: `
      <path fill="currentColor" d="M21.4 4.3 18.1 19c-.2 1.1-.9 1.4-1.8.9l-5-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.2 9.5-8.6c.4-.4-.1-.6-.6-.2L5.5 11.5l-5-1.6C-.6 9.6-.6 8.9.6 8.5l19.5-7.6c.9-.3 1.7.2 1.3 3.4z"/>
    `,
  },
  discord: {
    label: "Discord",
    tagline: "Bot status, guilds & channel configuration",
    color: "#5865F2",
    pathMarkup: `
      <path fill="currentColor" d="M4.5 3.5h15a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.6c-.5.4-1.2 0-1.2-.6v-3H4.5A2.5 2.5 0 0 1 2 15V6a2.5 2.5 0 0 1 2.5-2.5zM7 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>
    `,
  },
  slack: {
    label: "Slack",
    tagline: "Socket-mode bot, workspaces & channel hooks",
    color: "#E01E5A",
    pathMarkup: `
      <path fill="currentColor" d="M4.5 3.5h15a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.6c-.5.4-1.2 0-1.2-.6v-3H4.5A2.5 2.5 0 0 1 2 15V6a2.5 2.5 0 0 1 2.5-2.5zM7 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>
    `,
  },
  signal: {
    label: "Signal",
    tagline: "End-to-end encrypted messaging via signal-cli",
    color: "#3A76F0",
    pathMarkup: `
      <path fill="currentColor" d="M12 2.2c-5.4 0-9.8 4.4-9.8 9.8 0 1.5.4 3 1 4.4l-1 4.4 4.4-1c1.4.7 2.9 1 4.4 1 5.4 0 9.8-4.4 9.8-9.8S17.4 2.2 12 2.2zm0 17.6c-1.4 0-2.8-.4-4.1-1l-.4-.2-3 .7.7-3-.2-.4c-.7-1.3-1-2.7-1-4.1 0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8z"/>
    `,
  },
  imessage: {
    label: "iMessage",
    tagline: "macOS bridge for Apple's native messaging",
    color: "#00C853",
    pathMarkup: `
      <path fill="currentColor" d="M12 2.5c-5.6 0-10 4-10 9 0 2.7 1.3 5.1 3.5 6.8v3.7l3.6-2A11 11 0 0 0 12 20.5c5.6 0 10-4 10-9s-4.5-9-10-9zm-4.4 11 2.8-3 2.4 1.8 3.6-3.7-2.7 5-2.4-1.8-3.7 3.7z"/>
    `,
  },
  googlechat: {
    label: "Google Chat",
    tagline: "Chat API webhooks, spaces & service accounts",
    color: "#00897B",
    pathMarkup: `
      <path fill="currentColor" d="M19.6 4.4H4.4c-1.3 0-2.4 1.1-2.4 2.4v10.4c0 1.3 1.1 2.4 2.4 2.4h11.2l4 4V6.8c0-1.3-1-2.4-2-2.4zM17 13.8H7c-.6 0-1-.4-1-1s.4-1 1-1h10c.6 0 1 .4 1 1s-.4 1-1 1zm0-4H7c-.6 0-1-.4-1-1s.4-1 1-1h10c.6 0 1 .4 1 1s-.4 1-1 1z"/>
    `,
  },
  nostr: {
    label: "Nostr",
    tagline: "Decentralized DMs over Nostr relays (NIP-04)",
    color: "#8E44EC",
    pathMarkup: `
      <path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5.6 11.4-.8 2.8-.9 3-2.3-.4c-1 .1-2.1 0-3.1-.4l-.8 2.4-1.7-.6 2-6.3c-.4-.7-.7-1.4-.9-2.2-.6-3.4 1.7-6.6 5.2-7.2 1.2-.2 2.4 0 3.5.5l-.5 1.4c-.8-.4-1.7-.6-2.6-.4-2.4.4-4 2.7-3.6 5.1.1.7.4 1.3.8 1.8l.5-1.6 1.8.5-.5 1.7c.7.3 1.4.4 2.2.3.5-.1 1-.2 1.5-.4l1.2-.4z"/>
    `,
  },
  bluebubbles: {
    label: "BlueBubbles",
    tagline: "BlueBubbles iMessage relay server",
    color: "#3E8AFA",
    pathMarkup: `
      <path fill="currentColor" d="M12 2c5.5 0 10 4.5 10 10s-4.5 10-10 10S2 17.5 2 12 6.5 2 12 2zm-3 7c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
    `,
  },
  mattermost: {
    label: "Mattermost",
    tagline: "Open-source team messaging",
    color: "#0072C6",
    pathMarkup: `
      <path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 16c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.7 6 6-2.7 6-6 6z"/>
    `,
  },
  msteams: {
    label: "Microsoft Teams",
    tagline: "Microsoft Teams bot via Bot Framework",
    color: "#6264A7",
    pathMarkup: `
      <path fill="currentColor" d="M4.5 3.5h15a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.6 3.6c-.5.4-1.2 0-1.2-.6v-3H4.5A2.5 2.5 0 0 1 2 15V6a2.5 2.5 0 0 1 2.5-2.5zM7 9.3a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm5 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>
    `,
  },
};

/** Fallback used for channels we don't have a glyph for yet. */
const FALLBACK_BRAND: ChannelBrand = {
  label: "Channel",
  tagline: "Custom channel plugin",
  color: "#6366f1",
  pathMarkup: `
    <path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm-4-9h8v2H8z"/>
  `,
};

export function getChannelBrand(id: string): ChannelBrand {
  return CHANNEL_BRANDS[id] ?? { ...FALLBACK_BRAND, label: id };
}

/**
 * Render the channel glyph at `size` px. Generic glyphs sit in a tinted
 * tile; official marks are drawn plain (`channel-logo--mark`).
 */
export function renderChannelLogo(id: string, size = 44): TemplateResult {
  const brand = getChannelBrand(id);
  return html`
    <span
      class="channel-logo ${brand.officialMark ? "channel-logo--mark" : ""}"
      style="--brand: ${brand.color}; width: ${size}px; height: ${size}px;"
      aria-label="${brand.label}"
      title="${brand.label}"
    >
      <svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
        ${unsafeSVG(brand.pathMarkup)}
      </svg>
    </span>
  `;
}
