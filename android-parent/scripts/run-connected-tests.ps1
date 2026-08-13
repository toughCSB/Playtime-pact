<#
.SYNOPSIS
  Deterministic Android connected-test runner for the Playtime Pact parent app.

.DESCRIPTION
  Boots a clean API 36 emulator, proves the device is unlocked and credential-ready,
  installs the app plus test APKs from scratch and runs the full connected
  instrumentation suite in a single invocation.

  The emulator-only device PIN is read from PLAYTIME_PACT_TEST_DEVICE_PIN when supplied;
  otherwise this process generates a cryptographically random ephemeral PIN. It is never
  accepted as a parameter, placed in a command line, persisted, or written to stdout,
  stderr, or the JSON report. The credential is always cleared in the finally block.

  Readiness is driven by exact Android state signals only. There are no fixed sleeps,
  no polling delays and no retry-until-time loops: `adb wait-for-device` blocks until the
  daemon sees the device, and each subsequent gate reads a single authoritative signal.

.PARAMETER AvdName
  The AVD to boot. The supported configuration is PlaytimePactApi36.

.PARAMETER VerifyLockedFailure
  Deliberately leaves the keyguard locked so the preflight gate rejects the device
  before any instrumentation starts, then clears the test credential.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$AvdName,

  [switch]$VerifyLockedFailure
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ExpectedAvdName = 'PlaytimePactApi36'
$ExpectedSystemImage = 'system-images;android-36;google_apis;x86_64'
$ExpectedApiLevel = 36
$RequiredJdkFeatureVersion = 17
$ApplicationId = 'com.playtimepact.parent'
$TestApplicationId = 'com.playtimepact.parent.test'
$GradleConnectedTask = ':app:connectedDebugAndroidTest'
$MinimumConnectedTests = 21

$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AndroidProjectRoot = Join-Path $RepositoryRoot 'android-parent'
$EvidenceRoot = Join-Path $RepositoryRoot '.omo/evidence/project-completion/W3-T3'

$script:EmulatorProcess = $null
$script:CredentialArmed = $false
$script:CredentialClearExitCode = $null
$script:CredentialClearClassification = $null
$script:CredentialRemovalVerified = $false
$script:DeviceCredential = $null
$script:DeviceCredentialSource = $null
$script:DeviceSerial = $null
$script:DeviceDisconnectObserved = $false
$script:DeviceDisconnectWaitExitCode = $null
$script:Adb = $null

function Fail([string]$Code, [string]$Message) { throw "$Code`: $Message" }

# Windows PowerShell 5.1 runs on .NET Framework, which has no ProcessStartInfo.ArgumentList,
# so arguments are quoted explicitly using the documented Windows CommandLineToArgvW rules.
function ConvertTo-CommandLine {
  param([string[]]$Arguments = @())
  $quoted = foreach ($argument in $Arguments) {
    $value = [string]$argument
    if ($value -eq '') { '""'; continue }
    if ($value -notmatch '[\s"]') { $value; continue }
    $escaped = $value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    '"' + $escaped + '"'
  }
  return ($quoted -join ' ')
}

function Write-Note([string]$Message) { Write-Host $Message }

# ---------------------------------------------------------------------------
# Toolchain discovery
# ---------------------------------------------------------------------------

function Resolve-AndroidSdkRoot {
  $candidates = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path -LiteralPath (Join-Path $candidate 'platform-tools\adb.exe')) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  Fail 'PRECONDITION_SDK_MISSING' 'Could not locate an Android SDK containing platform-tools\adb.exe'
}

# Locates an already-installed JDK 17. This never downloads or installs anything and
# never silently substitutes a different major version.
function Resolve-Jdk17Home {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($explicit in @($env:PLAYTIME_PACT_JDK17_HOME, $env:JAVA_HOME_17_X64, $env:JAVA_HOME)) {
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { $candidates.Add($explicit) }
  }
  $roots = @(
    (Join-Path $env:ProgramFiles 'Microsoft'),
    (Join-Path $env:ProgramFiles 'Eclipse Adoptium'),
    (Join-Path $env:ProgramFiles 'Java'),
    (Join-Path $env:ProgramFiles 'Amazon Corretto'),
    (Join-Path $env:ProgramFiles 'Zulu'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium'),
    (Join-Path $env:USERPROFILE '.jdks')
  )
  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { continue }
    foreach ($directory in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $candidates.Add($directory.FullName)
    }
  }

  foreach ($candidate in $candidates) {
    $releaseFile = Join-Path $candidate 'release'
    $javac = Join-Path $candidate 'bin\javac.exe'
    if (-not (Test-Path -LiteralPath $releaseFile) -or -not (Test-Path -LiteralPath $javac)) { continue }
    $versionLine = Select-String -LiteralPath $releaseFile -Pattern '^JAVA_VERSION="([^"]+)"' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $versionLine) { continue }
    $version = $versionLine.Matches[0].Groups[1].Value
    $feature = ($version -split '[._-]')[0]
    if ([int]$feature -eq $RequiredJdkFeatureVersion) {
      return [pscustomobject]@{ Home = (Resolve-Path -LiteralPath $candidate).Path; Version = $version }
    }
  }
  Fail 'PRECONDITION_JDK17_MISSING' "No installed JDK $RequiredJdkFeatureVersion was found. Install one and expose it via PLAYTIME_PACT_JDK17_HOME or JAVA_HOME."
}

