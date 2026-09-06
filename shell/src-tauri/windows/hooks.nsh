; Noobty NSIS hooks — keep receive folder; clear shell config + autostart on uninstall.
!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; App config (hub URL, auto-accept, download_dir preference)
  RMDir /r "$APPDATA\noobty-shell"
  ; tauri-plugin-autostart registers under product name
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Noobty"
!macroend
