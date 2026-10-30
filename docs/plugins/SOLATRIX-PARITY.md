# Solatrix plugin ↔ original desktop app — parity checklist

Target: the ORIGINAL Solatrix desktop app (`MrYungCEO/solatrix-terminal`, local
working copy incl. uncommitted edits) running inside InfiniBot — same styles,
same functionality — with the dangerous parts (browser-held private keys,
renderer signing, hard-coded API keys) replaced by the plugin's server-side,
permission-gated execution.

Branch `feat/solatrix-parity`. Inventories of the original (secrets redacted):
[`solatrix/parity/original-trading.md`](solatrix/parity/original-trading.md),
[`original-dashboard-feed.md`](solatrix/parity/original-dashboard-feed.md),
[`original-backend.md`](solatrix/parity/original-backend.md). RPC/component
contract: [`solatrix/parity/CONTRACTS.md`](solatrix/parity/CONTRACTS.md).

Status: **Done** = implemented and verified (unit tests and/or side-gateway e2e and/or screenshot pair) · **Done★** = done and improved over the original (bug fixed / stub made real) · **Deferred** = intentionally not ported, with reason · **Partial** = works, with the stated limitation.

## How the original maps onto InfiniBot

| Original view | InfiniBot route (nav) | Element |
|---|---|---|
| `index-trading.html` (Terminal) | `/solatrix` (Terminal) | `<solatrix-terminal-view>` |
| `index.html` › Dashboard | `/solatrix/portfolio` (Portfolio) | `<solatrix-dashboard-view section="dashboard">` |
| `index.html` › Wallets / Distribute / Collect | `/solatrix/wallets` (+ in-page sections) | dashboard sections |
| `index.html` › Copy Trading | `/solatrix/copy-bot` | dashboard section |
| `index.html` › Launcher | `/solatrix/launcher` | dashboard section |
| `index.html` › Settings | `/solatrix/settings` | dashboard section (+ agent access) |
| `index.html` › Analytics / PnL Tracker / Strategy RE / Overwatch | in-page dashboard sections | dashboard sections |
| `index-feed.html` (Feed) + CopyBot Pro | `/solatrix/discovery` | `<solatrix-feed-view mode="feed\|copybot">` |
| — (InfiniBot addition) | `/solatrix/queue` | dashboard shell › SYSTEM › Queue |
| — (InfiniBot addition) | `/solatrix/map` | legacy wallet map (intel branch extends it) |

Styles: the original CSS (`styles/*.css`, the three HTML `<style>` blocks and the CSS the original JS injected at runtime) is vendored **verbatim** into `extensions/solatrix/ui/styles/original/` by `scripts/vendor-original-css.mjs` (`:root/html/body → :host`, nothing else changed) and applied inside each view's shadow root — nothing leaks into InfiniBot's global CSS. Dashboard markup is vendored from `index.html` by `ui/dashboard/markup/vendor-markup.mjs`. Fonts (Orbitron / JetBrains Mono / Inter) and the original logo are included.

## Terminal (`index-trading.html`)

