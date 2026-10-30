# Original Solatrix — Trading / Terminal view (index-trading.html) porting reference

Compiled from the local working copy of `solatrix-terminal`. Secret values
(Helius / Replicate keys) are redacted. "(missing)" = renderer calls a preload
method that does not exist.

Key facts:
- **Renderer holds keys** — `trading-panel.js loadWallets` decodes master + sub-wallet secrets; `executeDirectSwap` / `executePumpPortalSwap` sign in the renderer; header stats decode keys every 15 s; sidebar import/export prompts show keys. **Port:** none of this; signing is server-side via tickets + policy.
- Fake/unwired UI in the original: stats block (Vol/Buys/Sells/Net) uses `Math.random()`; Token Safety never updated; Holders tab mock rows; DCA "coming soon"; Collect/Distribute/wallet create/import/export IPC missing; CopyBot cannot run in this window; Jito tip saved but never sent; "Bundle" is a parallel batch. **Port:** wired to real plugin data (see SOLATRIX-PARITY.md).
- CDN: lightweight-charts 4.1.0 (port: npm `lightweight-charts@4.1.0`, bundled), `@solana/web3.js@latest` (port: not loaded in the browser).

## 0. Theme
Fonts Orbitron 400-800 (`--font-display`), JetBrains Mono 400-700 (`--font-mono`), Inter 400-700 (`--font-primary`). CSS: `styles/trading.css`, `trading-enhanced.css`, `take-profit.css`, `chart-levels.css`, `scroll-system.css`; inline 72-4824; JS-injected CSS in trading-panel, terminal-feed, position-mode-manager, trade-position-overlay, holdings-panel, terminal-sidebar-panels, view-toggle, trenches-feed, ai-image-generator.

Tokens (`trading.css :root`): bg #000 / #050508; glass rgba(10,10,15,.92) / rgba(18,18,25,.9); border rgba(212,175,55,.25/.5); accent #d4af37 / #ffd700 / #f4e4a6; success #00ff88; danger #ff3366; warning #ffaa00; info #00d4ff; text #fff / .75 / .4; glows gold/green/red; `--color-buy/-bg/-dim`, `--color-sell/-bg/-dim`; radius 4/6/8. Scroll system: 4 px (hover 6) gold thumbs `rgba(212,175,55,.35/.6/.8)`, purple/green/red variants. Chart: bg #0a0a0a, grid rgba(212,175,55,.1), crosshair #d4af37, candles #22c55e / #ef4444 (settings default #00ff88 / #ff3366), line/area #d4af37.

## 1. Header
Title bar "SOLATRIX TERMINAL" (Electron window controls). Logo + SOLATRIX. **Nav tabs** Trenches / Trending / CopyTrade / Monitor / Track / Portfolio (→ close sidebar / trending / track / monitor / track / wallet panels). **Search** "Search token name, CA, or wallet address..." with Recent / Trending / Results (≥2 chars; >30 = CA; ≥32 auto-load 500 ms; recent 5 / trending 5 / results 8; `solatrix-recent-tokens`). **Header stats** TOTAL SOL (+USD), P&L (+%), TOKENS ($ + count), WALLETS (+N TXs); wallet dot + SOL. **Launcher** (Connect / Synced; launch sync fills CA). **Dashboard** (in-page overlay: Total SOL/USD, Total P&L, Wallets funded, Positions, Tokens; wallet grid, positions, activity; Back).

## 2. Sub-nav
Terminal · Wallets (scroll to right wallet panel) · Positions (bottom Positions tab) · Distribute / Collect (dashboard sections).

## 3. Token info bar
Avatar, `$SYMBOL`, name; CA input + Load (›) + Copy; badges age (m/h/d/mo), Pump.fun, Raydium; metrics Price (subscript zeros `$0.0₅1234`), Liq, 24h Vol, MC, 24h %. **Chart settings** dropdown (`solatrix_chartSettings`): Chart type Candles/Line/Area/Bars; Price scale Normal/Log/Percentage; Up/Down colours; Show Volume / Grid / Trade Markers. Last token `solatrix_lastToken`; timeframe `solatrix_timeframe` (def 15m); SOL price poll 30 s.

