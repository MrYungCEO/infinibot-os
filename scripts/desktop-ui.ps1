# UI Automation helper — invoked by src/desktop/ui-automation.ts.
# Reads one JSON command from stdin, writes one JSON response to stdout.
#
# Commands:
#   { "op": "list_windows" }
#   { "op": "snapshot",  "pid|processName|focused", "maxDepth": N, "maxNodes": N }
#   { "op": "find",      <target>, "name"?, "nameContains"?, "automationId"?, "controlType"?, "index"? }
#   { "op": "invoke",    <target>, <selector> }
#   { "op": "set_value", <target>, <selector>, "text": "..." }
#   { "op": "focus",     <target>, <selector> }
#   { "op": "wait_for",  <target>, <selector>, "timeoutMs": N }
#   { "op": "keys",      <target>, "keys": "^s" }    # SendKeys syntax
#   { "op": "screenshot","pid?|processName?|focused?", "outPath": "..." }
#
# <target> = one of: { "pid": N } | { "processName": "name" } | { "focused": true }
# <selector> = fields on the command itself (name, nameContains, automationId, controlType, index)
#
# Response is always a single JSON object on stdout. On error: { "ok": false, "error": "..." }.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class UIW32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$SW_RESTORE = 9

function Out-Json {
    param([Parameter(ValueFromPipeline=$true)] $Obj)
    $json = $Obj | ConvertTo-Json -Compress -Depth 10
    [Console]::Out.WriteLine($json)
}

# ─────────────────────────────────────────────────────────────────────
# Target resolution (which window's AutomationElement tree we act on)
# ─────────────────────────────────────────────────────────────────────

function Get-ElementFromHwnd {
    param([IntPtr]$Hwnd)
    if ($Hwnd -eq [IntPtr]::Zero) { return $null }
    try { return [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd) } catch { return $null }
}

function Resolve-ProcessHwnd {
    param([int]$TargetPid)
    if ($TargetPid -le 0) { return [IntPtr]::Zero }
    try {
        $p = Get-Process -Id $TargetPid -ErrorAction Stop
        return $p.MainWindowHandle
    } catch { return [IntPtr]::Zero }
}

function Resolve-NameHwnd {
    param([string]$ProcessName)
    if (-not $ProcessName) { return [IntPtr]::Zero }
    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
    }
    return [IntPtr]::Zero
}

function Resolve-TargetHwnd {
    param($Cmd)
    if ($Cmd.focused -eq $true) { return [UIW32]::GetForegroundWindow() }
    if ($Cmd.pid) { return (Resolve-ProcessHwnd -TargetPid ([int]$Cmd.pid)) }
    if ($Cmd.processName) { return (Resolve-NameHwnd -ProcessName ([string]$Cmd.processName)) }
    # Nothing specified → active window
    return [UIW32]::GetForegroundWindow()
}

function Resolve-TargetRoot {
    param($Cmd)
    $hwnd = Resolve-TargetHwnd -Cmd $Cmd
    if ($hwnd -eq [IntPtr]::Zero) { return $null }
    return (Get-ElementFromHwnd -Hwnd $hwnd)
}

function Get-WindowInfo {
    param([IntPtr]$Hwnd)
    if ($Hwnd -eq [IntPtr]::Zero -or -not [UIW32]::IsWindow($Hwnd)) { return $null }
    $out = [UIW32+RECT]::new()
    [void][UIW32]::GetWindowRect($Hwnd, [ref]$out)
    [uint32]$pidOut = 0
    [void][UIW32]::GetWindowThreadProcessId($Hwnd, [ref]$pidOut)
    $proc = $null
    try { $proc = Get-Process -Id ([int]$pidOut) -ErrorAction SilentlyContinue } catch {}
    return @{
        hwnd = $Hwnd.ToInt64()
        pid = [int]$pidOut
        processName = if ($proc) { $proc.ProcessName } else { "" }
        title = if ($proc) { $proc.MainWindowTitle } else { "" }
        rect = @{ x = $out.Left; y = $out.Top; width = $out.Right - $out.Left; height = $out.Bottom - $out.Top }
    }
}

# ─────────────────────────────────────────────────────────────────────
# Element serialization
# ─────────────────────────────────────────────────────────────────────

