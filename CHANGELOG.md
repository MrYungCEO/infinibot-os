# Changelog

All notable user-facing changes to InfiniBot are recorded here. Newest first.
Versions use CalVer (`YYYY.M.PATCH`); see [docs/reference/RELEASING.md](docs/reference/RELEASING.md).

History from before the first public release, including the upstream project
InfiniBot was forked from (MIT-licensed), is archived in
[docs/history/CHANGELOG-upstream.md](docs/history/CHANGELOG-upstream.md).

## 2026.11.1

- KinglyVault relay: a stuck connection now recovers on its own (watchdog, bounded calls, `kvconnect.restart`).
- KinglyVault: zero-pairing sign-in, AI features run on your own InfiniBot with a model picker, outputs/tasks/files/approvals shown inside KV, shared lessons + memory, full MCP access (`kv.write`, `kv.admin`), KV side panel UI control.
- Setup: provider brand logos.

## 2026.10.32 — 2026-10-29

Patch release for the desktop app: one KinglyVault connection unlocks your plugins.

- **Connecting KinglyVault now unlocks your paid plugins.** Linking KinglyVault (setup,
  the Plugins card or Settings) also links your plugin licence, with no second sign-in.
  Already linked? InfiniBot picks your plugins up by itself on its next start.
- **CEO plan = every paid plugin.** CEO members see **Included with your CEO plan**
  instead of Buy buttons, and the plugins install and turn on. Other accounts keep Buy
  only for plugins they don't own.
- **Plugin zips from your KinglyVault CEO downloads import and run.** Pasting a
  KinglyVault plan licence also works, and keys inside a JSON file or quotes are
  accepted. Errors now say in plain words why a key was refused.
- **Offline:** if KinglyVault can't be reached, your saved plugin access keeps working
  through the grace period and the panel says KinglyVault is unreachable.

## 2026.10.31 — 2026-10-29

Patch release for the desktop app and npm: KinglyVault Connect built in.

- **Connect KinglyVault in one click.** A new optional KinglyVault step in setup, a
  KinglyVault card at the top of Plugins, and Setup › Connect KinglyVault all use the
  same flow: click **Connect KinglyVault**, approve on kinglyvault.com, and InfiniBot
  shows **Connected ✓** by itself. Prefer a code? Paste the 8-character code from
  KinglyVault instead. Skip is always there.
- **On by default, idle until you link.** KinglyVault Connect ships turned on, makes no
  network calls until you pair, and no longer logs `kvconnect.status: unknown method`
  on every page.
- **What linking gives you:** your agents can use your KinglyVault courses and library,
  and the KV agent on kinglyvault.com can chat with your agents, start coders in folders
  you allow and open pages in InfiniBot. Every action is scoped and logged.
- **Reliable link.** It reconnects by itself, survives restarts (it runs with the
  InfiniBot gateway on desktop and npm), shows the last sync and plain-English errors.
  **Disconnect** revokes the link on both sides; if KinglyVault can't be reached at that
  moment, InfiniBot finishes the revoke as soon as it can. Revoking on kinglyvault.com
  removes the link here within seconds.
- **Terminal:** `infinibot kv-connect` (no code) opens kinglyvault.com to approve.

## 2026.10.30 — 2026-10-29

Patch release for the desktop app (Windows fix).

- **Grok and Claude work as the AI brain on Windows.** Choosing Grok Build or Claude
  Code as the brain no longer fails with `spawn ENAMETOOLONG`. Windows limits a whole
  command line to 32,767 characters (8,191 through `cmd.exe`), and InfiniBot's
  instructions were being passed inline. Long instructions and messages now go through
  a file (`--prompt-file`, `--append-system-prompt-file`) or stdin on every CLI (Claude
  Code, Codex, Gemini CLI, OpenCode, Grok Build): brain route, chat CLI mode, connection
  test and coder runs.
- **Long messages are never refused.** Chat CLI mode no longer rejects messages over
  100 KB for OpenCode, Gemini CLI or Grok Build.
- **Plain-English error.** If a command line is ever too long, the error explains it in
  plain words instead of showing a raw `ENAMETOOLONG` / `E2BIG`.

## 2026.10.29 — 2026-10-29

One release for the npm package and the desktop app.

- **Setup: connect your browser.** A new setup step walks you through loading the
  InfiniBot Browser Relay extension (v0.3.2) in Chrome and shows when it is connected.
  The extension now lives in a visible folder (`~/InfiniBot/browser-extension`), with an
  "Open folder" button and tips for Chrome's hidden-folder picker.
- **Setup: connect your AI apps (MCP).** A new setup step connects InfiniBot to MCP
  clients such as Claude Desktop, Cursor and Claude Code.
