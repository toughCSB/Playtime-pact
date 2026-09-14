!include "LogicLib.nsh"

; Playtime Pact NSIS 커스텀 매크로
; 설치 시: 관리자 권한 Scheduled Task 등록 + 느리게 스트레칭된 PIN verifier 초기화
; 제거 시: customUnInit에서 PIN 검증 (틀리면 Abort) → customUnInstall에서 정리

; 이전 설치본의 제거기는 PIN/서비스/감시 프로세스 처리 방식이 서로 다르다.
; 새 verifier로 먼저 승인한 뒤 in-place upgrade helper를 제거기로 사용하면
; 제한 언어 모드와 구버전 파일 잠금 버그에 의존하지 않고 안전하게 교체할 수 있다.
!macro customInit
  SetRegView 64
  ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\6491a751-fe68-52d6-bee4-d790b73e3eb9" "DisplayVersion"
  ${If} $R7 == "0.60.8"
  ${OrIf} $R7 == "0.61.0-rc.1"
  ${OrIf} $R7 == "0.61.0-rc.2"
  ${OrIf} $R7 == "0.61.0-rc.3"
  ${OrIf} $R7 == "0.61.0-rc.4"
  ${OrIf} $R7 == "0.61.0-rc.5"
  ${OrIf} $R7 == "0.61.0-rc.6"
  ${OrIf} $R7 == "0.61.0-rc.7"
  ${OrIf} $R7 == "0.61.0-rc.8"
  ${OrIf} $R7 == "0.61.0-rc.9"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=PlaytimePactInstallerAuth.exe "${PROJECT_DIR}\build\native\PlaytimePactInstallerAuth.exe"
    ExecWait '"$PLUGINSDIR\PlaytimePactInstallerAuth.exe" --authorize-upgrade' $R5
    ${If} $R5 != 0
      Abort "Parent PIN authorization was cancelled or failed."
    ${EndIf}
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\6491a751-fe68-52d6-bee4-d790b73e3eb9" "UninstallString" '$\"$PLUGINSDIR\PlaytimePactInstallerAuth.exe$\"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\6491a751-fe68-52d6-bee4-d790b73e3eb9" "QuietUninstallString" '$\"$PLUGINSDIR\PlaytimePactInstallerAuth.exe$\" /S'
  ${EndIf}
!macroend