# ---------------------------------------------------------------------------
# Bounded process control (event driven, never time driven)
# ---------------------------------------------------------------------------

# Runs a console tool to completion and captures both streams. Completion is awaited on
# the process exit event, so there is no polling and no wait-for-time pattern.
function Invoke-Tool {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory,
    [hashtable]$Environment = @{},
    [string]$StandardInputText,
    [int]$TimeoutSeconds = 300,
    [switch]$AllowFailure
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = ConvertTo-CommandLine -Arguments $Arguments
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardInput = $null -ne $StandardInputText
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
  foreach ($key in $Environment.Keys) { $startInfo.EnvironmentVariables[$key] = [string]$Environment[$key] }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $null = $process.Start()
  # Read both pipes asynchronously so a full buffer can never deadlock the child.
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if ($null -ne $StandardInputText) {
    $process.StandardInput.WriteLine($StandardInputText)
    $process.StandardInput.Close()
  }
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    $null = Invoke-Tool -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -Arguments @('/PID', [string]$process.Id, '/T', '/F') -TimeoutSeconds 30 -AllowFailure
    $process.WaitForExit()
    $process.Dispose()
    Fail 'TOOL_TIMEOUT' "$(Split-Path -Leaf $FilePath) did not exit within the bounded $TimeoutSeconds-second deadline"
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $process.Dispose()

  $result = [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = $stdout.Trim()
    StdErr = $stderr.Trim()
  }
  if (-not $AllowFailure -and $exitCode -ne 0) {
    $detail = if ($result.StdErr) { $result.StdErr } else { $result.StdOut }
    Fail 'TOOL_FAILED' ("{0} exited with {1}: {2}" -f (Split-Path -Leaf $FilePath), $exitCode, $detail)
  }
  return $result
}

function Invoke-Adb {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$AllowFailure)
  $full = @()
  if ($script:DeviceSerial) { $full += @('-s', $script:DeviceSerial) }
  $full += $Arguments
  return Invoke-Tool -FilePath $script:Adb -Arguments $full -AllowFailure:$AllowFailure
}

function Invoke-AdbShell {
  param([Parameter(Mandatory = $true)][string]$Command, [switch]$AllowFailure)
  return Invoke-Adb -Arguments @('shell', $Command) -AllowFailure:$AllowFailure
}

# ---------------------------------------------------------------------------
# Emulator lifecycle
# ---------------------------------------------------------------------------