| Feature | Original file(s) | Plugin location | Status |
|---|---|---|---|
| Header: logo, nav tabs Trenches/Trending/CopyTrade/Monitor/Track/Portfolio → sidebar panels | index-trading.html, inline script | `ui/terminal/view-header.ts` | Done |
| Token search (Recent / Trending / Results, CA auto-load ≥32 chars, Enter) | trading-panel.js, terminal-main.js | view-header.ts + `solatrix.tokens.search`, `market.trending` | Done |
| Header stats TOTAL SOL / P&L / TOKENS / WALLETS + wallet pill | inline `updateHeaderStats` | view-header.ts + `ledger.snapshot/stats`, `wallets.balances` | Done★ (no key decoding in the browser) |
| LAUNCHER button (launch sync) | view-toggle.js | view-header.ts + `solatrix.sync.status` | Done |
| DASHBOARD in-page mini dashboard | view-toggle.js | view-header.ts (+ "Full Dashboard" link) | Done |
| Sub-nav Terminal / Wallets / Positions / Distribute / Collect | inline script | view-header.ts, router | Done |
| Token info bar: avatar, $SYMBOL, CA input/load/copy, age/Pump.fun/Raydium badges, PRICE/LIQ/24H VOL/MC/24H | terminal-main.js | view-header.ts + `market.token` | Done |
| Chart settings (type, scale, colours, volume/grid/markers) | inline, trading-chart.js | `<solatrix-chart>` | Done (moved into the chart header) |
| Left icon sidebar — wallet, holdings, track, monitor, trending, recent, new, overwatch, hawkeye, collect, trenches, distribute, copytrading | sidebar-data.js, sidebar-panels-full.js, holdings-panel.js, inline sb* | `ui/terminal/view-sidebar.ts` + tracked/monitor/overwatch/hawkeye/copy RPCs | Done★ (original Collect/Distribute/wallet IPC was missing — now real tickets) |
| Sidebar AI Studio (Replicate image/video) | ai-image-generator.js | view-sidebar.ts | **Deferred** — needs a third-party Replicate key in the browser; InfiniBot already has image/video tools. Panel shows the notice. |
| Bottom panel: resizable 150px–70vh, persisted | history-panel.js | `ui/terminal/view-bottom.ts` | Done |
| Feed controls Start/Stop/Refresh + status | terminal-feed.js | view-bottom.ts + `feed.live` | Done |
| Trades tab (Live P&L, Hide Closed, Verify, Show Targets) | trades-table.js | view-bottom.ts + `ledger.trades`, `chain.verifyPositions` | Done |
| Positions tab (25/50/100 % sell, per-wallet expand, stale close) | trades-table.js | view-bottom.ts + `ledger.forceClose` | Done |
| Orders tab (TP/SL rules as orders, distance bars, pause/edit/cancel) | take-profit-panel.js | view-bottom.ts + `tp.*` | Done |
| Holders tab | terminal-feed.js | `market.holders` | Done★ (original used mock rows) |
| Top Traders / Tracking / Liquidity Pool / Dev Token / History | terminal-feed.js, history-panel.js | view-bottom.ts | Done |
| DCA tab | terminal-feed.js | view-bottom.ts | Done (a "coming soon" stub in the original too — kept 1:1) |
| Take Profit tab + alert settings | take-profit-panel.js | view-bottom.ts + `tp.*`, `alerts.*` | Done |
| Trading panel stats 1m/5m/1h/24h | trading-panel.js | `ui/terminal/view-trade.ts` | Done★ (original used `Math.random`) |
| Balance card, Instant / Slow / Bundle modes | trading-panel.js | view-trade.ts | Done |
| Presets P1/P2/P3 (original values; edits save into the active preset) | trading-panel.js | view-trade.ts | Done |
| Quick buy 0.1/0.25/0.5/1/2/5, quick sell 1/5/10/25/50/75/100 %, custom BUY/SELL | trading-panel.js | view-trade.ts → `trade.prepare` → review | Done (every trade shows the review/confirm step — see "Deliberate differences") |
| Trade settings: slippage 5/10/15/25+custom, priority Low/Med/High/Turbo+custom, Jito tip, slow interval/batch/random | trading-constants.js, SLIPPAGE_STANDARDIZATION.md | view-trade.ts + server-side standardisation | Done★ (one slippage model; pump tokens floor 25 %; the original was inconsistent) |
| Wallet selection (groups, All/None/Funded, grid, bundle totals) | trading-panel.js | view-trade.ts + `wallets.*` | Done |
| Token Safety | trading-panel.js | view-trade.ts + `market.safety` | Done★ (never populated in the original; unknown values show "—", never fake) |
| Pool info, low-SOL warning + reload | trading-panel.js | view-trade.ts (+ distribute ticket) | Done |
| Position-mode bar ▲ LONG / status / ▼ SHORT + modal | position-mode-manager.js | `ui/terminal/view-modals.ts` + `positionMode.*` | Done★ (the original only recorded synthetic sells; now real TP/SL rules, trailing TP implemented) |
| TP rule modal (all fields) | index-trading.html 8110-8299, take-profit-panel.js | view-modals.ts + `tp.rules.create/update`, `tp.groups` | Done |
| Alert toasts + WebAudio tones | tp-sl-alerts.js | `ui/terminal/alerts.ts` + `alerts.feed` | Done |
| Keyboard: Enter search/CA, Escape, Delete/Ctrl+Z/Y on drawings | various | terminal + chart | Done |
| Window chrome (frameless title bar ─ □ ✕) | main.js / preload | — | **Deferred** — Electron-only; InfiniBot owns the window. |
| Mobile layout | — (none in original) | container queries | Done (added; desktop stays 1:1) |

