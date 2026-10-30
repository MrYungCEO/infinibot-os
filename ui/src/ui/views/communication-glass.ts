import { css, html, type TemplateResult } from "lit";

/** Shared visual language for communication surfaces in both shadow and light DOM. */
export const communicationGlassShadowStyles = css`
  :host {
    --comms-gold: var(--glass-gold, #d9b45f);
    --comms-gold-hi: var(--glass-gold-hi, #f1d38a);
    --comms-line: var(--glass-stroke, color-mix(in srgb, var(--comms-gold) 16%, transparent));
    --comms-line-strong: var(--glass-stroke-gold, color-mix(in srgb, var(--comms-gold) 34%, transparent));
    --comms-panel: var(--glass-2, rgba(24, 22, 18, .58));
    --comms-card: var(--glass-3, rgba(34, 31, 25, .64));
    --comms-float: var(--glass-4, rgba(30, 27, 22, .88));
    --comms-fg: var(--glass-fg, var(--g-fg, #f4f1ea));
    --comms-fg-2: var(--glass-fg-2, var(--g-fg-dim, color-mix(in srgb, var(--comms-fg) 72%, transparent)));
    --comms-fg-3: var(--glass-fg-3, var(--g-fg-faint, color-mix(in srgb, var(--comms-fg) 48%, transparent)));
    color: var(--comms-fg);
    font-family: var(--glass-font, var(--font-ui, Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif));
    -webkit-font-smoothing: antialiased;
  }
  :host-context([data-theme="light"]) {
    --comms-panel: var(--glass-2, rgba(255,255,255,.68));
    --comms-card: var(--glass-3, rgba(255,255,255,.78));
    --comms-float: var(--glass-4, rgba(255,255,255,.92));
  }
  :host, .wrap, .hub { position: relative; isolation: isolate; }
  :host::before, .wrap::before, .hub::before {
    content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background: radial-gradient(620px 340px at 12% -4%, var(--glass-gold-a16, rgba(217,180,95,.14)), transparent 72%),
      radial-gradient(520px 300px at 94% 18%, var(--glass-gold-a10, rgba(217,180,95,.08)), transparent 75%);
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; }
  .comm-icon { display: inline-block; flex: 0 0 auto; vertical-align: -0.18em; }
  :focus-visible { outline: none !important; box-shadow: var(--glass-focus-ring, 0 0 0 3px rgba(217,180,95,.28)) !important; }

  .page-head, .head, .hub-header {
    background: var(--glass-sheen), var(--comms-panel) !important;
    border: 1px solid var(--comms-line) !important;
    border-radius: var(--glass-radius-lg, 20px) !important;
    box-shadow: var(--glass-elev-2) !important;
    backdrop-filter: var(--glass-blur, blur(20px) saturate(150%));
    -webkit-backdrop-filter: var(--glass-blur, blur(20px) saturate(150%));
    padding: 18px 20px !important;
  }
  .page-title, .title, .hub-crumbs { letter-spacing: var(--glass-tracking-tight, -.025em); font-weight: 680 !important; }
  .page-sub, .sub, .muted { color: var(--comms-fg-2) !important; }

  .card, .panel, .child-panel, .kpi, .stat-tile, .health-strip, .kind-card,
  .viz-card, .insight-card, .ai-band, .yt-section, .sub-page, .account-select,
  .ri-panel, .ri-article-card, .ri-settings-group, .ri-asset-card, .ri-topic-row {
    background: var(--glass-sheen), var(--comms-card) !important;
    border: 1px solid var(--comms-line) !important;
    box-shadow: var(--glass-elev-2) !important;
  }
  button.card, .kind-card, .ri-article-card, .ri-asset-card, .feature-tile {
    transition: transform var(--glass-dur, 180ms) var(--glass-spring, cubic-bezier(.2,.8,.2,1)), border-color var(--glass-dur-fast, 120ms), box-shadow var(--glass-dur, 180ms);
  }
  button.card:hover, .kind-card:hover, .ri-article-card:hover, .ri-asset-card:hover, .feature-tile:hover {
    transform: var(--glass-lift, translateY(-2px)); border-color: var(--comms-line-strong) !important; box-shadow: var(--glass-elev-3), var(--glass-glow-soft) !important;
  }
  .btn, .btn-ghost, .btn-primary, .action-btn, .score-now, .score-all-btn, .transcribe-btn,
  .onboarding-btn, .ri-btn, .ri-btn-icon, .freshness-refresh, .btn-advance {
    border-radius: var(--glass-radius-sm, 10px) !important;
    border: 1px solid var(--comms-line) !important;
    background: var(--glass-sheen), var(--glass-hover, color-mix(in srgb, var(--comms-fg) 6%, transparent)) !important;
    color: var(--comms-fg) !important;
    box-shadow: var(--glass-elev-1) !important;
    transition: transform var(--glass-dur-fast, 120ms), border-color var(--glass-dur-fast, 120ms), background var(--glass-dur-fast, 120ms);
  }
  .btn:hover, .btn-ghost:hover, .action-btn:hover, .ri-btn:hover, .ri-btn-icon:hover { transform: var(--glass-lift, translateY(-1px)); border-color: var(--comms-line-strong) !important; }
  .btn-primary, .score-now, .score-all-btn, .transcribe-btn, .onboarding-btn, .ri-btn.gold {
    background: var(--glass-gold-fill, linear-gradient(135deg,#f1d38a,#b98122)) !important;
    color: var(--glass-ink, #160f03) !important; border-color: transparent !important; font-weight: 700;
  }
  .input, .modal-input, .search, .sort, .account-list, .hub-search, .hub-select,
  .ri-input, .ri-select, .ri-search-input, textarea, select, input[type="text"], input[type="password"], input[type="number"], input[type="email"] {
    background: color-mix(in srgb, var(--glass-base, #090806) 62%, transparent) !important;
    color: var(--comms-fg) !important; border: 1px solid var(--comms-line) !important;
    border-radius: var(--glass-radius-sm, 10px) !important;
  }
  .modal, .modal-box, .wizard, .fm-modal {
    background: var(--glass-sheen), var(--comms-float) !important; border: 1px solid var(--comms-line-strong) !important;
    box-shadow: var(--glass-elev-4) !important; backdrop-filter: var(--glass-blur-lg, blur(28px) saturate(160%));
  }
  .modal-scrim, .modal-backdrop, .wizard-overlay, .fm-overlay { backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .empty, .state-empty, .onboarding, .ri-empty, .ri-detail-empty {
    background: var(--glass-sheen), var(--comms-panel) !important; border: 1px dashed var(--comms-line-strong) !important;
    border-radius: var(--glass-radius-lg, 20px) !important; color: var(--comms-fg-2) !important;
  }
  .spinner, .ri-spinner { border-color: var(--comms-line) !important; border-top-color: var(--comms-gold) !important; }
  .kpi-val, .stat-val, .ri-metric-value { font-variant-numeric: tabular-nums; letter-spacing: -.035em; }
  .status, .badge, .freshness-pill, .stage-chip, .ri-tag, .ri-status-pill { backdrop-filter: none; border: 1px solid var(--comms-line) !important; }
  .detail-tabs, .sub-tabs, .ri-tabs { background: var(--glass-1) !important; border: 1px solid var(--comms-line) !important; border-radius: var(--glass-radius, 14px) !important; padding: 4px !important; }
  .detail-tab.is-active, .sub-tab.is-active, .ri-tab.active { background: var(--glass-gold-tint) !important; color: var(--comms-gold-hi) !important; }

  @media (max-width: 520px) {
    .wrap, .hub { padding: 10px !important; }
    .page-head, .head, .hub-header { padding: 14px !important; border-radius: 16px !important; }
    .grid, .kpis, .kpi-row, .overview-row, .ri-metrics { grid-template-columns: minmax(0,1fr) !important; }
    .controls, .hub-controls, .page-head { align-items: stretch !important; }
    .btn, .btn-primary, .action-btn { min-height: 42px; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
  @media (prefers-reduced-transparency: reduce) {
    .page-head, .head, .hub-header, .modal, .modal-box, .wizard, .fm-modal { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: var(--glass-solid) !important; }
    .wrap::before, .hub::before { display: none; }
  }
`;

