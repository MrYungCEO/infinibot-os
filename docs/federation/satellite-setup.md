# Satellite Node Setup

Connect a second device to your InfiniBot network in under 5 minutes.

---

## Prerequisites

- **Master device**: InfiniBot running in `master` mode on the same LAN (or Tailscale / Cloudflare tunnel for WAN)
- **Satellite device**: Node.js 20 LTS + git (or Docker)
- Both devices on the **same Wi-Fi / Ethernet** for LAN discovery to work

---

## Step 1 — Clone and install on the satellite

```bash
git clone https://github.com/MrYungCEO/infinibotOS.git
cd infinibotOS
bun install           # or: npm install
```

---

## Step 2 — Get the satellite config from the master

On the **master device**, open the InfiniBot dashboard → Federation → **Add Satellite Node**.

1. Enter a node name (e.g. `ASUS-TUF-Linux`).
2. Select the satellite's platform.
3. On the **Configure Connection** step, click **⊕ Scan LAN** — the master is advertising itself via mDNS and the wizard will find it automatically. Alternatively, pick a LAN/Tailscale URL from the list.
4. Copy the generated JSON config.

Save the config on the **satellite** to:

| Platform | Path |
|----------|------|
| Linux / macOS | `~/.infinibot/infinibot.json` |
| Windows | `%USERPROFILE%\.infinibot\infinibot.json` |
| Docker | `/root/.infinibot/infinibot.json` (inside container) |

The config looks like:

```json
{
  "federation": {
    "enabled": true,
    "mode": "satellite",
    "masterUrl": "ws://192.168.1.10:47913/federation",
    "nodeName": "ASUS-TUF-Linux",
    "discovery": true
  },
  "gateway": { "port": 47913, "mode": "local", "bind": "lan" }
}
```

> **Tip — zero-config discovery**: If you set `"discovery": true` in the config above and leave `masterUrl` blank, the satellite will scan for the master via mDNS on startup and connect automatically (no manual IP needed).

---

## Step 3 — Start the satellite gateway

```bash
# Direct
bun run gateway

# Or if installed globally
infinibot gateway start
```

The terminal should show:

```
[FEDERATION] satellite mode, connecting to ws://192.168.1.10:47913/federation
[FEDERATION] connected to master as node-<uuid>
```

---

## Step 4 — Verify on the master

1. Open the master dashboard → **Federation** (or **/nodes** view).
2. The satellite should appear in the **Connected Nodes** list within ~10 seconds.
3. The master wizard's **Connect** step will show a spinner until the satellite registers — it auto-advances when the node appears.

---

## Protocol overview

| Phase | Who | What |
|-------|-----|------|
| **Advertisement** | Master | Publishes `_infinibot-federation._tcp` mDNS service on startup |
| **Discovery** | Satellite | Scans for the service; updates `masterUrl` automatically |
| **Handshake** | Satellite → Master | WebSocket connect to `/federation`, sends `node.register` with manifest |
| **Registration** | Master | Validates protocol version, echoes `register.ack`, begins heartbeats |
| **Heartbeat** | Both | 30-second ping/pong; master drops node after 3 missed heartbeats |

Discovery is **open-LAN** (any device sees the mDNS record). Authentication is the gateway password, shared from master to satellites via the config JSON.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Satellite shows `connecting` forever | Wrong `masterUrl` | Run `⊕ Scan LAN` in wizard or check master's LAN IP |
| mDNS scan returns nothing | Satellite firewall blocks mDNS (UDP 5353) | Open port, or paste the master's IP manually |
| Node disappears after 90 s | Heartbeat timeout | Check network stability; master and satellite must stay reachable |
| "mDNS not available" error | `@homebridge/ciao` not installed | Run `bun install` in the repo root |

---

## WAN / cross-subnet federation

mDNS is LAN-only (link-local multicast). For devices on different networks:

- **Tailscale**: Install on both devices → the master advertises its Tailscale IP in `federation.urls`. Use the Tailscale URL from the wizard.
- **Cloudflare Tunnel**: Start `infinibot tunnel` on the master → tunnel URL appears in the wizard → paste it as `masterUrl`.

NAT traversal across arbitrary internet connections is not yet supported (tracked as a deferred item).

---

## Expected timing

- mDNS discovery: **~3 seconds**
- Satellite → master WebSocket connect: **<1 second** (same LAN)
- Satellite visible in master dashboard: **~5–10 seconds** total
