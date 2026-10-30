---
summary: "CLI reference for `infinibot doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
---

# `infinibot doctor`

Health checks + quick fixes for the gateway and channels.

Related:
- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Examples

```bash
infinibot doctor
infinibot doctor --repair
infinibot doctor --deep
```

Notes:
- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- `--fix` (alias for `--repair`) writes a backup to `~/.infinibot/infinibot.json.bak` and drops unknown config keys, listing each removal.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv INFINIBOT_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent “unauthorized” errors.

```bash
launchctl getenv INFINIBOT_GATEWAY_TOKEN
launchctl getenv INFINIBOT_GATEWAY_PASSWORD

launchctl unsetenv INFINIBOT_GATEWAY_TOKEN
launchctl unsetenv INFINIBOT_GATEWAY_PASSWORD
```
