import { html, type TemplateResult } from "lit";

export type OpsIconName =
  | "activity"
  | "arrowDown"
  | "check"
  | "chevron"
  | "chip"
  | "close"
  | "database"
  | "download"
  | "edit"
  | "filter"
  | "key"
  | "link"
  | "logs"
  | "play"
  | "project"
  | "radio"
  | "refresh"
  | "search"
  | "server"
  | "shield"
  | "spark"
  | "terminal";

const ICON_PATHS: Record<OpsIconName, TemplateResult> = {
  activity: html`
    <path d="M3 12h4l2.4-6 4.2 12 2.4-6h5" />
  `,
  arrowDown: html`
    <path d="M12 4v14m0 0 6-6m-6 6-6-6" />
  `,
  check: html`
    <path d="m5 12 4 4L19 6" />
  `,
  chevron: html`
    <path d="m9 18 6-6-6-6" />
  `,
  chip: html`
    <rect x="7" y="7" width="10" height="10" rx="2" /><path
      d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 6h3M1 9h3m-3 6h3"
    />
  `,
  close: html`
    <path d="m7 7 10 10M17 7 7 17" />
  `,
  database: html`
    <ellipse cx="12" cy="5" rx="8" ry="3" /><path
      d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"
    />
  `,
  download: html`
    <path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" />
  `,
  edit: html`
    <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="m14.5 7.5 3 3" />
  `,
  filter: html`
    <path d="M4 5h16M7 12h10m-7 7h4" />
  `,
  key: html`
    <circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 3 3m-6 0 2 2" />
  `,
  link: html`
    <path
      d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"
    />
  `,
  logs: html`
    <path d="M5 4h14M5 9h14M5 14h9M5 19h7" /><path d="M2 4h.01M2 9h.01M2 14h.01M2 19h.01" />
  `,
  play: html`
    <path d="m9 6 9 6-9 6V6Z" />
  `,
  project: html`
    <path d="M3 6.5h7l2 2h9v10.5H3V6.5Z" /><path d="M3 10h18" />
  `,
  radio: html`
    <circle cx="12" cy="12" r="2" /><path
      d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"
    />
  `,
  refresh: html`
    <path d="M20 7v5h-5M4 17v-5h5" /><path
      d="M6.1 8a7 7 0 0 1 11.8-2L20 8M4 16l2.1 2a7 7 0 0 0 11.8-2"
    />
  `,
  search: html`
    <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
  `,
  server: html`
    <rect x="3" y="4" width="18" height="6" rx="2" /><rect
      x="3"
      y="14"
      width="18"
      height="6"
      rx="2"
    /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
  `,
  shield: html`
    <path d="M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-5" />
  `,
  spark: html`
    <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z" /><path
      d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"
    />
  `,
  terminal: html`
    <path d="m4 6 5 5-5 5m7 0h9" />
  `,
};

export function opsIcon(name: OpsIconName, size = 18): TemplateResult {
  return html`<svg
    class="ops-icon"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${ICON_PATHS[name]}</svg>`;
}

export type OpsTelemetryItem = {
  label: string;
  value: string | number;
  tone?: "accent" | "success" | "warning" | "danger";
};

/** Compact, screen-reader-friendly system state rail shared by the operations views. */
export function renderOpsTelemetryRail(
  label: string,
  items: OpsTelemetryItem[],
): TemplateResult {
  return html`<div class="ops-telemetry-rail" role="list" aria-label=${label}>
    ${items.map(
      (item) => html`<div class="ops-telemetry-item ${item.tone ?? ""}" role="listitem">
        <span class="ops-telemetry-pip" aria-hidden="true"></span>
        <span class="ops-telemetry-label">${item.label}</span>
        <strong class="ops-telemetry-value">${item.value}</strong>
      </div>`,
    )}
  </div>`;
}

