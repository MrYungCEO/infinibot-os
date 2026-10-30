# Content Studio plugin (`content-studio`)

Branch `plugin/content-studio`. PLUGIN-PLATFORM.md rows 45, 46 (UI) and B19/B20
(backend). Content › Pages and Content › Intelligence left core and are now a
first-party, manifest-v2 plugin: `extensions/content-studio`.

## What the plugin contributes (only while enabled)

| Kind | What |
|---|---|
| Pages | `content-pages` (`/content-pages`, Content › Pages) and `content-intel` (`/content-intel` → `/content-pages?view=intel`, Content › Intelligence). Plugin-gated tabs in `ui/src/ui/plugin-host.ts` `FIRST_PARTY_PAGES`. |
| Nav | One sidebar entry, "Content Studio", in a plugin group "Content". The in-page Pages / Intelligence sub-tabs are the existing `HOST_SUBVIEWS["content-pages"]`. Launchpad lists it under Content. |
| RPC | 91 methods as `content-studio.*` (table: `src/content-studio/methods.ts`). Legacy names are manifest `rpcAliases` onto them: `content.pages.*`, `content.intel.*`, `content.trends.*`, `scripts.*`, `viralExamples.*`, `viral.formats.*`, `socials.*`, `instagram.*`, `manychat.*`. Scopes are the ones core had (unlisted ones stay admin). |
| HTTP | `GET /plugins/content-studio/video?shortcode=<sc>` (Range-capable reel stream; replaces core's `/api/content-intel/video/<sc>.mp4`). `GET/POST /plugins/content-studio/media` (studio media, see Production pipeline). |
| Pipeline RPC | 27 plugin-native methods `content-studio.{board,stages,items,docs,ideas,media}.*` (no legacy alias; `CONTENT_STUDIO_NATIVE_METHODS`). |
| Tools | `content_intel`, `script`, `viral_watch` (viral_watch was written but never registered before), `content_pipeline`. |
| Agents | `agents/roster.json`: cmo, content-director, scriptwriter, brand-designer, video-editor-agent (prompts moved verbatim from `standard-roster.ts`; the `content` roster pack is gone). |
| Service | `content-studio-instagram-sync`: the Instagram stats poller, gated exactly as before (starts only once a content page has Instagram connected). Config `instagramSync: false` turns it off. |
| Settings | `instagramSync`, `pipelineDir`, `venvPath` (see private pipeline below). |
| Listing | tagline, description, category `apps`, tags, `assets/cover.svg`, `assets/icon.svg` (original gold-on-black art), two screenshots. |

When the plugin is off: no sidebar entry, no Launchpad / ⌘K entry, no
dashboard content card or trends radar, `/content-pages` and `/content-intel`
show "Content Studio is turned off — open Plugins", every content RPC is
"unknown method", no content tools, no Instagram polling, no content agents
seeded, knowledge graph and sub-agent detail skip content pages.

## Production pipeline, content pages, Ideas, media

The Content Studio page (`<content-studio-shell>`, `ui/src/ui/views/content-studio/`)
opens on **Pipeline**, with **Ideas** and **Channels** (the original content-pages
hub, unchanged) as sibling tabs.

- **Board** (`board.ts`): stages as columns (default Idea → Script → Produce → Edit →
  Schedule → Published). Drag cards between stages and within a stage (same native-DnD
  pattern as the Tasks kanban: midpoint drop index, drop line, RAF-gated renders,
  optimistic move then `items.move`). Drag a column header to reorder stages;
  double-click to rename; ⋯ menu for colour, WIP limit, "counts as published",
  move, delete (non-empty stages move their items first). WIP: `n/limit` chip, bar,
  red column + warning when over. KPI strip uses `<holo-panel>`.
- **Content page** (`page-view.ts`): every card opens a page with title/summary,
  platform/format/due/tags and the shared `rich-doc-editor.ts` (from
  feat/rich-doc-editor, extended additively: `rpc` override, `media` hooks,
  video/audio blocks, drop/paste upload, `insertMedia`). The media rail uploads,
  adds by URL (download or reference), sets the card cover and inserts into the page.
  ✨ Generate appears only when the FlyPic plugin is loaded (`flypic.generate` +
  `flypic.job.get`, output imported because FlyPic links expire; billed on the
  user's FlyPic account, so it asks first).
- **Ideas** (`ideas.ts`): free-form markdown pages (icon, pin, tags), promote →
  pipeline item (page and media copied, back-link kept).
- **Storage**: `<stateDir>/plugin-data/content-studio/studio.db` (`pipeline-store.ts`,
  schema in `PRAGMA user_version`): `cs_stages`, `cs_items` (dense per-stage
  positions), `cs_docs` (Block[] per owner — the `task_content_blocks` pattern),
  `cs_ideas`, `cs_media`, `cs_media_links`. Files in `…/content-studio/media/`
  (core's media store is a 2-minute scratch dir). Upload = raw-body POST
  `?filename=&ownerKind=&ownerId=`; URL import goes through the SSRF host guard on
  every redirect hop.
- **Markdown** (`blocks.ts`) reuses core `blocks-markdown`; video/audio are written
  `![video: caption](url)` / `![audio: caption](url)`.
- **Agents**: `content_pipeline` (board, create/move/update/delete items, stage
  CRUD/reorder by name, get/set/append pages, ideas + promote, attach media by URL
  or local path). The board re-polls every 15 s and on focus so agent edits show up.

## Video posting queue (Posting tab)

Each content page can post its finished videos from the owner's own
Instagram / TikTok account on one Droid Swarm phone.

- **Binding** — one Droid Swarm device per page plus one account per
  platform on it, picked from what is actually logged in on the phone
  (`content-studio.posting.detect` → Droid Swarm reads the app's profile
  screen and account switcher; read-only). Changing the binding switches
  auto-posting off until the owner turns it back on.
- **Queue** — `cs_post_queue` in `studio.db` (schema v2, survives restarts):
  queued → scheduled → (awaiting_approval →) posting → posted / failed, plus
  paused and skipped. Every status change goes through
  `PostingStore.transition()` (`QUEUE_TRANSITIONS`). Sources: a page's
  pipeline items' videos, the media library, an upload, a URL, or (agent
  tool only) a local render; `episodeId` fills title/hook/series/episode.
- **Schedule** (`posting-schedule.ts`) — every N minutes/hours or X per day
  spread across a daily window (can wrap midnight) in the page's IANA
  timezone, deterministic ±jitter per entry, daily cap. Live pages are
  floored at 30 min between posts and 10 posts/day; dry-run pages may go
  down to 1 min. Droid Swarm additionally keeps 12 min between live posts
  on one phone and 10/day per account.
- **Captions** — per-page template with `{title} {hook} {hashtags} {cta}
  {series} {episode} {date} {page} {handle}`, default hashtags, CTA, live
  preview, per-video override, and an AI draft (`posting.aiCaption`, the
  owner's default model via `api.runtime.host.runLLM`) that is only saved
  when applied.
- **Safety switches** — *Require approval* (default on: every post files an
  approval in core's registry → Telegram + inbox and waits) and *Dry run*
  (default on: the phone runs the whole flow and stops before the final
  Share/Post tap, then discards the draft). Agents can only turn these ON.
- **Ticker** — the `content-studio-posting` service ticks every 15 s, one
  post in flight per page. A post found mid-flight after a restart is
  marked failed ("interrupted") and is never re-posted automatically.
  Retryable failures back off (5/10/20 min live, 30/60 s dry run, max 3
  attempts). Wrong account / logged out / human checkpoint fail at once,
  switch the page's auto-posting off and alert the owner
  (`api.runtime.host.alertOwner`).

### How Content Studio calls Droid Swarm

The plugins never import each other. Droid Swarm registers
`droid-swarm.publisher.devices | detect | publish` (manifest `rpc`), and
Content Studio invokes those handlers in-process through the active plugin
registry (`posting-droid.ts`; the registry is a `globalThis` singleton, so it
works across jiti module instances). With Droid Swarm off, posting reports
"Droid Swarm unavailable". The publisher (`extensions/droid-swarm/src/publisher/`)
drives the phone only through Android Ops `agentControlDevice()` — the
compliance allow-list, CAPTCHA/verification stop, and per-step
`device.agent_control.*` audit all apply — plus one
`content_posting.publish|detect` audit row per call. Flow: verify the active
account (switch via Instagram's own switcher if the bound account is logged
in there; TikTok is never switched, it fails safe) → copy the video into the
Android Ops library → `push_media` → `share_media` (new: media scan +
MediaStore lookup + SEND intent) → Next → caption → Share/Post (dry run
stops here) → confirm on the profile (post count +1). Neither app exposes a
permalink in its UI tree, so `postUrl` stays empty and `postRef` records
the post count.

Agent tool: `content_posting` (status, list_queue, candidates, queue_video,
update_video, move, pause/resume/skip/retry/remove, set_frequency,
set_template, set_safety, preview_caption, ai_caption, post_now, devices,
detect_accounts, history). It is on main's allow-list
(`standard-roster.ts`) and on the CMO, content-director and video-editor roster
agents.

End-to-end check: `node extensions/content-studio/scripts/posting-e2e.mjs`
(throwaway HOME/state, fake adb + fake Instagram in
`extensions/droid-swarm/test/fake-bin/fake-social.js`, dry run only).

## How the backend is wired (the seam)

The content backend (`src/content/**`, `src/socials/**`, the eight handler
modules in `src/gateway/server-methods/`, the three tools) still compiles into
core, but **core no longer registers any of it**:

- `server-methods.ts` dropped the eight handler spreads and their READ/WRITE
  entries; `server-methods-list.ts` dropped the content block;
- `infinibot-tools.ts` dropped `script` + `content_intel`;
- `server-startup.ts` dropped the Instagram poller; `server-http.ts` dropped
  the video route.

The plugin reaches it through one seam, `contentStudio` in
`infinibot/plugin-sdk` (`src/content-studio/index.ts`). Handler modules and
stores are dynamically imported on the first call, so a gateway with the
plugin off never opens a content store. Core code that still reads content
data (knowledge graph `collectContent`, `subagents.detail` content pages)
checks `isContentStudioActive()` first.

Why not move the files into `extensions/content-studio/src` yet: bundled
extensions are loaded from source by jiti and may only import core through
`infinibot/plugin-sdk`. The content code shares core singletons (databases
store, config, logging), so a physical move needs the plugin `build` step
(PLUGIN-PLATFORM §4.1). The seam makes that a pure file move later.

Shared helpers stay core: `src/content/blocks-markdown.ts` (kanban, project
summary) and `src/content/research-service.ts` (web search, research).

## Host change: `contributes.rpcAliases`

Ported from `release/plugins-2` (7fe636f2, host API v0) — only the alias part,
same code, so integration takes either side:
`manifest-v2.ts` parses `rpcAliases: [{method, target}]` (target must be a
declared rpc, alias can't be in the plugin namespace, inherits the target's
scope), `registry.ts` `wireRpcAliases` wires them after `register()` and never
shadows a core or other plugin method, `runtime.ts` resolves alias scopes.

## Migration (existing installs)

`src/content-studio/migration.ts`, run once at gateway boot
(`server.impl.ts`, before roster seeding):

1. Marker `<stateDir>/plugin-data/content-studio/.migration.json` exists → nothing.
2. `plugins.entries.content-studio.enabled` already set (true or false) → kept, marker written.
3. Otherwise look for content data in the state dir **and** the legacy
   cwd-relative content state dir (`INFINIBOT_STATE_DIR` or `state/`):
   reels in `content-intel.db`, rows in `databases.db` `content_pages` /
   `viral_examples`, viral-format benchmarks, `socials/analytics.db`,
   `secrets/instagram.json` / `secrets/manychat.json` (non-empty only).
   - Found → write `plugins.entries.content-studio.enabled = true` and tag
     seed-managed content agents (`_seedVersion` set, no `_plugin`) with
     `_plugin: "content-studio"` so the plugin refreshes them and removes
     them if it's ever turned off. Operator-customised agents are untouched.
   - Not found → stays off.

Data never moves: every store keeps its existing path. Disabling the plugin
never deletes data; re-enabling picks it up again. Fresh installs decide on
first boot (no data → off) and never flip later on their own.

## Honest connections

- **ManyChat**: there is no mock mode any more. `manychat.connect` checks the
  key with ManyChat (`/fb/page/getInfo`) and only then stores it
  (`<stateDir>/secrets/manychat.json`, 0600) and reports connected. The UI
  shows "connected" only from `manychat.status` (the stored, verified key); a
  page flag left over from the old mock connect shows "Not connected —
  reconnect". New `manychat.status` / `manychat.disconnect`; flows/trigger use
  the stored key and fail with `NOT_CONNECTED` otherwise. The flows endpoint
  was also wrong (`/fb/flow/getFlows` → `/fb/page/getFlows`).
- **Instagram**: already real (Graph API token paste), unchanged.

## Content Intelligence notes

- `content.intel.trends` never existed; the Trends sub-tab now calls
  `content.trends.last30days` and maps its bundle (topics / formats / signals).
- The reel pipeline is owner-private (PRIVATE-SPLIT §5). Its path is purely
  config: env `INFINIBOT_CONTENT_INTEL_PIPELINE_DIR` / `REEL_PIPELINE_DIR` /
  `INFINIBOT_CONTENT_INTEL_VENV` → plugin settings `pipelineDir` / `venvPath`
  → legacy `integrations.contentIntel.*` → empty = pipeline features report
  "disabled" (no default path). Committed `__pycache__/*.pyc` removed.
- Third-party reel thumbnails: none are tracked (`ui/public/content-intel-thumbs/`
  is gitignored).
- `<cmo-chat>` stays a thin wrapper over the core agent chat modal.

## Left for later

- Physical move of `src/content/**` + `src/socials/**` into the extension
  (needs the plugin build step).
- `reports/kinds/content-overview.ts` and two `workflow-engine.ts` templates
  still name the content agents; they degrade to "agent not found" when off.
- Canva MCP preset (B19) is still core `agent-mcp-defaults.ts`.
- Mobile content screens call the legacy names; with the plugin off they get
  "unknown method" (no mobile gating yet).
- Satellite proxy prefixes in `server-methods.ts` still list the legacy names
  (they keep working because clients call legacy names).

## Verification (2026-09-28)

Two isolated side gateways built from this branch (fresh `HOME` + state dir
under `/tmp`, channels/cron/MCP/providers off, password auth), live gateway
untouched. Owner copy = `~/.infinibot/infinibot.json` with every
token/key/password and the channels/gateway/models/integrations blocks
stripped, plus read-only backups of the owner's `content-intel.db`,
`viral-formats.db` and the repo `state/databases.db` (deleted afterwards).

| Probe | Fresh, off | Fresh, on (fixture) | Fresh, off again | Owner copy (migrated) |
|---|---|---|---|---|
| Boot log | "no existing data, plugin stays off" | — | — | "existing data found (186 reels …; 1 content pages …) — plugin enabled; agents handed to the plugin: …" |
| `content.pages.list` / `content-studio.pages.list` | unknown method | 2 pages | unknown method | owner's page |
| `content.intel.totals` | unknown method | 8 reels | unknown method | 205 reels, 11.2M views |
| `manychat.status` / `connect {apiKey:"mock"}` | unknown | `connected:false` / AUTH_ERROR 401 from ManyChat, nothing saved | unknown | `connected:false` |
| Content roster agents | none | +5 seeded | −5 dropped | 5 adopted + refreshed |
| `/plugins/content-studio/video` | not a plugin route (SPA shell) | "no local video" (pipeline unset) | — | "no local video" |
| Sidebar / page | no Content group; "turned off" card | Content › Content Studio; Pages + Intelligence | no Content group; "turned off" card | same as on |
| Data files | — | — | unchanged byte sizes; back on re-enable | — |

Second boot of each gateway: migration silent (marker present).
Screenshots: `/tmp/plugin-content-studio-shots/`.

Tests: `src/content-studio/content-studio.test.ts` (manifest ⇄ method table,
off/on load through the real loader, alias scopes, alias never shadows core,
lazy handler dispatch, migration cases), `src/gateway/server-methods/manychat.test.ts`,
`src/plugins/first-party-manifests.test.ts`, roster pack test, UI navigation
tests; `pnpm build` and `pnpm -C ui build` pass.