## Chart system (shared with the control-bar CHART panel)

| Feature | Original | Plugin | Status |
|---|---|---|---|
| lightweight-charts 4.1.0 wrapper, timeframes 1s 30s 1m 5m 15m 1H 4H 1D (+30m, 1w), OHLC readout | chart.js, trading-chart.js | `ui/chart/solatrix-chart.ts` | Done |
| Chart types candle/line/area/bars, scale normal/log/%, colours, volume/grid/markers | trading-chart.js | chart + settings dropdown | Done |
| Indicators MA 20 / EMA 9 / Bollinger 20,2 | trading-chart.js | `ui/chart/indicators.ts` | Done★ (the original had no UI toggle; added in chart settings) |
| Data: GeckoTerminal → Birdeye → DexScreener synthetic, health-sorted, retry, cache | chart-service.js | `src/parity/read` (`solatrix.market.ohlcv`) | Done★ (server-side; synthetic candles never outrank real ones; priced in the requested token) |
| Live updates (price tick, OHLCV refresh, pause when hidden) | trading-chart.js | chart | Done |
| Drawing tools: crosshair, trend, horizontal, ray, fib, rectangle, brush, text, emoji, ruler, zoom, delete + context menu, property panel, undo/redo, per-token persistence | chart-drawings.js | `ui/chart/drawings*.ts` + `chart.state.*` | Done★ (Brush/Emoji/Ruler were no-ops in the original) |
| Trade markers (5 s buckets, bundle counts, tooltips) | trading-chart.js | `ui/chart/markers.ts` + `ledger.trades` | Done |
| TP/SL/ENTRY price lines | trading-chart.js | chart + `tp.rules`, `ledger.snapshot` | Done |
| LONG/SHORT levels overlay, draggable labels, floating panel, CREATE RULES, BUY/SELL | chart-levels.js | `ui/chart/levels*.ts` → TP rules / host trade review | Done |
| Active levels strip | take-profit-panel.js | chart | Done |
| Trade position overlay (CLOSE / TP / SL) | trade-position-overlay.js | chart | Done |
| Compact variant for the control bar (390px-safe) | — | `variant="compact"` | Done |

## Control-bar CHART panel (`ui/src/ui/views/solana-chart.ts`)

| Feature | Status |
|---|---|
| SOURCE switch "Solatrix" (native chart) \| "DexScreener" (embed), remembered per profile | Done (side-gateway screenshots, desktop + 390px) |
| Plugin disabled ⇒ Solatrix option disabled, DexScreener + basic watchlist keep working | Done (side gateway with the plugin disabled) |
| One shared watchlist (`ui/src/ui/solana/watchlist.ts`): add / remove / reorder (drag, Alt+↑/↓) / live prices; synced with the plugin (`solatrix.watchlist.*`, mirrors `settings.watchlist`) | Done |
| Migration of the old saved coins (`infinibot-saved-coins`) — one-time, never deletes the legacy key, no data loss | Done (unit tests + side gateway) |
| Watchlist sidebar in both the panel and the plugin pages | Done |
| DexScreener embed renders a chart | Partial — the embed now targets the token's best pair; DexScreener rate-limits/blocks headless browsers, so it could only be shown empty in automated screenshots |

