/**
 * Marks for the coding CLIs in the chat mode switcher, badges and dividers:
 * the shared provider logo, with the CLI always named in text next to it.
 * See lib/provider-logos.ts and docs/licensing/BRAND-USAGE.md.
 */
import { html, type TemplateResult } from "lit";
import "../components/provider-logo.js";
import type { CliBackendId } from "./chat-route";

export function cliLogo(id: CliBackendId, size = 16): TemplateResult {
  return html`<ib-provider-logo class="cli-logo" provider=${id} size=${size}></ib-provider-logo>`;
}
