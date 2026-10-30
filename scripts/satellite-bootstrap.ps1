# InfiniBot Satellite Bootstrap (Windows / PowerShell)
#
# One command turns a Windows box into a fully-managed InfiniBot satellite:
#   - installs Node 22 LTS if missing (via winget; falls back to fnm/nvs hint)
#   - installs `infinibot` globally from npm
#   - registers a Scheduled Task that re-runs `npm i -g infinibot@latest` every
#     6h so satellites auto-pick-up every release published from main
#   - registers a Scheduled Task that auto-starts the gateway at logon
#   - opens the gateway LAN firewall port
#   - (optional) pairs to a master gateway via `infinibot federation join`
#
# Usage (elevated PowerShell):
#   .\scripts\satellite-bootstrap.ps1 -InviteToken eyJ2I...long-string
#
# Legacy two-arg form is still accepted but deprecated:
#   .\scripts\satellite-bootstrap.ps1 -MasterUrl ws://master:18789/federation `
#     -PairingToken xxxxxxxx
#
# Idempotent: safe to re-run. Will only replace tasks/services it created itself.

[CmdletBinding()]
param(
  # Preferred: single encoded invite blob from `infinibot federation invite`.
  [string]$InviteToken = $env:INFINIBOT_INVITE_TOKEN,
  # Deprecated: legacy two-arg pairing. Kept for backwards compat only.
  [string]$MasterUrl = $env:INFINIBOT_MASTER_URL,
  [string]$PairingToken = $env:INFINIBOT_PAIRING_TOKEN,
  [int]$GatewayPort = 18789,
  [string]$NpmTag = "latest",
  [int]$UpdateIntervalHours = 6,
  [switch]$NoAutoStart,
  [switch]$NoUpdateTask,
  [switch]$Uninstall,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$TaskUpdate  = "InfiniBot-AutoUpdate"
$TaskGateway = "InfiniBot-Gateway"
$FwRule      = "InfiniBot-Gateway-In-TCP"
$LogDir      = Join-Path $env:LOCALAPPDATA "InfiniBot\logs"

function Show-Help {
  Write-Host @"
InfiniBot Satellite Bootstrap

Preferred:
  .\scripts\satellite-bootstrap.ps1 -InviteToken <encoded-invite>

Deprecated (will be removed in a future release):
  -MasterUrl    <url>     (legacy two-arg pairing)
  -PairingToken <token>   (legacy two-arg pairing)

Common:
  -GatewayPort         <port>  (default 18789)
  -NpmTag              <tag>   (default latest)
  -UpdateIntervalHours <n>     (default 6)
  -NoAutoStart                 skip gateway scheduled task
  -NoUpdateTask                skip auto-update scheduled task
  -Uninstall                   remove tasks + firewall rule
  -Help                        show this message
"@
}

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    throw "Run this script in an elevated PowerShell (Run as Administrator)."
  }
}

function Write-Step($msg) { Write-Host ">> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "OK $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "!! $msg" -ForegroundColor Yellow }

function Uninstall-All {
  Write-Step "removing scheduled tasks + firewall rule"
  foreach ($t in @($TaskUpdate, $TaskGateway)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Ok "removed task $t"
    }
  }
  if (Get-NetFirewallRule -Name $FwRule -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -Name $FwRule
    Write-Ok "removed firewall rule"
  }
  Write-Ok "uninstall complete. `infinibot` global package is left in place (uninstall with: npm uninstall -g infinibot)."
}

function Ensure-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $ver = (& node -v).TrimStart("v")
    $maj = [int]($ver.Split(".")[0])
    if ($maj -ge 22) { Write-Ok "node $ver"; return }
    Write-Warn2 "node $ver is too old (need >=22)"
  }
  Write-Step "installing Node.js 22 LTS via winget"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "winget not available. Install Node.js 22 LTS manually from https://nodejs.org/ and re-run."
  }
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node still not on PATH after winget install. Open a new shell and re-run."
  }
  Write-Ok "node installed: $(& node -v)"
}

function Install-Infinibot {
  Write-Step "installing infinibot@$NpmTag globally"
  & npm config set fund false | Out-Null
  & npm config set audit false | Out-Null
  & npm install -g "infinibot@$NpmTag"
  if ($LASTEXITCODE -ne 0) { throw "npm install -g infinibot failed (exit $LASTEXITCODE)" }
  Write-Ok "installed: $(& infinibot --version 2>&1)"
}

