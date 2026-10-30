# Original Solatrix Terminal — backend service inventory (porting reference)

Source: local working copy of `MrYungCEO/solatrix-terminal`
(`infini-data/solatrix-terminal`, including uncommitted edits). Line refs are
`main.js` unless noted. Secret values are redacted; this document only records
where they lived so the port can avoid them.

## 0. Headline findings

1. **Keys stored in plaintext** — `solatrix-data/solatrix-main.json` holds `masterWallet` + `subWallets` (base58 64-byte secrets); `loadWalletKeypairs()` (L2110) decodes them on every swap/transfer. No encryption. The renderer (`trading-panel.js:2257-2341`) also decodes keys. **Port:** keys live only in the plugin's `EncryptedWalletStore`; signing is server-side by wallet address.
2. **Hard-coded secrets** — a Helius API key (main.js L2033/2061/2123, copybot-engine.js:22, connection-state-machine.js:42, renderer files) and a Redis Cloud URL with inline password (L3717). **Port:** none carried over; RPC comes from the plugin's BYOK/config/platform chain; the launch party relay uses the gateway, not Redis.
3. **Main-process DEX = Jupiter Lite v1 with PumpPortal fallback; no Jito in main.** Jito `sendBundle` only exists in renderer `index.html` (launcher). Backend "bundle buy/sell" = N independent Jupiter swaps in parallel chunks.
4. **Take-profit engine never fires** — `TakeProfitEngine.getPriceData()` calls a non-existent `positionTracker.getSolPrice()`; `mcap` never cached. Further bugs §2.6. **Port fixes them.**
5. `trade-wait-and-record` (L1408) is broken (`ipcMain.listeners` on a handle channel).
6. CopyBot is not wired into Electron main (renderer `<script>` + `require()` with contextIsolation); only runs via `monitor-cli.js`/pm2, default `dryRun: true`.
7. Unused: `mobile-server.js`; renderer-only: `tp-sl-alerts.js`, `trade-sync.js`, `trade-verification-helper.js`, `token-price-service.js`, `position-mode-manager.js`.
8. User data dir has only `solatrix-main.json` (+ backups); SQLite engines never initialised on this machine.

## 1. IPC channels (151 registrations; preload exposes `window.electron.*`)

| Namespace | Channels | Signs? | Persist |
|---|---|---|---|
| alerts | alert-settings-get/set, alert-test, notification-test-simple | n | alert-settings.json. Defaults `{enabled, desktopNotifications, soundAlerts, soundVolume:.7, tpSound:'success', slSound:'warning', showToasts}` |
| queue | queue:status, operation-status, cancel, priority, pause, resume, clear, wallet-locked, mint-locked, constants | n | memory |
| queue writes | queue:swap-execute (NORMAL, slippage %·100, def 1%), queue:bundle-buy (HIGH, concurrency 5, 200 ms chunks), queue:bundle-sell (sellPercent def 100, skip SOL<0.002, slippage def 15%, lock by mint), queue:tp-sl-execute (CRITICAL, def 15%) | **y** | — |
| trade engine | trade-record-buy/sell, record-verified (verify ≤10×2 s), wait-and-record (broken), exists/get/get-recent(50)/get-all(filter), position-get/-active/-all, pnl-unrealized/total/realized, today/volume/engine stats, import-legacy, export-all, mark-verified, get-unverified, recalculate-positions, check-migration-needed, clear-all (backup first), force-close, verify-stale | n | solatrix-trades.db |
| position/price | position-tracker-init, positions-snapshot, position-pnl, price-cached, prices-all-cached, price-get(maxAge 5000), prices-batch, tracker add/remove/sync, sol-price, tracker stats/configure/stop | n | memory |
| take-profit | init, create/update/delete/toggle rule, get-all, get-for-mint, history(50), active slow sells, stop slow sell, wallet groups CRUD, stats | indirect **y** | solatrix-takeprofit.db |
| launch sync | sync:receiveLaunch, getStatus, confirmReceipt, getSyncForMint, getAllSyncs, clearSyncForMint | n | launch-sync-history.json + trades |
| wallet/rpc | get-wallet-cache, rpc-get-balance, rpc-get-multiple-balances, get-token-balances (Token-2022 aware; subs in batches of 10) | n | wallet-cache.json |
| swap/transfer | swap-execute (direct, toBps(slippage‖25)), swap-execute-batch, transfer-sol-to-wallet (master→sub, needs amt+5000 lamports), transfer-sol (wallet→wallet), transfer-sol-external (wallet→address, 1-based index, CU price = priorityFee, 10000 lamport buffer) | **y** | — |
| bundle sell | bundle-sell-scan-wallets (`{walletIndex,address,tokenBalance,solBalance,isMaster,canSell: sol≥0.002}`), bundle-sell-execute | scan n / execute **y** | — |
| redis/party | redis-connect/disconnect/status, party-create (6-char code w/o I O 0 1, TTL 60 min, max 20 members; waiting→armed→executing→completed), join (def buy .5), leave, get, update-member, launch (host only), arm, send-activity, report-buy | n (members buy client-side) | Redis |
| storage | save (20 timestamped backups), load, save-verified (checksum + .bak), load-safe, emergency-sync, list/restore backups, export/import-all (`solatrix-export-v1`), info, saveOnClose | n | `<key>.json` (solatrix-main **contains keys**) |
| update | version/config/check-github/download/progress/open-installer/open-downloads/clean/check-git/apply-git (**git pull + npm install**)/check-url/restart/changelog | n | — |
| chain-verifier | configure, verify-trade, reconcile-wallet, queue-trade-verification, process-pending, stats, is-swap-transaction, get-program-ids, get-token-balance, verify-position-closed (dust 1e-6), batch-verify-positions, get-all-token-balances, start/stop jobs, set-wallets | n | memory |
| window/page | window-minimize/maximize/close, log-message, window-is-maximized, load-page (index / index-trading / index-feed), get-current-page, proxy-pump-ipfs (POST pump.fun/api/ipfs; local proxy 127.0.0.1:19191) | n | — |

