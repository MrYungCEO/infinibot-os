# Getting started with InfiniBot

This guide takes you from nothing to your first message in about 10 minutes.
You don't need an account, a credit card or a terminal.

## 1. Pick how you want to run it

| Option | Best for | Where |
| --- | --- | --- |
| **Desktop app** (recommended) | Windows 10/11 and Linux | <https://infinibotos.com/download> |
| **InfiniBot Cloud** | Trying it in your browser, or a Mac for now | <https://cloud.infinibotos.com> (Free plan, no card) |
| **npm** | People comfortable with a terminal, on Windows, macOS or Linux | `npm i -g infinibot` (Node.js 22.12+) |

A macOS desktop app is coming soon.

## 2. Install the desktop app

Download the file for your system from <https://infinibotos.com/download>.
The current release is **v2026.10.18**, and installed apps update
themselves. On Windows, 2026.10.17 and earlier download the update but can't
install it on their own: run the new installer from the download page once
(your data is kept). From 2026.10.18 on, Windows updates install
automatically.

- **Windows:** run `InfiniBot-Setup-x64.exe`.

  Windows may show a blue **"Windows protected your PC"** screen. Click
  **More info**, then **Run anyway**. This happens because InfiniBot is a new
  app that isn't code-signed yet, not because anything is wrong. Want to
  double-check? Compare the file's SHA-256 with the checksum on the download
  page (PowerShell: `Get-FileHash .\InfiniBot-Setup-x64.exe`).

- **Linux:** run the AppImage (`chmod +x InfiniBot-x86_64.AppImage`, then
  open it), or install the Debian/Ubuntu package with
  `sudo apt install ./infinibot_amd64.deb`.

Prefer not to install anything? Try InfiniBot Cloud in your browser:
<https://cloud.infinibotos.com>.

## 3. Set it up

On first launch the app asks where to keep your data, then opens
**Get started**, an 8-step setup:

1. **Your goals.** What you want InfiniBot for. This shapes everything after it.
2. **AI brain.** InfiniBot needs a model to think with. Pick one:
   - the **Claude, ChatGPT, Google or Grok plan you already have**. InfiniBot
     installs that provider's official CLI if needed, opens its sign-in in
     your browser and sends a tiny test message. No API key needed;
   - a **free local model** on your computer (Ollama or vLLM), so nothing
     leaves your machine and there's no bill; or
   - a **provider key**. Google Gemini and Groq have free tiers, and
     OpenRouter is one key for hundreds of models.
3. **Channels.** Keep it to this app, or connect Telegram, WhatsApp or
   Discord so you can message InfiniBot from your phone.
4. **Voice.** Talk to InfiniBot out loud. Local voice is the default:
   **Set up voice for me** installs the built-in voice engine in one click
   (no Docker needed). Cloud voice (Robovoice) is an optional, free choice.
5. **Phone.** Pair the InfiniBot mobile app with a QR code.
6. **Privacy.** Turn on **Secure Mode** for chats that only ever use local
   models on your machine.
7. **Your plan.** Recommended plugins and courses for your goals.
8. **Finish.** Review your choices and go.

You can **Skip** a step, and **Save and exit** keeps your progress. Come back
any time from **Settings › Setup › Get started**.

## 4. Send your first message

Open **Chat & Voice › Chat**, type "Hi, what can you do?" and press Enter.
Your agent answers using the AI brain you picked, and the first chat greets
you with the account it runs on.

## 5. Learn the app

After onboarding, your **personal learning path** walks you through the app
based on the goals you picked. Open **Home › Learn** any time. The courses are
short and interactive: each one walks
you through a real page of the app, one step at a time. Finish the core
courses to earn an InfiniBot certificate.

## Using npm instead

You need [Node.js 22.12 or newer](https://nodejs.org/).

```bash
npm i -g infinibot
infinibot quickstart
```

Then open the dashboard at <http://127.0.0.1:18789> and log in with the
gateway password you set. The npm package can lag behind the desktop app by a
release. More install options: <https://infinibotos.com/docs/install/>.

## Plugins and prices

- The desktop app and self-hosting are free.
- Free plugins are included: Business & Agency, Canvas Library, Content
  Studio, Discipline, Whiteboard and Robovoice (the optional, free cloud
  voice).
- Paid plugins are a one-time purchase on **Home › Plugins**: FlyPic $19;
  InfiniCode and Products $29; Infinitrade, Solatrix, OmniClinic and Droid
  Swarm $49.
- InfiniBot Cloud plans run from Free ($0) to Scale ($199/mo).
- Your AI provider bills you separately (or your existing subscription
  covers it), or a local model costs $0.

## Something not working?

| Problem | Fix |
| --- | --- |
| Windows blocks the installer | Click **More info**, then **Run anyway** |
| Chat says no model is configured | Add a key in **Settings › Keys & Usage**, or rerun **Settings › Setup › Get started** |
| Anything else | Run `infinibot doctor` (npm installs), or see <https://infinibotos.com/docs/troubleshooting/> |

## More help

- Docs: <https://infinibotos.com/docs/>
- FAQ: <https://infinibotos.com/docs/faq/>
- Windows notes: <https://infinibotos.com/docs/windows/>
- Security: <https://infinibotos.com/docs/security/>