- **Grok Build everywhere.** Grok is a choice in every CLI, coder and brain picker, in
  chat CLI mode, and in CLI routing.
- **Reliable coding CLIs on Windows.** Codex, OpenCode and Grok no longer fail with
  `spawn EINVAL` on Windows (`.cmd` shims are resolved and run directly).
- **Plain-English CLI errors.** Sign-in, plan-limit and credit failures from a coding CLI
  are explained in plain words, and the turn falls back to the built-in model.
- **Gemini CLI.** Labels say when Gemini CLI needs an API key or a paid Google plan, and
  the "free account no longer supported" error is explained with an option to add a
  Gemini API key.
- **Import skills and workflows.** Import buttons and drag-and-drop on the Skills and
  Workflows pages (`skills.import` / `workflows.import`), with a dialog when a name is
  already taken.

## 2026.10.28 — 2026-10-28

One release for the npm package and the desktop app.

- **Agent | CLI switcher in chat.** Switch a chat between the InfiniBot agent
  and a signed-in coding CLI (Claude Code, Codex, Gemini, OpenCode) from
  the composer, on web and mobile.
- **KinglyVault Connect.** `infinibot kv-connect` links this computer to your
  KinglyVault account over an outbound relay (no open ports), with persistent
  CLI sessions you can drive from KinglyVault.
- **Daily review.** A /daily-review page, `daily_review` tool and RPC that sum
  up what your agents did today.
- **Product Studio (Monsoon)** plugin, and a **launch test panel** tool that
  runs a page past a panel of test personas.
- **Cloud first.** The setup wizard, docs and README point to InfiniBot Cloud
  first; running it yourself stays free.
- **Commercial licenses.** InfiniBot Cloud sells commercial licenses for
  hosted, resale, white-label and OEM use (cloud.infinibotos.com/licenses),
  with signed license keys, an `infinibot license` CLI check and an owner
  admin page. Use under FSL-1.1-ALv2 stays free.

## 2026.10.27 — 2026-10-27

Desktop app:

- Fixed: the Browser page said "Extension source not found in the repo" in the installed app. The
  extension was always in the installer; the app now finds it, copies it to a folder that stays put
  across updates, and shows the Chrome "Load unpacked" steps with screenshots.
- The Browser Relay extension now uses the InfiniBot icon (v0.3.1) and also ships as a zip.
- Branding: installer sidebar/header art and icons, InfiniBot icon on Linux and in the tray, an
  About InfiniBot dialog, and Windows file properties that read "InfiniBot".
- Includes the setup-guide video in the setup wizard and the daily-review fixes.

## 2026.10.22 — 2026-10-19

Desktop release, built from the live line (a607696f) with the 2026.10.21
desktop line merged in.

### Added

- **3D Agent Mesh.** The agent map has a 3D world view next to the 2D map,
  with a 2D/3D toggle. Quality steps down by itself on slow GPUs, and devices
  without WebGL stay on 2D.
- **Connect to another InfiniBot.** Joining another InfiniBot now makes this
  computer a real satellite node of that master. The pairing survives
  restarts on both sides.

### Fixed

- **Satellite window.** A joined desktop keeps showing its own InfiniBot, not
  the master's page, and it no longer relaunches after joining a plain-http
  master.
- **Crashed gateway.** The app notices when its gateway exits and restarts it.
- **Reports worker.** The report render worker exits with its gateway instead
  of lingering after you quit.

## 2026.10.21 — 2026-10-19

Desktop release, built from the live line (7c5afc9e) with the 2026.10.20
desktop line merged in.

### Fixed

- **Plugin import.** Importing a plugin that already ships with InfiniBot, at
  the same or an older version, no longer shows an error. It says the plugin
  is already included and offers Enable. A newer version upgrades it.
- **Purchase prompts.** Each plugin card shows exactly one of Free, Included,
  Owned or Buy. Owned, included and free plugins never show Buy. After you buy,
  the plugin unlocks by itself within a few minutes.
- **Checkout and licence sign-in open in your browser.** The KinglyVault
  licence sign-in and the upgrade checkout now open in your default browser
  like every other link, instead of in a window inside the app.

### Added

- **Easier plugin import.** Import a plugin from a folder (including drag and
  drop), from a URL, or from a GitHub repo, branch or release.
- **Voice brain picker.** The voice settings brain picker lists every API
  provider, local model and subscription CLI (Claude, ChatGPT/Codex, Gemini,
  Grok). It fits every screen size.
- **Connect KinglyVault (coming soon).** The Plugins page has a Connect
  KinglyVault button that will link your purchases with a device code. Until
  KinglyVault turns it on, the button is shown as unavailable.

## 2026.10.20 — 2026-10-18

