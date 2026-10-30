# Mobile surface audit — 2026-10-01

Branch `feat/mobile-ui-sync`. Every entry the mobile app can navigate to was
opened against the live gateway (read-only), before and after this work.

## How it was checked

There is no emulator on this machine, so the app was exported for the web
(`expo export --platform web`) and driven with headless Chrome at 390×844
(and 1024×768 for tablet layouts), connected to the live gateway with the
owner's saved credentials. For each entry the harness records every gateway
request and its answer, page errors, horizontal overflow, and a screenshot.

What that does and does not prove:

- **Native screens** — loads, real requests, real data, crashes and layout are
  checked directly.
- **Web-backed pages** (the app shows the web UI in a WebView) — a browser
  cannot host a WebView, so each route was instead opened in the live web UI at
  phone width with the same credential seeding the WebView uses, and the tab the
  web app resolved to was recorded.
- **Device-only pieces** — WebView content (terminal emulator, the mesh "World"
  view, grid panels), camera screens, push, haptics and real keyboard behaviour
  were **not** exercised. They need a device or emulator.
- "Actions work" was exercised end to end only for chat (create, rename,
  delete, switch, send, live sync). Other screens' write actions were read in
  source and their request names/params checked against the gateway, not run —
  the gateway is live and the audit stayed read-only.

## Summary

| | Before | After (final build) |
|---|---|---|
| Entries opened | 96 | 97 (56 native screens/routes, 41 web-backed) |
| Native screens that crash the whole app | 2 (Mesh Progression, Credits & Usage) | 0 |
| Entries with a failing gateway request on open | 3 | 0 — 278 requests across the run, none rejected |
| Request names with no gateway handler (found in source) | 27 | 0 |
| Peak requests in one ~7 s screen window | 1,534 (`subagents.list` loop) | 29 |
| Web-backed routes that render connected in the live web UI at 390×844 | not checked | 47 of 47 (41 entries + 6 grid panel routes) |
| Pages reachable only by knowing where to tap | Notes, Research, Workflows | none |
| Duplicate / zero-data destinations | Goals + Phases (same page), Budget (all zeros) | merged / removed |

Evidence files (text, committed next to this document in `evidence/`):

- `audit-final-summary.json` — the final run: crashes, failed requests, page errors, overflow, request counts
- `web-routes.txt` — one line per web-backed route: HTTP status, the web tab it resolved to, connected or not
- `npm-test.txt` — full `npm test` output
- `sync-proof.txt`, `sync-report.json` — web ⇄ mobile chat sync checks
- `unread-panel-report.json` — unread / replying markers, tool cards, `show_panel` cards
- `polish-facts.txt` — which screens have pull-to-refresh, skeleton loaders, leftover emoji
- `web-tokens-check.txt`, `voice-route-check.txt`

"No failed request" means: on opening each native screen, every request the app sent was answered without an error. It says nothing about buttons that were not pressed.

## Matrix

`native` = a React Native screen; `web` = the web UI shown in the in-app
WebView. "Before" is what the first audit saw (or what source review found for
actions). For `web` rows, "After" is the result of opening that route in the
live web UI at phone width — not inside the mobile app. On a device the WebView
additionally hides the web shell's own top bar and sidebar.