function Assert-AvdIsSupported {
  param([Parameter(Mandatory = $true)][string]$SdkRoot)

  if ($AvdName -cne $ExpectedAvdName) {
    Fail 'PRECONDITION_AVD_UNSUPPORTED' "Only the standardized AVD '$ExpectedAvdName' is supported, received '$AvdName'"
  }

  $emulator = Join-Path $SdkRoot 'emulator\emulator.exe'
  if (-not (Test-Path -LiteralPath $emulator)) { Fail 'PRECONDITION_EMULATOR_MISSING' "Emulator binary not found at $emulator" }

  $listed = Invoke-Tool -FilePath $emulator -Arguments @('-list-avds') -AllowFailure
  $names = @($listed.StdOut -split '\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($names -notcontains $AvdName) {
    Fail 'PRECONDITION_AVD_MISSING' "AVD '$AvdName' is not registered. Known AVDs: $($names -join ', ')"
  }

  $avdHome = if ($env:ANDROID_AVD_HOME) { $env:ANDROID_AVD_HOME } else { Join-Path $env:USERPROFILE '.android\avd' }
  $configPath = Join-Path $avdHome "$AvdName.avd\config.ini"
  if (-not (Test-Path -LiteralPath $configPath)) { Fail 'PRECONDITION_AVD_CONFIG_MISSING' "AVD config not found at $configPath" }

  $config = @{}
  foreach ($line in (Get-Content -LiteralPath $configPath)) {
    if ($line -match '^\s*([^=#]+?)\s*=\s*(.*)$') { $config[$Matches[1]] = $Matches[2].Trim() }
  }
  $sysdir = if ($config.ContainsKey('image.sysdir.1')) { $config['image.sysdir.1'] } else { '' }
  $normalized = ($sysdir.TrimEnd('\', '/') -replace '[\\/]', ';')
  if ($normalized -cne $ExpectedSystemImage) {
    Fail 'PRECONDITION_AVD_IMAGE_MISMATCH' "AVD '$AvdName' uses image '$normalized' but '$ExpectedSystemImage' is required"
  }

  $imagePath = Join-Path $SdkRoot ($sysdir -replace '[\\/]', [IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $imagePath)) {
    Fail 'PRECONDITION_SYSTEM_IMAGE_MISSING' "System image '$ExpectedSystemImage' is not installed at $imagePath"
  }

  return [pscustomobject]@{ Emulator = $emulator; SystemImage = $ExpectedSystemImage; ConfigPath = $configPath }
}

# Boots the AVD with a wiped data partition and snapshots fully disabled.
function Start-CleanEmulator {
  param([Parameter(Mandatory = $true)][string]$EmulatorPath)

  $arguments = @(
    '-avd', $AvdName,
    '-wipe-data',
    '-no-snapshot',
    '-no-snapshot-load',
    '-no-snapshot-save',
    '-no-boot-anim',
    '-netdelay', 'none',
    '-netspeed', 'full'
  )
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $EmulatorPath
  $startInfo.Arguments = ConvertTo-CommandLine -Arguments $arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $null = $process.Start()
  # Drain the emulator pipes so the child can never block on a full buffer.
  $null = $process.StandardOutput.ReadToEndAsync()
  $null = $process.StandardError.ReadToEndAsync()
  $script:EmulatorProcess = $process
  return $process
}

function Get-ManagedEmulatorProcesses {
  # Preflight permits no emulator process, so every matching process after launch belongs
  # to this run. Include qemu teardown helpers whose command line no longer names the AVD.
  return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @('emulator.exe', 'qemu-system-x86_64.exe')
  })
}

function Start-DeviceDisconnectWait {
  if (-not $script:DeviceSerial) { return $null }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $script:Adb
  $startInfo.Arguments = ConvertTo-CommandLine -Arguments @('-s', $script:DeviceSerial, 'wait-for-disconnect')
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $waiter = New-Object System.Diagnostics.Process
  $waiter.StartInfo = $startInfo
  $null = $waiter.Start()
  $null = $waiter.StandardOutput.ReadToEndAsync()
  $null = $waiter.StandardError.ReadToEndAsync()
  return $waiter
}

function Stop-Emulator {
  $process = $script:EmulatorProcess
  if (-not $process) { return $true }

  # Subscribe to adb's exact disconnect state before triggering emulator shutdown.
  $disconnectWaiter = Start-DeviceDisconnectWait
  if (-not $process.HasExited) {
    if ($script:DeviceSerial) { $null = Invoke-Adb -Arguments @('emu', 'kill') -AllowFailure }
    if (-not $process.WaitForExit(30000)) {
      $null = Invoke-Tool -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -Arguments @('/PID', [string]$process.Id, '/T', '/F') -TimeoutSeconds 30 -AllowFailure
      if (-not $process.WaitForExit(30000)) { Fail 'EMULATOR_STOP_TIMEOUT' 'The managed emulator process did not emit its exit signal after forced teardown' }
    }
  }
  $processExited = $process.HasExited
  $process.Dispose()
  $script:EmulatorProcess = $null

  # emulator shutdown can leave a short-lived qemu teardown helper. Do not sample residue
  # while it is alive: terminate every process owned by this run and await each exit signal.
  $helperProcessesExited = $true
  foreach ($entry in @(Get-ManagedEmulatorProcesses)) {
    try {
      $helper = [System.Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)
      if (-not $helper.HasExited) {
        $null = Invoke-Tool -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -Arguments @('/PID', [string]$helper.Id, '/T', '/F') -TimeoutSeconds 30 -AllowFailure
        if (-not $helper.WaitForExit(30000)) { $helperProcessesExited = $false }
      }
      $helper.Dispose()
    } catch [System.ArgumentException] {
      # The process exited between the authoritative process snapshot and event handle open.
    }
  }

  if ($disconnectWaiter) {
    if ($disconnectWaiter.WaitForExit(30000)) {
      $script:DeviceDisconnectWaitExitCode = $disconnectWaiter.ExitCode
      $script:DeviceDisconnectObserved = $disconnectWaiter.ExitCode -eq 0
    } else {
      $null = Invoke-Tool -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -Arguments @('/PID', [string]$disconnectWaiter.Id, '/T', '/F') -TimeoutSeconds 30 -AllowFailure
      $null = $disconnectWaiter.WaitForExit(30000)
      $script:DeviceDisconnectObserved = $false
    }
    $disconnectWaiter.Dispose()
  }
  return $processExited -and $helperProcessesExited
}

