# Product Studio (`monsoon-studio`)

Embeds the Monsoon Digital Product Studio (repo `MonsoomAI`, branch `feat/unified-studio`) in InfiniBot.

- **Page:** Product Studio (`/product-studio`, nav group Work). It shows a health pill and the embedded studio editor. When the studio is down, an Offline card shows the start command.
- **Agent tools:** 26 `studio_*` tools, each proxied to `POST <studioUrl>/api/tools/<name>`. They are allowlisted for the `main` agent and the design agent through the `monsoon-studio` plugin group.
- **RPCs:** `monsoon-studio.status`, `monsoon-studio.tools.list`, `monsoon-studio.tools.call`.
- **Config:** `studioUrl` (default `http://127.0.0.1:4311`) and `timeoutMs` (default 180000).

The plugin needs the studio server running (systemd user unit `monsoon-studio`). See `MonsoomAI/docs/studio/infinibot-integration.md`.

Regenerate the vendored tool schemas after studio tool changes:

```bash
node extensions/monsoon-studio/scripts/sync-schemas.mjs http://127.0.0.1:4311
```