$script:Patterns = @(
    @{ name = "Invoke";         id = [System.Windows.Automation.InvokePattern]::Pattern },
    @{ name = "Value";          id = [System.Windows.Automation.ValuePattern]::Pattern },
    @{ name = "Toggle";         id = [System.Windows.Automation.TogglePattern]::Pattern },
    @{ name = "ExpandCollapse"; id = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
    @{ name = "SelectionItem";  id = [System.Windows.Automation.SelectionItemPattern]::Pattern },
    @{ name = "RangeValue";     id = [System.Windows.Automation.RangeValuePattern]::Pattern },
    @{ name = "Scroll";         id = [System.Windows.Automation.ScrollPattern]::Pattern },
    @{ name = "Text";           id = [System.Windows.Automation.TextPattern]::Pattern }
)

function Get-ElementPatterns {
    param($El)
    $result = @()
    foreach ($p in $script:Patterns) {
        $ignored = $null
        try {
            if ($El.TryGetCurrentPattern($p.id, [ref]$ignored)) { $result += $p.name }
        } catch {}
    }
    return $result
}

function Format-Element {
    param($El, [string]$Ref, [int]$Depth)
    try {
        $c = $El.Current
    } catch { return $null }

    $rect = $c.BoundingRectangle
    $bounds = $null
    if (-not $rect.IsEmpty) {
        $bounds = @{
            x = [int]$rect.X; y = [int]$rect.Y
            width = [int]$rect.Width; height = [int]$rect.Height
        }
    }

    return [ordered]@{
        ref          = $Ref
        role         = $c.LocalizedControlType
        name         = $c.Name
        automationId = $c.AutomationId
        class        = $c.ClassName
        depth        = $Depth
        enabled      = $c.IsEnabled
        offscreen    = $c.IsOffscreen
        bounds       = $bounds
        patterns     = (Get-ElementPatterns -El $El)
    }
}

# Walk the control-view tree breadth-first within bounded depth + node count.
function Walk-Tree {
    param($Root, [int]$MaxDepth = 16, [int]$MaxNodes = 400)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $out = @()
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@{ el = $Root; depth = 0 })
    $refCount = 0
    while ($queue.Count -gt 0 -and $out.Count -lt $MaxNodes) {
        $item = $queue.Dequeue()
        $el = $item.el
        $depth = [int]$item.depth
        $formatted = Format-Element -El $el -Ref ("e$refCount") -Depth $depth
        if ($formatted) {
            $out += $formatted
            $refCount++
        }
        if ($depth -lt $MaxDepth) {
            try {
                $child = $walker.GetFirstChild($el)
                while ($child -ne $null -and $out.Count + $queue.Count -lt $MaxNodes) {
                    $queue.Enqueue(@{ el = $child; depth = $depth + 1 })
                    $child = $walker.GetNextSibling($child)
                }
            } catch {}
        }
    }
    return ,$out
}

# ─────────────────────────────────────────────────────────────────────
# Element lookup from a <selector> (name, nameContains, automationId, role, index)
# ─────────────────────────────────────────────────────────────────────

function Match-SelectorAgainstFormatted {
    param($Elements, $Cmd)
    $name        = if ($Cmd.name) { [string]$Cmd.name } else { $null }
    $contains    = if ($Cmd.nameContains) { [string]$Cmd.nameContains } else { $null }
    $auto        = if ($Cmd.automationId) { [string]$Cmd.automationId } else { $null }
    $role        = if ($Cmd.controlType) { [string]$Cmd.controlType } else { $null }
    $ref         = if ($Cmd.ref) { [string]$Cmd.ref } else { $null }
    $index       = if ($Cmd.index) { [int]$Cmd.index } else { 0 }

    $matches = @()
    foreach ($e in $Elements) {
        if ($ref -and $e.ref -ne $ref) { continue }
        if ($name -and $e.name -ne $name) { continue }
        if ($contains -and ($e.name -notmatch [regex]::Escape($contains))) { continue }
        if ($auto -and $e.automationId -ne $auto) { continue }
        if ($role -and $e.role -ne $role) { continue }
        $matches += $e
    }
    if ($matches.Count -eq 0) { return $null }
    if ($index -ge $matches.Count) { $index = $matches.Count - 1 }
    return $matches[$index]
}

# Re-resolve a formatted element descriptor to a live AutomationElement by
# walking the tree and matching on automationId + name + depth + role.
function Resolve-LiveElement {
    param($Root, $Formatted)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@{ el = $Root; depth = 0 })
    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $el = $item.el
        $d = [int]$item.depth
        try {
            $c = $el.Current
            $matchAuto = if ($Formatted.automationId) { $c.AutomationId -eq $Formatted.automationId } else { $true }
            $matchName = if ($Formatted.name) { $c.Name -eq $Formatted.name } else { $true }
            $matchRole = if ($Formatted.role) { $c.LocalizedControlType -eq $Formatted.role } else { $true }
            if ($matchAuto -and $matchName -and $matchRole -and $d -eq [int]$Formatted.depth) {
                return $el
            }
        } catch {}
        try {
            $child = $walker.GetFirstChild($el)
            while ($child -ne $null) {
                $queue.Enqueue(@{ el = $child; depth = $d + 1 })
                $child = $walker.GetNextSibling($child)
            }
        } catch {}
    }
    return $null
}

