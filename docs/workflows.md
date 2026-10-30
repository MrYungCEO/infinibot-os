---
title: Workflows
description: Standardized, runnable agent procedures — typed inputs, preflight requirements, and dedicated agent spawn.
---

# Workflows

A workflow is a **markdown document** that an agent runs as a unit of work. Beyond the prose body, the YAML frontmatter declares:

- **Typed dynamic inputs** the user fills in at run time (`inputs[]`).
- **Required capabilities** the runner verifies before the workflow is allowed to start (`requires[]`).
- **The agent + model** that should run it.

When a user clicks **Run**, InfiniBot:

1. Validates the supplied inputs against the schema.
2. Runs preflight against `requires[]` — checks the listed tools/MCP servers/env vars/channels/federation nodes are actually present and connected.
3. Interpolates the validated inputs into the body using `{{name}}` placeholders.
4. **Spawns a dedicated agent session** (via the same `sessions.spawn` pipeline that drives sub-agent dispatch), labelled `workflow:<id>`.
5. Returns a `runId` you can poll, cancel, or watch in the activity feed.

Every run is recorded so you can see what ran, when, what inputs it got, and whether the preflight produced warnings.

## Anatomy of a workflow

```markdown
---
id: weekly-digest
name: Send weekly stats digest
description: Pull the week's metrics and email them out
tags: [ops, weekly]
agent: main
timeoutSeconds: 600
inputs:
  - name: to
    label: Recipient email
    type: email
    required: true
    description: Where to send the digest
  - name: include_charts
    label: Include chart images?
    type: boolean
    default: true
  - name: format
    type: select
    options:
      - value: short
        label: Short summary
      - value: full
        label: Full report
    default: short
requires:
  - kind: env
    name: SENDGRID_API_KEY
    reason: Needed to send the email
  - kind: tool
    name: stats.fetch
  - kind: mcp
    name: filesystem
    optional: true
---

# Weekly Stats Digest

Pull this week's stats from the dashboard and send a `{{format}}` email to `{{to}}`.

If `{{include_charts}}` is true, attach the chart PNGs from the most recent
report folder.

Use the `stats.fetch` tool, then format the output as a digest, then call
the `email.send` tool with the formatted body.
```

## Inputs

The `inputs[]` array declares each value the runner collects from the user before starting. Supported types:

| Type | UI control | Notes |
|---|---|---|
| `string` | Single-line text | `pattern` regex, `placeholder` |
| `text` | Multi-line text | Same options as `string` |
| `number` | Number input | `min` / `max` bounds |
| `boolean` | Toggle | Accepts string forms `true/false/yes/no/1/0` |
| `select` | Dropdown | Requires `options[]` |
| `multiSelect` | Multi-tag picker | Requires `options[]` |
| `url` | Text + URL parse | Rejects malformed URLs |
| `email` | Text + email shape check | |
| `date` | Date picker | ISO-8601 string |

Each input may have:

- `required: true` — empty/missing values fail preflight with a clear error.
- `default: …` — used when the field is left blank.
- `description` / `label` — surfaced in the run dialog.

Validated values are interpolated into the body via `{{name}}`. The runner also prepends a `<inputs>` JSON block to the task so models that don't understand templating still see the values verbatim — useful for tool-calling models that want to reference the raw payload.

Unknown placeholders (e.g. `{{not_in_schema}}`) are **left in the text** rather than silently emptied, so the agent can flag them or you can spot the mistake.

## Required capabilities — preflight

`requires[]` is a list of things that have to be true before the workflow can run. Currently supported:

| Kind | Checked against | Use it when |
|---|---|---|
| `env` | `process.env[name]` is set + non-empty | API keys, secrets, config |
| `tool` | `agent.tools.list` returns this id | Agent tool dependencies |
| `mcp` | `mcp.list` shows the server with `status: connected/ready` | MCP-backed integrations |
| `channel` | `channels.capabilities` shows the channel + `enabled: true` | Outbound posting (Telegram, Slack…) |
| `node` | `federation.nodes.list` shows the node online | Cross-machine work |
| `model` | `models.list` includes this model id | Model-specific prompts |

Each requirement may also set `optional: true` — failures become **warnings** instead of hard errors, surfaced in the dialog but not blocking the run.

The preflight result the runner returns is structured:

```ts
{
  ok: boolean,                    // true only if zero "error"-severity issues
  issues: [
    {
      severity: "error" | "warning",
      requirement: { kind, name, reason?, optional? },
      detail: "env var SENDGRID_API_KEY is not set",
    },
    …
  ],
  resolvedInputs: { ... },        // validated + defaulted form values
  interpolatedBody: "..."         // body with {{}} resolved (only when ok)
}
```

