# InfiniBot — the AI OS

<p align="center">
  <a href="https://fsl.software/"><img src="https://img.shields.io/badge/License-FSL--1.1--ALv2-blue.svg?style=for-the-badge" alt="License: FSL-1.1-ALv2"></a>
  <a href="https://infinibotos.com/download"><img src="https://img.shields.io/badge/Desktop-v2026.11.1-gold?style=for-the-badge" alt="Desktop v2026.10.18"></a>
  <img src="https://img.shields.io/badge/Node-22.12%2B-brightgreen?style=for-the-badge" alt="Node 22.12+">
</p>

> **A personal AI control room, hosted for you on InfiniBot Cloud or run on your own computer.** Chat and voice
> with your agents, projects and kanban, files, a knowledge graph, a business
> CRM, plugins and a mobile companion app, all behind one local gateway. Your
> keys, your data, your hardware.

InfiniBot answers you in the app and on the channels you already use
(Telegram, WhatsApp, Discord, Slack, Signal and more). It runs agents and
coding agents in the background, keeps your work in local projects, and can
keep sensitive chats on local models only with **Secure Mode**.

- InfiniBot Cloud (in your browser, Free plan, no card): <https://cloud.infinibotos.com/app/>
- Website: <https://infinibotos.com>
- Docs: <https://infinibotos.com/docs/>
- Run it yourself, free (desktop app): <https://infinibotos.com/download>

