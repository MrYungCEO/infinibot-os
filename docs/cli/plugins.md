---
summary: "CLI reference for `infinibot plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
---

# `infinibot plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:
- Plugin system: [Plugins](/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
infinibot plugins list
infinibot plugins info <id>
infinibot plugins enable <id>
infinibot plugins disable <id>
infinibot plugins doctor
infinibot plugins update <id>
infinibot plugins update --all
```

Bundled plugins ship with InfiniBot but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `infinibot.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
infinibot plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
infinibot plugins install -l ./my-plugin
```

### Update

```bash
infinibot plugins update <id>
infinibot plugins update --all
infinibot plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).
