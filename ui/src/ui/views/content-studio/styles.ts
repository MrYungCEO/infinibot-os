/**
 * Content Studio stylesheet (light DOM, injected once into document.head).
 * Every selector is under `.cs-shell` / `cs-*` so nothing leaks into core UI.
 * Colours ride the theme tokens the content-pages hub uses (`--g-primary`,
 * `--text`, `--danger`), with the hub's gold-on-glass fallbacks.
 */

const CSS = `
.cs-shell {
  --cs-gold: var(--g-primary, #caa45a);
  --cs-text: var(--text, #f2efe8);
  --cs-dim: color-mix(in srgb, var(--cs-text) 58%, transparent);
  --cs-faint: color-mix(in srgb, var(--cs-text) 34%, transparent);
  --cs-meta: color-mix(in srgb, var(--cs-text) 80%, transparent);
  --cs-line: rgba(255,255,255,0.08);
  --cs-line-gold: color-mix(in srgb, var(--cs-gold) 26%, transparent);
  --cs-glass: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015));
  --cs-panel: rgba(14,13,11,0.72);
  --cs-danger: var(--danger, #ef6b5b);
  --cs-ok: var(--ok, #4ade80);
  --cs-radius: 14px;
  /* 1 viewport-height unit in this subtree's CSS px, and the chrome above +
     below the board. Re-derived under the desktop body zoom (viewport-scale.css). */
  --cs-vh: 1dvh;
  --cs-col-offset: 276px;
  display: flex; flex-direction: column; gap: 14px;
  min-height: 100%; padding: 18px 22px 40px; box-sizing: border-box;
  color: var(--cs-text); font-family: var(--font-body, Inter, system-ui, sans-serif);
}
.cs-shell *, .cs-shell *::before, .cs-shell *::after { box-sizing: border-box; }
.cs-shell button { font: inherit; }

/* ── Header + tabs ─────────────────────────────────────────── */
.cs-shell-head { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.cs-brand { display:flex; align-items:center; gap:12px; }
.cs-brand-mark {
  width:40px; height:40px; border-radius:11px; display:grid; place-items:center;
  font: 700 13px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing:.06em; color:#0b0a08;
  background: linear-gradient(140deg, color-mix(in srgb, var(--cs-gold) 85%, #fff), var(--cs-gold));
  box-shadow: 0 8px 22px -10px var(--cs-gold), inset 0 1px 0 rgba(255,255,255,.4);
}
.cs-brand h1 { margin:0; font-size:20px; font-weight:700; letter-spacing:-.01em; }
.cs-brand p { margin:2px 0 0; font-size:12.5px; color: var(--cs-dim); }
.cs-tabs { display:inline-flex; gap:4px; padding:4px; border-radius:12px; background: var(--cs-panel); border:1px solid var(--cs-line); }
.cs-tab {
  appearance:none; border:0; background:transparent; color: var(--cs-dim); cursor:pointer;
  padding:8px 16px; border-radius:9px; font-size:13px; font-weight:600; display:inline-flex; gap:8px; align-items:center;
  min-height:36px; transition: background .15s, color .15s;
}
.cs-tab:hover { color: var(--cs-text); background: rgba(255,255,255,0.04); }
.cs-tab.is-on { color:#0b0a08; background: linear-gradient(180deg, color-mix(in srgb, var(--cs-gold) 88%, #fff), var(--cs-gold)); }
.cs-tab-badge { font-size:11px; padding:1px 7px; border-radius:99px; background: rgba(0,0,0,.18); }
.cs-tab:not(.is-on) .cs-tab-badge { background: rgba(255,255,255,.07); color: var(--cs-text); }
.cs-shell-body { flex:1; min-height:0; display:flex; flex-direction:column; }
.cs-shell-body > content-pages-hub { margin: -20px -24px 0; }

/* ── Shared controls ──────────────────────────────────────── */
.cs-btn {
  appearance:none; cursor:pointer; border-radius:9px; padding:8px 14px; font-size:13px; font-weight:600;
  display:inline-flex; align-items:center; gap:6px; min-height:36px; white-space:nowrap; transition: filter .15s, background .15s, border-color .15s;
}
.cs-btn-primary { border:0; color:#0b0a08; background: linear-gradient(180deg, color-mix(in srgb, var(--cs-gold) 82%, #fff), var(--cs-gold)); box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--cs-gold) 70%, transparent); }
.cs-btn-primary:hover { filter: brightness(1.07); }
.cs-btn-ghost { background: rgba(255,255,255,0.035); color: var(--cs-text); border:1px solid var(--cs-line); }
.cs-btn-ghost:hover, .cs-btn-ghost.is-on { border-color: var(--cs-line-gold); background: color-mix(in srgb, var(--cs-gold) 9%, transparent); }
.cs-btn-danger { border:0; background: var(--cs-danger); color:#fff; }
.cs-danger { color: var(--cs-danger) !important; }
.cs-link { background:none; border:0; color: var(--cs-gold); cursor:pointer; text-decoration: underline; padding:0 4px; }
.cs-input, .cs-select {
  background: rgba(255,255,255,0.04); border:1px solid var(--cs-line); color: var(--cs-text);
  border-radius:9px; padding:8px 11px; font-size:13px; min-height:36px; outline:none;
}
.cs-input:focus, .cs-select:focus { border-color: color-mix(in srgb, var(--cs-gold) 60%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cs-gold) 14%, transparent); }
.cs-select option { background:#16140f; color: var(--cs-text); }
.cs-icon-btn { appearance:none; border:0; background:transparent; color: var(--cs-dim); cursor:pointer; width:28px; height:28px; border-radius:7px; font-size:16px; line-height:1; display:grid; place-items:center; }
.cs-icon-btn:hover { background: rgba(255,255,255,0.07); color: var(--cs-text); }
.cs-error { padding:10px 14px; border-radius:10px; border:1px solid color-mix(in srgb, var(--cs-danger) 45%, transparent); background: color-mix(in srgb, var(--cs-danger) 12%, transparent); color: color-mix(in srgb, var(--cs-danger) 70%, #fff); font-size:13px; }
.cs-chip { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:600; letter-spacing:.02em; padding:2px 8px; border-radius:99px; background: rgba(255,255,255,0.06); color: var(--cs-dim); text-transform: lowercase; }
.cs-chip-plat { color: var(--cs-text); background: color-mix(in srgb, var(--cs-gold) 16%, transparent); }
.cs-chip-plat[data-p=instagram] { background: rgba(225,48,108,.2); }
.cs-chip-plat[data-p=tiktok] { background: rgba(37,244,238,.16); }
.cs-chip-plat[data-p=youtube] { background: rgba(255,0,0,.2); }
.cs-chip-plat[data-p=linkedin] { background: rgba(10,102,194,.28); }
.cs-chip-ok { background: color-mix(in srgb, var(--cs-ok) 18%, transparent); color: var(--cs-ok); }
.cs-due.soon { background: rgba(245,158,11,.2); color:#fbbf24; }
.cs-due.late { background: color-mix(in srgb, var(--cs-danger) 22%, transparent); color: color-mix(in srgb, var(--cs-danger) 75%, #fff); }
.cs-skel { height:64px; border-radius:12px; margin:8px 0; background: linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,255,255,.07), rgba(255,255,255,.03)); background-size:200% 100%; animation: cs-shimmer 1.4s linear infinite; }
@keyframes cs-shimmer { to { background-position: -200% 0; } }

/* ── Board ───────────────────────────────────────────────── */
content-studio-shell { display:block; min-width:0; }
cs-pipeline-board { display:flex; flex-direction:column; min-height:0; min-width:0; flex:1; }
.cs-board-wrap { display:flex; flex-direction:column; gap:12px; min-height:0; min-width:0; flex:1; }
.cs-board-loading { padding:40px; text-align:center; color: var(--cs-dim); }
.cs-board-bar { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.cs-kpis { display:grid; grid-template-columns: repeat(4, minmax(112px, 1fr)); gap:10px; flex: 1 1 520px; max-width: 720px; }
.cs-kpi { font: 700 20px/1.1 var(--font-body, Inter, system-ui, sans-serif); color: var(--cs-text); letter-spacing:-.01em; }
.cs-kpi small { font-size:11px; font-weight:500; color: var(--cs-dim); }
.cs-board-tools { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.cs-search { width: 210px; }
.cs-board {
  /* Columns grow to fill the board and shrink to 180px so all six default
     stages fit at 1440px; past that the board scrolls sideways. */
  display:flex; gap:10px; overflow-x:auto; overflow-y:hidden; padding: 4px 2px 12px; min-width:0;
  align-items: flex-start; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-color: color-mix(in srgb, var(--cs-gold) 35%, transparent) transparent;
}
.cs-col {
  --stage: var(--cs-gold);
  /* Fixed viewport-tall column: header stays put, .cs-col-body scrolls. */
  position:relative; flex: 1 0 180px; max-width: 340px; display:flex; flex-direction:column; min-height:0;
  height: max(380px, calc(100 * var(--cs-vh) - var(--cs-col-offset)));
  border-radius: var(--cs-radius); background: var(--cs-glass), var(--cs-panel);
  border:1px solid var(--cs-line); scroll-snap-align: start;
  transition: border-color .15s, box-shadow .15s, opacity .15s, transform .15s;
}
.cs-col::before { content:""; position:absolute; inset:0 0 auto; height:3px; border-radius: var(--cs-radius) var(--cs-radius) 0 0; background: var(--stage); opacity:.9; }
.cs-col.is-over { border-color: color-mix(in srgb, var(--stage) 65%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--stage) 40%, transparent), 0 14px 40px -18px var(--stage); }
.cs-col.is-over-wip { border-color: color-mix(in srgb, var(--cs-danger) 55%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--cs-danger) 9%, transparent), transparent 40%), var(--cs-panel); }
.cs-col.is-dragging { opacity:.45; }
.cs-col.drop-before { box-shadow: -4px 0 0 0 var(--cs-gold); }
.cs-col.drop-after { box-shadow: 4px 0 0 0 var(--cs-gold); }
.cs-col-head { position:relative; display:flex; align-items:center; gap:8px; padding:14px 10px 8px 14px; cursor:grab; user-select:none; }
.cs-col-head:active { cursor:grabbing; }
.cs-col-dot { width:9px; height:9px; border-radius:50%; background: var(--stage); box-shadow: 0 0 10px var(--stage); flex:none; }
.cs-col-name { margin:0; font-size:13.5px; font-weight:700; letter-spacing:.01em; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cs-done-mark { margin-left:6px; color: var(--cs-ok); font-size:12px; }
.cs-col-rename { flex:1; min-width:0; background: rgba(0,0,0,.35); color: var(--cs-text); border:1px solid color-mix(in srgb, var(--cs-gold) 55%, transparent); border-radius:7px; padding:4px 8px; font: 700 13px/1.2 inherit; outline:none; }
.cs-col-count { font: 600 12px/1 "JetBrains Mono", ui-monospace, monospace; padding:4px 8px; border-radius:99px; background: rgba(255,255,255,.06); color: var(--cs-dim); }
.cs-col-count.is-over { background: color-mix(in srgb, var(--cs-danger) 24%, transparent); color: color-mix(in srgb, var(--cs-danger) 70%, #fff); }
.cs-wip-of { opacity:.7; }
.cs-wip-bar { height:3px; margin: 0 14px 6px; border-radius:99px; background: rgba(255,255,255,.07); overflow:hidden; }
.cs-wip-bar span { display:block; height:100%; background: var(--stage); border-radius:inherit; transition: width .3s; }
.cs-col.is-over-wip .cs-wip-bar span { background: var(--cs-danger); }
.cs-wip-warn { margin: 0 12px 6px; font-size:11px; color: color-mix(in srgb, var(--cs-danger) 70%, #fff); }
.cs-col-head, .cs-wip-bar, .cs-wip-warn, .cs-col-foot, .cs-quick-add { flex-shrink:0; }
.cs-col-body {
  flex:1 1 0; min-height:0; overflow-y:auto; overflow-x:hidden; overscroll-behavior-y:contain; padding: 4px 10px 8px;
  display:flex; flex-direction:column; gap:8px;
  scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--stage) 45%, transparent) transparent;
}
/* Cards keep their natural height inside the scrolling body — never squash. */
.cs-col-body > .cs-card, .cs-col-body > .cs-drop-line, .cs-col-body > .cs-col-empty { flex-shrink:0; }
.cs-col-empty { border:1.5px dashed var(--cs-line); border-radius:12px; padding:22px 10px; text-align:center; font-size:12px; color: var(--cs-faint); transition: all .15s; }
.cs-col-empty.is-active { border-color: color-mix(in srgb, var(--stage) 70%, transparent); color: var(--cs-text); background: color-mix(in srgb, var(--stage) 8%, transparent); }
.cs-col-foot { appearance:none; margin: 0 10px 10px; padding:9px; border-radius:10px; border:1px dashed transparent; background:transparent; color: var(--cs-dim); cursor:pointer; text-align:left; font-size:12.5px; }
.cs-col-foot:hover { border-color: var(--cs-line); color: var(--cs-text); background: rgba(255,255,255,.03); }
.cs-col-add { flex: 0 0 44px; writing-mode: vertical-rl; padding: 14px 0; border-radius: var(--cs-radius); border:1.5px dashed var(--cs-line); background: transparent; color: var(--cs-dim); cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; font-size:13px; font-weight:600; max-height: 160px; }
.cs-col-add span { font-size:24px; color: var(--cs-gold); }
.cs-col-add:hover { border-color: var(--cs-line-gold); color: var(--cs-text); }
.cs-quick-add { display:flex; gap:6px; align-items:center; margin: 0 10px 10px; }
.cs-quick-add .cs-input { flex:1; min-width:0; }
.cs-drop-line { height:3px; border-radius:99px; background: var(--cs-gold); box-shadow: 0 0 10px var(--cs-gold); margin: -2px 2px; }

/* card */
.cs-card {
  position:relative; border-radius:12px; overflow:hidden; cursor:grab; outline:none;
  background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.025)); border:1px solid var(--cs-line);
  box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 6px 16px -10px rgba(0,0,0,.7);
  transition: transform .12s, border-color .12s, box-shadow .12s, opacity .12s; contain: layout paint;
}
.cs-card:hover, .cs-card:focus-visible { border-color: color-mix(in srgb, var(--stage) 55%, transparent); transform: translateY(-1px); box-shadow: 0 10px 24px -14px var(--stage); }
.cs-card.is-dragging { opacity:.35; transform: scale(.98); }
.cs-card-cover { position:relative; aspect-ratio: 16/9; background:#000; overflow:hidden; }
.cs-card-cover img, .cs-card-cover video { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
.cs-play { position:absolute; inset:0; margin:auto; width:34px; height:34px; border-radius:50%; display:grid; place-items:center; font-size:12px; color:#fff; background: rgba(0,0,0,.55); border:1px solid rgba(255,255,255,.35); pointer-events:none; }
.cs-card-body { padding:10px 12px 9px; display:flex; flex-direction:column; gap:6px; }
.cs-card-chips { display:flex; gap:5px; flex-wrap:wrap; }
.cs-card-chips:empty { display:none; }
.cs-card-title { margin:0; font-size:13.5px; font-weight:650; line-height:1.35; color: var(--cs-text); overflow-wrap:anywhere; }
.cs-card-sum { margin:0; font-size:12px; line-height:1.45; color: color-mix(in srgb, var(--cs-text) 74%, transparent); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.cs-card-tags { display:flex; gap:6px; flex-wrap:wrap; font-size:11.5px; color: color-mix(in srgb, var(--cs-gold) 70%, #fff); }
.cs-card-foot { display:flex; gap:12px; align-items:center; font: 500 11.5px/1.2 "JetBrains Mono", ui-monospace, monospace; color: var(--cs-meta); padding-top:2px; }
.cs-age { margin-left:auto; }

/* stage menu + modal */
.cs-menu { position:absolute; top: 40px; right: 8px; z-index: 30; width: 232px; padding:6px; border-radius:12px; background: rgba(20,18,15,.98); border:1px solid var(--cs-line-gold); box-shadow: 0 18px 50px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:2px; cursor:default; }
.cs-menu > button, .cs-menu-row > button { appearance:none; border:0; background:transparent; color: var(--cs-text); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; font-size:13px; }
.cs-menu > button:hover, .cs-menu-row > button:hover:not(:disabled) { background: color-mix(in srgb, var(--cs-gold) 14%, transparent); }
.cs-menu button:disabled { opacity:.35; cursor:not-allowed; }
.cs-menu-row { display:flex; gap:4px; flex-wrap:wrap; padding:4px 6px; }
.cs-menu-row > button { flex:1; text-align:center; }
.cs-swatch { appearance:none; width:22px !important; height:22px; flex:none !important; padding:0 !important; border-radius:50% !important; border:2px solid transparent !important; cursor:pointer; }
.cs-swatch.is-on { border-color:#fff !important; }
.cs-menu-field { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; font-size:12.5px; color: var(--cs-dim); }
.cs-menu-field .cs-input { width:84px; min-height:30px; padding:4px 8px; }
.cs-menu-check { display:flex; align-items:center; gap:8px; padding:6px 10px; font-size:12.5px; color: var(--cs-dim); cursor:pointer; }
.cs-modal-back { position:fixed; inset:0; z-index: 1000; background: rgba(0,0,0,.55); display:grid; place-items:center; padding:16px; }
.cs-modal { width:min(420px, 100%); padding:20px; border-radius:16px; background:#15130f; border:1px solid var(--cs-line-gold); box-shadow: 0 30px 80px rgba(0,0,0,.6); }
.cs-modal h3 { margin:0 0 8px; font-size:16px; }
.cs-modal p { margin:0 0 12px; color: var(--cs-dim); font-size:13px; }
.cs-modal .cs-select { width:100%; }
.cs-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }

/* ── Page view ───────────────────────────────────────────── */
cs-page-view { display:flex; flex-direction:column; min-height:0; flex:1; }
.cs-page { display:flex; flex-direction:column; gap:10px; min-height:0; flex:1; }
.cs-page-top { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.cs-crumbs { display:flex; align-items:center; gap:8px; font-size:13px; color: var(--cs-dim); }
.cs-crumb-sep { opacity:.5; }
.cs-stage-pill { --stage: var(--cs-gold); padding:3px 10px; border-radius:99px; font-size:12px; font-weight:600; color: var(--cs-text); background: color-mix(in srgb, var(--stage) 20%, transparent); border:1px solid color-mix(in srgb, var(--stage) 45%, transparent); }
.cs-spacer { flex:1; }
.cs-field-inline { display:flex; align-items:center; gap:8px; font-size:12px; color: var(--cs-dim); }
.cs-page-grid { display:grid; grid-template-columns: minmax(0, 1fr) 300px; gap:14px; min-height:0; flex:1; }
.cs-page-main { display:flex; flex-direction:column; min-height: 560px; border-radius: var(--cs-radius); border:1px solid var(--cs-line); background: var(--cs-panel); overflow:hidden; }
.cs-doc-head { padding: 22px 28px 12px; display:flex; flex-direction:column; gap:10px; border-bottom:1px solid var(--cs-line); background: radial-gradient(800px 200px at 0% 0%, color-mix(in srgb, var(--cs-gold) 7%, transparent), transparent 70%); }
.cs-title-input { width:100%; background:transparent; border:0; outline:none; color: var(--cs-text); font: 800 26px/1.2 var(--font-body, Inter, system-ui, sans-serif); letter-spacing:-.02em; padding:2px 0; }
.cs-title-input:focus { box-shadow: 0 2px 0 0 color-mix(in srgb, var(--cs-gold) 55%, transparent); }
.cs-summary-input { width:100%; background:transparent; border:0; outline:none; color: var(--cs-dim); font-size:14px; padding:2px 0; }
.cs-idea-title-row { display:flex; align-items:center; gap:10px; }
.cs-icon-input { width:46px; height:46px; text-align:center; font-size:24px; border-radius:12px; border:1px solid var(--cs-line); background: rgba(255,255,255,.04); color: var(--cs-text); outline:none; flex:none; }
.cs-props { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; }
.cs-prop { display:flex; align-items:center; gap:8px; font-size:12px; color: var(--cs-faint); text-transform: uppercase; letter-spacing:.06em; }
.cs-prop .cs-select, .cs-prop .cs-input { min-height:32px; padding:5px 9px; text-transform:none; letter-spacing:0; }
.cs-prop-tags { flex: 1 1 260px; }
.cs-tags { display:flex; flex-wrap:wrap; gap:6px; align-items:center; text-transform:none; letter-spacing:0; }
.cs-tag { display:inline-flex; align-items:center; gap:2px; padding:3px 4px 3px 9px; border-radius:99px; font-size:12px; color: var(--cs-text); background: color-mix(in srgb, var(--cs-gold) 15%, transparent); }
.cs-tag button { appearance:none; border:0; background:transparent; color: var(--cs-dim); cursor:pointer; padding:0 4px; font-size:14px; line-height:1; }
.cs-tag-input { width:90px; background:transparent; border:0; border-bottom:1px dashed var(--cs-line); color: var(--cs-text); outline:none; font-size:12px; padding:3px 2px; }
.cs-meta-line { font-size:12px; color: var(--cs-faint); }
.cs-editor-host { flex:1; min-height: 420px; display:flex; flex-direction:column; }
.cs-editor-host.rd-host .rd-toolbar { position: sticky; top:0; }
.cs-editor-host .rd-page { padding-top: 22px; }
.cs-editor-host .rd-doc { padding: 0 32px; max-width: 860px; }
.cs-page-danger { display:flex; justify-content:flex-end; padding-top:10px; }

/* media rail */
.cs-rail { display:flex; flex-direction:column; gap:10px; padding:14px; border-radius: var(--cs-radius); border:1px solid var(--cs-line); background: var(--cs-panel); align-self:start; position: sticky; top: 8px; max-height: calc(100vh - 140px); overflow:auto; transition: border-color .15s, background .15s; }
.cs-rail.is-drop { border-color: color-mix(in srgb, var(--cs-gold) 70%, transparent); background: color-mix(in srgb, var(--cs-gold) 7%, var(--cs-panel)); }
.cs-rail-head { display:flex; align-items:center; justify-content:space-between; }
.cs-eyebrow { font: 700 10.5px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing:.16em; text-transform:uppercase; color: var(--cs-gold); }
.cs-count { font: 600 11px/1 "JetBrains Mono", ui-monospace, monospace; color: var(--cs-dim); }
.cs-dropzone { appearance:none; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:4px; padding:18px 10px; border-radius:12px; border:1.5px dashed var(--cs-line-gold); background: rgba(255,255,255,.02); color: var(--cs-text); font-size:12.5px; }
.cs-dropzone:hover { background: color-mix(in srgb, var(--cs-gold) 8%, transparent); }
.cs-dropzone small { color: var(--cs-faint); font-size:11px; }
.cs-dropzone-ic { font-size:22px; color: var(--cs-gold); }
.cs-rail-actions { display:flex; gap:6px; }
.cs-rail-actions .cs-btn { flex:1; justify-content:center; min-height:32px; padding:6px 10px; font-size:12px; }
.cs-busy { font-size:12px; color: var(--cs-gold); padding:6px 8px; border-radius:8px; background: color-mix(in srgb, var(--cs-gold) 9%, transparent); animation: rd-pulse 1.4s ease-in-out infinite; }
.cs-media-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
.cs-media-tile { position:relative; margin:0; border-radius:10px; overflow:hidden; border:1px solid var(--cs-line); background:#000; }
.cs-media-tile img, .cs-media-tile video { width:100%; aspect-ratio: 1; object-fit:cover; display:block; }
.cs-media-tile[data-kind=audio] { grid-column: 1 / -1; background: rgba(255,255,255,.03); }
.cs-audio-tile { display:flex; align-items:center; gap:8px; padding:10px; }
.cs-audio-tile span { font-size:20px; color: var(--cs-gold); }
.cs-audio-tile audio { flex:1; min-width:0; height:32px; }
.cs-media-tile figcaption { position:absolute; inset:auto 0 0; padding:14px 7px 5px; font-size:10.5px; color:#fff; background: linear-gradient(transparent, rgba(0,0,0,.8)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cs-media-tile[data-kind=audio] figcaption { position:static; background:none; color: var(--cs-dim); padding: 0 10px 8px; }
.cs-cover-badge { display:inline-block; margin-right:5px; padding:1px 6px; border-radius:99px; background: var(--cs-gold); color:#0b0a08; font-weight:700; font-size:9.5px; }
.cs-tile-actions { position:absolute; top:5px; right:5px; display:flex; gap:4px; opacity:0; transition: opacity .15s; }
.cs-media-tile:hover .cs-tile-actions, .cs-media-tile:focus-within .cs-tile-actions { opacity:1; }
.cs-tile-actions button { appearance:none; width:26px; height:26px; border-radius:7px; border:1px solid rgba(255,255,255,.2); background: rgba(0,0,0,.65); color:#fff; cursor:pointer; font-size:13px; display:grid; place-items:center; }
.cs-tile-actions button:hover { background: var(--cs-gold); color:#0b0a08; }
.cs-rail-empty { margin:0; font-size:12px; line-height:1.5; color: var(--cs-faint); }

/* ── Ideas ───────────────────────────────────────────────── */
cs-ideas-area { display:flex; flex-direction:column; flex:1; min-height:0; }
.cs-ideas { display:grid; grid-template-columns: 320px minmax(0, 1fr); gap:14px; flex:1; min-height:0; }
.cs-ideas-list { display:flex; flex-direction:column; gap:6px; padding:12px; border-radius: var(--cs-radius); border:1px solid var(--cs-line); background: var(--cs-panel); align-self:start; max-height: calc(100vh - 170px); overflow:auto; position: sticky; top: 8px; }
.cs-ideas-head { display:flex; gap:8px; margin-bottom:4px; }
.cs-ideas-head .cs-input { flex:1; min-width:0; }
.cs-idea-row { appearance:none; position:relative; display:flex; gap:10px; align-items:flex-start; width:100%; text-align:left; padding:10px; border-radius:11px; border:1px solid transparent; background:transparent; color: var(--cs-text); cursor:pointer; }
.cs-idea-row:hover { background: rgba(255,255,255,.035); }
.cs-idea-row.is-on { background: color-mix(in srgb, var(--cs-gold) 11%, transparent); border-color: var(--cs-line-gold); }
.cs-idea-ic { font-size:20px; line-height:1.2; flex:none; }
.cs-idea-txt { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
.cs-idea-title { font-weight:650; font-size:13.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cs-pin { color: var(--cs-gold); margin-right:5px; }
.cs-idea-ex { font-size:12px; color: var(--cs-dim); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4; }
.cs-idea-meta { font-size:11px; color: var(--cs-faint); display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.cs-idea-del { position:absolute; top:6px; right:6px; width:22px; height:22px; border-radius:6px; display:grid; place-items:center; color: var(--cs-faint); opacity:0; }
.cs-idea-row:hover .cs-idea-del, .cs-idea-del:focus { opacity:1; }
.cs-idea-del:hover { color: var(--cs-danger); background: rgba(255,255,255,.06); }
.cs-ideas-empty { display:flex; flex-direction:column; gap:10px; align-items:flex-start; padding:16px 8px; font-size:13px; color: var(--cs-dim); line-height:1.5; }
.cs-ideas-empty b { color: var(--cs-text); }
.cs-ideas-page { min-width:0; display:flex; flex-direction:column; }
.cs-ideas-placeholder { flex:1; min-height: 360px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border-radius: var(--cs-radius); border:1.5px dashed var(--cs-line); color: var(--cs-faint); }
.cs-ideas-placeholder span { font-size:34px; color: var(--cs-gold); }
.cs-ideas .cs-page-grid { grid-template-columns: minmax(0, 1fr) 260px; }

/* ── Responsive ──────────────────────────────────────────── */
/* body is zoomed (default 0.7) at these widths and viewport units ignore zoom,
   so divide them back out or the columns stop at 70% of the window. */
@media (min-width: 1101px) and (max-width: 1680px) {
  .cs-shell { --cs-vh: calc(1dvh / var(--ui-viewport-zoom, 0.7)); --cs-col-offset: 372px; }
}
:root[data-viewport-scale="off"] .cs-shell { --cs-vh: 1dvh; --cs-col-offset: 276px; }
@media (max-width: 1180px) {
  .cs-page-grid, .cs-ideas .cs-page-grid { grid-template-columns: minmax(0,1fr); }
  .cs-rail { position: static; max-height:none; }
  .cs-media-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
}
@media (max-width: 900px) {
  .cs-ideas { grid-template-columns: minmax(0,1fr); }
  .cs-ideas-list { position: static; max-height:none; }
  .cs-ideas.has-selection .cs-ideas-list { display:none; }
  .cs-ideas:not(.has-selection) .cs-ideas-page { display:none; }
}
@media (max-width: 720px) {
  .cs-shell { padding: 12px 10px 28px; gap:10px; }
  .cs-brand p { display:none; }
  .cs-tabs { width:100%; }
  .cs-tab { flex:1; justify-content:center; padding:8px 6px; }
  .cs-kpis { grid-template-columns: repeat(2, minmax(0,1fr)); flex-basis:100%; }
  .cs-board-tools { width:100%; }
  .cs-search { flex:1 1 100%; width:auto; min-width:0; }
  .cs-board { scroll-snap-type: x mandatory; gap:10px; scroll-padding-inline: 2px; }
  .cs-col { flex: 0 0 84vw; max-width:none; height: max(360px, calc(100 * var(--cs-vh) - 150px)); scroll-snap-align: start; }
  .cs-doc-head { padding: 16px 14px 10px; }
  .cs-title-input { font-size:21px; }
  .cs-editor-host .rd-doc { padding: 0 14px; }
  .cs-tile-actions { opacity:1; }
}
@media (prefers-reduced-motion: reduce) {
  .cs-card, .cs-col, .cs-wip-bar span { transition:none; }
  .cs-busy, .cs-skel { animation:none; }
}
`;

let injected = false;

export function ensureStudioStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.contentStudio = "1";
  style.textContent = CSS;
  document.head.appendChild(style);
}
