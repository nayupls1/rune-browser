; Registers Rune Browser as a web browser on Windows (electron-builder includes
; this file in the installer): it's listed in Default apps for links (http,
; https) and web files, and offered in "Open with". Windows lets only the user
; make it the default (Settings > Web tabs > Default browser opens that page;
; src/main/defaultBrowser.ts). Links and files open as `rune-browser.exe -- "<link>"`:
; after `--`, nothing in a link can be taken for a switch of Chromium's.
; Uninstalling removes all of it (not an update: that would reset the user's choice).
; The names are in src/shared/defaultBrowser.ts (a test keeps them in step).

!define RUNE_PROG_ID "RuneBrowserHTML"
!define RUNE_CLIENT_KEY "Software\Clients\StartMenuInternet\Rune Browser"
!define RUNE_REGISTERED_NAME "Rune Browser"

!macro runeAddFileType EXT
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities\FileAssociations" ".${EXT}" "${RUNE_PROG_ID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${RUNE_PROG_ID}" ""
!macroend

!macro runeRemoveFileType EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${RUNE_PROG_ID}"
!macroend

!macro customInstall
  ; What links and web files open with.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}" "" "Rune Browser HTML Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}" "FriendlyTypeName" "Rune Browser HTML Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\Application" "ApplicationName" "Rune Browser"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\Application" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\Application" "ApplicationCompany" "nayupls1"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\Application" "AppUserModelId" "${APP_ID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}\shell\open\command" "" '"$appExe" -- "%1"'

  ; The browser, and what it can open.
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}" "" "Rune Browser"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\shell\open\command" "" '"$appExe"'
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities" "ApplicationName" "Rune Browser"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities" "ApplicationDescription" "${APP_DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities\StartMenu" "StartMenuInternet" "Rune Browser"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities\URLAssociations" "http" "${RUNE_PROG_ID}"
  WriteRegStr SHELL_CONTEXT "${RUNE_CLIENT_KEY}\Capabilities\URLAssociations" "https" "${RUNE_PROG_ID}"
  !insertmacro runeAddFileType "html"
  !insertmacro runeAddFileType "htm"
  !insertmacro runeAddFileType "xhtml"
  !insertmacro runeAddFileType "shtml"
  !insertmacro runeAddFileType "pdf"
  !insertmacro runeAddFileType "svg"
  !insertmacro runeAddFileType "webp"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${RUNE_REGISTERED_NAME}" "${RUNE_CLIENT_KEY}\Capabilities"

  ; Explorer and Default apps pick it up.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${RUNE_REGISTERED_NAME}"
    DeleteRegKey SHELL_CONTEXT "${RUNE_CLIENT_KEY}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${RUNE_PROG_ID}"
    !insertmacro runeRemoveFileType "html"
    !insertmacro runeRemoveFileType "htm"
    !insertmacro runeRemoveFileType "xhtml"
    !insertmacro runeRemoveFileType "shtml"
    !insertmacro runeRemoveFileType "pdf"
    !insertmacro runeRemoveFileType "svg"
    !insertmacro runeRemoveFileType "webp"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