# ---------------------------------------------------------------------------
# Exact device state signals
# ---------------------------------------------------------------------------

# Blocks on adb's own device-state signal and exact framework lifecycle events. A wiped
# API 36 image can emit boot_progress_enable_screen before setting sys.boot_completed, so
# user-unlock completion is awaited before reading that property or consuming the earlier
# retained screen event. Every process wait is event-driven and bounded by Invoke-Tool.
function Wait-ForBootCompleted {
  $null = Invoke-Tool -FilePath $script:Adb -Arguments @('start-server') -AllowFailure
  $null = Invoke-Tool -FilePath $script:Adb -Arguments @('wait-for-device')

  $serials = @(
    (Invoke-Tool -FilePath $script:Adb -Arguments @('devices')).StdOut -split '\r?\n' |
      Where-Object { $_ -match '^(emulator-\d+)\s+device$' } |
      ForEach-Object { $Matches[1] }
  )
  if ($serials.Count -ne 1) {
    Fail 'PRECONDITION_DEVICE_AMBIGUOUS' "Expected exactly one attached emulator, found $($serials.Count)"
  }
  $script:DeviceSerial = $serials[0]

  # This exact lifecycle completion trails the early screen-enable event on a clean boot
  # and proves credential-encrypted user storage is ready without polling a property.
  $null = Invoke-Adb -Arguments @('logcat', '-b', 'events', '-m', '1', '-s', 'uc_finish_user_unlocked_completed')
  $bootCompleted = (Invoke-AdbShell -Command 'getprop sys.boot_completed').StdOut.Trim()
  if ($bootCompleted -ne '1') {
    Fail 'PRECONDITION_BOOT_INCOMPLETE' "sys.boot_completed reported '$bootCompleted' instead of 1"
  }
  # Consume the retained display event only after boot completion has been proven.
  $null = Invoke-Adb -Arguments @('logcat', '-b', 'events', '-m', '1', '-s', 'boot_progress_enable_screen')
  return $script:DeviceSerial
}

function Get-DeviceApiLevel {
  $level = (Invoke-AdbShell -Command 'getprop ro.build.version.sdk').StdOut.Trim()
  $parsed = 0
  if (-not [int]::TryParse($level, [ref]$parsed)) {
    Fail 'PRECONDITION_API_LEVEL_UNKNOWN' "Device reported an unparseable API level '$level'"
  }
  return $parsed
}

function Get-UserLifecycleState {
  $reported = (Invoke-AdbShell -Command 'dumpsys user --user 0').StdOut
  $state = [regex]::Match($reported, '(?m)^\s*State:\s+([A-Z_]+)\s*$')
  if (-not $state.Success) {
    Fail 'PRECONDITION_USER_STATE_UNKNOWN' 'dumpsys user did not report a lifecycle state for user 0'
  }
  return $state.Groups[1].Value
}

function Get-KeyguardState {
  $dump = (Invoke-AdbShell -Command 'dumpsys window' -AllowFailure).StdOut
  $showing = $dump -match 'mDreamingLockscreen=true' -or $dump -match 'isStatusBarKeyguard=true' -or $dump -match 'mShowingLockscreen=true'
  return [pscustomobject]@{ KeyguardShowing = [bool]$showing }
}

# ---------------------------------------------------------------------------
# Credential handling. The secret exists only in this process and redirected stdin.
# ---------------------------------------------------------------------------

function Initialize-DeviceCredential {
  $supplied = $env:PLAYTIME_PACT_TEST_DEVICE_PIN
  if (-not [string]::IsNullOrWhiteSpace($supplied)) {
    if ($supplied -notmatch '^\d{4,16}$') {
      Fail 'PRECONDITION_PIN_ENV_INVALID' 'PLAYTIME_PACT_TEST_DEVICE_PIN must be 4 to 16 digits.'
    }
    $script:DeviceCredential = $supplied
    $script:DeviceCredentialSource = 'environment'
    Remove-Variable -Name supplied -ErrorAction SilentlyContinue
    return
  }

  $bytes = New-Object byte[] 4
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $number = ([BitConverter]::ToUInt32($bytes, 0) % 900000) + 100000
  $script:DeviceCredential = [string]$number
  $script:DeviceCredentialSource = 'generated-ephemeral'
  [Array]::Clear($bytes, 0, $bytes.Length)
  Remove-Variable -Name supplied, number, bytes -ErrorAction SilentlyContinue
}