Dead preload calls used by the renderer: `wallet.{import,getAll,generate,getPrivateKey,export,distribute,create,collect}`, `tradeEngine.{executeBuy,closePosition,getOpenPositions}`, `trade.getTrades`.

Main → renderer events: `trade-queue-progress` (`{event: queued|executing|progress|retrying|completed|failed|cancelled|priority-changed, operation{…}, queueSize, executingCount, message?, progress?, result?, error?}`), `trade-executed`, `tp-sl-alert`, `take-profit-event` (rule-triggered | sell-executed | slow-sell-progress | slow-sell-stopped | position-closed), `position-closed`, `positions-update` (1 s), `price-update` (>0.1 % move), `bundle-progress` (starting|validating|checking-balances|validation-warning|scanning|ready|executing|complete|error), `sol-transfer-complete`, `load-token`, `launch-sync-event`, `launcher-token-received`, `chain-verification-event`, `verification-batch-complete`, `reconciliation-complete`, `reconciliation-request-wallets`, `redis-status`, `party-message`, update/lifecycle.

## 2. Engines

### 2.1 trade-queue.js
- `PRIORITY {LOW:1, NORMAL:5, HIGH:10, CRITICAL:20, EMERGENCY:100}`; `OP_TYPE {bundle_buy, bundle_sell, quick_buy, quick_sell, instant_buy, instant_sell, tp_execute, sl_execute, transfer}`; `STATUS {queued, executing, retrying, completed, failed, cancelled, skipped}`.
- Defaults: `maxConcurrent 1`, `maxRetries 3`, `baseRetryDelayMs 1000`, `maxRetryDelayMs 30000`, `operationTimeoutMs 120000`; completed purged after 5 min (60 s sweep).
- `enqueue(fn, {priority,label,type,mint,wallets[],skipDuplicateCheck,metadata}) → {id,status,promise,queuePosition}`; id `${type}_${Date.now()}_${rand6}`.
- Wallet lock: any locked wallet ⇒ SKIPPED `WALLET_LOCKED`. Mint lock: locked and `priority <= holder` ⇒ SKIPPED `MINT_LOCKED`; higher priority overrides.
- Order: priority desc, createdAt asc. `fn(ctx)` gets `{opId, retryCount, isCancelled(), emitProgress(msg,pct)}`, raced against timeout.
- Retry backoff `min(1000·2^(n−1), 30000)`. Never retry: 'Insufficient SOL', 'insufficient lamports', '0x1', 'Token account not found', 'wallet not found', 'Quote validation failed', cancelled. Always retry: 'Rate limited', 429, timeout, ECONNRESET, ETIMEDOUT, network, 500/502/503/504. Else retry once.
- Cancel: queued → removed + rejected; executing → flagged (`isCancelled()`).

