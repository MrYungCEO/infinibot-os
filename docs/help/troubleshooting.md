---
summary: "Troubleshooting hub: symptoms → checks → fixes"
read_when:
  - You see an error and want the fix path
  - The installer says “success” but the CLI doesn’t work
---

# Troubleshooting

## Video: common issues and fixes

The setup guide has a chapter on the most common problems: 401/402/429 key and credit errors, "model not found", a gateway that isn't running or a busy port 18789, old Node, "command not found", "unauthorized" in the control panel, microphone access and the Windows blue screen. [Play it from Common issues (5:10)](/docs/troubleshooting/?t=310#setup-guide), or pick a chapter below.

<!--setup-guide:player compact-->

## First 60 seconds

Run these in order:

```bash
infinibot status
infinibot status --all
infinibot gateway probe
infinibot logs --follow
infinibot doctor
```

If the gateway is reachable, deep probes:

```bash
infinibot status --deep
```

## Common “it broke” cases

### `infinibot: command not found`

Almost always a Node/npm PATH issue. Start here:

- [Install (Node/npm PATH sanity)](/install#troubleshooting-infinibot-not-found)

### Installer fails (or you need full logs)

The one-line installer just runs `npm install --global infinibot` and then `infinibot quickstart`. To see the full npm output, run the install step yourself:

```bash
npm install --global infinibot --loglevel verbose
```

The desktop app doesn't need Node.js or npm. If the terminal route keeps failing, [download the desktop app](/download) instead.

### Gateway “unauthorized”, can’t connect, or keeps reconnecting

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Gateway authentication](/gateway/authentication)

### Control UI fails on HTTP (device identity required)

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Control UI](/web/control-ui#insecure-http)

### Service says running, but RPC probe fails

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Background process / service](/gateway/background-process)

### Model/auth failures (rate limit, billing, “all models failed”)

- [Models](/cli/models)
- [OAuth / auth concepts](/concepts/oauth)

### `/model` says `model not allowed`

This usually means `agents.defaults.models` is configured as an allowlist. When it’s non-empty,
only those provider/model keys can be selected.

- Check the allowlist: `infinibot config get agents.defaults.models`
- Add the model you want (or clear the allowlist) and retry `/model`
- Use `/models` to browse the allowed providers/models

### When filing an issue

Paste a safe report:

```bash
infinibot status --all
```

If you can, include the relevant log tail from `infinibot logs --follow`.
