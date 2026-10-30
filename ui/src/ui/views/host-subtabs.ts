import { html, nothing } from "lit";

import { HOSTS_WITH_OWN_SWITCHER, pathForTab, resolveSubView, subViewsForHost, type Tab } from "../navigation";
import { isTabAvailable } from "../plugin-host.js";
import { ensureHomeGlassStyles } from "./home-glass";

export interface HostSubtabsProps {
  /** The merged host page (state.tab). */
  host: Tab;
  /** Its active sub-view id (state.hostView[host]); missing → the default. */
  view?: string | null;
  basePath: string;
  onSelect: (view: string) => void;
  /** Page allowlist: sub-tabs whose backing tab isn't allowed are hidden. */
  isPageAllowed?: (tab: Tab) => boolean;
}

/**
 * Sidebar consolidation, phase 2: the in-page sub-tab bar of a merged host
 * page ("Reviews · Oversight", "Logs · Debug"…). One bar for every merged host;
 * the sub-views come from navigation HOST_SUBVIEWS. Each tab is a real link
 * (/host?view=<id>) so it can be opened in a new tab, bookmarked or shared.
 */
export function renderHostSubtabs(props: HostSubtabsProps) {
  ensureHomeGlassStyles();
  if (HOSTS_WITH_OWN_SWITCHER.has(props.host)) return nothing;
  // A plugin-gated host whose plugin is off shows only the "turned off" card.
  if (!isTabAvailable(props.host)) return nothing;
  const all = subViewsForHost(props.host);
  const shown = all.filter((v) => !v.hidden);
  const views = props.isPageAllowed
    ? shown.filter((v) => v.tab === props.host || props.isPageAllowed!(v.tab))
    : shown;
  if (views.length < 2) return nothing;
  // A routing-only (hidden) sub-view lights up the visible entry for its tab.
  const resolved = resolveSubView(props.host, props.view);
  const active = resolved?.hidden ? shown.find((v) => v.tab === resolved.tab)?.id : resolved?.id;
  const base = pathForTab(props.host, props.basePath);
  return html`<nav class="host-subtabs" role="tablist" aria-label="Sections" data-host-subtabs=${props.host}>
    ${views.map((v, i) => {
      const selected = v.id === active;
      return html`<a
        class="host-subtabs__tab ${selected ? "is-active" : ""}"
        role="tab"
        aria-selected=${selected ? "true" : "false"}
        data-host-view=${v.id}
        href=${i === 0 && v.id === all[0]?.id ? base : `${base}?view=${encodeURIComponent(v.id)}`}
        @click=${(e: MouseEvent) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (!selected) props.onSelect(v.id);
        }}
        >${v.label}</a
      >`;
    })}
  </nav>`;
}
