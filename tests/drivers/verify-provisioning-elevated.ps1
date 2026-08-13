[CmdletBinding()]
param(
  [string]$ProvisionScript,
  [switch]$PreflightOnly,
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($ProvisionScript)) { $ProvisionScript = Join-Path $PSScriptRoot '..\..\scripts\provision-remote-approval.ps1' }
$ProvisionScript = [IO.Path]::GetFullPath($ProvisionScript)

function Fail([string]$Message) { throw "ELEVATED_DRIVER_FAILED: $Message" }

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Provision([hashtable]$Arguments) {
  $output = & $ProvisionScript @Arguments
  $text = ($output | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  return $text | ConvertFrom-Json
}

function Assert-Fails([string]$Code, [scriptblock]$Operation, [string]$Scenario = 'operation') {
  $failed = $false
  try { & $Operation | Out-Null } catch {
    $failed = $true
    $message = $_.Exception.Message
    if (-not $message.StartsWith("$Code`: ", [StringComparison]::Ordinal)) { Fail "$Scenario expected $Code but received $message" }
  }
  if (-not $failed) { Fail "$Scenario expected failure $Code" }
}

function Write-JsonNoBom([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

function Publish-Result($Value) {
  $json = $Value | ConvertTo-Json -Depth 12
  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    [IO.File]::WriteAllText($ResultPath, $json, [Text.UTF8Encoding]::new($false))
  }
  return $json
}

function Assert-NoConfigStaging([string]$Directory) {
  if (Test-Path -LiteralPath $Directory) {
    $residue = @(Get-ChildItem -LiteralPath $Directory -Recurse -Force -File | Where-Object { $_.Name -match '^config\..*\.(tmp|bak)$' })
    if ($residue.Count -ne 0) { Fail "Config staging residue remains: $($residue.FullName -join ', ')" }
  }
}

function Get-DaclRows([string]$Path, [switch]$Directory) {
  $acl = Get-Acl -LiteralPath $Path
  $descriptor = [Security.AccessControl.CommonSecurityDescriptor]::new([bool]$Directory, $false, $acl.Sddl)
  return @($descriptor.DiscretionaryAcl | ForEach-Object {
    [pscustomobject]@{
      sid = $_.SecurityIdentifier.Value
      mask = [int]$_.AccessMask
      flags = [int]$_.AceFlags
      qualifier = [string]$_.AceQualifier
    }
  } | Sort-Object sid)
}

function Assert-ExactAcl([string]$Path, [string]$TargetSid, [switch]$Directory) {
  $actual = @(Get-DaclRows $Path -Directory:$Directory)
  $inheritFlags = if ($Directory) { 3 } else { 0 }
  $targetMask = if ($Directory) { 0x1200a9 } else { 0x120089 }
  $expected = @(
    [pscustomobject]@{ sid = 'S-1-5-18'; mask = 0x1f01ff; flags = $inheritFlags; qualifier = 'AccessAllowed' }
    [pscustomobject]@{ sid = 'S-1-5-32-544'; mask = 0x1f01ff; flags = $inheritFlags; qualifier = 'AccessAllowed' }
    [pscustomobject]@{ sid = $TargetSid; mask = $targetMask; flags = $inheritFlags; qualifier = 'AccessAllowed' }
  ) | Sort-Object sid
  if (($actual | ConvertTo-Json -Compress) -ne ($expected | ConvertTo-Json -Compress)) {
    Fail "Unexpected ACL on $Path. Actual: $($actual | ConvertTo-Json -Compress)"
  }
}

function New-DisposableTargetAccount {
  $name = "PptChild$([Guid]::NewGuid().ToString('N').Substring(0,8))"
  $user = New-LocalUser -Name $name -NoPassword -AccountNeverExpires -UserMayNotChangePassword
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PptUserProfile {
  [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int CreateProfile(string sid, string userName, System.Text.StringBuilder path, uint size);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool DeleteProfile(string sid, string path, string computer);
}
'@
  $path = [Text.StringBuilder]::new(260)
  $result = [PptUserProfile]::CreateProfile($user.SID.Value, $name, $path, 260)
  if ($result -ne 0) { Remove-LocalUser -Name $name; Fail "Could not initialize disposable target profile ($result)" }
  return [pscustomobject]@{ name = "$env:COMPUTERNAME\$name"; localName = $name; sid = $user.SID.Value; profile = $path.ToString() }
}

function Invoke-IdentityKeyProbe($Target, [string]$KeyName, [switch]$System) {
  $probeDir = Join-Path $root "probe-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $probeDir | Out-Null
  $scriptPath = Join-Path $probeDir 'probe.ps1'
  $resultPath = Join-Path $probeDir 'result.txt'
  @(
    "`$ErrorActionPreference='Stop'",
    'try {',
    "  `$key=[Security.Cryptography.CngKey]::Open('$KeyName',[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey)",
    '  `$signer=[Security.Cryptography.ECDsaCng]::new(`$key)',
    "  `$null=`$signer.SignData([Text.Encoding]::ASCII.GetBytes('authority-boundary'),[Security.Cryptography.HashAlgorithmName]::SHA256)",
    "  [IO.File]::WriteAllText('$resultPath','SIGNED')",
    "} catch { [IO.File]::WriteAllText('$resultPath','DENIED') }"
  ) | Set-Content -LiteralPath $scriptPath -Encoding UTF8
  $operator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $probeDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' "${operator}:(OI)(CI)F" "$($Target.sid):(OI)(CI)RX" "$($Target.sid):(CI)W" | Out-Null
  $taskName = "PlaytimePact-KeyProbe-$([Guid]::NewGuid().ToString('N'))"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
  $principal = if ($System) { New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest } else { New-ScheduledTaskPrincipal -UserId $Target.name -LogonType S4U -RunLevel Limited }
  $watcher = [IO.FileSystemWatcher]::new($probeDir, 'result.txt')
  $watcher.EnableRaisingEvents = $true
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::Created, 20000)
    if ($change.TimedOut -or -not (Test-Path -LiteralPath $resultPath)) { Fail "Identity key probe timed out for $($principal.UserId)" }
    return [IO.File]::ReadAllText($resultPath)
  } finally {
    $watcher.Dispose()
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    & icacls.exe $probeDir '/grant:r' "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)F" | Out-Null
    Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Assert-MachineKeyAcl([string]$Name, [string[]]$ExpectedSids) {
  $probeDir = Join-Path $root "acl-$([Guid]::NewGuid().ToString('N'))"
  $scriptPath = Join-Path $probeDir 'acl.ps1'
  $resultPath = Join-Path $probeDir 'result.json'
  $taskName = "PlaytimePact-KeyAcl-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $probeDir | Out-Null
  $operator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $probeDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' "${operator}:(OI)(CI)F" | Out-Null
  @(
    "`$ErrorActionPreference='Stop'",
    "try { `$key=[Security.Cryptography.CngKey]::Open('$Name',[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey); try {",
    "`$o=[Security.Cryptography.CngPropertyOptions](1 -bor 2 -bor 4); `$sd=[Security.AccessControl.RawSecurityDescriptor]::new(`$key.GetProperty('Security Descr',`$o).GetValue(),0); `$r=[ordered]@{error=`$false;owner=`$sd.Owner.Value;group=`$sd.Group.Value;sids=@(`$sd.DiscretionaryAcl|% {`$_.SecurityIdentifier.Value}|sort)}; [IO.File]::WriteAllText('$resultPath',(`$r|ConvertTo-Json -Compress))",
    "} finally { `$key.Dispose() } } catch { [IO.File]::WriteAllText('$resultPath','{`"error`":true}') }"
  ) | Set-Content -LiteralPath $scriptPath -Encoding UTF8
  $watcher = [IO.FileSystemWatcher]::new($probeDir, 'result.json'); $watcher.EnableRaisingEvents = $true
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::Created, 20000)
    if ($change.TimedOut -or -not (Test-Path -LiteralPath $resultPath)) { Fail "Machine key ACL probe timed out for $Name" }
    $actual = [IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
    $sids = @($actual.sids | Sort-Object)
    if ($actual.error -or $actual.owner -ne 'S-1-5-18' -or $actual.group -ne 'S-1-5-18' -or ($sids -join ',') -ne (@($ExpectedSids | Sort-Object) -join ',')) {
      Fail "Machine key $Name has unexpected signing principals: $($sids -join ',')"
    }
  } finally {
    $watcher.Dispose()
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Remove-TestKeysAsSystem([string[]]$Names) {
  $namesToRemove = @($Names | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($namesToRemove.Count -eq 0) { return }
  $cleanupDir = Join-Path $root "cleanup-$([Guid]::NewGuid().ToString('N'))"
  $scriptPath = Join-Path $cleanupDir 'cleanup.ps1'
  $resultPath = Join-Path $cleanupDir 'result.txt'
  $taskName = "PlaytimePact-KeyCleanup-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $cleanupDir | Out-Null
  $operator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $cleanupDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' "${operator}:(OI)(CI)F" | Out-Null
  Write-JsonNoBom (Join-Path $cleanupDir 'keys.json') $namesToRemove
  @(
    "`$ErrorActionPreference='Stop'",
    "try { foreach (`$name in @([IO.File]::ReadAllText('$(Join-Path $cleanupDir 'keys.json')') | ConvertFrom-Json)) {",
    "if([Security.Cryptography.CngKey]::Exists(`$name,[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey)){`$key=[Security.Cryptography.CngKey]::Open(`$name,[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey);try{`$key.Delete()}finally{`$key.Dispose()}}",
    "}; [IO.File]::WriteAllText('$resultPath','REMOVED') } catch { [IO.File]::WriteAllText('$resultPath','FAILED') }"
  ) | Set-Content -LiteralPath $scriptPath -Encoding UTF8
  $watcher = [IO.FileSystemWatcher]::new($cleanupDir, 'result.txt'); $watcher.EnableRaisingEvents = $true
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::Created, 20000)
    if ($change.TimedOut -or -not (Test-Path -LiteralPath $resultPath) -or [IO.File]::ReadAllText($resultPath) -ne 'REMOVED') { Fail 'LocalSystem key cleanup failed' }
  } finally {
    $watcher.Dispose()
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $cleanupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$elevated = Test-Administrator
$originalProgramData = $env:ProgramData
$originalLocalAppData = $env:LOCALAPPDATA
$root = Join-Path ([IO.Path]::GetTempPath()) "PlaytimePact-Elevated-$([Guid]::NewGuid().ToString('N'))"
$programData = Join-Path $root 'ProgramData'
$localAppData = Join-Path $root 'LocalAppData'
$mutableDir = Join-Path $localAppData 'PlaytimePact\remote'
$protectedDir = Join-Path $programData 'PlaytimePact\remote'
$configPath = Join-Path $protectedDir 'config.json'
$pendingPath = Join-Path $mutableDir 'pending-enrollment.json'
$adminPublicPath = Join-Path $mutableDir 'admin-public.jwk.json'
$receiptPath = Join-Path $mutableDir 'registration-receipt.json'
$originalMoveItemFunction = $null
$moveItemOverridden = $false
$operationalKeyName = $null
$adminKeyName = $null
$target = $null
$stage = 'initialization'

try {
  New-Item -ItemType Directory -Path $mutableDir -Force | Out-Null
  $env:ProgramData = $programData
  $env:LOCALAPPDATA = $localAppData

  if ($PreflightOnly) {
    if (-not $elevated) {
      Assert-Fails 'ELEVATION_REQUIRED' {
        Invoke-Provision @{
          Action = 'ImportRegistration'
          BaseUrl = 'https://approval.example'
          HouseholdId = 'household-elevated-driver'
          TargetAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        }
      }
    }
    Publish-Result ([pscustomobject]@{
      schemaVersion = 1
      elevated = $elevated
      nonElevatedImportRejected = -not $elevated
      fullDriverRequired = -not $elevated
    })
    return
  }

  if (-not $elevated) {
    throw 'ELEVATION_REQUIRED: Run this driver from a distinct elevated installer/operator account'
  }

  $stage = 'distinct non-admin target creation'
  $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $target = New-DisposableTargetAccount
  $targetSid = $target.sid
  $mutableDir = Join-Path $target.profile 'AppData\Local\PlaytimePact\remote'

  $stage = 'identity creation'
  $identity = Invoke-Provision @{ Action = 'NewPcIdentity'; IanaTimeZone = 'UTC'; TargetAccount = $target.name }
  $bundle = [IO.File]::ReadAllText($pendingPath) | ConvertFrom-Json
  $operationalKeyName = $bundle.operational.keyName
  $adminKeyName = $bundle.admin.keyName
  if ($identity.pcId -ne $bundle.pcId) { Fail 'Identity output does not match the pending bundle' }
  Assert-MachineKeyAcl $operationalKeyName @('S-1-5-18', $operatorSid)
  Assert-MachineKeyAcl $adminKeyName @('S-1-5-18', $operatorSid)
  if ((Invoke-IdentityKeyProbe $target $adminKeyName) -ne 'DENIED') { Fail 'Target account directly signed with the admin key during enrollment' }

  $workerReceipt = [ordered]@{
    v = 1
    serverNowMs = 1700000000000
    operation = 'registerPc'
    household_id = 'household-elevated-driver'
    pc_id = $bundle.pcId
    public_key = ($bundle.operational.publicJwk | ConvertTo-Json -Compress -Depth 4)
    iana_time_zone = 'UTC'
    membership_epoch = 1
    service_epoch = 1
  }
  $receipt = [ordered]@{
    schemaVersion = 1
    householdId = 'household-elevated-driver'
    pcId = $bundle.pcId
    baseUrl = 'https://approval.example'
    operationKey = "register-pc:$($bundle.pcId)"
    workerReceipt = $workerReceipt
  }
  Write-JsonNoBom $receiptPath $receipt
  $pendingBytes = [IO.File]::ReadAllBytes($pendingPath)

  $stage = 'wrong-account rejection'
  Assert-Fails 'WRONG_WINDOWS_ACCOUNT' {
    Invoke-Provision @{
      Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
      RegistrationReceipt = $receiptPath; TargetAccount = 'INVALID\DifferentAccount'
    }
  }
  if (Test-Path -LiteralPath $configPath) { Fail 'Wrong-account preflight wrote a protected config' }

  $stage = 'unwritable ProgramData rejection'
  $blockedProgramData = Join-Path $root 'blocked-programdata'
  [IO.File]::WriteAllText($blockedProgramData, 'not-a-directory')
  $env:ProgramData = $blockedProgramData
  Assert-Fails -Scenario 'unwritable ProgramData' -Code 'CONFIG_WRITE_FAILED' -Operation {
    Invoke-Provision @{
      Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
      RegistrationReceipt = $receiptPath; TargetAccount = $target.name
    }
  }
  $env:ProgramData = $programData
  if (-not (Test-Path -LiteralPath $pendingPath)) { Fail 'Unwritable ProgramData consumed the pending bundle' }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($pendingPath)) -ne [Convert]::ToBase64String($pendingBytes)) { Fail 'Unwritable ProgramData changed the pending bundle' }
  if (Test-Path -LiteralPath $configPath) { Fail 'Unwritable ProgramData published a config' }
  Assert-NoConfigStaging $root

  $stage = 'cancelled publish rejection'
  $originalMoveItemFunction = Get-Item -LiteralPath 'Function:\Move-Item' -ErrorAction SilentlyContinue
  Set-Item -LiteralPath 'Function:\Move-Item' -Value { throw 'DRIVER_CANCELLED' }
  $moveItemOverridden = $true
  try {
    Assert-Fails -Scenario 'cancelled publish' -Code 'CONFIG_WRITE_FAILED' -Operation {
      Invoke-Provision @{
        Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
        RegistrationReceipt = $receiptPath; TargetAccount = $target.name
      }
    }
  } finally {
    if ($originalMoveItemFunction) {
      Set-Item -LiteralPath 'Function:\Move-Item' -Value $originalMoveItemFunction.ScriptBlock
    } else {
      Remove-Item -LiteralPath 'Function:\Move-Item' -Force -ErrorAction SilentlyContinue
    }
    $moveItemOverridden = $false
  }
  if ($originalMoveItemFunction) {
    $restoredMoveItem = Get-Item -LiteralPath 'Function:\Move-Item' -ErrorAction SilentlyContinue
    if (-not $restoredMoveItem -or $restoredMoveItem.ScriptBlock.ToString() -ne $originalMoveItemFunction.ScriptBlock.ToString()) { Fail 'Move-Item function was not restored after cancellation' }
  } elseif (Test-Path -LiteralPath 'Function:\Move-Item') {
    Fail 'Move-Item override remained after cancellation'
  }
  if (Test-Path -LiteralPath $configPath) { Fail 'Cancelled import published a config' }
  if (-not (Test-Path -LiteralPath $pendingPath)) { Fail 'Cancelled import consumed the pending bundle' }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($pendingPath)) -ne [Convert]::ToBase64String($pendingBytes)) { Fail 'Cancelled import changed the pending bundle' }
  Assert-NoConfigStaging $protectedDir
  Assert-MachineKeyAcl $operationalKeyName @('S-1-5-18')
  Assert-MachineKeyAcl $adminKeyName @('S-1-5-18')

  $stage = 'interrupted key hardening recovery'
  $firstImport = Invoke-Provision @{
    Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
    RegistrationReceipt = $receiptPath; TargetAccount = $target.name
  }
  if ($firstImport.verified -ne $true -or $firstImport.pcId -ne $bundle.pcId) { Fail 'First resumed import did not verify' }
  Assert-MachineKeyAcl $operationalKeyName @('S-1-5-18')
  Assert-MachineKeyAcl $adminKeyName @('S-1-5-18')
  if ((Invoke-IdentityKeyProbe $target $adminKeyName) -ne 'DENIED') { Fail 'Target account directly signed with the installed admin key' }
  if ((Invoke-IdentityKeyProbe $target $adminKeyName -System) -ne 'SIGNED') { Fail 'LocalSystem could not sign with the installed admin key' }
  if (Test-Path -LiteralPath $pendingPath) { Fail 'Successful import retained the pending bundle' }
  if (Test-Path -LiteralPath $adminPublicPath) { Fail 'Successful import retained admin-public.jwk.json' }

  $stage = 'second idempotent import'
  $secondImport = Invoke-Provision @{
    Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
    RegistrationReceipt = $receiptPath; TargetAccount = $target.name
  }
  if ($secondImport.noOp -ne $true -or $secondImport.verified -ne $true -or $secondImport.pcId -ne $bundle.pcId) { Fail 'Second import was not an exact no-op' }

  $stage = 'exact ACL verification'
  Assert-ExactAcl $protectedDir $targetSid -Directory
  Assert-ExactAcl $configPath $targetSid

  $stage = 'disable'
  $disable = Invoke-Provision @{ Action = 'Disable' }
  if ($disable.disabled -ne $true -or $disable.configPath -ne $configPath) { Fail 'Disable returned an invalid receipt' }
  if (-not (Test-Path -LiteralPath $configPath)) { Fail 'Disable removed the protected config' }
  $disabledConfig = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
  if ($disabledConfig.disabled -ne $true) { Fail 'Disable did not mark the protected config disabled' }
  if ($disabledConfig.membership.pcId -ne $bundle.pcId -or $disabledConfig.membership.householdId -ne 'household-elevated-driver') { Fail 'Disable changed the protected membership' }
  if ($disabledConfig.operational.keyName -ne $operationalKeyName -or $disabledConfig.admin.keyName -ne $adminKeyName) { Fail 'Disable changed the configured key names' }
  if ($disabledConfig.mutableStateDir -ne $mutableDir) { Fail 'Disable changed the mutable state directory' }
  if (-not [Security.Cryptography.CngKey]::Exists($operationalKeyName, [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) { Fail 'Disable removed the operational key' }
  if (-not [Security.Cryptography.CngKey]::Exists($adminKeyName, [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) { Fail 'Disable removed the admin key' }
  if (Test-Path -LiteralPath $pendingPath) { Fail 'Disable recreated the pending bundle' }
  if (Test-Path -LiteralPath $adminPublicPath) { Fail 'Disable recreated admin-public.jwk.json' }
  if (Test-Path -LiteralPath (Join-Path $mutableDir 'intent.json')) { Fail 'Disable left reconciliation intent behind' }
  Assert-ExactAcl $protectedDir $targetSid -Directory
  Assert-ExactAcl $configPath $targetSid
  Assert-NoConfigStaging $protectedDir
  $disabledBytes = [IO.File]::ReadAllBytes($configPath)

  $stage = 'repeated disable'
  $repeatedDisable = Invoke-Provision @{ Action = 'Disable' }
  if ($repeatedDisable.disabled -ne $true -or $repeatedDisable.configPath -ne $configPath) { Fail 'Repeated Disable returned an invalid receipt' }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -ne [Convert]::ToBase64String($disabledBytes)) { Fail 'Repeated Disable changed the protected config' }
  Assert-ExactAcl $configPath $targetSid
  Assert-NoConfigStaging $protectedDir
  $configBytes = $disabledBytes

  $stage = 'receipt mismatch rejection'
  $mismatched = $receipt | ConvertTo-Json -Depth 12 | ConvertFrom-Json
  $mismatched.pcId = [Guid]::NewGuid().ToString()
  Write-JsonNoBom $receiptPath $mismatched
  Assert-Fails 'IDENTITY_MISMATCH' {
    Invoke-Provision @{
      Action = 'ImportRegistration'; BaseUrl = 'https://approval.example'; HouseholdId = 'household-elevated-driver'
      RegistrationReceipt = $receiptPath; TargetAccount = $target.name
    }
  }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($configPath)) -ne [Convert]::ToBase64String($configBytes)) { Fail 'Receipt mismatch changed the protected config' }
  Assert-NoConfigStaging $protectedDir
  Write-JsonNoBom $receiptPath $receipt

  $stage = 'identity reset'
  $reset = Invoke-Provision @{ Action = 'ResetIdentity'; ConfirmPcId = $bundle.pcId }
  if ($reset.removedPcId -ne $bundle.pcId -or $reset.localOnly -ne $true) { Fail 'ResetIdentity returned an invalid receipt' }
  foreach ($path in @($configPath, $pendingPath, $adminPublicPath, $receiptPath)) {
    if (Test-Path -LiteralPath $path) { Fail "ResetIdentity retained $path" }
  }
  $provider = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  if ([Security.Cryptography.CngKey]::Exists($operationalKeyName, $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey) -or [Security.Cryptography.CngKey]::Exists($adminKeyName, $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) { Fail 'ResetIdentity retained a CNG key' }
  Assert-NoConfigStaging $protectedDir

  Publish-Result ([pscustomobject]@{
    schemaVersion = 1
    elevated = $true
    pcId = $bundle.pcId
    importsVerified = 2
    exactAclVerified = $true
    machineKeyAclVerified = $true
    distinctNonAdminTargetVerified = $true
    targetKeyAccessDenied = $true
    localSystemKeyAccessVerified = $true
    receiptMismatchRejected = $true
    unwritableProgramDataAtomic = $true
    cancellationResumeVerified = $true
    disableVerified = $true
    disableIdempotentVerified = $true
    resetCleanupVerified = $true
  })
} catch {
  if (-not [string]::IsNullOrWhiteSpace($ResultPath)) {
    $failure = [ordered]@{
      schemaVersion = 1
      elevated = $elevated
      success = $false
      stage = $stage
      error = $_.Exception.Message
      details = ($_ | Out-String)
    }
    [IO.File]::WriteAllText($ResultPath, ($failure | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  }
  throw
} finally {
  if ($moveItemOverridden) {
    if ($originalMoveItemFunction) {
      Set-Item -LiteralPath 'Function:\Move-Item' -Value $originalMoveItemFunction.ScriptBlock
    } else {
      Remove-Item -LiteralPath 'Function:\Move-Item' -Force -ErrorAction SilentlyContinue
    }
  }
  $env:ProgramData = $originalProgramData
  $env:LOCALAPPDATA = $originalLocalAppData
  Remove-TestKeysAsSystem @($operationalKeyName, $adminKeyName)
  if ($target) {
    [void][PptUserProfile]::DeleteProfile($target.sid, $target.profile, $null)
    Remove-LocalUser -Name $target.localName -ErrorAction SilentlyContinue
    if (Get-LocalUser -Name $target.localName -ErrorAction SilentlyContinue) { throw "ELEVATED_DRIVER_CLEANUP_FAILED: disposable account $($target.localName) remains" }
    if (Test-Path -LiteralPath $target.profile) { throw "ELEVATED_DRIVER_CLEANUP_FAILED: disposable profile $($target.profile) remains" }
  }
  if (Test-Path -LiteralPath $root) {
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $root '/inheritance:e' '/grant:r' "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)F" '/T' '/C' | Out-Null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $root) { throw "ELEVATED_DRIVER_CLEANUP_FAILED: $root" }
}
