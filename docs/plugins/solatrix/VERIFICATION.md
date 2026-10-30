# Solatrix verification record

Verified 2026-09-28 from the isolated `plugin/solatrix` worktree. The source applications were read-only.

## Coverage

- Inventory: `/tmp/solatrix-plugin/INVENTORY.md`
- Source capabilities inventoried: 45 (31 product surfaces + 14 backend capabilities)
- Mapped to a plugin page, host replacement, or backend contract: 45/45 (100%)
- Directly functional or intentionally host-adapted: 31/45 (69% operational parity)
- Main plugin pages: 9/9, each captured at 1440×900 and 390×844 in dark and light host themes

The inventory lists the 14 partial/fixture-backed production behaviors. The most material gaps are live venue-specific mint/bundle construction, SPL bulk transfer construction, Helius-backed Copy Bot/Map streaming, timed order and TP/SL execution, live party coordination, and secure wallet-key export. All fail closed; none silently broadcasts or exposes a key.

## Safety proof

- Solatrix is bundled but disabled by default. While disabled, `solatrix.status` returns `unknown method`, its sidebar group is absent, and `/solatrix` renders the host's turned-off card.
- State remains under `<stateDir>/plugin-data/solatrix` after disable. The isolated run retained `secrets/.key`, `secrets/wallets.enc`, wallet metadata, settings, tickets, queue and event journal.
- Wallet generation/import is accepted only from an interactive UI connection. Keys are AES-256-GCM encrypted, file permissions are restricted, and wallet-list/status/tool results return metadata only.
- Swaps, transfers, Copy Bot execution and bundle launches are independent default-off gated permissions.
- An action needs both its grant and a five-minute UI ticket with an exact confirmation phrase. Agent/CLI clients do not receive the phrase and cannot confirm.
- The isolated gateway used a fresh HOME/state directory, skipped channels/providers/cron/MCP, and loaded `test/loopback-only.cjs`; a request to `example.com` was rejected before the network.
- A local Solana/Jupiter/Raydium mock returned recorded quote fixtures. The only confirmed swap produced a `MOCK_SWAP_*` signature; no real key or transaction was used.

## Automated checks

The final commands and exit codes are recorded in the run RESULT. Unit coverage includes portfolio arithmetic, copy-rule evaluation, manifest defaults, recorded Jupiter/Raydium quote normalization, default-off write gating, UI-only confirmation and key redaction.

## Visual evidence

- Final dark sweep: `/tmp/solatrix-plugin/verify-state/verification/solatrix-final-visual/visual-mule0bx4/`
- Final light sweep: `/tmp/solatrix-plugin/verify-state/verification/solatrix-light-visual/visual-muleapnd/`
- Clean light Launcher rerun: `/tmp/solatrix-plugin/verify-state/verification/solatrix-light-launcher-rerun/visual-mulecylq/`
- Disabled route: `/tmp/solatrix-plugin/verify-state/verification/solatrix-disabled-route/visual-mule9bhe/`
- Plugins listing disabled state: `/tmp/solatrix-plugin/verify-state/verification/solatrix-disable-ui/visual-mule30f0/`
- Side-by-side source/plugin captures: `/tmp/solatrix-plugin/shots/compare_{terminal,portfolio,wallets,discovery,copy-bot,launcher,map,queue,settings}__{desktop,mobile}.png`

The dark sweep reports zero console errors and zero failed RPCs across all 18 route/viewport captures. The light sweep has one transient Google Fonts `ERR_NETWORK_CHANGED` on Launcher mobile; its isolated rerun reports zero console errors and zero failed RPCs.
