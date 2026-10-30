---
summary: "Infinitrade — first-party trading plugin: what it contains, safety model, OmniTrade migration plan, and what's left before retiring the :18911 OmniTrade gateway"
read_when:
  - You are enabling or working on the Infinitrade plugin (extensions/infinitrade)
  - You are migrating the owner's OmniTrade data or retiring the OmniTrade gateway
---
# Infinitrade

`extensions/infinitrade` is a bundled manifest-v2 plugin (id `infinitrade`,
display name "Infinitrade"). It brings the trading desk from the separate
OmniTrade gateway (the separate `InfiniBot-omnitrade` checkout, `:18911`) into
the main gateway. Like every bundled plugin it is **disabled on fresh
installs**. Turn it on in **Setup › Plugins**. Turning it off removes the
following cleanly, on the in-process restart that `plugins.setEnabled`
triggers:

- the sidebar entry and the `/infinitrade` page (a "turned off" card is shown
  instead);
- the RPCs and legacy aliases;
- the agent tools and chat panels;
- the skill and the background service.

Host APIs used or added: see [HOST-API-NEEDS.md](./HOST-API-NEEDS.md).

## What's in it

| Area | Files | Notes |
|---|---|---|
| TradeLocker client | `src/tradelocker/{math,client,demo}.ts` | Ported from the fork's `src/execution/tradelocker.ts`. Rules kept: P&L multiplier = instrument `lotSize` (XAUUSD 100, not contractSize); round-trips paired by `positionId`; candles use the numeric INFO route + `[1m,5m,15m,30m,1H,4H,1D,1W]` (hours uppercase, "1M" refused); ordersHistory has an 8 s cache + in-flight dedup + row dedup (Cloudflare 1015); quote-currency P&L converted to USD for USD-base pairs (USDJPY etc.). The fork reported yen as dollars. Crosses are flagged `pnlInUsd: false`; desk snapshot cached; 429 retried once honouring Retry-After; order POSTs never retried. Logs carry method, path and status only. |
| Secrets | `src/secrets.ts` | TradeLocker login is AES-256-GCM encrypted under `<stateDir>/plugin-data/infinitrade/secrets/` (0600/0700). Only the refresh token is persisted; access tokens stay in memory. Nothing secret is returned by any RPC. |
| Market intel | `src/intel/*` | Ported verbatim from `src/omnitrade/intel`: Google News RSS + finance lexicon sentiment, publisher RSS feed, ForexFactory calendar, TradingView calendar, Nager.Date holidays. All keyless. Pure parse entry points (`headlinesFromGoogleRss`, `econEventsFromFF`) are shared by tests and demo mode. |
| Quick scanner | `src/scanner.ts` | EMA 20/50 trend, RSI 14, ATR 14, 20-bar breakout, swing S/R, each with the reason for its vote (`infinitrade.scanner.quick`, used by the chat panel). The full confluence scanner is the ported one below. |
| Ported OmniTrade backend | `src/ot/**` | The fork's `src/omnitrade/**`, `execution/{tradelocker,solana}.ts` and its 13 `server-methods/omnitrade*.ts`, copied with the fork's directory layout so relative imports resolve unchanged. Core imports are replaced by small shims (`src/ot/{config,logging,notifications,telegram,services,agents,reports,discipline}/…`) that read host capabilities from `src/ot/host.ts` (state root = plugin data dir, logger, `runtime.host.runLLM`, notifications, Telegram out, the shared encrypted credential store). `src/ot/registry.ts` lists all 119 methods with scopes; `src/ot/register.ts` registers each as `infinitrade.<name without "omnitrade">` (`src/legacy-names.ts`) and starts the `infinitrade-trading-services` service (TradeLocker session restore → trade-archive scheduler, signal evaluator). |
| Orders (gated) | `src/orders.ts` | See the safety model below. |
| RPCs | `src/rpc.ts`, `src/ot/registry.ts` | 146 `infinitrade.*` methods (27 plugin + 119 ported), declared with scopes in the manifest. Every fork name (`journal.*`, `signals.*`, `aurum.*`, `tradelocker.*`, `market.*`, `scanner.*`, `terminal.*`, `trade.archive.*`, `research.omnitrade.*`, `personal.omnitrade.*`, `omnitrade.*`, `execution.*`) is an rpcAlias. `node --import tsx extensions/infinitrade/scripts/sync-manifest.ts` regenerates both lists; `test/ot-port.test.ts` fails on drift. |
| Chat panels | `src/panels.ts` | `infinitrade.{positions,account,trades,chart,scanner,insights,intel,calendar}`, rendered by the host's generic plugin-panel renderer (tiles/table/candles); core `show_panel` pops them as modals app-wide. |
| Agent tools | `src/tools.ts` | `infinitrade_market` (read-only), `infinitrade_panel` (show_panel for trading), and `infinitrade_order` (optional; prepares tickets only). |
| Skill + agent | `skills/infinitrade-analyst/SKILL.md`, `agents/roster.json` | The fork's OmniTrade Analyst persona as roster agent `infinitrade-analyst` (appears/disappears with the plugin) plus its skill: analysis rather than advice, fetch before quoting, label demo data. |
| Services | `index.ts`, `src/ot/register.ts` | Intel cache refresh (every 10 min, keyless sources) and the trading services (session restore, trade archive scheduler, signal evaluator). Both off in demo mode. |
| UI | `extensions/infinitrade/ui/**` (lazy chunk via `ui/src/ui/lazy-views.ts`) | `<infinitrade-view>` (light DOM): command header (trading sessions, open P&L/balance, account switcher), section tabs and the fork's screens ported verbatim under `ui/ot/` — Market Knowledge Hub, Economic Calendar, Market Scanner, Signals, Trading Terminal (default), Trading Journal, Accounts, Trading Toolkit, Indicator Studio, Personal OS, Research — plus **Connection & Safety** (connect, order permission + limits, import). `?section=<id>`. The fork's stylesheets are scoped to the page at runtime (`ui/lib/scoped-css.ts`); `ui/palette.css` declares the Infinitrade gold/black palette — the page stays the dark trading terminal in the light theme too (the fork's CSS is dark-first), while the app chrome follows the theme; `ui/lib/client.ts` maps the views' fork RPC names onto `infinitrade.*`; `ui/lib/nav.ts` maps fork routes (`/journal`, `/trading?symbol=`) onto sections. Assistant dock → `infinitrade-analyst`. |
| Import | `src/migrate.ts` | See the migration plan below. |

Config (`plugins.entries.infinitrade.config`):

- `dataMode`: `"auto"` (default) or `"demo"`. Demo means offline fixtures: no
  broker or news requests.
- `baseUrlOverride`: owner-only broker URL, e.g. the local mock at
  `extensions/infinitrade/test/mock-tradelocker.mjs`.
- `backgroundRefresh`: turns the intel refresh on or off.

## Trading safety model

1. **Read-only by default.** All market, account, intel and scan reads are
   read-scoped. With no account connected, reads return demo data tagged
   `source: "demo"`, and the UI, panels and tools label it as demo.
2. **Placing orders is a separately declared gated permission**
   (`permissions.gated: orders`).
   - It is OFF on every install, and it stays off after an import.
   - Only an admin can turn it on. The grant is the host permission
     `gated:orders` (Setup › Plugins › Infinitrade › Permissions, or the
     Infinitrade Settings switch, which calls `plugins.permissions.set`).
     While it is off the host also blocks `infinitrade.orders.prepare/
     confirm/cancel` and the `infinitrade_order` tool (they `require` it).
   - A per-order lot cap applies (default 1).
3. **Every order needs explicit confirmation from a person.**
   - `prepare` creates a single-use ticket that expires after 2 minutes.
   - `confirm` runs only from an interactive UI connection (webchat/ui, never
     an agent's backend client), only with the exact phrase
     `PLACE <SIDE> <LOTS> <SYMBOL>`, and only while the grant is still on.
   - The ticket is marked used before the network call, and the POST is never
     retried.
4. **Agents can't place orders.** `infinitrade_order` is an optional tool,
   hidden unless an allowlist names it. It only prepares tickets.
5. **The ported OmniTrade order paths are gated the same way.**
   `tradelocker.place/modify/cancel`, `execution.order.*`,
   `omnitrade.desk.execute` and `execution.solana.swap.execute` (and their
   `infinitrade.*` names) `require` `gated:orders`, and `src/ot/order-guard.ts`
   makes each of them two-phase: the first call only returns a ticket
   (summary, LIVE vs paper, phrase, 2-minute expiry); the order goes out only
   when an interactive UI connection repeats the same request with
   `confirm: { ticketId, phrase }`. The per-order lot cap applies. The UI's
   client shows the typed-phrase dialog (`ui/lib/order-confirm.ts`)
   automatically, after the fork's own review gate. Paper orders go through
   the same gate.

## Migration plan for the owner's live OmniTrade data

Source: `~/.infinibot-omnitrade/omnitrade/` (about 11 MB). It holds:

- `state.json`, `journal.json`, `accounts-meta.json`;
- `scanner-settings.json`, `scanner-last-scan.json`;
- `indicators.json`, `research-library.json`, `terminal-layouts.json`;
- `ai-insights-cache.json`, `aurum-sim.json`;
- `trade-archive.db` and `signals.db`, both in WAL mode while `:18911` runs;
- `secrets/tradelocker.json`.

The import is `infinitrade.migrate.run` / `.preview` / `.import` (Setup ›
Plugins › Infinitrade › Data importers, Infinitrade › Connection & Safety, or
an admin RPC call). It is:

- **Read-only on the source.** Files are only read. SQLite files are copied
  (db+wal+shm) to a private temp dir and snapshotted there with `VACUUM INTO`,
  so the live DB is never opened by SQLite. Tests and the side-gateway run
  assert the source bytes are unchanged.
- **Written where the screens read it.** Everything lands in the live
  `<stateDir>/plugin-data/infinitrade/omnitrade/` (the ported stores' state
  dir), so the journal, archive, signals, indicators, research library,
  layouts and settings appear in Infinitrade immediately (cached SQLite
  handles are reset after an import).
- **Never clobbers Infinitrade's own data.** JSON files Infinitrade already has
  (including defaults its screens seed) are merged — missing keys and records
  (by `id`) added, existing values kept; if shapes differ the incoming copy is
  parked in `imported/omnitrade/`. SQLite databases are merged row by row
  (`INSERT OR IGNORE` by primary key).
- **Idempotent.** A sha256 ledger (`migration.json`) makes re-runs skip
  unchanged files.
- **Dry-run by default** for `migrate.run`; `migrate.preview` is always a dry
  run.
- **Opt-in for credentials.** Imported only with `importCredentials: true` and
  only if Infinitrade has no login yet. Re-encrypted, tokens dropped, orders
  not granted.
- **Non-trading databases** (`achievements.db`, `discipline.db` from the source
  root) are snapshotted to `imported/omnitrade/` only; core Achievements and
  the Discipline plugin own that data.

Verified on 2026-09-28 against a /tmp copy of `~/.infinibot-omnitrade` on a
side gateway: dry run wrote nothing; the import brought 11 files, merged 4
(2,211 trade-archive rows, 85 signals rows, 19 indicators); a re-run skipped
all 15; the source copy's sha256s were unchanged.

Steps on the owner's machine:

1. Deploy a main-gateway build that contains this branch. Do this on a planned
   restart window; don't restart `:18789` ad hoc.
2. Setup › Plugins → enable **Infinitrade**. The gateway restarts in-process.
3. Infinitrade › Settings → **Preview** (dry run). Review the list.
4. **Import**. Tick "Also import the TradeLocker login" to move the broker
   login instead of retyping it. Re-run any time before cut-over; only changed
   files are re-copied.
5. Check Trading Terminal and Trading Journal against the OmniTrade UI for the
   same account: open P&L, closed-trade count and net P&L should match.
6. Leave **Place orders** off unless it's explicitly wanted.

This was verified on a copy only (tests use a temp copy with a real WAL-mode
SQLite file). The real `~/.infinibot-omnitrade` was never read by an import run
on this branch.

## What's left before retiring the :18911 gateway

Parity was ported on `plugin/infinitrade-parity`: every "Market Command"
screen, the fork's full RPC surface (119 methods) and its background loops.
Knowledge Hub and Personal OS are included as Infinitrade sections — in the
fork they are the market-intel hub and the daily *trading* command center.
The full before/after table is in the branch report (GAP.md).

Still open:

1. **Clock-modal trading sessions** come from `feat/control-bar-clock`
   (`contributes.clockSections`); merge it — not duplicated here.
2. **App-wide overlays and topbar chips** (HOST-API-NEEDS #12, #13): the
   Assistant drawer, the fork's panel modal, and the sessions / P&L / account
   chips live in the Infinitrade page, not the global chrome.
3. **Telegram channel ingestion** for signals (HOST-API-NEEDS #15). Paste /
   forward ingestion and Telegram *out* (alerts to `telegram.defaultChatId`)
   work.
4. **Achievements and Discipline data** — snapshot only; their owners need an
   importer (HOST-API-NEEDS #17).
5. **Alias `requires` gating** in the host (HOST-API-NEEDS #18); the plugin's
   order guard already blocks.
6. **Mobile** screens that call `omnitrade.*` / `tradelocker.*` now resolve via
   aliases, but the RN screens themselves weren't reviewed here.
7. **Before shutting down `omnitrade-gateway.service`:** run the import with it
   stopped for a final consistent snapshot, repoint any MCP/agent config that
   targets `:18911`, and archive `~/.infinibot-omnitrade` rather than deleting
   it. The fork has no trading cron jobs to move.
