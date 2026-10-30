# InfiniBot Plugin Platform — design

Status: **design for owner approval**, with one working spike (§8).
Branch: `feat/plugin-platform-design` (based on `feat/saas-clerk-neon` @ `e94dfcd5`).
Owner summary: [`OWNER-SUMMARY.md`](OWNER-SUMMARY.md).

InfiniBot is "the AI OS". The plugin platform decides what that OS *is* (the
core) and how everything specialised gets built on top of it (plugins), by us
and by other people. Specialised AI OS products (Infinitrade, Robovoice,
OmniClinic, agency OS, creator OS…) become **plugin bundles on one core**
instead of forks of it.

Contents

1. Principles
2. Core vs plugin — every surface classified
3. Plugin SDK and manifest v2
4. Developer experience
5. Marketplace and UGC
6. First-party plugins: Robovoice, Infinitrade, InfiniCode, FlyPic
7. Rollout plan
8. Spike: InfiniCode as a v2 plugin (what was built and proven)
9. Decisions the owner needs to make

---

## 1. Principles

1. **The core is small and complete.** A fresh install with zero plugins is
   a working AI OS: chat, voice, agents, goals with verified completion,
   memory, projects and notes, terminals, channels framework, MCP, skills,
   settings, and the plugin host. Everything vertical is a plugin.
2. **Plugins are declared, not discovered.** A plugin's manifest lists every
   capability it contributes and every permission it needs. The host enforces
   the list at load time (the spike already does this for RPCs and HTTP
   routes). Nothing a plugin does is invisible to the user or the reviewer.
3. **One contribution model for first-party and UGC.** Our own plugins use the
   same manifest and SDK as community plugins. First-party plugins get a
   higher trust tier (in-process), not a private API.
4. **Dependencies point one way.** Plugins import the SDK; the core never
   imports a plugin. This is the same rule as
   [`docs/licensing/PRIVATE-SPLIT.md`](../licensing/PRIVATE-SPLIT.md), and
   plugins are how that split gets done: private and paid products ship as
   plugins through the registry, not in the FSL tree.
5. **Disabled means gone.** A disabled plugin has no nav entry, no page, no
   RPC method, no HTTP route, no tool, no cron job, no background service.
   The spike proves this for nav, page, RPC and HTTP (§8).
6. **Usage-based money only.** Paid plugins bill through InfiniBot Cloud
   credits, per use. There are no flat or unlimited plugin plans (matches the
   Cloud pricing rule).
7. **Verified completion applies to plugins too.** Plugin tools and agents
   report through the same RESULT/evidence contract, and the marketplace
   pipeline uses `visual_verify` for every UI-contributing submission.

---

## 2. Core vs plugin — every surface classified

Source inventory: the launch UI triage (`/tmp/launch-ui-triage/TRIAGE.md`,
99 surfaces, numbered in its §3 order) plus 36 backend-only features the
triage did not list (B1–B36). UI paths are relative to `ui/src/ui/`; backend
paths start with `src/`. `x.*` = RPC namespace in
`src/gateway/server-methods/x.ts`.

**Decision codes**

| Code | Meaning | Where it lives | Can be disabled |
|---|---|---|---|
| **C** | Core | FSL core tree | No |
| **FP** | First-party plugin, bundled | `extensions/<pkg>` in the FSL tree | Yes |
| **FM** | First-party plugin, marketplace-distributed | Registry (may be private source or paid) | Yes (not installed by default) |
| **MP** | Marketplace tier (community or low-priority first-party; not bundled) | Registry | n/a |
| **P** | Private hosted-cloud code (not a plugin) | Commercial repo | n/a |
| **X** | Remove | — | — |

**Effort:** S = gating/routing only; M = view + handlers move into a plugin
package; L = core imports the module today and needs a seam first.

### 2.1 UI surfaces (triage 1–99)

