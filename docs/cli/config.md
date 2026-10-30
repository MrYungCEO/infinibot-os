---
summary: "CLI reference for `infinibot config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
---

# `infinibot config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `infinibot configure`).

## Examples

```bash
infinibot config get browser.executablePath
infinibot config set browser.executablePath "/usr/bin/google-chrome"
infinibot config set agents.defaults.heartbeat.every "2h"
infinibot config set agents.list[0].tools.exec.node "node-id-or-name"
infinibot config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
infinibot config get agents.defaults.workspace
infinibot config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
infinibot config get agents.list
infinibot config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
infinibot config set agents.defaults.heartbeat.every "0m"
infinibot config set gateway.port 19001 --json
infinibot config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
