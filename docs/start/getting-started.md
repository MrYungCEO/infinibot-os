---
summary: "Beginner guide: start on InfiniBot Cloud in your browser (or download the free desktop app), finish the setup and send your first message. No coding needed."
read_when:
  - You have never used InfiniBot (or an AI tool like it) before
  - You want the shortest path from download to your first message
---

# Getting started with InfiniBot

This guide is for you if you have never set up an AI tool before. You don't need to know what an "API" is, and you don't need to write any code. It takes about 10 minutes.

InfiniBot gives you a team of AI helpers (we call them **agents**) that can answer messages, write, research, organise your notes and tasks, and work with the apps you already use. The fastest way to start is **InfiniBot Cloud**: your own private InfiniBot in the browser, nothing to install. Prefer your own hardware? Running it yourself on your computer is free.

**Fastest:** [Start on InfiniBot Cloud](#start-on-infinibot-cloud) · **Run it yourself, free:** [1. Download](#1-download) → [2. Install](#2-install) → [3. The 8-step setup](#3-the-8-step-setup) → [4. Send your first message](#4-send-your-first-message) → [5. Keep learning](#5-keep-learning)

## Start on InfiniBot Cloud

No download and no install. It works on any computer, a Chromebook or your phone.

1. Open [InfiniBot Cloud](https://cloud.infinibotos.com/app/) and create your account. The **Free plan** gives you the full workspace for 30 active minutes a day, and it needs no card.
2. Your private InfiniBot machine starts in the browser. Connect the AI provider your agents should think with (InfiniBot Cloud is bring-your-own-key, so the provider bills you directly and there's no markup).
3. Say what you want handled, the same way as in [4. Send your first message](#4-send-your-first-message).

Want it on 24/7, so channels, schedules and background agents keep working while you sleep? **Pro** ($49/mo) is always on, and **Starter** ($19/mo) wakes when you use it. See every plan on [Cloud pricing](https://cloud.infinibotos.com/pricing).

[Start on InfiniBot Cloud →](https://cloud.infinibotos.com/app/)

## Run it yourself, free

Prefer to run InfiniBot on your own computer? The desktop app for Windows and Linux (and npm on a Mac) is free, with no account needed. The steps below walk you through it.

## Watch the 6-minute setup guide

Prefer to watch? This video covers the run-it-yourself route on this page: download and install, the 8-step setup, AI brains and API keys, the cloud and npm routes, and fixes for common problems. Tap a chapter to jump to it.

<!--setup-guide:player compact-->


## 1. Download

Go to the [download page](/download) and press the big button. It picks the right file for your computer.

- **Windows 10 or 11:** `InfiniBot-Setup-x64.exe`
- **Linux:** the AppImage (works on most Linux computers) or the `.deb` file (Debian and Ubuntu)
- **Mac:** the Mac app is coming soon. For now, use [InfiniBot Cloud](https://cloud.infinibotos.com) in your browser, or the terminal install below.

Prefer not to install anything? [Start on InfiniBot Cloud](#start-on-infinibot-cloud) instead. The Free plan needs no card.

## 2. Install

### On Windows

Already have InfiniBot 2026.10.17 or earlier? Run the new installer once. Older Windows versions download the update but can't install it themselves. Your data is kept, and from 2026.10.18 on, updates install automatically.

1. Open `InfiniBot-Setup-x64.exe` from your Downloads folder. If your browser says the file isn't commonly downloaded, choose **Keep**.
2. Windows may show a blue **"Windows protected your PC"** screen. Click **More info**, then **Run anyway**. This happens because InfiniBot is a new app that isn't code-signed yet, not because anything is wrong. Want to double-check? Compare the file's SHA-256 with the checksum on the [download page](/download#verify) (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`).
3. Finish the installer and open **InfiniBot** from the Start menu.

The two clicks look like this:

![Illustration of step 1: the blue Windows SmartScreen dialog titled "Windows protected your PC", with a gold circle and arrow pointing at the "More info" link under the message](/assets/download/smartscreen-step1-1000.webp)

![Illustration of step 2: the expanded SmartScreen dialog showing "App: InfiniBot-Setup-x64.exe" and "Publisher: Unknown publisher", with a gold circle and arrow pointing at the "Run anyway" button](/assets/download/smartscreen-step2-1000.webp)

*Illustration — a reproduction of the Windows SmartScreen dialog, not a screenshot.* More detail, including how to check the checksum step by step: [Windows guide](/docs/windows).

### On Linux

- **AppImage:** right-click the file, allow it to run as a program (or run `chmod +x InfiniBot-x86_64.AppImage`), then open it.
- **.deb:** run `sudo apt install ./infinibot_amd64.deb`, then open InfiniBot from your app menu.

### Prefer the terminal? (Mac, Linux or Windows)

If you are comfortable with a terminal and have [Node.js](https://nodejs.org/) 22.12 or newer:

```bash
npm i -g infinibot && infinibot quickstart
```

More options: [Install](/docs/install).

## 3. The 8-step setup

The first time you open the desktop app, it asks where to keep your data (the default folder is fine). Then the setup starts. It has 8 short steps, and you can skip any of them and come back later.

1. **Your goals.** Tell InfiniBot what you want help with (for example: customers, content, research, your own tasks). It uses this to tailor the rest of the setup.
2. **AI brain.** Choose the AI model your agents think with. You don't need an API key. Already pay for **Claude**, **ChatGPT**, **Google (Gemini)** or **Grok**? Sign in with that plan through the provider's official app for the terminal (Claude Code, Codex CLI, Gemini CLI or Grok Build; OpenCode works too). Or pick a free **local model** that runs on your computer (Ollama or vLLM), or use a provider's free tier (**Google Gemini** and **Groq** have one). **OpenRouter** is one key for hundreds of models. Already have a key from OpenAI, Anthropic or another provider? Paste it here.
3. **Channels.** Decide where you talk to your agents: just this app, or also **Telegram**, **WhatsApp** or **Discord**.
4. **Voice.** Turn on voice so you can speak to your agents and hear them answer. Voice runs locally by default: press **Set up voice for me** and the built-in voice engine installs in one click, no Docker needed. Robovoice, the optional cloud voice, is free.
5. **Phone.** Pair the InfiniBot mobile app so you can use the same team from your phone.
6. **Privacy.** Choose whether to use **Secure Mode**: sensitive chats and files stay on local models on your own computer, with an encrypted vault.
7. **Your plan.** InfiniBot recommends plugins and courses that fit your goals.
8. **Finish.** Review your choices and start using InfiniBot.

What's an "API key"? It's a password-like code from an AI company that lets an app use their AI and bill your account with them. With the plan you already pay for, a local model or a free tier, you can skip it entirely.

## 4. Send your first message

Open **Chat**, type a message and press Enter. Try one of these:

- "Introduce yourself and tell me what you can do for me."
- "Make a checklist for launching my new product next month."
- "Summarise this note in three bullet points:" (then paste some text)

Your agent answers in the chat. The first chat greets you with the account your agent runs on, so you can see which AI is answering. If you connected Telegram, WhatsApp or Discord in step 3, you can message it there too.

If nothing happens, check that an AI brain is set up (step 2). With a local model, the first answer can take a little longer while the model loads.

## 5. Keep learning

- **Learn courses.** Open **Learn** in the app for short, guided courses on the main features.
- **Plugins.** Open the **Plugins** page to add whole new tools. Free plugins are included. Paid plugins are a one-time purchase ($19 to $49) that unlocks right there.
- **Your learning path.** After setup, a personal learning path walks you through the app based on your goals.
- **Docs.** Browse the [documentation](/docs/) when you want to go deeper.

## FAQ

### Is it safe?

The installer is unsigned for now, so Windows may show the blue "Windows protected your PC" screen (click **More info**, then **Run anyway**), and you can verify the checksum on the [download page](/download#verify). InfiniBot runs on your computer, and Secure Mode keeps chats on local models only. InfiniBot is source-available under the Functional Source License (FSL).

### Do I need an API key?

No. On the desktop app you can sign in with the Claude, ChatGPT, Google or Grok plan you already have, run a free local model (Ollama) on your computer, or use a provider's free tier (Google Gemini, Groq).

### What does it cost?

The desktop app and self-hosting are free. Cloud plans run from Free ($0) to $199 a month. Some plugins are a one-time purchase ($19 to $49). Your own AI provider bills you separately, or a local model is $0.

### Is my data private?

Self-hosted data stays on your machine. Secure Mode keeps sensitive chats and files on local models, with an encrypted vault.

### Is there a Mac app?

Coming soon. For now, use [InfiniBot Cloud](https://cloud.infinibotos.com) in your browser, or `npm i -g infinibot` (Node.js 22.12+) on a Mac.

### Can I use InfiniBot commercially?

Yes. Using, modifying and self-hosting InfiniBot is free under the Functional Source License (FSL-1.1-ALv2), including inside your company and for client work. You only need a [commercial license](https://cloud.infinibotos.com/licenses/) for a Competing Use: making InfiniBot available to others in a commercial product or service that substitutes for it or offers substantially similar functionality, such as selling a hosted, resale, white-label or OEM product built on InfiniBot.

Commercial licenses: Indie Commercial $299 a year, Team / Business $1,499 a year, Agency / Reseller $2,499 every 6 months, and Enterprise / OEM $2,499 every 60 days. Enterprise perpetual rights for a fixed major version start at $49,999 by written quote. Each release also becomes Apache-2.0 two years after it ships. See [commercial licenses](https://cloud.infinibotos.com/licenses/) for the full terms.

More questions: [FAQ](/docs/faq).
