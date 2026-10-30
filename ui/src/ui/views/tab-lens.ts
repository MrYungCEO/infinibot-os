import { html, nothing } from "lit";

import { t } from "../i18n";
import {
  RETIRED_TABS,
  navLabelForTab,
  pathForTab,
  relatedTabsForHost,
  titleForTab,
  type Tab,
} from "../navigation";
import { ensureHomeGlassStyles } from "./home-glass";

export interface TabLensProps {
  tab: Tab;
  basePath: string;
  onSelect: (tab: Tab) => void;
}

/**
 * Sidebar consolidation, phase 1: pages that lost their own sidebar entry are
 * still full pages. On a host page ("Command", "Register", "Setup"…) show
 * "Also here: …" links to the pages it now hosts; on one of those pages show a
 * "Part of <host>" link back. Nav-only — no view is merged or changed.
 */
export function renderTabLensLinks(props: TabLensProps) {
  ensureHomeGlassStyles();
  const go = (tab: Tab) => (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    props.onSelect(tab);
  };
  const chip = (tab: Tab, label: string) => html`<a
    class="topbar-tabctx__lens-chip"
    href=${pathForTab(tab, props.basePath)}
    data-lens-tab=${tab}
    @click=${go(tab)}
    >${label}</a
  >`;
  const host = RETIRED_TABS[props.tab];
  if (host) {
    return html`<span class="topbar-tabctx__lens" data-tab-lens="part-of">
      <span class="topbar-tabctx__lens-label">${t("nav.partOf", undefined, "Part of")}</span>
      ${chip(host, navLabelForTab(host))}
    </span>`;
  }
  const related = relatedTabsForHost(props.tab);
  if (!related.length) return nothing;
  return html`<span class="topbar-tabctx__lens" data-tab-lens="also-here">
    <span class="topbar-tabctx__lens-label">${t("nav.alsoHere", undefined, "Also here")}</span>
    ${related.map((tab) => chip(tab, titleForTab(tab)))}
  </span>`;
}