| # | Surface | Route / tab | Dec. | Package | Rationale | Key deps | Eff. |
|---|---|---|---|---|---|---|---|
| 1 | Dashboard → generic OS Home | `/`, `dashboard` | C | core | The OS needs its own home; Business HQ content moves to the business pack | new `views/home.ts`, `app-render.ts`, `controllers/first-run.ts` | M |
| 2 | First-run checklist | in dashboard | C | core | Onboarding is the OS | `controllers/first-run.ts`, `views/first-run-checklist.ts` | S |
| 3 | Learn | `learn` | C | core | Teaches the OS; plugins contribute tracks | `views/learn.ts`, `src/learn/bundled.ts`, `learn.*` | S |
| 4 | Learn missions panel | topbar overlay | C | core | Onboarding | `components/learn-missions-panel.ts` | S |
| 5 | Apps & Sites | `apps` (hidden) | FP | content-studio | Builder feature, overlaps Sites | `views/apps.ts`, `src/apps`, `apps.*` | S |
| 6 | Overview (legacy) | `overview` | X | — | Alias with no content | `TAB_REDIRECTS` | S |
| 7 | Webchat | `webchat` | C | core | The chat page | `views/webchat.ts`, `chat.*`, `sessions.*` | – |
| 8 | Grid | `grid` | C | core | Multi-panel chat layout; plugins add grid widgets; Solana panel dropped | `views/masonry-grid.ts`, `views/grid-panels/**` | S |
| 9 | Standalone `/chat` block | `chat` | X | — | Dead render block | `app-render.ts` | S |
| 10 | Voice (Talk) + wake word | `voice` | C | core | Voice is the moat; core owns the voice UI + provider interface (§6.1) | `views/voice-chat.ts`, `src/voice`, `src/tts`, `voicewake.*`, `talk.*`, `tts.*` | M |
| 11 | Voice › Commands | `voicecommands` | C | core | Voice control of the OS | `views/voice-commands.ts` | S |
| 12 | Agent chat modal (⌘⇧M) | overlay | C | core | Global quick chat | `components/agent-chat-modal.ts` | – |
| 13 | `<cmo-chat>` | in content-intel | X | — | Merge into the modal; CMO persona ships with content pack | `components/cmo-chat.ts` | S |
| 14 | Agent chat sidebar (autopilot) | overlay | X | — | Merge into the modal | `components/agent-chat-sidebar.ts`, `autopilot.*` | S |
| 15 | Live-action voice sidebar | topbar | C | core | Voice-driven UI control | `views/voice-chat.ts`, `ui-control.*` | – |
| 16 | Projects (kanban) | `projects` | C | core | What agents work on; Notion sync split out (B21) | `views/kanban.ts`, `src/projects`, `src/tasks`, `kanban.*` | S |
| 17 | Databases | `projects?view=databases` | C | core | Structured work data on a local store; Notion becomes a plugin backend | `views/databases.ts`, `src/databases`, `databases.*` | M |
| 18 | Issues | `issues` | C | core | Agent/dev issue tracking | `views/issues.ts`, `src/issues` | S |
| 19 | Notes | `notes` | C | core | Human knowledge | `views/notes.ts`, `src/notes` | – |
| 20 | Whiteboard | `whiteboard` | C | first-party plugin (off by default) | Agent-drivable canvas; legacy scene data enables it once and migrates idempotently to `plugin-data/whiteboard` | `extensions/mcp-excalidraw` | S |
| 21 | Topbar Canvas floater | overlay | C | Whiteboard contribution | Shortcut is present only while Whiteboard is enabled | `extensions/mcp-excalidraw` | S |
| 22 | Schedule (calendar, cron) | `schedule` | C | core | Schedule over the cron engine; Google/Calendly connectors split (B22) | `views/schedule.ts`, `src/cron`, `scheduled-tasks.*` | M |
| 23 | Discipline (Day) | `discipline` | FP | productivity | ADHD planner, not the OS; needs a completion-bus seam (4 core importers) — **converted: `extensions/discipline`, see [DISCIPLINE-PLUGIN.md](DISCIPLINE-PLUGIN.md)** | `views/discipline.ts`, `src/discipline`, `discipline.*` | M |
| 24 | Focus board | `focus` | FP | productivity | Same audience as Discipline — **part of the Discipline plugin (`discipline.focus.*`)** | `views/focus.ts`, `focus.*` | S |
| 25 | Canvas Library ("HoloCanvas") | `canvas` | FP | canvas-library | Deck library; canvas runtime stays core (B34). **Done** — [`canvas-library/README.md`](canvas-library/README.md) | `extensions/canvas-library`; core store/share/convert in `src/canvas-host` | M |
| 26 | Sites | `sites` (hidden) | FP | content-studio | Site builder | `views/sites.ts`, `landing-pages.*` | S |
| 27 | Design | `design` (hidden) | FP | content-studio | Creative tool | `views/design.ts`, `src/design` | S |
| 28 | Storyboard | `storyboard` (hidden) | FP | content-studio | Video pre-production (2 methods missing) | `views/storyboard.ts`, `src/storyboard` | S |
| 29 | Business HQ | `business-hq` | FP | business-agency | Becomes the pack's home page; strip owner IDs | `views/business-hq.ts`, `src/business-objects` (17 importers) | M |
| 30 | Command › Executive | `command-ceo` | FP | business-agency | CEO lens | `views/command-ceo.ts` | M |
| 31 | Command › Operations | `command-ops` | FP | business-agency | Merge into Executive | `views/command-ops.ts` | S |
| 32 | Command › Today | `agency-daily` | FP | business-agency | Agency daily board | `views/agency-daily.ts` | S |
| 33 | Command › Agencies | `agency-operations` | FP | business-agency | Agency CRUD (8.8k lines, 10 outside importers) | `src/agency-operations` | L |
| 34 | Command › Topology | `agency-topology` | FP | business-agency | Relations graph; delete KK/Vault mock | `views/agency-topology.ts`, `relations.*` | S |
| 35 | Topbar Agency chip | overlay | FP | business-agency | Only meaningful with agencies (needs topbar-slot contribution) | `components/agency-switcher.ts` | S |
| 36 | Clients (CRM + invoicing) | `clients` | FP | business-agency | CRM; abstract payments (Whop-only today) | `views/clients.ts`, `clients.*` | M |
| 37 | People | `opportunities?view=people` | FP | business-agency | Merge into Clients contacts | `views/person.ts`, `src/person` | S |
| 38 | Products › Catalog | `products` | FP | business-agency | Inventory/SKU | `views/products.ts` | S |
| 39 | Products › Portfolio | `product-portfolio` | FP | business-agency | Second product store; merge | `views/product.ts`, `src/product` | M |
| 40 | Register (Opps/Decisions/Risks/Commitments) | `opportunities…` | FP | business-agency | Business registers | `views/opportunity.ts` etc. | S |
| 41 | Leads / Qualifier / Pipeline | hidden | FP | business-agency | Sales ops | `views/leads.ts`, `leads.*`, `lead-tool.ts` | M |
| 42 | Funnels | hidden | MP | growth | 2/5 complete, 6 missing methods — below bundle bar | `views/funnels.ts`, `src/funnels` | M |
| 43 | Campaigns | hidden | MP | growth | Value 1/5, dead handler block | `views/campaigns.ts`, `src/campaigns` | S |
| 44 | Settings › Business | `business` | FP | business-agency | Income sync + embedded CRM; "Personalize your agent" step moves to core Setup | `views/business.ts`, `business.*` | M |
| 45 | Content Pages | `content-pages` | FP | content-studio | Social content ops (fix ManyChat fake-connect) | `views/content-pages.ts`, `content-pages.*` | M |
| 46 | Content Intelligence | `content-pages?view=intel` | FP | content-studio | Viral-format scoring; delete 181 IG thumbnails; private pipeline per PRIVATE-SPLIT §5 | `views/content-intel.ts`, `src/content/{intelligence,trends,viral-formats}` | M |
| 47 | Inbox (Mail) | `inbox` | FP | channel-email | Email is a channel; contributes a sub-view to core Channels host | `views/inbox.ts`, `gmail.*`, `email-accounts.*` | M |
| 48 | Research | `research` | C | core | Agent knowledge gathering (keyless); moves to Memory › Research; move `research.db` out of cwd | `views/research-intel.ts`, `src/research` | M |
| 49 | Vault (Kingly Vault) | `vault` (hidden) | X | — | Owner community SaaS (value 0/5); private per PRIVATE-SPLIT §4 | `views/vault-*.ts`, `src/vault` | S |
| 50 | Android-ops | `android-ops` (hidden) | X | — | Owner phone rack; seed has tailnet IPs | `src/android-ops` | S |
| 51 | Agents | `agents` | C | core | Roster + agent config | `views/agents-management`, `agents.*` | S |
| 52 | Skills | `skills` | C | core | Capability system; vertical skills move to plugins | `views/skills.ts`, `src/agents/skills` | S |
| 53 | Activity | `activity` | C | core | What agents are doing | `views/agent-activity*.ts` | S |
| 54 | Mesh (world map) | `mesh` | C | core | Visual orchestration; plugins add map layers | `views/agent-mesh-page.ts`, `components/agency-world-viz.ts` | S |
| 55 | Reviews | `reviews` | C | core | Verification of agent work | `views/reviews/**` | M |
| 56 | Oversight | `reviews?view=oversight` | C | core | Same data as Reviews; merge | `views/oversight/**` | M |
| 57 | Agent Focus modal | overlay | C | core | Agent detail | `components/agent-focus-*` | – |
| 58 | Reports | `reports` | C | core | Agent output docs; vertical report kinds move to plugins | `views/reports/**`, `src/reports` | S |
| 59 | Autonomy (Goals) | `autonomy` | C | core | Verified goal runs = the differentiator | `views/autonomy-goals.ts`, `src/autonomy/goals` | M |
| 60 | Workflows | `workflows` | C | core | Repeatable automation | `views/workflows.ts`, `src/workflows` | – |
| 61 | Prompt templates | `workflows?view=templates` | C | core | Workflow building block | `views/prompt-templates` | – |
| 62 | Terminals | `terminals` | C | core | CLI-coder orchestration | `views/terminals.ts`, `src/terminal`, `src/agents/coder-backend` | – |
| 63 | **InfiniCode mesh** | `inficode` | **FP** | **infinicode** | Plugin already existed (disabled); **converted in the spike (§8)** | `views/inficode/**`, `extensions/infinicode` | M |
| 64 | Workspace (IDE) | `workspace` | FP | dev-extras | Repeats Terminals + Files | `views/workspace.ts`, `git.*` | S |
| 65 | Files | `files` | C | core | Agent outputs, diff/revert | `views/files.ts`, `files.*` | – |
| 66 | Directory map | `files?view=directories` | FP | dev-extras | Niche; binds Notion DBs | `views/directories.ts` | S |
| 67 | Browser (relay setup) | `browser` | C | core | Agent browser control | `views/browser.ts`, `browser-tool.ts` | S |
| 68 | Memory › Agents | `memory` | C | core | What each agent knows | `views/memory-agents.ts` | S |
| 69 | Memory › Memory | `memory?view=memory` | C | core | Rewire from `localhost:3014` to gateway `memory.*` | `controllers/memory.ts`, `src/memory` | M |
| 70 | Knowledge graph | `memory?view=graph` | C | core | Visual memory | `views/knowledge-graph.ts` | – |
| 71 | Fleet › Federation | `federation` | FP | fleet | Multi-gateway UI; runtime stays core (B23) | `views/federation*.ts` | L |
| 72 | Fleet › Hardware | `federation?view=hardware` | FP | fleet | Node telemetry | `views/hardware-analysis.ts` | S |
| 73 | Ollama | `federation?view=ollama` | C | core | Local models are a core provider path; move to Models & Keys | `views/ollama-monitor.ts`, `src/ollama` | S |
| 74 | Instances | `instances` (hidden) | X | — | Value 1/5, empty assign menu | `views/instances.ts` | S |
| 75 | Nodes (exec approvals, pairing) | `nodes` (hidden) | C | core | Security controls; move to Setup › Devices | `views/nodes.ts`, `exec-approvals.*` | M |
| 76 | Setup (+ wizard) | `setup` | C | core | Config home; drop licence gate + owner URL | `views/setup.ts`, `wizard.*` | M |
| 77 | Quickstart / onboarding | in Setup | C | core | Merge into one flow; plugin packs chosen here | `views/setup-wizard.ts` | M |
| 78 | Config | `setup?view=config` | C | core | Raw config editor | `views/config*.ts` | – |
| 79 | **Plugins** | `setup?view=plugins` | **C** | **core** | The plugin host UI; **toggle added in the spike**; grows into the Marketplace | `views/plugins/index.ts`, `plugins.*` | M |
| 80 | Components (voice pack) | `components` | C | core | Host stays core; download backend → voice-local | `views/components-settings.ts` | S |
| 81 | Plan / Upgrade pill | topbar | X | — | kinglyvault.com upsell; Cloud-only chrome | `components/plan-badge.ts` | S |
| 82 | Channels | `channels` | C | core | Channels framework host; per-channel forms from plugin config schema | `views/channels*.ts`, `src/channels` | – |
| 83 | Channels › Inbox (comms) | `channels?view=inbox` | C | core | Cross-channel inbox | `views/comms-hub.ts`, `src/comms` | – |
| 84 | API keys | `apikeys` | C | core | BYOK | `views/apikeys` | – |
| 85 | Usage & plans | `apikeys?view=usage` | C | core | Usage tracking; plugin credit usage shows here | `views/credits.ts`, `credits.*` | S |
| 86 | MCP | `mcp` | C | core | MCP client + server; plugins contribute servers | `views/mcp.ts`, `src/mcp` | S |
| 87 | Profiles | `profiles` | C | core | Multi-user isolation | `views/profiles-manager.ts` | S |
| 88 | Users | `users` (hidden) | C | core | Merge into Profiles | `views/users.ts` | S |
| 89 | Appearance | `appearance` | C | core | Theming; plugins read tokens only | `views/appearance.ts` | S |
| 90 | Mobile | `mobile` | C | core | Mobile stays open | `views/mobile.ts` | S |
| 91 | Docs | `docs` | C | core | Needs public-docs allowlist; plugin docs section | `src/gateway/server-docs.ts` | S |
| 92 | Logs | `logs` | C | core | Operations | `views/logs.ts` | – |
| 93 | Debug | `logs?view=debug` | C | core | Operations | `views/debug.ts` | – |
| 94 | Launchpad (⌘P) | overlay | C | core | Command surface; plugins add entries | `views/launchpad.ts` | S |
| 95 | ⌘K | overlay | C | core | Command surface | `views/nav-sidebar-enhanced.ts` | S |
| 96 | Proactive overlay host | overlay | C | core | Notification layer; plugins emit through it | `components/proactive-*.ts`, `src/proactive` | – |
| 97 | Topbar Chart (Solana) | topbar | X | — | Value 0/5; can return inside Infinitrade | `views/solana-chart.ts` | S |
| 98 | Topbar bell | topbar | C | core | Notifications | `src/notifications` | S |
| 99 | Topbar Restart | topbar | C | core | Gateway control (add confirm) | `system.*` | S |

### 2.2 Backend-only features (B1–B36)

