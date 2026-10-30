# InfiniBot setup from a git checkout (Windows / PowerShell).
#
# Safe to re-run. It never rewrites your git remotes, never switches branches,
# never stashes or resets your work. It only checks prerequisites, installs
# dependencies from the committed lockfile and builds the gateway + control UI.
#
# Usage:
#   git clone <repo-url> InfiniBot; cd InfiniBot
#   powershell -ExecutionPolicy Bypass -File scripts/satellite-setup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/satellite-setup.ps1 -Update
#     (-Update also fast-forwards the current branch; skipped with local changes)

param([switch]$Update)

$ErrorActionPreference = "Stop"
$RepoDir = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $RepoDir

Write-Host "=== InfiniBot setup ==="
Write-Host "  repo: $RepoDir"
Write-Host ""

Write-Host "[1/4] checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 22.12+ is required (https://nodejs.org)."
  exit 1
}
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)"
if ($LASTEXITCODE -ne 0) {
  Write-Error "InfiniBot needs Node 22.12 or newer (found $(node -v))."
  exit 1
}

Write-Host "[2/4] checking pnpm"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (Get-Command corepack -ErrorAction SilentlyContinue) { corepack enable 2>$null }
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Error "pnpm not found. Run: corepack enable   (or: npm install -g pnpm)"
  exit 1
}

if ($Update) {
  $dirty = (git status --porcelain)
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null | Out-Null
  $hasUpstream = ($LASTEXITCODE -eq 0)
  if ($dirty) {
    Write-Host "      -Update skipped: you have local changes (commit or stash them first)."
  } elseif (-not $hasUpstream) {
    Write-Host "      -Update skipped: current branch has no upstream."
  } else {
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

Write-Host "[3/4] installing dependencies"
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[4/4] building (backend + control UI)"
pnpm build:all
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  pnpm infinibot onboard      # pick a model provider, set a gateway password"
Write-Host "  pnpm infinibot gateway      # start the gateway, then open the printed URL"
