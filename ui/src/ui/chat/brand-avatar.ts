import { html } from "lit";
import { BRAND_DEFAULT_LOGO, resolveBrandLogoUrl } from "../controllers/app-branding";

/**
 * Assistant/agent avatar for chat surfaces: the app's brand logo (so a
 * white-labelled logo carries through). `className` keeps each surface's own
 * sizing/shape classes; `chat-logo-avatar` adds the shared img treatment.
 * The stock logo has wide transparent margins, so it also gets
 * `chat-logo-avatar--mark` (object-view-box crop to the emblem) — custom
 * logos are shown whole.
 */
export function renderBrandAvatar(className: string, alt: string) {
  const src = resolveBrandLogoUrl();
  const mark = src.endsWith(BRAND_DEFAULT_LOGO.slice(1)) ? " chat-logo-avatar--mark" : "";
  return html`<img
    class="${className} chat-logo-avatar${mark}"
    src="${src}"
    alt="${alt}"
    draggable="false"
    decoding="async"
  />`;
}
