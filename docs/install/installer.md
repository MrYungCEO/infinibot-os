---
summary: "How the installer scripts work (install.sh + install.ps1), their flags, and where they are hosted"
read_when:
  - You want to understand `infinibotos.com/install.sh`
  - You want to automate installs (CI / headless)
  - You are deploying or updating the installer scripts
---

# Installer internals

InfiniBot is distributed as the [`infinibot`](https://www.npmjs.com/package/infinibot) npm package. The installer scripts are a convenience wrapper: they make sure Node.js and git are present, install the npm package globally, and launch the setup wizard. They do not clone or build anything.

| Platform | One-liner |
|----------|-----------|
| macOS / Linux / WSL | `curl -fsSL https://infinibotos.com/install.sh \| bash` |
| Windows (PowerShell) | `iwr -useb https://infinibotos.com/install.ps1 \| iex` |
| Any OS with Node 22.12+ and git | `npm i -g infinibot && infinibot onboard` |
| Try without installing | `npx -y infinibot@latest onboard` |

## install.sh (macOS / Linux / WSL)

What it does:

1. Detects the OS and, on Linux, the distro.
2. Ensures **Node.js 22.12+**. Homebrew on macOS (nvm when Homebrew is absent), NodeSource on Debian/Ubuntu and Fedora/RHEL, pacman on Arch, nvm elsewhere or when there is no root access.
3. Ensures **git** (see [Why git is needed](#why-git-is-needed)).
4. If npm's global prefix is not writable by you, switches it to `~/.npm-global` and adds that to `PATH` in `~/.zshrc`, `~/.bashrc` and `~/.profile` (whichever exist). It never runs `sudo npm`.
5. Runs `npm install -g infinibot@latest`.
6. Runs `infinibot onboard --install-daemon`, reading the keyboard from your terminal even though the script itself arrives on stdin. With no terminal at all (CI, `docker build`) it skips the wizard and prints the command to run later.

It never reads, moves or deletes `~/.infinibot` (config, sessions, credentials) or your workspace.

Flags (pass them after `bash -s --`) and the matching environment variables:

| Flag | Environment variable | Effect |
|------|----------------------|--------|
| `--no-onboard` | `INFINIBOT_NO_ONBOARD=1` | Install only; skip the wizard |
| `--version <v>` | `INFINIBOT_VERSION=<v>` | Install a specific version or dist-tag (default `latest`) |
| `--dry-run` | `INFINIBOT_DRY_RUN=1` | Print what would run; change nothing |
| `--help` | | Show usage |
| | `INFINIBOT_NPM_SPEC=<spec>` | Install this npm spec instead (tarball path or URL); used by release smoke tests |

```bash
# Headless / CI
curl -fsSL https://infinibotos.com/install.sh | bash -s -- --no-onboard

# Pin a version
curl -fsSL https://infinibotos.com/install.sh | bash -s -- --version 2026.10.0

# See every command without running it
curl -fsSL https://infinibotos.com/install.sh | bash -s -- --dry-run

# Trace the installer when something goes wrong
curl -fsSL https://infinibotos.com/install.sh | bash -x
```

`sharp` is installed with `SHARP_IGNORE_GLOBAL_LIBVIPS=1` so it uses its prebuilt binaries instead of building against a system libvips.

## install.ps1 (Windows PowerShell)

Works in Windows PowerShell 5.1 and PowerShell 7.

1. Ensures **Node.js 22.12+** and **Git** using winget, then Chocolatey, then Scoop. If none of those exist it stops and links the official installers.
2. Runs `npm install -g infinibot@latest`.
3. Adds npm's global directory to your user `PATH` if it is missing.
4. Runs `infinibot onboard --install-daemon`.

```powershell
iwr -useb https://infinibotos.com/install.ps1 | iex
```

Options are parameters when you invoke the script block, or environment variables when you pipe into `iex`:

```powershell
# Install only, no wizard
& ([scriptblock]::Create((iwr -useb https://infinibotos.com/install.ps1))) -NoOnboard

# Same, with environment variables
$env:INFINIBOT_NO_ONBOARD = "1"; iwr -useb https://infinibotos.com/install.ps1 | iex

# Pin a version / preview only
& ([scriptblock]::Create((iwr -useb https://infinibotos.com/install.ps1))) -Version 2026.10.0
& ([scriptblock]::Create((iwr -useb https://infinibotos.com/install.ps1))) -DryRun
```

Common Windows issues:

- **`npm error spawn git ENOENT`**: Git is missing. Install [Git for Windows](https://git-scm.com/download/win), open a new PowerShell window, and re-run.
- **`infinibot` is not recognized**: npm's global directory is not on `PATH`. Run `npm config get prefix`, add that directory to your user `PATH`, and open a new window.

## Why git is needed

`npm install -g infinibot` shells out to git because one transitive dependency (`libsignal`, pulled in by the WhatsApp library) is published as a GitHub reference instead of a registry tarball. Without git on `PATH` npm fails with `spawn git ENOENT`. Both installers install git for you; if you use plain `npm i -g infinibot`, install git first.

## Why npm hits `EACCES` on Linux

When Node comes from a system package (apt, dnf, NodeSource), npm's global prefix is root-owned and `npm install -g` fails with `EACCES`. `install.sh` switches the prefix to `~/.npm-global`. To do the same by hand, see [Node.js + npm](/install/node).

## Where the scripts are hosted

There is one source of truth and three served copies:

| File | Served at | How it gets there |
|------|-----------|-------------------|
| `scripts/install-infinibot.sh`, `scripts/install-infinibot.ps1` | every running gateway at `/install.sh` and `/install.ps1` | shipped inside the npm package |
| `docs/install.sh`, `docs/install.ps1` | `https://infinibotos.com/install.sh` and `/install.ps1` | Netlify site `infinibot-landing`, publish dir `docs/` |
| `install-scripts-static/install.sh`, `install.ps1` | optional standalone static host | manual deploy; see `install-scripts-static/README.md` |

Edit only the files in `scripts/`, then copy them out:

```bash
pnpm install-scripts:sync     # copy scripts/install-infinibot.* to docs/ and install-scripts-static/
pnpm install-scripts:check    # fail if a copy drifted (also part of pnpm release:check)
```

Publishing the copies on infinibotos.com is a landing deploy (no build step):

```bash
cd docs
netlify status                # confirm which site this directory is linked to
netlify deploy --prod --no-build --dir . --site <infinibot-landing site id>
curl -fsSL https://infinibotos.com/install.sh | head -n 12     # verify what is live
curl -fsSI https://infinibotos.com/install.ps1 | grep -i content-type
```

`docs/netlify.toml` serves both files as `text/plain; charset=utf-8` with a five-minute cache, so a fix reaches users quickly. The content type is required, not cosmetic: PowerShell 7 hands `iex` a byte array instead of text when `install.ps1` arrives as `application/octet-stream`, and the one-liner fails. Any other host for these files must send a text content type too.
