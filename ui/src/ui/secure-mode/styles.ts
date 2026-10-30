/**
 * Secure Mode visual tokens. One emerald accent that reads on both the
 * black/gold glass theme (dark) and the porcelain light theme. Tokens live on
 * :root so they also reach shadow-DOM surfaces (custom properties inherit).
 */
import { css } from "lit";

const GLOBAL_STYLE_ID = "ib-secure-mode-styles";

const GLOBAL_CSS = `
:root {
  --ib-secure: #34d399;
  --ib-secure-strong: #10b981;
  --ib-secure-soft: rgba(52, 211, 153, 0.13);
  --ib-secure-ring: rgba(52, 211, 153, 0.5);
  --ib-secure-glow: 0 0 0 1px rgba(52, 211, 153, 0.35), 0 0 22px rgba(52, 211, 153, 0.18);
  --ib-secure-ink: #04261a;
}
:root[data-theme="light"] {
  --ib-secure: #059669;
  --ib-secure-strong: #047857;
  --ib-secure-soft: rgba(5, 150, 105, 0.1);
  --ib-secure-ring: rgba(5, 150, 105, 0.5);
  --ib-secure-glow: 0 0 0 1px rgba(5, 150, 105, 0.3), 0 0 18px rgba(5, 150, 105, 0.14);
  --ib-secure-ink: #ffffff;
}
/* App-shell frame while Secure Mode is on (or a secure chat is on screen). */
.shell.shell--secure::after,
.shell.shell--secure-locked::after {
  content: "";
  /* layout.css hides .shell::after (old CRT effect); re-enable it here. */
  display: block;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9990;
  /* The app body runs at zoom 0.7, so 4px renders as ~3px on screen. */
  border: 4px solid var(--ib-secure);
  box-shadow: inset 0 0 0 1px rgba(4, 38, 26, 0.6), inset 0 0 48px rgba(52, 211, 153, 0.22);
}
.shell.shell--secure-locked::after {
  border-style: dashed;
  border-color: var(--ib-secure-ring);
  box-shadow: none;
}
/* Light-DOM chat composer (views/chat.ts) in a secure session. */
.chat-compose.chat-compose--secure {
  border: 1px solid var(--ib-secure-ring);
  border-radius: 14px;
  box-shadow: var(--ib-secure-glow);
}
.chat-secure-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 6px; }
.ib-secure-lockbadge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
  color: var(--ib-secure);
  background: var(--ib-secure-soft);
  border: 1px solid var(--ib-secure-ring);
}
.ib-secure-lockbadge svg { width: 13px; height: 13px; }
.ib-secure-lockbadge--locked { color: var(--muted, #9ca3af); border-style: dashed; background: transparent; }
/* Header strip on pages whose header lives inside a big view (Kanban /projects). */
.ib-secure-strip { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 6px 4px 8px; flex: none; }
.ib-secure-strip__title { margin-right: auto; display: inline-flex; align-items: center; gap: 8px; font-weight: 650; white-space: nowrap; color: var(--ib-secure); }
.ib-secure-strip__title svg { width: 16px; height: 16px; }
`;

/** Inject the global tokens + light-DOM rules once. */
export function ensureSecureGlobalStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(GLOBAL_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = GLOBAL_STYLE_ID;
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
}

/** Shared shadow-DOM base for the secure elements. */
export const secureBaseStyles = css`
  :host {
    color: var(--glass-fg, var(--text, #e5e7eb));
    font-family: var(--glass-font, var(--font-body, inherit));
    --sm-accent: var(--ib-secure, #34d399);
    --sm-accent-strong: var(--ib-secure-strong, #10b981);
    --sm-soft: var(--ib-secure-soft, rgba(52, 211, 153, 0.13));
    --sm-ring: var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
    --sm-ink: var(--ib-secure-ink, #04261a);
    --sm-surface: var(--g-surface, var(--glass-2, var(--card, rgba(18, 18, 22, 0.72))));
    --sm-surface-2: var(--g-surface-strong, var(--bg-elevated, rgba(24, 24, 28, 0.9)));
    --sm-border: var(--g-border, var(--glass-stroke, var(--border, rgba(255, 255, 255, 0.1))));
    --sm-muted: var(--muted, color-mix(in srgb, currentColor 60%, transparent));
    --sm-radius: var(--g-radius, 14px);
    --sm-radius-sm: var(--g-radius-sm, 10px);
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; color: inherit; }
  svg { width: 15px; height: 15px; flex: none; }
  .sm-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 32px; padding: 0 12px; border-radius: var(--sm-radius-sm);
    border: 1px solid var(--sm-border); background: color-mix(in srgb, currentColor 5%, transparent);
    cursor: pointer; font-size: 12.5px; font-weight: 600; white-space: nowrap;
  }
  .sm-btn:hover:not(:disabled) { border-color: var(--sm-ring); color: var(--sm-accent); }
  .sm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .sm-btn--primary { background: var(--sm-accent); border-color: var(--sm-accent); color: var(--sm-ink); }
  .sm-btn--primary:hover:not(:disabled) { background: var(--sm-accent-strong); color: var(--sm-ink); }
  .sm-btn--danger:hover:not(:disabled) { border-color: #f87171; color: #f87171; }
  .sm-btn--icon { width: 30px; min-height: 30px; padding: 0; }
  .sm-btn:focus-visible, .sm-input:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 2px; }
  .sm-input {
    min-height: 32px; padding: 0 10px; border-radius: var(--sm-radius-sm);
    border: 1px solid var(--sm-border); background: var(--sm-surface); font-size: 13px; min-width: 0;
  }
  textarea.sm-input { padding: 10px; min-height: 120px; resize: vertical; line-height: 1.5; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; }
  .sm-error { color: #f87171; font-size: 12.5px; }
  .sm-muted { color: var(--sm-muted); font-size: 12.5px; }
  .sm-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px;
    font-size: 11.5px; font-weight: 600; color: var(--sm-accent); background: var(--sm-soft); border: 1px solid var(--sm-ring);
  }
  .sm-chip svg { width: 12px; height: 12px; }
`;