| Section | Screen | Kind | Before | After | Data shown | Notes |
|---|---|---|---|---|---|---|
| Main | Chat | native | opens, but local-only 'Main Chat' — none of the web's sessions, two stacked headers, fake Model button | loads, no failed RPC | real: 49 web chat sessions, transcripts, tool cards, panels | create / rename / delete / switch + live sync proven (see Sync proof) |
| Main | Board | native | opens | loads, no failed RPC | real (Notion projects/tasks) | first paint takes ~10 s — `notion.databases.query` is slow on the gateway |
| Main | Dashboard | native | opens | loads, no failed RPC | real | Budget tile now opens Credits & Usage |
| Main | Business | native | opens | loads, no failed RPC | real ($16.8k revenue, 1,300 clients, 8 projects) | reloads only while on screen, ≤ 1 per 5 s |
| Main | Knowledge | native | fails: research.list (unknown method) | loads, no failed RPC | real (115 notes, 25 workflows) | research count from `research:status` |
| Main | More | native | opens; no search, 12 ad-hoc sections | loads, no failed RPC | catalogue | search + web-sidebar grouping |
| Home | Notifications | native | opens | loads, no failed RPC | real (10,966 unread) |  |
| Home | Approvals | native | opens | loads, no failed RPC | real (none pending) |  |
| Home | Learn | web | opens | web page `learn` renders, connected | web page |  |
| Chat & Voice | Voice | web | opens | web page `voice` renders, connected | web page |  |
| Chat & Voice | Grid | native | opens | loads, no failed RPC | user layout (empty) | chat panel route fixed (/chat → /webchat); panels are WebViews — device only |
| Chat & Voice | Inbox | web | opens | web page `inbox` renders, connected | web page |  |
| Chat & Voice | Channels | web | opens | web page `channels` renders, connected | web page |  |
| Chat & Voice | Glasses | native | opens | loads, no failed RPC | needs camera | permission prompt only in the preview; device only |
| Chat & Voice | Video | native | opens; script/voice/send actions called RPCs that do not exist | loads, no failed RPC | needs camera | script via chat.send+agent.wait, frames via vision.pushFrame, send via `send`; local TTS step removed; not exercised end to end |
| Work | Documents | web | opens | web page `notes` renders, connected | web page |  |
| Work | Notes | native | not reachable from More/Launchpad | loads, no failed RPC | real (115 notes) |  |
| Work | Research | native | not reachable from More/Launchpad; fails: research.list | loads, no failed RPC | real (0 articles, 6 topics) | now the article feed the web Research tab shows |
| Work | Schedule | native | opens | loads, no failed RPC | real (55 jobs) |  |
| Work | Reports | native | opens | loads, no failed RPC | real |  |
| Work | Vault | web | opens | web page `vault` renders, connected | web page |  |
| Agents | Agents | native | opens; three fake fallback agents, '0 sessions / 0 messages / — tools' never populated; save called agents.update (unknown) | loads, no failed RPC | real (28 agents, default flagged) | edit saves through agents.management.update; set-default removed (needs a config rewrite + restart) |
| Agents | Activity | native | opens; live refresh subscribed to an event the gateway never emits | loads, no failed RPC | real (12 running) | follows the `chat` event; 'open in Board/Chat' links fixed |
| Agents | Agent Mesh | native | fails: sessions.list (unexpected property messageLimit) + endless subagents.list loop | loads, no failed RPC | real counts (5 agents, 1 node) | the World view is a WebView bundle — renders on device only; request flood fixed |
| Agents | Reviews | native | opens | loads, no failed RPC | real (100 reviews) |  |
| Agents | Ops Agents | native | opens | loads, no failed RPC | real |  |
| Agents | Autonomy | native | opens | loads, no failed RPC | real |  |
| Agents | Goals & Phases | web | two entries (Goals, Phases) opening the same web page | web page `autonomy` renders, connected | web page | merged: Goals and Phases are tabs inside the web Autonomy page |
| Agents | Workflows | native | not reachable from More/Launchpad | loads, no failed RPC | real (25) |  |
| Agents | Memory | native | fails: memory.list (unknown method); showed mock files | loads, no failed RPC | real (7 identity/memory files) | search filters file names (no server search RPC); zero-byte files labelled Empty |
| Agents | Knowledge Graph | web | opens | web page `memory` renders, connected | web page |  |
| Agents | Terminals | native | opens | loads, no failed RPC | real PTY list | xterm is a WebView — renders on device only |
| Agents | Workspace | web | opens | web page `workspace` renders, connected | web page |  |
| Agents | Federation | native | opens | loads, no failed RPC | real |  |
| Agents | Hardware | native | opens | loads, no failed RPC | real via HTTP (verified with curl: 200) | the browser preview is blocked by CORS; fine on device |
| Agents | Mesh Progression | native | CRASH (whole app) | loads, no failed RPC | real (Legend, level 78, 297,690 XP; quests; leaderboard) | crash: fontFamily was given an object; card also read a non-existent 'global' owner (showed Recruit · 0 XP) |
| Content | CMO | native | opens; private per-device session, never matched the web | loads, no failed RPC | real: the web's CMO thread | shares agent:cmo:cmo-chat + the chat UI |
| Content | Trends & Research | native | opens | loads, no failed RPC | honest empty state | `content.trends.last30days` returns nothing on this gateway yet |
| Settings | Settings | native | opens | loads, no failed RPC | real |  |
| Settings | Connections | native | opens | loads, no failed RPC | real |  |
| Settings | Plugins | native | opens | loads, no failed RPC | real |  |
| Settings | Credits & Usage | native | CRASH (whole app) | loads, no failed RPC | real ($836.39 this month) | fontFamily was given an object |
| Business & Agency | Business HQ | native | opens | loads, no failed RPC | real | opens the Business tab |
| Business & Agency | Command | native | opens | loads, no failed RPC | real |  |
| Business & Agency | Clients | native | opens; every client named 'Unknown' | loads, no failed RPC | real (1 client in this store) |  |
| Business & Agency | Sales Pipeline | web | opens | web page `pipeline` renders, connected | web page |  |
| Business & Agency | Register | native | opens | loads, no failed RPC | real (3 tracked) |  |
| Business & Agency | Leads & Funnels | web | opens | web page `leads` renders, connected | web page |  |
| Business & Agency | Business settings | web | opens | web page `business` renders, connected | web page |  |
| Solatrix | Terminal | web | opens | web page `solatrix` renders, connected | web page |  |
| Solatrix | Portfolio | web | opens | web page `solatrix-portfolio` renders, connected | web page |  |
| Solatrix | Wallets | web | opens | web page `solatrix-wallets` renders, connected | web page |  |
| Solatrix | Discovery | web | opens | web page `solatrix-discovery` renders, connected | web page |  |
| Solatrix | Copy Bot | web | opens | web page `solatrix-copy` renders, connected | web page |  |
| Solatrix | Bubble Map | web | opens | web page `solatrix-bubblemap` renders, connected | web page |  |
| Solatrix | Convergence | web | opens | web page `solatrix-convergence` renders, connected | web page |  |
| Solatrix | Alerts | web | opens | web page `solatrix-alerts` renders, connected | web page |  |
| Solatrix | Launcher | web | opens | web page `solatrix-launcher` renders, connected | web page |  |
| Solatrix | Map | web | opens | web page `solatrix-map` renders, connected | web page |  |
| Solatrix | Queue | web | opens | web page `solatrix-queue` renders, connected | web page |  |
| Solatrix | Settings | web | opens | web page `solatrix-settings` renders, connected | web page |  |
| Infinitrade | Market Knowledge Hub | web | opens | web page `infinitrade-knowledge` renders, connected | web page |  |
| Infinitrade | Economic Calendar | web | opens | web page `infinitrade-calendar` renders, connected | web page |  |
| Infinitrade | Market Scanner | web | opens | web page `infinitrade-scanner` renders, connected | web page |  |
| Infinitrade | Signals | web | opens | web page `infinitrade-signals` renders, connected | web page |  |
| Infinitrade | Trading Terminal | web | opens | web page `infinitrade` renders, connected | web page |  |
| Infinitrade | Trading Journal | web | opens | web page `infinitrade-journal` renders, connected | web page |  |
| Infinitrade | Accounts | web | opens | web page `infinitrade-accounts` renders, connected | web page |  |
| Infinitrade | Trading Toolkit | web | opens | web page `infinitrade-toolkit` renders, connected | web page |  |
| Infinitrade | Indicator Studio | web | opens | web page `infinitrade-indicators` renders, connected | web page |  |
| Infinitrade | Personal OS | web | opens | web page `infinitrade-personal` renders, connected | web page |  |
| Infinitrade | Research | web | opens | web page `infinitrade-research` renders, connected | web page |  |
| Infinitrade | Connection & Safety | web | opens | web page `infinitrade-settings` renders, connected | web page |  |
| Content Studio | Content Studio | native | opens | loads, no failed RPC | honest empty state |  |
| Content Studio | Content intelligence | native | opens | loads, no failed RPC | real (221 reels) |  |
| Discipline | Day | native | opens | loads, no failed RPC | real |  |
| Discipline | Focus board | web | opens | web page `discipline` renders, connected | web page |  |
| HoloCanvas | HoloCanvas | web | opens | web page `canvas` renders, connected | web page |  |
| Products | Catalog | web | opens | web page `products` renders, connected | web page |  |
| Products | Portfolio | native | opens | loads, no failed RPC | honest empty state |  |
| Robovoice | Robovoice | web | opens | web page `robovoice` renders, connected | web page |  |
| Whiteboard | Whiteboard | web | opens | web page `whiteboard` renders, connected | web page |  |
| Stack routes | Dashboard › BusinessCommandCenter | native | opens | loads, no failed RPC | real (7 active projects) | legacy hub kept; overlaps the Business tab |
| Stack routes | Dashboard › BusinessProfile | native | opens; save called business.update (unknown) | loads, no failed RPC | real | business.save |
| Stack routes | Dashboard › Leads | native | opens; Search button overlapped the 'Has Phone' filter | loads, no failed RPC | search tool (no results until searched) |  |
| Stack routes | Dashboard › Clients | native | opens; every client named 'Unknown' | loads, no failed RPC | real |  |
| Stack routes | Dashboard › Schedule | native | opens | loads, no failed RPC | needs Google Calendar connect |  |
| Stack routes | Dashboard › Databases | native | fails silently: notion.databases.list (unknown) | loads, no failed RPC | real (Notion databases) | notion.db.list / discover / add / pages.pull |
| Stack routes | Dashboard › IncomeStreams | native | fails: business.income.streams (unknown); edit duplicated the stream | loads, no failed RPC | real (none yet) |  |
| Stack routes | Dashboard › CustomerProfile | native | fails: notion.page.get etc. (unknown) | loads, no failed RPC | needs a customer id | opened without a customer in the audit; notion.get / notion.update / notion.db.pages.blocks |
| Stack routes | Business › Kanban | native | opens | loads, no failed RPC | real |  |
| Stack routes | Knowledge › Notes | native | opens | loads, no failed RPC | real |  |
| Stack routes | Knowledge › Research | native | fails: research.list (unknown method) | loads, no failed RPC | real |  |
| Stack routes | Knowledge › Workflows | native | opens | loads, no failed RPC | real |  |
| Stack routes | NotificationsPrefsModal | native | opens | loads, no failed RPC | real |  |
| Stack routes | WorkflowsModal | native | opens | loads, no failed RPC | real |  |