function Find-Element {
    param($Root, $Cmd, [int]$MaxNodes = 2000)
    $snapshot = Walk-Tree -Root $Root -MaxDepth 32 -MaxNodes $MaxNodes
    $chosen = Match-SelectorAgainstFormatted -Elements $snapshot -Cmd $Cmd
    if (-not $chosen) { return $null }
    $live = Resolve-LiveElement -Root $Root -Formatted $chosen
    return @{ element = $live; descriptor = $chosen }
}

# ─────────────────────────────────────────────────────────────────────
# Operations
# ─────────────────────────────────────────────────────────────────────

function Op-ListWindows {
    $result = @()
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle }
    foreach ($p in $procs) {
        $result += [ordered]@{
            pid         = $p.Id
            processName = $p.ProcessName
            title       = $p.MainWindowTitle
            hwnd        = $p.MainWindowHandle.ToInt64()
        }
    }
    return @{ ok = $true; windows = $result }
}

function Op-Snapshot {
    param($Cmd)
    $root = Resolve-TargetRoot -Cmd $Cmd
    if (-not $root) { return @{ ok = $false; error = "no window matched target" } }
    $maxDepth = if ($Cmd.maxDepth) { [int]$Cmd.maxDepth } else { 16 }
    $maxNodes = if ($Cmd.maxNodes) { [int]$Cmd.maxNodes } else { 400 }
    $window = Get-WindowInfo -Hwnd ([IntPtr]::new($root.Current.NativeWindowHandle))
    $elements = Walk-Tree -Root $root -MaxDepth $maxDepth -MaxNodes $maxNodes
    return @{ ok = $true; window = $window; elements = $elements; truncated = ($elements.Count -ge $maxNodes) }
}

function Op-Find {
    param($Cmd)
    $root = Resolve-TargetRoot -Cmd $Cmd
    if (-not $root) { return @{ ok = $false; error = "no window matched target" } }
    $all = Walk-Tree -Root $root -MaxDepth 32 -MaxNodes 2000
    $name     = if ($Cmd.name) { [string]$Cmd.name } else { $null }
    $contains = if ($Cmd.nameContains) { [string]$Cmd.nameContains } else { $null }
    $auto     = if ($Cmd.automationId) { [string]$Cmd.automationId } else { $null }
    $role     = if ($Cmd.controlType) { [string]$Cmd.controlType } else { $null }
    $matches = @()
    foreach ($e in $all) {
        if ($name -and $e.name -ne $name) { continue }
        if ($contains -and ($e.name -notmatch [regex]::Escape($contains))) { continue }
        if ($auto -and $e.automationId -ne $auto) { continue }
        if ($role -and $e.role -ne $role) { continue }
        $matches += $e
    }
    return @{ ok = $true; matches = $matches; count = $matches.Count }
}

function Invoke-ElementAction {
    param($Element, [string]$ActionName)
    $patternType = $null
    $apply = $null
    switch ($ActionName) {
        "invoke" {
            $patternType = [System.Windows.Automation.InvokePattern]::Pattern
            $apply = { param($p) $p.Invoke() }
        }
        "toggle" {
            $patternType = [System.Windows.Automation.TogglePattern]::Pattern
            $apply = { param($p) $p.Toggle() }
        }
        "expand" {
            $patternType = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
            $apply = { param($p) $p.Expand() }
        }
        "collapse" {
            $patternType = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
            $apply = { param($p) $p.Collapse() }
        }
        "select" {
            $patternType = [System.Windows.Automation.SelectionItemPattern]::Pattern
            $apply = { param($p) $p.Select() }
        }
        default { throw "unknown action: $ActionName" }
    }
    $out = $null
    if (-not $Element.TryGetCurrentPattern($patternType, [ref]$out)) {
        throw "element does not support $ActionName pattern"
    }
    & $apply $out
}

function Op-Invoke {
    param($Cmd)
    $root = Resolve-TargetRoot -Cmd $Cmd
    if (-not $root) { return @{ ok = $false; error = "no window matched target" } }
    $found = Find-Element -Root $root -Cmd $Cmd
    if (-not $found -or -not $found.element) { return @{ ok = $false; error = "element not found" } }
    $action = if ($Cmd.uiAction) { [string]$Cmd.uiAction } else { "invoke" }
    try {
        Invoke-ElementAction -Element $found.element -ActionName $action
        return @{ ok = $true; action = $action; element = $found.descriptor }
    } catch {
        return @{ ok = $false; error = "$_"; element = $found.descriptor }
    }
}