# adb forwards redirected stdin to the device shell. The shell reads one line and passes
# it directly to locksettings, so the value is absent from every process argument.
function Invoke-CredentialCommand {
  param([Parameter(Mandatory = $true)][ValidateSet('set', 'clear')][string]$Action)
  if ([string]::IsNullOrWhiteSpace($script:DeviceCredential)) { Fail 'CREDENTIAL_NOT_INITIALIZED' 'The ephemeral device credential is unavailable' }
  $arguments = @()
  if ($script:DeviceSerial) { $arguments += @('-s', $script:DeviceSerial) }
  $deviceCommand = if ($Action -eq 'set') {
    'IFS= read -r TEST_CREDENTIAL; locksettings set-pin --old "" "$TEST_CREDENTIAL"'
  } else {
    'IFS= read -r TEST_CREDENTIAL; locksettings clear --old "$TEST_CREDENTIAL"'
  }
  $arguments += @('shell', $deviceCommand)
  return Invoke-Tool -FilePath $script:Adb -Arguments $arguments -StandardInputText $script:DeviceCredential -AllowFailure
}

function Set-DeviceCredential {
  $outcome = Invoke-CredentialCommand -Action set
  $script:CredentialArmed = $true
  if ($outcome.ExitCode -ne 0) {
    Fail 'PRECONDITION_CREDENTIAL_SET_FAILED' 'locksettings set-pin failed to arm the emulator-only test credential.'
  }
  $verify = Invoke-AdbShell -Command 'locksettings get-disabled' -AllowFailure
  return [pscustomobject]@{ Armed = $true; LockDisabledReport = $verify.StdOut.Trim() }
}

function Clear-DeviceCredential {
  if (-not $script:CredentialArmed) {
    $script:CredentialClearClassification = 'NOT_ARMED'
    return $false
  }
  if (-not $script:DeviceSerial) {
    $script:CredentialClearClassification = 'DEVICE_SERIAL_MISSING'
    return $false
  }
  if ([string]::IsNullOrWhiteSpace($script:DeviceCredential)) {
    $script:CredentialClearClassification = 'CREDENTIAL_UNAVAILABLE'
    return $false
  }
  $outcome = Invoke-CredentialCommand -Action clear
  $script:CredentialClearExitCode = $outcome.ExitCode
  if ($outcome.ExitCode -eq 0) {
    # A successful empty-credential verification is an independent state read proving
    # that clear did not merely return a successful process exit code.
    $verify = Invoke-AdbShell -Command 'locksettings verify --old ""' -AllowFailure
    $script:CredentialRemovalVerified = $verify.ExitCode -eq 0
    if ($script:CredentialRemovalVerified) {
      $script:CredentialArmed = $false
      $script:CredentialClearClassification = 'CLEARED_AND_VERIFIED'
      return $true
    }
    $script:CredentialClearClassification = 'REMOVAL_VERIFICATION_FAILED'
    return $false
  }
  $detail = "$($outcome.StdOut)`n$($outcome.StdErr)"
  $script:CredentialClearClassification = if ($detail -match 'old password|old credential') {
    'OLD_CREDENTIAL_REJECTED'
  } elseif ($detail -match 'device.+(?:offline|not found)|no devices') {
    'DEVICE_UNAVAILABLE'
  } else {
    'COMMAND_FAILED'
  }
  Remove-Variable -Name detail -ErrorAction SilentlyContinue
  return $false
}

function Clear-Keyguard {
  # Unlock the keyguard using the armed credential, then confirm it is gone.
  $null = Invoke-AdbShell -Command 'input keyevent 82' -AllowFailure
  $null = Invoke-AdbShell -Command 'wm dismiss-keyguard' -AllowFailure
  return (Get-KeyguardState)
}

# ---------------------------------------------------------------------------
# Package hygiene and capability preflight
# ---------------------------------------------------------------------------

function Remove-InstalledPackages {
  $removed = @()
  foreach ($package in @($TestApplicationId, $ApplicationId)) {
    $listed = Invoke-AdbShell -Command "pm list packages $package" -AllowFailure
    if ($listed.StdOut -match [regex]::Escape("package:$package")) {
      $null = Invoke-Adb -Arguments @('uninstall', $package) -AllowFailure
      $removed += $package
    }
  }
  return $removed
}