## Against the brief — done, partly done, not done

**Done and evidenced**

- Chat lists / creates / renames / deletes / switches the web's sessions; live both ways (`evidence/sync-proof.txt`, 12 of 12).
- Unread and "replying" markers, tool-call cards, `show_panel` as native cards (`evidence/unread-panel-report.json`, 8 of 8).
- Markdown, code blocks with copy, user images; agent switcher; logo avatars; tokens generated from the web CSS.
- Navigation regrouped with search; dead and duplicate entries removed; registry integrity tests.
- Deep links: the resolver tests pass; three real defects fixed (tabs stacked a second tab tree, "open in Board/Chat" links were dead under React Navigation 7, the web build treated its own address as a link).
- Keyboard: one navigator-level `KeyboardAvoidingView` for all stack screens. Verified by code only — there is no on-screen keyboard in a headless browser.
- Emoji used as icons replaced in 28 files (`evidence/polish-facts.txt` lists what is left and why).

**Partly done**

- "Same paging as the web": same lists and order; real offset paging waits on the gateway (above).
- Headers: one shared navigator header replaced three native styles. Many screens still draw their own title block under it, so the look is not yet uniform page to page.
- Pull-to-refresh and skeleton loaders: present in chat and on the screens listed in `evidence/polish-facts.txt`; not added across the board.
- Haptics: Android tick only; iOS needs `expo-haptics` (native build).
- Tablet: chat, More, Launchpad and the dock adapt; other screens are phone layouts stretched.

