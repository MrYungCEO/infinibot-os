# InfiniBot CLI Reference

Complete command reference for full Infinibot control.

## Quick Start

```bash
# Initial setup
infinibot setup                    # Initialize config
infinibot onboard                  # Interactive wizard

# Start gateway
infinibot gateway run             # Run in foreground
infinibot gateway install         # Install as service
infinibot gateway start           # Start service

# Open UI
infinibot ui open                 # Open Control UI
infinibot ui open --onboarding    # Sovereign onboarding flow
```

---

## Setup & Onboarding

### `infinibot setup`
Initialize `~/.infinibot/infinibot.json` and agent workspace.

### `infinibot onboard`
Interactive wizard for complete setup.

```bash
# Quick start
infinibot onboard

# Non-interactive with API key
infinibot onboard --non-interactive --accept-risk \
  --anthropic-api-key sk-xxx \
  --install-daemon

# Advanced options
infinibot onboard \
  --workspace ~/my-agent \
  --flow advanced \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --gateway-auth token \
  --gateway-token my-secret \
  --install-daemon \
  --daemon-runtime node
```

**Options:**
| Flag | Description |
|------|-------------|
| `--workspace <dir>` | Agent workspace directory |
| `--non-interactive` | No prompts (requires `--accept-risk`) |
| `--flow <type>` | quickstart / advanced / manual |
| `--mode <type>` | local / remote |
| `--reset` | Reset all config before setup |
| `--auth-choice <choice>` | Auth method (see below) |
| `--anthropic-api-key <key>` | Anthropic API key |
| `--openai-api-key <key>` | OpenAI API key |
| `--openrouter-api-key <key>` | OpenRouter API key |
| `--gemini-api-key <key>` | Gemini API key |
| `--gateway-port <port>` | Gateway port (default: 18789) |
| `--gateway-bind <mode>` | loopback / lan / tailnet / auto |
| `--gateway-auth <mode>` | token / password |
| `--gateway-token <token>` | Auth token |
| `--gateway-password <pass>` | Auth password |
| `--tailscale <mode>` | off / serve / funnel |
| `--install-daemon` | Install gateway service |
| `--skip-daemon` | Skip service install |
| `--daemon-runtime <rt>` | node / bun |
| `--skip-channels` | Skip channel setup |
| `--skip-skills` | Skip skills setup |
| `--skip-health` | Skip health check |
| `--json` | Output JSON summary |

**Auth choices:** `setup-token`, `token`, `openai-api-key`, `openrouter-api-key`, `anthropic-api-key`, `gemini-api-key`, `skip`

### `infinibot configure`
Interactive credentials and device setup.

### `infinibot config`
Config get/set/unset helpers.

```bash
infinibot config get gateway.port
infinibot config set gateway.port 18789
infinibot config unset gateway.tailscale
```

---

## Gateway Control

### `infinibot gateway run`
Run gateway in foreground.

```bash
# Basic
infinibot gateway run

# With options
infinibot gateway run \
  --port 18789 \
  --bind loopback \
  --token my-secret \
  --verbose \
  --force

# Dev mode (isolated state)
infinibot --dev gateway run
infinibot gateway run --dev --reset
```

**Options:**
| Flag | Description |
|------|-------------|
| `--port <port>` | Gateway port |
| `--bind <mode>` | loopback / lan / tailnet / auto / custom |
| `--token <token>` | Auth token |
| `--auth <mode>` | token / password |
| `--password <pass>` | Auth password |
| `--tailscale <mode>` | off / serve / funnel |
| `--tailscale-reset-on-exit` | Reset tailscale on shutdown |
| `--allow-unconfigured` | Start without gateway.mode=local |
| `--dev` | Create dev config if missing |
| `--reset` | Reset dev state (requires --dev) |
| `--force` | Kill existing listener first |
| `--verbose` | Verbose logging |
| `--claude-cli-logs` | Only show claude-cli logs |
| `--ws-log <style>` | auto / full / compact |
| `--compact` | Alias for --ws-log compact |
| `--raw-stream` | Log raw stream events |

### Service Management

```bash
infinibot gateway status          # Show status + probe
infinibot gateway install         # Install as service
infinibot gateway uninstall       # Remove service
infinibot gateway start           # Start service
infinibot gateway stop            # Stop service
infinibot gateway restart         # Restart service
```

**Install options:**
```bash
infinibot gateway install \
  --port 18789 \
  --runtime node \
  --token my-secret \
  --force
```

### Gateway Utilities

```bash
# Call gateway method
infinibot gateway call health
infinibot gateway call status
infinibot gateway call cron.list
infinibot gateway call agent.run --params '{"message":"hello"}'

# Usage cost
infinibot gateway usage-cost --days 30

# Health check
infinibot gateway health

# Full probe (reachability + discovery + health)
infinibot gateway probe
infinibot gateway probe --url ws://remote:18789 --token xxx

# Discover gateways via Bonjour
infinibot gateway discover
```

