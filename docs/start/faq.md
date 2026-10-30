---
summary: "Plain answers for new InfiniBot users: safety, API keys, cost, privacy, Mac, the Windows warning, voice and plugins."
read_when:
  - You are deciding whether to try InfiniBot
  - You hit the Windows "Windows protected your PC" screen
---

# FAQ

Plain answers to the questions new users ask most. New here? Start with [Getting started](/docs/start/getting-started).

## Setup video

New to InfiniBot? The [6-minute setup guide](/docs/start/getting-started/#setup-guide) answers most first-day questions. Jump to [API keys](/docs/faq/?t=159#setup-guide), the [cloud route](/docs/faq/?t=259#setup-guide), the [npm route](/docs/faq/?t=286#setup-guide) or [common issues](/docs/faq/?t=310#setup-guide).

<!--setup-guide:player compact-->

## Questions and answers

### Is it safe?

The installer is unsigned for now, so Windows may show a blue "Windows protected your PC" screen: click **More info**, then **Run anyway**. You can verify the file's checksum on the [download page](/download#verify). InfiniBot runs on your computer, and Secure Mode keeps chats on local models only. InfiniBot is source-available under the Functional Source License (FSL).

### Why does Windows say "Windows protected your PC"?

Windows may show a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This happens because InfiniBot is a new app that isn't code-signed yet, not because anything is wrong. Want to double-check? Compare the file's SHA-256 with the checksum on the [download page](/download#verify) (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`). Step-by-step pictures: [Windows guide](/docs/windows).

### Do I need an API key?

No. On the desktop app you can sign in with the Claude, ChatGPT, Google or Grok plan you already have, run a free local model (Ollama) on your computer, or use a provider's free tier (Google Gemini, Groq). The plan sign-in uses that provider's official CLI (Claude Code, Codex CLI, Gemini CLI, Grok Build; OpenCode works too).

### What does it cost?

InfiniBot Cloud runs from a Free plan ($0, 30 active minutes a day) to $199 a month; Pro ($49) is always on. Self-hosting with the desktop app is free. Some plugins are a one-time purchase ($19 to $49). Your own AI provider bills you separately, or a local model is $0.

### Is my data private?

Self-hosted data stays on your machine. Secure Mode keeps sensitive chats and files on local models, with an encrypted vault.

### Is there a Mac app?

Coming soon. For now, use [InfiniBot Cloud](https://cloud.infinibotos.com) in your browser, or `npm i -g infinibot` (Node.js 22.12+) on a Mac.

### Can I try it without installing anything?

Yes. [InfiniBot Cloud](https://cloud.infinibotos.com) runs in your browser. The Free plan gives you 30 active minutes a day and needs no card.

### Does InfiniBot have voice?

Yes. Voice runs locally by default. On the desktop app, **Set up voice for me** installs the built-in voice engine in one click, no Docker needed. Robovoice is the optional cloud voice for live calls, and it's free. Usage is measured to keep cloud voice fair; if it's ever busy, switch to local voice in one click.

### How do plugins work?

Open the **Plugins** page in the app. Free plugins (Business & Agency, Canvas Library (HoloCanvas), Content Studio, Discipline, Whiteboard, Robovoice) are included. Paid plugins are a one-time purchase that unlocks on the Plugins page: Infinitrade, Solatrix, OmniClinic and Droid Swarm are $49; InfiniCode and Products are $29; FlyPic is $19.

### Can my team use it too?

Yes, optionally. Multi-user workspaces are off by default. When the owner turns them on, they invite people, and each person starts with no access until the owner grants it on the Access page.

### What licence is InfiniBot under?

The Functional Source License, FSL-1.1-ALv2. Self-hosting is free, including inside your company. Offering a competing commercial product or service needs a [commercial license](https://cloud.infinibotos.com/licenses/). Each release becomes Apache-2.0 two years after it ships.

### Can I use InfiniBot commercially?

Yes. Using, modifying and self-hosting InfiniBot is free under the Functional Source License (FSL-1.1-ALv2), including inside your company and for client work. You only need a [commercial license](https://cloud.infinibotos.com/licenses/) for a Competing Use: making InfiniBot available to others in a commercial product or service that substitutes for it or offers substantially similar functionality, such as selling a hosted, resale, white-label or OEM product built on InfiniBot.

Commercial licenses: Indie Commercial $299 a year, Team / Business $1,499 a year, Agency / Reseller $2,499 every 6 months, and Enterprise / OEM $2,499 every 60 days. Enterprise perpetual rights for a fixed major version start at $49,999 by written quote. Each release also becomes Apache-2.0 two years after it ships. See [commercial licenses](https://cloud.infinibotos.com/licenses/) for the full terms.

### Does the desktop app update itself?

Yes. Installed desktop apps update automatically when a new release is published. One exception on Windows: if you have 2026.10.17 or earlier, run the new installer from the [download page](/download) once. Your data is kept, and from 2026.10.18 on, updates install automatically.
