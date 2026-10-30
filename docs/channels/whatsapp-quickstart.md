---
summary: "Quick WhatsApp setup - scan QR and go"
---

# 💬 WhatsApp Quickstart

Connect Infinibot to WhatsApp in 2 minutes. Just scan a QR code.

---

## ⚡ Quick Setup (2 minutes)

### Step 1: Start QR Login

```bash
infinibot channels login
```

A QR code appears in your terminal.

### Step 2: Scan with WhatsApp

1. Open **WhatsApp** on your phone
2. Go to **Settings** → **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code

### Step 3: Done! ✅

Infinibot is now connected. Send yourself a message to test.

---

## 📱 Phone Number Options

### Option A: Dedicated Number (Recommended)

Use a **separate phone number** for Infinibot:
- Clean separation from personal chats
- No confusion about who's replying
- Best for always-on assistant

**How to get one:**
- Spare phone + cheap prepaid SIM
- eSIM on your main phone (dual SIM)
- WhatsApp Business app (separate from personal WhatsApp)

### Option B: Your Personal Number

Use your own number with "self-chat mode":
- Message yourself to talk to Infinibot
- Quick for testing
- May confuse contacts if replies leak

```json
{
  "channels": {
    "whatsapp": {
      "selfChatMode": true
    }
  }
}
```

---

## 🔒 Security: Who Can Message?

By default, Infinibot uses **pairing mode** - unknown senders get a code.

### Allow specific people only:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567", "+15559876543"]
    }
  }
}
```

### Approve new senders manually:

```bash
# See pending requests
infinibot pairing list whatsapp

# Approve someone
infinibot pairing approve whatsapp <code>
```

---

## 🔧 Configuration

Edit `~/.infinibot/config.json`:

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    }
  }
}
```

Then restart:
```bash
infinibot gateway restart
```

---

## ✅ Verify Connection

```bash
# Check WhatsApp status
infinibot status

# Send a test message
infinibot message send --channel whatsapp --target "+15551234567" --message "Hello from Infinibot!"
```

---

## 🛠️ Troubleshooting

### QR code expired

QR codes expire after ~60 seconds. Run again:
```bash
infinibot channels login
```

### "Session closed" after linking

WhatsApp sometimes disconnects new links. Wait 30 seconds and the gateway should reconnect automatically.

### Messages not delivering

Check that:
1. Gateway is running: `infinibot gateway status`
2. WhatsApp is connected: `infinibot status`
3. Recipient is in allowlist (if using allowlist mode)

### Re-link device

If connection is broken:
```bash
# Clear session and re-link
infinibot channels logout whatsapp
infinibot channels login
```

---

## 📖 Full Documentation

For advanced features (groups, media, multiple accounts):

[📖 Complete WhatsApp Guide →](whatsapp.md)