Desktop release, built from the live line (38142685) with the 2026.10.19
desktop line merged in.

### Fixed

- **Speech-to-text on Windows.** The built-in voice engine no longer returns
  garbage transcripts on Windows graphics cards. Whisper's encoder still uses
  the graphics card (DirectML), and its decoder now runs on the processor. On
  the test corpus, word errors drop from 808% to 3.4%. At startup the engine
  checks its own transcription and falls back to the processor if the result
  is wrong, and voice setup only passes when that test is accurate.
- **Setup modal navigation.** Every navigation button in the setup modal now
  closes the modal before it opens the page.

### Added

- **Edit one setting from Setup.** Setup › Your setup lists each area (AI
  brain, channels, voice, phone and so on) with an Edit button. You can change
  a single setting without rerunning the quickstart.

## 2026.10.19 — 2026-10-17

Desktop release, built from the live line (1e3b237c) with the desktop
packaging line (2026.10.18) merged in.

### Fixed

- **Windows voice.** The built-in voice engine now runs on Windows PCs with an
  old (14.29) or missing Visual C++ runtime: the runtime DLLs ship next to the
  onnxruntime binding. Voice readiness no longer depends on the process id the
  engine reports.
- **AI brain quick options.** Claude, ChatGPT, Google (Gemini) and Grok
  install on clean desktop machines (no Node.js needed). Google sign-in works
  with Gemini CLI 0.6x. Sign-in pages and every external link open in your
  default browser, not inside the app.
- **Ollama Cloud is back** in onboarding, with every API-key provider. Model
  pickers list the provider's live models (with Free badges) and run a real
  test turn.
- **Update widget.** The sidebar update widget follows the desktop release
  feed, and Help › Check for Updates… / the tray menu check for new versions.

### Added

- **Phone and remote access.** The onboarding Phone step covers Android and
  iPhone, and Setup › Remote access gives you a Tailscale (MagicDNS) link to
  reach InfiniBot from anywhere.

### Note for Windows users on 2026.10.17 or earlier

Those versions can't install updates on their own. Download 2026.10.19 once
from https://infinibotos.com/download/windows; auto-update works from
2026.10.19 onward.

## 2026.10.18 — 2026-10-16

Desktop release, built from the live line (39f91b5b). InfiniBot Cloud is
still on 2026.10.16, so these features are coming to Cloud.

### Added

- **Built-in voice engine.** Local voice runs on your computer with no Docker.
  "Set up voice for me" downloads the voice models and turns local voice on
  in one click. The Docker GPU voice engine is still there under Advanced.
- **Local voice by default, free cloud voice.** Local voice is the default
  everywhere (onboarding, Voice settings, voice chat, Telegram voice notes
  and the mobile app). Cloud voice (Robovoice) is an optional choice you pick
  yourself, and it's now free: the Robovoice plugin moved to the free list.
  If cloud voice is busy, one click switches back to local voice.
- **Use your existing AI subscription.** Agents can chat through your Claude,
  ChatGPT, Google (Gemini) or Grok plan via the provider's official CLI
  (Claude Code, Codex CLI, Gemini CLI, Grok Build; also OpenCode), with no
  API key. Set it up in onboarding ("Which of these do you already have?")
  or in Settings › Setup › Coders › Use my subscription. If a plan hits its
  usage limit, the next CLI takes over.
- **Personal learning path.** After onboarding, InfiniBot walks you through
  the app step by step, based on the goals you picked.
- **Repos & deploy page.** Attach repos to projects, set a deploy branch,
  see branch health (including work merged on the remote's deploy branch but
  not pulled), and clean up safely with restore manifests. Attaching a repo
  is instant.
- **Project knowledge graphs.** A Knowledge Graph button on each project page
  opens the graph scoped to that project, with a depth control and "Show
  all" (web and mobile).

### Fixed

- The first chat greets you with the account your agent actually runs on.
- Subscription settings rows fit phones.

### Updating on Windows

Windows installs of 2026.10.17 and earlier download this update but can't
install it on their own. Run the new installer from
<https://infinibotos.com/download> once; your data folder is kept. From
2026.10.18 on, Windows updates install automatically. Linux AppImage installs
update automatically.

## 2026.10.17 — 2026-10-16

Desktop fix release on top of 2026.10.16 (same gateway and control UI).

- **First launch opens the new onboarding.** A brand-new desktop install goes
  straight into Settings › Setup › Get started (goals, AI brain, channels,
  voice, phone, privacy and plan). The only extra step on the desktop is choosing
  the data folder. Restoring a backup, connecting to another InfiniBot
  (satellite) and InfiniBot Cloud are one click away on the same screen.