### 2.2 trade-engine.js (PnLEngine) + trade-storage.js
- SQLite `trades` (PK signature; type buy|sell; sol_amount, token_amount, price_per_token, sol_price_at_trade, usd_value, network/priority/total fee sol, total_fee_usd, realized_pnl, cost_basis_used, pnl_percent, wallet_address/index, slot, block_time, verified, verification_error, timestamp, confirmed_at + trigger, trigger_price, entry_price, position_mode, tp_price, sl_price), `positions` (PK mint — aggregated across wallets; total_cost_basis_usd/sol, quantity, avg_cost_per_token, realized_pnl_usd/sol, first_buy_at, last_trade_at, buy/sell counts, total bought/sold, close_price, closed_at, close_signature), `daily_summaries`.
- **Average cost.** Buy: `costUsd = solAmount × solPriceAtTrade`; basis += cost; `avg = basisUsd/qty`. Sell: `sellQty = min(tokenAmount, qty)`, `pct = sellQty/qty`, `costBasisUsed = basisUsd·pct`, `realized = solAmount·solPrice − costBasisUsed`, `pnlPercent = realized/costBasisUsed·100`; close when qty ≤ 1e-6. Sell without position ⇒ full proceeds as profit (100 %). Fees recorded, not in basis/PnL. Dedup by signature (`{duplicate:true}`).
- Unrealized `qty·price − basisUsd`, percent clamped [−99.99, 999999], requires basis > 0.0001. `getTotalPnl` roi = total/(basis+|realized|).
- Also `forceClosePosition`, `verifyAndCloseStalePositions`, `recalculatePositions`, `importLegacyData`, `exportAll`, `getStats`, `clearAllData`, integrity check/repair.

### 2.3 pnl-calculator.js
`MAX_PNL_PERCENT 999999`, `MIN_PNL_PERCENT −99.99`, `MAX_PNL_USD 1e8`, `MIN_COST_BASIS 0.0001`, `MIN_PRICE 1e-10`, `MIN_QUANTITY 1e-6`. `unrealized(cur, entry, qty, costBasis?, {feesUsd})` → `{usd, percent, currentValue, costBasis, valid}` (price-based percent minus fees/basis). `realized(sellPx, avgBuyPx, qty, costBasisUsed?, {feesUsd})`. `portfolioTotal(positions)`. Formatters incl. `formatPrice` with subscript zeros.

### 2.4 position-tracker.js
DexScreener single `latest/dex/tokens/<mint>` and multi `tokens/v1/solana/<a,b>` (≤30/chunk); fallback pump.fun then Jupiter v4 price (deprecated). 300 req/60 s, min 200 ms interval. Cache TTL 3000 ms; SOL price 10 s. Batch refresh 5 s, broadcast 1 s. Snapshot `{positions[{mint,symbol,quantity,avgCostPerToken,currentPrice,currentValue,costBasis,unrealizedPnl,unrealizedPnlPercent,realizedPnl,buyCount,sellCount,lastTradeAt}], totals{invested,current,unrealizedPnl,unrealizedPnlPercent,realizedPnl,totalPnl,positionCount}, solPrice, timestamp}`; sorted by value, cached 500 ms.

### 2.5 take-profit-engine.js + storage
- Rules: `trigger_type price|mcap|pnl_percent|price_percent`, `trigger_direction above|below`, `trigger_value`, `action_type instant_sell|slow_sell|buy|chain`, `sell_mode percent|amount|all`, `sell_value`, slow sell (`duration_minutes` def 30, `interval_seconds` def 30, `randomize_percent` def 10), `wallet_mode all|main|selected|group`, `wallet_addresses`, `wallet_group_id`, `chain_to_rule_id`, `chain_delay_seconds`, `max_executions` (def 1), `execution_count`, `cooldown_minutes`, `last_triggered_at`, `status active|paused|completed|failed`. Tables `slow_sell_progress`, `tp_execution_history`, `wallet_groups` (`wg_<ts>_<rand>`). Rule ids `tp_<ts>_<rand6>`.
- Loop every 2 s: cooldown, `executionCount >= maxExecutions ⇒ completed`; values: price USD, mcap, `price_percent = (price−avgCost)/avgCost·100`, `pnl_percent = (qty·price−basis)/basis·100`; `>=` above / `<=` below. No trailing, no multiplier.
- instant_sell amount: percent → qty·v/100, amount → min(v, qty), all → qty. slow_sell: `batchCount = ceil(dur·60/interval)`, `batch = total/batchCount`, ×(1 ± rand %), first batch immediate, stop at count or 99 % sold, then chain. chain: run target rule after delay. `buy` unimplemented.
- Alerts: `rule-triggered` → `sl-triggered` when direction below else `tp-triggered`.

### 2.6 TP bugs fixed by the port
`getSolPrice` missing; `execution_count` double-increment + stale in-memory rules; sells aggregate qty from one wallet with a decimals mismatch; `positionMode` not stored.

### 2.7 PositionModeManager (renderer)
Modes long/short; entry = current price; long `tp = entry·(1+tp%)`, `sl = entry·(1−sl%)`, short inverted; defaults tp 10 %, sl 10 %, sell 100 %, slippage 25; localStorage `solatrix_position_mode`; 500 ms check; on hit records a synthetic sell only (no swap); also creates backend TP rules.