## Dashboard (`index.html`)

| Section | Status | Notes |
|---|---|---|
| Shell: animated bg/grid/scanlines/HUD, header stats, network pill, sidebar COMMAND/OPERATIONS/SYSTEM, persistent token chart | Done★ | The persistent chart offers "Native chart" (shared `<solatrix-chart>`, default) \| "DexScreener" (the original embed), remembered per profile. Trading/Terminal/Charts → `/solatrix`; Live Feed → `/solatrix/discovery`; Trenches → terminal trenches panel (was a dead link) |
| Dashboard: KPI cards, fee panel + log, signal feed, copy-trading-active, master wallet strip, Quick Trade (instant/slow/bundle), slow settings, wallet leaderboard, quick actions, deploy controls, wallet groups, fee profiles, launch history, enhanced sweep, bulk create, bundle wallet grid, right sidebar (breakdown, SOL/USD, holdings, withdraw, activity) | Done | Portfolio chart = inline SVG from sampled values (no portfolio-history RPC) — Partial. CSV/JSON wallet import points to single-key import (keys only enter through Wallets). |
| 🔥 Spam Launch | Not available yet | The original only simulated it. Solatrix shows "Not available yet" with the reason (no pump.fun create-transaction builder) instead of a pretend success. |
| Wallets: Advanced Trading Instant/Slow/Scheduled, price targets (sell-at-MC → `mcap` TP rule), bundle buy/sell, wallet management (generate / import / export-key-once / labels / groups) | Done | Rebuy-at-MC disabled with a note (the TP engine only sells). Exports never contain keys. |
| Distribute (SOL) | Done | Token distribution refused with a clear message (no SPL-transfer builder yet) — **Partial** |
| Collect (+ sell tokens first, USDC→SOL, withdraw from main) | Done | |
| PnL Tracker, Analytics (P&L chart, history export, trade log recover-from-chain, holdings) | Done | "Demo trades" removed: the ledger only holds real, recorded trades (empty until you trade or recover from chain). |
| Copy Trading (Signal/Copy, buy wallet, amount, slippage, copy buys/sells, auto-sell 100/75/50/Mirror, tracked + presets, active copies + Sell All, history, status) + enable/disable with limits | Done★ | Mirror sells are proportional (the original treated Mirror as 100 %); exits sell from the wallet that bought (the original always sold from master) |
| 🎯 Strategy RE (v1 + v2 algorithms: exits, patterns, insights, first-buyer, compare/rank) | Done★ | Never loaded in the original (EventEmitter in the browser) |
| Overwatch (score, tags, hawk alerts, top wallets, saved wallets import/export) | Done★ | Uses live SOL price (original hard-coded $150) |
| Launcher: header, chart + quick trade, tabs PumpPortal / Creator Fees / Pump.fun (legacy) / Meteora / Bundler / Friends / Monitor, launch config, wallet management, active launch monitor | Done / Partial | PumpPortal launch goes through the existing typed-phrase `launch.prepare/confirm`; **Token creation + image upload: Not available yet** (needs a pump.fun metadata/create builder); the launch dry-run shows only the fee/allocation estimate from your inputs. Creator-fee claim: Not available yet (no collectCreatorFee builder; nothing is sent). Pump.fun legacy / Bundler / Spam: Not available yet (the original only simulated them). Meteora = CONFIG EXPORT, as the original. |
| 👥 Friends Queue (party codes, TTL, host/member, arm, launch, member auto-buy, activity) | Partial | State machine + UI ported; **cross-install relay deferred** — the original used a shared Redis Cloud instance with hard-coded credentials. Local in-process relay behind a `PartyRelay` interface. |
| Settings: RPC (owner, encrypted), priority fee, trade recovery, backup/restore (non-secret), danger zone + InfiniBot settings, agent access, trade limits, legacy import, permission matrix | Done | "Demo & Testing" removed (no demo mode). Auto-Update **Deferred** (Electron/git self-update; InfiniBot manages plugin updates) |
| Queue (trade queue + operation ledger) | Done | InfiniBot addition in the original's styling |
| Modals (analysis, deposit/QR, create, reset, activity log, import, wallet detail, fee log, creator wallet, save token) | Done | "Copy Key" shows the key once through the existing owner-only export flow |

