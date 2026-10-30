# Desktop control helper invoked by src/desktop/launcher.ts.
# Reads one JSON command from stdin, writes one JSON response to stdout.
#
# Commands:
#   { "op": "displays" }
#   { "op": "launch",  "path": "...", "args": "...", "display": 1,
#       "position": "fullscreen|maximized|normal|left-half|right-half|top-half|
#                    bottom-half|top-left|top-right|bottom-left|bottom-right|center" }
#   { "op": "close",   "pid": 1234 }  # or "process": "brave"
#
# All responses are a single JSON object: { "ok": bool, ...fields } written to stdout.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# ShowWindow nCmdShow constants
$SW_HIDE       = 0
$SW_SHOWNORMAL = 1
$SW_MINIMIZE   = 6
$SW_MAXIMIZE   = 3
$SW_RESTORE    = 9
$SW_SHOW       = 5

# Window style indices for GetWindowLong/SetWindowLong
$GWL_STYLE   = -16
$GWL_EXSTYLE = -20
# Window styles
$WS_CAPTION     = 0x00C00000
$WS_THICKFRAME  = 0x00040000
$WS_BORDER      = 0x00800000
$WS_DLGFRAME    = 0x00400000
$WS_SYSMENU     = 0x00080000
$WS_MINIMIZEBOX = 0x00020000
$WS_MAXIMIZEBOX = 0x00010000

function Out-Json {
    param([Parameter(ValueFromPipeline=$true)] $Obj)
    $json = $Obj | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($json)
}

function Get-DeviceNumber {
    param([string]$DeviceName)
    # Extract the trailing integer from \\.\DISPLAYN — Windows Display Settings
    # uses this same numbering, so /apps display 3 matches what's in Settings.
    if ([string]::IsNullOrEmpty($DeviceName)) { return 999 }
    $m = [regex]::Match($DeviceName, '(\d+)$')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return 999
}

function Get-SortedScreens {
    # Return screens sorted by \\.\DISPLAYN index so callers can index 1..N in
    # Windows-order.
    return [System.Windows.Forms.Screen]::AllScreens |
        Sort-Object -Property @{ Expression = { Get-DeviceNumber $_.DeviceName } }
}

function Get-Displays {
    $screens = @(Get-SortedScreens)
    $result = @()
    foreach ($s in $screens) {
        $b = $s.WorkingArea
        $num = Get-DeviceNumber $s.DeviceName
        $result += [ordered]@{
            index    = $num
            primary  = $s.Primary
            device   = $s.DeviceName
            bounds   = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
            workArea = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
        }
    }
    return $result
}

function Get-ScreenByIndex {
    param([int]$Display)
    $screens = @(Get-SortedScreens)
    foreach ($s in $screens) {
        if ((Get-DeviceNumber $s.DeviceName) -eq $Display) { return $s }
    }
    # Fall back to primary
    foreach ($s in $screens) { if ($s.Primary) { return $s } }
    return $screens[0]
}

function Compute-TargetRect {
    param([int]$Display, [string]$Position)
    $screen = Get-ScreenByIndex -Display $Display
    $b = $screen.WorkingArea
    # For "fullscreen" we want to cover the whole monitor including taskbar area.
    if ($Position -eq "fullscreen") { $b = $screen.Bounds }
    $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height
    switch ($Position) {
        "left-half"     { $w = [int]($b.Width / 2) }
        "right-half"    { $x = $b.X + [int]($b.Width / 2); $w = $b.Width - [int]($b.Width / 2) }
        "top-half"      { $h = [int]($b.Height / 2) }
        "bottom-half"   { $y = $b.Y + [int]($b.Height / 2); $h = $b.Height - [int]($b.Height / 2) }
        "top-left"      { $w = [int]($b.Width / 2); $h = [int]($b.Height / 2) }
        "top-right"     { $x = $b.X + [int]($b.Width / 2); $w = $b.Width - [int]($b.Width / 2); $h = [int]($b.Height / 2) }
        "bottom-left"   { $y = $b.Y + [int]($b.Height / 2); $w = [int]($b.Width / 2); $h = $b.Height - [int]($b.Height / 2) }
        "bottom-right"  { $x = $b.X + [int]($b.Width / 2); $y = $b.Y + [int]($b.Height / 2); $w = $b.Width - [int]($b.Width / 2); $h = $b.Height - [int]($b.Height / 2) }
        "center"        {
            $targetW = [int]($b.Width * 0.7); $targetH = [int]($b.Height * 0.7)
            $x = $b.X + [int](($b.Width - $targetW) / 2)
            $y = $b.Y + [int](($b.Height - $targetH) / 2)
            $w = $targetW; $h = $targetH
        }
    }
    return @{ x = $x; y = $y; width = $w; height = $h }
}

