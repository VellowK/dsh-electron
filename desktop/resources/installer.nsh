; Custom NSIS hooks — electron-builder auto-includes <buildResources>/installer.nsh.
; Adds a launch shortcut inside the install directory, in addition to the
; desktop + start-menu shortcuts electron-builder already creates. The shortcut
; is cleaned up automatically on uninstall (the uninstaller `RMDir /r $INSTDIR`).
!macro customInstall
  CreateShortCut "$INSTDIR\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend
