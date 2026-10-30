---
summary: "Quick iMessage setup - macOS only via BlueBubbles or direct"
---

# 💬 iMessage Quickstart (macOS Only)

Connect InfiniBot to iMessage on your Mac in 5 minutes.

---

## ⚠️ Requirements

- **macOS only** (iMessage requires macOS)
- **Signed into iMessage** on your Mac
- **Full Disk Access** for InfiniBot (to read Messages database)

---

## ⚡ Quick Setup (5 minutes)

### Step 1: Grant Full Disk Access

InfiniBot needs to read the Messages database.

1. Open **System Preferences** → **Privacy & Security** → **Full Disk Access**
2. Click the **+** button
3. Add **Terminal** (or your terminal app)
4. If running as a service, also add the Node.js binary

### Step 2: Configure InfiniBot

Edit `~/.infinibot/infinibot.json`:

```json
{
  "channels": {
    "imessage": {
      "enabled": true
    }
  }
}
```

### Step 3: Restart Gateway

```bash
infinibot gateway restart
```

### Step 4: Send an iMessage! ✅

Messages sent to your Mac's iMessage will now be processed.

---

## 🔒 Security: Who Can Message?

### Allowlist mode (recommended):
```json
{
  "channels": {
    "imessage": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567", "friend@icloud.com"]
    }
  }
}
```

### Pairing mode:
```bash
infinibot pairing list imessage
infinibot pairing approve imessage <code>
```

---

## 📱 Alternative: BlueBubbles Server

For more features and reliability, use BlueBubbles:

### What is BlueBubbles?

A server that runs on your Mac and provides a proper API for iMessage.

### Setup BlueBubbles

1. Download from [bluebubbles.app](https://bluebubbles.app)
2. Install and run on your Mac
3. Follow BlueBubbles setup wizard
4. Note the server URL and password

### Configure InfiniBot for BlueBubbles

```json
{
  "channels": {
    "bluebubbles": {
      "enabled": true,
      "serverUrl": "http://localhost:1234",
      "password": "your-password"
    }
  }
}
```

[📖 Full BlueBubbles Guide →](bluebubbles.md)

---

## 👥 Group Chats

iMessage group chats work automatically:

```json
{
  "channels": {
    "imessage": {
      "groups": {
        "*": {
          "requireMention": true
        }
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
infinibot message send --channel imessage --target "+15551234567" --message "Hello!"
```

---

## 🛠️ Troubleshooting

### "Permission denied" reading messages

Grant Full Disk Access:
1. System Preferences → Privacy & Security → Full Disk Access
2. Add Terminal and/or Node.js

### Messages not sending

Check that:
1. iMessage is signed in and working on your Mac
2. You can send iMessages normally from Messages.app
3. Gateway has Full Disk Access

### Only seeing some messages

The direct iMessage integration reads from the local database. For real-time reliability, consider using BlueBubbles.

### "Database locked" errors

Close Messages.app and try again, or restart the gateway.

---

## 📖 Full Documentation

For reactions, attachments, and advanced features:

[📖 Complete iMessage Guide →](imessage.md)
