!include "LogicLib.nsh"

; Playtime Pact NSIS 커스텀 매크로
; 설치 시: 관리자 권한 Scheduled Task 등록 + 느리게 스트레칭된 PIN verifier 초기화
; 제거 시: customUnInit에서 PIN 검증 (틀리면 Abort) → customUnInstall에서 정리

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
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "PlaytimePact" 'wscript.exe //B //Nologo "$INSTDIR\resources\resources\start-watch-loop.vbs"'
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
  FileWrite $R1 '  <arguments>--privileged-broker-service</arguments>$\r$\n'
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
  ${EndIf}
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" start' $R5
  ${If} $R5 != 0
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall'
    MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service could not be started."
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$INSTDIR\Playtime Pact.exe" --privileged-broker-health-check'
  Pop $R5
  Pop $R4
  ${If} $R5 != 0
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" stop'
    ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall'
    MessageBox MB_OK|MB_ICONSTOP "The protected Playtime Pact service failed its IPC health check."
    Abort
  ${EndIf}
!macroend

; 제거 시작 전 PIN 검증 — electron-builder un.onInit 내부에서 customUnInit 호출됨
; 여기서 Abort하면 파일 삭제 전에 완전 취소됨
!macro customUnInit
  ; 보호된 C:\ProgramData\PlaytimePact\Admin\admin-secret.json의 PIN verifier와 입력 PIN을 비교한다.
  ; PIN 원문은 레지스트리에 저장하지 않는다.
  GetTempFileName $R0
  Rename $R0 "$R0.ps1"
  StrCpy $R0 "$R0.ps1"

  FileOpen $R1 $R0 w
  FileWrite $R1 'Add-Type -AssemblyName Microsoft.VisualBasic$\r$\n'
  FileWrite $R1 '$$pin=[Microsoft.VisualBasic.Interaction]::InputBox("Enter admin PIN to uninstall Playtime Pact.","Playtime Pact - Uninstall","")$\r$\n'
  FileWrite $R1 '$$root=[Environment]::GetFolderPath("CommonApplicationData")$\r$\n'
  FileWrite $R1 '$$secret=Join-Path $$root "PlaytimePact\Admin\admin-secret.json"$\r$\n'
  FileWrite $R1 'if (!(Test-Path -LiteralPath $$secret)) { exit 2 }$\r$\n'
  FileWrite $R1 '$$parsed=Get-Content -LiteralPath $$secret -Raw | ConvertFrom-Json$\r$\n'
  FileWrite $R1 'if ($$parsed.schemaVersion -eq 1 -and $$parsed.algorithm -eq "pbkdf2-sha256") { try { $$salt=[Convert]::FromBase64String([string]$$parsed.salt) } catch { exit 3 }; $$iterations=[int]$$parsed.iterations; $$expected=[string]$$parsed.hash; if ($$iterations -lt 100000 -or !($$expected -match "^[0-9a-f]{64}$$")) { exit 3 }; $$derive=[System.Security.Cryptography.Rfc2898DeriveBytes]::new($$pin,$$salt,$$iterations,[System.Security.Cryptography.HashAlgorithmName]::SHA256); $$actual=($$derive.GetBytes(32) | ForEach-Object { $$_.ToString("x2") }) -join ""; $$derive.Dispose(); if ($$actual -ne $$expected) { exit 4 }; exit 0 }$\r$\n'
  FileWrite $R1 '$$expected=[string]$$parsed.adminPasswordHash$\r$\n'
  FileWrite $R1 'if (!($$expected -match "^[0-9a-f]{64}$$")) { exit 3 }$\r$\n'
  FileWrite $R1 '$$sha=[System.Security.Cryptography.SHA256]::Create()$\r$\n'
  FileWrite $R1 '$$bytes=[Text.Encoding]::UTF8.GetBytes($$pin)$\r$\n'
  FileWrite $R1 '$$actual=($$sha.ComputeHash($$bytes) | ForEach-Object { $$_.ToString("x2") }) -join ""$\r$\n'
  FileWrite $R1 'if ($$actual -ne $$expected) { exit 4 }$\r$\n'
  FileClose $R1

  nsExec::ExecToStack '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$R0"'
  Pop $R3
  Pop $R4
  Delete $R0

  ${If} $R3 != 0
    MessageBox MB_OK|MB_ICONSTOP "PIN verification failed. Uninstall cancelled."
    Abort
  ${EndIf}
  FileOpen $R1 "C:\ProgramData\PlaytimePact\watchdog-disabled.flag" w
  FileWrite $R1 'uninstall'
  FileClose $R1
  ExecWait 'schtasks /delete /tn "PlaytimePact" /f'
  ExecWait 'schtasks /delete /tn "MyPact" /f'
  ExecWait 'schtasks /delete /tn "MyPactForMyFuture" /f'
  ExecWait 'taskkill /F /IM "Playtime Pact.exe" /T'
  ExecWait 'taskkill /F /IM "My Pact.exe" /T'
  ExecWait 'taskkill /F /IM "MyPact.exe" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq PlaytimePactWatchdog" /T'
  ExecWait 'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq MyPactWatchdog" /T'
  ExecWait `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($$_.Name -eq 'powershell.exe' -or $$_.Name -eq 'wscript.exe') -and ($$_.CommandLine -like '*watch-loop.ps1*' -or $$_.CommandLine -like '*start-watch-loop.vbs*') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" stop'
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall'
!macroend

!macro customUnInstall
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
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" stop'
  ExecWait '"$INSTDIR\PlaytimePactPrivilegedBroker.exe" uninstall'
  Delete "$INSTDIR\PlaytimePactPrivilegedBroker.xml"
  Delete "$INSTDIR\PlaytimePactPrivilegedBroker.exe"
  Delete "$INSTDIR\PlaytimePactPrivilegedBroker.exe.config"
  DeleteRegKey HKLM "Software\PlaytimePact"
  DeleteRegKey HKLM "Software\MyPact"
!macroend