const globalStyles = `
  :where(.uib-host,.ibm-root,.inbox-page,.comms-hub,.ri-dashboard,.socials-analytics) {
    --cg-gold: var(--glass-gold,#d9b45f); --cg-line: var(--glass-stroke,rgba(217,180,95,.16));
    --cg-line-strong: var(--glass-stroke-gold,rgba(217,180,95,.34)); --cg-fg: var(--glass-fg,var(--g-fg,#f4f1ea));
    --cg-fg2: var(--glass-fg-2,var(--g-fg-dim,#bbb5aa)); color:var(--cg-fg); font-family:var(--glass-font,var(--font-ui,Inter,"SF Pro Display",-apple-system,sans-serif));
    -webkit-font-smoothing:antialiased;
  }
  .comm-icon{display:inline-block;flex:0 0 auto;vertical-align:-.18em}
  .uib-host { position:relative; isolation:isolate; padding:12px; gap:10px; }
  .uib-host::before { content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(600px 300px at 12% 0,var(--glass-gold-a16,rgba(217,180,95,.12)),transparent 72%); }
  .uib-account-bar,.uib-view-toggle,.ibm-search-bar,.inbox-header,.inbox-filters,.comms-pane,.comms-thread-pane,.comms-conversation-pane,.ri-header,.socials-header {
    background:var(--glass-sheen),var(--glass-2)!important;border:1px solid var(--cg-line)!important;border-radius:var(--glass-radius-lg,20px)!important;
    box-shadow:var(--glass-elev-2)!important;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);
  }
  .uib-account-bar,.uib-view-toggle { border-bottom:1px solid var(--cg-line)!important; padding:9px 12px!important; }
  .uib-account-pill,.uib-view-tab,.uib-connect-btn,.ibm-btn,.lp-btn,.filter-chip,.comms-btn,.comms-select,.comms-input,
  .ri-btn,.ri-btn-icon,.ri-tab,.toast-close,.notif-toast__action,.notif-toast__close,.threads-sidebar__btn,.sidebar-add-category,.context-menu-item {
    border:1px solid var(--cg-line)!important;background:var(--glass-sheen),var(--glass-hover)!important;color:var(--cg-fg)!important;border-radius:var(--glass-radius-sm,10px)!important;
    transition:transform var(--glass-dur-fast,120ms),border-color var(--glass-dur-fast,120ms),background var(--glass-dur-fast,120ms)!important;
  }
  :where(.uib-account-pill,.uib-view-tab,.uib-connect-btn,.ibm-btn,.lp-btn,.filter-chip,.comms-btn,.ri-btn,.ri-btn-icon,.threads-sidebar__btn,.sidebar-add-category):hover { transform:var(--glass-lift,translateY(-1px));border-color:var(--cg-line-strong)!important; }
  .uib-account-pill.active,.uib-view-tab.active,.ibm-label-btn.active,.filter-chip--active,.ri-tab.active { background:var(--glass-gold-tint)!important;color:var(--glass-gold-hi,var(--cg-gold))!important;border-color:var(--cg-line-strong)!important; }
  .uib-save-btn,.ibm-btn-compose,.comms-btn-primary,.threads-sidebar__btn--primary { background:var(--glass-gold-fill)!important;color:var(--glass-ink,#160f03)!important;border-color:transparent!important;font-weight:700; }
  .uib-body { padding:0!important; }
  .uib-stat-card,.uib-alert-card,.ibm-sidebar,.ibm-list-panel,.ibm-detail-panel,.inbox-row,.inbox-full-detail,.inbox-detail-row,
  .comms-message,.ri-panel,.ri-article-card,.ri-settings-group,.ri-asset-card,.stat-card,.post-card,.socials-panel {
    background:var(--glass-sheen),var(--glass-3)!important;border:1px solid var(--cg-line)!important;border-radius:var(--glass-radius,14px)!important;box-shadow:var(--glass-elev-2)!important;
  }
  .uib-stat-card,.inbox-row,.ri-article-card,.post-card { transition:transform var(--glass-dur),border-color var(--glass-dur),box-shadow var(--glass-dur)!important; }
  .uib-stat-card:hover,.inbox-row:hover,.ri-article-card:hover,.post-card:hover { transform:var(--glass-lift,translateY(-2px));border-color:var(--cg-line-strong)!important;box-shadow:var(--glass-elev-3),var(--glass-glow-soft)!important; }
  .uib-stat-value,.stat-value,.metric-value { font-variant-numeric:tabular-nums;letter-spacing:-.035em;color:var(--cg-gold)!important; }
  .uib-alert-input,.ibm-search-input,.comms-select,.comms-input,.sidebar-edit-input,.ri-input,.ri-select,.ri-search-input {
    background:color-mix(in srgb,var(--glass-base,#090806) 62%,transparent)!important;color:var(--cg-fg)!important;border:1px solid var(--cg-line)!important;border-radius:var(--glass-radius-sm,10px)!important;
  }
  :where(button,input,select,textarea):focus-visible { outline:none!important;box-shadow:var(--glass-focus-ring)!important; }
  .ibm-body { gap:10px!important; }
  .ibm-sidebar,.ibm-list-panel,.ibm-detail-panel { overflow:hidden; }
  .ibm-msg-row { border-bottom:1px solid var(--cg-line)!important; }
  .ibm-msg-row:hover,.ibm-msg-row.selected { background:var(--glass-gold-tint)!important; }
  .uib-empty,.uib-not-configured,.ibm-empty,.inbox-empty,.comms-empty,.ri-empty,.notif-history-panel__empty {
    background:var(--glass-sheen),var(--glass-2)!important;border:1px dashed var(--cg-line-strong)!important;border-radius:var(--glass-radius-lg,20px)!important;color:var(--cg-fg2)!important;
  }
  .uib-modal,.ec-modal,.exm-modal,.notif-history-panel,.threads-sidebar,.sidebar-context-menu {
    background:var(--glass-sheen),var(--glass-4)!important;border:1px solid var(--cg-line-strong)!important;box-shadow:var(--glass-elev-4)!important;backdrop-filter:var(--glass-blur-lg)!important;-webkit-backdrop-filter:var(--glass-blur-lg)!important;
  }
  .uib-modal-backdrop,.ec-backdrop,.exm-backdrop,.threads-sidebar-overlay,.sidebar-context-menu-overlay { backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px); }
  .notif-toast,.toast { background:var(--glass-sheen),var(--glass-4)!important;border:1px solid var(--cg-line-strong)!important;box-shadow:var(--glass-elev-4)!important;backdrop-filter:var(--glass-blur-lg)!important; }
  .threads-sidebar__header,.threads-sidebar__footer,.sidebar-category-header { border-color:var(--cg-line)!important; }
  .sidebar-item { border:1px solid transparent;border-radius:12px; }
  .sidebar-item:hover,.sidebar-item.active { background:var(--glass-gold-tint)!important;border-color:var(--cg-line)!important; }
  .comms-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:12px}.comms-pane{display:flex;flex-direction:column;overflow:hidden}.comms-pane-head{padding:14px;border-bottom:1px solid var(--cg-line)}
  .comms-thread{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;padding:12px;border:0;border-bottom:1px solid var(--cg-line);background:transparent;color:var(--cg-fg);cursor:pointer}.comms-thread:hover,.comms-thread.is-active{background:var(--glass-gold-tint)}
  .comms-messages{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}.comms-message{max-width:min(72%,680px);padding:10px 13px}.comms-message.outbound{background:var(--glass-gold-tint)!important}.comms-composer{padding:12px;border-top:1px solid var(--cg-line)}
  @media(max-width:640px){.uib-host{padding:8px}.uib-account-bar{flex-wrap:nowrap;overflow:auto}.uib-account-bar-spacer{display:none}.uib-body{overflow:auto}.ibm-body,.comms-layout{grid-template-columns:1fr!important}.ibm-sidebar{display:flex;overflow:auto;padding:6px}.ibm-label-btn{flex:0 0 auto}.ibm-list-panel{min-height:320px}.comms-layout{display:flex;flex-direction:column}.comms-thread-pane{max-height:42vh}.comms-message{max-width:90%}.inbox-row{grid-template-columns:1fr!important}.threads-sidebar{width:min(100vw,390px)!important}.uib-modal,.ec-modal,.exm-modal,.notif-history-panel{width:calc(100vw - 16px)!important;max-width:none!important;max-height:calc(100dvh - 16px)!important}.socials-stats,.ri-metrics{grid-template-columns:1fr!important}}
  @media(prefers-reduced-motion:reduce){:where(.uib-host,.ibm-root,.inbox-page,.comms-hub,.ri-dashboard,.socials-analytics) *, :where(.uib-host,.ibm-root,.inbox-page,.comms-hub,.ri-dashboard,.socials-analytics) *::before{animation:none!important;transition:none!important}}
  @media(prefers-reduced-transparency:reduce){.uib-account-bar,.uib-view-toggle,.ibm-search-bar,.comms-pane,.uib-modal,.ec-modal,.exm-modal,.notif-toast,.toast,.threads-sidebar{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:var(--glass-solid)!important}}
`;