| # | Feature | Dec. | Package | Rationale | Key deps | Eff. |
|---|---|---|---|---|---|---|
| B1 | Gateway runtime, sessions, auth, config, routing | C | core | This is the OS | `src/gateway`, `src/config`, `src/sessions`, `src/routing` | – |
| B2 | Coder backends + durable tmux spawn | C | core | CLI orchestration | `src/agents/coder-backend` | – |
| B3 | Roster `core` pack (main + 4 coders) | C | core | Fresh-install default | `src/agents/standard-roster.ts` | – |
| B4 | Roster packs dev/content/business/ops | FP | dev-extras / content-studio / business-agency | Each pack ships with its plugin; `ops` split (overseer/monitor/archivist stay core opt-in) | `ROSTER_PACKS`, `agents.rosterPacks`, `agent-mcp-defaults.ts` | M |
| B5 | Goals, verification, visual_verify | C | core | Verified completion | `src/autonomy/goals`, `src/verification` | – |
| B6 | Legacy autonomy task queue | FP | dev-extras | Superseded by Goals | `src/queue`, `autonomous-tasks.*` | M |
| B7 | Cron engine | C | core | Plugins own their seeded jobs, seeded disabled (29 jobs seeded on a fresh boot today) | `src/cron` | M |
| B8 | Proactive engine | C | core | 21 outside importers; plugins emit through it | `src/proactive` | – |
| B9 | Proactive ADHD commitment/drift | FP | productivity | Personal productivity logic | `src/proactive/commit-store.ts` | M |
| B10 | Memory slot + memory-core | C | core | Default memory | `src/plugins/slots.ts`, `extensions/memory-core` | – |
| B11 | MCP server, client, discovery | C | core | Make `~/.claude.json` auto-register opt-in | `src/mcp` | S |
| B12 | Channels framework + channel SDK | C | core | Framework only | `src/channels`, `src/plugin-sdk` | – |
| B13 | Plugin host | C | core | This design | `src/plugins` | M |
| B14 | Skills loader + bundled skills | C | core | Loader core; vertical skills (flypic-design-agent, crm-manager, moltbook…) move to plugins | `skills/`, `src/agents/skills` | M |
| B15 | Reports renderer + Telegram sink | C | core | Canonical output; `kinds/ceo-hourly` → business pack | `src/reports` | S |
| B16 | Local voice engines (Kokoro, Whisper, voice packs) | FP | voice-local | Local is opt-in; no native binaries in core (sidecar-managed) | `docker-compose.voice.yaml`, `infinibot_stt/`, `voice-docker.*`, `voice-pack.*` | M |
| B17 | LiveKit agent + Robovoice proxy | **FM** | **robovoice** | Separate commercial product; realtime voice provider (§6.1) | `voice-agent/`, `server-voice-proxy.ts`, `voice.robovoiceUrl` | M |
| B18 | FlyPic media generation | **FM** | **flypic** | Separate commercial product; media provider (§6.4) | `agent-mcp-defaults.ts`, `skills/flypic-design-agent`, `notes-edit-flypic.ts` | S |
| B19 | Canva MCP preset | FP | content-studio | Only content agents use it | `agent-mcp-defaults.ts` | S |
| B20 | Instagram/socials/scripts/viral examples | FP | content-studio | Content pipeline | `src/content/*` (18 importers), `src/socials` | M |
| B21 | Notion integration | FP | notion | Third-party backend; the Home-stall fixes (`8c2f0108`…`e94dfcd5`) show the coupling cost | `notion-*.*`, `kanban-list-cache.ts` | L |
| B22 | Calendar connectors (Google, Calendly) | FP | productivity | BYO OAuth; core Schedule gets a local store | `calendar-sync.*`, `src/calendar` | M |
| B23 | Federation runtime | C | core (for now) | 53 outside importers; too coupled to move pre-launch; exposed to plugins via `api.federation` | `src/federation` | L |
| B24 | SSH devices, Tailscale, tunnel | FP | fleet | Multi-node ops | `ssh-devices.*`, `network-tailscale.*` | S |
| B25 | Licence gate + SaaS (Clerk/Neon) + fleet orchestrator | **P** | commercial repo | Hosted-ops code per PRIVATE-SPLIT §1–3; the marketplace registry lives here too (§5) | `src/license`, `src/saas`, `src/fleet` | M |
| B26 | Workforce / escalation / agency SOP loop | FP | business-agency | Agency operating model | `src/workforce`, `src/agency-operations` | L |
| B27 | Forms, Loops, ManyChat, Supabase helper | MP | growth | Marketing integrations | `forms.*`, `src/loops`, `manychat.*` | M |
| B28 | Hyprland/desktop tools, overlay daemon, VisionClaw | MP | desktop-linux | Owner's Linux setup | `hyprland-*.ts`, `extensions/infinibot-overlay` | M |
| B29 | Gamification | X | — | Nothing calls `mesh.gamification.*` | `src/achievements`, `src/cosmetics` | S |
| B30 | War room | X | — | Controller never imported | `src/war-room` | S |
| B31 | Moltbook | X | — | Upstream leftover | `moltbook.*`, `skills/moltbook` | S |
| B32 | Image Studio backend | X | — | View already removed | `src/image-studio` | S |
| B33 | Kingly Vault backend | X | — | Private (PRIVATE-SPLIT §4) | `src/vault` | S |
| B34 | Canvas host / canvas-workflows runtime | C | core | Proactive, reports and work-review render through it | `src/canvas-host`, `src/canvas-workflows` | – |
| B35 | OmniClinic (AI Doctor OS) | **FM** | omniclinic | Vertical product; same pattern as Infinitrade | branch `feat/omniclinic-doctor-ai-os` | L |
| B36 | **Infinitrade** (OmniTrade) | **FM** | **infinitrade** | Vertical product folded onto the main gateway (§6.2) | the separate `InfiniBot-omnitrade` checkout | L |

### 2.3 Counts

| Decision | UI (1–99) | Backend (B1–B36) | Total (135) |
|---|---|---|---|
| Core | 59 | 14 | **73** |
| First-party bundled (FP) | 29 | 10 | **39** |
| First-party marketplace (FM) | 0 | 4 | **4** |
| Marketplace tier (MP) | 2 | 2 | **4** |
| Private hosted (P) | 0 | 1 | **1** |
| Remove (X) | 9 | 5 | **14** |

FP UI surfaces by package: business-agency 14, content-studio 7, productivity 2,
dev-extras 2, fleet 2, infinicode 1, channel-email 1.

**Proposed bundled packages** (each is one `extensions/<pkg>` with a v2
manifest): `business-agency`, `content-studio`, `productivity`, `fleet`,
`dev-extras`, `voice-local`, `notion`, `channel-email`, `infinicode`, plus the
existing channel/provider/memory extensions. **First-party marketplace:**
`robovoice`, `infinitrade`, `flypic`, `omniclinic`. **Marketplace tier:**
`growth`, `desktop-linux`, tier-2 channels.

> **Status (2026-09-28, branch `plugin/business-agency`):** the
> `business-agency` package exists (`extensions/business-agency`). It covers
> rows 1 (generic core home), 29–36, 40, 41, 44 and the Leads/Funnels/Campaigns
> rows, plus B4 (business roster pack), B15 (`ceo-hourly`) and B26
> (workforce/SOP loop). Products stays its own plugin and is an optional
> integration. Inbox and Research stay core. See
> [BUSINESS-AGENCY.md](BUSINESS-AGENCY.md).

### 2.4 Notable calls

1. **Voice stays core, engines split.** Voice UI, wake word, live-action and
   cloud STT/TTS (BYOK providers) are core. Kokoro/Whisper → `voice-local`
   (FP). LiveKit realtime → `robovoice` (FM). A fresh install can talk with
   no plugin (cloud BYOK) and gets local voice with one toggle.
2. **Tier-1 channels are bundled plugins; tier-2 go to the marketplace.**
   The 8 channels in `CHAT_CHANNEL_ORDER` + LINE stay bundled. Note Telegram
   is wired into core (`telegram-send-tool.ts`, reports sink,
   `notifications/telegram-completions.ts`), so "Telegram is a plugin" is L.
3. **Federation runtime stays core; Fleet UI is a plugin.** 53 importers.
4. **Discipline is a plugin despite 4 core importers** — needs a
   completion-bus/hook seam first.
5. **Mail is `channel-email`, contributing a sub-view to the core Channels
   host** — requires host sub-view contributions (Phase 0).
6. **Research is core** (Memory › Research), once finance seed topics and
   the cwd `research.db` are fixed.
7. **Funnels/Campaigns go to the marketplace tier**, not the bundled
   business pack — below the bundle quality bar.