# Proves the device exposes the PackageInstaller surface the product depends on before
# instrumentation starts, so a missing capability is never reported as a product defect.
function Assert-PackageInstallerCapability {
  $sessions = Invoke-AdbShell -Command 'pm list packages -f android' -AllowFailure
  if ($sessions.ExitCode -ne 0) { Fail 'PRECONDITION_PM_UNAVAILABLE' 'Package manager service is not answering on the device' }

  $installerFeature = Invoke-AdbShell -Command 'cmd package install-create -r -t' -AllowFailure
  if ($installerFeature.ExitCode -ne 0 -or $installerFeature.StdOut -notmatch 'Success: created install session') {
    Fail 'PRECONDITION_PACKAGEINSTALLER_UNAVAILABLE' 'PackageInstaller sessions cannot be created on this device'
  }
  $sessionId = $null
  if ($installerFeature.StdOut -match '\[(\d+)\]') { $sessionId = $Matches[1] }
  if ($sessionId) { $null = Invoke-AdbShell -Command "cmd package install-abandon $sessionId" -AllowFailure }
  return [pscustomobject]@{ SessionCreated = $true; ProbeSessionId = $sessionId }
}

# ---------------------------------------------------------------------------
# Instrumentation
# ---------------------------------------------------------------------------

function Invoke-ConnectedTests {
  param([Parameter(Mandatory = $true)][string]$JdkHome, [Parameter(Mandatory = $true)][string]$SdkRoot)

  $gradlew = Join-Path $AndroidProjectRoot 'gradlew.bat'
  if (-not (Test-Path -LiteralPath $gradlew)) { Fail 'PRECONDITION_GRADLE_MISSING' "Gradle wrapper not found at $gradlew" }

  $environment = @{
    JAVA_HOME = $JdkHome
    ANDROID_SDK_ROOT = $SdkRoot
    ANDROID_HOME = $SdkRoot
    ANDROID_SERIAL = $script:DeviceSerial
  }
  # `install` of both APKs is performed by the connected task itself after the clean
  # uninstall above, keeping a single invocation authoritative.
  $arguments = @($GradleConnectedTask, '--no-daemon', '--stacktrace', "-Pandroid.testInstrumentationRunnerArguments.package=$ApplicationId")
  return Invoke-Tool -FilePath $gradlew -Arguments $arguments -WorkingDirectory $AndroidProjectRoot -Environment $environment -TimeoutSeconds 900 -AllowFailure
}

# Reads the machine-consumed instrumentation results rather than scraping console prose.
function Read-ConnectedTestResults {
  $resultsRoot = Join-Path $AndroidProjectRoot 'app\build\outputs\androidTest-results\connected'
  $summary = [pscustomobject]@{
    ResultsRoot = $resultsRoot
    ConnectedTestCount = 0
    FailureCount = 0
    ErrorCount = 0
    SkippedCount = 0
    Suites = @()
  }
  if (-not (Test-Path -LiteralPath $resultsRoot)) { return $summary }

  $suites = @()
  foreach ($file in (Get-ChildItem -LiteralPath $resultsRoot -Recurse -Filter 'TEST-*.xml' -ErrorAction SilentlyContinue)) {
    [xml]$document = Get-Content -LiteralPath $file.FullName -Raw
    $node = $document.testsuite
    if (-not $node) { continue }
    $summary.ConnectedTestCount += [int]$node.tests
    $summary.FailureCount += [int]$node.failures
    $summary.ErrorCount += [int]$node.errors
    if ($node.skipped) { $summary.SkippedCount += [int]$node.skipped }
    $suites += [pscustomobject]@{
      name = [string]$node.name
      tests = [int]$node.tests
      failures = [int]$node.failures
      errors = [int]$node.errors
    }
  }
  $summary.Suites = $suites
  return $summary
}

function Save-ConnectedReports {
  param([Parameter(Mandatory = $true)][string]$ResultsRoot)
  if (-not (Test-Path -LiteralPath $ResultsRoot)) { return $null }
  $destination = Join-Path $EvidenceRoot 'reports'
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
  $null = New-Item -ItemType Directory -Path $destination -Force
  Copy-Item -Path (Join-Path $ResultsRoot '*') -Destination $destination -Recurse -Force
  return $destination
}