**Not done**

- Chat mic and speak buttons through Robovoice speech. Mobile voice goes to the Robovoice page (`evidence/voice-route-check.txt`); the chat composer has no mic and replies have no speak button.
- Per-chat model picker (the web has one).
- Write actions outside chat were not executed against the live gateway.
- Nothing was run on a phone, tablet or emulator.

**Removed rather than repaired** (each was either fake or unsafe; say if you want any back)

- Chat header "Model" button — it only changed client-side state and never reached the gateway.
- Federation node picker and multi-panel mode in the Chat tab — the web chat has neither; the Grid covers multi-panel.
- "Set as default agent" — it needed a whole-config rewrite from a redacted snapshot plus a gateway restart.
- Budget page (zeros from an unused store), Income "delete stream" (no RPC), Memory server search (no RPC), Video text-to-speech step (local TTS no longer exists).
- Unused files: the local-only chat drawer, legacy chat header/bubble/input, SessionsScreen, AuthScreen, FederationTerminalScreen and others nothing imported.

## Root causes worth knowing

1. **Request flood from Agent Mesh.** Its sub-agent fetcher depended on objects
   that are new on every render; each fetch re-rendered, re-created the fetcher
   and fetched again — `subagents.list` in a tight loop for as long as the
   screen was mounted. The live gateway stalled twice during the audit before
   this was found.