function Wait-MainWindow {
    param([int]$TargetPid, [int]$TimeoutMs = 6000)
    $deadline = [DateTime]::Now.AddMilliseconds($TimeoutMs)
    while ([DateTime]::Now -lt $deadline) {
        # Some apps (Electron, browsers) spawn a launcher that exits; resolve
        # the real process by executable name if the original pid vanishes.
        $proc = $null
        try { $proc = Get-Process -Id $TargetPid -ErrorAction Stop } catch {}
        if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
            return @{ pid = $proc.Id; hwnd = $proc.MainWindowHandle.ToInt64(); title = $proc.MainWindowTitle }
        }
        Start-Sleep -Milliseconds 150
    }
    return $null
}

function Resolve-Targets {
    # Returns an array of hashtables { pid, hwnd, title } for the requested
    # target. Accepts either a pid or a process name (which may match multiple).
    param($Cmd)
    $pidVal = if ($Cmd.pid) { [int]$Cmd.pid } else { 0 }
    $procName = if ($Cmd.process) { [string]$Cmd.process } else { "" }
    $procs = @()
    if ($pidVal -gt 0) {
        try { $procs += Get-Process -Id $pidVal -ErrorAction Stop } catch {}
    } elseif ($procName) {
        $procs = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
    }
    $result = @()
    foreach ($p in $procs) {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
            $result += @{ pid = $p.Id; hwnd = $p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle }
        }
    }
    return ,$result
}

function Op-Launch {
    param($Cmd)
    $exe = [string]$Cmd.path
    if (-not $exe) { return @{ ok = $false; error = "path is required" } }
    if (-not (Test-Path -LiteralPath $exe)) { return @{ ok = $false; error = "path not found: $exe" } }

    $argList = @()
    if ($Cmd.args) {
        # Cmd.args is a single string; PowerShell will split on whitespace respecting quotes.
        $argList = [regex]::Matches([string]$Cmd.args, '("[^"]+"|\S+)') | ForEach-Object { $_.Value.Trim('"') }
    }

    $display = 1
    if ($Cmd.display) { $display = [int]$Cmd.display }
    $position = "normal"
    if ($Cmd.position) { $position = [string]$Cmd.position }

    # Start the process
    $startArgs = @{
        FilePath = $exe
        PassThru = $true
    }
    if ($argList.Count -gt 0) { $startArgs.ArgumentList = $argList }
    # Window style: Maximized/Minimized/Normal — fullscreen positioning is done post-hoc.
    if ($position -eq "maximized" -or $position -eq "fullscreen") {
        $startArgs.WindowStyle = "Maximized"
    }

    $proc = Start-Process @startArgs
    $pidVal = $proc.Id

    $win = Wait-MainWindow -TargetPid $pidVal -TimeoutMs 8000
    if (-not $win) {
        return @{ ok = $true; launched = $true; pid = $pidVal; positioned = $false; note = "window never appeared within timeout" }
    }

    $hwndPtr = [IntPtr]::new($win.hwnd)
    # Ensure window is restored to normal state before moving (can't reliably move maximized/fullscreen).
    [void][Win32]::ShowWindow($hwndPtr, $SW_RESTORE)
    Start-Sleep -Milliseconds 100

    $rect = Compute-TargetRect -Display $display -Position $position
    [void][Win32]::MoveWindow($hwndPtr, $rect.x, $rect.y, $rect.width, $rect.height, $true)

    if ($position -eq "fullscreen" -or $position -eq "maximized") {
        Start-Sleep -Milliseconds 80
        [void][Win32]::ShowWindow($hwndPtr, $SW_MAXIMIZE)
    }

    [void][Win32]::SetForegroundWindow($hwndPtr)

    return @{
        ok         = $true
        launched   = $true
        positioned = $true
        pid        = $pidVal
        title      = $win.title
        display    = $display
        position   = $position
        rect       = $rect
    }
}

function Op-Close {
    param($Cmd)
    $killed = @()
    if ($Cmd.pid) {
        try {
            Stop-Process -Id ([int]$Cmd.pid) -Force -ErrorAction Stop
            $killed += [int]$Cmd.pid
        } catch {
            return @{ ok = $false; error = "Stop-Process failed: $_" }
        }
    } elseif ($Cmd.process) {
        $name = [string]$Cmd.process
        $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.Id } catch {}
        }
    } else {
        return @{ ok = $false; error = "pid or process is required" }
    }
    return @{ ok = $true; closed = $killed }
}

function Op-Minimize {
    param($Cmd)
    $targets = Resolve-Targets -Cmd $Cmd
    if ($targets.Count -eq 0) { return @{ ok = $false; error = "no matching windows" } }
    $hit = @()
    foreach ($t in $targets) {
        $hwnd = [IntPtr]::new($t.hwnd)
        [void][Win32]::ShowWindow($hwnd, $SW_MINIMIZE)
        $hit += @{ pid = $t.pid; title = $t.title }
    }
    return @{ ok = $true; minimized = $hit }
}

