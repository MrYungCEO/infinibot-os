---
summary: "Quick Telegram bot setup - BotFather token"
---

# ✈️ Telegram Quickstart

Create a Telegram bot and connect it to Infinibot in 3 minutes.

---

## ⚡ Quick Setup (3 minutes)

### Step 1: Create Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a **name** (display name, e.g., "My Assistant")
4. Choose a **username** (must end in `bot`, e.g., `myassistant_bot`)
5. Copy the **token** BotFather gives you

It looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

### Step 2: Add Token to Infinibot

**Option A: Environment variable**
```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
```

**Option B: Config file** (`~/.infinibot/config.json`)
```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
    }
  }
}
```

### Step 3: Restart Gateway

```bash
infinibot gateway restart
```

### Step 4: Message Your Bot! ✅

Find your bot on Telegram and send a message.

First message triggers **pairing** - you'll get a code. Approve it:
```bash
infinibot pairing approve telegram <code>
```

---

## 🤖 BotFather Settings (Optional)

Customize your bot with these BotFather commands:

| Command | What it does |
|---------|--------------|
| `/setdescription` | Bot description in profile |
| `/setabouttext` | "What can this bot do?" text |
| `/setuserpic` | Bot profile picture |
| `/setcommands` | Show commands in menu |
| `/setprivacy` | See all group messages (disable privacy) |

### Enable group message visibility:

By default, bots only see messages that @mention them in groups.

To see **all** group messages:
1. Message @BotFather
2. Send `/setprivacy`
3. Select your bot
4. Choose **Disable**

⚠️ After changing privacy, remove and re-add the bot to existing groups.

---

## 👥 Groups Setup

Add your bot to a group, then configure:

```json
{
  "channels": {
    "telegram": {
      "groups": {
        "*": {
          "requireMention": true
        }
      }
    }
  }
}
```

**Options:**
- `requireMention: true` - Bot only responds when @mentioned
- `requireMention: false` - Bot responds to all messages

---

## 🔒 Security: Who Can DM?

### Pairing mode (default):
Unknown users get a code. Approve manually:
```bash
infinibot pairing list telegram
infinibot pairing approve telegram <code>
```

### Allowlist mode:
Only specific users can DM:
```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "allowlist",
      "allowFrom": ["123456789"]
    }
  }
}
```

(Use Telegram user IDs - get yours from @userinfobot)

---

## ✅ Verify Connection

```bash
# Check status
infinibot status

# Send a test message (use user ID or @username)
infinibot message send --channel telegram --target "123456789" --message "Hello!"
```

---

## 🛠️ Troubleshooting

### Bot not responding

1. Check gateway is running: `infinibot gateway status`
2. Check token is valid: `infinibot status`
3. Check pairing: `infinibot pairing list telegram`

### "Unauthorized" error

Your token is invalid or revoked. Get a new one from @BotFather.

### Bot doesn't see group messages

1. Check privacy mode: `/setprivacy` with BotFather → Disable
2. Remove and re-add bot to the group
3. Or make the bot a group admin

### Can't find user ID

Message @userinfobot on Telegram - it replies with your user ID.

---

## 📖 Full Documentation

For webhooks, multiple accounts, and advanced features:

[📖 Complete Telegram Guide →](telegram.md)