2. **Stacked tab trees.** React Navigation 7 pushes a second copy of a route
   that already exists lower in the stack. Opening a tab from an open modal
   (Launchpad, alert links, "open in Board") stacked a whole new tab tree, with
   every tab screen mounted and polling again. Tab destinations now pass
   `{ pop: true }`.
3. **Unstable `gateway` object.** About 40 hooks use the `gateway` prop as an
   effect dependency, and it was a new object on every root render, so screens
   refetched on unrelated re-renders. It now changes identity only when the
   connection status changes.
4. **Unbounded `sessions.list`.** Several callers asked for every session with
   derived titles and last messages — a transcript read per session, thousands
   of them. All callers are bounded now.
5. **Request names that drifted.** 27 names had no handler (`research.list`,
   `memory.*`, `agents.update`, `business.update`, `notion.databases.*`,
   `gateway:config.*`, `agent:chat`, …). Each was replaced by the current
   handler or the dead action was removed.

## Still open

- `notion.databases.query` / `notion.query` on the gateway call Notion without a
  timeout (`src/gateway/server-methods/notion-proxy.ts`); the Board takes ~10 s
  to paint and would hang for 30 s if Notion stalls. Gateway-side fix, not done
  here (it needs a gateway restart to take effect).
- Trends shows an honest empty state: `content.trends.last30days` returns
  nothing on this gateway yet.
- Paging: this gateway rejects `offset` (sessions) and `beforeIndex` (history),
  so "load older" uses a growing `limit` — the same data in the same order as
  the web, fetched less efficiently. Page one sends no paging param, so nothing
  is rejected on open; the single probe happens only when the user pages
  further, and the client switches to real paging by itself once the gateway
  accepts it.
- The legacy Business Command Center under Dashboard overlaps the Business tab.
  It is kept because Business Profile, Leads, Schedule, Databases and Income
  are reached from it.
- In-app alert toasts still overlay the header for a few seconds, including a
  toast for a reply in the chat that is already open.
- Model switching per chat (the web has a model picker) is not on mobile; the
  model is shown per reply.
- Screens outside the chat tab keep their own header styles inside the page;
  the shared header only replaced the navigator-level one.