## Feed (`index-feed.html`) + CopyBot

| Feature | Status |
|---|---|
| Title nav DASHBOARD / TRADING / FEED / COPYBOT, status bar, loading steps | Done |
| FeedFirstUI: filters All/Buys/Sells/My Trades/Tracked, pause, sound (880/440 Hz), clear, items with Buy / 📈 / 👁, auto-scroll, max 200, sidebar Quick Trade / Positions / CopyBot widget / Tracking | Done★ (original parsing was a `Math.random()` placeholder; now real `feed.live`) |
| CopyBot Pro (Overview / Wallets presets / Settings / Signals) | Done★ (never mounted in the original) |
| Basic CopyBot panel (`copybot-panel.js`) | Done (superseded by CopyBot Pro + dashboard Copy Trading; same settings) |

## Backend engines (server-side, `extensions/solatrix/src/parity/**`)

| Engine | Original | Status |
|---|---|---|
| Trade ledger, average-cost PnL, positions per mint + per wallet, stats, export, recalc, force close, verify stale | trade-engine.js, trade-storage.js, pnl-calculator.js | Done★ (JSON, per-wallet quantities fix the TP decimals bug) |
| Position tracker / prices (DexScreener multi, caches) | position-tracker.js, token-price-service.js | Done |
| Trade queue (priorities, wallet/mint locks, retry classes, timeout, cancel) | trade-queue.js | Done★ (never retries after a transaction was sent) |
| UI trade tickets: instant / slow / bundle, bundle sell, distribute, collect, sweep | main.js swap/bundle/transfer handlers | Done★ (server-side signing; gated permissions; owner trade limits + daily cap; typed confirm on mainnet / large trades) |
| Take-profit / stop-loss engine (price, mcap, price %, P&L %, trailing; instant / slow sell; chains; cooldown; max executions; wallet groups; history) | take-profit-engine.js, take-profit-storage.js | Done★ (the original never fired: missing price function, double counting, aggregate/decimals bug) |
| Position modes | position-mode-manager.js | Done★ |
| Alerts (settings, test, event feed) | tp-sl-alerts.js, main.js | Done |
| Fees (profiles fast/turbo/ultra/custom, estimate, log) | index.html fee panel | Done |
| Chain verifier (owner-filtered swap parsing, Token-2022, pump.fun programs, reconcile/recover) | chain-verifier.js | Done★ (original parsed non-owner balances; pump.fun program missing) |
| Strategy analyzer v1 + v2 | strategy-analyzer(-v2).js | Done★ |
| Copy engine (signal/copy, sizing fixed/percent/scaled, filters, exits, presets, monitor) | copybot-engine.js, copybot-enhanced-panel.js | Done★ (dry-run default; executes only with `gated:copy-trading` + limits) |
| Launch sync, launch history | launch-sync-api.js | Done |
| Party queue | FRIEND_LAUNCH_GROUPS.md, main.js party-* | Partial (local relay) |
| Jito bundles | index.html (renderer) | **Deferred** — tips are recorded and flagged in ticket warnings; "Bundle" mode is parallel swaps, exactly like the original's backend |
| Storage backups / emergency sync | main.js storage-* | Done as non-secret data export/import; keys never exported (original exported plaintext keys) |
| Mobile server (WS pairing) | mobile-server.js | **Deferred** — never wired in the original; InfiniBot's own mobile app talks to the gateway |

## Security model (unchanged, extended)

