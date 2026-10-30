/**
 * Research page entry (lazy chunk). The page is one self-contained element;
 * app-render hands it the gateway client and the app (for cross-page navigation).
 */
import { html, type TemplateResult } from "lit";
import type { AppViewState } from "../../app-view-state";
import type { GatewayBrowserClient } from "../../gateway";
import "./workspace";

export function renderResearchWorkspace(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  return html`<infinibot-research-workspace
    .client=${client}
    .app=${state}
    .connected=${Boolean((state as { connected?: boolean }).connected)}
  ></infinibot-research-workspace>`;
}
