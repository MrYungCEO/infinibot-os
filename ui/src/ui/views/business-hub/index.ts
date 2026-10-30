/**
 * Business Hub page (business-agency plugin) — mounts <business-hub-app> and
 * binds its section to the app's host sub-view (`/hub?view=…`), so the
 * section survives reloads and old /leads, /pipeline, /campaigns links land
 * on the right place.
 */

import { html } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import type { Tab } from "../../navigation";
import "./app";
import type { SectionId } from "./app";

export function renderBusinessHub(state: AppViewState, client: GatewayBrowserClient) {
  const section = (state.hostView?.hub as SectionId | undefined) ?? "overview";
  return html`<business-hub-app
    .client=${client}
    .section=${section}
    .onSection=${(s: SectionId) => state.setHostView(s)}
    .openLegacy=${(tab: string) => state.setTab(tab as Tab)}
  ></business-hub-app>`;
}