function Op-SetValue {
    param($Cmd)
    $root = Resolve-TargetRoot -Cmd $Cmd
    if (-not $root) { return @{ ok = $false; error = "no window matched target" } }
    $found = Find-Element -Root $root -Cmd $Cmd
    if (-not $found -or -not $found.element) { return @{ ok = $false; error = "element not found" } }
    $text = if ($Cmd.text) { [string]$Cmd.text } else { "" }
    $out = $null
    try {
        if (-not $found.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$out)) {
            return @{ ok = $false; error = "element does not support Value pattern"; element = $found.descriptor }
        }
        $out.SetValue($text)
        return @{ ok = $true; element = $found.descriptor; text = $text }
    } catch {
        return @{ ok = $false; error = "$_"; element = $found.descriptor }
    }
}

function Op-Focus {
    param($Cmd)
    $root = Resolve-TargetRoot -Cmd $Cmd
    if (-not $root) { return @{ ok = $false; error = "no window matched target" } }
    $found = Find-Element -Root $root -Cmd $Cmd
    if (-not $found -or -not $found.element) { return @{ ok = $false; error = "element not found" } }
    try {
        $found.element.SetFocus()
        return @{ ok = $true; element = $found.descriptor }
    } catch {
        return @{ ok = $false; error = "$_"; element = $found.descriptor }
    }
}

function Op-WaitFor {
    param($Cmd)
    $timeoutMs = if ($Cmd.timeoutMs) { [int]$Cmd.timeoutMs } else { 5000 }
    $deadline = [DateTime]::Now.AddMilliseconds($timeoutMs)
    while ([DateTime]::Now -lt $deadline) {
        $root = Resolve-TargetRoot -Cmd $Cmd
        if ($root) {
            $found = Find-Element -Root $root -Cmd $Cmd -MaxNodes 800
            if ($found -and $found.element) {
                return @{ ok = $true; element = $found.descriptor }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    return @{ ok = $false; error = "timed out after ${timeoutMs}ms waiting for element" }
}

function Op-Keys {
    param($Cmd)
    $keys = if ($Cmd.keys) { [string]$Cmd.keys } else { "" }
    if (-not $keys) { return @{ ok = $false; error = "keys is required" } }

    $hwnd = Resolve-TargetHwnd -Cmd $Cmd
    if ($hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; error = "no window matched target" } }
    [void][UIW32]::ShowWindow($hwnd, $SW_RESTORE)
    [void][UIW32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 120
    try {
        [System.Windows.Forms.SendKeys]::SendWait($keys)
        return @{ ok = $true; keys = $keys; hwnd = $hwnd.ToInt64() }
    } catch {
        return @{ ok = $false; error = "$_" }
    }
}

function Op-Screenshot {
    param($Cmd)
    $hwnd = Resolve-TargetHwnd -Cmd $Cmd
    if ($hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; error = "no window matched target" } }
    [void][UIW32]::ShowWindow($hwnd, $SW_RESTORE)
    Start-Sleep -Milliseconds 80
    $rect = [UIW32+RECT]::new()
    [void][UIW32]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { return @{ ok = $false; error = "window has zero size" } }

    $outPath = if ($Cmd.outPath) { [string]$Cmd.outPath } else { Join-Path $env:TEMP "ui-shot-$([Guid]::NewGuid().ToString('N')).png" }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        } finally { $g.Dispose() }
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
    return @{ ok = $true; path = $outPath; width = $w; height = $h }
}

# ─────────────────────────────────────────────────────────────────────
# Dispatch
# ─────────────────────────────────────────────────────────────────────

try {
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { Out-Json @{ ok = $false; error = "no input" }; exit 1 }
    $cmd = $raw | ConvertFrom-Json
    $op = [string]$cmd.op
    switch ($op) {
        "list_windows" { Out-Json (Op-ListWindows) }
        "snapshot"     { Out-Json (Op-Snapshot   -Cmd $cmd) }
        "find"         { Out-Json (Op-Find       -Cmd $cmd) }
        "invoke"       { Out-Json (Op-Invoke     -Cmd $cmd) }
        "set_value"    { Out-Json (Op-SetValue   -Cmd $cmd) }
        "focus"        { Out-Json (Op-Focus      -Cmd $cmd) }
        "wait_for"     { Out-Json (Op-WaitFor    -Cmd $cmd) }
        "keys"         { Out-Json (Op-Keys       -Cmd $cmd) }
        "screenshot"   { Out-Json (Op-Screenshot -Cmd $cmd) }
        default        { Out-Json @{ ok = $false; error = "unknown op: $op" } }
    }
} catch {
    Out-Json @{ ok = $false; error = "$_" }
    exit 1
}