### Watchdog

```bash
# Auto-restart on crash
infinibot watchdog
```

---

## UI Control

### `infinibot ui`

```bash
# Open Control UI in browser
infinibot ui open

# Open sovereign onboarding
infinibot ui open --onboarding

# Show UI URL
infinibot ui status
infinibot ui status --json

# Dev server
infinibot ui serve --port 5173
```

### `infinibot dashboard`
Open Control UI with current token (alias).

---

## Agent Control

### `infinibot agent`
Run agent turn via Gateway.

```bash
# Basic
infinibot agent --to +1555123456 --message "Hello"

# With options
infinibot agent \
  --agent main \
  --message "Run report" \
  --thinking medium \
  --deliver \
  --reply-channel telegram \
  --reply-to @mychat

# Local (no gateway)
infinibot agent --local --message "Hello"
```

**Options:**
| Flag | Description |
|------|-------------|
| `--to <target>` | Session target (phone/email/id) |
| `--message <msg>` | Message to send |
| `--session-id <id>` | Existing session |
| `--agent <id>` | Agent id |
| `--thinking <level>` | off / minimal / low / medium / high |
| `--verbose <on\|off>` | Session verbose level |
| `--channel <ch>` | Delivery channel |
| `--deliver` | Send reply to channel |
| `--reply-to <target>` | Delivery target override |
| `--reply-channel <ch>` | Delivery channel override |
| `--local` | Run embedded (no gateway) |
| `--timeout <sec>` | Command timeout |
| `--json` | JSON output |

### `infinibot agents`
Manage isolated agents.

```bash
infinibot agents list
infinibot agents list --bindings
```

### `infinibot sessions`
List conversation sessions.

```bash
infinibot sessions
infinibot sessions --store file
infinibot sessions --active 24h
infinibot sessions --json
```

---

## Task Management

### `infinibot kanban`

```bash
# List tasks
infinibot kanban tasks
infinibot kanban tasks --status in_progress
infinibot kanban tasks --project proj-123

# Create task
infinibot kanban task:create \
  --title "Build feature" \
  --description "Details..." \
  --project proj-123 \
  --priority high \
  --assignee main

# Update task
infinibot kanban task:update \
  --id task-123 \
  --status done

# Projects
infinibot kanban projects
infinibot kanban project:create --name "New Project"

# Visual board
infinibot kanban board
infinibot kanban board --project proj-123
```

---

## Knowledge Management

### `infinibot notes`

```bash
infinibot notes list
infinibot notes list --category ideas --pinned
infinibot notes get note-123
infinibot notes create --name "My Note" --body "Content..."
infinibot notes update note-123 --pinned true
infinibot notes delete note-123
infinibot notes search "query"
```

### `infinibot research`

```bash
infinibot research list
infinibot research list --topic "AI" --status active
infinibot research get doc-123
infinibot research create --name "Study" --topic "AI" --status draft
infinibot research update doc-123 --status complete
infinibot research delete doc-123
infinibot research search "query"
```

### `infinibot workflows`

```bash
infinibot workflows list
infinibot workflows get wf-123
infinibot workflows create --name "Deploy" --body "Steps..."
infinibot workflows update wf-123 --tags "deploy,prod"
infinibot workflows delete wf-123
infinibot workflows search "deploy"
infinibot workflows run wf-123 --agent main --context "extra info"
```

### `infinibot memory`

```bash
infinibot memory status
infinibot memory status --agent main --deep
infinibot memory index
infinibot memory search "query"
```

---

## Workspace Management

### `infinibot workspace`

```bash
# Info
infinibot workspace info
infinibot workspace info --agent main

# List files
infinibot workspace list
infinibot workspace list --dir memory --recursive

# Read/write
infinibot workspace read MEMORY.md
infinibot workspace write notes.md --content "My notes"
echo "Content" | infinibot workspace write notes.md
infinibot workspace write log.md --content "Entry" --append

# Delete
infinibot workspace delete temp.md

# Initialize new workspace
infinibot workspace init --path ~/new-agent
infinibot workspace init --template sovereign
```

---

## Budget & Usage

### `infinibot budget`

```bash
# Status
infinibot budget status
infinibot budget status --days 7

# History
infinibot budget history
infinibot budget history --days 30 --provider anthropic

# Routing recommendation
infinibot budget route "Build a REST API"
infinibot budget route "Simple question" --type chat

# Manual recording
infinibot budget record \
  --provider anthropic \
  --model claude-3-opus \
  --cost 0.15 \
  --tokens-in 1000 \
  --tokens-out 500

# Subscriptions
infinibot budget subscriptions

# Set limits
infinibot budget set 50       # $50/month
infinibot budget alert 80     # Alert at 80%
```

---

## Messaging

### `infinibot message`

```bash
# Send
infinibot message send --target +1555123456 --message "Hello"
infinibot message send --channel telegram --target @chat --message "Hi"

# Broadcast
infinibot message broadcast --targets user1,user2 --message "Announcement"
```

