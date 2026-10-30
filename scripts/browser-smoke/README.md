# Browser control — smoke harness & rollout notes

The InfiniBot gateway already ships ~70% of a first-class browser-control stack:
`src/browser/*` (extension-backed CDP relay on `:18792`, Playwright `connectOverCDP`
session layer, Chrome launcher + profiles), a native `browser` agent tool
(`src/agents/tools/browser-tool.ts`, 40+ verbs), the `infinibot browser` CLI, and
NATO-codename infra in `src/gateway/server-methods/ui-control.ts`.

This folder adds the reproducible verification harness and the rollout checklist.

## What the relay actually is

`ws://127.0.0.1:18792/cdp` is a **real extension-backed CDP proxy served by the
gateway** — not a shim, and unrelated to `~/clawd` (a report workspace). It forwards
CDP to the **InfiniBot Browser Relay** Chrome extension (`assets/chrome-extension`,
`chrome.debugger`). It exposes targets only for tabs the extension has attached.

`"Page.enable times out"` was a **0-attached-tabs** condition, not a broken relay:
- `curl :18792/extension/status` → `{"connected":true}` (extension WS up)
- `curl :18792/json/list` → `[]` (no tab attached)
- `Target.createTarget` → `"No attached tab"` — a cold-bootstrap dead-lock in the
  extension (fixed in **0.2.2**: `Target.createTarget` is now handled before the
  "no attached tab" guard).

## Run the harness

```bash
node scripts/browser-smoke/cdp-smoke.mjs          # list targets, bootstrap, eval, cleanup
node scripts/browser-smoke/cdp-smoke.mjs --list   # just list attached tabs
node scripts/browser-smoke/cdp-smoke.mjs --url https://infinitybotos.com
```

Pre-0.2.2 (or before reloading the extension) it prints the reproduction:
`[1] list_tabs → 0 ... SMOKE_FAIL: No attached tab for method Target.createTarget`.
After reloading the extension it bootstraps a tab and evals `document.title`.

## To finish the rollout (requires a gateway restart)

1. **Reload the relay extension** so the 0.2.2 cold-bootstrap fix is live:
   `chrome://extensions` → *InfiniBot Browser Relay* → **Reload** (or relaunch via
   `~/.local/bin/google-chrome`). Verify: `curl :18792/extension/status`.
2. **Expose `mcp__infinibot__browser`** to MCP clients. The `browser` tool is built in
   `createInfiniBotTools` but absent from the external MCP surface. Confirm whether the
   resolved policy for the MCP session key is filtering it (`agent.tools.list` →
   `buildTools` → `filterToolsByPolicy`); the supported lever is the operator config
   `tools.alsoAllow` / a per-agent `tools.allow` including `group:ui` (= `browser` +
   `ui_control`). Least-privilege: scope to the orchestrator/main session, not all
   sub-agents.
3. **Restart the gateway** to register the tool: `mcp__infinibot__gateway { action:"restart" }`
   (or restart the `pnpm infinibot gateway` supervisor).

## The 7 smoke checks (run after steps 1–3)

| # | Check | How |
|---|---|---|
| 1 | list_tabs shows real tabs | `browser tabs` / `cdp-smoke.mjs --list` |
| 2 | eval `.cut-clip` count on Studio | `browser exec {tab, code:"document.querySelectorAll('.cut-clip').length"}` |
| 3 | screenshot infinitybotos.com hero → PNG on disk | `browser navigate` + `browser screenshot` |
| 4 | click the Studio unmute button | `browser act {kind:"click", ref:"[aria-label=Unmute]"}` |
| 5 | console_capture round-trips a console.log | `browser exec {code:"console.log('hello')"}` + `browser console` |
| 6 | network_capture gets a response body | `browser` network capture around a `fetch` |
| 7 | survives gateway restart (re-registers + reattaches) | restart, re-run harness |

## Deferred (follow-up PRs)

- **Firefox/Marionette** — none today; the user's primary browser is snap Firefox where
  Marionette is sandbox-confined (relaunching the live session risks open tabs/logins).
- Voice-friendly verb aliases (`eval`, `press_key`, `wait_for`, `dom_snapshot`,
  `network_capture`, `console_capture`) as thin wrappers over the existing
  `exec`/`act`/`snapshot`/`console` verbs.
- Managed-Chromium auto-launch when nothing is attached (the `clawd-chrome` wrapper is
  the manual form of this today).