!macro customInstall
  ; 설치/업데이트 중 기존 watchdog이 앱을 다시 띄워 app.asar 제거를 막지 않도록 먼저 정지
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pact"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "나의 약속"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "My Pact for My Future"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MyPact"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "MyPactForMyFuture"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "MyPact"
  ExecWait 'schtasks /delete /tn "PlaytimePact" /f'
  ExecWait 'schtasks /delete /tn "MyPact" /f'
  ExecWait 'schtasks /delete /tn "MyPactForMyFuture" /f'
  ExecWait 'schtasks /delete /tn "PactWatchdog" /f'
  ExecWait 'taskkill /F /IM "Playtime Pact.exe" /T'
  ExecWait 'taskkill /F /IM "My Pact.exe" /T'
  ExecWait 'taskkill /F /IM "My Pact for My Future.exe" /T'
  ExecWait 'taskkill /F /IM "MyPact.exe" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq PlaytimePactWatchdog" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq MyPactWatchdog" /T'
  ExecWait `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'powershell.exe' -or $$_.Name -eq 'wscript.exe') -and ($$_.CommandLine -like '*watch-loop.ps1*' -or $$_.CommandLine -like '*start-watch-loop.vbs*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ExecWait `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$legacyTaskNames=@('MyPact','MyPactForMyFuture','PactWatchdog'); $$legacyRunNames=@('MyPact','MyPactForMyFuture','My Pact for My Future','Pact','나의 약속'); $$legacyTasksPresent=@($$legacyTaskNames | Where-Object { Get-ScheduledTask -TaskName $$_ -ErrorAction SilentlyContinue }); $$legacyRunPresent=@(); foreach ($$path in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Run','HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')) { foreach ($$name in $$legacyRunNames) { if ($$null -ne (Get-ItemProperty -Path $$path -Name $$name -ErrorAction SilentlyContinue)) { $$legacyRunPresent += $$name } } }; $$legacyProcesses=@(Get-CimInstance Win32_Process | Where-Object { @('My Pact.exe','My Pact for My Future.exe','MyPact.exe') -contains $$_.Name }); if ($$legacyTasksPresent.Count -gt 0 -or $$legacyRunPresent.Count -gt 0 -or $$legacyProcesses.Count -gt 0) { exit 41 }"` $R5
  ${If} $R5 != 0
    MessageBox MB_OK|MB_ICONSTOP "Legacy MyPact remnants are still active. Remove MyPact completely before installing Playtime Pact."
    Abort
  ${EndIf}
  ; HKLM\Run: 모든 사용자 로그온 시 각자 세션에서 watchdog을 띄워 앱을 시작/재시작
  ; Start the interactive timer directly for every signed-in user. Some managed
  ; Windows accounts block WSH/VBS, which previously prevented the app from
  ; appearing even though the machine-wide installation itself was present.
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact" '"$INSTDIR\Playtime Pact.exe" --start-hidden'
  ; Scheduled Task: 관리자 세션용 HIGHEST watchdog 보조
  ExecWait 'schtasks /create /tn "PlaytimePact" /tr "wscript.exe //B //Nologo \"$INSTDIR\resources\resources\start-watch-loop.vbs\"" /sc onlogon /rl HIGHEST /delay 0000:10 /f'
  ExecWait `cmd.exe /c mkdir C:\ProgramData\PlaytimePact C:\ProgramData\PlaytimePact\Admin C:\ProgramData\PlaytimePact\Data 2>nul`
  Delete "C:\ProgramData\PlaytimePact\watchdog-disabled.flag"
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)M /C`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\settings*.json /inheritance:e /grant:r *S-1-5-18:F *S-1-5-32-544:F *S-1-5-32-545:M /C`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\Admin /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /T /C`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\Data /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)M /T /C`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\Data\*.json /inheritance:e /grant:r *S-1-5-18:F *S-1-5-32-544:F *S-1-5-32-545:M /C`
  ExecWait `cmd.exe /c mkdir C:\ProgramData\PlaytimePact\Broker C:\ProgramData\PlaytimePact\Broker\Accounting 2>nul`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\Broker /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /T /C`
  ; Repair protected usage files as LocalSystem. Existing versions could leave a
  ; child file with an ACL that neither the service nor elevated installer could replace.
  ExecWait '"$INSTDIR\resources\PlaytimePactInstallerAuth.exe" --repair-protection' $R5
  ${If} $R5 != 0
    MessageBox MB_OK|MB_ICONSTOP "Protected usage permissions could not be repaired. No protected data was removed."
    Abort
  ${EndIf}
  ExecWait `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$p='C:\ProgramData\PlaytimePact\Admin\admin-secret.json'; $$default='9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0'; $$rewrite=$$false; if (!(Test-Path -LiteralPath $$p)) { $$rewrite=$$true } else { try { $$parsed=Get-Content -LiteralPath $$p -Raw | ConvertFrom-Json } catch { $$parsed=$$null }; if ($$null -ne $$parsed -and $$parsed.adminPasswordHash -eq $$default) { $$rewrite=$$true } }; if ($$rewrite) { $$salt=New-Object byte[] 16; $$rng=[System.Security.Cryptography.RNGCryptoServiceProvider]::new(); $$rng.GetBytes($$salt); $$rng.Dispose(); $$derive=[System.Security.Cryptography.Rfc2898DeriveBytes]::new('0000',$$salt,1500000,[System.Security.Cryptography.HashAlgorithmName]::SHA256); $$hash=($$derive.GetBytes(32) | ForEach-Object { $$_.ToString('x2') }) -join ''; $$derive.Dispose(); $$secret=[ordered]@{ schemaVersion=1; algorithm='pbkdf2-sha256'; iterations=1500000; salt=[Convert]::ToBase64String($$salt); hash=$$hash } | ConvertTo-Json -Compress; [System.IO.File]::WriteAllText($$p,$$secret,[System.Text.UTF8Encoding]::new($$false)) }"`
  ExecWait `icacls.exe C:\ProgramData\PlaytimePact\Admin\admin-secret.json /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F /C`
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" stop'
  CopyFiles /SILENT "$INSTDIR\resources\app.asar.unpacked\node_modules\node-windows\bin\winsw\winsw.exe" "$INSTDIR\PlaytimePactPrivilegedBroker.exe"
  CopyFiles /SILENT "$INSTDIR\resources\app.asar.unpacked\node_modules\node-windows\bin\winsw\winsw.exe.config" "$INSTDIR\PlaytimePactPrivilegedBroker.exe.config"
  FileOpen $R1 "$INSTDIR\PlaytimePactPrivilegedBroker.xml" w
  FileWrite $R1 '<?xml version="1.0" encoding="UTF-8"?>$\r$\n'
  FileWrite $R1 '<service>$\r$\n'
  FileWrite $R1 '  <id>PlaytimePactPrivilegedBroker</id>$\r$\n'
  FileWrite $R1 '  <name>Playtime Pact Privileged Broker</name>$\r$\n'
  FileWrite $R1 '  <description>Protected accounting and enforcement broker for Playtime Pact.</description>$\r$\n'
  FileWrite $R1 '  <executable>$INSTDIR\Playtime Pact.exe</executable>$\r$\n'
  ; Keep the explicit bootstrap flag on the SYSTEM service. The protected
  ; usage initializer is idempotent once the store exists, and only SYSTEM
  ; can migrate the legacy SYSTEM-only HMAC record without weakening its ACL.
  FileWrite $R1 '  <arguments>--privileged-broker-service --initialize-local-protection</arguments>$\r$\n'
  FileWrite $R1 '  <serviceaccount>$\r$\n'
  FileWrite $R1 '    <domain>NT AUTHORITY</domain>$\r$\n'
  FileWrite $R1 '    <user>SYSTEM</user>$\r$\n'
  FileWrite $R1 '  </serviceaccount>$\r$\n'
  FileWrite $R1 '  <startmode>Automatic</startmode>$\r$\n'
  FileWrite $R1 '  <stoptimeout>15sec</stoptimeout>$\r$\n'
  FileWrite $R1 '  <onfailure action="restart" delay="5 sec" />$\r$\n'
  FileWrite $R1 '</service>$\r$\n'
  FileClose $R1
  nsExec::ExecToStack 'sc.exe query PlaytimePactPrivilegedBroker'
  Pop $R4
  Pop $R3
  ${If} $R4 != 0
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" install' $R5
    ${If} $R5 != 0
      MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service could not be installed."
      Abort
    ${EndIf}
  ${Else}
    ; Re-register the existing WinSW service on upgrades so the SYSTEM
    ; bootstrap argument in the adjacent XML is applied as well.
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall' $R5
    ${If} $R5 != 0
      MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service could not be re-registered."
      Abort
    ${EndIf}
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" install' $R5
    ${If} $R5 != 0
      MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service could not be re-installed."
      Abort
    ${EndIf}
  ${EndIf}
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" start' $R5
  ${If} $R5 != 0
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall'
    MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service could not be started."
    Abort
  ${EndIf}
  ; Cold Electron/service startup may outlast the first named-pipe connection.
  ; Retry readiness, not authentication, and retain the diagnostic if it fails.
  StrCpy $R6 0
  ppt_readiness_retry:
    nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\Playtime Pact.exe" --protection-readiness-check'
    Pop $R5
    Pop $R4
    IntOp $R6 $R6 + 1
    ${If} $R5 != 0
    ${AndIf} $R6 < 5
      Sleep 1500
      Goto ppt_readiness_retry
    ${EndIf}
  ${If} $R5 != 0
    FileOpen $R1 "C:\ProgramData\PlaytimePact\install-health.log" w
    FileWrite $R1 'Readiness exit: $R5$\r$\n$R4$\r$\n'
    FileClose $R1
    ; Keep the service registered: its first start may still be completing.
    ; A later repair/uninstall must not be stranded by a missing service.
    MessageBox MB_OK|MB_ICONSTOP "Playtime Pact protection is not ready. Installation is not complete.$\r$\nDiagnostic: $R4$\r$\nSaved to C:\ProgramData\PlaytimePact\install-health.log. Restart Windows and retry this installer."
    Abort
  ${EndIf}
