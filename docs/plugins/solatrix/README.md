# Solatrix plugin

`extensions/solatrix` ports the Solatrix Solana suite into a bundled, off-by-default manifest-v2 InfiniBot plugin. Its pages are Terminal, Portfolio, Wallets, Discovery, Copy Bot, Launcher, Map, Queue and Settings.

Safety is structural: private keys live only in the plugin's AES-256-GCM secret store; normal RPCs and agent tools never return them. Swaps, transfers, copy execution and launches each have a separate default-off gated permission. Every transaction needs a short-lived ticket plus an exact confirmation phrase from an interactive UI client. Copy Bot and Launcher are disabled until explicitly enabled with per-trade and daily limits.

State lives under `<stateDir>/plugin-data/solatrix`. Legacy importers read the original Solatrix directories but never import private keys; a key must be added through the Wallets page.

The pages are a 1:1 port of the original desktop app (Terminal, Dashboard and Feed views, the original chart system and styles): see [SOLATRIX-PARITY.md](../SOLATRIX-PARITY.md) for the feature-by-feature checklist. The native chart and the Solana watchlist are shared with InfiniBot's control-bar CHART panel, which offers a Solatrix | DexScreener source switch and falls back to DexScreener when the plugin is off.

Read-only public market data (prices, candles, trending, token trades) follows the `marketData` setting (`auto` = live with a labelled fixture fallback); `dataMode` alone decides whether anything can be broadcast.

The plugin provides offline fixture data for safe demos and tests. Mainnet must be selected explicitly and is always labelled **REAL FUNDS**. Solatrix is not financial advice.
