# Federation Coder Setup

This guide covers how to configure and verify that coder sub-agents (`coder-claude`, `coder-codex`, `coder-opencode`) run correctly on satellite nodes when spawned from a master gateway via `sessions_spawn`.

## Background

InfiniBot's federation lets a master node dispatch agent work to satellite nodes.
When you call `sessions_spawn` with `node: "<satellite-id>"` and `agentId: "coder-claude"`, the request flows:

```
Master MCP tool
  → federation.node.invoke (hub)
    → session.spawn WS message → satellite
      → satellite session:spawn:request handler
        → sessions.spawn local gateway
          → terminal.spawnAgent (CLI)
            → PTY: claude --print --output-format stream-json ...
```

For this to work, **the satellite must have the relevant CLI binary installed and on the PATH the InfiniBot gateway sees at startup**.

---

## Requirements on the satellite host

### 1. Install the CLI tool

| Agent ID | Binary | Install |
|---|---|---|
| `coder-claude` | `claude` | `npm install -g @anthropic-ai/claude-code` |
| `coder-codex` | `codex` | `npm install -g @openai/codex` |
| `coder-opencode` | `opencode` | `npm install -g opencode-ai` |

### 2. Authenticate the CLI

```bash
# Claude Code
claude auth login

# Codex — set OPENAI_API_KEY in ~/.profile / ~/.bashrc
export OPENAI_API_KEY="sk-..."

# OpenCode
opencode auth
```

### 3. Ensure the binary is on the gateway's PATH

The InfiniBot gateway inherits `$PATH` from the process that starts it. If you start the gateway via `nohup`, `systemd`, `launchd`, or the menubar app, the PATH is likely minimal (missing `~/.npm-global/bin`, `~/.local/bin`, `~/Library/pnpm`, etc.).

**Verify what the gateway sees:**

```bash
infinibot gateway --satellite  # watch the log — it logs the PATH on start
# or check the binary detection directly:
infinibot setup status          # shows which CLIs are detected
```

**If the binary isn't detected, extend the PATH before starting the gateway:**

```bash
# In ~/.profile or the script that starts the gateway:
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
```

For systemd units, add `Environment=PATH=/home/user/.npm-global/bin:...` to the `[Service]` block.

---

## Verifying a remote spawn works

From the master, use the `sessions_spawn` tool:

```
sessions_spawn {
  task: "echo hello world",
  agentId: "coder-claude",
  node: "<satellite-node-id>"
}
```

Expected: `{ status: "accepted", childSessionKey: "agent:coder-claude:subagent:<uuid>", runId: "...", remote: true }`.

Then check for the session on the satellite:

```
sessions_list { node: "<satellite-node-id>", includeFederated: true }
```

The spawned session should appear with `nodeId = "<satellite-node-id>"` and `agentId = "coder-claude"`.

---

## Common failure modes and their errors

| Symptom | Root cause | Fix |
|---|---|---|
| `sessions_spawn` returns `status: "error"`, error contains `terminal.spawnAgent failed for cli=claude` | `claude` binary not on gateway PATH | Install + add PATH (see above) |
| `sessions_spawn` returns `status: "error"`, error contains `Terminal manager not initialized` | Satellite gateway started without terminal support | Restart satellite gateway (terminals init on startup) |
| `sessions_spawn` returns `status: "accepted"` but `sessions_list` shows 0 sessions | (pre-fix) phantom key bug — upgrade to latest InfiniBot | `npm install -g infinibot@latest` on satellite |
| `sessions_spawn` returns `status: "accepted"` but the session is an agent-loop, not a CLI session | (pre-fix) execution bridge missing — upgrade to latest | `npm install -g infinibot@latest` on satellite |
| `sessions_spawn` returns `status: "error"`, error contains `gateway timeout` | Satellite gateway unreachable / disconnected | Check `infinibot channels status --probe` on satellite |

---

## How agent config drives the execution mode

InfiniBot resolves which execution path to use for each agent via `resolveAgentConfig()`.

For agents seeded by the standard roster (including all `coder-*` agents), the config written by the seeder looks like:

```json
{
  "id": "coder-claude",
  "type": "cli",
  "cliCommand": "claude"
}
```

`resolveAgentConfig()` **synthesises** `execution: { mode: "terminal", cli: "claude" }` from this shape at runtime. If you want to override the CLI used for a specific agent on a satellite, set an explicit `execution` block in `~/.infinibot/infinibot.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "coder-claude",
        "execution": {
          "mode": "terminal",
          "cli": "claude",
          "autoClose": true,
          "autoCloseDelayMs": 3000
        }
      }
    ]
  }
}
```

An explicit `execution` block always wins over the synthesised one.

---

## Checking satellite logs

When a spawn is attempted, the satellite gateway logs structured messages at `[SPAWN]` prefix:

```
INFO  [SPAWN] Received request from master  { correlationId, agentId, label }
INFO  [SPAWN] Calling local gateway         { method: "sessions.spawn", agentId }
INFO  [SPAWN] Local gateway accepted        { sessionKey, actualRunId }
INFO  [SPAWN] Sending success result to master
```

On failure:

```
ERROR [SPAWN] Failed to spawn remote session  { error, stack, agentId }
```

Access the satellite logs via the gateway log file (default `/tmp/infinibot-gateway.log`) or `journalctl -u infinibot-gateway`.

---

## Federation nodeId churn

When the satellite reconnects, it gets a new ephemeral nodeId (e.g. `node_mqtx2frp_...` → `node_mquqauqi_...`). This is expected — nodeIds are session-scoped. Use `federation.nodes.list` to get the current nodeId before spawning:

```
federation.nodes.list {}
# → { nodes: [{ nodeId: "node_xyz123_abc", displayName: "My-Host-01", connected: true }] }
```

Then use that `nodeId` in `sessions_spawn { node: "node_xyz123_abc" }`.

To get a stable reference by hostname, look for the node with `displayName` matching your satellite's hostname.