8. **Databases stay core, Notion becomes a plugin backend** (L).
9. **Ollama is core** (Models & Keys); Hardware is Fleet.
10. **Robovoice, Infinitrade, FlyPic, OmniClinic are first-party but NOT in
    the FSL tree.** They ship through the registry. This resolves the open
    `OWNER:` question in PRIVATE-SPLIT §6 ("generic external voice agent
    option or private plugin?"): **both** — core keeps a generic realtime
    voice-provider interface; Robovoice is a private plugin implementing it.

### 2.5 Existing `extensions/*`

Today `BUNDLED_ENABLED_BY_DEFAULT` is empty (`src/plugins/config-state.ts`),
so every bundled plugin is off unless configured; channel/provider plugins
auto-enable when their config exists (`src/config/plugin-auto-enable.ts`);
`memory-core` fills the memory slot.

| Extension | Kind | Today | Proposed |
|---|---|---|---|
| telegram, whatsapp, discord, slack, signal, imessage, googlechat, line | channel | off; auto-enable when configured | FP bundled |
| bluebubbles, matrix, mattermost, msteams, nextcloud-talk, nostr, tlon, twitch, zalo, zalouser | channel | off; auto | MP (tier-2) |
| voice-call | telephony | off | FP (voice is core) |
| memory-core | memory | **on** (slot) | C |
| memory-lancedb | memory | off | FP |
| copilot-proxy, google-gemini-cli-auth | provider | off; auto | FP |
| google-antigravity-auth, qwen-portal-auth | provider | off; auto | MP |
| llm-task, lobster | tool | off | FP |
| open-prose | skill pack | off | MP |
| diagnostics-otel | exporter | off | FP |
| **infinicode** | UI + RPC | off | **FP, v2 manifest (done in spike)** |
| mcp-excalidraw | Whiteboard manifest-v2 plugin + bundled MCP server | disabled on fresh installs | Existing installs with `.excalidraw` data are enabled once; explicit disable always wins and never deletes data |
| infinibot-overlay | scripts (no manifest) | n/a | MP `desktop-linux` |

`extensions/robopark-map` is gone from this tree; its `TAB_REDIRECTS`/`Tab`
leftovers can be deleted.

---
## 3. Plugin SDK and manifest v2

### 3.1 What exists today (v1) and what's missing

`src/plugins/**` already has a real plugin host: discovery (bundled
`extensions/*`, workspace, `plugins.load.paths`), a JSON manifest
(`infinibot.plugin.json`: id, configSchema, kind, channels, providers, skills,
uiHints, one `ui` block), config-driven enablement (`plugins.entries.<id>`,
allow/deny, memory slot), and a registration API (`registerTool`,
`registerHook`, `registerHttpRoute`/`registerHttpHandler`,
`registerGatewayMethod`, `registerService`, `registerProvider`,
`registerChannel`, `registerCli`, `registerCommand`, typed `on()` hooks).

Gaps this design closes:

| Gap | Consequence today |
|---|---|
| Capabilities are implicit (whatever `register()` calls) | Can't review, consent, or sandbox a plugin |
| Plugin RPCs are all admin-only (unclassified → admin) | Plugins can't offer read/write scopes |
| One `ui.entry` per plugin, rendered only inside the Plugins page | No real nav entries, pages, sub-views, widgets, overlays |
| No compatibility range | A plugin built for a future API loads and breaks |
| No enable/disable in the UI; restart via CLI | Owner can't manage plugins from the app |
| No per-plugin storage, secrets, credits, sidecars, MCP, roster, cron, panel kinds | Every first-party plugin reaches into core |
| Everything runs in-process with full Node access | UGC is impossible to allow safely |

### 3.2 Manifest v2

`"manifestVersion": 2` opts in. v1 manifests keep working unchanged (the
spike proves both load side by side). Implemented subset is marked ✅.

```jsonc
{
  "manifestVersion": 2,                       // ✅
  "id": "infinicode",                         // ✅ lowercase, globally unique in the registry
  "name": "InfiniCode",
  "version": "2026.9.28",                     // plugin's own version (semver or calver)
  "publisher": "infinibot",                   // ✅ registry publisher handle (= SaaS account/org)
  "description": "…",
  "license": "FSL-1.1-ALv2",                  // publisher's license (SPDX), checked at submission
  "engines": { "infinibot-plugin-api": "^2.0.0" },   // ✅ semver range vs PLUGIN_API_VERSION
  "runtime": "in-process",                    // "in-process" | "sandboxed" (default for UGC)
  "rpcNamespace": "infinicode",               // optional; defaults to id
  "configSchema": { … },                      // ✅ JSON Schema, as v1
  "contributes": {
    // UI surfaces
    "nav":      [{ "tab": "inficode", "label": "InfiniCode", "icon": "server", "group": "Agents" }],   // ✅
    "pages":    [{ "tab": "inficode", "route": "/inficode", "builtin": "inficode" }],                  // ✅ builtin | entry
    "navSection": { "title": "InfiniCode", "order": 100, "collapsedByDefault": false,
                    "items": [{ "page": "inficode", "label": "Fleet", "icon": "server" }] },            // ✅ optional — see SIDEBAR-SECTIONS.md
    "subviews": [{ "host": "channels", "id": "mail", "label": "Mail", "entry": "/plugins/x/mail.js" }],
    "widgets":  [{ "id": "pnl", "surface": "grid|dashboard", "entry": "…", "size": "2x1" }],
    "overlays": [{ "id": "call-hud", "entry": "…", "trigger": "event:robovoice.call.*" }],
    "settings": [{ "id": "robovoice", "label": "Robovoice", "entry": "…" }],  // or auto-form from configSchema
    "mapLayers":[{ "id": "fleet", "entry": "…" }],
    "mapRoom":  { "title": "InfiniCode Fleet", "theme": "fleet", "size": "M", "placement": "east" },   // ✅ room on the agent mesh map — see MAP-ROOMS.md
    "panelKinds":[{ "id": "trades", "schema": { … } }],       // show_panel kinds (chat-panels)
    "launchpad":[{ "id": "open-desk", "label": "Trading desk", "tab": "infinitrade-desk" }],
    "learn":    [{ "track": "infinitrade-basics", "path": "learn/basics.json" }],
    // Backend
    "rpc":      [{ "method": "infinicode.fleet.list", "scope": "read" }],   // ✅ read|write|admin, must be "<id>.*"
    "http":     ["/plugins/infinicode/commands"],                            // ✅ must be under /plugins/<id>/
    "tools":    [{ "name": "infinitrade_quote", "trust": "read" }],          // trust: read|write|exec|external-send
    "skills":   ["skills/"],                  // SKILL.md dirs shipped in the package
    "cron":     [{ "id": "scan", "schedule": "*/15 * * * *", "defaultEnabled": false }],
    "channels": ["line"],
    "providers":[{ "kind": "voice.realtime", "id": "robovoice" }],   // voice.stt|voice.tts|voice.realtime|media.generate|llm
    "hooks":    ["message:received"],
    "events":   { "emits": ["infinicode.status"], "subscribes": ["federation.*"] },
    "storage":  { "kv": true, "sqlite": ["fleet.db"] },
    "services": ["infinicode-fleet"],          // ✅ (listed; enforcement Phase 0)
    "sidecars": [{ "id": "agent", "image": "ghcr.io/…/robovoice-agent@sha256:…", "ports": [8081], "health": "/healthz" }],
    "mcpServers":[{ "id": "flypic", "url": "https://…/api/mcp", "auth": "secret:FLYPIC_TOKEN" }],
    "roster":   [{ "agentId": "trader", "file": "agents/trader.json" }]
  },
  "permissions": {                            // ✅ parsed + shown; enforced by runtime tier (§3.5)
    "network": ["api.tradelocker.com", "*.livekit.cloud"],
    "fs": ["plugin-data"],                    // only the plugin's own data dir unless listed
    "exec": false,
    "secrets": ["TRADELOCKER_EMAIL", "TRADELOCKER_PASSWORD"],
    "channels": [],                           // may send on these channels (e.g. "telegram")
    "credits": true                           // may charge InfiniBot Cloud credits
  }
}
```

Validation rules (fail closed; ✅ = enforced by the spike's
`src/plugins/manifest-v2.ts`):

- ✅ `engines["infinibot-plugin-api"]` required; host refuses to load a plugin
  whose range excludes `PLUGIN_API_VERSION` (status `error`, reason shown).
- ✅ RPC methods must be namespaced `<rpcNamespace>.*` (defaults to `<id>.*`);
  HTTP routes and page entries
  must live under `/plugins/<id>/`; every nav entry needs a page.
- ✅ Registering an RPC or HTTP route that isn't declared is rejected with a
  diagnostic; `registerHttpHandler` (catch-all) is refused for v2.
- Tools must be declared with a trust class; roster agents may only allow
  tools the plugin declares (no auto-grant of core tools).
- Sidecar images must be pinned by digest.

**Why a plugin-API semver separate from product calver:** the product ships
`2026.x.y` calver; plugins need to know when the *contract* breaks. Majors of
`infinibot-plugin-api` break plugins; minors add capabilities. The host
exports `PLUGIN_API_VERSION` (spike: `2.0.0`, since v1 is the implicit 1.x).

### 3.3 `@infinibot/plugin-sdk` (typed package)

Today plugins import `infinibot/plugin-sdk` via a jiti alias
(`src/plugin-sdk`). Phase 2 publishes it as a versioned npm package whose
major = plugin-API major.

```ts
import { definePlugin, z } from "@infinibot/plugin-sdk";

export default definePlugin({
  config: z.object({ accountId: z.string().optional() }),   // → configSchema
  register(api) {
    api.rpc("infinitrade.positions.list", { scope: "read" }, async (_p, ctx) => {
      const db = await api.storage.sqlite("trades.db");          // per-plugin, tenant-aware
      return db.all("select * from positions");
    });
    api.tool({ name: "infinitrade_quote", trust: "read", schema, run });
    api.cron("scan", async () => { … });
    api.events.emit("infinitrade.signal", payload);
    const creds = await api.secrets.get("TRADELOCKER_PASSWORD"); // vault-backed, declared only
    await api.credits.charge({ units: 1, sku: "infinitrade.signal", reason });
    api.panelKind("trades", { schema, resolve, query });
  },
});
```

Host services exposed on `api` (each gated by the manifest):

| Service | Backed by | Notes |
|---|---|---|
| `api.storage.kv()` / `.sqlite(name)` / `.dir()` | `<stateDir>/plugins/<id>/` via `resolveStateDir()` (tenant-namespaced in SaaS) | Deleted on uninstall unless "keep data" |
| `api.secrets.get/set` | `src/vault` | Only names listed in `permissions.secrets` |
| `api.credits.charge/estimate` | Cloud credits (`src/credits/aggregator.ts` locally for display) | Only with `permissions.credits`; user sees per-plugin usage in Keys & Usage |
| `api.fetch` | host fetch with host allowlist | Sandboxed plugins have no other network path |
| `api.events.emit/on` | gateway broadcast + federation bus | Replaces the direct `getFederationHub()` import InfiniCode uses today |
| `api.federation` | `src/federation` | role, publish, invokeOnNode |
| `api.sidecars.ensure/stop/health` | docker-manager generalised from `src/gateway/voice/native/docker-manager.ts` | Digest-pinned images only |
| `api.mcp.register` | `mcp-servers` config | Removed on disable |
| `api.roster.register` | `agents.rosterPacks` | Tools limited to plugin-declared ones |
| `api.ui.notify/proactive` | proactive overlay host | Uses the existing overlay kinds |
| `api.verification.report` | `src/verification` | Plugin agents emit RESULT evidence like core agents |

**UI kit** (`@infinibot/plugin-sdk/ui`): Lit web components + CSS custom
properties mirroring the core tokens (`--g-primary`, `--g-line`, `--g-muted`,
`--g-state-*`, glass tokens), so plugin pages look native without importing
core CSS: `<ib-page>`, `<ib-card>`, `<ib-table>`, `<ib-switch>`,
`<ib-empty>`, `<ib-stat>`, `<ib-chart-line>`, plus a typed `rpc()` client and
`subscribe(event)`. The spike's Plugins-page switch is the first `ib-switch`.
Brand rule: no provider logos in the kit or in listings
([`docs/licensing/BRAND-USAGE.md`](../licensing/BRAND-USAGE.md)).

### 3.4 UI contribution model

Two kinds of plugin UI:

1. **First-party builtin pages** — compiled into the control-UI bundle as a
   lazy chunk (fast, same design system). The manifest's `pages[].builtin`
   names the chunk; the UI's `FIRST_PARTY_PAGES` map
   (`ui/src/ui/plugin-host.ts`) says which tab renders it. **Such tabs are
   plugin-gated:** no sidebar entry and a "turned off" card unless the owning
   plugin is loaded. ✅ (spike)
2. **Entry-module pages** (marketplace) — an ES module served by the plugin
   under `/plugins/<id>/…`. Trusted first-party plugins may mount as a web
   component in the main document (today's `ui.entry` path). Sandboxed plugins
   mount in a **sandboxed iframe** (`sandbox="allow-scripts"`, no
   `allow-same-origin`, strict CSP `default-src 'none'; script-src 'self'
   /plugins/<id>/; connect-src 'none'`), talking to the host through a
   `postMessage` bridge that exposes only the plugin's declared RPCs and
   events. The iframe never sees the gateway token.

The UI host builds everything from `plugins.list`: one sidebar section per
enabled plugin with pages ✅ ([SIDEBAR-SECTIONS.md](SIDEBAR-SECTIONS.md); nav
`group` no longer places entries inside core groups), launchpad entries ✅,
labels ✅, page gating ✅, and in Phase 0 host sub-views (extends
`HOST_SUBVIEWS` at runtime), grid/dashboard widgets, overlays, settings
sections, map layers, launchpad entries.

**Learn tracks** ✅: `contributes.learn` (inline, or a `learn.json` inside the
plugin) ships guided walkthroughs, a quiz and a mastery badge. They are listed
on the Learn page, as "Take the tour" on the Plugins page and as the
"Learn this" chip on the plugin's routes, only while the plugin is enabled
(live toggle `learn:<trackId>`). See [LEARN.md](LEARN.md).

### 3.5 Isolation and trust tiers

| Tier | Who | Runtime | Access |
|---|---|---|---|
| **T0 core-trusted** | First-party, signed with the InfiniBot key | In-process (jiti, as today) | Full `api`, still limited to declared contributions |
| **T1 verified** | Registry-reviewed publisher + explicit user consent to "run in-process" | In-process | Same as T0; shown with a warning |
| **T2 sandboxed** (default for UGC) | Everyone else | Separate Node process started with Node 22's permission model (`--permission --allow-fs-read=<pkg> --allow-fs-write=<plugin-data>`, no `--allow-child-process` unless `exec` granted, no addons), on Linux additionally under `bubblewrap`/landlock with no network namespace access except the host proxy | Talks to the host over JSON-RPC on stdio; every `api.*` call is checked against the manifest by the host; network only via `api.fetch` (host allowlist); UI only via sandboxed iframe |

What a T2 plugin can never do: read other plugins' data or the gateway
config/credentials, spawn processes without `exec`, open sockets, import core
modules, register undeclared capabilities, or run code in the control-UI
origin.

**Integration with W5 tool trust** (`src/routing/sender-trust.ts`,
`src/agents/pi-tools.trust.ts`): every plugin tool declares a trust class.
`read` tools are available to all turns; `write`/`external-send` tools are
removed for `untrusted-sender` turns and require `tools.trust.untrustedTools`
opt-in; `exec` tools follow the exec policy (deny/ask on untrusted content).
Plugin tools are never in `DEFAULT_UNTRUSTED_SENDER_TOOLS`. Plugin RPC scopes
plug into gateway authorization (✅ spike: `resolvePluginMethodScope` in
`src/plugins/runtime.ts`, consulted by `authorizeGatewayMethod`); a disabled
plugin's scopes disappear with it.

**Integration with W2 HTTP auth** (`src/gateway/http-auth.ts`): `/plugins/*`
is already classified *protected* (non-SPA prefix). Plugins can't declare
public routes; routes that remote machines poll (InfiniCode's
`/plugins/infinicode/commands`) use **scoped plugin tokens** minted per node
(Phase 0), not the gateway password.

**Integration with verified completion:** plugin-contributed agents and tools
use the RESULT contract; plugin cron jobs report outcomes through
`api.verification.report`; the marketplace pipeline runs `visual_verify` on
every declared page/widget (§5.3).

### 3.6 Lifecycle

| Step | What happens | State |
|---|---|---|
| **install** | Download from registry (or local path), verify publisher signature + registry countersignature + digest, show permissions consent, unpack to `<stateDir>/plugins/pkgs/<id>@<ver>/` | `plugins.installs.<id>` (exists: `src/plugins/installs.ts`) |
| **enable** | `plugins.setEnabled {id, enabled:true}` ✅ → config write → load. Spike: in-process gateway restart; Phase 0: hot load (per-plugin handler/route scopes, `plugins.entries.<id>` becomes a hot reload rule) | `plugins.entries.<id>.enabled` ✅ |
| **configure** | Settings section (auto-form from `configSchema` or plugin-provided) → `plugins.entries.<id>.config`; secrets go to the vault | config + vault |
| **migrate** | On version change, run the plugin's `migrations/NNN-*.{sql,ts}` against its own storage in a transaction; record `schemaVersion` | `<plugin-data>/.meta.json` |
| **disable** | Unregister everything (nav, pages, RPCs, routes, tools, cron, services, MCP entries, roster agents); stop sidecars; data kept ✅ (nav/page/RPC/route) | entry `enabled:false` ✅ |
| **update** | Same as install for the new version; keep previous version dir for **rollback** | `installs.<id>.previous` |
| **uninstall** | Disable, remove package dir, remove config entry, delete `<plugin-data>` unless user ticks "keep data", revoke plugin tokens, remove vault secrets | clean state |

### 3.7 Compatibility with v1

v1 manifests load exactly as today (no `contributes`, implicit capabilities,
admin-only RPCs, `ui.entry` inline panel). The registry only accepts v2.
Bundled v1 extensions migrate to v2 one by one in Phase 1; after two releases
v1 loading is warned, and dropped at plugin-API 3.0.

---

## 4. Developer experience

### 4.1 CLI

`infinibot plugin …` (extends the existing `infinibot plugins` command in
`src/plugins/cli.ts`):

| Command | Does |
|---|---|
| `create <id> --template <t>` | Scaffold from a template (below), with v2 manifest, SDK, tests, README, LICENSE picker |
| `dev` | Link the package into a **side gateway** on a free port with a throwaway state dir (the spike's `pp-start.sh` recipe, productised: scrubbed env, channels/cron off), watch + hot reload backend (re-register on change) and UI (Vite HMR for entry modules); opens the control UI with the plugin enabled |
| `build` | Bundle backend (esbuild, node22 target) + UI entries; emit `dist/` and a content digest |
| `test` | Run the plugin's vitest suite against the **local test harness**: an in-memory host implementing `api` (fake storage/secrets/credits/fetch), plus a contract test that loads the manifest through the real `loadInfiniBotPlugins` and asserts declared = registered |
| `verify` | Boot the side gateway, enable the plugin, run `visual_verify` over every declared page/widget at desktop + mobile, fail on console errors / failed RPCs |
| `pack` | Produce `<id>-<version>.ibp` (tarball + manifest + digest + SBOM) |
| `publish` | Sign with the publisher key (from `infinibot login` → SaaS account), upload to the registry, stream submission status |
| `doctor` | Lint manifest, check permissions vs code (static scan for `fs`, `child_process`, `net` imports), license check |

### 4.2 Templates

| Template | Contains |
|---|---|
| `ui-page` | One nav entry + page (entry module using the UI kit) + read RPC |
| `agent-tool` | One declared tool with trust class + skill + test |
| `channel` | Channel plugin skeleton on the existing channel SDK (`src/channels/plugins`) |
| `voice-provider` | Implements `voice.stt`/`voice.tts`/`voice.realtime` provider interfaces (§6.1) |
| `data-connector` | OAuth/API-key connector: secrets, cron sync, storage, a Databases source |
| `vertical-os` | Bundle template: several pages + roster agent + panel kinds + learn track (how Infinitrade/OmniClinic are shaped) |

### 4.3 Docs and examples

- Docs section `docs/plugins/` served in-app via Docs and on the public site:
  quickstart (create → dev → publish in 10 minutes), manifest reference
  (generated from the manifest-v2 parser so it can't drift), SDK reference
  (typedoc), UI kit gallery, security model, review guidelines, monetisation.
- Examples: `extensions/infinicode` (UI + RPC + HTTP, first v2 plugin),
  `examples/plugins/hello-page`, `examples/plugins/weather-tool`,
  `examples/plugins/csv-connector`.

---
## 5. Marketplace and UGC

### 5.1 Registry service (InfiniBot Cloud)

Built the same way as the cloud-serverless surfaces (`feat/cloud-serverless`,
infinibot-cloud.netlify.app): thin Netlify Functions (`netlify/functions/
registry.mts`, `submissions.mts`, `plugin-assets.mts`) delegating to
`src/saas/cloud/registry/*.ts`, stateless per request, Clerk session auth,
Neon Postgres, artifacts in object storage (Netlify Blobs first; R2/S3 when
volume needs it), private code per PRIVATE-SPLIT (B25).

Neon schema (new `registry_*` tables next to the existing `surface_*` ones):

| Table | Key columns |
|---|---|
| `registry_publishers` | id, clerk_user_id / clerk_org_id, handle, display_name, verified, payout_account, public_keys[] (ed25519), status |
| `registry_plugins` | id (= manifest id), publisher_id, name, summary, categories[], tier (FM/MP), listing_status, pricing_model, created_at |
| `registry_versions` | plugin_id, version, plugin_api_range, manifest (jsonb), artifact_key, sha256, publisher_sig, registry_sig, sbom (jsonb), permissions (jsonb), review_status, published_at, yanked |
| `registry_submissions` | id, plugin_id, version, stage, check_results (jsonb), screenshots[], reviewer, decision, notes |
| `registry_installs` | plugin_id, version, tenant_or_install_hash, installed_at, uninstalled_at (anonymous counts for self-hosted; tenant-linked for Cloud) |
| `registry_reviews` | plugin_id, user_id, rating 1–5, body, version, status |
| `registry_reports` | plugin_id, version, reporter, reason, evidence, status, action |
| `registry_payouts` | publisher_id, period, credits_earned, revenue_share, status |

API (JSON over HTTPS; public reads cacheable at the edge):

| Endpoint | Auth |
|---|---|
| `GET /api/registry/plugins?q=&category=&api=2.0.0` | public |
| `GET /api/registry/plugins/:id` / `…/versions` | public |
| `GET /api/registry/artifacts/:id/:version` | public (signed URL) |
| `POST /api/registry/submissions` (multipart `.ibp`) | Clerk session, publisher |
| `GET /api/registry/submissions/:id` | publisher / reviewer |
| `POST /api/registry/submissions/:id/decision` | reviewer role (Clerk org role) |
| `POST /api/registry/plugins/:id/yank` / `takedown` | publisher (yank) / admin (takedown) |
| `POST /api/registry/reviews`, `/reports` | Clerk session |
| `GET /api/registry/revocations` | public — signed list the gateway polls |

Self-hosted gateways talk to the registry anonymously for browse/install;
installing a **paid** plugin or publishing requires `infinibot login` (Clerk
device flow → Cloud account), which also links credits.

Listing metadata travels in the manifest's optional `listing` block
(tagline, markdown description, category, tags, cover, icon, screenshots,
publisher, links — see [PLUGINS-PAGE-CONTROL](PLUGINS-PAGE-CONTROL.md#store-listing-listing-optional--any-manifest-version)).
The gateway already renders it in Setup › Plugins for installed plugins; the
registry reuses the same parser for submissions, and adds ratings, install
counts and reviews from `registry_reviews` / `registry_installs` — the UI shows
those only when that real data exists.

### 5.2 Publisher accounts

Publisher = a SaaS (Clerk) user or Clerk organization. Onboarding: accept
the Publisher Agreement (revenue share, content rules, takedown, trademark
rules), register an ed25519 public key (CLI generates it; private key stays
on the publisher's machine), optional identity verification (required for
paid plugins and for T1 "run in-process" eligibility), payout details.
Org publishers get roles (owner / maintainer) via Clerk orgs.

### 5.3 Submission pipeline

```
upload .ibp ─► 1 static checks ─► 2 build/repro ─► 3 automated tests ─► 4 visual verify ─► 5 review ─► 6 sign + publish
                 (seconds)          (minutes)        (minutes)            (minutes)          (human+AI)     (seconds)
```

1. **Static checks** (Netlify Function, synchronous):
   - manifest v2 validation with the *same* parser the gateway uses
     (`src/plugins/manifest-v2.ts` shipped in the SDK);
   - id/name squatting and trademark rules (no "InfiniBot Official…", no
     provider logos in listing assets — BRAND-USAGE.md);
   - **license check**: the plugin's declared SPDX license + every bundled
     dependency through the `scripts/check-licenses.mjs` allowlist logic
     (copyleft/unknown fail for T0/T1; GPL-family allowed only for T2
     sandboxed plugins that don't link into core, and never for bundled FP);
   - **secret scan** (gitleaks-style patterns + entropy) over the package;
   - **permission/static analysis**: AST scan for `node:fs`, `child_process`,
     `net`, `dgram`, `worker_threads`, `eval`/`new Function`, dynamic
     `import()` of URLs, native addons; every hit must be covered by a
     declared permission, else reject; T2 packages may not contain native
     addons at all;
   - malware heuristics: obfuscation score, minified-only sources without
     source maps, install scripts (forbidden), known-bad hash list.
2. **Build reproducibility** (queued worker — a Fly Machine job, same infra
   as fleet): rebuild from the submitted source with the pinned SDK version;
   the rebuilt digest must equal the uploaded `dist/` digest (source must be
   included for review even for closed-source listings — held privately).
3. **Automated tests:** run `infinibot plugin test` (plugin's suite + the
   contract test: declared = registered, disable leaves nothing behind).
4. **Visual verify:** boot a side gateway (fresh state, no secrets), enable
   the plugin, run `visual_verify` over every declared page/widget/settings
   section at 1440×900 and 390×844; screenshots are attached to the
   submission and become the listing's default screenshots; console errors
   or failed RPCs fail the stage.
5. **Review:** an AI reviewer pass (permission sanity: "does a weather widget
   need `exec`?", listing honesty vs screenshots, prompt-injection in tool
   descriptions) produces a report; a human reviewer approves. First version
   of every plugin, any permission increase, and any paid plugin always get a
   human. Pure metadata updates can auto-approve.
6. **Sign + publish:** registry countersigns `{id, version, sha256,
   publisher_sig, permissions}` with the registry key (held as a Netlify
   secret → KMS later); version becomes installable.

### 5.4 Signing and integrity

- Publisher signs the package digest with their ed25519 key at `publish`.
- Registry verifies it against the registered key and adds its own
  countersignature after review.
- **The gateway verifies both signatures + the digest before install and
  again before every load of a registry-installed plugin**; the registry
  public key ships in core (rotatable via a signed key-rotation record).
- The gateway polls the signed **revocation list**; a revoked version is
  disabled on next load with a visible reason (malware takedown path).
- First-party T0 plugins are signed with the InfiniBot publisher key; only
  those (and user-approved T1) may run in-process.

### 5.5 Versions, updates, rollback

Semver for plugins in the registry; each version records its
`infinibot-plugin-api` range, and the in-app Marketplace only offers versions
compatible with the running gateway. Update modes per plugin: manual
(default), auto-minor, auto-all. **A permission increase always requires
re-consent**, even with auto-update. Previous version stays on disk for
one-click rollback; publishers can **yank** a version (hidden, existing
installs warned); admins can **take down** (revocation list).

### 5.6 Ratings, reviews, installs

1–5 stars + text, one per account per plugin, tied to the installed version;
publisher replies; review moderation queue. Install counts: Cloud tenants
exact; self-hosted counted anonymously (salted install hash, opt-out in
Settings). Listing shows: installs, rating, last updated, permissions
summary, tier badge (First-party / Verified / Community), price model,
screenshots from the visual-verify stage.

### 5.7 Abuse reporting and takedown

In-app "Report plugin" (reason + optional evidence) → `registry_reports` →
triage SLA (malware/credential theft: immediate takedown via revocation list
+ publisher suspended pending review; policy violations: publisher notified,
7 days to fix; IP/trademark: notice-and-takedown process linked from
TRADEMARKS.md). Every takedown is logged with the reason shown to users.

### 5.8 Pricing and revenue share

Consistent with Cloud's **usage-based credits (never flat/unlimited)**:

| Model | How it works |
|---|---|
| Free | No charge |
| **Metered** | Plugin calls `api.credits.charge({units, sku})`; SKUs + credit price per unit declared in the listing and reviewed; user sees an estimate before first use and per-plugin usage in Keys & Usage |
| One-time unlock | Allowed only as credits (e.g. 500 credits to unlock), not a subscription |

Paid plugins require an InfiniBot Cloud account (self-hosted users log in to
link credits). Publisher revenue share: **publisher gets X% of credits spent
in their plugin, net of provider pass-through costs** (proposal: 70/30 for
community, 80/20 once a publisher passes a volume threshold — owner decision
§9). Payouts monthly via the existing payment rail (Whop today, as Robovoice's
edge-client credits already use). First-party paid plugins
(Robovoice minutes, FlyPic generations, Infinitrade signals) use the same
metering path, so there is one credits ledger.

### 5.9 In-app Marketplace UI

Setup › Plugins grows into **Plugins | Marketplace | Updates** sub-views:

- **Marketplace:** search, categories (Vertical OS, Voice, Media, Channels,
  Data connectors, Productivity, Dev), tier filter, compatible-only default.
- **Plugin detail:** screenshots, description, publisher, rating, installs,
  price model, **permissions in plain language** ("Connects to
  api.tradelocker.com", "Stores 2 secrets", "Can spend credits").
- **Install → consent dialog** listing every permission and contribution
  (the same data the spike's caps line shows), T1 in-process opt-in as a
  separate, warned checkbox.
- **Updates:** available updates, changelog, permission diffs highlighted,
  rollback.
- Installed plugins keep the enable switch (✅ spike).

### 5.10 Licensing rules for plugins

- Plugins carry **their publisher's own license** (declared SPDX in the
  manifest, checked at submission). The FSL core license does not extend to
  plugins, and plugins don't gain rights to the core beyond the FSL.
- Plugins may not contain InfiniBot core code copied out of the tree (that
  would be redistributing FSL code under another license); they depend on
  the SDK, which is published under a permissive license (proposal:
  Apache-2.0 for `@infinibot/plugin-sdk` so any plugin license can use it —
  owner decision §9).
- **No GPL/AGPL in anything bundled into core** (FP packages follow the core
  license allowlist). Copyleft plugins are allowed only as marketplace T2
  plugins that run out-of-process.
- A plugin whose main purpose is to re-host InfiniBot as a competing
  commercial service is a Competing Use under the FSL and is rejected.
- Trademarks: "for InfiniBot" naming is fine (TRADEMARKS.md "Uses you don't
  need to ask about"); "InfiniBot" as the leading word of a plugin name,
  InfiniBot logos, and third-party provider logos in listings are not.

---

## 6. First-party plugins

Shared new core APIs all four need (build in Phase 0, ~4–5 engineer-days
of the Phase 0 total): `registerPanelKind`, `registerMcpServer` /
`registerSkill` / roster contributions, tenant-aware `api.storage`,
vault-backed `api.secrets`, `api.federation`, `api.credits`, sidecar
lifecycle, multi-page nav + overlays, plugin-declared RPC scopes (✅).

### 6.1 Robovoice — realtime voice provider plugin (FM)

**Core keeps a voice provider interface** (voice is core):

- Promote `src/gateway/voice/types.ts` (`SttProvider`, `SttStream`,
  `TtsProvider`) into the SDK and add `RealtimeSessionProvider`:
  `createSession({agentId, character, tenant}) → {url, token, expiresAt}`,
  `end`, `status`, plus usage events (seconds) for credits.
- Make `src/gateway/voice/providers/registry.ts` pluggable
  (`registerProvider({kind:"voice.stt"|"voice.tts"|"voice.realtime"})`).
- Core keeps: cloud BYOK STT/TTS providers (groq/openai/deepgram,
  elevenlabs/openai/cartesia), the voice UI shell, wake word, live-action,
  `voice-fast-path.ts`, `src/voice/*`, `src/tts/*`, `voice.json` /
  `voice-settings.json`.

**voice-local (FP, bundled):** native whisper/Kokoro providers,
`native/*`, `kokoro-bootstrap.ts`, kokoro/speaches in `docker-manager.ts` →
declared sidecars; voice packs. Local-first path = enable voice-local.

**Robovoice plugin (FM, `extensions/robovoice` in a private repo):**

| Moves in | From |
|---|---|
| Robovoice proxy (becomes `/plugins/robovoice/*`, no more `/api/settings` / `/api/voices` collision with core `server-voice-config.ts`) | `src/gateway/server-voice-proxy.ts` |
| LiveKit token minting → `RealtimeSessionProvider` | `src/gateway/server-voice-connection.ts` (+ livekit parts of `server-voice-urls.ts`) |
| `voice.robovoiceUrl`, `voice.livekitUrlExternal`, LiveKit key/secret → plugin config + vault (removes the `"devkey"` default, `server-voice-connection.ts:46`) | `types.infinibot.ts:361`, env |
| livekit + voice-agent services → declared sidecars (Robovoice image) | `docker-compose.voice.yaml`, `voice-agent/` (delete the in-repo copy, 2k lines, drifting from `voice_agent.py`) |
| InfiniBot tool bridge → plugin-registered tools/routes | `Robovoice-Prod/scripts/infinibot-mcp-http.mjs` (413 L) |
| Call surface, character/pipeline picker, credits view → plugin page + call-HUD overlay | carved out of `views/voice-chat.ts` (10,987 L monolith) |

Stays in Robovoice-Prod: the Next.js SaaS dashboard, Neon/Clerk
multi-tenancy, billing. The plugin talks to Robovoice Cloud over HTTP.
**Cloud path:** plugin → Robovoice Cloud/LiveKit Cloud, metered via
`api.credits.charge` (1 credit = 1 s standard voice, matching Robovoice's
edge-client model). **Local path:** voice-local (Kokoro/whisper) with no
Robovoice at all.

Risks: `voice-chat.ts` monolith extraction (main cost); credit semantics
(Robovoice seconds vs core provider-cost credits) must be unified in one
ledger; LiveKit secrets must never default. **Effort: 12–16 engineer-days**
(interface+registry 3, plugin skeleton+proxy+session+sidecar 4, UI carve-out
4–6, credits+tool bridge 2, tests 1–2).

### 6.2 Infinitrade — vertical OS plugin on the main gateway (FM)

Today: separate fork the separate `InfiniBot-omnitrade` checkout
(`feat/omnitrade-integration` @ `88019db0`, 152 commits past merge-base
`01382094`, 1,061 files changed), own gateway on :18911, state
`~/.infinibot-omnitrade`.

| Moves into `infinitrade` | Size |
|---|---|
| `src/omnitrade/**` (signals, aurum, intel, research, indicators, scanner, journal-insights, trade-archive, terminal, panel, personal, store/risk/credentials…) | ~21.6k L |
| `src/execution/**` (TradeLocker, Solana) | 3.9k L |
| 13 `server-methods/omnitrade*.ts` (~120 methods) + `server-omnitrade-identity-http.ts` | ~4.1k L |
| Trading UI views (desk, journal ×5, terminal, toolkit, market-intel, scanner, signals, personal-os, onboarding wizard, agent map) | ~14.3k L |
| Trading panel kinds + `<omnitrade-panel-modal>` | via `registerPanelKind` |

Stays in core (upstreamed separately first): the tenancy layer
(`src/config/tenant-context.ts`, `tenant-resource-cache.ts`,
`src/gateway/tenancy/*`), the generic chat-panel host + show_panel tool
(extended with plugin panel kinds). Out of scope: the fork's `saas/` and
`mobile/` apps.

API needed from core: ~120 declared RPCs (**renamed to `infinitrade.*`**,
with temporary aliases — `market.*`, `signals.*`, `research.*`, `journal.*`,
`personal.*` are too generic and collide), `registerPanelKind`, tenant-aware
storage, vault secrets for TradeLocker/Solana creds, services for
scanner/signal/archive loops, declared tools + an analyst roster agent
(no more hand-editing `infinibot-tools.ts` + `main.toolsAllow` + live config
— the "new tool trap"), multi-page nav (Desk, Journal, Scanner, Signals,
Intel, Research, Personal OS), events for panel show / signal emit.

Data migration (one-shot `infinibot plugin migrate infinitrade --from
~/.infinibot-omnitrade`): WAL-checkpoint then copy `signals.db`,
`trade-archive.db`; copy JSON stores (`journal`, `indicators`,
`accounts-meta`, `aurum-sim`, `research-library`, `scanner-*`,
`terminal-layouts`, `ai-insights-cache`) to `<stateDir>/plugins/infinitrade/`;
re-encrypt `secrets/` into the vault; keep `OMNITRADE_STATE_DIR` as a compat
read path for one release. The fork's other core stores (achievements,
discipline…) need an owner call: merge or leave.

Risks: fork divergence (it's a cherry-pick of `src/omnitrade` onto current
core, touching shared files); tenancy is a prerequisite; live broker
execution inside the main gateway makes restarts riskier (restarts kill
sub-agents) → execution must be idempotent; display-only rename left old
RPC/storage names. **Effort: 15–20 engineer-days** (tenancy upstream 3–4,
panel-kind API 2, backend move + rename 4, UI bundle 4–6, migration 1–2,
parity tests 2).

### 6.3 InfiniCode — mesh UI + fleet bridge (FP, bundled)

**Spike converted it (§8).** Today `extensions/infinicode` (531 L: 8 RPCs,
2 HTTP routes, fleet service) + the core UI `views/inficode/*` (2,078 L).
Why it was disabled by default: every bundled plugin defaults off; the view
called `infinicode.*` methods that don't exist on a fresh install (so
`/inficode` was retired into Setup › Plugins); it only works on a federation
master; `FleetStore` is in-memory.

Done in spike: v2 manifest (nav + page + 8 scoped RPCs + 2 HTTP routes),
plugin-gated `/inficode` route and Agents-group nav entry, toggle, clean
disable. Remaining (Phase 1): move `views/inficode/*` from core into the
plugin package as its builtin chunk source; replace `getFederationHub()`
import with `api.federation`; persist `FleetStore` in plugin SQLite; scoped
node tokens for `/plugins/infinicode/commands`; declare `exec` and make the
CODER panel spawn **only on explicit click** (the spike found opening the
page auto-starts `claude --dangerously-skip-permissions` in a tmux session
— §8.4); add a map layer to the core Mesh page. **Effort: 4–6 engineer-days.**

### 6.4 FlyPic — media generation provider (FM)

FlyPic is an external Next.js app reached as an HTTP MCP server
(`~/.infinibot/mcp-servers.json` → `http://localhost:3000/api/mcp`, 12 tools).

| Moves into `flypic` | From |
|---|---|
| MCP server declaration (`contributes.mcpServers`, token in vault — today plain text in `mcp-servers.json`) | `mcp-servers.json` |
| Per-agent MCP defaults (brand-designer, designer, graphic-designer) → plugin roster contribution | `src/gateway/agent-mcp-defaults.ts:9,26-27` |
| `skills/flypic-design-agent` (293 L) | `skills/`, `src/agents/skills/config.ts:76`, `standard-roster.ts:772` |
| `notes-edit-flypic.ts` projection | `src/compositions/` |
| FlyPic project picker UI | kanban views |

Core gains: a `MediaGenerationProvider` interface (`generateImage`,
`editImage`, `generateVideo`, `history`, `credits`) so ComfyUI
(`src/storyboard/image-generator.ts`) and FlyPic are peers; a plugin-namespaced
**project-meta** extension replacing the hardcoded `flypicProjectId` column
(`src/tasks/store.ts`, `src/apps/store.ts`, ~15 sites in
`server-methods/kanban.ts`) — keep the column one release as read fallback.
Credits: FlyPic generations metered through `api.credits` so they show in
Keys & Usage. Risks: kanban regression surface; mobile content agent
silently degrades when the plugin is off (surface in capabilities).
**Effort: 4–5 engineer-days.**

---
## 7. Rollout plan

Estimates are engineer-days of focused agent/dev work, excluding review
wait. Workstreams inside a phase have **non-overlapping file scopes** so
they can run as parallel agents in separate worktrees; shared files have one
named owner stream.

### Phase 0 — Plugin host v2 in core (≈ 21–24 days, 6 parallel streams → ~1–1.5 weeks wall)

| Stream | Scope (files owned) | Deliverable | Days |
|---|---|---|---|
| **0A Manifest + loader** | `src/plugins/manifest*.ts`, `loader.ts`, `registry.ts`, `config-state.ts`, `discovery.ts` | Full v2 schema (all `contributes.*`, tools trust, sidecars, storage), validation, generated manifest reference doc, v1 compat | 3 |
| **0B Host services** | new `src/plugins/api/*` (storage, secrets, credits, events, federation, sidecars, mcp, roster), `src/plugins/runtime/**` | `api.*` services, tenant-aware plugin data dir, uninstall cleanup | 4–5 |
| **0C UI host** | `ui/src/ui/plugin-host*.ts`, `ui/src/ui/plugin-host/**`, `views/plugins/**`, and (sole owner) `navigation.ts` runtime hooks | Runtime sub-views, widgets, overlays, settings sections, launchpad entries, map-layer slot, sandboxed-iframe bridge, Marketplace/Updates sub-views (browse from a stub registry) | 4–5 |
| **0D Agent surfaces** | `src/agents/infinibot-tools.ts` (sole owner), `standard-roster.ts`, `src/agents/skills/config.ts`, `src/gateway/agent-mcp-defaults.ts`, `src/chat-panels/**`, `src/agents/pi-tools.trust.ts` | Plugin tools with trust classes wired into W5; plugin skills, MCP servers, roster agents, cron seeds (default off), `registerPanelKind` | 3 |
| **0E Sandbox runtime** | new `src/plugins/sandbox/**` | T2 child-process runtime (Node `--permission`, bwrap on Linux), JSON-RPC host bridge, `api.fetch` allowlist proxy, crash isolation | 4–5 |
| **0F Hot lifecycle + gateway glue** | `src/gateway/config-reload.ts`, `src/gateway/server-plugins.ts`, `src/gateway/server-methods/plugins.ts`, `src/gateway/server-methods.ts` (auth hook only), `src/gateway/http-auth.ts` | Enable/disable/uninstall without gateway restart (per-plugin handler + route scopes), scoped plugin tokens for machine-polled routes, `plugins.install/uninstall/update` RPCs, signature verification + revocation list client | 3 |

**Acceptance (Phase 0):**
- All existing bundled v1 extensions load unchanged; `pnpm build`,
  `pnpm -C ui build`, full unit suites green.
- Contract test: a fixture v2 plugin using every contribution type loads;
  disabling it leaves zero nav entries, pages, RPCs, routes, tools, cron
  jobs, services, MCP entries, roster agents (asserted by enumerating each
  registry); uninstall deletes its data dir.
- A T2 fixture plugin that tries `fs.readFileSync(~/.infinibot/infinibot.json)`,
  `child_process.spawn`, and a raw `net.connect` is blocked in each case; its
  declared `api.fetch` host works.
- Fresh-install walkthrough on an isolated side gateway (fresh state dir):
  Setup › Plugins → enable/disable each FP plugin → nav/page appear/disappear
  **without a gateway restart** — `visual_verify` screenshots desktop+mobile.
- Owner-config copy (secrets stripped, channels/cron off, secret env vars
  scrubbed): same walkthrough; existing pages unchanged.

### Phase 1 — First-party plugins (≈ 35–47 days for the four named plugins + 5–8 days per bundled pack × 7 packs; 5+ parallel streams → ~3–4 weeks wall)

| Stream | Scope | Days |
|---|---|---|
| **1A InfiniCode** | `extensions/infinicode/**`, `ui/src/ui/views/inficode/**` | 4–6 |
| **1B FlyPic** | new `extensions/flypic` (private repo), `src/compositions/notes-edit-flypic.ts`, project-meta in `src/tasks/store.ts`, `src/apps/store.ts`, `server-methods/kanban.ts` | 4–5 |
| **1C Robovoice + voice-local** | `src/gateway/voice/**`, `server-voice-*.ts`, `src/gateway/kokoro-bootstrap.ts`, `docker-compose.voice.yaml`, `voice-agent/`, `ui/src/ui/views/voice-chat*.ts`; new `extensions/voice-local`, `extensions/robovoice` (private) | 12–16 |
| **1D Infinitrade** | tenancy upstream (`src/config/tenant-*.ts`, `src/gateway/tenancy/**`) first, then new `extensions/infinitrade` (private) + migration command | 15–20 |
| **1E Bundled packs** | move views/handlers into `extensions/{business-agency,content-studio,productivity,fleet,dev-extras,notion,channel-email}` — one sub-agent per pack, each owning its `views/*` + `server-methods/*` files from §2 | 5–8 per pack, parallel |

Shared-file rule for Phase 1: `navigation.ts`, `app-render.ts`,
`lazy-views.ts`, `server-methods.ts` edits are **deletions only** (removing a
moved tab's static entry), batched by one integration stream at the end.

**Acceptance (Phase 1):** each plugin's pages/RPCs/tools exist only while
enabled; Infinitrade data migrated from `~/.infinibot-omnitrade` with
row-count parity and the :18911 gateway retired; Robovoice call works via
the plugin while a fresh install still talks via BYOK cloud or voice-local;
FlyPic generation charged through credits; fresh-install + owner-copy
walkthroughs with `visual_verify` for every plugin page.

### Phase 2 — SDK + CLI + templates (≈ 8–10 days, 3 streams)

2A `@infinibot/plugin-sdk` package + UI kit (`packages/plugin-sdk/**`);
2B `infinibot plugin create|dev|build|test|verify|pack|doctor`
(`src/plugins/cli*.ts`, `src/plugins/devkit/**`); 2C templates, docs section,
examples (`templates/plugins/**`, `docs/plugins/**`, `examples/plugins/**`).
**Acceptance:** a new developer goes from `create --template ui-page` to a
visible page in `dev` with HMR in under 10 minutes on a fresh machine; all
templates pass `test` + `verify` in CI.

### Phase 3 — Marketplace registry + SaaS submissions (≈ 15–20 days, 4 streams)

3A registry API + Neon schema (commercial repo `src/saas/cloud/registry/**`,
`netlify/functions/registry*.mts`); 3B submission pipeline workers (static
checks, repro build + tests + visual verify on Fly jobs); 3C signing,
revocation, `infinibot plugin publish` + gateway verify/install/update
(`src/plugins/install.ts`, `update.ts`); 3D in-app Marketplace UI against the
real registry + reviewer console (Clerk org role) + credits metering and
payout ledger. **Acceptance:** end-to-end: publish a sample plugin from a
test publisher account → automated checks + screenshots → approve → install
from a fresh gateway with consent → metered call charges credits → yank →
revoke disables it on next load.

### Phase 4 — UGC launch (≈ 5–8 days + ongoing moderation)

Publisher onboarding page, Publisher Agreement, review guidelines,
moderation SLAs, abuse-report flow live, launch content for the 250k IG
audience ("build your own AI OS" series using the templates), seeded with
the first-party plugins and 5–10 example community plugins.
**Acceptance:** external publisher publishes without help; takedown drill
completed; review queue median < 48 h.

---

## 8. Spike: InfiniCode as a v2 plugin

### 8.1 What was built

Commits on `feat/plugin-platform-design`:

| Commit | Change |
|---|---|
| `9a95f690` | `src/plugins/manifest-v2.ts` (v2 parser, `PLUGIN_API_VERSION=2.0.0`, semver range check); `manifest.ts`/`manifest-registry.ts` carry `v2`; `registry.ts` rejects undeclared RPCs, undeclared HTTP routes and catch-all handlers for v2; `loader.ts` refuses incompatible API ranges and warns on declared-but-unregistered RPCs; `runtime.ts` `resolvePluginMethodScope` + `server-methods.ts` authorization uses declared read/write scopes; `server-methods/plugins.ts` returns contributions/permissions and adds admin-only **`plugins.setEnabled`**; InfiniCode manifest → v2 |
| `eff5fafb` | `ui/src/ui/plugin-host.ts` (contribution maps from `plugins.list`, `FIRST_PARTY_PAGES`, plugin-gated tabs); sidebar appends plugin nav entries per group and drops gated tabs; `/inficode` is its own route again, rendering InfiniCode when loaded and a "turned off" card otherwise; Plugins page gets the **enable switch**, v2 badge, contributions/permissions line, restart polling; mesh page hides its InfiniCode button when off |
| `a73482b3` | Sidebar label comes from the manifest; plugin rows wrap on mobile |

v1 extensions are untouched (they load as before; only v2 opts into
enforcement).

### 8.2 Tests and builds

- `vitest run src/plugins/ src/gateway/server-methods.test.ts` → 9 files,
  62 tests passed (includes the new `manifest-v2.test.ts`: semver ranges,
  parse/reject rules, v1 compatibility, bundled InfiniCode manifest validity,
  loader enforcement, scope exposure only while loaded, API-range refusal,
  config transform).
- `pnpm -C ui test` → 36 files, 366 tests passed (new `plugin-host.test.ts`;
  updated `navigation-consolidation.test.ts` for the un-retired route).
- `pnpm build` exit 0 (`verify-build OK`); `pnpm -C ui build` exit 0.
- `tsc --noEmit`: no errors in changed files (pre-existing errors elsewhere
  unchanged).

### 8.3 End-to-end evidence (two isolated side gateways)

Both ran from this worktree's `dist/` with channels, cron, MCP, federation,
Gmail, tunnel and providers skipped:

- **fresh** — `:18950`, empty state dir, config = gateway block only;
- **owner copy** — `:18951`, copy of the owner's `infinibot.json` with all
  secret-named keys blanked, `channels`/`notion`/`loops`/`secrets`/
  `integrations` removed, cron off, federation off, plugin entries reset.

| Check | Result |
|---|---|
| Disabled by default: `infinicode.fleet.list` | `unknown method` (fresh + owner) |
| Plugins page: v2 badge, DISABLED, switch off, caps line | screenshot pass (fresh, owner; desktop + mobile) |
| `/inficode` while disabled | "InfiniCode is turned off" card + Open Plugins; no sidebar entry |
| Click switch → `plugins.setEnabled` → in-process restart | config `{"infinicode":{"enabled":true}}`; status LOADED; switch on |
| Enabled: `infinicode.fleet.list` | `{ "nodes": [] }` |
| Enabled: sidebar | "InfiniCode" entry in Agents group after Fleet (fresh + owner) |
| Enabled: `/inficode` | real InfiniCode mesh view (fresh) |
| Click switch off → restart | config `enabled:false`; `infinicode.fleet.list` → `unknown method`; nav entry gone; card back (owner) |

Screenshots: `/tmp/pp-vv-state/verification/plugin-platform-*/…` (listed
in the run's RESULT block). The MCP `visual_verify` tool itself injects the
*live* gateway's password, so it can't log into a side gateway; the same
harness (`runVisualVerify` from this worktree's `dist/`) was run directly
with the side gateway's password in `INFINIBOT_GATEWAY_PASSWORD`, including
its vision assessment.

### 8.4 Findings the spike surfaced (feed Phase 0/1)

1. **Opening `/inficode` auto-spawns `claude --dangerously-skip-permissions`**
   in a tmux session (`infinibot_inficode_coder_local`) via the CODER panel.
   Existing behaviour, now visible because the page is reachable. Must become
   a declared `exec` permission + explicit click (§6.3). The spawned session
   was idle and killed.
2. **Side gateways inherit real secrets from the shell env**
   (`TELEGRAM_BOT_TOKEN`, `NOTION_API_KEY`, `LOOPS_API_KEY` are exported in
   the owner's shell). Stripping the config copy is not enough; `plugin dev`
   and the submission sandbox must start from a scrubbed environment. No
   outbound calls were logged before the env was scrubbed.
3. **`server-pairing-http.ts` resolves `qrcode-terminal` from
   `process.cwd()`**, so a gateway started outside the repo dir fails to
   boot. Plugin/dev tooling must not depend on cwd; fix the resolution.
4. **Toggle currently restarts the gateway** (the `plugins` config prefix is
   restart-class). It works (the UI polls through the reconnect; the capture
   waited 20 s) but a restart drops WS sessions and kills routed sub-agents
   → Phase 0F hot lifecycle.
5. **Label drift:** the tab title said "InfiCode", the plugin "InfiniCode";
   manifest labels now win in the sidebar (fixed).
6. InfiniCode's own layout has pre-existing issues on desktop (oversized
   Agent Ops / Fleet tab blocks, clipped CODER footer) — Phase 1A.

---

## 9. Decisions the owner needs to make

1. **Approve the core/plugin split** (§2), especially: voice stays core with
   engines split; Discipline/Notion/Mail become plugins; Funnels/Campaigns
   go to the marketplace tier; the 14 removals.
2. **First-party commercial plugins outside the FSL tree** — Robovoice,
   Infinitrade, FlyPic, OmniClinic ship via the registry (private source),
   not in the public repo. (Resolves PRIVATE-SPLIT §6.)
3. **Robovoice as default voice?** Keep BYOK cloud STT/TTS as the core
   default and Robovoice as an opt-in premium provider, or make Robovoice the
   default provider when the user is logged into InfiniBot Cloud.
4. **Revenue share** for paid community plugins (proposal 70/30, 80/20 above
   a volume threshold) and the payout rail (Whop vs Stripe Connect).
5. **SDK license** — publish `@infinibot/plugin-sdk` + UI kit under
   Apache-2.0 (proposal) so any plugin license can depend on it.
6. **Sandbox strictness at launch** — require T2 (out-of-process) for all
   community plugins (proposal), with T1 in-process only for verified
   publishers + user consent.
7. **Who reviews** — owner + AI reviewer at launch; when to add paid/partner
   reviewers.
8. **Infinitrade fork's extra core stores** (achievements, discipline…):
   merge into the main install or leave behind.
9. **Order of Phase 1** — proposal: InfiniCode + FlyPic first (small, prove
   the APIs), Robovoice and Infinitrade in parallel once Phase 0B/0D land.
