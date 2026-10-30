---
summary: "Quick Discord bot setup - create app, get token, invite"
---

# 🎮 Discord Quickstart

Create a Discord bot and add it to your server in 5 minutes.

---

## ⚡ Quick Setup (5 minutes)

### Step 1: Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Name it (e.g., "My Assistant")
4. Click **Create**

### Step 2: Create Bot User

1. Click **"Bot"** in the left sidebar
2. Click **"Add Bot"** → **"Yes, do it!"**
3. Under **Token**, click **"Reset Token"**
4. Copy the token (you'll only see it once!)

### Step 3: Enable Required Intents ⚠️

Still on the Bot page, scroll down to **"Privileged Gateway Intents"**:

✅ **Enable these:**
- [x] **MESSAGE CONTENT INTENT** (required!)
- [x] **SERVER MEMBERS INTENT** (recommended)

Click **Save Changes**.

### Step 4: Add Token to Infinibot

**Option A: Environment variable**
```bash
export DISCORD_BOT_TOKEN="your-token-here"
```

**Option B: Config file** (`~/.infinibot/config.json`)
```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "your-token-here"
    }
  }
}
```

### Step 5: Generate Invite Link

1. Go to **OAuth2** → **URL Generator**
2. Under **Scopes**, check:
   - [x] `bot`
   - [x] `applications.commands`
3. Under **Bot Permissions**, check:
   - [x] Send Messages
   - [x] Read Message History
   - [x] Add Reactions
   - [x] Use Slash Commands
4. Copy the generated URL at the bottom

### Step 6: Invite Bot to Server

1. Paste the URL in your browser
2. Select your server
3. Click **Authorize**

### Step 7: Start Infinibot

```bash
infinibot gateway restart
```

### Step 8: Message Your Bot! ✅

DM the bot or @mention it in a channel.

---

## 📋 Quick Reference: Bot Permissions

Minimum permissions for basic chat:
```
Send Messages
Read Message History
Add Reactions
Use Slash Commands
```

Full permissions number: `274877975552`

Pre-built invite URL (replace CLIENT_ID):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=274877975552&scope=bot%20applications.commands
```

---

## 🏠 Server (Guild) Setup

Control bot behavior per server:

```json
{
  "channels": {
    "discord": {
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": {
            "general": { "requireMention": true },
            "bot-chat": { "requireMention": false }
          }
        }
      }
    }
  }
}
```

**Find Guild ID:**
1. Enable Developer Mode: User Settings → App Settings → Advanced → Developer Mode
2. Right-click server name → Copy Server ID

---

## 🔒 Security: Who Can DM?

### Pairing mode (default):
```bash
infinibot pairing list discord
infinibot pairing approve discord <code>
```

### Allowlist mode:
```json
{
  "channels": {
    "discord": {
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["user:123456789"]
      }
    }
  }
}
```

---

## ✅ Verify Connection

```bash
# Check status
infinibot status

# Send a test message
infinibot message send --channel discord --target "user:123456789" --message "Hello!"
```

---

## 🛠️ Troubleshooting

### Bot is online but doesn't respond

**Most common cause:** Message Content Intent not enabled!

Fix:
1. Discord Developer Portal → Your App → Bot
2. Enable **MESSAGE CONTENT INTENT**
3. Save and restart gateway

### "Used disallowed intents" error

Same fix - enable the intents in Developer Portal.

### Bot can't see messages in server

1. Check bot has "Read Message History" permission in that channel
2. Check channel permission overrides

### Can't find the token

Tokens can only be viewed once. Reset it:
1. Developer Portal → Bot → Reset Token
2. Update your config with new token

### "Invalid token" error

Token was reset or copied incorrectly. Get a fresh token from Developer Portal.

---

## 📖 Full Documentation

For slash commands, reactions, threads, and more:

[📖 Complete Discord Guide →](discord.md)
