# Security Policy

InfiniBot runs AI agents that can read files, run shell commands and send
messages on your behalf, so we take security reports seriously. Thank you for
helping keep users safe.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, discussions or
pull requests.**

Report privately through **GitHub private vulnerability reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
<!-- OWNER: confirm the repo URL, and enable "Private vulnerability reporting" under Settings → Code security. -->
Direct link: <https://github.com/MrYungCEO/infinibot-os/security/advisories/new>

If you can't use GitHub, email <!-- OWNER: set security contact -->`SECURITY_CONTACT_EMAIL`.

Please include:

- The affected version (`infinibot --version`) or commit.
- Your platform and how InfiniBot is installed.
- Steps to reproduce, and a minimal proof of concept if possible.
- The impact: what an attacker can do, and what access they need first.

### What to expect

<!-- OWNER: adjust these targets to what you can actually commit to. -->
- We aim to acknowledge reports within **3 business days**.
- We'll keep you updated while we investigate and fix the issue.
- We'll coordinate a disclosure date with you and credit you in the advisory
  unless you'd rather stay anonymous.

## Supported versions

InfiniBot is released continuously. Security fixes go into the **latest
release** only. Please upgrade before reporting, and check whether the issue
still reproduces on `main`.

## Scope

In scope:

- The gateway (`infinibot gateway`) and its HTTP/WebSocket endpoints.
- The Control UI, CLI, bundled plugins (`extensions/`) and bundled skills.
- The desktop, mobile and native node apps in this repository.

Out of scope:

- Findings that need an attacker who already controls your machine, your
  InfiniBot state directory (`~/.infinibot`) or your gateway password.
- Actions an agent takes because you allowed them in its tool policy (for
  example, host shell access you turned on). Unsafe *defaults*, or ways to get
  around a policy, are in scope.
- Prompt injection that only produces text and doesn't get around a tool
  policy, approval gate or sandbox.
- Vulnerabilities in third-party model providers, channels or MCP servers.
  Please report those to the vendor.

## Hardening guidance

The web interface and gateway are meant for **local or private-network use**.
Don't expose the gateway port to the public internet. For remote access, use a
private network such as Tailscale or an authenticated reverse proxy, and always
set a strong gateway password.

Run the built-in audit to find risky settings:

```bash
infinibot security audit          # config review
infinibot security audit --deep   # also probes the running gateway
```

The threat model and hardening guide are in
[docs/gateway/security](docs/gateway/security/index.md).

## Runtime requirements

InfiniBot requires **Node.js 22.12.0 or later**, which includes fixes for:

- CVE-2025-59466: async_hooks DoS vulnerability
- CVE-2026-21636: permission model bypass vulnerability

```bash
node --version  # v22.12.0 or later
```

## Docker

No official container image is published yet. If you build one from the
`Dockerfile` in this repo:

1. It runs as the non-root `node` user. Keep it that way.
2. Use `--read-only` where you can, with a volume for state.
3. Drop capabilities with `--cap-drop=ALL`.

```bash
docker build -t infinibot:local .
docker run --read-only --cap-drop=ALL \
  -v infinibot-data:/home/node/.infinibot \
  infinibot:local
```

## Secret scanning

This project uses `detect-secrets` to catch committed credentials. The config
is in `.detect-secrets.cfg` and the baseline in `.secrets.baseline`.

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```