!macroend

; 제거 시작 전 PIN 검증 — electron-builder un.onInit 내부에서 customUnInit 호출됨
; 여기서 Abort하면 파일 삭제 전에 완전 취소됨
!macro customUnInit
  ; PowerShell language mode와 무관한 native verifier가 보호된 PIN verifier를 읽는다.
  ExecWait '"$INSTDIR\resources\PlaytimePactInstallerAuth.exe" --verify' $R3
  ${If} $R3 != 0
    MessageBox MB_OK|MB_ICONSTOP "PIN verification failed. Uninstall cancelled."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ; Stop execution reversibly. Keep service registration and policy selectors
  ; until the file move has succeeded, so a lock cannot strand the installation.
  IfFileExists "C:\ProgramData\PlaytimePact\watchdog-disabled.flag" 0 +2
    CopyFiles /SILENT "C:\ProgramData\PlaytimePact\watchdog-disabled.flag" "$PLUGINSDIR\previous-watchdog-disabled.flag"
  FileOpen $R1 "C:\ProgramData\PlaytimePact\watchdog-disabled.flag" w
  FileWrite $R1 'uninstall'
  FileClose $R1
  ; sc.exe reports 1062 when an existing service is already stopped. That is
  ; a successful uninstall precondition, not a protection failure.
  ExecWait 'sc.exe stop PlaytimePactPrivilegedBroker' $R3
  ${If} $R3 == 1060
    StrCpy $R3 0
  ${ElseIf} $R3 == 1062
    StrCpy $R3 0
  ${ElseIf} $R3 != 0
    ; WinSW remains a fallback for unusual service-control failures.
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" stop' $R3
  ${Else}
    ; Allow a normal STOP_PENDING transition to release file handles.
    Sleep 1500
  ${EndIf}
  ${If} $R3 != 0
    Delete "C:\ProgramData\PlaytimePact\watchdog-disabled.flag"
    IfFileExists "$PLUGINSDIR\previous-watchdog-disabled.flag" 0 +2
      CopyFiles /SILENT "$PLUGINSDIR\previous-watchdog-disabled.flag" "C:\ProgramData\PlaytimePact\watchdog-disabled.flag"
    MessageBox MB_OK|MB_ICONSTOP "The protection service could not be stopped. No installation files were removed."
    Abort "Protection service stop failed."
  ${EndIf}
  ExecWait 'taskkill /F /IM "Playtime Pact.exe" /T'
