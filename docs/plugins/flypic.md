# FlyPic plugin

`extensions/flypic` puts [FlyPic](https://flypic.ai) inside InfiniBot: connect your FlyPic account in one click, use flypic.ai's own studio and library on the **FlyPic** page, and let agents generate, browse and organise through the same connection.

Everything runs on the AI provider keys in your FlyPic account (BYOK). FlyPic has no credits and InfiniBot never sees your provider keys.

## Connect FlyPic

1. Enable the plugin (Setup › Plugins › FlyPic) and open **FlyPic** in the sidebar.
2. Click **Connect FlyPic**. A flypic.ai window opens. Sign in if you need to, check what InfiniBot is asking for, and click **Allow**.
3. The window closes and the page shows your account chip: email · plan.

If the browser blocks the popup, the page sends you to flypic.ai and comes back to `/flypic` afterwards.

What InfiniBot asks for (the scopes, shown on FlyPic's consent screen):

| Scope | Lets InfiniBot |
| --- | --- |
| `generate` | generate and edit images and videos, upload references, check jobs |
| `library:read` | browse and search your generations |
| `library:write` | delete, like and unlike generations |
| `account:read` | see your email, plan, plan features and which providers you connected (never the keys) |

### How it works

- **OAuth 2.1, authorization code + PKCE (S256).** Each gateway registers itself with FlyPic once per callback URL (RFC 7591 dynamic client registration, public client, no secret). The callback is `<gateway origin>/plugins/flypic/oauth/callback`. It authenticates itself: the single-use `state` minted for your session is the credential, and the issuer (`iss`) is checked.
- **Tokens are per InfiniBot user.** They live in `<state dir>/plugin-data/flypic/connection.json` for that user (mode 0600). The access and refresh tokens are AES-256-GCM encrypted with the install key, the same store email accounts use. The plugin refuses to save them if encryption isn't available.
- **Refresh rotation.** Access tokens last 1 hour. Refresh tokens last 30 days and are replaced on every use, with one refresh in flight per user. If FlyPic sees an old refresh token reused, it revokes the whole connection. The page then shows **Reconnect FlyPic**.
- **Disconnect from either side.** **Disconnect** on the page revokes the connection on FlyPic and deletes the local tokens. Removing InfiniBot in FlyPic › Settings › Connected apps kills the tokens immediately; the plugin notices on the next refresh and asks you to reconnect.

### API token (optional, legacy)

Under **Advanced: API token for agents** you can still save a FlyPic API token (`fp_live_…` from flypic.ai/mcp). Agents then use FlyPic's MCP endpoint with it. When Connect FlyPic is connected, the connection wins.

## Pages

The FlyPic page is full-bleed and has four tabs:

| Tab | What it is |
| --- | --- |
| **Studio** | flypic.ai's generate studio (`UnifiedStudio`): the same model picker and catalog (incl. Higgsfield models such as Qwen Image 3 edit, multi-reference images), prompt, references upload, aspect/size/quality, progress, results and FlyPic's real error messages. |
| **Video** | the same studio, opened in video mode. |
| **Library** | your flypic.ai library (`HistoryPage`): grid, search and type filters, detail view, download, delete, video playback, and **reuse in the studio** (edit / start frame / upscale…). |
| **Agent runs** | FlyPic jobs your agents started from this gateway. |

The Studio, Video and Library tabs are **flypic.ai itself**, framed at `flypic.ai/embed`. They aren't a copy, so they stay 1:1 with flypic.ai as FlyPic ships changes. The frame gets a single-use 60-second ticket in its URL fragment and swaps it for a 15-minute session that lives only in memory. When that runs low, the frame asks this page for a new ticket. No third-party cookies are involved. FlyPic only lets the gateway origin that registered the connection frame the page.

If a model needs a provider key you haven't added, the studio says so and links to **flypic.ai › Connect your AI**. Adding keys needs your own flypic.ai session, which is never shared with InfiniBot.

## Agent tools

All tools are declared in the v2 manifest and work through the connection. The first five also work with a legacy API token. Successful results lead with viewable `urls` / `media`. Failures return FlyPic's own reason: the BYOK `provider_setup_required` gate with a `setupUrl`, the plan gate (`plan_required`), or Higgsfield's message plus `requestId`.

| Tool | Does |
| --- | --- |
| `flypic_generate_image` | generate an image (`model`, `aspectRatio`, `quality`, `referenceUrls` — URLs, data URLs or local files, which are uploaded first; multi-reference models use them all). Waits for queued jobs (`wait`, `waitSeconds`). |
| `flypic_generate_video` | generate a video, optionally from `startImageUrl` / `endImageUrl` |
| `flypic_edit_media` | edit an image (source + extra references) |
| `flypic_job_status` | check a job once |
| `flypic_wait_job` | wait for a queued job and return its media or failure reason |
| `flypic_list_models` | the studio's model catalog (incl. Higgsfield), with the provider each model needs, whether that key is connected (`ready`) and whether the model uses reference images (`acceptsReference`) |
| `flypic_feed_list` | list or search your library (`query`, `mediaType`, `limit`, `cursor`) |
| `flypic_feed_get` | one library item |
| `flypic_feed_delete` | delete a library item |
| `flypic_feed_favorite` | like / unlike (`favorite: false`) |
| `flypic_use_as_reference` | reuse an item: `as: edit \| reference \| video_start` with a `prompt`, or just get its URL |
| `flypic_find_reference` | find reference photos for a text query (`query`, `limit`, `orientation`, `fullBody`, `source`). Runs a live Bing Images search (Google Images as fallback) in your browser through the InfiniBot browser relay, keeps only URLs that really serve a large raster image, and tops up from your FlyPic library. Returns thumbnails and `referenceUrls`. Without the relay it searches your library only. |
| `flypic_account` | account, plan, plan features, connected providers, agent access |

**Reference images need a reference-capable model.** Text-only models (such as Higgsfield Soul standard, or text-to-video models) ignore references. When a call carries `referenceUrls`, a `startImageUrl` or a library item to reuse, the tool checks FlyPic's `acceptsReference` flag (by model id if FlyPic doesn't send the flag yet):

- a model that uses references, or that can't be checked, runs as asked
- a text-only model, or no model, switches to the best reference-capable model you have a provider key for (Soul 2, Nano Banana, Qwen Image, Marketing Studio, Seedream…). The result says so in `referenceModel` / `note`
- if you have no reference-capable model connected, nothing is generated. The tool returns `reference_model_required` with the models to pick and the key each one needs

**Plans.** On FlyPic, agent/API access is the plan feature "MCP & API access" (Pro and Studio). On other plans the tools return `plan_required` with an upgrade link. The embedded studio keeps working on any plan, because it is flypic.ai.

Agents only see plugin tools when their allowlist includes them. The standard roster gives `main` (INFINI) all twelve `flypic_*` tools, and external MCP clients (Claude Code, Claude Desktop) see exactly what `main`'s allowlist allows, because `agent.tools.list` resolves them to `main`'s policy. Content and brand roles have `group:plugins`. Other agents need the tool names added to their allowlist.

## Chat panels

In the InfiniBot chat (webchat, Grid chat, voice transcript), FlyPic answers with **live cards** instead of a wall of URLs. The tools attach them on their own, and agents can also open them with `show_panel` (`kind: "flypic.generation"`, `query: { jobId }` and so on). On channels without UI (Telegram, WhatsApp…) tools return plain results and `show_panel` returns a text fallback.

| Kind | Shows | Attached by |
| --- | --- | --- |
| `flypic.generation` | one job: model and prompt, then a progress bar with elapsed time against the model's **typical duration** (the median of your recent runs with that model, else a rough default), then the image or a video player. Buttons: **Download**, **Use as reference** (images: asks for a prompt and starts a new generation conditioned on it), **Favorite** (FlyPic like, once the result is in your library), **Open in FlyPic**, **Regenerate** (same prompt, model and settings). On failure: FlyPic's own reason, with the Higgsfield **request id** and HTTP status, plus **Add provider key** for the BYOK gate. | `flypic_generate_image`, `flypic_generate_video`, `flypic_edit_media`, `flypic_use_as_reference` (with a prompt) |
| `flypic.models` | the studio catalog grouped **Image / Video / Motion**, each with its provider and whether your key for it is connected on FlyPic (**Ready** / **Needs … key** with an **Add key** link). **Generate** asks for a prompt and starts a generation with that model. | `flypic_list_models` |
| `flypic.feed` | your library as a grid: search, type filter (all / images / videos), favorites, **Load more** in the expanded view, and a detail view with the same buttons as a generation. | `flypic_feed_list` |
| `flypic.connect` | **Connect FlyPic** (the same OAuth popup as the FlyPic page). It flips to "connected as …" once you finish. | any tool that hits "FlyPic isn't connected", and `flypic_account` while disconnected |

How the cards behave:

- **They survive reloads.** A card carries only `{ kind, query }` (a generation card carries its `jobId`), never data, and re-queries `chat.panel.refresh` when it scrolls into view. A running generation polls every 3 s and stops once the job is finished.
- **Buttons start generations without blocking.** Regenerate, model-picker Generate and Use as reference call `flypic.generate.start`. It records a `running` job immediately, finishes the FlyPic call in the background (video is synchronous on FlyPic, 30–300 s) and returns a new generation card that appears inside the current one. A run that was still going when the gateway restarted is reported as interrupted (it may still appear in your FlyPic library).
- **Agent tools still wait for the result** (as before), so their card usually shows the finished result. A queued job (`wait: false`, or one that passes `waitSeconds`) shows progress and fills in by itself.
- **Data comes only from the plugin's read RPCs** (`flypic.job.view`, `flypic.models.catalog`, `flypic.feed.list`, `flypic.connect.status`). Buttons call the plugin's own write RPCs in your UI session (`flypic.generate.start`, `flypic.feed.favorite`, `flypic.connect.start`). A panel can never call another plugin's or core's methods. See [Plugin panel data](api-reference.md#plugin-panel-data) for the generic blocks the cards use.

## RPCs

| Method | Scope | Purpose |
| --- | --- | --- |
| `flypic.connect.status` | read | connection, account, scopes, reconnect reason |
| `flypic.connect.start` | write | `{ origin, returnTo? }` → `{ authorizeUrl, redirectUri }` |
| `flypic.connect.disconnect` | write | revoke on FlyPic and forget locally |
| `flypic.embed.ticket` | write | `{ parentOrigin, view }` → `{ embedUrl, ticket, expiresIn }` |
| `flypic.account.get` | read | `/api/oauth/me` passthrough |
| `flypic.job.view` | read | `{ jobId }` → job + typical duration + library generation id / liked + the request (generation card) |
| `flypic.models.catalog` | read | catalog with group (image/video/motion), provider and key readiness (model picker) |
| `flypic.feed.list` | read | `{ mediaType?, query?, limit? }` → library items with liked state (library card) |
| `flypic.feed.favorite` | write | `{ id, favorite }` (card button) |
| `flypic.generate.start` | write | `{ kind, prompt, model?, mode?, sourceUrl?, referenceUrls?, aspectRatio?, quality?, durationSeconds? }` → `{ chatPanel, jobId }`, non-blocking (card buttons) |
| `flypic.models.list`, `flypic.generate`, `flypic.job.get`, `flypic.gallery.list`, `flypic.settings.*` | — | unchanged |

## Settings

| Key | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `https://flypic.ai` | FlyPic site URL (OAuth, embed and API). `FLYPIC_BASE_URL` env works too. |
| `apiKey` | — | optional legacy API token |
| `defaultImageModel`, `defaultVideoModel` | — | used by `flypic.generate` |

## Development

- Mock FlyPic (MCP + OAuth + REST): `node extensions/flypic/scripts/mock-server.mjs 4100`. Authorize auto-approves; model `needs-key-*` returns the BYOK gate; `mock-queued` queues; `higgsfield-fail` returns a 502 with a `requestId`. `FLYPIC_MOCK_IMAGE_MS` / `FLYPIC_MOCK_VIDEO_MS` slow generations down (to watch a card's progress); `FLYPIC_MOCK_VIDEO_FILE=/path/clip.mp4` serves a real clip as the video result.
- Tests: `pnpm vitest run extensions/flypic` (panels: `extensions/flypic/flypic.panels.test.ts`).

## Turning it on for a live install

Code changes ship with the next deploy. Afterwards:

1. **Enable the plugin** (Setup › Plugins › FlyPic) and **Connect FlyPic** on the FlyPic page, if you haven't yet.
2. **Give `main` the tools.** New installs get them from the standard roster. On an existing install, the roster adds missing defaults to `agents.list[main].tools.allow` on the next gateway boot (`addNewSeedTools`; it won't re-add a tool you removed). To turn them on without waiting for a restart, add the thirteen names to `agents.list[main].tools.allow` in `~/.infinibot/infinibot.json`: `flypic_generate_image`, `flypic_generate_video`, `flypic_edit_media`, `flypic_job_status`, `flypic_wait_job`, `flypic_list_models`, `flypic_feed_list`, `flypic_feed_get`, `flypic_feed_delete`, `flypic_feed_favorite`, `flypic_use_as_reference`, `flypic_find_reference`, `flypic_account`. Agent config hot-reloads, so the next turn (and the next MCP `tools/list`) picks them up with no restart. Keep `show_panel` in the list too so agents can reopen cards.
3. **Check:** ask INFINI in webchat "show my FlyPic models". A model-picker card should appear.
- FlyPic's side of this: flypic `docs/INFINIBOT_OAUTH.md`.

## Known limits

- **Split-origin hosted UI** (control UI on one origin, gateway on another): the OAuth callback goes to the gateway origin, but the studio frame's parent is the UI origin. FlyPic only allows framing from registered redirect origins, so the embedded studio needs the UI origin registered as well. Agent tools and the connection work regardless.
- If you connected from one address (e.g. `localhost`) and open InfiniBot from another (e.g. a Tailscale name), the page asks you to **Reconnect here** before it can frame the studio.
