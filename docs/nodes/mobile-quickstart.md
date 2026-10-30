---
summary: "Quick mobile node setup - iOS and Android pairing"
---

# 📲 Mobile Node Quickstart

Extend Infinibot to your phone for camera, location, notifications, and more.

---

## 🤔 What is a Mobile Node?

A **node** is a device that extends Infinibot's capabilities:

- 📸 **Camera** - Take photos on command
- 📍 **Location** - Share your location
- 🔔 **Notifications** - Get alerts from Infinibot
- 🎤 **Audio** - Voice interactions
- 📺 **Canvas** - Display content on your screen

Your phone becomes a sensor and interface for your AI assistant.

---

## ⚡ Quick Setup (iOS)

### Step 1: Install the App

Download **Infinibot** from the App Store:

[📱 Download for iOS](https://apps.apple.com/app/infinibot)

### Step 2: Open and Pair

1. Open the Infinibot app
2. Tap **"Pair with Gateway"**
3. You'll see a pairing code

### Step 3: Approve on Gateway

On your computer:
```bash
# See pending pairing requests
infinibot nodes pending

# Approve the device
infinibot nodes approve <request-id>
```

### Step 4: Done! ✅

Your phone is now connected. Test it:
```bash
# Take a photo
infinibot nodes camera <device-name>

# Get location
infinibot nodes location <device-name>
```

---

## ⚡ Quick Setup (Android)

### Step 1: Install the App

Download **Infinibot** from Google Play:

[📱 Download for Android](https://play.google.com/store/apps/details?id=ai.infinibot.node)

### Step 2: Open and Pair

1. Open the Infinibot app
2. Tap **"Connect to Gateway"**
3. Enter your gateway URL (e.g., `http://192.168.1.100:18789`)
4. A pairing code appears

### Step 3: Approve on Gateway

```bash
infinibot nodes pending
infinibot nodes approve <request-id>
```

### Step 4: Grant Permissions

The app will request permissions for:
- 📸 Camera
- 📍 Location
- 🎤 Microphone
- 🔔 Notifications

Grant the ones you want to use.

### Step 5: Done! ✅

---

## 🔗 Connection Methods

### Local Network (LAN)

If your phone and gateway are on the same network:

```
Gateway URL: http://192.168.1.100:18789
```

Find your computer's IP:
```bash
# macOS/Linux
ifconfig | grep "inet "

# Windows
ipconfig
```

### Remote Access (Internet)

For access outside your home network:

**Option A: Tailscale (Recommended)**
1. Install Tailscale on both devices
2. Use Tailscale IP: `http://100.x.x.x:18789`

**Option B: Port Forward + Dynamic DNS**
1. Forward port 18789 on your router
2. Use your public IP or DDNS hostname

[📖 Remote Access Guide →](../gateway/remote.md)

---

## 📸 Using Camera

Ask your AI or use CLI:

**Via chat:**
> "Take a photo with my phone"

**Via CLI:**
```bash
# List connected nodes
infinibot nodes status

# Snap a photo
infinibot nodes camera-snap --node "iPhone" --facing back
```

---

## 📍 Using Location

**Via chat:**
> "Where am I right now?"

**Via CLI:**
```bash
infinibot nodes location --node "iPhone"
```

---

## 🔔 Sending Notifications

**Via chat:**
> "Remind me to call John in 10 minutes"

**Via CLI:**
```bash
infinibot nodes notify --node "iPhone" \
  --title "Reminder" \
  --body "Call John"
```

---

## 🎛️ Node Configuration

Edit `~/.infinibot/config.json`:

```json
{
  "nodes": {
    "enabled": true,
    "autoApprove": false,
    "devices": {
      "iPhone": {
        "capabilities": ["camera", "location", "notify"],
        "cameraDefault": "back"
      }
    }
  }
}
```

### Auto-approve devices:
```json
{
  "nodes": {
    "autoApprove": true
  }
}
```

⚠️ Only enable auto-approve on secure networks.

---

## ✅ Verify Connection

```bash
# List all nodes
infinibot nodes status

# Describe a specific node
infinibot nodes describe <node-name>

# Test camera
infinibot nodes camera-snap --node <name>

# Test location
infinibot nodes location --node <name>
```

---

## 🛠️ Troubleshooting

### Node not connecting

1. **Same network?** Phone and gateway must be reachable
2. **Firewall?** Allow port 18789
3. **Gateway running?** `infinibot gateway status`

### "Connection refused"

- Check gateway URL is correct
- Check gateway is listening: `infinibot status`
- Try with IP instead of hostname

### Camera permission denied

On your phone:
- iOS: Settings → Infinibot → Camera → Allow
- Android: Settings → Apps → Infinibot → Permissions → Camera

### Node disconnects frequently

- Check WiFi stability
- Enable "Keep alive" in app settings
- On Android, disable battery optimization for Infinibot

### Notifications not appearing

- iOS: Settings → Infinibot → Notifications → Allow
- Android: Settings → Apps → Infinibot → Notifications → On
- Check Do Not Disturb is off

---

## 📺 Canvas (Display Content)

Show content on your phone screen:

```bash
# Present a URL
infinibot canvas present --node "iPhone" --url "https://example.com"

# Present HTML
infinibot canvas present --node "iPhone" --html "<h1>Hello!</h1>"
```

---

## 🎤 Voice Wake

Wake your phone with voice commands:

```json
{
  "nodes": {
    "devices": {
      "iPhone": {
        "voiceWake": {
          "enabled": true,
          "phrase": "Hey Infinibot"
        }
      }
    }
  }
}
```

[📖 Voice Wake Guide →](voicewake.md)

---

## 📖 Full Documentation

For screen recording, audio, and advanced features:

[📖 Complete Nodes Guide →](index.md)
