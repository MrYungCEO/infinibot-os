/**
 * Community Manager stylesheet (light DOM, injected once). Every selector is
 * under `.cmx` so nothing leaks into core UI. Premium black-gold glass on the
 * theme tokens (`--g-primary`, `--text`), with fallbacks.
 */

const CSS = `
.cmx {
  --cmx-gold: var(--g-primary, #caa45a);
  --cmx-text: var(--text, #f2efe8);
  --cmx-dim: color-mix(in srgb, var(--cmx-text) 60%, transparent);
  --cmx-faint: color-mix(in srgb, var(--cmx-text) 36%, transparent);
  --cmx-line: rgba(255,255,255,0.08);
  --cmx-line-gold: color-mix(in srgb, var(--cmx-gold) 28%, transparent);
  --cmx-glass: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015));
  --cmx-panel: rgba(14,13,11,0.72);
  --cmx-ok: #4ade80; --cmx-warn: #fbbf24; --cmx-fail: #f87171; --cmx-info: #7dd3fc;
  --cmx-radius: 14px;
  display: flex; flex-direction: column; gap: 14px; min-height: 100%;
  padding: 18px 22px 48px; box-sizing: border-box; color: var(--cmx-text);
  font-family: var(--font-body, Inter, system-ui, sans-serif);
}
.cmx *, .cmx *::before, .cmx *::after { box-sizing: border-box; }
.cmx button, .cmx input, .cmx select, .cmx textarea { font: inherit; color: inherit; }
.cmx a { color: var(--cmx-gold); }

/* header */
.cmx-head { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:14px 16px; border-radius:var(--cmx-radius);
  background: var(--cmx-glass), var(--cmx-panel); border:1px solid var(--cmx-line-gold);
  box-shadow: 0 18px 40px -28px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.05); }
.cmx-brand { display:flex; align-items:center; gap:12px; min-width:0; flex:1 1 260px; }
.cmx-mark { width:42px; height:42px; border-radius:12px; display:grid; place-items:center; color:#0b0a08; flex-shrink:0;
  background: linear-gradient(140deg, color-mix(in srgb, var(--cmx-gold) 80%, #fff), var(--cmx-gold));
  box-shadow: 0 8px 22px -10px var(--cmx-gold), inset 0 1px 0 rgba(255,255,255,.45); }
.cmx-mark svg { width:22px; height:22px; }
.cmx-brand h1 { margin:0; font-size:19px; font-weight:700; letter-spacing:-.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cmx-brand p { margin:2px 0 0; font-size:12.5px; color:var(--cmx-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cmx-head-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.cmx-pill { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border-radius:99px; font-size:12px; font-weight:700;
  letter-spacing:.04em; text-transform:uppercase; border:1px solid var(--cmx-line); background:rgba(255,255,255,.03); }
.cmx-dot { width:8px; height:8px; border-radius:50%; background: var(--cmx-faint); box-shadow:0 0 0 3px rgba(255,255,255,.04); }
.cmx-tone-live .cmx-dot, .cmx-dot.ok { background: var(--cmx-ok); box-shadow: 0 0 10px var(--cmx-ok); }
.cmx-tone-shadow .cmx-dot, .cmx-dot.warn { background: var(--cmx-warn); }
.cmx-tone-paused .cmx-dot, .cmx-dot.fail { background: var(--cmx-fail); }
.cmx-tone-live { color: var(--cmx-ok); border-color: color-mix(in srgb, var(--cmx-ok) 35%, transparent); }
.cmx-tone-shadow { color: var(--cmx-warn); border-color: color-mix(in srgb, var(--cmx-warn) 35%, transparent); }
.cmx-tone-paused { color: var(--cmx-fail); border-color: color-mix(in srgb, var(--cmx-fail) 40%, transparent); }

/* buttons + inputs */
.cmx-btn { appearance:none; cursor:pointer; border-radius:10px; padding:8px 14px; font-size:13px; font-weight:600; min-height:38px;
  display:inline-flex; align-items:center; justify-content:center; gap:7px; white-space:nowrap; border:1px solid var(--cmx-line);
  background: rgba(255,255,255,.04); transition: filter .15s, background .15s, border-color .15s; }
.cmx-btn svg { width:15px; height:15px; }
.cmx-btn:hover { background: rgba(255,255,255,.08); }
.cmx-btn:disabled { opacity:.5; cursor:not-allowed; }
.cmx-btn.primary { color:#0b0a08; border-color:transparent; background: linear-gradient(180deg, color-mix(in srgb, var(--cmx-gold) 88%, #fff), var(--cmx-gold)); }
.cmx-btn.primary:hover { filter: brightness(1.06); }
.cmx-btn.danger { color: var(--cmx-fail); border-color: color-mix(in srgb, var(--cmx-fail) 40%, transparent); }
.cmx-btn.ok { color: var(--cmx-ok); border-color: color-mix(in srgb, var(--cmx-ok) 40%, transparent); }
.cmx-btn.sm { min-height:30px; padding:5px 10px; font-size:12px; border-radius:8px; }
.cmx-input, .cmx-select, .cmx-textarea { width:100%; border-radius:10px; border:1px solid var(--cmx-line); background: rgba(0,0,0,.35);
  padding:9px 12px; font-size:13.5px; min-height:40px; outline:none; }
.cmx-input:focus, .cmx-select:focus, .cmx-textarea:focus { border-color: var(--cmx-line-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cmx-gold) 14%, transparent); }
.cmx-textarea { min-height:90px; resize:vertical; line-height:1.45; }
.cmx-select { padding-right: 30px; text-overflow: ellipsis; }
.cmx-select option { background:#141210; }
.cmx-label { display:block; font-size:12px; font-weight:600; color: var(--cmx-dim); margin:0 0 6px; letter-spacing:.02em; }

/* tabs */
.cmx-tabs { display:flex; gap:4px; padding:4px; border-radius:12px; background: var(--cmx-panel); border:1px solid var(--cmx-line);
  overflow-x:auto; scrollbar-width:none; }
.cmx-tabs::-webkit-scrollbar { display:none; }
.cmx-tab { appearance:none; border:0; background:transparent; color: var(--cmx-dim); cursor:pointer; padding:8px 14px; border-radius:9px;
  font-size:13px; font-weight:600; display:inline-flex; gap:7px; align-items:center; min-height:36px; white-space:nowrap; }
.cmx-tab svg { width:14px; height:14px; }
.cmx-tab:hover { color: var(--cmx-text); background: rgba(255,255,255,.04); }
.cmx-tab.on { color:#0b0a08; background: linear-gradient(180deg, color-mix(in srgb, var(--cmx-gold) 88%, #fff), var(--cmx-gold)); }
.cmx-badge { font-size:11px; padding:1px 7px; border-radius:99px; background: rgba(255,255,255,.08); }
.cmx-tab.on .cmx-badge { background: rgba(0,0,0,.18); }

/* kpis */
.cmx-kpis { display:grid; grid-template-columns: repeat(8, minmax(0,1fr)); gap:10px; }
.cmx-kpi { padding:12px 14px; border-radius:12px; background: var(--cmx-glass), var(--cmx-panel); border:1px solid var(--cmx-line); min-width:0; }
.cmx-kpi b { display:block; font-size:22px; font-weight:700; letter-spacing:-.02em; font-variant-numeric: tabular-nums; }
.cmx-kpi span { font-size:11.5px; color: var(--cmx-dim); text-transform:uppercase; letter-spacing:.06em; }
.cmx-kpi.alert b { color: var(--cmx-fail); }
.cmx-kpi.gold b { color: var(--cmx-gold); }

/* panels */
.cmx-grid { display:grid; grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.6fr); gap:14px; align-items:start; }
.cmx-col { display:flex; flex-direction:column; gap:14px; min-width:0; }
.cmx-panel { border-radius: var(--cmx-radius); background: var(--cmx-glass), var(--cmx-panel); border:1px solid var(--cmx-line); min-width:0; overflow:hidden; }
.cmx-panel-h { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--cmx-line); }
.cmx-panel-h h2 { margin:0; font-size:12.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color: var(--cmx-dim); display:flex; gap:8px; align-items:center; }
.cmx-panel-h h2 svg { width:14px; height:14px; color: var(--cmx-gold); }
.cmx-panel-b { padding:12px 14px; }
.cmx-empty { padding:22px 14px; text-align:center; color: var(--cmx-faint); font-size:13px; }

/* feed */
.cmx-feed { list-style:none; margin:0; padding:4px 0; max-height:420px; overflow:auto; }
.cmx-feed li { display:grid; grid-template-columns: 44px 70px 1fr; gap:8px; padding:7px 14px; font-size:12.8px; align-items:baseline; border-bottom:1px solid rgba(255,255,255,.03); }
.cmx-feed time { color: var(--cmx-faint); font-variant-numeric: tabular-nums; font-size:12px; }
.cmx-kind { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color: var(--cmx-gold); }
.cmx-kind.mod, .cmx-kind.approval { color: var(--cmx-fail); }
.cmx-kind.lead { color: var(--cmx-ok); }
.cmx-kind.system { color: var(--cmx-info); }
.cmx-feed .dry { color: var(--cmx-dim); font-style: italic; }
.cmx-filters { display:flex; gap:4px; flex-wrap:wrap; }
.cmx-chip { appearance:none; border:1px solid var(--cmx-line); background:transparent; border-radius:99px; padding:3px 9px; font-size:11.5px; cursor:pointer; color: var(--cmx-dim); }
.cmx-chip.on { border-color: var(--cmx-line-gold); color: var(--cmx-gold); background: color-mix(in srgb, var(--cmx-gold) 10%, transparent); }

/* tables */
.cmx-table { width:100%; border-collapse:collapse; font-size:13px; }
.cmx-table th { text-align:left; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color: var(--cmx-faint); padding:8px 12px; border-bottom:1px solid var(--cmx-line); }
.cmx-table td { padding:9px 12px; border-bottom:1px solid rgba(255,255,255,.04); vertical-align:middle; }
.cmx-table tr:hover td { background: rgba(255,255,255,.02); }
.cmx-score { display:inline-grid; place-items:center; min-width:34px; height:26px; border-radius:8px; font-weight:700; font-variant-numeric: tabular-nums; }
.cmx-score.hot { color:#0b0a08; background: var(--cmx-gold); }
.cmx-score.warm { color: var(--cmx-gold); background: color-mix(in srgb, var(--cmx-gold) 14%, transparent); }
.cmx-score.nurture { color: var(--cmx-dim); background: rgba(255,255,255,.06); }
.cmx-offer { font-size:11.5px; font-weight:700; padding:2px 8px; border-radius:6px; background: rgba(255,255,255,.06); white-space:nowrap; }
.cmx-offer.pulse { color:#fcd34d; } .cmx-offer.kinglyvault { color:#c4b5fd; } .cmx-offer.kinglyvault-plugins { color:#f0abfc; } .cmx-offer.infinibot { color:#7dd3fc; }
.cmx-offer2 { font-size:11px; color: rgba(255,255,255,.62); white-space:nowrap; }
.cmx-cta { font-size:11.5px; color: var(--cmx-dim); margin-top:3px; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cmx-matrix { display:flex; flex-direction:column; gap:6px; }
.cmx-matrix-row { display:grid; grid-template-columns: minmax(0,1.1fr) auto; gap:4px 10px; padding:8px 10px; border-radius:10px; background: rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.06); font-size:12.5px; }
.cmx-matrix-row .offers { display:flex; gap:6px; align-items:center; justify-content:flex-end; flex-wrap:wrap; }
.cmx-matrix-row .cta { grid-column: 1 / -1; font-size:11.5px; color: var(--cmx-dim); }
.cmx-matrix-row.fallback { border-color: rgba(212,175,55,.45); background: rgba(212,175,55,.07); }
.cmx-link-row { display:grid; grid-template-columns: 150px minmax(0,1fr); gap:8px; align-items:center; margin-bottom:6px; }
.cmx-late { color: var(--cmx-fail); font-weight:700; }
.cmx-mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size:12px; }
.cmx-cards { display:none; }

/* approvals */
.cmx-appr { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid rgba(255,255,255,.04); }
.cmx-appr-main { flex:1; min-width:0; }
.cmx-appr-main b { display:block; font-size:13.5px; }
.cmx-appr-main span { display:block; font-size:12px; color: var(--cmx-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* chart */
.cmx-chart { width:100%; height:120px; display:block; }
.cmx-legend { display:flex; gap:14px; font-size:12px; color: var(--cmx-dim); padding:0 14px 12px; }
.cmx-legend i { display:inline-block; width:10px; height:3px; border-radius:2px; margin-right:6px; vertical-align:middle; }
.cmx-funnel { display:flex; flex-direction:column; gap:8px; }
.cmx-bar { display:grid; grid-template-columns: 110px 1fr 46px; gap:10px; align-items:center; font-size:12.5px; }
.cmx-bar-track { height:10px; border-radius:99px; background: rgba(255,255,255,.06); overflow:hidden; }
.cmx-bar-fill { height:100%; border-radius:99px; background: linear-gradient(90deg, color-mix(in srgb, var(--cmx-gold) 60%, transparent), var(--cmx-gold)); }

/* banners */
.cmx-banner { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 14px; border-radius:12px; border:1px solid var(--cmx-line-gold);
  background: color-mix(in srgb, var(--cmx-gold) 8%, transparent); font-size:13px; }
.cmx-banner.warn { border-color: color-mix(in srgb, var(--cmx-warn) 40%, transparent); background: color-mix(in srgb, var(--cmx-warn) 7%, transparent); }
.cmx-banner.fail { border-color: color-mix(in srgb, var(--cmx-fail) 40%, transparent); background: color-mix(in srgb, var(--cmx-fail) 8%, transparent); }
.cmx-banner svg { width:16px; height:16px; flex-shrink:0; color: var(--cmx-gold); }
.cmx-banner > span { flex:1; min-width:200px; }
.cmx-toast { position:sticky; bottom:12px; align-self:center; padding:10px 16px; border-radius:10px; background:#1b1915; border:1px solid var(--cmx-line-gold); font-size:13px; z-index:3; }

/* wizard */
.cmx-wiz { display:grid; grid-template-columns: 230px minmax(0,1fr); gap:16px; align-items:start; }
.cmx-steps { list-style:none; margin:0; padding:8px; border-radius: var(--cmx-radius); background: var(--cmx-glass), var(--cmx-panel); border:1px solid var(--cmx-line); position:sticky; top:12px; }
.cmx-steps li button { appearance:none; width:100%; border:0; background:transparent; cursor:pointer; display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:9px; font-size:13px; text-align:left; color: var(--cmx-dim); }
.cmx-steps li button:hover { background: rgba(255,255,255,.04); color: var(--cmx-text); }
.cmx-steps .num { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-size:11.5px; font-weight:700; border:1px solid var(--cmx-line); flex-shrink:0; }
.cmx-steps .num svg { width:13px; height:13px; }
.cmx-steps .done .num { background: color-mix(in srgb, var(--cmx-ok) 16%, transparent); color: var(--cmx-ok); border-color: color-mix(in srgb, var(--cmx-ok) 40%, transparent); }
.cmx-steps .current button { color: var(--cmx-text); background: color-mix(in srgb, var(--cmx-gold) 10%, transparent); }
.cmx-steps .current .num { color:#0b0a08; background: var(--cmx-gold); border-color: transparent; }
.cmx-step { display:flex; flex-direction:column; gap:14px; min-width:0; }
.cmx-step-h { display:flex; align-items:flex-start; gap:12px; justify-content:space-between; flex-wrap:wrap; }
.cmx-step-h h2 { margin:0; font-size:20px; font-weight:700; letter-spacing:-.01em; }
.cmx-step-h p { margin:4px 0 0; font-size:13px; color: var(--cmx-dim); max-width:640px; line-height:1.5; }
.cmx-kicker { font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color: var(--cmx-gold); }
.cmx-health { display:flex; flex-wrap:wrap; gap:8px; }
.cmx-check { display:inline-flex; align-items:center; gap:8px; padding:7px 11px; border-radius:10px; font-size:12.5px; border:1px solid var(--cmx-line); background: rgba(255,255,255,.025); max-width:100%; }
.cmx-check svg { width:14px; height:14px; flex-shrink:0; }
.cmx-check.ok svg { color: var(--cmx-ok); } .cmx-check.warn svg { color: var(--cmx-warn); } .cmx-check.fail svg { color: var(--cmx-fail); }
.cmx-check.fail { border-color: color-mix(in srgb, var(--cmx-fail) 35%, transparent); }
.cmx-check small { color: var(--cmx-dim); }
@media (max-width: 720px) { .cmx-check { flex-wrap: wrap; width: 100%; } .cmx-check small { flex-basis: 100%; padding-left: 22px; } }
.cmx-guide { margin:0; padding-left:20px; font-size:13px; line-height:1.7; color: var(--cmx-dim); }
.cmx-guide b { color: var(--cmx-text); }
.cmx-row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
.cmx-row > .grow { flex:1 1 260px; min-width:0; }
.cmx-bot { display:flex; align-items:center; gap:12px; padding:12px; border-radius:12px; border:1px solid var(--cmx-line-gold); background: rgba(0,0,0,.25); }
.cmx-bot img, .cmx-bot .ph { width:44px; height:44px; border-radius:50%; background: #2a2620; flex-shrink:0; display:grid; place-items:center; }
.cmx-bot b { font-size:15px; } .cmx-bot .meta { display:block; font-size:12px; color: var(--cmx-dim); overflow-wrap:anywhere; }
.cmx-guilds { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px,1fr)); gap:10px; }
.cmx-guild { appearance:none; text-align:left; color: var(--cmx-text); cursor:pointer; padding:14px; border-radius:12px; border:1px solid var(--cmx-line); background: rgba(255,255,255,.03); display:flex; gap:12px; align-items:center; }
.cmx-guild.sel { border-color: var(--cmx-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cmx-gold) 16%, transparent); }
.cmx-guild .gi { width:42px; height:42px; border-radius:12px; background:#2a2620; display:grid; place-items:center; font-weight:700; flex-shrink:0; overflow:hidden; }
.cmx-guild .gi img { width:100%; height:100%; }
.cmx-guild b { display:block; font-size:14px; color: var(--cmx-text); } .cmx-guild span { display:block; font-size:12px; color: var(--cmx-dim); }
.cmx-map { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap:12px; }
.cmx-map-item small { display:block; font-size:11.5px; color: var(--cmx-faint); margin-top:4px; }
.cmx-q { border:1px solid var(--cmx-line); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:10px; background: rgba(0,0,0,.18); }
.cmx-q-h { display:grid; grid-template-columns: 1fr 90px; gap:10px; }
.cmx-opt { display:grid; grid-template-columns: minmax(0,1fr) 72px 200px; gap:8px; }
.cmx-split { display:grid; grid-template-columns: minmax(0,1.5fr) minmax(260px,1fr); gap:14px; align-items:start; }
.cmx-weights { font-size:13px; font-weight:700; }
.cmx-weights.bad { color: var(--cmx-fail); } .cmx-weights.good { color: var(--cmx-ok); }
.cmx-preview { border-radius:12px; background:#313338; color:#dbdee1; padding:12px 14px; font-size:13.5px; font-family: "gg sans", "Noto Sans", sans-serif; }
.cmx-preview .who { font-weight:600; color:#fff; } .cmx-preview .bot { font-size:10px; background:#5865f2; color:#fff; border-radius:3px; padding:1px 4px; margin-left:4px; }
.cmx-preview .sel { margin-top:8px; border-radius:4px; background:#1e1f22; padding:9px 12px; color:#949ba4; display:flex; justify-content:space-between; }
.cmx-presets { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:10px; }
.cmx-preset { appearance:none; text-align:left; color: var(--cmx-text); cursor:pointer; border-radius:12px; border:1px solid var(--cmx-line); background: rgba(255,255,255,.03); padding:14px; }
.cmx-preset.sel { border-color: var(--cmx-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cmx-gold) 16%, transparent); }
.cmx-preset b { display:block; font-size:15px; margin-bottom:6px; } .cmx-preset span { display:block; font-size:12px; color: var(--cmx-dim); line-height:1.5; }
.cmx-team-row { display:grid; grid-template-columns: 1.1fr 1fr 150px 1.4fr 40px; gap:8px; align-items:center; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,.04); }
.cmx-offers { display:flex; flex-wrap:wrap; gap:4px; }
.cmx-steprun { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.cmx-steprun li { display:grid; grid-template-columns: 22px 220px 1fr; gap:10px; padding:9px 12px; border-radius:10px; background: rgba(255,255,255,.03); font-size:13px; align-items:center; }
.cmx-steprun li svg { width:16px; height:16px; }
.cmx-steprun li.ok svg { color: var(--cmx-ok); } .cmx-steprun li.fail svg { color: var(--cmx-fail); }
.cmx-steprun li span { color: var(--cmx-dim); font-size:12.5px; }
.cmx-nav { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; padding-top:6px; }
.cmx-err { color: var(--cmx-fail); font-size:13px; }
.cmx-note { font-size:12.5px; color: var(--cmx-dim); line-height:1.5; }
.cmx-modes { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:12px; }
.cmx-livemods { margin-top:14px; padding:14px; border-radius:12px; border:1px solid var(--cmx-line); background: rgba(255,255,255,.02); display:grid; gap:8px; }
.cmx-livemods-row { display:flex; flex-wrap:wrap; gap:8px; }

/* responsive */
@media (max-width: 1280px) { .cmx-kpis { grid-template-columns: repeat(4, minmax(0,1fr)); } }
@media (max-width: 980px) {
  .cmx-grid { grid-template-columns: 1fr; }
  /* Mobile wireframe: leads + approvals first, the activity feed after. */
  .cmx-grid > .cmx-col.feed-col { order: 2; }
  .cmx-wiz { grid-template-columns: 1fr; }
  .cmx-split { grid-template-columns: 1fr; }
  .cmx-steps { position:static; display:flex; overflow-x:auto; gap:4px; padding:6px; scrollbar-width:none; }
  .cmx-steps li { flex-shrink:0; }
  .cmx-steps li button .lbl { display:none; }
  .cmx-steps .current button .lbl { display:inline; }
}
@media (max-width: 720px) {
  .cmx { padding: 12px 10px 40px; gap:10px; }
  .cmx-head { padding:12px; }
  .cmx-brand h1 { font-size:17px; }
  .cmx-kpis { grid-template-columns: repeat(2, minmax(0,1fr)); gap:8px; }
  .cmx-kpi b { font-size:19px; }
  .cmx-table.collapse { display:none; }
  .cmx-panel > .cmx-table:not(.collapse) { display:block; overflow-x:auto; white-space:nowrap; }
  .cmx-table select { min-width:140px; }
  .cmx-cards { display:flex; flex-direction:column; }
  .cmx-card { display:grid; grid-template-columns: 40px 1fr auto; gap:10px; align-items:center; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.04); }
  .cmx-card .meta { font-size:12px; color: var(--cmx-dim); }
  .cmx-card .acts { display:flex; gap:6px; grid-column: 2 / 4; }
  .cmx-feed li { grid-template-columns: 40px 1fr; }
  .cmx-feed li .cmx-kind { display:none; }
  .cmx-presets, .cmx-modes { grid-template-columns: 1fr; }
  .cmx-team-row { grid-template-columns: 1fr 1fr 40px; }
  .cmx-team-row > input:first-child { grid-column: 1 / -1; }
  .cmx-team-row > .cmx-offers { grid-column: 1 / 3; }
  .cmx-opt { grid-template-columns: 1fr 70px; }
  .cmx-matrix-row { grid-template-columns: 1fr; }
  .cmx-matrix-row .offers { justify-content:flex-start; }
  .cmx-opt select { grid-column: 1 / 3; }
  .cmx-steprun li { grid-template-columns: 22px 1fr; }
  .cmx-steprun li span { grid-column: 2; }
  .cmx-head-actions { width:100%; }
  .cmx-head-actions .cmx-btn { flex:1; }
}
`;

let injected = false;
export function ensureCommunityStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.id = "community-manager-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}