The UI shows the issue list so the user knows exactly what to fix before they retry.

## Run pipeline

When the user clicks Start (or an agent calls `workflows.run.start`):

1. **`workflows.run.preflight`** runs implicitly — validates inputs + checks requirements. If anything errors, the run is recorded with `status: "failed"` and the issue list, no agent is spawned.
2. **`sessions.spawn`** is called with:
   - `task` = the interpolated body (with `<inputs>` JSON prefix)
   - `agentId` = the workflow's `agent` (defaults to `main`)
   - `label` = `workflow:<workflow-id>`
   - `model` = override or workflow default
   - `runTimeoutSeconds` = override or workflow default (600s)
3. The spawned session shows up in the activity feed like any other agent session, but tagged with the `workflow:<id>` label so you can tell which run produced it.
4. The runner stores a `WorkflowRun` record:

```ts
{
  id: "wfr_abc...",
  workflowId: "weekly-digest",
  workflowName: "Send weekly stats digest",
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout",
  inputs: { to: "x@y.com", include_charts: true, format: "short" },
  sessionKey: "agent:main:subagent:...",
  agent: "main",
  startedAt: "2026-05-01T12:00:00Z",
  finishedAt?: "...",
  error?: "...",
  preflight: { ok, issues, resolvedInputs }
}
```

## Gateway methods

All on the gateway WS:

- `workflows.list` / `workflows.get` / `workflows.create` / `workflows.update` / `workflows.delete` — same CRUD as before; now supports the new fields in the create/update payload.
- **`workflows.run.preflight { id, inputs }`** — dry-run validation + requirement check. Returns the preflight result without spawning anything. Useful for the run-dialog UI to show issues live as the user fills the form.
- **`workflows.run.start { id, inputs, agentId?, model?, timeoutSeconds? }`** — runs the full pipeline. Returns `{ run, preflight }`.
- `workflows.run.list { workflowId?, limit? }` — recent runs, newest first.
- `workflows.run.get { runId }` — full record.
- `workflows.run.cancel { runId }` — marks a pending/running run as cancelled. (Kills the spawned agent run by aborting the underlying chat run if it's still in flight.)

## Where runs live

- Workflow `.md` files: `state/workflows/<id>.md`
- Run history: `state/workflows/runs.json` (capped at 500 rows; for serious history we'll switch to SQLite)

The single-file run history is intentionally simple — backups are a `cp`, migration between machines is the same.

## Patterns

### "Triage my inbox"

```yaml
inputs:
  - name: time_window
    type: select
    options: [{ value: "24h" }, { value: "7d" }, { value: "30d" }]
    default: "24h"
requires:
  - kind: env
    name: GMAIL_REFRESH_TOKEN
  - kind: tool
    name: gmail.list
```

Body uses `{{time_window}}` to scope the fetch. Preflight blocks if Gmail isn't connected.

### "Spin up a project"

```yaml
inputs:
  - name: project_name
    type: string
    required: true
    pattern: "^[A-Za-z0-9_ -]+$"
  - name: stack
    type: select
    options:
      - { value: ts-node, label: "TypeScript / Node" }
      - { value: py, label: "Python" }
      - { value: rust, label: "Rust" }
requires:
  - kind: tool
    name: filesystem.write
  - kind: tool
    name: shell.run
```

### "Ship a release"

```yaml
agent: coder
timeoutSeconds: 1800
inputs:
  - name: bump
    type: select
    options:
      - { value: patch }
      - { value: minor }
      - { value: major }
    default: patch
  - name: dry_run
    type: boolean
    default: true
requires:
  - kind: env
    name: NPM_TOKEN
  - kind: env
    name: GITHUB_TOKEN
  - kind: tool
    name: shell.run
  - kind: tool
    name: github.release.create
```

### "Run on a satellite"

```yaml
inputs:
  - name: target_node
    type: select
    options:
      - { value: home-server, label: "Home server (GPU)" }
      - { value: macbook, label: "MacBook" }
requires:
  - kind: node
    name: home-server
    optional: true
```

The runner currently spawns the agent on the master; pair this with an explicit `federation.node.invoke` call from inside the body to actually execute on the chosen node. (A `node:` field on the workflow that auto-routes the spawn is on the roadmap.)

## TL;DR

- Workflows are **runnable agent procedures**, not just text.
- They declare **typed inputs** (validated, defaulted, regex/email/url-checked).
- They declare **required capabilities** (env / tool / MCP / channel / node / model) that are **verified before the agent is spawned**.
- The runner spawns a **dedicated agent session** the same way sub-agent dispatch works — visible in the activity feed, cancellable, time-limited.
- Run history is persisted; you can see what ran, with what inputs, and what preflight said.
