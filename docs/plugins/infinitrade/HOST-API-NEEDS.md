---
summary: "Core/host plugin APIs Infinitrade needed: what was added on plugin/infinitrade (v0) and what is still missing"
read_when:
  - You are changing the plugin host (manifest v2, registry, loader, chat panels)
  - You are rebasing plugin/infinitrade onto a newer feat/plugin-platform-design
---
# Infinitrade — host API needs

Infinitrade was built against the manifest-v2 plugin host from
`feat/plugin-platform-design` (9a95f690, eff5fafb), which is treated as **v0**
and may still change. This file lists every host capability the plugin uses.
It covers:

- what already existed;
- what had to be **added** (commit 7fe636f2 plus the UI wiring commit);
- what is still **missing** (the plugin works around these today).

## Used as-is (already in the v2 host)

| Capability | Used for |
|---|---|
| `manifestVersion: 2`, `engines["infinibot-plugin-api"]: "^2.0.0"` | API compatibility gate |
| `contributes.nav` / `contributes.pages` (`builtin`) + UI `FIRST_PARTY_PAGES` gating | Sidebar entry and the `/infinitrade` page exist only while the plugin is loaded |
| `contributes.rpc` with `read`/`write`/`admin` scopes → `resolvePluginMethodScope` | 24 `infinitrade.*` methods. Credentials, grants and migration are `admin` |
| `plugins.setEnabled` + in-process restart; Setup › Plugins toggle | Enable/disable from the UI |
| Bundled plugins are disabled by default (`BUNDLED_ENABLED_BY_DEFAULT` is empty) | "Disabled on fresh installs" |
| `api.registerTool(tool, { optional: true })` | `infinitrade_order` is never auto-exposed |
| `api.registerService` | Background intel refresh, stopped on disable |
| Manifest `skills: ["skills"]` → `resolvePluginSkillDirs` (only while enabled) | `infinitrade-analyst` skill |
| `api.runtime.state.resolveStateDir()` | Per-plugin storage root |

## Added on this branch (host API v0 — review before merge)

All of these are additive and backwards-compatible. v1 manifests and v2
manifests that don't use the new fields behave exactly as before. Tests are in
`src/plugins/manifest-v2-contributions.test.ts`.

