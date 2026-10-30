<#
.SYNOPSIS
    InfiniBot installer for Windows (PowerShell 5.1+).
.DESCRIPTION
    1. Makes sure Node.js >= 22.12 and Git are available (installs them with winget/choco/scoop
       if missing; npm needs Git for one WhatsApp dependency that is fetched from GitHub).
    2. npm install -g infinibot   (the published npm package; no git clone, no build)
    3. Launches the setup wizard: infinibot onboard --install-daemon

    It never touches %USERPROFILE%\.infinibot (your config, sessions and keys).

    Options can also be set with environment variables when piping into iex:
      -NoOnboard        $env:INFINIBOT_NO_ONBOARD = "1"     install only, skip the wizard
      -Version x.y.z    $env:INFINIBOT_VERSION = "x.y.z"    specific version or dist-tag (default: latest)
      -DryRun           $env:INFINIBOT_DRY_RUN = "1"        print what would run, change nothing
      $env:INFINIBOT_NPM_SPEC                               full npm spec (tarball path/URL) instead of infinibot@<version>
.EXAMPLE
    iwr -useb https://infinibotos.com/install.ps1 | iex
.EXAMPLE
    & ([scriptblock]::Create((iwr -useb https://infinibotos.com/install.ps1))) -NoOnboard
#>

# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes a BOM-less
# script piped into iex with the ANSI code page, which corrupts box-drawing
# characters and emoji and can break parsing.

param(
    [string]$Version = "",
    [switch]$NoOnboard,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Package = "infinibot"
$NodeMinMajor = 22
$NodeMinMinor = 12
$DocsUrl = "https://infinibotos.com/docs/install"

if (-not $Version) { $Version = if ($env:INFINIBOT_VERSION) { $env:INFINIBOT_VERSION } else { "latest" } }
if ($env:INFINIBOT_NO_ONBOARD -eq "1") { $NoOnboard = $true }
if ($env:INFINIBOT_DRY_RUN -eq "1") { $DryRun = $true }
$NpmSpec = if ($env:INFINIBOT_NPM_SPEC) { $env:INFINIBOT_NPM_SPEC } else { "$Package@$Version" }

function Write-Info($Message) { Write-Host "[info] " -ForegroundColor Cyan -NoNewline; Write-Host $Message }
function Write-Ok($Message) { Write-Host "[ ok ] " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn($Message) { Write-Host "[warn] " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Fail($Message) { Write-Host "[fail] " -ForegroundColor Red -NoNewline; Write-Host $Message }
function Write-Step($Message) { Write-Host ""; Write-Host "==> " -ForegroundColor DarkYellow -NoNewline; Write-Host $Message -ForegroundColor White }

function Test-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

# True when the node on PATH satisfies engines (>= 22.12).
function Test-NodeOk {
    if (-not (Test-Command "node")) { return $false }
    $raw = (& node -v) 2>$null
    if ($raw -notmatch '^v(\d+)\.(\d+)\.') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -gt $NodeMinMajor) { return $true }
    return ($major -eq $NodeMinMajor -and $minor -ge $NodeMinMinor)
}

function Install-NodeJS {
    Write-Step "Node.js"

    if (Test-NodeOk) {
        Write-Ok "Node.js $(& node -v) found (need >= $NodeMinMajor.$NodeMinMinor)"
        return
    }
    if (Test-Command "node") {
        Write-Warn "Node.js $(& node -v) is too old (need >= $NodeMinMajor.$NodeMinMinor)"
    } else {
        Write-Info "Node.js not found"
    }

    if ($DryRun) {
        Write-Host "  [dry-run] winget install OpenJS.NodeJS.LTS (or choco / scoop)"
        return
    }

    if (Test-Command "winget") {
        Write-Info "Installing Node.js LTS with winget..."
        & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    } elseif (Test-Command "choco") {
        Write-Info "Installing Node.js LTS with Chocolatey..."
        & choco install nodejs-lts -y
    } elseif (Test-Command "scoop") {
        Write-Info "Installing Node.js LTS with Scoop..."
        & scoop install nodejs-lts
    } else {
        throw "Node.js >= $NodeMinMajor.$NodeMinMinor is required and no package manager (winget, choco, scoop) was found. Install Node.js from https://nodejs.org and re-run."
    }

    Update-SessionPath
    if (Test-NodeOk) {
        Write-Ok "Node.js $(& node -v) installed"
    } else {
        throw "Node.js was installed but is not on PATH yet. Open a new PowerShell window and re-run this installer."
    }
}

# npm shells out to git for a git-hosted transitive dependency (libsignal, via
# the WhatsApp library), so `npm install -g infinibot` fails without it.
function Install-Git {
    if (Test-Command "git") { return }
    Write-Info "Git not found (npm needs it to fetch one dependency); installing..."
    if (Test-Command "winget") {
        & winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
    } elseif (Test-Command "choco") {
        & choco install git -y
    } elseif (Test-Command "scoop") {
        & scoop install git
    } else {
        throw "Git is required and no package manager (winget, choco, scoop) was found. Install it from https://git-scm.com/download/win and re-run."
    }
    Update-SessionPath
    if (-not (Test-Command "git")) {
        throw "Git was installed but is not on PATH yet. Open a new PowerShell window and re-run this installer."
    }
    Write-Ok "Git installed"
}

function Install-InfiniBot {
    Write-Step "InfiniBot"

    if ($DryRun) {
        Write-Host "  [dry-run] npm install -g $NpmSpec"
        return
    }
    Install-Git
    if (-not (Test-Command "npm")) {
        throw "npm not found even though Node.js is installed. Reinstall Node.js from https://nodejs.org."
    }

    Write-Info "npm install -g $NpmSpec"
    $env:SHARP_IGNORE_GLOBAL_LIBVIPS = "1"
    & npm install -g $NpmSpec --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

    # npm's global bin dir on Windows is the prefix itself; make sure this
    # session and future ones can find infinibot.cmd.
    $prefix = (& npm config get prefix).Trim()
    if ($prefix -and (($env:Path -split ";") -notcontains $prefix)) {
        $env:Path = "$env:Path;$prefix"
        $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $userPath -or (($userPath -split ";") -notcontains $prefix)) {
            $newUserPath = if ($userPath) { "$userPath;$prefix" } else { $prefix }
            [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
            Write-Info "Added $prefix to your user PATH"
        }
    }

    if (-not (Test-Command "infinibot")) {
        throw "Installed, but the 'infinibot' command was not found. Open a new PowerShell window and run: infinibot onboard"
    }
    $installed = (& infinibot --version | Select-Object -Last 1)
    Write-Ok "InfiniBot $installed installed"
}

function Start-Onboarding {
    Write-Step "Setup"

    if ($NoOnboard) {
        Write-Info "Skipping the setup wizard (-NoOnboard). Run it later with: infinibot onboard"
        return
    }
    if ($DryRun) {
        Write-Host "  [dry-run] infinibot onboard --install-daemon"
        return
    }
    & infinibot onboard --install-daemon
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "The setup wizard exited early. Re-run it any time with: infinibot onboard"
    }
}

function Write-Done {
    Write-Host ""
    Write-Host "InfiniBot is installed." -ForegroundColor Green
    Write-Host ""
    Write-Host "  infinibot onboard     " -ForegroundColor Cyan -NoNewline; Write-Host "set up (or re-run) the wizard in this terminal"
    Write-Host "  infinibot quickstart  " -ForegroundColor Cyan -NoNewline; Write-Host "same setup, in your browser"
    Write-Host "  infinibot gateway     " -ForegroundColor Cyan -NoNewline; Write-Host "start the gateway  ->  http://127.0.0.1:18789"
    Write-Host "  infinibot doctor      " -ForegroundColor Cyan -NoNewline; Write-Host "diagnose problems"
    Write-Host ""
    Write-Host "Docs: $DocsUrl"
}

try {
    Write-Host ""
    Write-Host "InfiniBot installer" -ForegroundColor DarkYellow

    Install-NodeJS
    Install-InfiniBot
    Start-Onboarding
    if ($DryRun) {
        Write-Host ""
        Write-Info "Dry run complete; nothing was changed."
    } else {
        Write-Done
    }
}
catch {
    Write-Host ""
    Write-Fail "Installation failed: $_"
    Write-Host "Help: $DocsUrl" -ForegroundColor Yellow
    # Do not `exit` here: under `iwr | iex` that would close the user's window.
    throw
}