export function renderOpsSharedStyles(): TemplateResult {
  return html`
    <style>
      .ops-page {
        position: relative;
        isolation: isolate;
        display: grid;
        gap: 18px;
        min-width: 0;
        color: var(--g-fg);
      }
      :root[data-theme="light"] .ops-page,
      :host-context(html[data-theme="light"]) .ops-page {
        --g-bg: var(--bg-content);
        --g-bg-deep: var(--bg-muted);
        --g-fg: var(--card-foreground);
        --g-fg-dim: color-mix(in srgb, var(--card-foreground) 72%, transparent);
        --g-fg-faint: color-mix(in srgb, var(--card-foreground) 46%, transparent);
        --g-surface: var(--card);
        --g-surface-strong: var(--bg-elevated);
        --g-surface-hover: var(--bg-hover);
        --g-border: var(--border);
        --g-border-strong: var(--border-strong);
        --g-shadow-sm: var(--shadow-sm);
        --g-shadow: var(--shadow-md);
        --g-shadow-lg: var(--shadow-xl);
        --g-gradient-surface: var(--card);
      }
      :root[data-theme="light"] .ops-page .btn,
      :host-context(html[data-theme="light"]) .ops-page .btn {
        border-color: var(--input);
        background: var(--card);
        color: var(--card-foreground);
      }
      :root[data-theme="light"] .ops-page .btn.primary,
      :host-context(html[data-theme="light"]) .ops-page .btn.primary {
        border-color: var(--g-primary);
        background: var(--g-primary);
        color: var(--g-bg-deep);
      }
      :root[data-theme="light"] .ops-page .list-item,
      :root[data-theme="light"] .ops-page .table-row,
      :root[data-theme="light"] .ops-page .chip,
      :host-context(html[data-theme="light"]) .ops-page .list-item,
      :host-context(html[data-theme="light"]) .ops-page .table-row,
      :host-context(html[data-theme="light"]) .ops-page .chip {
        border-color: var(--border);
        background: var(--card);
        color: var(--card-foreground);
      }
      :root[data-theme="light"] .ops-page .field input,
      :root[data-theme="light"] .ops-page .field textarea,
      :root[data-theme="light"] .ops-page .field select,
      :host-context(html[data-theme="light"]) .ops-page .field input,
      :host-context(html[data-theme="light"]) .ops-page .field textarea,
      :host-context(html[data-theme="light"]) .ops-page .field select {
        border-color: var(--input);
        background-color: var(--card);
        color: var(--card-foreground);
      }
      .ops-page::before,
      .ops-page::after {
        content: "";
        position: fixed;
        pointer-events: none;
        z-index: -1;
      }
      .ops-page::before {
        inset: 0 0 auto auto;
        width: min(72vw, 900px);
        height: min(66vh, 680px);
        background:
          radial-gradient(
            circle at 72% 20%,
            color-mix(in srgb, var(--g-primary) 13%, transparent),
            transparent 46%
          ),
          radial-gradient(
            circle at 24% 54%,
            color-mix(in srgb, var(--g-accent) 9%, transparent),
            transparent 52%
          );
        filter: blur(26px);
        opacity: 0.9;
      }
      .ops-page::after {
        inset: 0;
        background: radial-gradient(
          ellipse at center,
          transparent 42%,
          color-mix(in srgb, var(--g-bg-deep) 42%, transparent) 100%
        );
        opacity: 0.72;
      }
      .ops-hero,
      .ops-panel {
        position: relative;
        overflow: hidden;
        border: 1px solid var(--g-border);
        background:
          linear-gradient(
            135deg,
            color-mix(in srgb, var(--g-surface-strong) 78%, transparent),
            color-mix(in srgb, var(--g-surface) 92%, transparent)
          ),
          var(--g-gradient-surface);
        box-shadow:
          var(--g-shadow),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 12%, transparent),
          inset 0 -1px 0 color-mix(in srgb, var(--g-bg-deep) 40%, transparent);
        backdrop-filter: var(--g-blur-heavy);
        -webkit-backdrop-filter: var(--g-blur-heavy);
      }
      .ops-hero::before,
      .ops-panel::before {
        content: "";
        position: absolute;
        inset: 0 12% auto;
        height: 1px;
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in srgb, var(--g-primary) 68%, var(--g-fg)),
          transparent
        );
        opacity: 0.62;
        pointer-events: none;
      }
      .ops-hero {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 24px;
        min-height: 146px;
        padding: clamp(24px, 3vw, 38px);
        border-radius: var(--g-radius-lg);
        background:
          radial-gradient(
            circle at 86% 10%,
            color-mix(in srgb, var(--g-primary) 19%, transparent),
            transparent 34%
          ),
          linear-gradient(
            118deg,
            color-mix(in srgb, var(--g-surface-strong) 92%, transparent),
            color-mix(in srgb, var(--g-bg) 72%, transparent)
          );
        box-shadow:
          var(--g-shadow-lg),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 16%, transparent);
      }
      .ops-hero-copy {
        min-width: 0;
      }
      .ops-eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        color: var(--g-primary);
        font: 700 10px/1 var(--g-font-family);
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .ops-eyebrow::before {
        content: "";
        width: 22px;
        height: 1px;
        background: var(--g-primary);
        box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 72%, transparent);
      }
      .ops-title {
        margin: 0;
        color: var(--g-fg);
        font: 600 clamp(28px, 4vw, 46px)/1.04 var(--g-font-family);
        letter-spacing: -0.045em;
      }
      .ops-title em {
        color: var(--g-primary);
        font-family: ui-serif, Georgia, serif;
        font-weight: 500;
      }
      .ops-subtitle {
        max-width: 680px;
        margin: 12px 0 0;
        color: var(--g-fg-dim);
        font-size: 13px;
        line-height: 1.6;
      }
      .ops-live-badge {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        flex: none;
        padding: 9px 13px;
        border: 1px solid var(--g-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--g-surface-strong) 78%, transparent);
        color: var(--g-fg-dim);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        box-shadow:
          var(--g-shadow-sm),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 10%, transparent);
      }
      .ops-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--g-success);
        box-shadow:
          0 0 0 4px var(--g-success-soft),
          0 0 16px var(--g-success);
        animation: opsPulse 2.4s ease-in-out infinite;
      }
      .ops-status-dot.warn {
        background: var(--g-warning);
        box-shadow:
          0 0 0 4px var(--g-warning-soft),
          0 0 16px var(--g-warning);
      }
      .ops-status-dot.offline {
        background: var(--g-fg-faint);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--g-fg-faint) 18%, transparent);
        animation: none;
      }
      .ops-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }
      .ops-metric {
        position: relative;
        min-width: 0;
        padding: 16px 18px;
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius);
        background: color-mix(in srgb, var(--g-surface) 88%, transparent);
        box-shadow:
          var(--g-shadow-sm),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 9%, transparent);
        backdrop-filter: var(--g-blur);
        -webkit-backdrop-filter: var(--g-blur);
        transition:
          transform 180ms ease,
          border-color 180ms ease,
          box-shadow 180ms ease;
      }
      .ops-metric:hover {
        transform: translateY(-2px);
        border-color: var(--g-border-strong);
        box-shadow:
          var(--g-shadow),
          0 0 26px color-mix(in srgb, var(--g-primary) 9%, transparent),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 12%, transparent);
      }
      .ops-metric-label {
        display: flex;
        align-items: center;
        gap: 7px;
        color: var(--g-fg-faint);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.13em;
        text-transform: uppercase;
      }
      .ops-metric-value {
        display: block;
        margin-top: 9px;
        color: var(--g-fg);
        font:
          600 24px/1 ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: -0.04em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ops-metric-value.accent {
        color: var(--g-primary);
        text-shadow: 0 0 18px color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .ops-telemetry-rail {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        overflow-x: auto;
        padding: 7px;
        border: 1px solid var(--g-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--g-surface) 76%, transparent);
        box-shadow:
          var(--g-shadow-sm),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 8%, transparent);
        scrollbar-width: none;
        backdrop-filter: var(--g-blur);
        -webkit-backdrop-filter: var(--g-blur);
      }
      .ops-telemetry-rail::-webkit-scrollbar { display: none; }
      .ops-telemetry-item {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 27px;
        flex: none;
        padding: 0 10px;
        border-right: 1px solid var(--g-border);
        color: var(--g-fg-faint);
        font: 650 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .ops-telemetry-item:last-child { border-right: 0; }
      .ops-telemetry-pip {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--g-fg-faint);
        box-shadow: 0 0 8px color-mix(in srgb, var(--g-fg-faint) 70%, transparent);
      }
      .ops-telemetry-value {
        color: var(--g-fg);
        font-size: 10px;
        letter-spacing: 0;
        text-transform: none;
      }
      .ops-telemetry-item.accent .ops-telemetry-pip,
      .ops-telemetry-item.accent .ops-telemetry-value {
        background: var(--g-primary); color: var(--g-primary);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 64%, transparent);
      }
      .ops-telemetry-item.success .ops-telemetry-pip,
      .ops-telemetry-item.success .ops-telemetry-value {
        background: var(--g-success); color: var(--g-success);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-success) 64%, transparent);
      }
      .ops-telemetry-item.warning .ops-telemetry-pip,
      .ops-telemetry-item.warning .ops-telemetry-value {
        background: var(--g-warning); color: var(--g-warning);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-warning) 64%, transparent);
      }
      .ops-telemetry-item.danger .ops-telemetry-pip,
      .ops-telemetry-item.danger .ops-telemetry-value {
        background: var(--g-danger); color: var(--g-danger);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-danger) 64%, transparent);
      }
      .ops-panel {
        padding: clamp(18px, 2.4vw, 28px);
        border-radius: var(--g-radius-lg);
      }
      .ops-section-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .ops-heading-group {
        display: flex;
        gap: 13px;
        min-width: 0;
      }
      .ops-heading-icon {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        flex: none;
        border: 1px solid var(--g-border-strong);
        border-radius: var(--g-radius-sm);
        background: var(--g-primary-soft);
        color: var(--g-primary);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 11%, transparent),
          0 0 22px color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .ops-heading {
        margin: 1px 0 0;
        color: var(--g-fg);
        font-size: 15px;
        font-weight: 650;
        letter-spacing: -0.01em;
      }
      .ops-kicker {
        margin: 5px 0 0;
        color: var(--g-fg-dim);
        font-size: 11px;
        line-height: 1.5;
      }
      .ops-page .btn {
        min-height: 38px;
        border-color: var(--g-border);
        border-radius: var(--g-radius-sm);
        background: color-mix(in srgb, var(--g-surface-strong) 78%, transparent);
        color: var(--g-fg-dim);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 10%, transparent),
          var(--g-shadow-sm);
        transition:
          transform 160ms ease,
          border-color 160ms ease,
          color 160ms ease,
          background 160ms ease,
          box-shadow 160ms ease;
      }
      .ops-page .btn:hover:not(:disabled) {
        transform: translateY(-1px);
        border-color: var(--g-border-strong);
        background: var(--g-surface-hover);
        color: var(--g-primary);
        box-shadow:
          var(--g-shadow),
          0 0 22px color-mix(in srgb, var(--g-primary) 9%, transparent);
      }
      .ops-page .btn.primary {
        border-color: color-mix(in srgb, var(--g-primary) 70%, transparent);
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--g-primary) 92%, var(--g-fg)),
          var(--g-primary)
        );
        color: var(--g-bg-deep);
        font-weight: 750;
      }
      .ops-page .btn:focus-visible,
      .ops-page input:focus-visible,
      .ops-page textarea:focus-visible,
      .ops-page select:focus-visible,
      .ops-page [tabindex]:focus-visible {
        outline: 2px solid var(--g-primary);
        outline-offset: 2px;
      }
      .ops-page input:not([type="checkbox"]),
      .ops-page textarea,
      .ops-page select {
        border-color: var(--g-border);
        border-radius: var(--g-radius-sm);
        background: color-mix(in srgb, var(--g-bg-deep) 48%, var(--g-surface));
        color: var(--g-fg);
        box-shadow:
          inset 0 1px 10px color-mix(in srgb, var(--g-bg-deep) 28%, transparent),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 7%, transparent);
        transition:
          border-color 160ms ease,
          box-shadow 160ms ease,
          background 160ms ease;
      }
      .ops-page input:not([type="checkbox"]):focus,
      .ops-page textarea:focus,
      .ops-page select:focus {
        border-color: var(--g-border-strong);
        background: color-mix(in srgb, var(--g-surface-strong) 64%, transparent);
        box-shadow:
          0 0 0 3px var(--g-primary-soft),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 9%, transparent);
      }
      .ops-empty {
        display: grid;
        place-items: center;
        min-height: 180px;
        padding: 28px;
        text-align: center;
        color: var(--g-fg-dim);
      }
      .ops-empty-icon {
        display: grid;
        place-items: center;
        width: 52px;
        height: 52px;
        margin-bottom: 14px;
        border: 1px solid var(--g-border);
        border-radius: 50%;
        background: var(--g-primary-soft);
        color: var(--g-primary);
        box-shadow:
          0 0 32px color-mix(in srgb, var(--g-primary) 13%, transparent),
          inset 0 1px 0 color-mix(in srgb, var(--g-fg) 12%, transparent);
      }
      .ops-empty strong {
        display: block;
        margin-bottom: 5px;
        color: var(--g-fg);
        font-size: 13px;
      }
      .ops-empty span {
        max-width: 36ch;
        font-size: 11px;
        line-height: 1.55;
      }
      .ops-skeleton {
        position: relative;
        overflow: hidden;
        min-height: 52px;
        border: 1px solid var(--g-border);
        border-radius: var(--g-radius-sm);
        background: var(--g-surface);
      }
      .ops-skeleton::after {
        content: "";
        position: absolute;
        inset: 0;
        transform: translateX(-100%);
        background: linear-gradient(
          90deg,
          transparent,
          color-mix(in srgb, var(--g-fg) 8%, transparent),
          transparent
        );
        animation: opsShimmer 1.7s ease-in-out infinite;
      }
      .ops-icon {
        display: block;
        flex: none;
      }
      @keyframes opsPulse {
        0%,
        100% {
          opacity: 0.68;
          transform: scale(0.9);
        }
        50% {
          opacity: 1;
          transform: scale(1);
        }
      }
      @keyframes opsShimmer {
        to {
          transform: translateX(100%);
        }
      }
      @media (max-width: 860px) {
        .ops-metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .ops-hero {
          align-items: flex-start;
          flex-direction: column;
          min-height: 0;
        }
      }
      @media (max-width: 600px) {
        .ops-page {
          gap: 12px;
        }
        .ops-hero {
          padding: 22px 18px;
          border-radius: var(--g-radius);
        }
        .ops-title {
          font-size: 30px;
        }
        .ops-subtitle {
          font-size: 12px;
        }
        .ops-panel {
          padding: 16px 13px;
          border-radius: var(--g-radius);
        }
        .ops-metrics {
          gap: 8px;
        }
        .ops-metric {
          padding: 13px 12px;
        }
        .ops-metric-value {
          font-size: 20px;
        }
        .ops-telemetry-rail {
          border-radius: var(--g-radius-sm);
        }
        .ops-section-head {
          align-items: stretch;
          flex-direction: column;
        }
        .ops-section-head > .row,
        .ops-section-head > .btn {
          width: 100%;
        }
        .ops-section-head > .btn {
          justify-content: center;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .ops-page *,
        .ops-page *::before,
        .ops-page *::after {
          scroll-behavior: auto !important;
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
        }
      }
      @media (prefers-reduced-transparency: reduce) {
        .ops-hero,
        .ops-panel,
        .ops-metric {
          background: var(--g-surface-strong);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
        .ops-page::before,
        .ops-page::after {
          display: none;
        }
      }
    </style>
  `;
}