1. **`contributes.tools: string[]`.** `registerTool` rejects any tool name the
   manifest didn't declare. The rejection is a diagnostic and the tool is not
   registered, mirroring the undeclared-RPC rule. Factories that register
   without names are not checked yet (see missing #6).
2. **`contributes.panels: string[]` + `api.registerPanelKind(def)`.** Plugins
   can add chat panel kinds for `show_panel` and `chat.panel.*`:
   - Kinds must be namespaced `<pluginId>.*` and declared in the manifest.
   - `def.methods` may list only the plugin's own **read-scoped** RPCs.
     `chat.panel.*` are read methods and must never proxy writes.
   - `chat.panel.kinds/resolve/refresh/show` see plugin kinds only while the
     plugin is loaded, and dispatch them to the plugin's gateway handlers
     (`getPluginGatewayHandlers`) behind the same per-kind allowlist.
   - The UI renders any `<pluginId>.<kind>` panel from one generic data shape
     (`{badge, tiles, table, candles, notes}`, in `panel-renderers.ts ›
     renderPluginPanel`). A plugin ships no UI code for its panels.
3. **`contributes.rpcAliases: [{ method, target }]`.** These are legacy,
   un-namespaced method names (e.g. `market.intel`) that the host wires onto a
   declared `rpc` target after `register()`:
   - An alias inherits the target's scope, so it can't widen access.
   - It is skipped with a warning if a core or other plugin method already has
     that name.
   - `resolvePluginMethodScope` honours an alias only once it is wired.

   This is what lets a plugin replace a forked gateway without breaking agents
   and scripts that call the old names.
4. **`permissions.gated: [{ id, label, description }]`.** This declares
   high-risk capabilities that stay OFF until the owner grants them. The host
   parses them and Setup › Plugins lists them ("Off until you allow it").
   **Granting is plugin-owned today** (see missing #2).
5. **plugin-sdk exports.** Added `callGatewayTool`, `GatewayCallOptions`,
   `AnyAgentTool`, and the chat panel types (`PanelKindDef`, `PanelCaller`,
   `PanelLink`, `PanelQuery`, `PanelKindOutput`, `ChatPanelRef`).
   `jsonResult` was already exported.
6. **UI plugin host.** Added the following:
   - `FIRST_PARTY_PAGES.infinitrade`;
   - the `infinitrade` Tab (route, icon, title and subtitle in
     `navigation.ts`), a lazy chunk and an `app-render` block;
   - `PluginListItem.contributes.tools/panels/rpcAliases`;
   - Plugins page rows for agent tools, chat panels and gated permissions.

## Still missing (worked around in the plugin)

| # | Need | Workaround today | Proposed host API |
|---|---|---|---|
| 1 | **Plugin secrets API** | `src/secrets.ts`: AES-256-GCM file store with its own random key under `<stateDir>/plugin-data/infinitrade/secrets/` (0600/0700). The key lives next to the data, so this protects against casual reads and backups but not against someone with full disk access | `api.secrets.get/set/delete(name)` for names declared in `permissions.secrets`, backed by the core vault/keychain; redacted in logs and config dumps |
| 2 | **Host-managed grants for `permissions.gated`** | DONE in release/plugins-2: gated permissions are host permission keys `gated:<id>`, OFF until granted (`plugins.entries.<id>.permissions.granted`), shown in Setup › Plugins › Permissions; contributions that `require` them are blocked by the host; plugins read the grant with `isPluginPermissionGranted()` from the plugin SDK | — |
| 3 | **Per-plugin storage API** | `api.runtime.state.resolveStateDir() + "/plugin-data/<id>"` (the host Data tab's dir; a pre-release `plugins/<id>` dir is moved over once) | `api.storage.dir()` (and later a KV) that respects tenant namespacing in SaaS mode |
| 4 | ~~**Page sub-routes**~~ | DONE in release/r7: every section is its own host page (`infinitrade` = Terminal, `infinitrade-<id>` at `/infinitrade/<id>`), listed in the plugin's sidebar section (`contributes.navSection`). Old `/infinitrade?section=<id>` links still open the right screen | — |
| 5 | ~~Plugin agents / personas~~ | DONE on plugin/infinitrade-parity: uses the host's `contributes.agents` (agents/roster.json → `infinitrade-analyst`, the fork's OmniTrade Analyst persona) | — |
| 6 | **Tool declarations for name-less factories** | All three tools are registered as objects, so their names are checked | Require `opts.names` for factories in v2, or check names when `resolvePluginTools` materialises them |
| 7 | **Declared cron jobs** | A plugin service with `setInterval`, off in `dataMode: "demo"` | `contributes.cron: [{id, every/expr, rpc}]` run by the core scheduler (visible in Schedule, leader-elected in cluster mode) |
| 8 | **Interactive-client signal** | `isInteractiveClient()` treats `connect.client.mode ∈ {webchat, ui}` as "a person at a screen" for order confirmation. A CLI could claim that mode | A host-issued `client.interactive` flag, or a first-class "user confirmation" RPC that shows a host modal the plugin can't bypass |
| 9 | **Default tool allowlist / roster wiring** | Agents with an explicit `tools.allow` must add `infinitrade` (plugin id) or the tool names | A manifest hint (`contributes.toolGroups`) the roster can include when the plugin is enabled |
| 11 | **Redact sensitive RPC params in the gateway debug log** | Found in side-gateway verification: `[gateway-debug] IN:` logs request params. It redacts `password`, but the TradeLocker **email** from `infinitrade.connection.connect` is logged in plain text. The plugin can't prevent this | `contributes.rpc[].sensitiveParams: ["email", …]` (or a host-wide denylist) that the debug logger redacts |
| 10 | **Network permission enforcement** | `permissions.network` is declared but only informational | Enforced egress allowlist for plugin `fetch` |

## Added on plugin/infinitrade-parity (OmniTrade parity)

Host changes on this branch (all additive):

| Hook | Where | Why |
|---|---|---|
| `api.runtime.host.runLLM(opts)` | `src/plugins/runtime/{types,index}.ts` (lazy import of `services/email/llm-analysis.js`) | The fork's AI features (journal AI insights + narrative, indicator generate/explain, research synthesis) ran completions against core directly or read provider keys from `~/.infinibot/models.json`. A plugin must not read host secrets; this gives it one completion on the owner's default model without ever seeing a key |
| Lazy UI chunk path | `ui/src/ui/lazy-views.ts › loadInfinitrade` now imports `extensions/infinitrade/ui/index` | The page moved out of core (`ui/src/ui/views/infinitrade` → `extensions/infinitrade/ui`), like OmniClinic |

Plugin-side conventions the host should know about:

- The ported views are light-DOM templates. `ui/lib/scoped-css.ts` scopes the
  fork's ~11k lines of stylesheets to `infinitrade-view` (and
  `.infinitrade-portal`) at runtime and declares the Infinitrade palette on
  the scope, so nothing leaks into the rest of the app.
- `extensions/infinitrade/ui/tsconfig.json` sets `experimentalDecorators` +
  `useDefineForClassFields: false`. esbuild uses the nearest tsconfig, and the
  extension's backend tsconfig (standard decorators) made Lit components under
  `extensions/*/ui` throw "Unsupported decorator location: field" at load.
  Any plugin UI with Lit decorators needs the same file.
- 119 ported fork methods are registered as `infinitrade.*` and their fork
  names (`journal.*`, `signals.*`, `aurum.*`, `tradelocker.*`, …) as manifest
  `rpcAliases` (generated from `src/ot/registry.ts`, test-enforced).

## Still missing after parity

| # | Need | Workaround today | Proposed host API |
|---|---|---|---|
| 12 | **Global plugin overlays** | The fork mounted `<omnitrade-panel-host>` and the Assistant drawer app-wide. In the plugin they live inside the Infinitrade page. Agents' `show_panel` still pops `infinitrade.*` panels everywhere through the host's `chat.panel.show` modal path | `contributes.overlays: [{ element, module }]` mounted by app-render while the plugin is enabled |
| 13 | ~~**Topbar contributions**~~ | DONE in release/r7 via the host's `contributes.topbarSlots` (right placement): builtin `infinitrade-pnl` (`ui/topbar-chip.ts`) shows open P&L + balance of the connected account and opens the journal; hidden until an account is connected. The full stat strip, sessions strip and account switcher stay in the page header | — |
| 14 | ~~**Clock-modal sections**~~ | DONE: `contributes.clockSections` → `trading-sessions` (`src/sessions.ts` + `ui/clock-sessions.ts`), merged with feat/control-bar-clock in release/r6 and kept as-is in r7 | — |
| 15 | **Telegram inbound for signal ingestion** | The fork's `src/telegram/signal-ingest-bridge.ts` hooked core Telegram inbound to parse channel signals. Ported as code only; the plugin exposes `infinitrade.signals.ingest.text` (paste/forward) and forwards alerts OUT via `runtime.channel.telegram.sendMessageTelegram` to `telegram.defaultChatId` | A channel-inbound subscription (`api.onChannelMessage({channel:"telegram", match})`) scoped by `permissions.channels` |
| 16 | **Tenant context for plugin module state** | Ported stores keep per-tenant caches but see only the default tenant (`src/ot/config/tenant-context.ts`); the plugin data dir is the isolation boundary | Host tenant id on `api.runtime.state` (or per-tenant plugin instances) for SaaS |
| 17 | **Achievements + Discipline import** | The importer snapshots the fork's `achievements.db` / `discipline.db` to `plugin-data/infinitrade/imported/omnitrade/` only | Core Achievements and the Discipline plugin each need their own importer from a snapshot (row merge by primary key, like `defaultMergeSqlite`) |
| 18 | ~~**`requires` gates on rpcAliases**~~ | FIXED in release/r7: `pluginMethodBlockedReason` resolves an alias (`contributes.rpcAliases` and `rpc[].aliases`) to its target (`pluginAliasTarget`) and applies the target's owner toggle and `requires` gates; `tradelocker.place` is refused without `gated:orders` (src/plugins/rpc-alias-gating.test.ts). Infinitrade's order guard still re-checks the grant | — |