/** Keep the override last because legacy views inject their own styles lazily. */
export function ensureCommunicationGlassStyles(): void {
  let tag = document.getElementById("communication-glass-styles") as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "communication-glass-styles";
    tag.textContent = globalStyles;
  }
  document.head.appendChild(tag);
}

const PATHS: Record<string, string> = {
  inbox: "M3 5h18v14H3z M3 13h5l2 3h4l2-3h5", send: "M22 2 11 13 M22 2 15 22l-4-9-9-4Z",
  draft: "M4 20h4L19 9l-4-4L4 16v4Z M13.5 6.5l4 4", star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.8 6.4 21l1.1-6.2L3 10.6l6.2-.9L12 3Z",
  tag: "M20 13 13 20l-9-9V4h7l9 9Z M8 8h.01", trash: "M4 7h16 M9 7V4h6v3 M7 7l1 13h8l1-13", alert: "M12 3 2 21h20L12 3Z M12 9v5 M12 18h.01",
  mail: "M3 5h18v14H3z M3 7l9 7 9-7", phone: "M7 2h10v20H7z M11 18h2", globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M2 12h20 M12 2c3 3 3 17 0 20 M12 2c-3 3-3 17 0 20",
  chat: "M4 4h16v12H8l-4 4V4Z", game: "M7 8h10l3 9-3 2-3-3h-4l-3 3-3-2 3-9Z M8 12h4 M10 10v4 M16 11h.01 M18 13h.01",
  bolt: "m13 2-9 12h7l-1 8 9-12h-7l1-8Z", folder: "M3 6h7l2 2h9v11H3z", pin: "m15 4 5 5-4 1-4 4-1 5-2-2-5 5 5-5-2-2 5-1 4-4 1-4Z",
  edit: "M4 20h4L19 9l-4-4L4 16v4Z", list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01", refresh: "M20 6v5h-5 M4 18v-5h5 M5.5 9a8 8 0 0 1 13-3l1.5 5 M4 13l1.5 5a8 8 0 0 0 13-3",
  check: "m5 12 4 4L19 6", close: "M6 6l12 12M18 6 6 18", user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0", chart: "M4 19V9 M10 19V5 M16 19v-7 M22 19V2",
  mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Z M5 10a7 7 0 0 0 14 0 M12 17v4 M8 21h8", play: "m9 6 9 6-9 6V6Z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0V4Z M8 6H4v2a4 4 0 0 0 4 4 M16 6h4v2a4 4 0 0 1-4 4 M12 13v5 M8 21h8 M9 18h6",
  search: "m21 21-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z", bookmark: "M6 3h12v18l-6-4-6 4V3Z", bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z", share: "M4 12v7h16v-7 M12 16V3 M7 8l5-5 5 5",
  file: "M6 2h8l4 4v16H6z M14 2v5h5", image: "M3 4h18v16H3z M8 9h.01 M3 17l5-5 4 4 3-3 6 6",
  link: "M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2 M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2",
};

export function commIcon(name: string, size = 16, label?: string): TemplateResult {
  return html`<svg class="comm-icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${label ? "false" : "true"} aria-label=${label ?? ""}><path d=${PATHS[name] ?? PATHS.mail}></path></svg>`;
}
