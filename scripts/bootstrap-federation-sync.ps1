#!/usr/bin/env pwsh
# InfiniBot Federation Sync Bootstrap (Windows)
# Sets up periodic code sync via GitHub scheduled task.
param(
    [string]$Role = "satellite",
    [string]$Remote = "origin",
    [string]$Branch = "main"
)

$RepoDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Hostname = hostname

Write-Host "=== InfiniBot Federation Sync Bootstrap ==="
Write-Host "  Host:    $Hostname"
Write-Host "  Role:    $Role"
Write-Host "  Remote:  $Remote"
Write-Host "  Branch:  $Branch"
Write-Host "  Repo:    $RepoDir"
Write-Host ""

# Validate git repo
$gitDir = Join-Path $RepoDir ".git"
if (-not (Test-Path $gitDir)) {
    Write-Error "ERROR: $RepoDir is not a git repository"
    exit 1
}

# Set environment
$env:FEDERATION_ROLE = $Role
$env:FEDERATION_GIT_REMOTE = $Remote
$env:FEDERATION_GIT_BRANCH = $Branch
$env:FEDERATION_REPO_PATH = $RepoDir

Write-Host "Installing Windows Scheduled Task..."
Set-Location $RepoDir
pnpm federation-sync:daemon

Write-Host ""
Write-Host "=== Bootstrap Complete ==="
Write-Host "Run 'pnpm federation-sync status' to check sync status."
Write-Host "Run 'pnpm federation-sync sync --dry-run' for a safe test."