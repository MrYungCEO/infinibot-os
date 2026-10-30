# Original Solatrix — Dashboard (index.html), Feed (index-feed.html), CopyBot, Strategy, Launch sync

Porting reference compiled from the local working copy of `solatrix-terminal`.
Line numbers refer to that copy. Secret values are redacted.

## 0. First findings

| # | Finding | Evidence |
|---|---|---|
| 1 | All private keys live in the renderer, unencrypted (localStorage `solatrix_v5`/`_backup`, sessionStorage, IndexedDB `SolatrixDB`, file via `storage.saveVerified('solatrix-main')`). | index.html 8919-9082, 9707-9723 |
| 2 | Creator-wallet keys in localStorage `solatrix.creatorWallets.v1` ("In production, encrypt this!"). | 12702-12961 |
| 3 | All signing in the renderer (Jupiter, PumpPortal trade-local, Jito bundles). | 13281, 26944-26960 |
| 4 | Two Helius API keys hard-coded (values redacted). | index.html 7934…; index-feed.html 477; connection-state-machine.js 42; strategy analyzers |
| 5 | `window.electronAPI` never exposed (only `window.electron`). | preload.js 6 |
| 6 | `view-toggle.js` is an in-page mini-dashboard overlay in the Terminal, not the 3-page switch. | index-trading.html 8089 |
| 7 | Orphaned/broken: strategy-analyzer-v2, strategy-panel, copybot-panel (Node `require`, never loaded); connection-state-machine `require('events')` breaks Feed init; strategy-analyzer.js `extends EventEmitter` + duplicate const ⇒ Strategy RE likely "not loaded". | main.js 5652; csm 14; sa 11/33 |

**Port rule:** the plugin reimplements every feature with keys only in the
server-side encrypted store and every write behind the plugin's gated
permissions + ticket confirmation; the broken/orphaned modules are ported in
their *intended* working form (engine server-side, UI in the plugin).

## A. index.html — Dashboard suite

Structure: 81-2185 `<style>` (~2,100 lines); 2189-2196 decorative layers (`.animated-bg`, `.grid-overlay`, `.scanlines`, `.hud-corner`); 2198-2221 title bar; 2224-2255 header stats (TOTAL SOL, P&L, TOKENS, WALLETS, network pill); 2257-2278 sidebar nav (Command / Operations / System); 2282-2336 persistent token chart (DexScreener iframe; hidden on Launcher); sections 2339-7468; 11 modals 7477-7722; one inline script 7724-28074.

Navigation: `.nav-item[data-section]` → `navigateTo`. Trading/Terminal/Charts load index-trading.html; 🦈 Live Feed loads index-feed.html; Trenches has no section (dead link).

