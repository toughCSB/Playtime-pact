Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set network = CreateObject("WScript.Network")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.GetParentFolderName(fso.GetParentFolderName(scriptDir))
appPath = fso.BuildPath(appDir, "Playtime Pact.exe")
disabledPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%ProgramData%"), "PlaytimePact\watchdog-disabled.flag")
currentUser = LCase(network.UserName)
currentDomain = LCase(network.UserDomain)
lockPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "PlaytimePactWatchdog-" & currentDomain & "-" & currentUser & ".lock")

Function MatchingWatchdogCount()
  MatchingWatchdogCount = 0
  escapedScript = Replace(LCase(WScript.ScriptFullName), "\", "\\")
  For Each process In wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'wscript.exe'")
    commandLine = LCase("" & process.CommandLine)
    If InStr(commandLine, LCase(WScript.ScriptFullName)) > 0 Then
      MatchingWatchdogCount = MatchingWatchdogCount + 1
    End If
  Next
End Function

On Error Resume Next
fso.CreateFolder lockPath
If Err.Number <> 0 Then
  Err.Clear
  If MatchingWatchdogCount() > 1 Then
    WScript.Quit 0
  End If
  fso.DeleteFolder lockPath, True
  fso.CreateFolder lockPath
  If Err.Number <> 0 Then
    WScript.Quit 0
  End If
End If
On Error GoTo 0

Function IsPlaytimePactRunning()
  IsPlaytimePactRunning = False

  For Each process In wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'Playtime Pact.exe'")
    ownerUser = ""
    ownerDomain = ""
    If process.GetOwner(ownerUser, ownerDomain) = 0 Then
      If LCase(ownerUser) = currentUser And LCase(ownerDomain) = currentDomain Then
        IsPlaytimePactRunning = True
        Exit Function
      End If
    End If
  Next
End Function

Sub EnsurePlaytimePactRunning()
  If fso.FileExists(disabledPath) Then
    WScript.Quit 0
  End If

  If Not IsPlaytimePactRunning() And fso.FileExists(appPath) Then
    shell.Run """" & appPath & """ --from-watchdog --start-hidden", 0, False
  End If
End Sub

EnsurePlaytimePactRunning

Do
  WScript.Sleep 3000
  EnsurePlaytimePactRunning
Loop
