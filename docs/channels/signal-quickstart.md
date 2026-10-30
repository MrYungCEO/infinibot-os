---
summary: "Quick Signal setup via signal-cli"
---

# 📱 Signal Quickstart

Connect InfiniBot to Signal in 5 minutes using signal-cli.

---

## ⚡ Prerequisites

Signal requires **signal-cli** - a command-line Signal client.

### Install signal-cli

**macOS:**
```bash
brew install signal-cli
```

**Linux (Ubuntu/Debian):**
```bash
# Download latest release
wget https://github.com/AsamK/signal-cli/releases/download/v0.13.2/signal-cli-0.13.2-Linux.tar.gz
tar xf signal-cli-0.13.2-Linux.tar.gz
sudo mv signal-cli-0.13.2 /opt/signal-cli
sudo ln -s /opt/signal-cli/bin/signal-cli /usr/local/bin/
```

**Windows (WSL):**
Use the Linux instructions inside WSL.

---

## ⚡ Quick Setup (5 minutes)

### Step 1: Register a Phone Number

You need a phone number that can receive SMS.

```bash
signal-cli -u +15551234567 register
```

### Step 2: Verify with SMS Code

You'll receive an SMS code. Enter it:

```bash
signal-cli -u +15551234567 verify 123-456
```

### Step 3: Configure InfiniBot

Edit `~/.infinibot/infinibot.json`:

```json
{
  "channels": {
    "signal": {
      "enabled": true,
      "number": "+15551234567"
    }
  }
}
```

### Step 4: Restart Gateway

```bash
infinibot gateway restart
```

### Step 5: Message the Number! ✅

Send a Signal message to your registered number.

---

## 🔗 Alternative: Link to Existing Account

Instead of registering a new number, link as a secondary device:

```bash
# Generate linking URI
signal-cli link -n "InfiniBot"

# This shows a URI - convert to QR code or use directly
```

Then scan with Signal app: Settings → Linked Devices → Link New Device

---

## 🔒 Security: Who Can Message?

### Pairing mode (default):
```bash
infinibot pairing list signal
infinibot pairing approve signal <code>
```

### Allowlist mode:
```json
{
  "channels": {
    "signal": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15559876543"]
    }
  }
}
```

---

## 👥 Groups

Signal groups work automatically. Configure mention requirements:

```json
{
  "channels": {
    "signal": {
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
infinibot message send --channel signal --target "+15559876543" --message "Hello from InfiniBot!"
```

---

## 🛠️ Troubleshooting

### "signal-cli not found"

Install signal-cli (see Prerequisites above).

### Registration failed

- Make sure the number can receive SMS
- Some VoIP numbers don't work
- Try voice verification: `signal-cli -u +1555... register --voice`

### Messages not sending

Check signal-cli works directly:
```bash
signal-cli -u +15551234567 send -m "Test" +15559876543
```

### Captcha required

Signal sometimes requires captcha verification:
```bash
signal-cli -u +15551234567 register --captcha "CAPTCHA_TOKEN"
```

Get the token from: https://signalcaptchas.org/registration/generate.html

---

## 📖 Full Documentation

For advanced features and multi-account setup:

[📖 Complete Signal Guide →](signal.md)
