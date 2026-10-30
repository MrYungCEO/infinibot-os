; ─── InfiniBot NSIS custom installer script ───────────────────────────────
;
; Hooks fired by electron-builder during NSIS install/uninstall.
; Both macros run with administrator privileges (UAC prompt is shown
; by the NSIS bootstrapper before these macros execute).
;
; Gateway port: 47913 (desktop default; matches INFINIBOT_DESKTOP_GATEWAY_PORT)
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall

  ; ── 1. Windows Firewall — inbound TCP rule for InfiniBot Gateway ────────
  DetailPrint "Registering InfiniBot Gateway firewall rule (TCP 47913)..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="InfiniBot Gateway" 2>nul'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="InfiniBot Gateway" dir=in action=allow protocol=TCP localport=47913 description="InfiniBot local gateway HTTP/WS" profile=any'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Warning: Firewall rule registration failed (exit $0). You can add it manually:"
    DetailPrint "  netsh advfirewall firewall add rule name=""InfiniBot Gateway"" dir=in action=allow protocol=TCP localport=47913"
  ${Else}
    DetailPrint "Firewall rule registered."
  ${EndIf}

  ; ── 2. Enable Windows Long Paths (>260 chars) ───────────────────────────
  ; Required because Node module trees easily exceed the MAX_PATH limit.
  DetailPrint "Setting LongPathsEnabled = 1..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled" 1
  DetailPrint "LongPathsEnabled set."

!macroend


!macro customUninstall

  ; ── Remove the firewall rule on uninstall ───────────────────────────────
  DetailPrint "Removing InfiniBot Gateway firewall rule..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="InfiniBot Gateway"'

  ; Note: We intentionally leave LongPathsEnabled = 1 on uninstall.
  ; Other tools may depend on it, and re-disabling it can break them.

!macroend