| Section | Contents | Complexity |
|---|---|---|
| **Dashboard** 2339-3597 | KPI cards (SOL price, Portfolio, Today P&L, Volume); ⛽ Fee panel (Auto / Speed / Manual; estimate, priority, spent, avg; manual priority fee + CU; fee log modal); 📡 Signal Feed widget; 🎯 Copy Trading Active; master wallet strip (copy, balance, deposit/create, refresh, reset); **Quick Trade** (wallet select all/none/funded; saved tokens; mint; mini PnL widget; SOL/% amount; slippage; sell %; presets 0.01-1 SOL, 25-100 %; Buy/Sell, Instant (parallel), Slow; progress+stop; wallet grid); Slow Trade settings (interval, batch, randomize); Portfolio chart (1h/24h/7d/30d); Wallet Leaderboard; Quick Actions (create, distribute, collect, export/import CSV, backup, refresh); 🚀 Deploy Wallet controls; 📁 Wallet Groups; ⚡ Fee Profiles (fast/turbo/ultra/custom); 📊 Launch History; 🔥 Spam Launch (simulated); 🧹 Enhanced Sweep (SOL / SPL); 📦 Bulk Create; bundle wallet grid; right sidebar (portfolio breakdown, SOL/USD override, token holdings, 💸 Withdraw, live activity) | L |
| **Wallets** 3601-3896 | Advanced Trading tabs Instant/Slow/Scheduled; mint; presets; shortcuts USDC/BONK/JUP; bundle sell %; **Price Targets** (sell-at-MC, rebuy-at-MC, monitor); Bundle Buy/Sell; Wallet Management (create, export JSON/CSV, clear) | M |
| **Distribute** 3899-4014 | SOL / Token; amount + mode; wallet select; execute | M |
| **Collect** 4017-4207 | Scan; destination master/external; Sell All Tokens; Collect SOL; USDC→SOL; Full Collect; Withdraw from main (25/50/100 %) | M |
| **PnL Tracker** 4210-4303 | Invested, Current, Unrealized, Realized, Total; Position tracker (refresh, scan, auto; sort value/pnl/pnl%/invested/time; filter open/closed/all); Closed positions | M |
| **Analytics** 4306-4383 | P&L chart, Trade History (export), Trade Log (recover from chain; demo trades), Token Holdings | S-M |
| **Settings** 4386-4623 | RPC + priority fee (def 50000); Demo & testing; Trade recovery; Backup & Restore; Auto-Update (Electron/git); Danger zone | M |
| **Copy Trading** 4626-4812 | Signal / Copy mode; Devnet / Mainnet; buy wallet; buy amount (0.01); slippage (1 %); copy buys/sells; auto-sell 100/75/50/Mirror; tracked wallets (+ presets Monster Bot, Monster Trading, Pump Deployer); active copies (Sell All); history; WS status log | L |
| **🎯 Strategy RE** 4815-4948 | Wallet + Analyze; presets; Win rate, Avg hold, Total P&L, Positions; Performance / Timing / Sizing / Exit / Patterns / Top Wins; export; position history filter | M |
| **Overwatch** 4951-5095 | Token mint Start/Stop; Hawk Mode; live activity (clear/export); Top Wallets; Tracked tokens; Hawk alerts; Saved wallets (filter whale/bot/profitable/watched; import/export). Score: base 50; PnL +min(pnl·5,25) / −min(|pnl|·2,15); trades +5 ≥5, +10 ≥20; sell/buy >3 −15, <0.3 & >3 buys +10; volume +5 >10, +10 >50; clamp 0-100. Tags whale (vol>20), profitable (pnl>5), dumper (sellRatio>5 & sells>3), bot (>50 trades/1h). Hawk: BOT >10 trades/5 min, WHALE trade >5 SOL, DUMPER sellVol > 3× buyVol, SNIPER 1 buy + sells + pnl>2 | M |
| **Launcher** 5098-7468 | Header stats; chart + Quick Trade sidebar; tabs pumpportal · pumpfun · creatorfees · meteora · bundler · friends · monitor; wallet management; Launch config (Jito tip/bundle size, anti-MEV, private submit, block-1, CU, µLamports, timeout, creator wallet); Active launch monitor (escalate fees, abort); **PumpPortal launch** (name, symbol, description, image, socials, dev buy, dev-bundle wallets, bundle buys, slippage, priority fee, cost estimate — real: IPFS → trade-local → renderer-signed Jito bundle); Creator Fees (claim); Pump.fun legacy (simulated); Meteora DAMM v2 (config JSON stub); Bundler (simulated); Monitor (metrics, snipers, holdings, consolidate/sell all, activity); 👥 Friends Queue | L |

Modals: Wallet Analysis, Deposit, Create Wallets, Reset Master, Activity Log, Import Wallet (private key), Wallet Detail (Copy Key), Fee Log, Add Creator Wallet (private key), Save Token.

IPC used by index.html: window controls, `loadFile` (missing) / `loadPage`, `storage.*` (incl. keys), `updater.*`, `redis.*`, `party.*`. It does **not** use swap/tradeEngine/bundleSell/positionTracker/takeProfit/launchSync — everything happens in the renderer.

External APIs from the renderer: Helius RPC/WSS/v0 (keyed), Jupiter lite-api quote/swap + price v2, CoinGecko/Binance/Kraken SOL price fallback, DexScreener, solana.fm, pump.fun frontend API, PumpPortal trade-local, Jito block engines, local IPFS proxy, IPFS gateways.

### Design tokens (index.html 82-103; same in index-feed.html)