### 2.8 chain-verifier.js
PROGRAM_IDS: Jupiter v6/v4, Raydium AMM/CPMM/CLMM, Orca Whirlpool, Meteora DLMM, Token, Token-2022, System, WSOL (**pump.fun missing — port adds it**). Helius 100/min, RPC 40/min. `verifyTrade(sig)`: Helius enhanced tx (if key) else RPC `getTransaction(jsonParsed, v0)`; `isSwapTransaction`; parse → `{success, verified, method, signature, slot, blockTime, type, inputMint, outputMint, inputAmount, outputAmount, fee, protocol}`. RPC parse = pre/post token balance deltas + SOL delta of account[0] with fee added back (±0.001 SOL). **Not filtered by owner — port filters by owner.** `reconcileWallet(addr, since)`. Pending queue (10 attempts, 30 s). Balance helpers (dust 1e-6). Jobs: verify every 30 s, reconcile every 5 min.

### 2.9 launch-sync-api.js
Input `{token{mint,name,symbol,image,uri}, trades[{wallet,walletIndex,amount,tokenAmount,price,signature,timestamp,tpPrice,slPrice,verified}], totalInvested, launchTimestamp, bundleSize}`; validate; duplicate = same mint + same launchTimestamp; record each trade as BUY; `launch-sync-history.json`.

### 2.10 copybot-engine.js
Defaults `network mainnet, dryRun true, maxPositionSol .1, minPositionSol .02, maxPositions 15, totalCapitalSol 3, copyBuys true, copySells false, onlyNewTokens true, minTargetSol .05, maxTxAge 30, copyDelay 0, slippageBps 1500, defaultTakeProfitPercent 50, defaultStopLossPercent 20, enableAutoTpSl false, useWebSocket, pollIntervalMs 1000, priceCheckIntervalMs 5000`. Monitor logsSubscribe/polling; BUY when target token Δ>0 and SOL Δ < −minTargetSol; ignore USDC/USDT/wSOL/mSOL/bSOL/stSOL; confidence HIGH >0.5 SOL, MEDIUM >0.1. Size `maxPositionSol × (0.5|0.75|1)`, `min(size, targetSol × totalCapital/1000 × 10)`, clamp [min,max].

### 2.11 trading-constants.js
`SLIPPAGE` DEFAULT 25, MIN 1, MAX 50, presets 5/15/25/50, `toBps`, `fromBps`, `validate`. `PRIORITY_FEE` DEFAULT_SOL .001, range .0001–.01, `DEFAULT_MICRO_LAMPORTS 50000`, `TYPICAL_COMPUTE_UNITS 200000`. `TRADING_DEFAULTS` slippage standard 15 / pumpFun 25 / emergency 50 / TP 10 / copy 15; priorityFee .001/.002/.005, bundle .0005; jitoTip .0001/.0005/.001.

## 3. Swap paths
- `executeJupiterSwap`: lite-api quote → PumpPortal on "not tradable / no route" → validate (outAmount>0, priceImpact ≤10 %) → `/swap` `{wrapAndUnwrapSol, prioritizationFeeLamports, dynamicComputeUnitLimit}` → sign → send (preflight, resend skipPreflight) → confirm 60 s → actual output check (warn <85 %). No MEV/Jito.
- Batch buy: chunks of 5, 200 ms; needs `SOL ≥ amount + .005`; `executeSwapWithRetry` 3 attempts 1/2/4 s.
- Bundle sell: `{sellPercent 100, slippage 15, minUsdValue .10, filterDust, instant}`, concurrency 10, stagger 50 ms·i, 500 ms chunks, retries 2.
- Units bugs: PumpPortal `priorityFee` max(fee, 2,000,000) sent as SOL; slippage entry points inconsistent (toBps 25 % vs %·100 def 1 %). **Port standardises to one slippage/priority model (see SOLATRIX-PARITY.md).**
- Renderer-only Jito bundle (index.html) fee presets: fast (tip .001, 50k µLamports, 400k CU), turbo (.005, 100k, 600k), ultra (.01, 200k, 800k).

## 4. External URLs (backend)
Helius RPC/WS/enhanced API (key redacted), `api.mainnet-beta.solana.com`, Jupiter lite-api quote/swap (+ deprecated price v4), `pumpportal.fun/api/trade-local`, `pump.fun/api/ipfs`, `frontend-api.pump.fun/coins/<mint>`, DexScreener token endpoints, Redis Cloud (password redacted), GitHub releases/raw, DNS-over-HTTPS, local proxy :19191.

## 5. Keys
`solatrix-main.json` (+ `.bak`, 20 timestamped backups, emergency `<appDir>/data/*-sync.json`) — plaintext base58. `storage-export-all` returns them to the renderer. **Port rule:** keys never leave `EncryptedWalletStore`; the import path in Solatrix › Wallets is the only way in; legacy import never copies keys.