function Op-Restore {
    param($Cmd)
    $targets = Resolve-Targets -Cmd $Cmd
    if ($targets.Count -eq 0) { return @{ ok = $false; error = "no matching windows" } }
    $hit = @()
    foreach ($t in $targets) {
        $hwnd = [IntPtr]::new($t.hwnd)
        [void][Win32]::ShowWindow($hwnd, $SW_RESTORE)
        [void][Win32]::SetForegroundWindow($hwnd)
        $hit += @{ pid = $t.pid; title = $t.title }
    }
    return @{ ok = $true; restored = $hit }
}

function Op-Fullscreen {
    param($Cmd)
    $targets = Resolve-Targets -Cmd $Cmd
    if ($targets.Count -eq 0) { return @{ ok = $false; error = "no matching windows" } }
    $display = 1
    if ($Cmd.display) { $display = [int]$Cmd.display }
    $hit = @()
    foreach ($t in $targets) {
        $hwnd = [IntPtr]::new($t.hwnd)
        # Restore first so MoveWindow takes effect.
        [void][Win32]::ShowWindow($hwnd, $SW_RESTORE)
        Start-Sleep -Milliseconds 80
        $rect = Compute-TargetRect -Display $display -Position "fullscreen"
        [void][Win32]::MoveWindow($hwnd, $rect.x, $rect.y, $rect.width, $rect.height, $true)
        Start-Sleep -Milliseconds 50
        [void][Win32]::ShowWindow($hwnd, $SW_MAXIMIZE)
        [void][Win32]::SetForegroundWindow($hwnd)
        $hit += @{ pid = $t.pid; title = $t.title; display = $display; rect = $rect }
    }
    return @{ ok = $true; fullscreen = $hit }
}

function Op-Move {
    param($Cmd)
    $targets = Resolve-Targets -Cmd $Cmd
    if ($targets.Count -eq 0) { return @{ ok = $false; error = "no matching windows" } }
    $display = 1
    if ($Cmd.display) { $display = [int]$Cmd.display }
    $position = "normal"
    if ($Cmd.position) { $position = [string]$Cmd.position }
    $hit = @()
    foreach ($t in $targets) {
        $hwnd = [IntPtr]::new($t.hwnd)
        [void][Win32]::ShowWindow($hwnd, $SW_RESTORE)
        Start-Sleep -Milliseconds 80
        $rect = Compute-TargetRect -Display $display -Position $position
        [void][Win32]::MoveWindow($hwnd, $rect.x, $rect.y, $rect.width, $rect.height, $true)
        if ($position -eq "fullscreen" -or $position -eq "maximized") {
            Start-Sleep -Milliseconds 50
            [void][Win32]::ShowWindow($hwnd, $SW_MAXIMIZE)
        }
        [void][Win32]::SetForegroundWindow($hwnd)
        $hit += @{ pid = $t.pid; title = $t.title; display = $display; position = $position; rect = $rect }
    }
    return @{ ok = $true; moved = $hit }
}

function Op-Screenshot {
    param($Cmd)
    $display = 1
    if ($Cmd.display) { $display = [int]$Cmd.display }
    $outPath = [string]$Cmd.out
    if (-not $outPath) { return @{ ok = $false; error = "out path required" } }

    $screen = Get-ScreenByIndex -Display $display
    $bounds = $screen.Bounds

    $dir = [System.IO.Path]::GetDirectoryName($outPath)
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $srcPoint = New-Object System.Drawing.Point $bounds.X, $bounds.Y
        $size     = New-Object System.Drawing.Size  $bounds.Width, $bounds.Height
        $gfx.CopyFromScreen($srcPoint, [System.Drawing.Point]::Empty, $size)
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $gfx.Dispose()
        $bmp.Dispose()
    }

    return @{
        ok      = $true
        path    = $outPath
        display = (Get-DeviceNumber $screen.DeviceName)
        width   = $bounds.Width
        height  = $bounds.Height
        bounds  = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
    }
}

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { Out-Json @{ ok = $false; error = "no input" }; exit 1 }
    $cmd = $raw | ConvertFrom-Json
    $op = [string]$cmd.op
    switch ($op) {
        "displays"   { Out-Json @{ ok = $true; displays = (Get-Displays) } }
        "launch"     { Out-Json (Op-Launch     -Cmd $cmd) }
        "close"      { Out-Json (Op-Close      -Cmd $cmd) }
        "minimize"   { Out-Json (Op-Minimize   -Cmd $cmd) }
        "restore"    { Out-Json (Op-Restore    -Cmd $cmd) }
        "fullscreen" { Out-Json (Op-Fullscreen -Cmd $cmd) }
        "move"       { Out-Json (Op-Move       -Cmd $cmd) }
        "screenshot" { Out-Json (Op-Screenshot -Cmd $cmd) }
        default      { Out-Json @{ ok = $false; error = "unknown op: $op" } }
    }
} catch {
    Out-Json @{ ok = $false; error = "$_" }
    exit 1
}
