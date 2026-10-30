---
summary: "Quick Slack app setup - create app, install to workspace"
---

# 💼 Slack Quickstart

Create a Slack app and add it to your workspace in 10 minutes.

---

## ⚡ Quick Setup (10 minutes)

### Step 1: Create Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Name it (e.g., "InfiniBot Assistant")
5. Select your workspace
6. Click **Create App**

### Step 2: Configure Bot Permissions

1. Click **"OAuth & Permissions"** in sidebar
2. Scroll to **"Scopes"** → **"Bot Token Scopes"**
3. Add these scopes:

| Scope | Why |
|-------|-----|
| `chat:write` | Send messages |
| `channels:history` | Read channel messages |
| `channels:read` | List channels |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read DMs |
| `im:read` | Access DM info |
| `im:write` | Send DMs |
| `users:read` | Get user info |
| `app_mentions:read` | See @mentions |

### Step 3: Install to Workspace

1. Scroll up to **"OAuth Tokens"**
2. Click **"Install to Workspace"**
3. Click **Allow**
4. Copy the **"Bot User OAuth Token"** (starts with `xoxb-`)

### Step 4: Enable Socket Mode

1. Click **"Socket Mode"** in sidebar
2. Toggle **Enable Socket Mode** ON
3. Create an app-level token:
   - Name: "infinibot"
   - Scope: `connections:write`
4. Copy the **App-Level Token** (starts with `xapp-`)

### Step 5: Subscribe to Events

1. Click **"Event Subscriptions"** in sidebar
2. Toggle **Enable Events** ON
3. Under **"Subscribe to bot events"**, add:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `app_mention`

### Step 6: Add Tokens to InfiniBot

Edit `~/.infinibot/infinibot.json`:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-token"
    }
  }
}
```

### Step 7: Restart Gateway

```bash
infinibot gateway restart
```

### Step 8: Invite Bot to Channel

In Slack:
1. Go to a channel
2. Type `/invite @YourBotName`

Or: Click channel name → Integrations → Add apps

### Step 9: Message Your Bot! ✅

@mention the bot or DM it directly.

---

## 📋 Required Scopes Summary

```
chat:write
channels:history
channels:read
groups:history
groups:read
im:history
im:read
im:write
users:read
app_mentions:read
```

---

## 🔧 Configuration Options

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "channels": {
        "general": { "requireMention": true },
        "bot-help": { "requireMention": false }
      }
    }
  }
}
```

---

## 🔒 Security: DM Access

### Allowlist specific users:
```json
{
  "channels": {
    "slack": {
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["U01234567"]
      }
    }
  }
}
```

**Find User ID:** Click on a user → View profile → More (⋮) → Copy member ID

---

## ✅ Verify Connection

```bash
# Check status
infinibot status

# Send a test message
infinibot message send --channel slack --target "#general" --message "Hello from InfiniBot!"
```

---

## 🛠️ Troubleshooting

### Bot not responding in channel

1. Is the bot invited to the channel? `/invite @BotName`
2. Check Socket Mode is enabled
3. Check event subscriptions are configured

### "not_in_channel" error

Invite the bot: `/invite @BotName`

### "missing_scope" error

Add the missing scope in OAuth & Permissions, then reinstall the app.

### "invalid_auth" error

Tokens are invalid. Regenerate them:
1. OAuth & Permissions → Reinstall app → Copy new bot token
2. Basic Information → App-Level Tokens → Regenerate

### Socket Mode disconnects

Check your `appToken` (xapp-) is correct and has `connections:write` scope.

---

## 📖 Full Documentation

For slash commands, interactive messages, and enterprise setup:

[📖 Complete Slack Guide →](slack.md)