function Save-Logcat {
  param([Parameter(Mandatory = $true)][string]$Destination)
  if (-not $script:DeviceSerial) { return $null }
  $dump = Invoke-Adb -Arguments @('logcat', '-d', '-v', 'threadtime') -AllowFailure
  if ($dump.ExitCode -ne 0) { return $null }
  $directory = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory -Force }
  Set-Content -LiteralPath $Destination -Value $dump.StdOut -Encoding UTF8
  return $Destination
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$report = [ordered]@{
  schemaVersion = 1
  outcome = 'unknown'
  mode = if ($VerifyLockedFailure) { 'verify-locked-failure' } else { 'connected-tests' }
  avdName = $AvdName
  systemImage = $ExpectedSystemImage
  requiredApiLevel = $ExpectedApiLevel
  requiredJdkFeatureVersion = $RequiredJdkFeatureVersion
  snapshots = 'disabled'
  dataPartition = 'wiped'
  minimumConnectedTests = $MinimumConnectedTests
  connectedTestCount = 0
  failureCount = 0
  errorCount = 0
  instrumentationStarted = $false
  preflight = [ordered]@{}
  credentialCleared = $false
  credentialClearExitCode = $null
  credentialClearClassification = $null
  credentialRemovalVerified = $false
  emulatorProcessExited = $false
  emulatorResidueCount = $null
  deviceDisconnected = $false
  deviceDisconnectWaitExitCode = $null
  errorCode = $null
  errorMessage = $null
}