`--bg-primary #000000`, `--bg-secondary #050508`, `--glass-bg rgba(10,10,15,.92)`, `--glass-bg-light rgba(18,18,25,.9)`, `--glass-border rgba(212,175,55,.25)`, `--glass-border-hover rgba(212,175,55,.5)`, `--accent-primary #d4af37`, `--accent-secondary #ffd700`, `--accent-tertiary #f4e4a6`, `--accent-success #00ff88`, `--accent-danger #ff3366`, `--accent-warning #ffaa00`, `--accent-info #00d4ff`, `--text-primary #fff`, `--text-secondary rgba(255,255,255,.75)`, `--text-muted rgba(255,255,255,.4)`, `--glow-gold 0 0 30px rgba(212,175,55,.3)`, `--glow-gold-intense 0 0 50px rgba(212,175,55,.5)`, `--glow-green 0 0 20px rgba(0,255,136,.4)`, `--glow-red 0 0 20px rgba(255,51,102,.4)`. Section accents #9945ff, #00d4ff, #ff6600, #ff3366, #00ff88, #ffd700, #ff69b4.

Fonts: Orbitron 400-900 (headings, stat values), JetBrains Mono 400-700 (numbers, addresses), Inter 400-700 (body).

Classes: `.glass`, `.glass-panel`, `.app-container`, `.header`, `.sidebar`, `.nav-section`, `.nav-item`, `.main-content`, `.dashboard-layout/-main/-sidebar`, `.panel/-header/-title`, `.dash-card`, `.dash-value/label/sub`, `.stat-block/.stat-value/.stat-label/.stat-usd`, `.animated-border-wrapper`, `.btn(-primary/-success/-danger/-outline/-sm/-xs)`, `.input-group/.input-label/.input-field`, `.wallet-grid/.wallet-card`, `.leaderboard`, `.activity-feed`, `.modal-overlay/.modal`, `.progress-bar`, `.tabs/.tab`, `.token-chart-*`, `.fee-panel`, `.hud-corner`, `.scanlines`, `.live-dot`, `.spinner`. Animations: `pulse`, `borderFlow` (gold gradient border, 2 s), `modalSlide`, `spin`, `slideIn`, `flashGreen/Red/Gold/Blue`, `friendJoin`, `armedPulse`.

## B. index-feed.html — Feed-first view + CopyBot

Shell: `<style>` 81-400; title bar with top nav **DASHBOARD / TRADING / FEED / COPYBOT**; loading overlay (Pre-flight → Helius RPC → WebSocket → Services → Ready); `#feed-container` mounts `FeedFirstUI`.

FeedFirstUI (feed-first-ui.js): status bar (dot, text, SOL price, clock); layout feed 70 % / sidebar 30 %; header "🔥 Live Feed"; filters All / Buys Only / Sells Only / My Trades / Tracked; pause, sound (880 Hz buy / 440 Hz sell), clear; feed item (type, symbol, mint, wallet badge, price, mcap, liquidity, ±SOL, ~USD, time; actions Buy, 📈 chart, 👁 track); footer count + auto-scroll; max 200 items. Sidebar: ⚡ Quick Trade (0.1), 💼 Positions, 🎯 CopyBot widget, 👁 Tracking. Status states connected / connecting / reconnecting / fallback ("Polling Mode") / error / disconnected. Original parsing is a placeholder (`Math.random()` amounts) — the port uses real parsed swaps from the plugin feed.

ConnectionStateMachine: states disconnected, connecting, connected, reconnecting, error, fallback; services helius_ws (5 retries, 1 s → 30 s), helius_rpc, jupiter, dexscreener (3); backoff `min(base·2^n, max) ± 25 %`.

