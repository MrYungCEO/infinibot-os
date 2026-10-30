# Federation Windows Verification

How to run the Windows self-test harness, what each check means, and how to fix failures.

## Prerequisites

| Requirement | Minimum |
|---|---|
| Windows | 10 (build 19041+) or 11 |
| Node.js | 20 LTS |
| InfiniBot | built from source (`pnpm build`) |
| Gateway | running (`pnpm start` or via Desktop app) |
| Federation | configured (at least one non-Windows peer connected) |

The gateway must be running before you execute the harness.

---

## Running the harness

### On a Windows machine (full test)

```bat
cd C:\path\to\InfiniBot-fresh
pnpm build
node scripts\federation-windows-selftest.mjs
```

With a custom gateway port (e.g. CLI mode on 18789):

```bat
node scripts\federation-windows-selftest.mjs --port 18789
```

### On Linux / macOS (dry-run — CI-safe)

Skips OS-level platform checks; exercises federation round-trips against any
peer that is currently connected.

```sh
node scripts/federation-windows-selftest.mjs --dry-run
```

### Cross-platform CI (picks the right script automatically)

```sh
node scripts/federation-selftest-runner.mjs
```

Pass `--dry-run` on Linux/macOS runners where no gateway is available to
skip the connectivity sections and only validate the script parses/loads.

---

## What each check means

### 1 / Platform Checks (Windows only, skipped in `--dry-run`)

| Check | What it tests | Fix |
|---|---|---|
| **Firewall inbound rule** | A TCP inbound rule exists for the gateway port (`netsh`). Without it, remote peers cannot initiate connections to the Desktop gateway. | `netsh advfirewall firewall add rule name="InfiniBot Gateway" protocol=TCP dir=in localport=47913 action=allow` |
| **LongPathsEnabled** | Registry flag is set so Node can read/write paths longer than 260 characters. Required for federation code-sync and workspace paths. | `reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f` — then reboot. |
| **Named-pipe IPC** | Always passes on Windows — native named pipes are available on all supported versions. Informational only. | N/A |
| **Defender exclusion** | *(Non-blocking warning.)* Whether Windows Defender excludes the repo directory. No exclusion degrades spawn latency. | `Add-MpPreference -ExclusionPath "C:\path\to\InfiniBot-fresh"` (elevated PowerShell) |

### 2 / Gateway Connectivity

Probes `http://127.0.0.1:<port>/api/status`. If this fails, the gateway is
not running or is listening on a different port.  Pass `--port` to override.

### 3 / Federation Peer Discovery

Calls `federation.selftest` in ping mode to discover the local node ID and
connected peers.  The harness needs **at least one connected satellite** to
run round-trip tests.

If `masterId` is `null` or `undefined`, this node is running in standalone
mode (federation not configured).  Check `~/.infinibot/infinibot.json` for
`federation.mode`.

### 4 / Bidirectional Spawn Invariant

| Direction | Path | What it proves |
|---|---|---|
| **OUTBOUND** (→ peer) | Windows gateway → master hub → peer gateway | Windows can originate cross-node spawns via its outbound WS connection |
| **INBOUND** (peer →) | peer gateway → master hub → Windows gateway | Windows receives spawns via the master's multiplexed use of the same outbound WS — **no inbound port required** |

Both legs invoke `sessions.list` on the target node (a read-only no-op) and
expect a successful response.  A failure on either leg indicates the
multiplexed bidirectional WS is not wired correctly for this node pair.

---

## Interpreting failures

### OUTBOUND fails

```
OUTBOUND  (→ peer-b)  FAIL  peer-b not connected
```

The master hub cannot reach `peer-b`.  Check:
- Is the peer's gateway running?
- Is the peer visible under `federation.peers.list` in the master's dashboard?
- Is the `federation.mode` set to `master` on the master node?

### INBOUND fails

```
INBOUND   (peer-b → local)  FAIL  ...
```

The master cannot route a call back to this Windows node.  The most common
causes:

1. **NodeId mismatch** — the node ID shown in `--dry-run` does not match what
   the master's hub recorded for this satellite.  Re-connect the satellite
   (restart its gateway) to re-register.

2. **Outbound WS disconnected** — the satellite's outbound connection to
   master dropped.  Check the gateway log for `federation reconnect` lines.
   Enable verbose logging: `INFINIBOT_WINDOWS_HARDENED_MODE=1 pnpm start`.

3. **Firewall blocks the outbound WS** — less common since it's outbound, but
   some corporate policies block WebSocket upgrades.  Confirm via
   `netsh advfirewall monitor show currentprofile`.

### No peers found

```
Peers reachable  FAIL  0 peers
```

Federation is configured but no satellites are connected.  The round-trip
tests are skipped automatically.  Ensure at least one other InfiniBot node
is running and pointed at this master's gateway URL.

---

## Windows-hardened-mode

When InfiniBot Desktop starts on Windows, it writes
`~/.infinibot/windows-hardened-mode.json` and sets
`INFINIBOT_WINDOWS_HARDENED_MODE=1` in the gateway's environment.  The
gateway uses this flag to enable:

- Verbose logging on federation reconnect cycles
- Named-pipe IPC preference over loopback TCP

You can also set this manually for a CLI gateway:

```bat
set INFINIBOT_WINDOWS_HARDENED_MODE=1
pnpm start
```

---

## Running as part of a CI pipeline

```yaml
# GitHub Actions example (Windows runner)
- name: Federation Windows self-test
  run: |
    pnpm build
    Start-Process -NoNewWindow pnpm -ArgumentList "start" -PassThru
    Start-Sleep -Seconds 10  # wait for gateway
    node scripts/federation-selftest-runner.mjs
```

On a Linux runner, pass `--dry-run` to skip platform checks:

```yaml
- name: Federation round-trip (dry-run)
  run: node scripts/federation-selftest-runner.mjs --dry-run
```
