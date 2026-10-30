# Solatrix parity — RPC + component contracts

Single source of truth shared by the backend (extensions/solatrix/src/parity/**)
and the UI (extensions/solatrix/ui/**). The UI talks to the backend only through
`ui/shared/api.ts`, which mirrors this file. Every method below is registered as
a gateway RPC by the plugin and declared in `infinibot.plugin.json`.

Conventions
- Amounts: SOL as decimal numbers (`amountSol`), tokens as UI units (`uiAmount`) plus `decimals` when raw units matter. Prices USD numbers. Times: ms epoch (`ts`) unless noted (`candle.time` = **seconds**, lightweight-charts UTCTimestamp).
- Slippage in the UI is a **whole-number percent** (`slippagePct`, 1–50). The server converts once: `bps = round(pct*100)`. Priority fee in **SOL** (`priorityFeeSol`), server converts to lamports once. Jito tip SOL (`jitoTipSol`).
- `scope`: read = any authenticated client; write = interactive UI only unless noted; admin = owner session (`requireOwnerSession`).
- Writes that move funds NEVER execute on prepare. They return a ticket with a `confirmationPhrase`; `solatrix.ops.confirm` executes it (interactive only). Agents keep using the existing agent tools (policy engine), never these RPCs.
- Demo data mode (`dataMode: demo`): executions are simulated (`simulated: true`, `MOCK_*` signatures) and recorded to the ledger flagged `simulated`.
- Market data mode (`marketData: auto|live|fixture`, new config, default `auto`): read-only public market data (prices, candles, trending, token trades) is live even in demo mode when `auto`/`live`; `fixture` = recorded fixtures (tests / offline). `auto` falls back to fixtures on network failure and labels `source`.

## Shared types

```ts
type Candle = { time: number /*sec*/; open: number; high: number; low: number; close: number; volume: number };
type Timeframe = "1s"|"30s"|"1m"|"5m"|"15m"|"30m"|"1h"|"4h"|"1d"|"1w";
type TokenRow = { mint: string; symbol: string; name: string; imageUrl?: string; priceUsd: number; change5m?: number; change1h?: number; change24h: number; volume24h: number; liquidityUsd: number; marketCap: number; pairCreatedAt?: number; dexId?: string; source: string };
type TokenDetail = TokenRow & { priceNative?: number; fdv?: number; pairAddress?: string; quoteSymbol?: string; change6h?: number; volume5m?: number; volume1h?: number; volume6h?: number; txns?: Record<"m5"|"h1"|"h6"|"h24", { buys: number; sells: number }>; websites?: string[]; socials?: Array<{ type: string; url: string }>; labels?: string[]; isPump?: boolean; pool?: { dex: string; pairAddress: string; baseReserve?: number; quoteReserve?: number; liquidityUsd: number; createdAt?: number } };
type MarketTrade = { signature: string; side: "buy"|"sell"; wallet: string; priceUsd: number; amountToken: number; amountSol: number; volumeUsd: number; ts: number; mint: string; symbol?: string };
type WatchItem = { mint: string; symbol: string; name: string; addedAt: number; imageUrl?: string };
type LedgerTrade = { id: string; signature: string; side: "buy"|"sell"; mint: string; symbol: string; solAmount: number; tokenAmount: number; pricePerToken: number; solPriceAtTrade: number; usdValue: number; networkFeeSol: number; priorityFeeSol: number; totalFeeSol: number; realizedPnlUsd: number|null; costBasisUsed: number|null; pnlPercent: number|null; wallet: string; ts: number; verified: boolean; simulated: boolean; source: "terminal"|"copy"|"tp"|"sl"|"launch"|"party"|"import"|"agent"; trigger?: "tp"|"sl"|"manual"|"copy"|"trailing"; triggerPrice?: number; entryPrice?: number; positionMode?: "long"|"short"; tpPrice?: number; slPrice?: number; slot?: number };
type LedgerPosition = { mint: string; symbol: string; quantity: number; costBasisUsd: number; costBasisSol: number; avgCostPerToken: number; realizedPnlUsd: number; realizedPnlSol: number; firstBuyAt: number; lastTradeAt: number; buyCount: number; sellCount: number; totalBought: number; totalSold: number; closedAt?: number; closePrice?: number; closeSignature?: string; wallets: Record<string, number> /* wallet → qty */ };
type SnapshotPosition = LedgerPosition & { currentPrice: number|null; currentValue: number|null; unrealizedPnl: number|null; unrealizedPnlPercent: number|null; tpPrice?: number; slPrice?: number; positionMode?: "long"|"short" };
type Snapshot = { positions: SnapshotPosition[]; totals: { invested: number; current: number; unrealizedPnl: number; unrealizedPnlPercent: number; realizedPnl: number; totalPnl: number; positionCount: number }; solPrice: number|null; ts: number };
type TpRule = { id: string; name: string; mint: string; symbol: string; triggerType: "price"|"mcap"|"price_percent"|"pnl_percent"|"trailing"; triggerDirection: "above"|"below"; triggerValue: number; trailingPct?: number; peak?: number; actionType: "instant_sell"|"slow_sell"|"chain"; sellMode: "percent"|"amount"|"all"; sellValue: number; slow?: { durationMinutes: number; intervalSeconds: number; randomizePercent: number }; walletMode: "all"|"main"|"selected"|"group"; walletAddresses: string[]; walletGroupId?: string; chainToRuleId?: string; chainDelaySeconds?: number; maxExecutions: number; executionCount: number; cooldownMinutes: number; lastTriggeredAt?: number; slippagePct: number; status: "active"|"paused"|"completed"|"failed"; enabled: boolean; tag?: string; createdAt: number; updatedAt: number };
type TradeTicket = { id: string; kind: "trade"|"bundle-sell"|"distribute"|"collect"|"sweep"|"party-buy"; summary: string; legs: Array<{ wallet: string; side: "buy"|"sell"|"transfer"; mint?: string; amountSol?: number; amountToken?: number; sellPercent?: number; to?: string; estOut?: string; priceImpactPct?: number; route?: string[] }>; totals: { solIn: number; solOutEst: number; feesSol: number; wallets: number }; warnings: string[]; slippagePct: number; priorityFeeSol: number; jitoTipSol: number; mode: "instant"|"slow"|"bundle"; confirmationPhrase: string; requiresTypedConfirm: boolean; expiresAt: number; network: string; simulated: boolean };
type QueueOp = { id: string; type: string; label: string; priority: number; status: "queued"|"executing"|"retrying"|"completed"|"failed"|"cancelled"|"skipped"; progress?: number; message?: string; retryCount: number; createdAt: number; startedAt?: number; completedAt?: number; mint?: string; wallets: string[]; result?: { signatures: string[]; simulated: boolean; [k: string]: unknown }; error?: string; ticketId?: string };
type AlertEvent = { id: string; type: "tp-triggered"|"sl-triggered"|"sell-executed"|"rule-triggered"|"slow-sell-progress"|"trade-buy"|"trade-sell"|"bundle-buy"|"bundle-sell"|"copy-signal"|"party"|"verification"; title: string; message: string; mint?: string; ts: number; data?: Record<string, unknown> };
```

## Market (read)
| Method | Params | Result |
|---|---|---|
| `solatrix.market.ohlcv` | `{ mint, timeframe: Timeframe, limit?: number (≤1000, def 300) }` | `{ mint, timeframe, candles: Candle[], source: "geckoterminal"|"birdeye"|"dexscreener-synthetic"|"fixture"|"cache", pool?: string, stale?: boolean }` |
| `solatrix.market.token` | `{ mint }` | `TokenDetail` |
| `solatrix.market.solPrice` | `{}` | `{ priceUsd, change24h, source }` |
| `solatrix.market.trending` | `{ limit? }` | `{ tokens: TokenRow[] }` |
| `solatrix.market.newPairs` | `{ filter?: "all"|"pump"|"raydium" }` | `{ tokens: TokenRow[] }` |
| `solatrix.market.trades` | `{ mint, limit?: number (def 50) }` | `{ trades: MarketTrade[], source }` |
| `solatrix.market.holders` | `{ mint }` | `{ mint, supply, top: Array<{ rank, account, owner?, amount, pct, tag?: "dev"|"whale"|"pool"|"burn" }>, top10Pct, flags, source }` |
| `solatrix.market.safety` | `{ mint }` | `{ top10Pct, devPct, holders, snipersPct?, insidersPct?, bundlerPct?, mintAuthorityRevoked, freezeAuthorityRevoked, lpBurnedPct?, source }` |
| existing | `solatrix.market.price/prices/candles`, `solatrix.tokens.search/feed`, `solatrix.token.get` | unchanged |

## Watchlist
| `solatrix.watchlist.get` | `{}` | `{ items: WatchItem[], updatedAt }` |
| `solatrix.watchlist.set` (write) | `{ items: WatchItem[], updatedAt }` | `{ items, updatedAt }` — also mirrors mints into `settings.watchlist` |

## Ledger (trade engine; read unless noted)
| `solatrix.ledger.trades` | `{ mint?, side?, wallet?, since?, until?, verified?, limit? (def 100, ≤1000), offset? }` | `{ trades: LedgerTrade[], total }` |
| `solatrix.ledger.positions` | `{ status?: "open"|"closed"|"all" }` | `{ positions: LedgerPosition[] }` |
| `solatrix.ledger.snapshot` | `{ force?: boolean }` | `Snapshot` |
| `solatrix.ledger.stats` | `{}` | `{ today: { trades, buys, sells, volumeSol, volumeUsd, realizedPnlUsd, feesSol }, allTime: { trades, volumeSol, volumeUsd, realizedPnlUsd, feesSol, winRate, wins, losses }, positions: { open, closed } }` |
| `solatrix.ledger.forceClose` (write) | `{ mint, reason? }` | `{ ok, position }` |
| `solatrix.ledger.verifyStale` (write) | `{}` | `{ checked, closed: string[] }` |
| `solatrix.ledger.recalculate` (write) | `{ mint? }` | `{ positions: number }` |
| `solatrix.ledger.export` | `{}` | `{ version: "solatrix-ledger-v1", trades, positions, exportedAt }` |
| `solatrix.ledger.clear` (admin) | `{ confirm: "CLEAR LEDGER" }` | `{ backup: string }` |

## Trading (write; tickets)
| `solatrix.trade.prepare` | `{ side, mint, mode, wallets: string[], amountSol?, sellPercent?, amountToken?, slippagePct, priorityFeeSol, jitoTipSol?, slow?: { intervalSec, batchSize, randomPct }, levels?: { type: "long"|"short", entry, tp?, sl? }, source?: "terminal"|"dashboard"|"feed"|"levels"|"position" }` | `TradeTicket` |
| `solatrix.trade.bundleSell.prepare` | `{ mint, sellPercent, wallets?: string[], slippagePct, priorityFeeSol, minUsdValue?, filterDust?, instant? }` | `TradeTicket` (legs per wallet with balance) |
| `solatrix.ops.confirm` | `{ ticketId, phrase }` | `{ opId, queued: true }` |
| `solatrix.ops.cancel` | `{ ticketId }` | `{ cancelled }` |
| `solatrix.tradeQueue.status` (read) | `{}` | `{ paused, executing: QueueOp[], queued: QueueOp[], recent: QueueOp[], locks: { wallets: string[], mints: string[] } }` |
| `solatrix.tradeQueue.cancel` / `.priority` / `.pause` / `.resume` / `.clear` | `{ opId? , priority? }` | status |
| `solatrix.trade.limits.get` (read) / `.set` (admin) | `{ maxSolPerTrade, dailyCapSol, maxWalletsPerBundle, typedConfirmAboveSol }` | limits — UI trades honour these (defaults 1 SOL / 5 SOL / 20 / 0.5 SOL; typed phrase always on mainnet) |
| `solatrix.wallets.scan` (read) | `{ mint? }` | `{ wallets: Array<{ address, label, group, sol, tokenBalance?, decimals?, canSell }>, totalTokens }` |

## Take profit / stop loss
| `solatrix.tp.rules` | `{ mint? }` | `{ rules: TpRule[] }` |
| `solatrix.tp.rules.create` (write) | `Partial<TpRule>` (mint, triggerType, triggerDirection, triggerValue required) | `TpRule` |
| `solatrix.tp.rules.update` (write) | `{ id, patch: Partial<TpRule> }` | `TpRule` |
| `solatrix.tp.rules.delete` / `.toggle` (write) | `{ id }` / `{ id, enabled }` | `{ ok }` / `TpRule` |
| `solatrix.tp.history` | `{ ruleId?, limit? }` | `{ entries: Array<{ id, ruleId, mint, triggerValue, actualValue, action, sellAmount, solReceived, usdValue, wallet, signature, status, ts }> }` |
| `solatrix.tp.slowSells` / `.stop` | `{}` / `{ id }` | `{ sells: Array<{ id, ruleId, mint, total, sold, remaining, batchesCompleted, batchesTotal, status, nextAt }> }` |
| `solatrix.tp.groups` / `.create` / `.update` / `.delete` | … | `{ groups: Array<{ id, name, description, walletAddresses }> }` |
| `solatrix.tp.stats` | `{}` | `{ active, paused, completed, triggeredToday, slowSellsActive }` |

Execution: rules are armed by an interactive owner (creation = consent). The engine only ever **sells**, only while the `gated:swaps` permission is on, only within trade limits, via the trade queue at CRITICAL priority. Fixes the original's bugs (price source, double execution count, per-wallet decimals).

## Position modes
| `solatrix.positionMode.get` | `{ mint }` | `{ mint, mode: "long"|"short"|null, entry, tpPct, slPct, tpSellPct, slSellPct, trailing, autoExecute, notifications, slippagePct, tpPrice, slPrice, ruleIds: string[] }` |
| `solatrix.positionMode.set` (write) | `{ mint, mode, entry?, tpPct, slPct, tpSellPct, slSellPct, trailing?, autoExecute?, notifications?, slippagePct? }` | same (creates/updates tagged TP/SL rules; trailing ⇒ `trailing` rule) |
| `solatrix.positionMode.close` (write) | `{ mint }` | `{ removedRules }` |

## Alerts
| `solatrix.alerts.get` / `.set` | settings `{ enabled, desktopNotifications, soundAlerts, soundVolume, showToasts, tpSound, slSound }` |
| `solatrix.alerts.test` | `{ type }` → emits a test AlertEvent |
| `solatrix.alerts.feed` | `{ since?: number }` → `{ events: AlertEvent[], now }` (UI polls every 2 s; shows toasts + WebAudio tones) |

## Chain verification (read)
| `solatrix.chain.verifyTrade` | `{ signature, wallet? }` | `{ verified, signature, slot, blockTime, type: "buy"|"sell"|"unknown", inputMint, outputMint, inputAmount, outputAmount, fee, protocol, method: "rpc"|"helius"|"fixture" }` |
| `solatrix.chain.tokenBalances` | `{ wallet }` | `{ wallet, sol, tokens: Array<{ mint, uiAmount, decimals, program: "spl"|"token-2022" }> }` |
| `solatrix.chain.verifyPositions` | `{ pairs: Array<{ wallet, mint }> }` | `{ results: Record<string /*wallet:mint*/, { isClosed, balance, reason }> }` |
| `solatrix.chain.recover` (write) | `{ wallet?, sinceHours? }` | `{ found, recorded }` (reconcile swaps into the ledger, verified) |
| existing | `solatrix.chain.verify`, `solatrix.chain.reconcile` | unchanged |

## Discovery / feeds (read)
| `solatrix.feed.live` | `{ mints?: string[], wallets?: string[], filter?: "all"|"buys"|"sells"|"mine"|"tracked", limit? }` | `{ items: Array<MarketTrade & { tracked?: boolean; mine?: boolean; marketCap?: number; liquidityUsd?: number }>, status: "connected"|"polling"|"fallback"|"error", solPrice }` |
| `solatrix.tracked.get` / `.set` (write) | `{ wallets: Array<{ address, label, addedAt }> }` | same — Track panel / Monitor / Feed "tracked" |
| `solatrix.monitor.activity` | `{ wallets?: string[], limit? }` | `{ items: Array<{ wallet, label, signature, type: "swap"|"transfer"|"other", mint?, symbol?, side?, amountSol?, ts }> }` |
| `solatrix.overwatch.analyze` | `{ mint, limit? }` | `{ token: TokenDetail, trades: MarketTrade[], wallets: Array<{ address, buys, sells, buyVolSol, sellVolSol, pnlSol, trades, score, tags: string[], firstSeen, lastSeen }>, alerts: Array<{ type: "BOT"|"WHALE"|"DUMPER"|"SNIPER", wallet, detail, ts }>, stats: { buys, sells, wallets, volumeSol } }` |
| `solatrix.overwatch.saved.get` / `.set` (write) | `{ wallets: Array<{ address, label, tags, note }>, tokens: string[] }` | same |
| `solatrix.hawkeye.scan` | `{ mint, minUsd?: number (10000), whaleUsd?: number (50000) }` | `{ signals: Array<MarketTrade & { whale: boolean }>, stats: { signals, whales } }` |
| `solatrix.strategy.analyze` | `{ wallet, maxTransactions?: number (300), lookbackDays?: number (30), detectFirstBuyer?: boolean, forceRefresh?: boolean }` | `StrategyProfile` (performance, timing, sizing, exits, patterns, insights, topWins, positions, sniping?) |
| `solatrix.strategy.saved` / `.delete` / `.compare` | `{}` / `{ wallet }` / `{ wallets }` | saved profiles / `{ rankings, byWinRate, bySpeed, byVolume }` |

## Wallet operations (write; tickets unless noted)
| `solatrix.wallets.groups` (read) / `.groups.set` (write) | `{ groups: Array<{ id, name, description, color?, walletAddresses }> }` |
| `solatrix.wallets.bulkGenerate` (interactive) | `{ count (1-50), prefix, group }` | `{ created: string[] }` (keys encrypted server-side, never returned) |
| `solatrix.wallets.meta.set` (write) | `{ address, label?, group?, role? }` | wallet |
| `solatrix.distribute.prepare` | `{ from, to: string[], mode: "equal"|"fixed"|"random", amountSol?, totalSol?, keepSol? }` | `TradeTicket` (transfer legs; `gated:transfers`) |
| `solatrix.collect.prepare` | `{ from: string[], to, keepSol? (0.002), sellTokens?: boolean }` | `TradeTicket` |
| `solatrix.sweep.prepare` | `{ asset: "sol"|"spl", mint?, from: string[], to }` | `TradeTicket` |
| (existing) `solatrix.transfer.prepare/confirm` | withdraw to an external address (cloud: allowlist only) |

## Fees
| `solatrix.fees.get` / `.set` (write) | `{ mode: "auto"|"speed"|"manual", manualPriorityFeeSol, manualComputeUnits, profiles: Array<{ id, name, jitoTipSol, microLamports, computeUnits, builtin? }>, activeProfile, presets: { slippage: number[], priority: number[], jito: number[] } }` |
| `solatrix.fees.estimate` (read) | `{}` | `{ lowSol, mediumSol, highSol, turboSol, source }` (getRecentPrioritizationFees) |
| `solatrix.fees.log` (read) | `{ limit? }` | `{ entries: Array<{ ts, signature, feeSol, priorityFeeSol, kind }>, totalSol, count, avgSol }` |

## Copy trading (extends existing `solatrix.copy.*`)
Rules gain (additive; existing fields unchanged): `mode: "signal"|"copy"` (def signal), `dryRun` (def true), `sizingMode: "fixed"|"percent"|"scaled"` (def fixed), `fixedSol`, `percentOfTarget`, `minSolPerTrade`, `copyBuys`, `copySells`, `autoSellPercent: 100|75|50|"mirror"`, `exitStrategy: "autoTpSl"|"followTarget"|"timeBased"|"manual"`, `autoSellAfterMinutes?`, `minTargetSol`, `onlyNewTokens`, `maxTxAgeSec`, `maxConcurrentTrades`, `cooldownMs`, `copyDelayMs`, `slippagePct`, `buyWallet`, `walletLabels: Record<address,label>`, `perWallet: Record<address, Partial<rules>>`.
| `solatrix.copy.presets` | `{}` | `{ presets: Array<{ id, name, emoji, address, risk: "low"|"medium"|"high"|"critical", description, recommended }> }` |
| `solatrix.copy.signals` | `{ since?, limit? }` | `{ signals: Array<{ id, wallet, label, side, mint, symbol, amountSol, confidence: "LOW"|"MEDIUM"|"HIGH", ts, signature, action: "signal"|"copied"|"skipped"|"dry-run", reason? }>, monitoring: { state, wallets, lastPollAt, mode } }` |
| `solatrix.copy.positions` | `{}` | `{ positions: Array<{ mint, symbol, wallet, entrySol, tokens, entryPrice, currentPrice, pnlPct, tpPct, slPct, openedAt, sourceWallet }> }` |
| `solatrix.copy.sellAll` (write) | `{}` | `TradeTicket` |

## Launch / party / sync
| `solatrix.launch.*` existing + `solatrix.launch.history` (read) `{ runs: Array<{ id, name, symbol, mint?, status, spentSol, wallets, ts, signatures }> , totals }`, `solatrix.launch.creatorFees` (read) `{ wallet }` → `{ tokens: Array<{ mint, symbol, unclaimedSol }> , totalSol }`, `solatrix.launch.claimFees.prepare` (write) → `TradeTicket`, `solatrix.launch.meteoraConfig` (read) → `{ config, url }` |
| `solatrix.sync.status` / `.all` / `.forMint` / `.clear` | launch-sync history (launches auto-recorded into the ledger + tracker) |
| `solatrix.party.create` | `{ name, maxMembers (5-50), ttlMinutes (15-1440), settings: { minBuySol, maxBuySol, slippagePct, execOrder: "simultaneous"|"sequential"|"random", buyDelayMs } }` | `Party` |
| `solatrix.party.join` / `.leave` / `.get` / `.updateMember` / `.arm` / `.launch` / `.activity` | `{ code, … }` | `Party` = `{ code, name, status: "waiting"|"armed"|"executing"|"completed"|"expired", hostMemberId, members: Array<{ id, name, wallet, buySol, status: "ready"|"completed"|"failed", signature? }>, settings, launchedMint?, expiresAt, activity: Array<{ ts, text }> }` — local relay only (see parity doc) |

## Settings / data
| `solatrix.data.export` (read) | `{}` | non-secret export `{ version: "solatrix-export-v1", settings, watchlist, ledger, tpRules, groups, tracked, overwatch, strategy }` |
| `solatrix.data.import` (admin) | `{ data }` | `{ imported }` (never keys) |
| `solatrix.demo.generateTrades` (write, demo mode only) | `{ count }` | `{ created }` |

## UI components
- `<solatrix-chart>` (`ui/chart/solatrix-chart.ts`): props `client`, `mint`, `symbol`, `timeframe` (def from settings, "15m"), `variant: "terminal"|"compact"`; methods `refresh()`, `fitContent()`, `scrollToRealtime()`, `screenshot()`, `setChartType()`, `startLevels("long"|"short")`; events (bubbling, composed): `solatrix-chart-timeframe {timeframe}`, `solatrix-chart-crosshair {open,high,low,close,time}`, `solatrix-chart-trade {side:"buy"|"sell", levels, mode, wallets}`, `solatrix-chart-levels {levels}`. Persists drawings per mint + settings via `solatrix.chart.state.get/set` (`{ settings, drawings: {[mint]: Drawing[]}, levels: {[mint]: Levels} }`). Compact variant = control-bar panel: timeframe row + chart + drawing toolbar (collapsible) + chart settings; no LONG/SHORT overlay.
- `<solatrix-trade-review>` (`ui/shared/trade-review.ts`): shows a `TradeTicket`; requires typing the phrase when `requiresTypedConfirm`; Enter/Confirm → `solatrix.ops.confirm`; emits `solatrix-trade-confirmed {opId}` / `solatrix-trade-cancelled`.
- Shared state: `ui/shared/bus.ts` — current token (`solatrix:token` event, persisted per profile), `loadToken(mint)`, queue/alert pollers.
