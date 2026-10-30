/**
 * Glass layer for the Agents page's per-agent editors (Settings tab), the
 * Sessions list (Logs tab), the "New agent" dialog and the agent config popup.
 *
 * Builds on the `.gt-*` primitives (glass-tools-shared.ts) and the agent-page
 * helpers (glass-agents-shared.ts). Everything is scoped under `.agm-*`
 * classes, which only exist inside the Agents page root (`.agp-root.gt-scope`)
 * or a modal that carries `.gt-scope` itself, so nothing leaks to other views.
 *
 * Colours come from the glass tokens (--glass-*, --gt-*), so light theme,
 * reduced transparency, reduced motion and perf mode follow automatically.
 */

export const AGM_CSS = /* css */ `
/* ── Local aliases ─────────────────────────────────────────── */
.agm-ed, .agm-modal-scrim, .agm-select {
  --agm-fg: var(--glass-fg, var(--g-fg));
  --agm-dim: var(--glass-fg-2, var(--g-fg-dim));
  --agm-faint: var(--glass-fg-3, var(--g-fg-faint));
  --agm-line: var(--glass-stroke, var(--g-border));
  --agm-line-2: var(--glass-stroke-strong, var(--g-border-strong));
  --agm-gold: var(--glass-gold, var(--g-primary));
  --agm-gold-ink: color-mix(in srgb, var(--agm-gold) 82%, var(--agm-fg));
  --agm-well: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
  --agm-mono: var(--glass-font-mono, var(--mono, ui-monospace, monospace));
  --agm-ok: var(--g-success, var(--ok, #22c55e));
  --agm-bad: var(--g-danger, var(--danger, #ef4444));
  --agm-warn: var(--g-warning, var(--warn, #f59e0b));
}
:root[data-theme="light"] .agm-ed,
:root[data-theme="light"] .agm-modal-scrim,
:root[data-theme="light"] .agm-select {
  --agm-gold-ink: color-mix(in srgb, var(--agm-gold) 55%, var(--agm-fg));
  --agm-well: rgba(255, 255, 255, 0.78);
}

/* ── Editor shell ──────────────────────────────────────────── */
.agm-ed { padding: 14px 16px 16px; color: var(--agm-fg); font-size: 13px; }
.agm-ed-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.agm-ed-title { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 650; letter-spacing: -0.005em; color: var(--agm-fg); }
.agm-ed-title svg, .agm-ed-title .agm-ico svg { width: 15px; height: 15px; color: var(--agm-gold-ink); flex: none; }
.agm-ico { display: inline-flex; color: var(--agm-gold-ink); }
.agm-ico svg { width: 15px; height: 15px; }
.agm-ed-meta { font: 500 10.5px/1 var(--agm-mono); letter-spacing: 0.06em; color: var(--agm-faint); font-variant-numeric: tabular-nums; }
.agm-ed-meta b { color: var(--agm-gold-ink); font-weight: 600; }
.agm-ed-hint { margin: 0 0 12px; font-size: 12px; line-height: 1.5; color: var(--agm-dim); }
.agm-ed-hint--head { margin: 4px 0 0; }
.agm-prompt-body { margin-top: 12px; }
.agm-ed-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--agm-line);
  font: 500 10.5px/1.4 var(--agm-mono); letter-spacing: 0.05em; color: var(--agm-faint);
}
.agm-ed-foot .is-open { color: var(--agm-gold-ink); }
.agm-sub-h {
  display: flex; align-items: center; gap: 10px; margin: 18px 0 10px;
  font: 600 10px/1 var(--agm-mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--agm-gold-ink);
}
.agm-sub-h::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, color-mix(in srgb, var(--agm-gold) 40%, transparent), transparent); }
.agm-sub-h svg { width: 13px; height: 13px; }

/* ── Toggle grid (tools / skills / MCP / sub-agents) ───────── */
.agm-check-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; max-height: 300px; overflow-y: auto; padding: 2px; }
.agm-check-grid--wide { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.agm-check {
  display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 34px;
  padding: 7px 10px; border-radius: 10px; text-align: left; cursor: pointer;
  border: 1px solid var(--agm-line);
  background: color-mix(in srgb, var(--agm-fg) 3%, transparent);
  color: var(--agm-dim); font: 500 11.5px/1.25 var(--agm-mono);
  transition: border-color 200ms ease, background 200ms ease, color 200ms ease, transform 160ms ease, box-shadow 260ms ease;
}
.agm-check:hover { border-color: color-mix(in srgb, var(--agm-gold) 32%, transparent); color: var(--agm-fg); background: color-mix(in srgb, var(--agm-fg) 5.5%, transparent); }
.agm-check:active { transform: scale(0.97); }
.agm-check:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-check[aria-pressed="true"] {
  color: var(--agm-fg);
  border-color: color-mix(in srgb, var(--agm-gold) 42%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--agm-gold) 13%, transparent), color-mix(in srgb, var(--agm-gold) 5%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent), 0 6px 18px -12px color-mix(in srgb, var(--agm-gold) 70%, transparent);
}
.agm-check-box {
  flex: none; width: 15px; height: 15px; display: grid; place-items: center; border-radius: 5px;
  border: 1px solid var(--agm-line-2); background: var(--agm-well); color: var(--glass-ink, #0b0906);
  transition: background 200ms ease, border-color 200ms ease;
}
.agm-check-box svg { width: 11px; height: 11px; stroke-width: 3; }
.agm-check[aria-pressed="true"] .agm-check-box { border-color: transparent; background: var(--glass-gold-fill, var(--agm-gold)); box-shadow: 0 0 10px -2px color-mix(in srgb, var(--agm-gold) 70%, transparent); }
.agm-check-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agm-check-stack { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-family: var(--glass-font, inherit); }
.agm-check-stack b { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agm-check-stack span { font: 10.5px var(--agm-mono); color: var(--agm-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agm-check .gt-chip { height: 18px; padding: 0 7px; font-size: 9.5px; letter-spacing: 0.08em; }

/* ── Small buttons / presets ───────────────────────────────── */
.agm-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.agm-actions--end { justify-content: flex-end; }
.gt-btn.agm-sm { height: 30px; padding: 0 12px; border-radius: 10px; font-size: 11.5px; gap: 6px; }
.gt-btn.agm-xs { height: 26px; padding: 0 10px; border-radius: 8px; font-size: 11px; gap: 5px; }
.gt-btn svg { width: 14px; height: 14px; flex: none; }
.gt-btn.agm-sm svg, .gt-btn.agm-xs svg { width: 13px; height: 13px; }
.gt-btn.is-on { border-color: color-mix(in srgb, var(--agm-gold) 45%, transparent); color: var(--agm-gold-ink); background: color-mix(in srgb, var(--agm-gold) 10%, transparent); }

/* ── Fields ────────────────────────────────────────────────── */
.agm-fields { display: flex; flex-direction: column; gap: 14px; }
.agm-fields--spaced { margin-top: 10px; }
.agm-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.agm-label { font: 600 10px/1 var(--agm-mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--agm-dim); }
.agm-label .agm-req { color: var(--agm-gold-ink); margin-left: 3px; }
.agm-label .agm-opt { text-transform: none; letter-spacing: 0; font-family: var(--glass-font, inherit); font-weight: 400; color: var(--agm-faint); margin-left: 4px; }
.agm-help { font-size: 11.5px; line-height: 1.45; color: var(--agm-faint); }
.gt-input.agm-input { width: 100%; box-sizing: border-box; min-width: 0; }
.gt-input.agm-mono, .agm-mono { font-family: var(--agm-mono); font-size: 12.5px; }
.gt-input.agm-input:focus-visible { box-shadow: var(--glass-focus-ring, 0 0 0 4px var(--gt-gold-faint)); }
.agm-row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.agm-check-grid--spaced { margin-top: 4px; }

/* Switch-style toggle (auto-approve, default agent) */
.agm-toggle {
  display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 12px;
  border-radius: 12px; border: 1px solid var(--agm-line); background: var(--agm-well);
  cursor: pointer; font-size: 12.5px; color: var(--agm-dim);
  transition: border-color 200ms ease, background 200ms ease;
}
.agm-toggle:hover { border-color: color-mix(in srgb, var(--agm-gold) 30%, transparent); }
.agm-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.agm-switch {
  position: relative; flex: none; width: 32px; height: 18px; border-radius: 999px;
  background: color-mix(in srgb, var(--agm-fg) 14%, transparent);
  box-shadow: inset 0 0 0 1px var(--agm-line-2);
  transition: background 240ms var(--glass-ease, ease);
}
.agm-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: transform 320ms var(--glass-spring, ease);
}
.agm-toggle input:checked + .agm-switch { background: var(--glass-gold-fill, var(--agm-gold)); box-shadow: 0 0 12px -3px color-mix(in srgb, var(--agm-gold) 70%, transparent); }
.agm-toggle input:checked + .agm-switch::after { transform: translateX(14px); }
.agm-toggle input:focus-visible + .agm-switch { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-toggle.is-danger { border-color: color-mix(in srgb, var(--agm-bad) 40%, transparent); background: color-mix(in srgb, var(--agm-bad) 8%, transparent); color: var(--agm-bad); }
.agm-toggle.is-danger input:checked + .agm-switch { background: var(--agm-bad); box-shadow: 0 0 12px -3px color-mix(in srgb, var(--agm-bad) 70%, transparent); }
.agm-toggle-text { font: 600 10.5px/1.2 var(--agm-mono); letter-spacing: 0.08em; text-transform: uppercase; }

/* Native selects (type / model) */
.agm-select {
  appearance: none; -webkit-appearance: none;
  width: 100%; min-width: 0; height: 32px; padding: 0 30px 0 10px; box-sizing: border-box;
  border-radius: 10px; border: 1px solid var(--agm-line); cursor: pointer;
  color: var(--agm-fg); font: 500 12px var(--agm-mono);
  color-scheme: dark;
  background:
    linear-gradient(45deg, transparent 50%, var(--agm-gold-ink) 50%) calc(100% - 15px) 50% / 5px 5px no-repeat,
    linear-gradient(135deg, var(--agm-gold-ink) 50%, transparent 50%) calc(100% - 10px) 50% / 5px 5px no-repeat,
    var(--agm-well);
  transition: border-color 200ms ease, box-shadow 260ms ease;
}
:root[data-theme="light"] .agm-select { color-scheme: light; }
.agm-select:hover { border-color: color-mix(in srgb, var(--agm-gold) 32%, transparent); }
.agm-select:focus-visible { outline: none; border-color: color-mix(in srgb, var(--agm-gold) 55%, transparent); box-shadow: var(--glass-focus-ring, 0 0 0 4px var(--gt-gold-faint)); }
.agm-select.is-cli { color: var(--agm-gold-ink); }
.agm-select--lg { height: 40px; font-size: 13px; border-radius: 12px; }

/* ── Code surfaces (prompt preview / editor / SKILL.md) ────── */
.agm-code {
  display: block; width: 100%; box-sizing: border-box; margin: 0;
  padding: 14px 16px; border-radius: 12px;
  border: 1px solid var(--agm-line); background: var(--agm-well);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25);
  color: var(--agm-fg); font: 12px/1.65 var(--agm-mono);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
:root[data-theme="light"] .agm-code { box-shadow: inset 0 1px 2px rgba(60, 45, 20, 0.08); }
pre.agm-code { min-height: 160px; max-height: 460px; overflow: auto; }
pre.agm-code.is-default { color: var(--agm-dim); }
textarea.agm-code { min-height: 280px; max-height: 600px; resize: vertical; outline: none; transition: border-color 200ms ease, box-shadow 260ms ease; }
textarea.agm-code:focus { border-color: color-mix(in srgb, var(--agm-gold) 55%, transparent); box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.25), 0 0 0 4px var(--glass-gold-a10, var(--gt-gold-faint)); }
textarea.agm-code.is-dirty { border-color: color-mix(in srgb, var(--agm-warn) 55%, transparent); }
textarea.agm-code--sm { min-height: 120px; font-size: 11.5px; }
.agm-code-bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; font: 500 10.5px/1.4 var(--agm-mono); letter-spacing: 0.04em; color: var(--agm-faint); }
.agm-code-bar--top { margin: 0 0 8px; }
.agm-dirty { display: inline-flex; align-items: center; gap: 6px; color: var(--agm-warn); }
.agm-dirty::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.agm-file { margin-top: 12px; padding: 12px; border-radius: 14px; border: 1px solid var(--agm-line); background: color-mix(in srgb, var(--agm-fg) 2.5%, transparent); }
.agm-file-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.agm-file-path { font: 600 11.5px var(--agm-mono); color: var(--agm-gold-ink); overflow-wrap: anywhere; }
.agm-details { margin-top: 14px; border-radius: 12px; border: 1px solid var(--agm-line); background: color-mix(in srgb, var(--agm-fg) 2.5%, transparent); }
.agm-details > summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; font-size: 12px; color: var(--agm-dim); list-style: none; }
.agm-details > summary::-webkit-details-marker { display: none; }
.agm-details > summary svg { width: 14px; height: 14px; color: var(--agm-gold-ink); }
.agm-details > summary:hover { color: var(--agm-fg); }
.agm-details-body { padding: 0 14px 12px; font-size: 12px; line-height: 1.6; color: var(--agm-dim); }
.agm-details-body p { margin: 0 0 8px; }
.agm-details-body .agm-details-lead { margin: 0; }
.agm-details-body strong { color: var(--agm-fg); font-weight: 600; }
.agm-details-body code { font: 11px var(--agm-mono); padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--agm-fg) 7%, transparent); }

/* ── Rows (references / sessions) ──────────────────────────── */
.agm-rows { display: flex; flex-direction: column; gap: 6px; }
.agm-rows--scroll { max-height: 340px; overflow-y: auto; padding-right: 2px; }
.agm-row {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 9px 12px;
  border-radius: 11px; border: 1px solid var(--agm-line);
  background: color-mix(in srgb, var(--agm-fg) 3%, transparent);
  font-size: 12px;
  transition: border-color 200ms ease, background 200ms ease, transform 260ms var(--glass-ease, ease);
}
.agm-row:hover { border-color: color-mix(in srgb, var(--agm-gold) 30%, transparent); background: color-mix(in srgb, var(--agm-fg) 5%, transparent); }
.agm-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.agm-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--agm-fg); }
.agm-row-title.is-mono { font: 12px var(--agm-mono); }
.agm-row-title.is-idle { color: var(--agm-dim); }
.agm-row-sub { font: 10.5px var(--agm-mono); letter-spacing: 0.04em; color: var(--agm-faint); }
.agm-row-meta { flex: none; font: 10.5px var(--agm-mono); color: var(--agm-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
.agm-add { display: flex; gap: 8px; padding: 12px; margin-bottom: 14px; border-radius: 14px; border: 1px solid var(--agm-line); background: color-mix(in srgb, var(--agm-fg) 2.5%, transparent); }
.agm-add .gt-input { flex: 1; }

/* ── Compact empty state ───────────────────────────────────── */
.agm-ed .gt-empty { padding: 22px 12px; gap: 8px; }
.agm-ed .gt-empty-orb { width: 46px; height: 46px; border-radius: 15px; }
.agm-ed .gt-empty-orb svg { width: 20px; height: 20px; }
.agm-ed .gt-empty-title { font-size: 13.5px; }

/* ── Modal (New agent + config popup) ──────────────────────── */
.agm-modal-scrim {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: radial-gradient(ellipse 60% 50% at 50% 40%, color-mix(in srgb, var(--agm-gold) 8%, transparent), transparent 70%), rgba(4, 4, 6, 0.62);
  -webkit-backdrop-filter: blur(8px) saturate(120%);
  backdrop-filter: blur(8px) saturate(120%);
  animation: agm-fade 220ms ease both;
}
.agm-modal-scrim.agm-popup { z-index: 2000; }
:root[data-theme="light"] .agm-modal-scrim { background: radial-gradient(ellipse 60% 50% at 50% 40%, color-mix(in srgb, var(--agm-gold) 10%, transparent), transparent 70%), rgba(40, 32, 18, 0.28); }
.agm-modal {
  position: relative; display: flex; flex-direction: column;
  width: min(560px, 100%); max-height: min(88vh, 860px);
  border-radius: var(--glass-radius-xl, 24px);
  background: var(--glass-sheen, none), var(--glass-4, rgba(18, 17, 15, 0.9));
  box-shadow: var(--glass-elev-4, 0 40px 90px -30px rgba(0, 0, 0, 0.8)), 0 0 80px -30px color-mix(in srgb, var(--agm-gold) 45%, transparent);
  color: var(--agm-fg);
  animation: agm-pop 420ms var(--glass-spring, ease) both;
}
.agm-modal--wide { width: min(640px, 100%); }
/* gold hairline edge */
.agm-modal::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
  background: var(--glass-edge, linear-gradient(160deg, color-mix(in srgb, var(--agm-gold) 55%, transparent), transparent));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
}
/* specular top edge */
.agm-modal::after {
  content: ""; position: absolute; left: 12%; right: 12%; top: 0; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.6), transparent); opacity: 0.6;
}
.agm-modal-head { display: flex; align-items: flex-start; gap: 14px; padding: 22px 22px 16px; }
.agm-modal-orb {
  flex: none; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 14px;
  color: var(--agm-gold-ink); font: 700 14px/1 var(--glass-font, inherit); letter-spacing: 0.02em;
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--agm-gold) 32%, transparent), color-mix(in srgb, var(--agm-gold) 7%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agm-gold) 34%, transparent), 0 14px 32px -14px color-mix(in srgb, var(--agm-gold) 60%, transparent);
}
.agm-modal-orb svg { width: 20px; height: 20px; }
.agm-modal-titles { flex: 1; min-width: 0; }
.agm-modal-titles .gt-eyebrow { font-size: 9.5px; }
.agm-modal-title {
  margin: 8px 0 4px; font-size: 21px; line-height: 1.15; font-weight: 650; letter-spacing: -0.022em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--agm-fg);
}
.agm-modal-sub { margin: 0; font-size: 12.5px; color: var(--agm-dim); }
.agm-modal-sub code { font: 11.5px var(--agm-mono); color: var(--agm-gold-ink); }
.agm-modal-close {
  flex: none; width: 32px; height: 32px; display: grid; place-items: center; padding: 0;
  border-radius: 10px; border: 1px solid var(--agm-line); cursor: pointer;
  background: color-mix(in srgb, var(--agm-fg) 4%, transparent); color: var(--agm-dim);
  transition: color 160ms ease, border-color 160ms ease, transform 160ms ease, background 160ms ease;
}
.agm-modal-close:hover { color: var(--agm-fg); border-color: color-mix(in srgb, var(--agm-gold) 35%, transparent); }
.agm-modal-close:active { transform: scale(0.94); }
.agm-modal-close:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-modal-close svg { width: 15px; height: 15px; }
.agm-modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 22px 18px; }
.agm-modal-body--flush { padding-top: 4px; }
.agm-modal-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  padding: 14px 22px 18px; border-top: 1px solid var(--agm-line);
}
.agm-modal-foot .agm-foot-note { flex: 1; min-width: 0; font-size: 11.5px; color: var(--agm-faint); }
.agm-error {
  display: flex; align-items: flex-start; gap: 8px; margin-bottom: 14px; padding: 10px 12px; border-radius: 12px;
  font-size: 12.5px; line-height: 1.45; color: var(--agm-bad);
  border: 1px solid color-mix(in srgb, var(--agm-bad) 35%, transparent);
  background: color-mix(in srgb, var(--agm-bad) 9%, transparent);
}
.agm-error .gt-light { margin-top: 4px; }

/* Native / CLI choice cards */
.agm-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.agm-choice {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  padding: 12px 14px; border-radius: 14px; cursor: pointer; text-align: left;
  border: 1px solid var(--agm-line); background: color-mix(in srgb, var(--agm-fg) 3%, transparent);
  color: var(--agm-dim); font: inherit;
  transition: border-color 200ms ease, background 200ms ease, transform 320ms var(--glass-spring, ease), box-shadow 300ms ease;
}
.agm-choice:hover { border-color: color-mix(in srgb, var(--agm-gold) 32%, transparent); color: var(--agm-fg); transform: translateY(-1px); }
.agm-choice:active { transform: scale(0.98); }
.agm-choice:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-choice b { display: inline-flex; align-items: center; gap: 8px; font: 650 12px/1 var(--agm-mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--agm-fg); }
.agm-choice span { font-size: 11.5px; color: var(--agm-faint); }
.agm-choice[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--agm-gold) 50%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--agm-gold) 14%, transparent), color-mix(in srgb, var(--agm-gold) 4%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 10px 26px -16px color-mix(in srgb, var(--agm-gold) 80%, transparent);
}
.agm-choice[aria-pressed="true"] b { color: var(--agm-gold-ink); }

/* Popup tabs (segmented, scrolls on phones) */
.agm-tabs { display: flex; gap: 4px; margin: 0 22px 4px; padding: 3px; border-radius: 999px; overflow-x: auto; scrollbar-width: none;
  background: color-mix(in srgb, var(--agm-fg) 4%, transparent); border: 1px solid var(--agm-line); flex: none; }
.agm-tabs::-webkit-scrollbar { display: none; }
.agm-tabs button {
  flex: 1 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border: 0; border-radius: 999px; cursor: pointer; white-space: nowrap;
  background: transparent; color: var(--agm-dim); font: 550 12px/1 var(--glass-font, inherit);
  transition: color 200ms ease, background 260ms var(--glass-ease, ease), box-shadow 260ms ease;
}
.agm-tabs button svg { width: 13px; height: 13px; }
.agm-tabs button:hover { color: var(--agm-fg); }
.agm-tabs button[aria-selected="true"] {
  color: var(--agm-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--agm-gold) 22%, transparent), color-mix(in srgb, var(--agm-gold) 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agm-gold) 40%, transparent), 0 4px 14px -6px color-mix(in srgb, var(--agm-gold) 60%, transparent);
}
.agm-tabs button[aria-selected="true"] svg { color: var(--agm-gold-ink); }
.agm-tabs button:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-modal .agm-ed { padding: 14px 0 4px; }

/* Agent picker list */
.agm-pick { display: grid; gap: 8px; }
.agm-pick-item {
  display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; text-align: left; cursor: pointer;
  border-radius: 14px; border: 1px solid var(--agm-line); background: color-mix(in srgb, var(--agm-fg) 3%, transparent);
  color: var(--agm-fg); font: inherit;
  transition: border-color 200ms ease, background 200ms ease, transform 360ms var(--glass-spring, ease), box-shadow 360ms ease;
}
.agm-pick-item:hover { border-color: color-mix(in srgb, var(--agm-gold) 36%, transparent); background: color-mix(in srgb, var(--agm-fg) 5%, transparent); transform: translateY(-2px); box-shadow: 0 14px 30px -18px color-mix(in srgb, var(--agm-gold) 60%, transparent); }
.agm-pick-item:active { transform: scale(0.985); }
.agm-pick-item:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--agm-gold)); }
.agm-mono-av {
  flex: none; width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px;
  font: 700 12.5px/1 var(--glass-font, inherit); letter-spacing: 0.02em; color: var(--agm-gold-ink);
  background: linear-gradient(140deg, color-mix(in srgb, var(--agm-gold) 26%, transparent), color-mix(in srgb, var(--agm-gold) 6%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agm-gold) 30%, transparent);
}
.agm-pick-arrow { flex: none; color: var(--agm-faint); transition: transform 260ms var(--glass-spring, ease), color 200ms ease; }
.agm-pick-arrow svg { width: 15px; height: 15px; }
.agm-pick-item:hover .agm-pick-arrow { color: var(--agm-gold-ink); transform: translateX(3px); }

@keyframes agm-fade { from { opacity: 0; } }
@keyframes agm-pop { from { opacity: 0; transform: translateY(14px) scale(0.97); } }

/* ── Phones ────────────────────────────────────────────────── */
@media (max-width: 640px) {
  .agm-ed { padding: 12px 12px 14px; }
  .agm-row2, .agm-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .agm-check-grid, .agm-check-grid--wide { grid-template-columns: minmax(0, 1fr); }
  .agm-modal-scrim { align-items: flex-end; padding: 0; }
  .agm-modal { width: 100%; max-height: 92dvh; border-radius: 24px 24px 0 0; }
  .agm-modal-head { padding: 18px 16px 12px; }
  .agm-modal-body { padding: 4px 16px 16px; }
  .agm-modal-foot { padding: 12px 16px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .agm-tabs { margin: 0 16px 4px; }
  .agm-add { flex-direction: column; }
}

/* ── Fallbacks ─────────────────────────────────────────────── */
:root.perf-mode .agm-modal-scrim { -webkit-backdrop-filter: none; backdrop-filter: none; }
:root.perf-mode .agm-modal { background: var(--glass-solid, #121110); }
:root.perf-mode .agm-modal-scrim,
:root.perf-mode .agm-modal { animation: none !important; }
:root.perf-mode .agm-check,
:root.perf-mode .agm-choice,
:root.perf-mode .agm-pick-item,
:root.perf-mode .agm-row,
:root.perf-mode .agm-switch,
:root.perf-mode .agm-switch::after,
:root.perf-mode .agm-modal-close { transition: none !important; }
:root.perf-mode .agm-choice:hover,
:root.perf-mode .agm-pick-item:hover { transform: none; }
@media (prefers-reduced-transparency: reduce) {
  .agm-modal-scrim { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
  .agm-modal { background: var(--glass-solid, #121110) !important; }
}
@media (prefers-reduced-motion: reduce) {
  .agm-modal-scrim, .agm-modal { animation: none !important; }
  .agm-check, .agm-choice, .agm-pick-item, .agm-row, .agm-switch, .agm-switch::after, .agm-modal-close { transition: none !important; }
  .agm-choice:hover, .agm-pick-item:hover { transform: none; }
}
`;