> **Fastest way to start: [InfiniBot Cloud](https://cloud.infinibotos.com/app/).** Your own private InfiniBot machine in the browser, with nothing to install or update. The Free plan gives you 30 active minutes a day with no card; Starter is $19/mo and Pro ($49/mo) stays on 24/7. See [Cloud plans](https://cloud.infinibotos.com/pricing).
>
> Prefer to run it yourself? Use the free [desktop app](https://infinibotos.com/download) (Windows, Linux) or the npm install below.

---

## Getting started

The fastest way is [InfiniBot Cloud](https://cloud.infinibotos.com/app/): nothing
to install. Prefer to run it yourself? The desktop app below is free, and you
don't need an account, a credit card or a terminal.

### 1. Download

Go to **<https://infinibotos.com/download>** and pick your system:

| System | File |
| --- | --- |
| Windows 10/11 (64-bit) | `InfiniBot-Setup-x64.exe` |
| Linux (x86_64) | `InfiniBot-x86_64.AppImage`, or `infinibot_amd64.deb` for Debian/Ubuntu |
| macOS | Coming soon. Use [InfiniBot Cloud](https://cloud.infinibotos.com) or the [npm install](#install-with-npm-windows-macos-linux) for now |

The current desktop release is **v2026.10.18**. Installed apps update
themselves. On Windows, 2026.10.17 and earlier download the update but can't
install it on their own: run the new installer from the download page once
(your data is kept). From 2026.10.18 on, Windows updates install
automatically.

### 2. Install

- **Windows:** run `InfiniBot-Setup-x64.exe`.

  Windows may show a blue **"Windows protected your PC"** screen. Click
  **More info**, then **Run anyway**. This happens because InfiniBot is a new
  app that isn't code-signed yet, not because anything is wrong. Want to
  double-check? Compare the file's SHA-256 with the checksum on the download
  page or in
  [`SHA256SUMS`](https://github.com/MrYungCEO/infinibot-desktop-releases/releases/latest)
  (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`).

- **Linux:** make the AppImage executable (`chmod +x InfiniBot-x86_64.AppImage`)
  and run it, or install the package with `sudo apt install ./infinibot_amd64.deb`.

Prefer not to install anything? Try InfiniBot Cloud in your browser:
<https://cloud.infinibotos.com> (the Free plan, no card).

### 3. Set it up (8 short steps)

On first launch the desktop app asks where to keep your data, then opens
**Get started**:

1. **Your goals.** Pick what you want InfiniBot for.
2. **AI brain.** Sign in with the Claude, ChatGPT, Google or Grok plan you
   already have (InfiniBot uses that provider's official CLI, so no API key),
   use a free local model on your computer (Ollama or vLLM), or paste a
   provider key. Google Gemini and Groq have free tiers, and OpenRouter is one
   key for hundreds of models.
3. **Channels.** Just this app, or Telegram, WhatsApp or Discord.
4. **Voice.** Talk out loud. Local voice is the default: **Set up voice for
   me** installs the built-in voice engine in one click (no Docker needed).
5. **Phone.** Pair the InfiniBot mobile app.
6. **Privacy.** Turn on Secure Mode if you want chats that only use local models.
7. **Your plan.** Recommended plugins and courses for your goals.
8. **Finish.** Review and go.

You can **Skip** a step, and **Save and exit** keeps your progress. Come back
any time from **Settings › Setup › Get started**.

### 4. Send your first message

Open **Chat & Voice › Chat**, type "Hi, what can you do?" and press Enter.
Your first chat greets you with the account your agent runs on.

### 5. Learn as you go

After onboarding, your **personal learning path** walks you through the app
step by step, based on the goals you picked. Open **Home › Learn** any time
for the short, interactive courses. Each one walks you through a real page
of the app, and you can earn an InfiniBot certificate.

### Install with npm (Windows, macOS, Linux)

If you're comfortable with a terminal, you can install the gateway from npm.
You need [Node.js 22.12 or newer](https://nodejs.org/).

```bash
npm i -g infinibot
infinibot quickstart
```

The same thing as a one-liner: `curl -fsSL https://infinibotos.com/install.sh | bash`
(macOS/Linux) or `iwr https://infinibotos.com/install.ps1 | iex` (Windows
PowerShell). Then open the dashboard at <http://127.0.0.1:18789>. The npm
package can lag behind the desktop app by a release. More options:
<https://infinibotos.com/docs/install/>.

---

## FAQ

**Is it safe?**
The Windows installer isn't code-signed yet (see the SmartScreen note above),
and you can check its SHA-256 checksum before you run it. InfiniBot runs on
your own computer, and Secure Mode keeps chats on local models only. The
source is available under the FSL license.

**Do I need an API key?**
No. Sign in with the Claude, ChatGPT, Google or Grok plan you already have
(desktop app), run a free local model (Ollama), or use a provider's free tier
(Google Gemini, Groq).

**What does it cost?**
The desktop app and self-hosting are free. Cloud plans run from Free ($0) to
$199/mo. Some plugins are a one-time purchase ($19 to $49). Your own AI
provider bills you separately, or a local model costs $0.

**Is my data private?**
Self-hosted data stays on your machine (in `~/.infinibot` by default). Secure
Mode keeps sensitive chats and files on local models, with an encrypted
vault. See [`PRIVACY.md`](./PRIVACY.md) for every outbound call.

**Is there a Mac app?**
Coming soon. For now, use [InfiniBot Cloud](https://cloud.infinibotos.com) in
your browser, or `npm i -g infinibot` (Node 22.12+) on a Mac.

More answers: <https://infinibotos.com/docs/faq/>

---

## What's inside

| Area | What it does |
| --- | --- |
| **Chat, Grid and Voice** | Chat with any agent, run many sessions side by side, and talk out loud. Local voice is the default, with a built-in engine (no Docker); Cloud voice (Robovoice) is an optional, free choice |
| **Use your subscription** | Run your agents on the Claude, ChatGPT, Google (Gemini) or Grok plan you already have, through the provider's official CLI (Claude Code, Codex CLI, Gemini CLI, Grok Build; also OpenCode). No API key. Desktop app and self-host |
| **Group chat** | Several agents in one conversation with shared context |
| **Agents** | Your agent roster, sub-agents and coding agents (Claude Code, Codex, OpenCode), with a live agent map |
| **Secure Mode** | A key-based secure lane (desktop and self-host): local models only, an allowlist of tools, an encrypted vault in your OS keyring, sealed secure files with collections and tags, and secure local web research with an approval card |
| **Files** | Grid, gallery and list views with a rich viewer. Files you add are OCR'd on your machine (self-host), and local video analysis feeds the same file context |
| **Knowledge graph** | Projects, tasks, files, CRM records and memory linked in one graph, plus a graph for each project (the Knowledge Graph button on a project page) |
| **Projects** | Local kanban with agent-runnable tasks. Attach a git repo to a project to see repo badges |
| **Repos & deploy** | Attach repos to projects, set a deploy branch, check branch health, and clean up safely with a restore option |
| **Browser agent** | An agent browser with named profiles that keep saved logins per site |
| **Local runtime manager** | Swaps the GPU between vLLM and Ollama, with a GPU widget (self-host) |
| **Plugins** | A Plugins page to browse, buy and turn plugins on (see below) |
| **Multi-user workspaces** | Optional, off by default: invite people, deny-by-default permissions, an Access page |
| **Autonomy** | Scheduled tasks, verified goal runs, a work queue and approval gates (for example on Telegram) |
| **Mobile app** | Pair your phone with a QR code: chat, sessions, kanban, notes and voice |
| **Federation** | Link several machines into one InfiniBot (optionally over Tailscale) |
| **Skills and MCP** | Bundled skills, saved workflows, and an MCP server that gives coding agents InfiniBot's tools |
| **Learn** | Interactive courses for each area, plus a certificate |

### Plugins

Free plugins are included. Paid plugins are a one-time purchase that unlocks
on the Plugins page (**Home › Plugins**).

| Free | Paid (one-time, USD) |
| --- | --- |
| Business & Agency, Canvas Library, Content Studio, Discipline, Whiteboard, Robovoice | Infinitrade $49, Solatrix $49, OmniClinic $49, Droid Swarm $49, InfiniCode $29, Products $29, FlyPic $19 |

Voice: **Local voice (default)** runs on your computer. **Cloud voice
(Robovoice)** is optional and free. Usage is measured to keep cloud voice
fair. If it's ever busy, switch to local voice in one click.

### InfiniBot Cloud

Don't want to run anything yourself? <https://cloud.infinibotos.com> runs
InfiniBot for you. Plans are flat prices, and AI is bring-your-own-key or a
local model:

| Self-host | Free | Starter | Pro | Business | Scale |
| --- | --- | --- | --- | --- | --- |
| $0, your hardware | $0, hosted, 30 active min/day, no Telegram/Slack | $19/mo, wakes on use, ~150 active h/mo fair use | $49/mo, always on | $99/mo | $199/mo |

Secure Mode, local OCR and the local runtime manager need local hardware, so
they're on the desktop app and self-host, not the cloud.

The cloud runs release 2026.10.16. The features new in desktop 2026.10.18
(the built-in voice engine, the learning path, using your subscription,
Repos & deploy and project knowledge graphs) are coming to Cloud.

---

## Operating systems

| System | Desktop app | npm / self-host |
| --- | --- | --- |
| Windows 10/11 x64 | Yes | Yes (Node 22.12+) |
| Linux x86_64 | Yes (AppImage, .deb) | Yes |
| macOS | Coming soon | Yes (Node 22.12+). iMessage needs a Mac |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Windows says "Windows protected your PC" | Click **More info**, then **Run anyway** (the installer isn't code-signed yet) |
| The dashboard login rejects your password | Run `infinibot onboard` again to set a new gateway password |
| Chat says no model is configured | Add a provider key in **Settings › Keys & Usage**, or pick a local model in **Settings › Setup › Get started** |
| Anything else | Run `infinibot doctor`. It checks your install and prints what's wrong |

More: <https://infinibotos.com/docs/troubleshooting/>

---

## For developers

### Run from source

You need access to the source repository, [Node.js 22.12+](https://nodejs.org/),
[pnpm](https://pnpm.io/) (`corepack enable`) and git.

```bash
pnpm install          # installs exactly what pnpm-lock.yaml pins
pnpm build:all        # backend + control UI (same as: pnpm build && pnpm ui:build)
pnpm infinibot onboard
pnpm infinibot gateway
# Dashboard → http://127.0.0.1:18789  (log in with your gateway password)
```

`pnpm build` wipes `dist/`, including the control UI, so always rebuild the UI
after it. `pnpm build:all` does both in the right order. On Windows, keep the
checkout outside OneDrive (OneDrive sync corrupts `node_modules`).

`bash scripts/satellite-setup.sh` (macOS/Linux) or
`powershell -ExecutionPolicy Bypass -File scripts/satellite-setup.ps1`
(Windows) checks your Node/pnpm versions and runs the same install and build.

Useful gateway flags: `--port 47913`; `--bind lan` for LAN access (needs a
password); `--auth password --password "…"` to override the configured auth.

### Docker (from source)

```bash
export INFINIBOT_GATEWAY_PASSWORD="your-strong-password"   # required
docker compose build
docker compose up -d infinibot-gateway
# Dashboard → http://localhost:18789
```

The first browser login asks to pair that browser. Approve it once:

```bash
docker compose exec infinibot-gateway node dist/index.js devices list
docker compose exec infinibot-gateway node dist/index.js devices approve <request-id>
```

State lives in the `infinibot-state` volume. Pass provider keys as env vars
(`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …) or add them in the dashboard.

### Federation spawns from Claude Code

If you drive InfiniBot from Claude Code, allow its sub-agent spawns once per
device so cross-node spawns don't prompt every time. Add
`mcp__infinibot__infinibot_sessions_spawn` and `mcp__infinibot__sessions_spawn`
to `permissions.allow` in `~/.claude/settings.json`, or run
`python3 scripts/allow-federation-spawns.py` from a source checkout (it merges,
never clobbers, and keeps a `.bak`).

### Contributing

The project is a TypeScript monorepo (gateway in `src/`, dashboard UI in
`ui/src/`). Run `pnpm test` before sending changes. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CLA.md`](./CLA.md).

---

## License

InfiniBot is source-available under the
[Functional Source License 1.1, Apache-2.0 future license](https://fsl.software/)
(`FSL-1.1-ALv2`); the full text is in [`LICENSE`](./LICENSE). You can use,
modify and self-host it for free, including inside your company. You may not
offer it, or a product that competes with it, to others as a commercial
hosted service. Every release becomes Apache-2.0 two years after it ships.

© 2026 Kingly Intelligence Systems, LLC

- Plain-English FAQ: [`LICENSING.md`](./LICENSING.md)
- **Can I use InfiniBot commercially?** Yes, inside your own business, for free. Selling a hosted, resale, white-label or OEM product built on it needs a commercial license: **[Commercial licenses](https://cloud.infinibotos.com/licenses/)** (Indie $299/yr, Team / Business $1,499/yr, Agency / Reseller $2,499 per 6 months, Enterprise / OEM by quote)
- Commercial, hosted, reseller, white-label and OEM options: [`COMMERCIAL.md`](./COMMERCIAL.md)
- Commercial agreement and tiers: [`docs/licensing/COMMERCIAL-LICENSE-AGREEMENT.md`](./docs/licensing/COMMERCIAL-LICENSE-AGREEMENT.md) · [`docs/licensing/COMMERCIAL-LICENSE-TIERS.md`](./docs/licensing/COMMERCIAL-LICENSE-TIERS.md)
- Name and logo use: [`TRADEMARKS.md`](./TRADEMARKS.md)
- Upstream and third-party credits: [`NOTICE`](./NOTICE)

Claude, Anthropic, OpenAI, Codex, Gemini, Google, OpenCode and other
third-party names and logos are trademarks of their respective owners, used
only to identify compatibility. They are not covered by InfiniBot's license
and do not imply endorsement, sponsorship or affiliation.