!macroend

!macro customRemoveFiles
  ; Stage files before irreversible cleanup (also for explicit uninstall).
  CreateDirectory "$PLUGINSDIR\old-install"
  Push ""
  Call un.atomicRMDir
  Pop $R0
  ${If} $R0 != 0
    StrCpy $R2 $R0
    Push ""
    Call un.restoreFiles
    Pop $R0
    Delete "C:\ProgramData\PlaytimePact\watchdog-disabled.flag"
    IfFileExists "$PLUGINSDIR\previous-watchdog-disabled.flag" 0 +2
      CopyFiles /SILENT "$PLUGINSDIR\previous-watchdog-disabled.flag" "C:\ProgramData\PlaytimePact\watchdog-disabled.flag"
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" start' $R3
    ${If} $R3 == 0
      nsExec::ExecToStack '"$INSTDIR\Playtime Pact.exe" --protection-readiness-check'
      Pop $R3
      Pop $R4
    ${EndIf}
    ${If} $R3 == 0
      ${IfNot} ${FileExists} "$PLUGINSDIR\previous-watchdog-disabled.flag"
        ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\Playtime Pact.exe" "open" "--hidden"
      ${EndIf}
      MessageBox MB_OK|MB_ICONSTOP "A file is in use: $R2$\r$\nThe protection service passed its readiness check after recovery. Installation was cancelled; close the application holding this file before retrying."
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "A file is in use: $R2$\r$\nAutomatic recovery did not pass the protection readiness check. The installation is NOT complete. Keep this window open and request repair."
    ${EndIf}
    Abort "Installation files are in use."
  ${EndIf}
  ; The wrapper is now in staging. sc deletes only this verified service entry;
  ; existing protected policy/usage/PIN data and selectors are never removed.
  ExecWait 'sc.exe delete PlaytimePactPrivilegedBroker' $R3
  ${If} $R3 == 1060
    StrCpy $R3 0
  ${EndIf}
  ${If} $R3 != 0
    Push ""
    Call un.restoreFiles
    Pop $R0
    MessageBox MB_OK|MB_ICONSTOP "The service could not be unregistered. Installation was stopped and file restoration was attempted. Protection requires a repair check."
    Abort "Protection service removal failed."
  ${EndIf}
  ExecWait 'schtasks /delete /tn "PlaytimePact" /f'
  ExecWait 'schtasks /delete /tn "MyPact" /f'
  ExecWait 'schtasks /delete /tn "MyPactForMyFuture" /f'
  ExecWait 'schtasks /delete /tn "PactWatchdog" /f'
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "MyPact"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "MyPactForMyFuture"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MyPact"
  ExecWait 'taskkill /F /IM "Playtime Pact.exe" /T'
  ExecWait 'taskkill /F /IM "My Pact.exe" /T'
  ExecWait 'taskkill /F /IM "My Pact for My Future.exe" /T'
  ExecWait 'taskkill /F /IM "MyPact.exe" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq PlaytimePactWatchdog" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq MyPactWatchdog" /T'
  ExecWait `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'powershell.exe' -or $$_.Name -eq 'wscript.exe') -and ($$_.CommandLine -like '*watch-loop.ps1*' -or $$_.CommandLine -like '*start-watch-loop.vbs*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ; Do not delete Software\PlaytimePact: it contains PolicySelectors.
  DeleteRegKey HKLM "Software\MyPact"
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend
