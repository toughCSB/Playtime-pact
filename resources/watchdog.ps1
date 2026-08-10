$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Split-Path (Split-Path $scriptDir -Parent) -Parent
$appPath = Join-Path $appDir "Playtime Pact.exe"
$sessionId = (Get-Process -Id $PID).SessionId

if (-not (Get-Process -Name "Playtime Pact" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId })) {
    if (Test-Path $appPath) {
        Start-Process -FilePath $appPath -ArgumentList "--from-watchdog --start-hidden"
    }
}
