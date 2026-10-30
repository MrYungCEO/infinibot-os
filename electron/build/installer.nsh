; InfiniBot NSIS custom installer hooks.
;
; electron-builder polls for a clean WM_CLOSE on the running app; our app
; hides to the tray instead of quitting, so the polite shutdown never
; completes and the "InfiniBot can not be closed / Retry" dialog spams.
;
; electron-builder embeds the same hook macros into BOTH installer.nsh and
; uninstaller.nsh. That means we can't `Call KillInfiniBot` from inside the
; macro body — the uninstaller script can only Call `un.`-prefixed functions
; and that resolution happens at NSIS compile time. The safest pattern is to
; inline the taskkill commands directly inside each macro, so the same body
; works in both contexts.
;
; nsExec::Exec leaves the process exit code on the NSIS stack; Pop $0 throws
; it away because we don't care if the process existed.

!macro KillInfiniBotInline
  nsExec::Exec 'taskkill /F /T /IM "InfiniBot.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "infinibot.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "infinibot-gateway.exe"'
  Pop $0
  Sleep 300
  nsExec::Exec 'taskkill /F /T /IM "InfiniBot.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "infinibot.exe"'
  Pop $0
!macroend

; ── electron-builder hook macros ─────────────────────────────────────────
; customInit fires inside .onInit before any UI renders.
!macro customInit
  !insertmacro KillInfiniBotInline
!macroend

; customCheckAppRunning REPLACES electron-builder's default polite-shutdown
; poll. When this macro is defined, the default loop is skipped — exactly
; what we want for a tray app that ignores WM_CLOSE.
!macro customCheckAppRunning
  !insertmacro KillInfiniBotInline
!macroend

; customInstall fires inside the install Section after files are extracted.
; We seed components.json so the app's components installer knows nothing is
; pre-selected on first launch.
!macro customInstall
  CreateDirectory "$APPDATA\InfiniBot"
  FileOpen $0 "$APPDATA\InfiniBot\components.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "_note": "Component selection. true = requested; the app downloads on first use. Edit via Settings > Components.",$\n'
  FileWrite $0 '  "selected": {$\n'
  FileWrite $0 '    "local-llm": false,$\n'
  FileWrite $0 '    "video": false,$\n'
  FileWrite $0 '    "browser": false,$\n'
  FileWrite $0 '    "image": false,$\n'
  FileWrite $0 '    "federation": false$\n'
  FileWrite $0 '  }$\n'
  FileWrite $0 '}$\n'
  FileClose $0
!macroend

; ── Uninstaller hooks. ──────────────────────────────────────────────────
!macro customUnInit
  !insertmacro KillInfiniBotInline
!macroend

!macro customUnInstall
  !insertmacro KillInfiniBotInline
!macroend