try {
  Initialize-DeviceCredential
  $report.preflight.pinSource = $script:DeviceCredentialSource

  $sdkRoot = Resolve-AndroidSdkRoot
  $script:Adb = Join-Path $sdkRoot 'platform-tools\adb.exe'
  $report.preflight.sdkRoot = $sdkRoot

  $jdk = Resolve-Jdk17Home
  $report.preflight.jdkHome = $jdk.Home
  $report.preflight.jdkVersion = $jdk.Version

  $avd = Assert-AvdIsSupported -SdkRoot $sdkRoot
  $report.preflight.avdConfigPath = $avd.ConfigPath
  $preexisting = @(Get-ManagedEmulatorProcesses)
  $report.preflight.preexistingManagedEmulatorCount = $preexisting.Count
  if ($preexisting.Count -ne 0) { Fail 'PRECONDITION_EMULATOR_ALREADY_RUNNING' "Found $($preexisting.Count) existing '$AvdName' emulator processes" }

  Write-Note "Booting $AvdName with a wiped data partition and snapshots disabled."
  $null = Start-CleanEmulator -EmulatorPath $avd.Emulator

  $serial = Wait-ForBootCompleted
  $report.preflight.deviceSerial = $serial
  $report.preflight.bootCompleted = $true

  $apiLevel = Get-DeviceApiLevel
  $report.preflight.apiLevel = $apiLevel
  if ($apiLevel -ne $ExpectedApiLevel) {
    Fail 'PRECONDITION_API_LEVEL_MISMATCH' "Device reports API $apiLevel but API $ExpectedApiLevel is required"
  }

  $userState = Get-UserLifecycleState
  $report.preflight.userStateBeforeCredential = $userState
  $report.preflight.userUnlocked = $userState -eq 'RUNNING_UNLOCKED'
  if ($userState -ne 'RUNNING_UNLOCKED') { Fail 'PRECONDITION_USER_LOCKED' "dumpsys user reported $userState before credential setup" }

  $credential = Set-DeviceCredential
  $report.preflight.credentialArmed = $credential.Armed

  if ($VerifyLockedFailure) {
    # Deliberately leave the keyguard up so the gate below rejects the device.
    $null = Invoke-AdbShell -Command 'input keyevent 26' -AllowFailure
    $report.preflight.keyguardIntentionallyLocked = $true
  } else {
    $keyguard = Clear-Keyguard
    $report.preflight.keyguardShowing = $keyguard.KeyguardShowing
  }

  $postCredentialState = Get-UserLifecycleState
  $report.preflight.userStateAfterCredential = $postCredentialState
  $report.preflight.userUnlockedAfterCredential = $postCredentialState -eq 'RUNNING_UNLOCKED'
  $keyguardState = Get-KeyguardState
  $report.preflight.keyguardShowing = $keyguardState.KeyguardShowing

  if ($VerifyLockedFailure) {
    $report.outcome = 'preflight-rejected'
    Fail 'PRECONDITION_KEYGUARD_LOCKED' 'Device keyguard is locked; refusing to start instrumentation because locked-device failures are environmental, not product defects.'
  }
  if ($keyguardState.KeyguardShowing -or $postCredentialState -ne 'RUNNING_UNLOCKED') {
    $report.outcome = 'preflight-rejected'
    Fail 'PRECONDITION_KEYGUARD_LOCKED' 'Device keyguard is locked after credential setup; refusing to start instrumentation.'
  }

  $report.preflight.uninstalledPackages = Remove-InstalledPackages
  $installer = Assert-PackageInstallerCapability
  $report.preflight.packageInstallerSessionCreated = $installer.SessionCreated

  Write-Note "Running $GradleConnectedTask on $serial."
  $report.instrumentationStarted = $true
  $gradle = Invoke-ConnectedTests -JdkHome $jdk.Home -SdkRoot $sdkRoot
  $report.gradleExitCode = $gradle.ExitCode

  $results = Read-ConnectedTestResults
  $report.connectedTestCount = $results.ConnectedTestCount
  $report.failureCount = $results.FailureCount
  $report.errorCount = $results.ErrorCount
  $report.suites = $results.Suites
  $report.resultsRoot = $results.ResultsRoot
  $reportsPath = Save-ConnectedReports -ResultsRoot $results.ResultsRoot
  if ($reportsPath) { $report.reportsPath = $reportsPath }

  $logcatPath = Save-Logcat -Destination (Join-Path $EvidenceRoot 'logcat.txt')
  if ($logcatPath) { $report.logcatPath = $logcatPath }

  if ($gradle.ExitCode -ne 0 -or $results.FailureCount -gt 0 -or $results.ErrorCount -gt 0) {
    $report.outcome = 'tests-failed'
    Fail 'CONNECTED_TESTS_FAILED' "Connected instrumentation reported $($results.FailureCount) failures and $($results.ErrorCount) errors across $($results.ConnectedTestCount) tests."
  }
  if ($results.ConnectedTestCount -lt $MinimumConnectedTests) {
    $report.outcome = 'insufficient-coverage'
    Fail 'CONNECTED_TESTS_UNDERCOUNT' "Executed $($results.ConnectedTestCount) connected tests but at least $MinimumConnectedTests are required."
  }
  $report.outcome = 'passed'
}
catch {
  if ($report.outcome -eq 'unknown') { $report.outcome = 'failed' }
  $message = $_.Exception.Message
  if ($message -match '^([A-Z0-9_]+): (.*)$') {
    $report.errorCode = $Matches[1]
    $report.errorMessage = $Matches[2]
  } else {
    $report.errorCode = 'UNEXPECTED_ERROR'
    $report.errorMessage = $message
  }
}
finally {
  # Teardown is nested so an unavailable device cannot prevent process-tree cleanup.
  try {
    $report.credentialCleared = Clear-DeviceCredential
    $report.credentialClearExitCode = $script:CredentialClearExitCode
    $report.credentialClearClassification = $script:CredentialClearClassification
    $report.credentialRemovalVerified = $script:CredentialRemovalVerified
  } catch {
    $report.credentialClearClassification = 'CLEANUP_EXCEPTION'
  } finally {
    try { $report.emulatorProcessExited = Stop-Emulator } catch { $report.emulatorProcessExited = $false }
    $residue = @(Get-ManagedEmulatorProcesses)
    $report.emulatorResidueCount = $residue.Count
    $report.deviceDisconnected = $script:DeviceDisconnectObserved
    $report.deviceDisconnectWaitExitCode = $script:DeviceDisconnectWaitExitCode
    $script:DeviceCredential = $null
  }
}

if ($report.outcome -eq 'passed' -and (-not $report.credentialCleared -or -not $report.credentialRemovalVerified)) {
  $report.outcome = 'failed'
  $report.errorCode = 'CREDENTIAL_CLEAR_FAILED'
  $report.errorMessage = "Emulator credential cleanup failed ($($report.credentialClearClassification))."
}
if ($report.outcome -eq 'passed' -and (-not $report.emulatorProcessExited -or $report.emulatorResidueCount -ne 0 -or -not $report.deviceDisconnected)) {
  $report.outcome = 'failed'
  $report.errorCode = 'EMULATOR_CLEANUP_FAILED'
  $report.errorMessage = 'Managed emulator teardown left process or device residue.'
}

$null = New-Item -ItemType Directory -Path $EvidenceRoot -Force
$reportPath = Join-Path $EvidenceRoot 'result.json'
$report.reportPath = $reportPath
$json = ($report | ConvertTo-Json -Depth 6)
[IO.File]::WriteAllText($reportPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Output $json

if ($report.outcome -eq 'passed') { exit 0 }
Write-Error ("{0}: {1}" -f $report.errorCode, $report.errorMessage) -ErrorAction Continue
exit 1
