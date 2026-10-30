/**
 * MCP page — luxury glass layer.
 *
 * Page-scoped styles for views/mcp.ts (Tools / Skills / MCPs). Builds on the
 * shared primitives in glass-tools-shared.ts (`.gt-scope`, `.gt-glass`, …) and
 * only uses existing theme tokens (--g-*, --bg*, --text*, --ok/--warn/--danger,
 * --mono). Every selector is prefixed with `.mcp-page` so nothing leaks.
 *
 * Layout: `.mcp-page` > `.mcp-scope.gt-scope` (content, isolated so the aurora
 * can sit at z-index -1) + `.mcp-layers.gt-scope` (dialogs / drawer / registry,
 * NOT isolated so their fixed z-index still competes with the app chrome).
 */
export const MCP_GLASS_CSS = /* css */ `
/* ── Root ───────────────────────────────────────────────────── */
.mcp-page {
  padding: 0 20px 48px;
  max-width: 1400px;
  font-family: var(--g-font-family, var(--font-body, inherit));
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.mcp-page .mcp-layers.gt-scope { position: static; isolation: auto; }
.mcp-page .gt-scope {
  --mcp-code-bg: color-mix(in srgb, var(--bg, #050505) 70%, transparent);
  --mcp-well: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  --mcp-well-hover: color-mix(in srgb, var(--gt-fg) 6%, transparent);
  --mcp-tile:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--gt-gold) 26%, transparent), transparent 70%),
    color-mix(in srgb, var(--gt-fg) 4%, transparent);
  --mcp-sheet-bg: color-mix(in srgb, var(--bg-elevated, #0e0e0e) 84%, transparent);
  --mcp-press: scale(0.985);
}
:root[data-theme="light"] .mcp-page .gt-scope {
  /* palette overrides can pin --g-fg/--text to a dark-theme ink inline on :root;
     base.css light tokens are the reliable source for ink here. */
  --gt-fg: var(--glass-fg, var(--text-strong, #18181b));
  --gt-dim: color-mix(in srgb, var(--text-strong, #18181b) 68%, transparent);
  --gt-faint: var(--muted-strong, #52525b);
  color: var(--gt-fg);
  --mcp-code-bg: rgba(250, 247, 240, 0.9);
  --mcp-well: rgba(255, 255, 255, 0.55);
  --mcp-well-hover: rgba(255, 255, 255, 0.85);
  --mcp-sheet-bg: rgba(255, 253, 248, 0.9);
}
.mcp-page svg { flex-shrink: 0; }
.mcp-page code, .mcp-page pre, .mcp-page .mcp-mono { font-family: var(--mono); }
.mcp-page .gt-hero { padding-top: 10px; }
.mcp-page .gt-title { font-family: var(--g-font-family, inherit); }

/* ── Toasts ─────────────────────────────────────────────────── */
.mcp-page .mcp-success,
.mcp-page .mcp-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px 11px 16px;
  margin-bottom: 16px;
  border-radius: 14px;
  font-size: 13px;
  line-height: 1.45;
  animation: mcp-g-drop 420ms var(--gt-ease) both;
}
.mcp-page .mcp-success {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 28%, transparent);
  box-shadow: 0 10px 30px -18px color-mix(in srgb, var(--ok) 60%, transparent);
}
.mcp-page .mcp-error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  box-shadow: 0 10px 30px -18px color-mix(in srgb, var(--danger) 60%, transparent);
}
.mcp-page .mcp-error > span { min-width: 0; overflow-wrap: anywhere; }
.mcp-page .mcp-error-dismiss {
  flex: none;
  display: grid; place-items: center;
  width: 30px; height: 30px;
  border-radius: 9px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  transition: background 200ms ease, transform 160ms ease;
}
.mcp-page .mcp-error-dismiss:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
.mcp-page .mcp-error-dismiss:active { transform: scale(0.92); }
@keyframes mcp-g-drop { from { opacity: 0; transform: translateY(-6px); } }

/* ── Loading / skeleton ─────────────────────────────────────── */
.mcp-page .mcp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px 20px;
  font: 500 11px/1 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.mcp-page .mcp-loading-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  font-size: 0;
  background: var(--gt-gold);
  box-shadow: 0 0 12px var(--gt-gold);
  animation: mcp-g-breathe 1.6s ease-in-out infinite;
}
@keyframes mcp-g-breathe { 0%, 100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }
.mcp-page .mcp-skel-head { display: grid; gap: 12px; padding: 18px 2px 26px; }
.mcp-page .mcp-skel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 14px;
}
.mcp-page .mcp-skel-card { padding: 18px; display: grid; gap: 12px; }
.mcp-page .mcp-skel-row { display: flex; gap: 12px; align-items: center; }

/* ── Capability tabs → glass segmented control ──────────────── */
.mcp-page .cap-tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0 0 22px;
}
.mcp-page .cap-tabs {
  --cap-pad: 4px;
  position: relative;
  display: inline-grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  padding: var(--cap-pad);
  border-radius: 16px;
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25), 0 1px 0 rgba(255, 255, 255, 0.04);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
}
:root[data-theme="light"] .mcp-page .cap-tabs { background: rgba(255, 255, 255, 0.6); box-shadow: inset 0 1px 2px rgba(24, 24, 27, 0.06); }
.mcp-page .cap-tabs::before {
  content: "";
  position: absolute;
  top: var(--cap-pad); bottom: var(--cap-pad); left: var(--cap-pad);
  width: calc((100% - var(--cap-pad) * 2) / 3);
  transform: translateX(calc(var(--cap-i, 0) * 100%));
  border-radius: 12px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 24%, transparent), color-mix(in srgb, var(--gt-gold) 9%, transparent));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 42%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 8px 22px -10px color-mix(in srgb, var(--gt-gold) 70%, transparent);
  transition: transform 520ms var(--gt-ease);
  pointer-events: none;
}
.mcp-page .cap-tab {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 20px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--gt-dim);
  font: 560 13.5px/1 var(--g-font-family, inherit);
  letter-spacing: -0.005em;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 160ms ease;
}
.mcp-page .cap-tab:hover { color: var(--gt-fg); }
.mcp-page .cap-tab:active { transform: scale(0.97); }
.mcp-page .cap-tab:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.mcp-page .cap-tab.active { color: var(--gt-fg); }
.mcp-page .cap-tab.active svg { color: var(--gt-gold-ink); }
.mcp-page .cap-tab svg { width: 15px; height: 15px; opacity: 0.85; }
.mcp-page .cap-tab-count {
  min-width: 22px;
  padding: 3px 7px;
  border-radius: 999px;
  font: 600 10.5px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 7%, transparent);
  transition: background 220ms ease;
}
.mcp-page .cap-tab.active .cap-tab-count {
  color: var(--gt-gold-ink);
  background: color-mix(in srgb, var(--gt-gold) 18%, transparent);
}
.mcp-page .cap-tabbar-hint { font-size: 12.5px; color: var(--gt-faint); }

/* ── Sections ───────────────────────────────────────────────── */
.mcp-page .mcp-section { margin-bottom: 36px; }
.mcp-page .mcp-section-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.mcp-page .mcp-section-title,
.mcp-page .mcp-discovery-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font: 620 17px/1.2 var(--g-font-family, inherit);
  letter-spacing: -0.015em;
  color: var(--gt-fg);
  text-transform: none;
}
.mcp-page .mcp-section-title svg,
.mcp-page .mcp-discovery-title svg {
  width: 30px; height: 30px;
  padding: 7px;
  box-sizing: border-box;
  border-radius: 10px;
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 28%, transparent);
}
.mcp-page .mcp-section-sub { font-size: 12.5px; color: var(--gt-faint); }
.mcp-page .mcp-section-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

/* ── Buttons (legacy .mcp-btn rides on .gt-btn) ─────────────── */
.mcp-page .mcp-btn { white-space: nowrap; letter-spacing: 0; text-transform: none; }
.mcp-page .mcp-btn svg { width: 14px; height: 14px; }
.mcp-page .mcp-icon-btn {
  display: grid; place-items: center;
  width: 36px; height: 36px;
  flex: none;
  border-radius: 11px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  color: var(--gt-dim);
  cursor: pointer;
  transition: color 200ms ease, background 200ms ease, border-color 200ms ease, transform 160ms ease;
}
.mcp-page .mcp-icon-btn svg { width: 15px; height: 15px; }
.mcp-page .mcp-icon-btn:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 9%, transparent); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.mcp-page .mcp-icon-btn:active { transform: scale(0.92); }
.mcp-page .mcp-icon-btn:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.mcp-page .mcp-delete-btn:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: var(--danger-subtle); }

/* ── Status bar (MCP gateway) ───────────────────────────────── */
.mcp-page .mcp-status-bar {
  position: relative;
  inset: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px 20px;
  padding: 18px 20px;
  margin-bottom: 18px;
  overflow: hidden;
}
.mcp-page .mcp-status-bar.running {
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--ok) 10%, transparent), transparent 46%),
    var(--gt-surface);
}
.mcp-page .mcp-status-left { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; min-width: 0; }
.mcp-page .mcp-status-orb {
  display: grid; place-items: center;
  width: 46px; height: 46px;
  flex: none;
  border-radius: 15px;
  background: var(--mcp-tile);
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.mcp-page .mcp-status-bar.running .mcp-status-orb {
  background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--ok) 22%, transparent), transparent 70%), color-mix(in srgb, var(--gt-fg) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 30%, transparent), 0 10px 30px -12px color-mix(in srgb, var(--ok) 60%, transparent);
}
.mcp-page .mcp-status-orb .gt-light { width: 10px; height: 10px; }
.mcp-page .mcp-status-indicator { display: grid; gap: 4px; }
.mcp-page .mcp-status-kicker {
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.mcp-page .mcp-status-label { font: 640 18px/1.15 var(--g-font-family, inherit); letter-spacing: -0.015em; color: var(--gt-dim); }
.mcp-page .mcp-status-label.active { color: var(--gt-fg); }
.mcp-page .mcp-meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12.5px; color: var(--gt-faint); }
.mcp-page .mcp-meta-value { color: var(--gt-fg); font-weight: 600; }
.mcp-page .mcp-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mcp-page .mcp-servers-count { height: 36px; padding: 0 12px; }

/* ── Server / skill cards (Tools + Skills tabs) ─────────────── */
.mcp-page .mcp-servers-grid,
.mcp-page .mcp-agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
  gap: 16px;
  align-items: start;
}
.mcp-page .mcp-server-card,
.mcp-page .mcp-agent-card {
  padding: 18px 18px 16px;
  cursor: pointer;
  outline: none;
  min-width: 0;
}
.mcp-page .mcp-server-card:active,
.mcp-page .mcp-agent-card:active { transform: var(--mcp-press); }
.mcp-page .mcp-server-card:focus-visible,
.mcp-page .mcp-agent-card:focus-visible { box-shadow: var(--gt-shadow-hover), 0 0 0 2px color-mix(in srgb, var(--gt-gold) 70%, transparent); }
.mcp-page .mcp-server-card.expanded {
  box-shadow: var(--gt-shadow-hover);
  background:
    radial-gradient(140% 90% at 100% 0%, color-mix(in srgb, var(--gt-gold) 8%, transparent), transparent 55%),
    var(--gt-surface);
}
.mcp-page .mcp-server-card.is-static { cursor: default; }
.mcp-page .mcp-server-card.is-static:active { transform: none; }
.mcp-page .mcp-server-card.disabled .mcp-server-header,
.mcp-page .mcp-server-card.disabled .mcp-server-meta { opacity: 0.62; }
.mcp-page .mcp-server-header,
.mcp-page .mcp-agent-header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.mcp-page .mcp-server-icon,
.mcp-page .mcp-agent-icon {
  display: grid; place-items: center;
  width: 44px; height: 44px;
  flex: none;
  border-radius: 14px;
  font-size: 20px;
  line-height: 1;
  color: var(--gt-gold-ink);
  background: var(--mcp-tile);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 20%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 8px 18px -10px rgba(0, 0, 0, 0.6);
}
:root[data-theme="light"] .mcp-page .mcp-server-icon,
:root[data-theme="light"] .mcp-page .mcp-agent-icon { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 26%, transparent), 0 6px 14px -8px rgba(120, 80, 10, 0.35); }
.mcp-page .mcp-server-icon svg { width: 20px; height: 20px; }
.mcp-page .mcp-server-info { flex: 1; min-width: 0; }
.mcp-page .mcp-server-name,
.mcp-page .mcp-agent-name {
  font: 620 15px/1.25 var(--g-font-family, inherit);
  letter-spacing: -0.01em;
  color: var(--gt-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-page .mcp-server-desc,
.mcp-page .mcp-agent-desc {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--gt-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mcp-page .mcp-agent-id { font: 11px var(--mono); color: var(--gt-faint); }
.mcp-page .mcp-server-meta,
.mcp-page .mcp-agent-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mcp-page .mcp-chip-count b { font-weight: 700; color: inherit; }
.mcp-page .mcp-expand-hint {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 550;
  color: var(--gt-faint);
  transition: color 200ms ease;
}
.mcp-page .mcp-expand-hint svg { width: 14px; height: 14px; transition: transform 420ms var(--gt-ease); }
.mcp-page .mcp-server-card:hover .mcp-expand-hint { color: var(--gt-gold-ink); }
.mcp-page .mcp-server-card.expanded .mcp-expand-hint svg { transform: rotate(180deg); }

/* legacy badge (agents) */
.mcp-page .mcp-badge {
  display: inline-flex; align-items: center; gap: 5px;
  height: 24px; padding: 0 10px;
  border-radius: 999px;
  font: 500 10.5px/1 var(--mono);
  letter-spacing: 0.04em;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  border: 1px solid var(--gt-line);
}
.mcp-page .mcp-badge svg { width: 12px; height: 12px; }
.mcp-page .mcp-badge .arrow { transition: transform 300ms var(--gt-ease); }
.mcp-page .mcp-badge .arrow.open { transform: rotate(180deg); }
.mcp-page .mcp-agent-card.default::after {
  content: "Default";
  position: absolute; top: 14px; right: 14px;
  font: 600 10px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
  padding: 5px 8px; border-radius: 999px;
  color: var(--gt-gold-ink); background: var(--gt-gold-faint);
}
.mcp-page .mcp-agent-card,
.mcp-page .canva-card,
.mcp-page .supabase-card {
  position: relative;
  background: var(--gt-surface);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 16%, var(--gt-line));
  border-radius: var(--gt-radius);
  box-shadow: var(--gt-shadow);
  transition: transform 420ms var(--gt-ease), box-shadow 420ms var(--gt-ease);
}
.mcp-page .canva-section-label { margin-bottom: 10px; font: 600 10px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
.mcp-page .canva-card,
.mcp-page .supabase-card { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 18px; margin-bottom: 10px; }
.mcp-page .canva-card-info { flex: 1; min-width: 0; }
.mcp-page .canva-card-name { font-weight: 620; color: var(--gt-fg); }
.mcp-page .canva-card-desc { margin-top: 2px; font-size: 12.5px; color: var(--gt-dim); }
.mcp-page .canva-status-pill,
.mcp-page .supabase-status-pill { height: 24px; display: inline-flex; align-items: center; padding: 0 10px; border-radius: 999px; font: 600 10px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--gt-dim); background: var(--mcp-well); border: 1px solid var(--gt-line); }
.mcp-page .canva-status-pill.connected,
.mcp-page .supabase-status-pill.connected { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.mcp-page .canva-status-pill.expired { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.mcp-page .canva-card-actions { display: flex; gap: 8px; }
.mcp-page .mcp-agent-expanded { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--gt-line); }

/* expandable tool list */
.mcp-page .mcp-server-tools-preview {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--gt-line);
  cursor: default;
  animation: mcp-g-unfold 480ms var(--gt-ease) both;
}
@keyframes mcp-g-unfold { from { opacity: 0; transform: translateY(-4px); } }
.mcp-page .mcp-tools-label,
.mcp-page .mcp-detail-label,
.mcp-page .mcp-form-label,
.mcp-page .mcp-reg-info-label,
.mcp-page .mcp-field-label,
.mcp-page .qi-key-label,
.mcp-page .qi-picker-label,
.mcp-page .qi-endpoint-label,
.mcp-page .qi-meta-key {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font: 600 10px/1.2 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.mcp-page .mcp-tools-list { display: flex; flex-wrap: wrap; gap: 6px; }
.mcp-page .mcp-tool-pill {
  display: inline-flex; align-items: center;
  height: 26px; padding: 0 10px;
  border-radius: 9px;
  font: 500 11px/1 var(--mono);
  color: var(--gt-dim);
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
  transition: color 180ms ease, border-color 180ms ease, background 180ms ease;
}
.mcp-page .mcp-tool-pill:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.mcp-page .mcp-tool-pill.is-deny { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 26%, transparent); }
.mcp-page .mcp-tool-pill.is-agent { color: var(--g-accent, #a855f7); border-color: color-mix(in srgb, var(--g-accent, #a855f7) 26%, transparent); }
.mcp-page .mcp-tool-pill.is-more { color: var(--gt-faint); }
.mcp-page .mcp-toolrows {
  display: grid;
  gap: 4px;
  max-height: 340px;
  overflow-y: auto;
  margin: 0 -6px;
  padding: 0 6px;
  scrollbar-width: thin;
}
.mcp-page .mcp-toolrow {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  align-items: baseline;
  padding: 9px 12px;
  border-radius: 11px;
  background: var(--mcp-well);
  border: 1px solid transparent;
  transition: background 200ms ease, border-color 200ms ease;
}
.mcp-page .mcp-toolrow:hover { background: var(--mcp-well-hover); border-color: color-mix(in srgb, var(--gt-gold) 18%, transparent); }
.mcp-page .mcp-toolrow::before {
  content: "";
  width: 5px; height: 5px;
  border-radius: 50%;
  align-self: center;
  background: var(--gt-gold);
  box-shadow: 0 0 8px var(--gt-gold);
  opacity: 0.8;
}
.mcp-page .mcp-toolrow-name { font: 600 12px/1.35 var(--mono); color: var(--gt-gold-ink); overflow-wrap: anywhere; }
.mcp-page .mcp-toolrow-desc { grid-column: 2; font-size: 12px; line-height: 1.5; color: var(--gt-dim); }

/* skill extras */
.mcp-page .mcp-skill-missing { margin-top: 12px; display: grid; gap: 4px; font-size: 12px; color: var(--warn); }
.mcp-page .mcp-skill-missing code { font-size: 11px; color: var(--gt-dim); }
.mcp-page .mcp-skill-key { margin-top: 12px; }
.mcp-page .mcp-skill-key .gt-input { width: 100%; box-sizing: border-box; font-family: var(--mono); font-size: 12px; }
.mcp-page .mcp-filter { width: 240px; max-width: 100%; box-sizing: border-box; padding-left: 36px; }
.mcp-page .mcp-filter-wrap { position: relative; display: flex; align-items: center; }
.mcp-page .mcp-filter-wrap > svg { position: absolute; left: 13px; width: 15px; height: 15px; color: var(--gt-faint); pointer-events: none; }
.mcp-page .mcp-count-note { font: 500 11px/1 var(--mono); color: var(--gt-faint); white-space: nowrap; }

/* ── Empty states ───────────────────────────────────────────── */
.mcp-page .mcp-empty,
.mcp-page .mcp-discovery-empty {
  grid-column: 1 / -1;
  padding: 40px 24px;
  text-align: center;
  font-size: 13px;
  color: var(--gt-dim);
  border-radius: var(--gt-radius);
  border: 1px dashed color-mix(in srgb, var(--gt-gold) 24%, transparent);
  background: color-mix(in srgb, var(--gt-fg) 2%, transparent);
}
.mcp-page .gt-empty.mcp-empty-glass { border-radius: var(--gt-radius); }

/* ── Quick install ──────────────────────────────────────────── */
.mcp-page .qi-section { margin-bottom: 18px; }
.mcp-page .qi-head {
  display: flex; align-items: center; gap: 14px;
  width: 100%;
  min-height: 64px;
  padding: 14px 18px;
  border: 0;
  border-radius: var(--gt-radius);
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background 220ms ease;
}
.mcp-page .qi-head:hover { background: color-mix(in srgb, var(--gt-gold) 4%, transparent); }
.mcp-page .qi-head:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: -2px; }
.mcp-page .qi-head-icon {
  display: grid; place-items: center;
  width: 40px; height: 40px; flex: none;
  border-radius: 13px;
  color: var(--gt-gold-ink);
  background: var(--mcp-tile);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 26%, transparent);
}
.mcp-page .qi-head-icon svg { width: 18px; height: 18px; }
.mcp-page .qi-head-text { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.mcp-page .qi-head-title { font-size: 14.5px; font-weight: 620; letter-spacing: -0.01em; color: var(--gt-fg); }
.mcp-page .qi-head-sub { font-size: 12.5px; color: var(--gt-dim); }
.mcp-page .qi-head-chevron { display: grid; place-items: center; color: var(--gt-faint); transition: transform 420ms var(--gt-ease); }
.mcp-page .qi-head-chevron svg { width: 18px; height: 18px; }
.mcp-page .qi-head-chevron.open { transform: rotate(180deg); color: var(--gt-gold-ink); }
.mcp-page .qi-body {
  display: flex; flex-direction: column; gap: 16px;
  padding: 4px 18px 20px;
  border-top: 1px solid var(--gt-line);
  padding-top: 18px;
  animation: mcp-g-unfold 480ms var(--gt-ease) both;
}
.mcp-page .qi-loading { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--gt-dim); }
.mcp-page .qi-noauth {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px;
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 24%, transparent);
}
.mcp-page .qi-key-row,
.mcp-page .qi-endpoint-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mcp-page .qi-key-row .qi-key-label,
.mcp-page .qi-endpoint-row .qi-endpoint-label { margin: 0; min-width: 0; }
.mcp-page .qi-key-value,
.mcp-page .qi-endpoint,
.mcp-page .qi-meta-val {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: 11px;
  font: 12px/1.4 var(--mono);
  background: var(--mcp-code-bg);
  border: 1px solid var(--gt-line);
  color: var(--gt-gold-ink);
  overflow-x: auto;
  white-space: nowrap;
}
.mcp-page .qi-endpoint { color: var(--gt-fg); }
.mcp-page .qi-meta-val { flex: 0 1 auto; white-space: normal; word-break: break-all; color: var(--gt-dim); padding: 5px 9px; font-size: 11.5px; }
.mcp-page .qi-scopes { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mcp-page .qi-scope,
.mcp-page .qi-pill,
.mcp-page .mcp-pill {
  display: inline-flex; align-items: center; gap: 8px;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: var(--mcp-well);
  color: var(--gt-dim);
  font: 520 12.5px/1 var(--g-font-family, inherit);
  cursor: pointer;
  white-space: nowrap;
  transition: background 240ms var(--gt-ease), border-color 200ms ease, box-shadow 240ms ease, transform 160ms ease;
}
.mcp-page .qi-scope:hover,
.mcp-page .qi-pill:hover,
.mcp-page .mcp-pill:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.mcp-page .qi-scope:active,
.mcp-page .qi-pill:active,
.mcp-page .mcp-pill:active { transform: scale(0.96); }
.mcp-page .qi-scope:focus-visible,
.mcp-page .qi-pill:focus-visible,
.mcp-page .mcp-pill:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.mcp-page .qi-scope.active,
.mcp-page .qi-pill.active,
.mcp-page .mcp-pill.active {
  color: var(--gt-fg);
  border-color: color-mix(in srgb, var(--gt-gold) 46%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 6px 18px -10px color-mix(in srgb, var(--gt-gold) 80%, transparent);
}
.mcp-page .qi-pill { border-radius: 11px; }
.mcp-page .qi-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--qi-c, var(--muted));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--qi-c, var(--muted)) 16%, transparent), 0 0 10px var(--qi-c, var(--muted));
}
.mcp-page .qi-dot.ok { --qi-c: var(--ok); }
.mcp-page .qi-dot.warn { --qi-c: var(--warn); }
.mcp-page .qi-dot.down { --qi-c: var(--danger); }
.mcp-page .qi-why {
  min-height: 34px;
  padding: 0 6px;
  border: 0;
  background: none;
  color: var(--gt-gold-ink);
  font: 500 12.5px var(--g-font-family, inherit);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--gt-gold) 40%, transparent);
  text-underline-offset: 3px;
  cursor: pointer;
}
.mcp-page .qi-refresh { margin-left: auto; width: 36px; padding: 0; }
.mcp-page .qi-scope-hint,
.mcp-page .qi-explain { font-size: 12.5px; line-height: 1.5; color: var(--gt-dim); }
.mcp-page .qi-warn {
  padding: 10px 13px;
  border-radius: 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 26%, transparent);
}
.mcp-page .qi-warn a { color: inherit; font-weight: 600; }
.mcp-page .qi-pickers { display: flex; flex-direction: column; gap: 12px; }
.mcp-page .qi-picker-group { display: flex; align-items: flex-start; gap: 12px; }
.mcp-page .qi-picker-label { min-width: 56px; padding-top: 11px; margin: 0; }
.mcp-page .qi-client-pills,
.mcp-page .qi-os-pills { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0; }
.mcp-page .qi-snippet-wrap { position: relative; }
.mcp-page .qi-snippet-copy {
  position: absolute; top: 10px; right: 10px; z-index: 1;
  height: 30px; padding: 0 12px;
  border-radius: 9px;
  font: 600 11.5px/1 var(--g-font-family, inherit);
  color: var(--gt-gold-ink);
  background: color-mix(in srgb, var(--bg, #000) 60%, var(--gt-gold) 14%);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 40%, transparent);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition: transform 160ms ease, background 200ms ease;
}
:root[data-theme="light"] .mcp-page .qi-snippet-copy { background: rgba(255, 255, 255, 0.88); }
.mcp-page .qi-snippet-copy:hover { background: color-mix(in srgb, var(--bg, #000) 50%, var(--gt-gold) 24%); }
.mcp-page .qi-snippet-copy:active { transform: scale(0.95); }
.mcp-page .qi-snippet,
.mcp-page .mcp-command-block,
.mcp-page .mcp-reg-install-cmd,
.mcp-page .mcp-insp-result {
  margin: 0;
  padding: 14px 16px;
  border-radius: 14px;
  font: 12px/1.6 var(--mono);
  color: var(--gt-fg);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 4%, transparent), transparent 40%),
    var(--mcp-code-bg);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
}
:root[data-theme="light"] .mcp-page .qi-snippet,
:root[data-theme="light"] .mcp-page .mcp-command-block,
:root[data-theme="light"] .mcp-page .mcp-reg-install-cmd,
:root[data-theme="light"] .mcp-page .mcp-insp-result { box-shadow: inset 0 1px 2px rgba(24, 24, 27, 0.05); }
.mcp-page .qi-snippet { overflow-x: auto; white-space: pre; padding-right: 86px; }
.mcp-page .mcp-command-block { white-space: pre-wrap; word-break: break-all; font-size: 11.5px; color: var(--gt-dim); }
.mcp-page .qi-meta { display: flex; flex-direction: column; gap: 8px; }
.mcp-page .qi-meta-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mcp-page .qi-meta-key { margin: 0; min-width: 80px; }
.mcp-page .qi-help {
  display: grid; gap: 8px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
}
.mcp-page .qi-help-item { font-size: 12.5px; line-height: 1.5; color: var(--gt-dim); }
.mcp-page .qi-help-item strong { color: var(--gt-gold-ink); }

/* ── Discovery ──────────────────────────────────────────────── */
.mcp-page .mcp-discovery { margin: 34px 0 36px; }
.mcp-page .mcp-discovery-head { display: flex; align-items: center; gap: 14px 18px; flex-wrap: wrap; margin-bottom: 14px; }
.mcp-page .mcp-search-wrap { flex: 1; min-width: min(100%, 260px); position: relative; display: flex; align-items: center; }
.mcp-page .mcp-search-icon { position: absolute; left: 14px; display: grid; color: var(--gt-faint); pointer-events: none; }
.mcp-page .mcp-search-icon svg { width: 16px; height: 16px; }
.mcp-page .mcp-search-input { width: 100%; height: 44px; padding-left: 42px; box-sizing: border-box; border-radius: 14px; font-size: 13.5px; }
.mcp-page .mcp-pills {
  display: flex;
  gap: 6px;
  margin-bottom: 20px;
  overflow-x: auto;
  padding: 2px 2px 6px;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(90deg, #000 92%, transparent);
  mask-image: linear-gradient(90deg, #000 92%, transparent);
}
.mcp-page .mcp-pills::-webkit-scrollbar { display: none; }
.mcp-page .mcp-pill { flex: none; }
.mcp-page .mcp-pill-count { font: 600 10.5px/1 var(--mono); opacity: 0.6; margin-left: 2px; }

.mcp-page .mcp-featured-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  gap: 16px;
}
.mcp-page .mcp-feat-card {
  --accent: var(--gt-gold);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  min-width: 0;
}
.mcp-page .mcp-feat-card > * { position: relative; z-index: 1; }
.mcp-page .mcp-feat-glow {
  position: absolute !important;
  z-index: 0 !important;
  inset: -40% -30% auto auto;
  width: 70%; height: 90%;
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 22%, transparent), transparent);
  opacity: 0.5;
  pointer-events: none;
  transition: opacity 420ms var(--gt-ease), transform 620ms var(--gt-ease);
}
.mcp-page .mcp-feat-card:hover .mcp-feat-glow { opacity: 1; transform: scale(1.12); }
.mcp-page .mcp-feat-card:active { transform: var(--mcp-press); }
.mcp-page .mcp-feat-card:focus-visible { box-shadow: var(--gt-shadow-hover), 0 0 0 2px color-mix(in srgb, var(--gt-gold) 70%, transparent); }
.mcp-page .mcp-feat-top { display: flex; align-items: flex-start; gap: 12px; }
.mcp-page .mcp-feat-logo {
  display: grid; place-items: center;
  width: 44px; height: 44px; flex: none;
  border-radius: 14px;
  font-size: 21px;
  line-height: 1;
  background:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 72%),
    color-mix(in srgb, var(--gt-fg) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 10px 22px -12px color-mix(in srgb, var(--accent) 70%, transparent);
}
.mcp-page .mcp-feat-namewrap { flex: 1; min-width: 0; }
.mcp-page .mcp-feat-name { font: 640 15px/1.25 var(--g-font-family, inherit); letter-spacing: -0.012em; color: var(--gt-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-page .mcp-feat-cat { margin-top: 4px; font: 600 10px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.mcp-page .mcp-feat-tagline { flex: 1; font-size: 13px; line-height: 1.5; color: var(--gt-dim); }
.mcp-page .mcp-feat-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--gt-line); }
.mcp-page .mcp-feat-transport { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 10.5px/1 var(--mono); letter-spacing: 0.06em; color: var(--gt-faint); }
.mcp-page .mcp-feat-install { height: 34px; padding: 0 16px; flex: none; }

.mcp-page .mcp-stat {
  --st: var(--muted-strong, #71717a);
  display: inline-flex; align-items: center; gap: 6px;
  flex: none;
  height: 24px; padding: 0 10px;
  border-radius: 999px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--st);
  background: color-mix(in srgb, var(--st) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--st) 26%, transparent);
}
.mcp-page .mcp-stat .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.mcp-page .mcp-stat.notinstalled { --st: var(--gt-faint); }
.mcp-page .mcp-stat.notinstalled .dot { box-shadow: none; opacity: 0.6; }
.mcp-page .mcp-stat.installing { --st: var(--warn); }
.mcp-page .mcp-stat.installing .dot { animation: mcp-g-breathe 1.2s ease-in-out infinite; }
.mcp-page .mcp-stat.connected { --st: var(--ok); }
.mcp-page .mcp-stat.installed { --st: var(--info, #38bdf8); }
.mcp-page .mcp-stat.error { --st: var(--danger); }

/* ── Servers (installed list) ───────────────────────────────── */
.mcp-page .mcp-category { margin-bottom: 18px; }
.mcp-page .mcp-category-header {
  display: flex; align-items: center; gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 0 4px;
  margin-bottom: 10px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mcp-page .mcp-category-header:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; border-radius: 10px; }
.mcp-page .mcp-category-chevron { display: grid; place-items: center; width: 18px; color: var(--gt-faint); transition: transform 420ms var(--gt-ease), color 200ms ease; }
.mcp-page .mcp-category-chevron svg { width: 15px; height: 15px; }
.mcp-page .mcp-category-chevron.open { transform: rotate(90deg); color: var(--gt-gold-ink); }
.mcp-page .mcp-category-label { font: 600 11px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-dim); transition: color 200ms ease; }
.mcp-page .mcp-category-header:hover .mcp-category-label { color: var(--gt-gold-ink); }
.mcp-page .mcp-category-rule { flex: 1; height: 1px; background: linear-gradient(90deg, var(--gt-line), transparent); }
.mcp-page .mcp-category-count {
  min-width: 24px; padding: 4px 8px; border-radius: 999px;
  font: 600 10.5px/1 var(--mono); text-align: center;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 6%, transparent);
}
.mcp-page .mcp-server-list { display: grid; gap: 10px; }
.mcp-page .mcp-server-item { border-radius: 16px; }
.mcp-page .mcp-server-item.expanded { box-shadow: var(--gt-shadow-hover); }
.mcp-page .mcp-server-row {
  display: flex; align-items: center; gap: 12px;
  min-height: 64px;
  padding: 10px 14px 10px 12px;
  border-radius: 16px;
  cursor: pointer;
  outline: none;
  transition: background 220ms ease;
}
.mcp-page .mcp-server-row:hover { background: color-mix(in srgb, var(--gt-gold) 3.5%, transparent); }
.mcp-page .mcp-server-row:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--gt-gold) 70%, transparent); }
.mcp-page .mcp-server-row .mcp-server-icon { width: 38px; height: 38px; border-radius: 12px; font-size: 17px; }
.mcp-page .mcp-server-row .mcp-server-name { font-size: 14px; }
.mcp-page .mcp-server-row .mcp-server-desc { -webkit-line-clamp: 1; margin-top: 2px; font-size: 12px; }
.mcp-page .mcp-server-chevron { display: grid; place-items: center; width: 18px; flex: none; color: var(--gt-faint); transition: transform 420ms var(--gt-ease), color 200ms ease; }
.mcp-page .mcp-server-chevron svg { width: 15px; height: 15px; }
.mcp-page .mcp-server-chevron.open { transform: rotate(90deg); color: var(--gt-gold-ink); }
.mcp-page .mcp-server-tools-count { flex: none; }
.mcp-page .mcp-server-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.mcp-page .mcp-insp-trybtn { height: 32px; padding: 0 12px; font-size: 12px; border-radius: 10px; }

/* toggle */
.mcp-page .mcp-toggle {
  position: relative;
  display: inline-block;
  width: 44px; height: 26px;
  flex: none;
  cursor: pointer;
}
.mcp-page .mcp-toggle::after { content: ""; position: absolute; inset: -8px -4px; }
.mcp-page .mcp-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.mcp-page .mcp-toggle-track {
  position: absolute; inset: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gt-fg) 10%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: background 320ms var(--gt-ease), box-shadow 320ms ease;
}
.mcp-page .mcp-toggle input:checked + .mcp-toggle-track {
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 85%, #fff 15%), var(--gt-gold));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 60%, transparent), 0 4px 14px -4px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.mcp-page .mcp-toggle input:focus-visible + .mcp-toggle-track { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.mcp-page .mcp-toggle-thumb {
  position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: linear-gradient(180deg, #fff, #e9e6df);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 3px 8px rgba(0, 0, 0, 0.25);
  transition: transform 420ms var(--gt-ease);
}
.mcp-page .mcp-toggle input:checked ~ .mcp-toggle-thumb { transform: translateX(18px); }

/* expanded server detail */
.mcp-page .mcp-server-detail {
  margin: 0 12px 12px;
  padding: 16px;
  border-radius: 14px;
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
  animation: mcp-g-unfold 480ms var(--gt-ease) both;
}
.mcp-page .mcp-server-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: 14px 18px;
  margin-bottom: 16px;
}
.mcp-page .mcp-detail-item { display: flex; flex-direction: column; gap: 0; min-width: 0; }
.mcp-page .mcp-detail-label { margin-bottom: 6px; }
.mcp-page .mcp-detail-value { font: 12.5px/1.45 var(--mono); color: var(--gt-fg); word-break: break-all; }
.mcp-page .mcp-detail-value a,
.mcp-page .mcp-reg-info-value a { color: var(--gt-gold-ink); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--gt-gold) 35%, transparent); }
.mcp-page .mcp-detail-value a:hover,
.mcp-page .mcp-reg-info-value a:hover { border-bottom-color: var(--gt-gold); }
.mcp-page .mcp-detail-divider { height: 1px; margin: 16px 0 14px; background: linear-gradient(90deg, transparent, var(--gt-line) 20%, var(--gt-line) 80%, transparent); }
.mcp-page .mcp-tools-detail-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.mcp-page .mcp-tools-detail-title { font: 600 13px/1 var(--g-font-family, inherit); color: var(--gt-fg); }
.mcp-page .mcp-tool-detail-list { display: grid; gap: 4px; max-height: 380px; overflow-y: auto; scrollbar-width: thin; }
.mcp-page .mcp-tool-detail-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.38fr) 1fr;
  gap: 4px 14px;
  align-items: baseline;
  padding: 9px 12px;
  border-radius: 11px;
  border: 1px solid transparent;
  transition: background 200ms ease, border-color 200ms ease;
}
.mcp-page .mcp-tool-detail-row:hover { background: var(--mcp-well-hover); border-color: color-mix(in srgb, var(--gt-gold) 16%, transparent); }
.mcp-page .mcp-tool-detail-name { font: 600 12px/1.4 var(--mono); color: var(--gt-gold-ink); overflow-wrap: anywhere; }
.mcp-page .mcp-tool-detail-desc { font-size: 12.5px; line-height: 1.5; color: var(--gt-dim); }
.mcp-page .mcp-tool-detail-desc.is-muted { color: var(--gt-faint); font-style: italic; }
.mcp-page .mcp-no-tools { padding: 10px 0; font-size: 12.5px; font-style: italic; color: var(--gt-faint); }

/* ── Sheets (dialogs) ───────────────────────────────────────── */
.mcp-page .mcp-dialog-overlay,
.mcp-page .mcp-marketplace-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--shell-topbar-height, 56px) + 16px) 24px 24px;
  background:
    radial-gradient(80% 60% at 50% 0%, color-mix(in srgb, var(--gt-gold) 10%, transparent), transparent 70%),
    rgba(4, 4, 6, 0.62);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
  animation: mcp-g-fade 260ms ease both;
}
:root[data-theme="light"] .mcp-page .mcp-dialog-overlay,
:root[data-theme="light"] .mcp-page .mcp-marketplace-overlay {
  background: radial-gradient(80% 60% at 50% 0%, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent 70%), rgba(40, 32, 18, 0.28);
}
@keyframes mcp-g-fade { from { opacity: 0; } }
.mcp-page .mcp-dialog,
.mcp-page .mcp-marketplace,
.mcp-page .mcp-drawer {
  position: relative;
  box-sizing: border-box;
  color: var(--gt-fg);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 26%, var(--gt-line));
  background:
    linear-gradient(90deg, transparent 8%, color-mix(in srgb, var(--gt-gold) 70%, transparent) 50%, transparent 92%) top / 100% 1px no-repeat,
    radial-gradient(120% 50% at 50% 0%, color-mix(in srgb, var(--gt-gold) 9%, transparent), transparent 60%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 160px),
    var(--mcp-sheet-bg);
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  backdrop-filter: blur(28px) saturate(170%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.35),
    0 30px 80px -20px rgba(0, 0, 0, 0.75),
    0 50px 120px -50px color-mix(in srgb, var(--gt-gold) 40%, transparent);
}
:root[data-theme="light"] .mcp-page .mcp-dialog,
:root[data-theme="light"] .mcp-page .mcp-marketplace,
:root[data-theme="light"] .mcp-page .mcp-drawer {
  box-shadow: inset 0 1px 0 #fff, 0 2px 6px rgba(24, 24, 27, 0.08), 0 30px 80px -24px rgba(60, 40, 10, 0.35);
}
.mcp-page .mcp-dialog {
  width: 520px;
  max-width: 100%;
  max-height: min(calc(100vh - var(--shell-topbar-height, 56px) - 48px), 860px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 26px 26px 22px;
  border-radius: 24px;
  scrollbar-width: thin;
  animation: mcp-g-sheet 520ms var(--gt-ease) both;
}
@keyframes mcp-g-sheet { from { opacity: 0; transform: translateY(18px) scale(0.98); } }
.mcp-page .mcp-sheet-head,
.mcp-page .canva-modal-header,
.mcp-page .supabase-modal-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 22px;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--gt-line);
}
.mcp-page .mcp-sheet-orb,
.mcp-page .canva-card-icon,
.mcp-page .supabase-card-icon {
  display: grid; place-items: center;
  width: 46px; height: 46px; flex: none;
  border-radius: 15px;
  color: var(--gt-gold-ink);
  font-size: 20px;
  background: var(--mcp-tile);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 12px 26px -12px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}
.mcp-page .mcp-sheet-orb svg,
.mcp-page .canva-card-icon svg,
.mcp-page .supabase-card-icon svg { width: 20px; height: 20px; }
.mcp-page .canva-card-icon { --brand: #a855f7; }
.mcp-page .supabase-card-icon { --brand: #3ecf8e; }
.mcp-page .canva-card-icon,
.mcp-page .supabase-card-icon {
  color: var(--brand);
  background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--brand) 34%, transparent), transparent 72%), color-mix(in srgb, var(--gt-fg) 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand) 34%, transparent), 0 12px 26px -12px color-mix(in srgb, var(--brand) 60%, transparent);
}
.mcp-page .mcp-sheet-titles { flex: 1; min-width: 0; }
.mcp-page .mcp-dialog-title,
.mcp-page .canva-modal-title,
.mcp-page .supabase-modal-title {
  margin: 0;
  padding: 0;
  border: 0;
  font: 650 19px/1.2 var(--g-font-family, inherit);
  letter-spacing: -0.02em;
  text-transform: none;
  color: var(--gt-fg);
}
.mcp-page .mcp-sheet-sub,
.mcp-page .canva-modal-subtitle,
.mcp-page .supabase-modal-subtitle,
.mcp-page .mcp-guided-sub { margin-top: 4px; font-size: 12.5px; line-height: 1.45; color: var(--gt-dim); }
.mcp-page .mcp-form-group,
.mcp-page .mcp-field { margin-bottom: 18px; }
.mcp-page .mcp-form-label { display: flex; }
.mcp-page .mcp-form-input,
.mcp-page .mcp-reg-env-input,
.mcp-page .mcp-insp-tryform textarea,
.mcp-page .mcp-marketplace-search input {
  width: 100%;
  min-height: 42px;
  box-sizing: border-box;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--bg, #050505) 55%, transparent);
  color: var(--gt-fg);
  font: 13px/1.4 var(--g-font-family, inherit);
  outline: none;
  transition: border-color 200ms ease, box-shadow 260ms ease, background 200ms ease;
}
:root[data-theme="light"] .mcp-page .mcp-form-input,
:root[data-theme="light"] .mcp-page .mcp-reg-env-input,
:root[data-theme="light"] .mcp-page .mcp-insp-tryform textarea,
:root[data-theme="light"] .mcp-page .mcp-marketplace-search input { background: rgba(255, 255, 255, 0.85); }
.mcp-page .mcp-form-input::placeholder,
.mcp-page .mcp-reg-env-input::placeholder,
.mcp-page .mcp-insp-tryform textarea::placeholder,
.mcp-page .mcp-marketplace-search input::placeholder { color: var(--gt-faint); }
.mcp-page .mcp-form-input:focus,
.mcp-page .mcp-reg-env-input:focus,
.mcp-page .mcp-insp-tryform textarea:focus,
.mcp-page .mcp-marketplace-search input:focus { border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); }
.mcp-page .mcp-form-input.is-code,
.mcp-page textarea.mcp-form-input,
.mcp-page .mcp-insp-tryform textarea { font-family: var(--mono); font-size: 12.5px; }
.mcp-page textarea.mcp-form-input { min-height: 84px; resize: vertical; }
.mcp-page .mcp-form-hint { margin-top: 6px; font-size: 12px; line-height: 1.45; color: var(--gt-faint); }
.mcp-page .mcp-form-hint code { font-size: 11px; color: var(--gt-dim); }
.mcp-page .mcp-dialog-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--gt-line);
}
.mcp-page .mcp-dialog-actions .gt-btn { height: 40px; padding: 0 18px; }
.mcp-page .mcp-sheet-close { margin-left: auto; }
.mcp-page .mcp-sheet-steps { display: flex; gap: 6px; flex-wrap: wrap; margin: -8px 0 20px; }

/* Canva / Supabase / guided-install specifics */
.mcp-page .canva-not-installed,
.mcp-page .mcp-guided-noenv,
.mcp-page .canva-connected-info,
.mcp-page .supabase-connected-info,
.mcp-page .canva-test-result,
.mcp-page .supabase-test-result,
.mcp-page .mcp-guided-test {
  margin-bottom: 16px;
  padding: 12px 14px;
  border-radius: 13px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--gt-dim);
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
}
.mcp-page .mcp-guided-noenv,
.mcp-page .canva-connected-info,
.mcp-page .supabase-connected-info,
.mcp-page .canva-test-result.success,
.mcp-page .supabase-test-result.success,
.mcp-page .mcp-guided-test.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); border-color: color-mix(in srgb, var(--ok) 26%, transparent); }
.mcp-page .canva-test-result.failure,
.mcp-page .supabase-test-result.failure,
.mcp-page .mcp-guided-test.bad { color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border-color: color-mix(in srgb, var(--danger) 26%, transparent); }
.mcp-page .canva-connected-email,
.mcp-page .supabase-connected-pat { font-weight: 600; }
.mcp-page .supabase-connected-pat { font-family: var(--mono); }
.mcp-page .canva-connected-status,
.mcp-page .supabase-connected-meta { margin-top: 4px; font-size: 11.5px; color: var(--gt-dim); }
.mcp-page .canva-token-row,
.mcp-page .supabase-pat-row,
.mcp-page .mcp-field-inputrow { display: flex; gap: 8px; align-items: stretch; }
.mcp-page .canva-token-row .mcp-form-input,
.mcp-page .supabase-pat-row .mcp-form-input,
.mcp-page .mcp-field-inputrow .mcp-form-input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12.5px; }
.mcp-page .canva-token-row .gt-btn,
.mcp-page .supabase-pat-row .gt-btn { height: auto; min-height: 42px; }
.mcp-page .canva-help-link,
.mcp-page .supabase-help-link,
.mcp-page .mcp-field-help {
  display: inline-flex;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 550;
  color: var(--gt-gold-ink);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--gt-gold) 30%, transparent);
}
.mcp-page .canva-help-link:hover,
.mcp-page .supabase-help-link:hover,
.mcp-page .mcp-field-help:hover { border-bottom-color: var(--gt-gold); }
.mcp-page .canva-token-warning { margin-top: 6px; font-size: 12px; color: var(--warn); }
.mcp-page .canva-or-divider {
  display: flex; align-items: center; gap: 12px;
  margin: 4px 0 18px;
  font-size: 12px; color: var(--gt-faint);
}
.mcp-page .canva-or-divider::before,
.mcp-page .canva-or-divider::after { content: ""; flex: 1; height: 1px; background: var(--gt-line); }
.mcp-page .supabase-readonly-row { display: flex; align-items: center; gap: 12px; min-height: 40px; }
.mcp-page .supabase-readonly-toggle {
  position: relative;
  width: 44px; height: 26px; flex: none;
  border-radius: 999px;
  cursor: pointer;
  background: color-mix(in srgb, var(--gt-fg) 10%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-line);
  transition: background 320ms var(--gt-ease);
}
.mcp-page .supabase-readonly-toggle::after {
  content: "";
  position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px; border-radius: 50%;
  background: linear-gradient(180deg, #fff, #e9e6df);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 3px 8px rgba(0, 0, 0, 0.2);
  transition: transform 420ms var(--gt-ease);
}
.mcp-page .supabase-readonly-toggle.on { background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 85%, #fff 15%), var(--gt-gold)); }
.mcp-page .supabase-readonly-toggle.on::after { transform: translateX(18px); }
.mcp-page .supabase-readonly-toggle:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.mcp-page .supabase-readonly-label { font-size: 12.5px; color: var(--gt-dim); }
.mcp-page .mcp-field-label { margin-bottom: 8px; }
.mcp-page .mcp-field-req { color: var(--warn); }
.mcp-page .mcp-field-secret-tag {
  padding: 3px 7px; border-radius: 999px;
  font: 600 9.5px/1 var(--mono); letter-spacing: 0.1em;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 28%, transparent);
}
.mcp-page .mcp-field-prefix {
  display: grid; place-items: center;
  width: 42px; flex: none;
  border-radius: 12px;
  color: var(--gt-faint);
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
}
.mcp-page .mcp-config-kicker { margin-bottom: 12px; font: 600 10px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
.mcp-page .mcp-advanced { margin-bottom: 14px; }
.mcp-page .mcp-advanced summary {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 34px;
  cursor: pointer;
  font-size: 12.5px; font-weight: 550;
  color: var(--gt-dim);
  list-style: none;
}
.mcp-page .mcp-advanced summary::-webkit-details-marker { display: none; }
.mcp-page .mcp-advanced summary::before { content: "▸"; font-size: 10px; color: var(--gt-gold-ink); transition: transform 300ms var(--gt-ease); }
.mcp-page .mcp-advanced[open] summary::before { transform: rotate(90deg); }
.mcp-page .mcp-advanced summary:hover { color: var(--gt-fg); }

/* ── Registry marketplace sheet ─────────────────────────────── */
.mcp-page .mcp-marketplace-overlay { z-index: 1000; }
.mcp-page .mcp-marketplace {
  width: 980px;
  max-width: 100%;
  max-height: min(calc(100vh - var(--shell-topbar-height, 56px) - 48px), 920px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 26px;
  animation: mcp-g-sheet 560ms var(--gt-ease) both;
}
.mcp-page .mcp-marketplace-header {
  display: flex; align-items: center; gap: 14px 16px; flex-wrap: wrap;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--gt-line);
  flex-shrink: 0;
}
.mcp-page .mcp-marketplace-title { display: inline-flex; align-items: center; gap: 10px; font: 650 18px/1.2 var(--g-font-family, inherit); letter-spacing: -0.018em; color: var(--gt-fg); white-space: nowrap; }
.mcp-page .mcp-marketplace-title svg { width: 30px; height: 30px; padding: 7px; box-sizing: border-box; border-radius: 10px; color: var(--gt-gold-ink); background: var(--gt-gold-faint); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 28%, transparent); }
.mcp-page .mcp-marketplace-search { flex: 1; min-width: min(100%, 260px); display: flex; gap: 8px; }
.mcp-page .mcp-marketplace-search .gt-btn { height: 42px; }
.mcp-page .mcp-marketplace-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 18px 22px; scrollbar-width: thin; }
.mcp-page .mcp-marketplace-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  padding: 12px 22px;
  border-top: 1px solid var(--gt-line);
  flex-shrink: 0;
}
.mcp-page .mcp-marketplace-footer-text { font: 500 10.5px/1.3 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--gt-faint); }
.mcp-page .mcp-reg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.mcp-page .mcp-reg-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px;
  border-radius: 16px;
  cursor: pointer;
  outline: none;
  min-width: 0;
}
.mcp-page .mcp-reg-card:active { transform: var(--mcp-press); }
.mcp-page .mcp-reg-card:focus-visible { box-shadow: var(--gt-shadow-hover), 0 0 0 2px color-mix(in srgb, var(--gt-gold) 70%, transparent); }
.mcp-page .mcp-reg-card-top { display: flex; align-items: center; gap: 10px; }
.mcp-page .mcp-reg-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 620 13.5px/1.3 var(--mono); color: var(--gt-fg); }
.mcp-page .mcp-reg-transport {
  flex: none;
  height: 22px; padding: 0 8px;
  display: inline-flex; align-items: center;
  border-radius: 999px;
  border: 1px solid;
  font: 600 9.5px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.mcp-page .mcp-reg-card-desc { font-size: 12.5px; line-height: 1.5; color: var(--gt-dim); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mcp-page .mcp-reg-card-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--gt-faint); }
.mcp-page .mcp-reg-card-meta span { display: inline-flex; align-items: center; gap: 5px; }
.mcp-page .mcp-reg-card-meta svg { width: 13px; height: 13px; }
.mcp-page .mcp-reg-version { font-family: var(--mono); color: var(--gt-gold-ink); }
.mcp-page .mcp-reg-load-more { display: flex; justify-content: center; padding: 18px 0 4px; }
.mcp-page .mcp-reg-detail { display: flex; flex-direction: column; gap: 18px; animation: mcp-g-unfold 480ms var(--gt-ease) both; }
.mcp-page .mcp-reg-detail-back { align-self: flex-start; }
.mcp-page .mcp-reg-detail-name { font: 650 22px/1.2 var(--g-font-family, inherit); letter-spacing: -0.02em; color: var(--gt-fg); word-break: break-word; }
.mcp-page .mcp-reg-detail-desc { font-size: 14px; line-height: 1.6; color: var(--gt-dim); }
.mcp-page .mcp-reg-detail-info {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
  gap: 16px;
  padding: 16px 18px;
  border-radius: 16px;
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
}
.mcp-page .mcp-reg-info-item { display: flex; flex-direction: column; min-width: 0; }
.mcp-page .mcp-reg-info-label { margin-bottom: 5px; }
.mcp-page .mcp-reg-info-value { font: 12.5px/1.45 var(--mono); color: var(--gt-fg); word-break: break-all; }
.mcp-page .mcp-reg-install-cmd { word-break: break-all; }
.mcp-page .mcp-reg-install-cmd .cmd-prefix { color: var(--gt-gold-ink); font-weight: 700; }
.mcp-page .mcp-reg-env-section { display: flex; flex-direction: column; gap: 8px; }
.mcp-page .mcp-reg-env-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.mcp-page .mcp-reg-env-name { display: inline-flex; align-items: center; gap: 6px; min-width: 150px; font: 600 12px var(--mono); color: var(--gt-fg); }
.mcp-page .mcp-reg-env-input { flex: 1; min-width: min(100%, 200px); width: auto; font-family: var(--mono); font-size: 12.5px; }
.mcp-page .mcp-reg-env-hint { font-size: 12px; color: var(--gt-faint); margin-top: -2px; }
.mcp-page .mcp-reg-env-secret { display: inline-flex; color: var(--warn); }
.mcp-page .mcp-reg-env-secret svg { width: 13px; height: 13px; }
.mcp-page .mcp-reg-install-btn { align-self: flex-start; height: 44px; padding: 0 24px; font-size: 13.5px; }

/* ── Inspector drawer ───────────────────────────────────────── */
.mcp-page .mcp-drawer-overlay {
  position: fixed; inset: 0; z-index: 1100;
  background: rgba(4, 4, 6, 0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  animation: mcp-g-fade 260ms ease both;
}
:root[data-theme="light"] .mcp-page .mcp-drawer-overlay { background: rgba(40, 32, 18, 0.22); }
.mcp-page .mcp-drawer {
  position: fixed; top: calc(var(--shell-topbar-height, 56px) + 12px); right: 12px; bottom: 12px;
  z-index: 1101;
  width: 580px;
  max-width: calc(100vw - 24px);
  display: flex; flex-direction: column;
  border-radius: 24px;
  overflow: hidden;
  animation: mcp-g-drawer 560ms var(--gt-ease) both;
}
@keyframes mcp-g-drawer { from { opacity: 0; transform: translateX(40px); } }
.mcp-page .mcp-drawer-head { display: flex; align-items: center; gap: 14px; padding: 20px 22px 16px; border-bottom: 1px solid var(--gt-line); flex-shrink: 0; }
.mcp-page .mcp-drawer-logo {
  display: grid; place-items: center;
  width: 46px; height: 46px; flex: none;
  border-radius: 15px;
  font-size: 20px;
  border: 0 !important;
  background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--g-primary-accent, var(--gt-gold)) 34%, transparent), transparent 72%), color-mix(in srgb, var(--gt-fg) 4%, transparent) !important;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary-accent, var(--gt-gold)) 34%, transparent), 0 12px 26px -12px color-mix(in srgb, var(--g-primary-accent, var(--gt-gold)) 60%, transparent);
}
.mcp-page .mcp-drawer-title { font: 650 18px/1.2 var(--g-font-family, inherit); letter-spacing: -0.018em; color: var(--gt-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-page .mcp-drawer-sub { margin-top: 4px; font: 600 10px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
.mcp-page .mcp-drawer-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 18px 22px 24px; scrollbar-width: thin; }
.mcp-page .mcp-insp-toolcount { margin-bottom: 12px; font: 600 10.5px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-gold-ink); }
.mcp-page .mcp-insp-tool {
  margin-bottom: 8px;
  border-radius: 14px;
  background: var(--mcp-well);
  border: 1px solid var(--gt-line);
  overflow: hidden;
  transition: border-color 220ms ease, background 220ms ease;
}
.mcp-page .mcp-insp-tool:hover { border-color: color-mix(in srgb, var(--gt-gold) 26%, transparent); }
.mcp-page .mcp-insp-tool-head { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 10px 8px 14px; cursor: pointer; }
.mcp-page .mcp-insp-tool-name { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; font: 600 12.5px/1.3 var(--mono); color: var(--gt-gold-ink); }
.mcp-page .mcp-insp-tool-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--gt-dim); }
.mcp-page .mcp-insp-tryform { padding: 0 14px 14px; border-top: 1px solid var(--gt-line); animation: mcp-g-unfold 420ms var(--gt-ease) both; }
.mcp-page .mcp-insp-tryform textarea { margin-top: 12px; min-height: 76px; resize: vertical; }
.mcp-page .mcp-insp-runrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.mcp-page .mcp-insp-runnote { font-size: 12px; color: var(--gt-faint); }
.mcp-page .mcp-insp-result { margin-top: 10px; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow-y: auto; }
.mcp-page .mcp-insp-result.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 28%, transparent); }

/* ── Mobile ─────────────────────────────────────────────────── */
@media (max-width: 640px) {
  .mcp-page { padding: 0 12px 40px; }
  .mcp-page .cap-tabbar { margin-bottom: 18px; }
  .mcp-page .cap-tabs { display: grid; width: 100%; box-sizing: border-box; }
  .mcp-page .cap-tab { padding: 0 8px; gap: 6px; font-size: 13px; min-height: 42px; }
  .mcp-page .cap-tabbar-hint { display: none; }
  .mcp-page .mcp-servers-grid, .mcp-page .mcp-agents-grid, .mcp-page .mcp-featured-grid { grid-template-columns: 1fr; gap: 12px; }
  .mcp-page .mcp-section-tools { width: 100%; }
  .mcp-page .mcp-section-tools > .gt-btn { flex: 1; }
  .mcp-page .mcp-filter-wrap { flex: 1; }
  .mcp-page .mcp-filter { width: 100%; }
  .mcp-page .gt-btn, .mcp-page .mcp-icon-btn { min-height: 40px; }
  .mcp-page .mcp-icon-btn { width: 40px; }
  .mcp-page .mcp-insp-trybtn { height: 40px; }
  .mcp-page .qi-scope, .mcp-page .qi-pill, .mcp-page .mcp-pill, .mcp-page .qi-why { min-height: 40px; }
  .mcp-page .mcp-status-bar { padding: 16px; }
  .mcp-page .mcp-actions { width: 100%; }
  .mcp-page .mcp-actions .gt-btn { flex: 1 1 auto; }
  .mcp-page .mcp-servers-count { display: none; }
  .mcp-page .qi-head-sub { display: none; }
  .mcp-page .qi-body { padding: 16px 14px 18px; }
  .mcp-page .qi-picker-group { flex-direction: column; gap: 8px; }
  .mcp-page .qi-picker-label { padding-top: 0; min-width: 0; margin: 0; }
  .mcp-page .qi-refresh { margin-left: 0; }
  .mcp-page .mcp-server-row { flex-wrap: wrap; padding: 12px; gap: 10px 12px; }
  .mcp-page .mcp-server-row .mcp-server-info { flex: 1 1 calc(100% - 110px); }
  .mcp-page .mcp-server-tools-count { margin-left: 30px; }
  .mcp-page .mcp-server-actions { margin-left: auto; }
  .mcp-page .mcp-server-detail { margin: 0 8px 8px; padding: 14px 12px; }
  .mcp-page .mcp-tool-detail-row { grid-template-columns: 1fr; }
  .mcp-page .mcp-dialog-overlay, .mcp-page .mcp-marketplace-overlay { align-items: flex-end; padding: 0; }
  .mcp-page .mcp-marketplace-search { order: 3; }
  .mcp-page .mcp-marketplace-close { order: 2; margin-left: auto; }
  .mcp-page .mcp-dialog, .mcp-page .mcp-marketplace {
    width: 100% !important;
    max-height: calc(100vh - var(--shell-topbar-height, 56px) - 16px);
    border-radius: 26px 26px 0 0;
    border-bottom: 0;
    padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px));
    animation-name: mcp-g-sheet-up;
  }
  .mcp-page .mcp-dialog { padding: 30px 18px calc(18px + env(safe-area-inset-bottom, 0px)); }
  .mcp-page .mcp-dialog::before, .mcp-page .mcp-marketplace::before {
    content: "";
    position: absolute; top: 9px; left: 50%;
    width: 40px; height: 4px; margin-left: -20px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--gt-fg) 22%, transparent);
  }
  .mcp-page .mcp-marketplace-header { padding: 26px 16px 14px; }
  .mcp-page .mcp-marketplace-body { padding: 14px 16px; }
  .mcp-page .mcp-marketplace-footer { padding: 10px 16px; }
  .mcp-page .mcp-dialog-actions .gt-btn { flex: 1 1 auto; }
  .mcp-page .mcp-drawer { top: auto; left: 0; right: 0; bottom: 0; width: 100%; max-width: none; height: auto; top: calc(var(--shell-topbar-height, 56px) + 16px); border-radius: 26px 26px 0 0; animation-name: mcp-g-sheet-up; }
  .mcp-page .mcp-reg-env-name { min-width: 100%; }
}
@keyframes mcp-g-sheet-up { from { transform: translateY(40px); opacity: 0; } }
@media (hover: none) {
  .mcp-page .gt-lift:hover { transform: none; }
}

/* ── Fallbacks ──────────────────────────────────────────────── */
:root.perf-mode .mcp-page .cap-tabs,
:root.perf-mode .mcp-page .mcp-dialog-overlay,
:root.perf-mode .mcp-page .mcp-marketplace-overlay,
:root.perf-mode .mcp-page .mcp-drawer-overlay,
:root.perf-mode .mcp-page .qi-snippet-copy { -webkit-backdrop-filter: none; backdrop-filter: none; }
:root.perf-mode .mcp-page .mcp-dialog,
:root.perf-mode .mcp-page .mcp-marketplace,
:root.perf-mode .mcp-page .mcp-drawer { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .mcp-page .mcp-dialog-overlay,
:root.perf-mode .mcp-page .mcp-marketplace-overlay { background: rgba(4, 4, 6, 0.82); }
:root.perf-mode .mcp-page .mcp-feat-glow { display: none; }
:root.perf-mode .mcp-page .mcp-server-card.expanded,
:root.perf-mode .mcp-page .mcp-status-bar.running { background: var(--gt-surface-solid); }
@media (prefers-reduced-transparency: reduce) {
  .mcp-page .cap-tabs,
  .mcp-page .mcp-dialog-overlay,
  .mcp-page .mcp-marketplace-overlay,
  .mcp-page .mcp-drawer-overlay,
  .mcp-page .qi-snippet-copy { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
  .mcp-page .mcp-dialog,
  .mcp-page .mcp-marketplace,
  .mcp-page .mcp-drawer { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .mcp-page .mcp-dialog-overlay,
  .mcp-page .mcp-marketplace-overlay { background: rgba(4, 4, 6, 0.85); }
  .mcp-page .mcp-server-card.expanded,
  .mcp-page .mcp-status-bar.running { background: var(--gt-surface-solid) !important; }
  .mcp-page .mcp-feat-glow { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .mcp-page *,
  .mcp-page *::before,
  .mcp-page *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
  .mcp-page .mcp-loading-dot,
  .mcp-page .mcp-stat.installing .dot { animation: none !important; }
  .mcp-page .mcp-server-card:active,
  .mcp-page .mcp-feat-card:active,
  .mcp-page .mcp-reg-card:active,
  .mcp-page .mcp-feat-card:hover .mcp-feat-glow { transform: none; }
}
`;