function Open-Firewall {
  Write-Step "opening firewall for gateway port $GatewayPort/tcp"
  if (Get-NetFirewallRule -Name $FwRule -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $FwRule -LocalPort $GatewayPort -Enabled True | Out-Null
  } else {
    New-NetFirewallRule -Name $FwRule -DisplayName "InfiniBot Gateway ($GatewayPort)" `
      -Direction Inbound -Protocol TCP -LocalPort $GatewayPort -Action Allow -Profile Any | Out-Null
  }
  Write-Ok "firewall rule active"
}

function Register-UpdateTask {
  if ($NoUpdateTask) { Write-Warn2 "skipping auto-update task (-NoUpdateTask)"; return }
  Write-Step "registering auto-update task ($TaskUpdate) every $UpdateIntervalHours h"

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"npm install -g infinibot@$NpmTag *>&1 | Out-File -Append '$LogDir\auto-update.log'`""

  $trigger1 = New-ScheduledTaskTrigger -AtStartup
  $trigger2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) `
    -RepetitionInterval (New-TimeSpan -Hours $UpdateIntervalHours)

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

  if (Get-ScheduledTask -TaskName $TaskUpdate -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskUpdate -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskUpdate -Action $action -Trigger @($trigger1,$trigger2) `
    -Settings $settings -Principal $principal -Description "Pulls the latest infinibot npm package every $UpdateIntervalHours hours." | Out-Null
  Write-Ok "auto-update task installed"
}

function Register-GatewayTask {
  if ($NoAutoStart) { Write-Warn2 "skipping gateway auto-start (-NoAutoStart)"; return }
  Write-Step "registering gateway auto-start task ($TaskGateway)"

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"infinibot gateway run --bind lan --port $GatewayPort --force *>&1 | Out-File -Append '$LogDir\gateway.log'`""

  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -MultipleInstances IgnoreNew

  if (Get-ScheduledTask -TaskName $TaskGateway -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskGateway -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskGateway -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Highest -Description "Keeps the InfiniBot satellite gateway running for federation." | Out-Null
  Write-Ok "gateway task installed (starts at logon)"
}

function Join-Federation {
  if ($InviteToken) {
    Write-Step "redeeming invite token"
    & infinibot federation join $InviteToken --yes
    if ($LASTEXITCODE -ne 0) { throw "federation join failed (exit $LASTEXITCODE)" }
    Write-Ok "federation paired (invite)"
    return
  }
  if ($MasterUrl) {
    Write-Warn2 "-MasterUrl / -PairingToken are deprecated; prefer -InviteToken from `infinibot federation invite`"
    Write-Step "pairing to master $MasterUrl (legacy)"
    $args = @("federation","join",$MasterUrl)
    if ($PairingToken) { $args += @("--token",$PairingToken) }
    & infinibot @args
    if ($LASTEXITCODE -ne 0) { throw "federation join failed (exit $LASTEXITCODE)" }
    Write-Ok "federation paired (legacy)"
    return
  }
  Write-Warn2 "no -InviteToken supplied; skipping federation pairing. Run later with: infinibot federation join <encoded-invite>"
}

function Start-GatewayNow {
  if ($NoAutoStart) { return }
  Write-Step "starting gateway task now"
  Start-ScheduledTask -TaskName $TaskGateway
  Start-Sleep -Seconds 2
  $running = Get-Process -Name infinibot -ErrorAction SilentlyContinue
  if ($running) { Write-Ok "gateway running (pid $($running.Id -join ','))" } else { Write-Warn2 "gateway process not detected — check $LogDir\gateway.log" }
}

# ----- main -----------------------------------------------------------------

if ($Help) { Show-Help; return }

Assert-Admin
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($Uninstall) { Uninstall-All; return }

Write-Host ""
Write-Host "=== InfiniBot satellite bootstrap ===" -ForegroundColor Magenta
Write-Host "  host:         $(hostname)"
Write-Host "  npm tag:      $NpmTag"
Write-Host "  gateway port: $GatewayPort"
if ($InviteToken) {
  Write-Host "  invite:       (provided)"
} elseif ($MasterUrl) {
  Write-Host "  master url:   $MasterUrl  (deprecated path)"
} else {
  Write-Host "  invite:       (skip pairing)"
}
Write-Host "  log dir:      $LogDir"
Write-Host ""

Ensure-Node
Install-Infinibot
Open-Firewall
Register-UpdateTask
Register-GatewayTask
Join-Federation
Start-GatewayNow

Write-Host ""
Write-Ok "satellite bootstrap complete."
Write-Host "Tasks:           Get-ScheduledTask 'InfiniBot-*'"
Write-Host "Update now:      Start-ScheduledTask -TaskName $TaskUpdate"
Write-Host "Gateway logs:    Get-Content '$LogDir\gateway.log' -Tail 40 -Wait"
Write-Host "Uninstall tasks: powershell -ExecutionPolicy Bypass -File scripts/satellite-bootstrap.ps1 -Uninstall"