EnhancedCopyBotPanel ("CopyBot Pro", never mounted in the original): header WS Live/Offline + ACTIVE/OFF; stats (Wallets, Signals, Total P&L, Positions); tabs Overview / Wallets (presets Monster Bot, Monster Sub, Orca Whale, Smart Money #1, Degen Trader with risk levels + recommended settings; add custom) / Settings / Signals (≤100). Config: enabled false, dryRun true, totalCapitalSol 3; sizing fixed / percent (of target) / scaled (by confidence), max .1, min .02, percentOfTarget 10; filters minTargetSol .05, minLiquidity 1000, onlyNewTokens, maxTxAge 30 s; exit autoTpSl / followTarget / timeBased / manual, TP 50 %, SL 20 %; alerts sound/toast; advanced copyDelay 0, slippageBps 1500, maxConcurrentTrades 3, cooldownMs 5000.

Basic CopyBotPanel (copybot-panel.js): tabs Overview (Signals, Trades, Positions, P&L; Dry Run / Live), Positions, Targets, Settings (min/max SOL, max positions, slippage bps, copy delay, auto TP/SL, TP %, SL %).

## C. view-toggle.js

Terminal-only overlay "SOLATRIX DASHBOARD" (stats Total SOL/USD, Total P&L, Positions, Wallets; Wallets grid; Recent Activity; Open Positions; Quick Actions; back button) toggled by header `#open-dashboard-btn`; Launcher button `#connect-launcher-btn` (launch sync → fills `#ca-input`). Real page switching: Dashboard ↔ Trading ↔ Feed via `loadPage` / `location.href`.

## D. Strategy analyzers

v1 (loaded by index.html): Helius signatures (100/page) → `getTransaction` → swap extraction by owner token deltas (excluding wSOL/USDC/USDT/mSOL/bSOL) → group by mint → positions (avg buy/sell, hold time, realized = sellSOL − buySOL·(sold/bought), %, win, stillHolding) → exit class (`holding`, `dca_out` ≥3 sells each <40 %, `tp_moonbag` ≥2 sells first 40-80 %, `full_exit` 1 sell ≥90 %, `partial`, `mixed`) → profile (winRate, avg win/loss, profitFactor, totalPnL, expectancy = wr·avgWin + (1−wr)·avgLoss; avg/median hold, quick flips <5 min, UTC hour histogram, peak hours ≥70 % of max; sizing; exit breakdown; top 5 wins) → patterns (Scalper hold <10 min & >20 positions; Sniper >60 % held <30 min; DCA Buyer >30 % with ≥2 buys; Moonbag >30 %; High Win Rate >65 %).

v2 (Node-only, unused): disk cache 24 h; first-buyer detection; token age; sniping block; insights (High/Low win rate ≥70/<40 %, Scalper <5 min / Swing >60 min, Early Entry >30 %, New Token Hunter >50 % on tokens <1 h, Consistent Sizing σ/μ <0.3, Primary Exit, Active Hours); compare + rank score = 0.4·winRate + 0.3·(profitFactor·20) + 0.3·expectancy.

strategy-panel.js (unused): Analyze / History / Compare / Settings tabs; results cards Performance, Timing & Speed, Sniping, Sizing, Patterns, Insights, Top Wins.

## E. Launch sync / party queue / friend launch groups

launch-sync-api (main): `receiveLaunch` validate → duplicate (same mint + same launchTimestamp) → record BUYs → history json → tracker → `load-token` → notification → `launch-sync-event`.

Friends Queue (Launcher tab + party-queue-panel.js in the Terminal sidebar): Redis connect; host Generate Invite (name, max friends 5/10/20/50, expiry 15m/30m/1h/24h, bundler settings minBuy .1 maxBuy 2 slippage 25 useJito, dev-wallet trigger, exec order Simultaneous/Sequential/Random) → code/share/QR, active invites; member Join (buy amount, slippage, priority fee, wallet source Master/Single/Group/All, amount mode Per wallet/Split/Random, Jito, auto-sell TP/SL/sell %); queue stats + friend list; mode Auto / Manual; ARM (≥1 friend), Execute Now, Abort (local only). Status waiting → armed → executing → completed. Member auto-buy on `launch` message, then `reportBuy`. Spec: 6-char codes, channels `party:{code}` / `party:{code}:activity`, TTL 60 min, host-only arm/launch, one launch per party.

## F. Summary

| Section / view | Complexity | Keys in renderer (original) |
|---|---|---|
| Shell, persistence, modals | L | yes |
| Dashboard | L | yes |
| Wallets / Distribute / Collect | M | yes |
| PnL Tracker, Analytics | M / S-M | no |
| Settings | M | yes (backup/export) |
| Copy Trading | L | yes |
| Strategy RE | M | no |
| Overwatch | M | no |
| Launcher (PumpPortal, Creator fees, Monitor) | L | yes |
| Launcher (legacy/bundler/meteora/spam) | M (stubs) | no |
| Friends Queue | L | yes |
| Feed (FeedFirstUI) | M | no |
| CopyBot Pro panel | M (not mounted) | no |
| view-toggle overlay | M | no |
| Strategy v2 + panel | L (unused) | no |
| launch-sync-api | M | no |
| party-queue-panel | M | no |