- Keys only in the plugin's encrypted wallet store; signing server-side (`withSecret`). The original's browser key storage, renderer signing and plaintext backups are **not** ported. Legacy import never copies keys.
- Every UI fund movement: prepare RPC → `<solatrix-trade-review>` → `solatrix.ops.confirm` (interactive session + confirmation phrase; typed on mainnet / above the owner's threshold) → trade queue. Agents keep trading only through `solana_trade` / `solana_transfer` (policy engine, approvals, agent-access modes); the new write RPCs refuse non-interactive callers.
- Gated permissions (`swaps`, `transfers`, `copy-trading`, `bundle-launch`) stay off by default; the TP engine and copy engine only execute while the matching permission is on. The plugin stays off by default; agent access starts Off.
- No hard-coded API keys (the original shipped Helius keys and a Redis password). Optional Birdeye key is owner-only and stored encrypted.

## Deliberate differences from the original

1. One confirmation step for every trade (the original executed quick buys on a single click with renderer-held keys).
2. Real data everywhere the original showed random/mock numbers (trading stats, holders, feed amounts, safety).
3. Bug fixes listed as Done★ above.
4. Terminal header compresses at narrower widths (inside InfiniBot's content column) instead of clipping; mobile layouts added.

## Verification

- Screenshot pairs `shots/parity/<screen>-{original,plugin}.png` (worktree `/tmp/ib-solatrix-parity`): terminal, 6 sidebar panels, bottom positions, TP modal, mini dashboard, chart / levels / settings / drawing toolbar, dashboard home, wallets, copy trading, analytics, PnL, strategy, overwatch, settings, launcher (+ each tab), feed. Plugin-only: 390px views, position mode, trade review, compact chart, queue, CopyBot Pro.
- Tests: plugin suite (`npx vitest run --config vitest.extensions.config.ts extensions/solatrix`), UI suite (`pnpm -C ui test`), registration ↔ manifest test.
- Evidence logs: `/tmp/sx-final/` (plugin-tests.log, ui-tests.log, tsc.log, intel-merge.log, side-gateway-e2e.txt).
- Side gateway (fresh state, devnet, egress limited to market-data hosts; this run used the since-removed demo mode): scripted e2e of market data, watchlist sync, encrypted wallets, ticket prepare/confirm/queue/ledger, limits, TP rules, position modes, permission refusals; control-bar panel screenshots for both sources, 390px and plugin disabled.

## Real data only (2026-09-29, feat/solatrix-real)

There is no demo/sample mode any more. The `dataMode` and `marketData` config keys, `src/demo.ts`, the `DemoChain`, the read-side fixture fallback, intel fixture holders/activity, "demo trades" and every DEMO label are gone. Runtime code is guarded by `test/real-data-guard.test.ts` (fails if any runtime module imports a demo/mock/fixture/fake path or shows "DEMO"). Fixtures and dev harnesses live under `test/**` and are only injected by tests.

| Data | Source | Key needed |
|---|---|---|
| Token search, price, pairs, trending / new pairs | DexScreener | none |
| Candles | GeckoTerminal (Birdeye first when a key is set) | none (Birdeye optional BYOK) |
| Quotes, token list/metadata, prices | Jupiter lite-api (`/swap/v1`, `/price/v3`, `/tokens/v2`) | none |
| pump.fun new launches / metadata | pump.fun public frontend API | none |
| Wallet balances, history, trade recovery, token facts | Solana JSON-RPC | public mainnet endpoint works but is rate limited; your own RPC recommended |
| Holder lists (terminal Holders tab, Bubble Map) | Solana JSON-RPC `getTokenLargestAccounts` | **your own RPC URL** — the public endpoint answers 429 |
| Holder transfer links | Helius | optional BYOK |

When data can't be loaded the UI shows why and what to do ("Create or import a wallet", "Add your RPC URL in Settings", "Add a Birdeye/Helius key", "Rate limited — Retry"), never sample numbers.