## 4. Chart system
- TradingChart (lightweight-charts): timeframes **1s 30s 1m 5m 15m 1H 4H 1D** (+30m, 1w mapped); OHLC readout; types candle/line/area/bars (precision 1e-10); scale normal/log/percent; volume histogram (rgba(34,197,94,.5) / rgba(239,68,68,.5)); indicators MA 20 #2196F3, EMA 9 #ff9800, Bollinger 20/2σ purple (no UI toggle in the original — port adds toggles in chart settings); controls fitContent, scrollToRealtime, screenshot; live: price poll 10 s → last candle, OHLCV refresh 30 s; pause on hidden; validation/sanitize.
- ChartDataService: order GeckoTerminal (pool lookup → ohlcv minute/hour/day aggregate) → Birdeye (optional key) → DexScreener synthetic candles; retry 3, backoff 1 s, 15 s timeout; health-sorted sources; 30 s cache; offline cache; placeholder data last. Sub-minute → 1-minute.
- **Drawing toolbar** (floating): Crosshair, Trend Line, Horizontal Line, Ray, Fibonacci (0 .236 .382 .5 .618 .786 1 1.272 1.618), Rectangle, Brush (no renderer in original), Text, Emoji (no-op), Ruler (no-op), Zoom in/out (×0.8 / ×1.25), Delete. Engine extras: vline, arrow, channel, ellipse, triangle, fibExtension, label, measure. Pan disabled while drawing; drag/resize handles; right-click menu (Edit, Duplicate, Front, Back, Lock, Hide, Delete); property panel (colour, width, solid/dashed/dotted); undo/redo 50; defaults #d4af37, 2 px, fill rgba(212,175,55,.15); per-token `chartDrawings_{mint}`. Keys: Delete/Backspace, Escape, Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y. **Port implements every toolbar tool including Brush, Emoji and Ruler (measure).**
- Trade markers: grouped in 5 s buckets; single circle "B"/"S"; bundle arrow with count; tooltip (SOL/tokens/USD, wallets, breakdown).
- TP/SL + entry lines: rules above → green dashed "TP x%", below → red dashed "SL x%"; entry solid gold "ENTRY".
- **Chart levels (LONG / SHORT overlay)**: entry = last price; TP1 ±10 %, SL ∓10 %; tp1-3 (#00FF88 / #00DD66 / #00BB44), sl, sl1-3 (#FF4444 / #FF6666 / #CC3333); default sell % tp 33/33/34, sl 100, sl1 50, sl2 50, sl3 100; drag labels (price/px = range(last 50 closes)·1.5 / height; long TP > entry > SL); floating info panel (type, symbol, lock; entry; trade size SOL/USD; Instant/Slow with interval 15s/30s/1m, batches 2/3/5/10, random 0/10/25 %; TP/SL rows with sell % 10/25/50/75/100; potential profit / max loss; wallets; Lock, +TP, +SL, CREATE RULES, BUY x SOL, SELL).
- Active levels strip under timeframes (1 s refresh).
- Trade position overlay: line per open position at avg entry; label LONG/SHORT, size, entry, P&L; CLOSE / TP / SL buttons; sync 5 s.

## 5. Right trading panel
Stats (1m/5m/1h/24h: Vol, Buys, Sells, Net); Balance (Total Portfolio USD/SOL, SOL card, TOKENS card, Bought, Sold, P&L, Token Holdings list); Trade mode ⚡ Instant / 🕐 Slow / 📦 Bundle; Presets **P1 {0.1 SOL, 25 %, prio .002, jito .0001} P2 {0.5, 30 %, .003, .0005} P3 {1, 35 %, .005, .001}** (settings changes save into the active preset); Quick Buy SOL 0.1 / 0.25 / 0.5 / 1 / 2 / 5; Quick Sell % 1 / 5 / 10 / 25 / 50 / 75 / 100; custom BUY/SELL + amount + Max + ≈USD + Execute; slow progress + Stop; **Trade Settings**: Slippage 5 / 10 / 15 / 25 + custom; Priority Fee Low .0001 / Med .001 / High .005 / Turbo .01 + custom; 🛡️ Jito Tip Off / .0001 / .0005 / .001; Slow interval 30 s (5-300), wallets/batch 1 (1-10), random ±10 % (0-50); Wallet selection (count, group, All/None/Funded, grid, bundle totals); Token Safety (Top 10, DEV, Holders, Snipers, Insiders, Bundler, NoMint, Burnt); Pool info (DEX, liquidity, created); low-SOL warning + reload 0.25 SOL from master; position-mode trigger bar (▲ LONG | status | ▼ SHORT); BUY / SELL big buttons.

Execution in the original: Instant = master wallet, renderer-signed Jupiter (PumpPortal fallback); Slow = sequential per wallet via IPC, delay interval·(1 ± rand); Bundle = `swap.executeBatch` / `bundleSell.execute` (not a Jito bundle). Slippage handling inconsistent (Instant forces ≥50 %, pump routes dynamic 9500 bps, bundle passes percent as bps). **Port standard:** slippage is a whole-number percent in the UI, converted once to bps server-side (`SLIPPAGE.toBps`), clamped 1-50 %, default 15 (pump routes 25); priority fee in SOL → lamports once; Jito tip applied only where a bundle is actually submitted (launch), and shown as "MEV protection" otherwise as a route preference.

## 6. Bottom panel
Resizable (150 px – 70 vh, `solatrix-bottom-panel-height`). Feed controls (status, ▶ Start Feed / Stop / Refresh; 3 s poll of the mint's swaps). Tabs: **Trades** (Age, Type, Token, Amount, Entry, Close, Fee, P&L, TX; Live P&L, Hide Closed, Verify, Show Targets), **Positions** (Token, Amount, Avg Buy, Current, P&L USD/%, TP/SL, TX, Actions 25/50/100 % sell, per-wallet expand, stale close), **Orders** (TP/SL rules as pending orders; filter All/TP/SL; Distance bar; Pause/Edit/Cancel), **Holders** (top 10 + dev/whale tags), **Top Traders** (from feed), **Tracking**, **DCA** (stub in original), **Take Profit** (rules, slow sells, alert settings), **Liquidity Pool**, **Dev Token**, **📜 History** (All/Buys/Sells, totals, Time/Type/Token/Amount/Price/Total/P&L/Trigger/TX).

## 7. Left icon sidebar
wallet (positions list; wallet list with copy/send/QR/create/import), holdings (all holdings; filter; sort Value/Name/Change; hide dust; SOL row; Buy/Sell; 60 s refresh), track (tracked wallets add/remove/view), monitor (Live / Alerts; tracked-wallet activity 15 s), trending (60 s), recent, new (All/Pump/Raydium; 30 s), overwatch (current token; live monitoring; Buys/Sells/Wallets/Vol; feed 3 s), hawkeye (ON/OFF; signals ≥$10k, whales ≥$50k; 5 s), collect (target, amount + MAX, source wallets), trenches (Bundles / Groups lists), distribute (source, amount per wallet + EQUAL keeping .01 SOL, targets), copytrading (ON/OFF; track wallet; Profit/Trades; signals ≤15; Quick Copy Buy loads the token), aistudio (Replicate image/video generator — **Deferred**: needs a third-party key; InfiniBot has its own media tools).

## 8. TP modal + alerts
Modal: Rule name; Token*; Symbol; Trigger type Price (USD) / Market Cap / Price Change % / P&L %; direction Above ≥ / Below ≤; value; Action Instant / Slow; sell mode Percentage / Fixed amount / All; 25/50/75/100; preview; slow duration 30 min / interval 30 s / randomize 10 %; Wallets All / Selected / Group; Max executions 1; Cooldown 0; Chain to rule + delay. Alert settings: enabled, desktop, sound, volume, toasts, test TP/SL/Buy/Sell. Toast types tp-triggered 🎯 #10b981, sl-triggered 🛑 #ef4444, sell-executed ✅ #3b82f6, rule-triggered ⚡ #f59e0b, slow-sell-progress 📊 #8b5cf6, trade-buy/sell, bundle; tones TP [800,1000,1200] Hz, SL [400,300,200] Hz.

## 9. Position modes
▲ LONG / ▼ SHORT modal: entry (CURRENT, LOCK), TP price / % 5/10/25/50/100 + custom, TP sell 100/75/50/25; SL price / % 5/10/15/25/50 + custom, SL sell 100/75/50; settings auto-execute, trailing TP (not implemented in original — port implements trailing), notifications, slippage 10/15/25; live status; PLACE LONG/SHORT; Close / Update. Creates TP/SL rules (`position-mode-tp/sl`).

## 10-12. Toasts, shortcuts, persistence
Toast 2.5 s; error toast 8 s. Keys above. localStorage keys: `solatrix_lastToken`, `solatrix_timeframe`, `solatrix_chartSettings`, `chartDrawings_{mint}`, `solatrix-presets`, `solatrix-recent-tokens`, `solatrix-tracked-wallets`, `solatrix-bottom-panel-height`, `solatrix_position_mode`, `solatrix_bundles`, `solatrix_groups`, `solatrix_copytrading`, `solatrix_wallets`, `replicate_api_key`, `solatrix_image_history`, `solatrix_v5` (**secrets — never ported**).

## 13-15
IPC surface and external URLs: see `original-backend.md`. Renderer key-handling sites: trading-panel.js 2248-2365, 3171-3380; index-trading.html 7795-7900; sidebar-panels-full.js 159-170, 396-410; wallet-panel.js 2173; holdings-panel.js 477. All replaced by server-side signing in the port.
