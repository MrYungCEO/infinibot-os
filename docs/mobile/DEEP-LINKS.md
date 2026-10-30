# InfiniBot deep links

Every alert InfiniBot sends (push, Telegram, in-app notification, proactive
overlay) carries a **deep link** so a tap lands on the right screen — natively in
the mobile app when it is installed, otherwise on the web UI.

## Two forms, one path

| Form | Example | Used by |
|---|---|---|
| App scheme | `infinibot://plugin/infinitrade/signals?signal=abc` | push `data.deepLink`, `notification.created`, in-app |
| Web opener | `https://<public-base>/m/plugin/infinitrade/signals?signal=abc` | Telegram buttons/links, anything that must be an https URL |

The **path** after `infinibot://` (or after `/m/`) is identical. The `/m/*`
page served by the gateway is public (it carries no data): on Android it hands
off to the app with an `intent://` URL whose `browser_fallback_url` is the web
route; on iOS it tries `infinibot://` and falls back to the web route; on
desktop it redirects straight to the web route (which is behind the normal
gateway login). On InfiniBot Cloud the public base is the cloud web host
(`https://infinibot-cloud.netlify.app`), which the Android app claims as a
verified App Link (`/m/` prefix) and iOS as an associated domain.

`<public-base>` resolution (gateway): `INFINIBOT_PUBLIC_URL` →
`federation.publicUrl` → Tailscale MagicDNS host (`https://` when
`gateway.tailscale.mode` is `serve`/`funnel`, else `http://<host>:<port>`) →
none (Telegram then gets no link line).

## Path table

| Path | Mobile destination | Web fallback route |
|---|---|---|
| `` / `home` / `dashboard` | Dashboard tab | `/dashboard` |
| `chat` · `chat/<sessionKey>` · legacy `activity/session/<sessionKey>` | Chat tab (switches session) | `/webchat?session=<sessionKey>` |
| `board` · `board/task/<taskId>` | Board tab (`taskId` param) | `/projects?task=<taskId>` |
| `business` · `knowledge` · `more` | that tab | `/business-hq` · `/notes` · `/dashboard` |
| `documents` · `documents/<id>` | WebSurface `/documents/<id>` | `/documents/<id>` |
| `runs` · `runs/<runId>` | Oversight (focus `runId`) | `/reviews?run=<runId>` |
| `approvals` · `approvals/<id>` | Approvals screen (focus `id`, approve/deny) | `/autonomy?view=approvals&approval=<id>` |
| `goals` · `goals/<id>` | WebSurface `/autonomy?view=goals&goal=<id>` | same |
| `phases` · `phases/<id>` | WebSurface `/autonomy?view=phases&phase=<id>` | same |
| `scheduled` · `scheduled/<taskId>` | WebSurface `/autonomy?view=scheduled&task=<taskId>` | same |
| `plugin/<pluginId>` · `plugin/<pluginId>/<page>` | the plugin page — native screen when the app has one (Discipline, Content Studio, Business & Agency CRM pages…), else authed WebSurface of the page route; a disabled/unknown plugin opens the Plugins screen on it | page route (`<page>` = page tab, `<pluginId>-<page>` tab, or route suffix; unknown page → main route `?section=<page>`) |
| `plugins` · `plugins/<pluginId>` | Plugins screen | `/plugins?plugin=<pluginId>` |
| `learn` · `learn/<trackId>` · `learn/<trackId>/<walkthroughId>` | WebSurface of the guided Learn track (the walkthrough auto-starts; progress syncs through the gateway) | `/learn/<trackId>?walkthrough=<walkthroughId>` |
| `web/<path…>` | route owned by a plugin → that plugin page; else WebSurface `/<path>` | `/<path>` |
| `settings` `notifications` `terminals` `agents` `autonomy` `reports` `oversight` `grid` `call` `discipline` | the native screen | `/setup` … |
| `connect?url=…&token=…` | Connection chooser, prefilled (pairing) | — |

Query strings are passed through to the destination.

Legacy inputs are normalised by `normalizeDeepLink` (gateway
`src/notifications/links.ts`, mobile `src/navigation/deep-links.js`):
`mobile://chat?sessionKey=X` → `infinibot://chat/X`; a relative web path like
`/solatrix/alerts` or `/infinitrade?section=signals` → `infinibot://web/solatrix/alerts`.