### `infinibot channels`

```bash
infinibot channels list
infinibot channels status
infinibot channels status --deep
infinibot channels capabilities
infinibot channels add --channel telegram --token BOT_TOKEN
infinibot channels login --channel whatsapp --verbose
infinibot channels logout --channel whatsapp
infinibot channels remove --channel telegram
```

---

## Scheduling

### `infinibot cron`

```bash
# List jobs
infinibot cron list
infinibot cron status

# Add job
infinibot cron add \
  --name "Daily report" \
  --schedule "0 9 * * *" \
  --payload '{"kind":"systemEvent","text":"Generate report"}'

# Manage
infinibot cron enable job-123
infinibot cron disable job-123
infinibot cron rm job-123

# Run now
infinibot cron run job-123 --force

# History
infinibot cron runs --id job-123 --limit 10
```

### `infinibot system`

```bash
# Events
infinibot system event --text "Custom event"
infinibot system event --text "With heartbeat" --heartbeat

# Heartbeat
infinibot system heartbeat trigger
infinibot system heartbeat status

# Presence
infinibot system presence
```

---

## Node Control

### `infinibot nodes`

```bash
# Status
infinibot nodes status
infinibot nodes describe node-123
infinibot nodes list
infinibot nodes pending

# Pairing
infinibot nodes approve req-123
infinibot nodes reject req-123
infinibot nodes rename node-123 --name "My Mac"

# Actions
infinibot nodes notify --node mac --title "Alert" --body "Message"
infinibot nodes camera --node phone --facing back
infinibot nodes screen --node mac --duration 30s
infinibot nodes location --node phone
infinibot nodes run --node mac --command "ls -la"
infinibot nodes canvas --node mac --action snapshot
```

### `infinibot devices`
Device pairing and token management.

```bash
infinibot devices list
infinibot devices add
infinibot devices remove device-123
```

---

## Infrastructure

### `infinibot models`

```bash
infinibot models list
infinibot models set default claude-3-opus
```

### `infinibot plugins`

```bash
infinibot plugins list
infinibot plugins info plugin-name
infinibot plugins enable plugin-name
infinibot plugins disable plugin-name
infinibot plugins install ./my-plugin
infinibot plugins update
infinibot plugins doctor
```

### `infinibot hooks`

```bash
infinibot hooks list
infinibot hooks info hook-name
infinibot hooks check
infinibot hooks enable hook-name
infinibot hooks disable hook-name
```

### `infinibot skills`

```bash
infinibot skills list
infinibot skills info skill-name
infinibot skills check
```

### `infinibot logs`

```bash
infinibot logs
infinibot logs --tail 100
infinibot logs --level error
```

### `infinibot browser`

```bash
infinibot browser status
infinibot browser start
infinibot browser stop
infinibot browser tabs
```

### `infinibot approvals`
Exec approval management.

### `infinibot security`
Security helpers.

### `infinibot sandbox`
Sandbox tools.

### `infinibot mcp`
Run MCP server.

```bash
infinibot mcp --http-port 8080 --verbose
```

---

## Maintenance

### `infinibot doctor`
Health checks and quick fixes.

### `infinibot reset`
Reset local config/state.

### `infinibot uninstall`
Uninstall gateway service and local data.

### `infinibot update`
CLI update helpers.

---

## Global Options

All commands support:

| Flag | Description |
|------|-------------|
| `--dev` | Use dev profile (isolated state) |
| `--profile <name>` | Use named profile |
| `--no-color` | Disable ANSI colors |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `INFINIBOT_CONFIG_PATH` | Config file path |
| `INFINIBOT_STATE_DIR` | State directory |
| `INFINIBOT_GATEWAY_TOKEN` | Gateway auth token |
| `INFINIBOT_GATEWAY_PASSWORD` | Gateway auth password |
| `INFINIBOT_PROFILE` | Profile name |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |

---

## Examples

### Full Local Setup

```bash
# 1. Run onboarding
infinibot onboard \
  --anthropic-api-key sk-ant-xxx \
  --gateway-port 18789 \
  --install-daemon

# 2. Start gateway service
infinibot gateway start

# 3. Open UI for sovereign onboarding
infinibot ui open --onboarding

# 4. Verify health
infinibot gateway health
infinibot status
```

### Remote Gateway

```bash
# On server
infinibot onboard \
  --gateway-bind lan \
  --gateway-auth token \
  --gateway-token my-secret \
  --install-daemon

# On client
infinibot config set gateway.remote.url ws://server:18789
infinibot config set gateway.remote.token my-secret
infinibot gateway probe --url ws://server:18789 --token my-secret
```

### Quick Agent Interaction

```bash
# One-shot question
infinibot agent --local --message "What is 2+2?"

# With delivery
infinibot agent \
  --to +1555123456 \
  --message "Generate weekly report" \
  --deliver
```

---

**Docs:** https://infinibotos.com/docs/cli