- Existing installs open as before and are not sent back through onboarding.
- Setup copy no longer says every feature is unlocked: free plugins are
  included, and paid plugins unlock with a purchase on the Plugins page.

Downloads: Windows 10/11 x64 (`InfiniBot-Setup-x64.exe`), Linux x86_64
(`InfiniBot-x86_64.AppImage`, `infinibot_amd64.deb`). macOS is coming soon.
The installers are not code-signed yet; check them against `SHA256SUMS` on
the [release page](https://github.com/MrYungCEO/infinibot-desktop-releases/releases/tag/v2026.10.17).

## 2026.10.16 — 2026-10-16

Desktop and InfiniBot Cloud release. (The npm package for this version is
built but not published yet.)

### Added

- **Use-case onboarding.** An 8-step guided setup: your goals, AI brain (a
  local model via Ollama/vLLM, or a provider key), channels (this app,
  Telegram, WhatsApp, Discord), voice, phone pairing, privacy (Secure Mode)
  and a plan of recommended plugins and courses.
- **Plugins page.** Plugins is its own page under Home: browse, buy, restore
  and turn plugins on. Free plugins are included; paid plugins are a one-time
  purchase through KinglyVault. Plugins are no longer limited to the desktop
  app.
- **Secure Mode** gains a per-agent Secure Mode toggle, sealed secure files
  with encrypted collections, tags and notes, and **secure research**:
  sanitized, owner-approved web research through a local SearXNG and local
  models.
- **Local OCR and video analysis.** Files you add are OCR'd automatically on
  your machine (RapidOCR plus a local vision model). Local video analysis
  with specialist analysts, a findings timeline and "look again". Results
  feed file context and the knowledge graph.
- **Local runtime manager.** Swaps the GPU between vLLM and Ollama on demand,
  with a GPU widget and a chat status line.
- **Files.** Grouping, grid/gallery/list views and a rich file viewer with an
  analysis panel.
- **Multi-user workspaces** (optional, off by default): invite people,
  deny-by-default permissions with a per-user editor, and an Access page.
- **Project repos.** Attach a local git repo to a project; repo badges on
  projects, kanban and pickers, "Projects with repos", and a Repos mode in
  the 3D knowledge graph.
- **Browser agent.** A more reliable agent browser and named browser profiles
  that keep saved logins per site.
- **Chat.** Response actions, document uploads, video attachments, and chat
  follows navigation (agent-driven page changes open the chat dock on the
  same session).
- **Mesh.** Owner decision cards on agents.
- **Telegram.** Verification screenshots are attached to run completion
  messages.

### Fixed

- The notifications panel opens reliably; the open chat dock no longer covers
  pages; the Knowledge Graph panel fills its grid cell.

## 2026.10.9 and earlier

InfiniBot is a self-hosted personal AI assistant: one long-running **gateway**
process that connects your chat channels, model providers and devices to a
fleet of agents, plus a browser **Control UI** to run it all.

### Highlights

- **Gateway + Control UI.** A single Node 22+ process (`infinibot gateway`)
  that owns channel connections, sessions and a WebSocket control plane, with a
  browser dashboard at `http://127.0.0.1:18789/`.
- **Channels.** WhatsApp (WhatsApp Web), Telegram, Discord, Slack, Signal,
  iMessage (macOS) and the in-app chat, with more available as plugins.
- **Models.** Anthropic, OpenAI, OpenRouter, Groq, local Ollama and other
  providers, with per-agent model selection and fallbacks.
- **Agents and sub-agents.** A configurable agent roster, sub-agent spawning,
  and coding-agent backends (Claude Code, Codex, OpenCode) run in persistent
  tmux-backed terminals.
- **Autonomy.** Cron jobs, verified goal runs, an agent work queue with gate
  criteria, and approval gates.
- **Voice.** Wake word, push-to-talk and voice chat with cloud or local
  speech-to-text and text-to-speech.
- **Projects and business data.** Local-first kanban, projects, notes and
  Notion-style databases (SQLite), with optional Notion sync.
- **Federation.** Master/satellite pairing across machines (optionally over
  Tailscale), with cross-device sessions and agent spawning.
- **Skills, workflows and MCP.** Bundled skills, saved workflows, and an MCP
  server that exposes the gateway's tools to external coding agents.
- **Content tools.** Storyboard (script to video), video studio and reports.
- **Clients.** CLI and TUI, plus Electron desktop, mobile (Expo) and native
  node apps.

### Changed

- Fresh changelog; pre-release history moved to
  `docs/history/CHANGELOG-upstream.md`.
- Community files (contributing guide, code of conduct, security policy,
  privacy notice, issue and PR templates) rewritten for InfiniBot.
- Documented the release process in `docs/reference/RELEASING.md` and every
  environment variable in `docs/environment.md`.
