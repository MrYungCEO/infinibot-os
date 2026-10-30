# Mesh plugin-rooms verification scripts

Reference copies of the puppeteer drivers used to verify the Plugin District
(docs/plugins/MAP-ROOMS.md). They assume Node 22, puppeteer from `ui/node_modules`,
system Chrome at `~/.local/bin/google-chrome`, and a worktree path in
`INFINIBOT_WORKTREE` (default `/tmp/ib-mesh-plugin-rooms`).

- `harness-shots.mjs [all|full|rooms|disable|mobile|none]` — drives
  `/mesh-plugin-rooms-harness.html` on a vite dev server (`pnpm -C ui exec vite --port 5199`):
  full district, 30 synthetic agents, per-room dpr-2 close-ups, plugin disable/re-enable,
  390 px, no-plugins. Writes to `/tmp/mesh-plugin-rooms/shots/`.
- `side-gateway-start.sh` — boots an isolated gateway (fresh HOME/state, password auth,
  channels/cron/tunnel off, all egress denied) serving the worktree dist on
  `$SIDE_PORT` (default 18977; pick a free one — other agents' side gateways use
  nearby ports) with the 12 first-party plugins enabled (`side/state/infinibot.json`).
  Point the shots script at it with `SIDE_BASE=http://127.0.0.1:<port>`.
- `side-gateway-shots.mjs side|synthetic|live` — real `/mesh` page against that gateway:
  `side` = rooms from the real `plugins.list`, live `mapRoom:<id>` contribution toggle,
  hover + click → plugin page; `synthetic` = 30 synthetic agents (24 firing plugin
  tools/RPCs, 6 on core tools) pushed through `applyBatch`, proving activity → room
  routing, the occupant tooltip and 12-rooms + 30-agents perf on the real page;
  `live` (with `LIVE_PROXY=http://127.0.0.1:18978`) renders the same dist read-only
  against the live gateway through `live-proxy.mjs` (same origin, so no CORS).
- `perf-probe.mjs` — four harness scenes (no rooms / 12 rooms idle / 30 agents without
  rooms / 12 rooms + 30 agents) sampling rAF frame time, ticker FPS and the engine's
  `window.__hudPerf.drawMs`, so the district's cost is separated from the headless
  swiftshader baseline. Writes `/tmp/mesh-plugin-rooms/shots/report-perf.json`.
