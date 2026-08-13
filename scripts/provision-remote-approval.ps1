<#
.SYNOPSIS
  Idempotent Windows provisioning for Playtime Pact remote approval.

.DESCRIPTION
  Run identity creation, registration and import from a distinct elevated installer
  while -TargetAccount names the non-administrator child account. Keys are machine-scoped
  for the LocalSystem privileged broker; the target Electron account receives read-only
  configuration access and no private-key access. Run ImportRegistration while Playtime Pact is
  stopped. The protected configuration is stored under ProgramData; mutable intent,
  relaunch fences and the non-secret enrollment files stay under LocalAppData.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('NewPcIdentity','RegisterPc','IssuePairing','ImportRegistration','VerifyConfig','Disable','ResetIdentity')]
  [string]$Action,

  [string]$BaseUrl,
  [string]$HouseholdId,
  [string]$IanaTimeZone,
  [string]$RegistrationReceipt,
  [string]$PairingOperationKey,
  [string]$TargetAccount,
  [string]$ConfirmPcId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProtectedDir = Join-Path $env:ProgramData 'PlaytimePact\remote'
$ProtectedConfigPath = Join-Path $ProtectedDir 'config.json'
$MutableDir = Join-Path $env:LOCALAPPDATA 'PlaytimePact\remote'
$PendingEnrollmentPath = Join-Path $MutableDir 'pending-enrollment.json'
$AdminPublicJwkPath = Join-Path $MutableDir 'admin-public.jwk.json'
$DefaultRegistrationReceiptPath = Join-Path $MutableDir 'registration-receipt.json'

function Fail([string]$Code, [string]$Message) { throw "$Code`: $Message" }

function Get-CurrentAccount {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}

function Resolve-TargetAccount([string]$AccountName) {
  if ([string]::IsNullOrWhiteSpace($AccountName)) { Fail 'ARGUMENT_REQUIRED' '-TargetAccount is required' }
  try {
    $sid = ([System.Security.Principal.NTAccount]::new($AccountName)).Translate([System.Security.Principal.SecurityIdentifier])
    $canonical = $sid.Translate([System.Security.Principal.NTAccount]).Value
  } catch { Fail 'TARGET_ACCOUNT_INVALID' "Could not resolve target account $AccountName" }
  if ($sid.Value -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    Fail 'TARGET_ACCOUNT_PRIVILEGED' 'TargetAccount must be distinct from the elevated installer account'
  }
  try {
    Add-Type -AssemblyName System.DirectoryServices.AccountManagement
    $contextType = if ($canonical.StartsWith("$env:COMPUTERNAME\", [StringComparison]::OrdinalIgnoreCase)) { 'Machine' } else { 'Domain' }
    $contextKind = [Enum]::Parse([DirectoryServices.AccountManagement.ContextType], $contextType)
    $context = [DirectoryServices.AccountManagement.PrincipalContext]::new($contextKind)
    $user = [DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($context, $canonical)
    if ($null -eq $user) { throw 'account principal missing' }
    $authorizationSids = @($user.GetAuthorizationGroups() | ForEach-Object { $_.Sid.Value })
    $user.Dispose(); $context.Dispose()
  } catch { Fail 'TARGET_ACCOUNT_INVALID' 'Could not determine target account group membership' }
  if ($authorizationSids -contains 'S-1-5-32-544') { Fail 'TARGET_ACCOUNT_PRIVILEGED' 'TargetAccount must not be an administrator' }
  $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($sid.Value)"
  $profile = (Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
  if ([string]::IsNullOrWhiteSpace($profile)) { Fail 'TARGET_PROFILE_MISSING' 'TargetAccount must have an initialized Windows profile' }
  return [pscustomobject]@{
    account = $canonical
    sid = $sid.Value
    mutableStateDir = Join-Path ([Environment]::ExpandEnvironmentVariables([string]$profile)) 'AppData\Local\PlaytimePact\remote'
  }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Assert-Administrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'ELEVATION_REQUIRED' 'This action must run from an elevated PowerShell session'
  }
}

function Restart-PrivilegedBrokerIfInstalled {
  $service = Get-Service -Name 'PlaytimePactPrivilegedBroker' -ErrorAction SilentlyContinue
  if (-not $service) { return }
  try {
    Restart-Service -Name $service.Name -Force -ErrorAction Stop
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(20))
  } catch {
    Fail 'SERVICE_RESTART_FAILED' 'Protected configuration was published but the privileged broker could not reload it'
  }
}

function Assert-AppStopped {
  if (Get-Process -Name 'Playtime Pact' -ErrorAction SilentlyContinue) {
    Fail 'APP_RUNNING' 'Stop Playtime Pact before changing the protected configuration'
  }
}

function Assert-Identifier([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9._:-]{1,128}$') {
    Fail 'BAD_IDENTIFIER' "$Name must contain 1-128 letters, digits, dot, underscore, colon or hyphen characters"
  }
}

function Assert-Guid([string]$Name, [string]$Value) {
  $parsed = [Guid]::Empty
  if (-not [Guid]::TryParse($Value, [ref]$parsed) -or $parsed.ToString() -ne $Value.ToLowerInvariant()) {
    Fail 'IDENTITY_MISMATCH' "$Name must be a canonical UUID"
  }
}

function Assert-HttpsEndpoint([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail 'ARGUMENT_REQUIRED' '-BaseUrl is required' }
  try { $uri = [Uri]$Value } catch { Fail 'BAD_ENDPOINT' "$Value is not an absolute URL" }
  if (-not $uri.IsAbsoluteUri) { Fail 'BAD_ENDPOINT' "$Value is not an absolute URL" }
  $localHttp = $uri.Scheme -eq 'http' -and ($uri.Host -eq 'localhost' -or $uri.Host -eq '127.0.0.1')
  if ($uri.Scheme -ne 'https' -and -not $localHttp) { Fail 'INSECURE_ENDPOINT' "$Value must use HTTPS" }
  if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.AbsolutePath -ne '/') {
    Fail 'BAD_ENDPOINT' '-BaseUrl must be an origin without credentials, path, query or fragment'
  }
  return $uri.AbsoluteUri.TrimEnd('/')
}

function Assert-PublicJwk($Value, [string]$Name) {
  if ($null -eq $Value -or $Value.kty -ne 'EC' -or $Value.crv -ne 'P-256' -or -not ($Value.x -match '^[A-Za-z0-9_-]{43}$') -or -not ($Value.y -match '^[A-Za-z0-9_-]{43}$')) {
    Fail 'IDENTITY_MISMATCH' "$Name must be a public P-256 JWK"
  }
  foreach ($member in @('d','p','q','dp','dq','qi','k')) {
    if ($Value.PSObject.Properties.Name -contains $member) { Fail 'PRIVATE_KEY_REJECTED' "$Name contains private key member $member" }
  }
}

function Test-JwkEqual($Left, $Right) {
  return $null -ne $Left -and $null -ne $Right -and $Left.kty -eq $Right.kty -and $Left.crv -eq $Right.crv -and $Left.x -eq $Right.x -and $Left.y -eq $Right.y
}

# --- CNG identity -----------------------------------------------------------------

function Open-ProvisionedKey([string]$KeyName) {
  $machine = [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey
  if ([string]::IsNullOrWhiteSpace($KeyName) -or -not [System.Security.Cryptography.CngKey]::Exists($KeyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, $machine)) {
    Fail 'KEY_MISSING' "$KeyName does not exist in the machine key store"
  }
  $key = [System.Security.Cryptography.CngKey]::Open(
    $KeyName,
    [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,
    [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
  if ($key.Provider.Provider -ne 'Microsoft Software Key Storage Provider' -or $key.Algorithm.Algorithm -ne 'ECDSA_P256' -or $key.AlgorithmGroup.AlgorithmGroup -ne 'ECDsa' -or $key.KeySize -ne 256) {
    $key.Dispose()
    Fail 'KEY_INVALID' "$KeyName is not a Microsoft Software KSP P-256 ECDSA key"
  }
  $forbidden = [System.Security.Cryptography.CngExportPolicies]::AllowExport `
    -bor [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextExport `
    -bor [System.Security.Cryptography.CngExportPolicies]::AllowArchiving `
    -bor [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextArchiving
  if (($key.ExportPolicy -band $forbidden) -ne 0) {
    $key.Dispose()
    Fail 'KEY_EXPORTABLE' "$KeyName allows export or archiving"
  }
  return $key
}

function Set-MachineKeyAcl([System.Security.Cryptography.CngKey]$Key, [string]$ProvisioningOperatorSid) {
  # During enrollment only the distinct installer and LocalSystem may sign.
  # ImportRegistration removes the installer ACE before handing authority to the service.
  $operatorAce = if ([string]::IsNullOrWhiteSpace($ProvisioningOperatorSid)) { '' } else { "(A;;GA;;;$ProvisioningOperatorSid)" }
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new("O:SYG:SYD:P(A;;GA;;;SY)$operatorAce")
  $bytes = [byte[]]::new($descriptor.BinaryLength)
  $descriptor.GetBinaryForm($bytes, 0)
  $securityInformation = 0x1 -bor 0x2 -bor 0x4 # OWNER, GROUP and DACL_SECURITY_INFORMATION
  $options = [System.Security.Cryptography.CngPropertyOptions]([int][System.Security.Cryptography.CngPropertyOptions]::Persist -bor $securityInformation)
  $property = [System.Security.Cryptography.CngProperty]::new('Security Descr', $bytes, $options)
  $Key.SetProperty($property)
}

function New-NonExportableKey([string]$KeyName, [string]$ProvisioningOperatorSid) {
  if ([System.Security.Cryptography.CngKey]::Exists($KeyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
    $existing = Open-ProvisionedKey $KeyName
    Set-MachineKeyAcl $existing $ProvisioningOperatorSid
    return $existing
  }
  $parameters = [System.Security.Cryptography.CngKeyCreationParameters]::new()
  $parameters.Provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $parameters.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey
  $parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
  $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
  $created = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $parameters)
  Set-MachineKeyAcl $created $ProvisioningOperatorSid
  return $created
}

function Remove-ProvisionedKeysAsSystem([string[]]$KeyNames) {
  $work = Join-Path $ProtectedDir "key-reset.$PID.$([Guid]::NewGuid().ToString('N'))"
  $scriptPath = Join-Path $work 'reset.ps1'
  $resultPath = Join-Path $work 'result.txt'
  $taskName = "PlaytimePact-KeyReset-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  Set-ProtectedDirectoryAcl ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $names = ($KeyNames | ConvertTo-Json -Compress).Replace("'", "''")
  @(
    "`$ErrorActionPreference='Stop'",
    "try { foreach (`$name in ('$names' | ConvertFrom-Json)) {",
    "  `$key=[Security.Cryptography.CngKey]::Open(`$name,[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey)",
    '  try { $key.Delete() } finally { $key.Dispose() }',
    "}; [IO.File]::WriteAllText('$resultPath','REMOVED') } catch { [IO.File]::WriteAllText('$resultPath','FAILED') }"
  ) | Set-Content -LiteralPath $scriptPath -Encoding UTF8
  $watcher = [IO.FileSystemWatcher]::new($work, 'result.txt')
  $watcher.EnableRaisingEvents = $true
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::Created, 20000)
    if ($change.TimedOut -or -not (Test-Path -LiteralPath $resultPath) -or [IO.File]::ReadAllText($resultPath) -ne 'REMOVED') { Fail 'KEY_DELETE_FAILED' 'LocalSystem could not remove the provisioned keys' }
  } finally {
    $watcher.Dispose()
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-ServiceKeyBoundary($Bundle) {
  $work = Join-Path $env:TEMP "PlaytimePact-KeyVerify-$PID-$([Guid]::NewGuid().ToString('N'))"
  $scriptPath = Join-Path $work 'verify.ps1'
  $requestPath = Join-Path $work 'request.json'
  $resultPath = Join-Path $work 'result.txt'
  $taskName = "PlaytimePact-KeyVerify-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $work | Out-Null
  $operator = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  Invoke-Icacls @($work, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', "${operator}:(OI)(CI)F") $work
  Write-Utf8NoBom $requestPath ((@($Bundle.operational, $Bundle.admin)) | ConvertTo-Json -Depth 8)
  @(
    "`$ErrorActionPreference='Stop'",
    "try { foreach (`$identity in @([IO.File]::ReadAllText('$requestPath') | ConvertFrom-Json)) {",
    "`$key=[Security.Cryptography.CngKey]::Open([string]`$identity.keyName,[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,[Security.Cryptography.CngKeyOpenOptions]::MachineKey)",
    "try { `$forbidden=[Security.Cryptography.CngExportPolicies]::AllowExport -bor [Security.Cryptography.CngExportPolicies]::AllowPlaintextExport -bor [Security.Cryptography.CngExportPolicies]::AllowArchiving -bor [Security.Cryptography.CngExportPolicies]::AllowPlaintextArchiving; if(`$key.Provider.Provider -ne 'Microsoft Software Key Storage Provider' -or `$key.Algorithm.Algorithm -ne 'ECDSA_P256' -or `$key.AlgorithmGroup.AlgorithmGroup -ne 'ECDsa' -or `$key.KeySize -ne 256 -or (`$key.ExportPolicy -band `$forbidden) -ne 0){throw 'key'}; `$o=[Security.Cryptography.CngPropertyOptions](1 -bor 2 -bor 4); `$sd=[Security.AccessControl.RawSecurityDescriptor]::new(`$key.GetProperty('Security Descr',`$o).GetValue(),0); `$sids=@(`$sd.DiscretionaryAcl|% {`$_.SecurityIdentifier.Value}); if(`$sd.Owner.Value -ne 'S-1-5-18' -or `$sd.Group.Value -ne 'S-1-5-18' -or (`$sids -join ',') -ne 'S-1-5-18'){throw 'acl'}; `$b=`$key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob); if(`$b.Length -ne 72){throw 'key'}; `$x=[Convert]::ToBase64String(`$b[8..39]).TrimEnd('=').Replace('+','-').Replace('/','_'); `$y=[Convert]::ToBase64String(`$b[40..71]).TrimEnd('=').Replace('+','-').Replace('/','_'); if(`$x -ne `$identity.publicJwk.x -or `$y -ne `$identity.publicJwk.y){throw 'jwk'}; `$s=[Security.Cryptography.ECDsaCng]::new(`$key); try{`$null=`$s.SignData([Text.Encoding]::ASCII.GetBytes('service-boundary'),[Security.Cryptography.HashAlgorithmName]::SHA256)}finally{`$s.Dispose()} } finally { `$key.Dispose() }",
    "}; [IO.File]::WriteAllText('$resultPath','VERIFIED') } catch { [IO.File]::WriteAllText('$resultPath','FAILED') }"
  ) | Set-Content -LiteralPath $scriptPath -Encoding UTF8
  $watcher = [IO.FileSystemWatcher]::new($work, 'result.txt'); $watcher.EnableRaisingEvents = $true
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $change = $watcher.WaitForChanged([IO.WatcherChangeTypes]::Created, 20000)
    if ($change.TimedOut -or -not (Test-Path -LiteralPath $resultPath) -or [IO.File]::ReadAllText($resultPath) -ne 'VERIFIED') { Fail 'KEY_BOUNDARY_INVALID' 'LocalSystem could not verify the service-only machine keys' }
  } finally {
    $watcher.Dispose(); Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-ServiceKeyBoundary($Bundle) {
  foreach ($identity in @($Bundle.operational, $Bundle.admin)) {
    $key = $null
    try { $key = Open-ProvisionedKey $identity.keyName } catch { $key = $null }
    if ($key) {
      try {
        $actual = Get-PublicJwk $key
        if (-not (Test-JwkEqual $actual $identity.publicJwk)) { Fail 'IDENTITY_MISMATCH' 'Machine key does not match its recorded public identity' }
        Set-MachineKeyAcl $key $null
      } finally { $key.Dispose() }
    }
  }
  Test-ServiceKeyBoundary $Bundle
}

function Get-PublicJwk([System.Security.Cryptography.CngKey]$Key) {
  $blob = $Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
  if ($blob.Length -ne 72) { Fail 'KEY_INVALID' 'Unexpected public key blob size' }
  [ordered]@{
    crv = 'P-256'
    kty = 'EC'
    x   = ConvertTo-Base64Url $blob[8..39]
    y   = ConvertTo-Base64Url $blob[40..71]
  }
}

function Get-ContentDigest([string]$Body) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return "sha-256=:$([Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Body)))):"
  } finally { $sha.Dispose() }
}

function Invoke-CngSign([System.Security.Cryptography.CngKey]$Key, [byte[]]$Data) {
  $signer = [System.Security.Cryptography.ECDsaCng]::new($Key)
  try {
    $signature = $signer.SignData($Data, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    if ($signature.Length -ne 64) { Fail 'SIGNATURE_FORMAT_INVALID' 'CNG did not return a 64-byte ES256 signature' }
    if (-not $signer.VerifyData($Data, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256)) {
      Fail 'SIGNATURE_INVALID' 'CNG could not verify its own signature'
    }
    return $signature
  } finally { $signer.Dispose() }
}

function New-SignedProof {
  param(
    [System.Security.Cryptography.CngKey]$Key,
    $PublicJwk,
    [string]$ActorId,
    [string]$Method,
    [string]$CanonicalUrl,
    [string]$Body,
    [string]$IdempotencyKey,
    [int]$MembershipEpochClaim,
    [int]$ServiceEpochClaim
  )
  $header = [ordered]@{ alg = 'ES256'; typ = 'remote-approval+jws'; jwk = $PublicJwk }
  $claims = [ordered]@{
    actorId          = $ActorId
    clientVersionCode = 1
    contentDigest    = Get-ContentDigest $Body
    htm              = $Method
    htu              = $CanonicalUrl
    iat              = [long][Math]::Floor(([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() / 1000)
    idempotencyKey   = $IdempotencyKey
    jti              = [Guid]::NewGuid().ToString()
    membershipEpoch  = $MembershipEpochClaim
    nonce            = [Guid]::NewGuid().ToString()
    serviceEpoch     = $ServiceEpochClaim
  }
  $protectedSegment = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($header | ConvertTo-Json -Compress -Depth 6)))
  $payloadSegment = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($claims | ConvertTo-Json -Compress -Depth 6)))
  $signature = Invoke-CngSign $Key ([Text.Encoding]::ASCII.GetBytes("$protectedSegment.$payloadSegment"))
  $token = [ordered]@{ protected = $protectedSegment; payload = $payloadSegment; signature = (ConvertTo-Base64Url $signature) }
  return "Bearer $($token | ConvertTo-Json -Compress -Depth 4)"
}

# --- Files and ACL ----------------------------------------------------------------

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
  [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}

function Write-JsonAtomically([string]$Path, $Value) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    Write-Utf8NoBom $temporary ($Value | ConvertTo-Json -Depth 12)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Read-JsonFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { Fail 'JSON_INVALID' "$Path is not valid JSON" }
}

function Invoke-Icacls([string[]]$Arguments, [string]$Subject) {
  & icacls.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'ACL_FAILED' "Could not secure $Subject" }
}

function Set-ProtectedDirectoryAcl([string]$ReadAccount) {
  if (-not (Test-Path -LiteralPath $ProtectedDir)) {
    try { New-Item -ItemType Directory -Path $ProtectedDir -Force | Out-Null }
    catch { Fail 'CONFIG_WRITE_FAILED' "Could not create the protected configuration directory: $($_.Exception.Message)" }
  }
  Invoke-Icacls @(
    $ProtectedDir,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    "${ReadAccount}:(OI)(CI)RX",
    '/T',
    '/C'
  ) $ProtectedDir
}

function Set-ProtectedFileAcl([string]$Path, [string]$ReadAccount) {
  Invoke-Icacls @(
    $Path,
    '/inheritance:r',
    '/grant:r',
    '*S-1-5-18:F',
    '*S-1-5-32-544:F',
    "${ReadAccount}:R",
    '/C'
  ) $Path
}

# --- Bundle and receipt validation -------------------------------------------------

function Assert-KeyMatchesJwk([string]$KeyName, $ExpectedJwk) {
  $key = Open-ProvisionedKey $KeyName
  try {
    $actual = Get-PublicJwk $key
    if (-not (Test-JwkEqual $actual $ExpectedJwk)) { Fail 'IDENTITY_MISMATCH' "$KeyName does not match the recorded public JWK. Use -Action ResetIdentity -ConfirmPcId <id>" }
  } finally { $key.Dispose() }
}

function Assert-PendingBundle($Bundle, [switch]$SkipKeyAccess) {
  if ($null -eq $Bundle -or $Bundle.schemaVersion -ne 1) { Fail 'ENROLLMENT_INVALID' 'pending-enrollment.json has an unsupported schema' }
  Assert-Guid 'pcId' ([string]$Bundle.pcId)
  Assert-Guid 'recoveryParentId' ([string]$Bundle.recoveryParentId)
  if ($Bundle.pcId -eq $Bundle.recoveryParentId) { Fail 'IDENTITY_MISMATCH' 'pcId and recoveryParentId must differ' }
  $target = Resolve-TargetAccount $Bundle.windowsAccount
  if ($Bundle.windowsAccountSid -ne $target.sid -or $Bundle.mutableStateDir -ne $target.mutableStateDir) { Fail 'WRONG_WINDOWS_ACCOUNT' 'Pending target account metadata changed' }
  $expectedOperational = "PlaytimePact-$($Bundle.pcId)-operational"
  $expectedAdmin = "PlaytimePact-$($Bundle.pcId)-admin"
  if ($Bundle.operational.actorId -ne $Bundle.pcId -or $Bundle.operational.keyName -ne $expectedOperational) { Fail 'IDENTITY_MISMATCH' 'Operational identity does not match pcId' }
  if ($Bundle.admin.actorId -ne $Bundle.recoveryParentId -or $Bundle.admin.keyName -ne $expectedAdmin) { Fail 'IDENTITY_MISMATCH' 'Admin identity does not match recoveryParentId' }
  if ($Bundle.operational.keyName -eq $Bundle.admin.keyName) { Fail 'IDENTITY_MISMATCH' 'Operational and admin keys must differ' }
  Assert-PublicJwk $Bundle.operational.publicJwk 'operational.publicJwk'
  Assert-PublicJwk $Bundle.admin.publicJwk 'admin.publicJwk'
  if (Test-JwkEqual $Bundle.operational.publicJwk $Bundle.admin.publicJwk) { Fail 'IDENTITY_MISMATCH' 'Operational and admin public keys must differ' }
  if (-not $SkipKeyAccess) {
    Assert-KeyMatchesJwk $Bundle.operational.keyName $Bundle.operational.publicJwk
    Assert-KeyMatchesJwk $Bundle.admin.keyName $Bundle.admin.publicJwk
  }
}

function Get-PendingBundle {
  $bundle = Read-JsonFile $PendingEnrollmentPath
  if (-not $bundle) { Fail 'ENROLLMENT_MISSING' "Run -Action NewPcIdentity first ($PendingEnrollmentPath)" }
  Assert-PendingBundle $bundle
  return $bundle
}

function Assert-WorkerRegistrationReceipt($WorkerReceipt, $Bundle, [string]$ExpectedHouseholdId) {
  if ($null -eq $WorkerReceipt -or $WorkerReceipt.v -ne 1 -or $WorkerReceipt.operation -ne 'registerPc') { Fail 'RECEIPT_INVALID' 'Worker registration receipt has an unsupported schema or operation' }
  if ($WorkerReceipt.household_id -ne $ExpectedHouseholdId) { Fail 'HOUSEHOLD_MISMATCH' 'Worker receipt household does not match the requested household' }
  if ($WorkerReceipt.pc_id -ne $Bundle.pcId) { Fail 'IDENTITY_MISMATCH' 'Worker receipt pcId does not match the pending identity' }
  if ($WorkerReceipt.iana_time_zone -ne $Bundle.ianaTimeZone) { Fail 'RECEIPT_INVALID' 'Worker receipt timezone does not match the pending identity' }
  if ($WorkerReceipt.membership_epoch -lt 1 -or $WorkerReceipt.service_epoch -lt 1) { Fail 'RECEIPT_INVALID' 'Worker receipt epochs must be positive integers' }
  try { $registeredJwk = [string]$WorkerReceipt.public_key | ConvertFrom-Json } catch { Fail 'RECEIPT_INVALID' 'Worker receipt public_key is not JSON' }
  Assert-PublicJwk $registeredJwk 'workerReceipt.public_key'
  if (-not (Test-JwkEqual $registeredJwk $Bundle.operational.publicJwk)) { Fail 'IDENTITY_MISMATCH' 'Worker receipt public key does not match the operational identity' }
}

function Assert-RegistrationReceipt($Receipt, $Bundle, [string]$ExpectedBaseUrl, [string]$ExpectedHouseholdId) {
  if ($null -eq $Receipt -or $Receipt.schemaVersion -ne 1) { Fail 'RECEIPT_INVALID' 'Registration receipt has an unsupported schema' }
  if ($Receipt.baseUrl -ne $ExpectedBaseUrl) { Fail 'RECEIPT_INVALID' 'Registration receipt base URL does not match -BaseUrl' }
  if ($Receipt.householdId -ne $ExpectedHouseholdId) { Fail 'HOUSEHOLD_MISMATCH' 'Registration receipt household does not match -HouseholdId' }
  if ($Receipt.pcId -ne $Bundle.pcId) { Fail 'IDENTITY_MISMATCH' 'Registration receipt pcId does not match the identity' }
  Assert-WorkerRegistrationReceipt $Receipt.workerReceipt $Bundle $ExpectedHouseholdId
}

function Assert-ConfigProperties($Value, [string[]]$Names, [string]$Context) {
  if ($null -eq $Value) { Fail 'CONFIG_INVALID' "$Context must be an object" }
  $propertyNames = @($Value.PSObject.Properties | ForEach-Object Name)
  foreach ($name in $Names) {
    if ($propertyNames -notcontains $name) { Fail 'CONFIG_INVALID' "$Context.$name is required" }
  }
}

function Assert-ConfigShape($Config) {
  Assert-ConfigProperties $Config @('schemaVersion','baseUrl','mutableStateDir','windowsAccount','windowsAccountSid','membership','operational','admin') 'config'
  Assert-ConfigProperties $Config.membership @('householdId','pcId','membershipEpoch','serviceEpoch') 'membership'
  Assert-ConfigProperties $Config.operational @('actorId','keyName','publicJwk') 'operational'
  Assert-ConfigProperties $Config.admin @('actorId','keyName','publicJwk','recoveryParentId','recoveryPublicJwk') 'admin'
  Assert-ConfigProperties $Config.operational.publicJwk @('kty','crv','x','y') 'operational.publicJwk'
  Assert-ConfigProperties $Config.admin.publicJwk @('kty','crv','x','y') 'admin.publicJwk'
  Assert-ConfigProperties $Config.admin.recoveryPublicJwk @('kty','crv','x','y') 'admin.recoveryPublicJwk'
  if ($Config.schemaVersion -ne 1) { Fail 'CONFIG_INVALID' 'schemaVersion must be 1' }
  $null = Assert-HttpsEndpoint ([string]$Config.baseUrl)
  $target = Resolve-TargetAccount ([string]$Config.windowsAccount)
  if ([string]::IsNullOrWhiteSpace($Config.mutableStateDir) -or -not [IO.Path]::IsPathRooted([string]$Config.mutableStateDir) -or [IO.Path]::GetFullPath([string]$Config.mutableStateDir) -ne [IO.Path]::GetFullPath($target.mutableStateDir) -or $Config.windowsAccountSid -ne $target.sid) {
    Fail 'CONFIG_INVALID' 'Target account metadata does not match its initialized profile'
  }
  Assert-Guid 'membership.pcId' ([string]$Config.membership.pcId)
  Assert-Guid 'admin.recoveryParentId' ([string]$Config.admin.recoveryParentId)
  Assert-Identifier 'membership.householdId' ([string]$Config.membership.householdId)
  if ($Config.membership.membershipEpoch -lt 1 -or $Config.membership.serviceEpoch -lt 1) { Fail 'CONFIG_INVALID' 'membership epochs must be positive integers' }
  if ($Config.operational.actorId -ne $Config.membership.pcId) { Fail 'CONFIG_INVALID' 'operational.actorId must equal membership.pcId' }
  if ($Config.admin.actorId -ne $Config.admin.recoveryParentId) { Fail 'CONFIG_INVALID' 'admin.actorId must equal admin.recoveryParentId' }
  if ($Config.operational.keyName -ne "PlaytimePact-$($Config.membership.pcId)-operational") { Fail 'CONFIG_INVALID' 'operational.keyName does not match membership.pcId' }
  if ($Config.admin.keyName -ne "PlaytimePact-$($Config.membership.pcId)-admin") { Fail 'CONFIG_INVALID' 'admin.keyName does not match membership.pcId' }
  if ($Config.admin.keyName -eq $Config.operational.keyName) { Fail 'CONFIG_INVALID' 'admin and operational keys must differ' }
  Assert-PublicJwk $Config.operational.publicJwk 'operational.publicJwk'
  Assert-PublicJwk $Config.admin.publicJwk 'admin.publicJwk'
  Assert-PublicJwk $Config.admin.recoveryPublicJwk 'admin.recoveryPublicJwk'
  if (Test-JwkEqual $Config.operational.publicJwk $Config.admin.publicJwk) { Fail 'CONFIG_INVALID' 'admin and operational public JWKs must differ' }
  if (-not (Test-JwkEqual $Config.admin.publicJwk $Config.admin.recoveryPublicJwk)) { Fail 'CONFIG_INVALID' 'admin and recovery public JWKs must match' }
}

function Invoke-VerifyConfig([string]$Path = $ProtectedConfigPath) {
  $config = Read-JsonFile $Path
  if (-not $config) { Fail 'CONFIG_MISSING' "$Path does not exist" }
  Assert-ConfigShape $config
  Test-ServiceKeyBoundary $config
  return [ordered]@{
    configPath      = $Path
    householdId     = $config.membership.householdId
    pcId            = $config.membership.pcId
    mutableStateDir = $config.mutableStateDir
    verified        = $true
  }
}

function Install-ProtectedConfig($Config, [string]$ReadAccount, [switch]$Replace, [switch]$SkipKeyValidation) {
  $temporary = Join-Path $ProtectedDir "config.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $backup = Join-Path $ProtectedDir "config.$PID.$([Guid]::NewGuid().ToString('N')).bak"
  $hadExisting = $false
  $published = $false
  try {
    try { Set-ProtectedDirectoryAcl $ReadAccount }
    catch { Fail 'CONFIG_WRITE_FAILED' 'Could not prepare the protected configuration directory' }
    try {
      Write-Utf8NoBom $temporary ($Config | ConvertTo-Json -Depth 12)
      Set-ProtectedFileAcl $temporary $ReadAccount
    } catch {
      Fail 'CONFIG_WRITE_FAILED' 'Could not stage the protected configuration'
    }

    # Key access, JWK matching and signing failures are validation failures, not
    # protected-file write failures, so keep this outside the write catch.
    if (-not $SkipKeyValidation) { $null = Invoke-VerifyConfig $temporary }

    try { $hadExisting = Test-Path -LiteralPath $ProtectedConfigPath -PathType Leaf }
    catch { Fail 'CONFIG_WRITE_FAILED' 'Could not inspect the protected configuration destination' }
    if ($hadExisting -and -not $Replace) { Fail 'CONFIG_EXISTS' 'Protected configuration appeared during import' }

    try {
      if ($hadExisting) {
        [IO.File]::Replace($temporary, $ProtectedConfigPath, $backup, $true)
      } else {
        Move-Item -LiteralPath $temporary -Destination $ProtectedConfigPath
      }
      $published = $true
      Set-ProtectedFileAcl $ProtectedConfigPath $ReadAccount
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } catch {
      if ($published) {
        try {
          if ($hadExisting -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
            [IO.File]::Replace($backup, $ProtectedConfigPath, $null, $true)
          } elseif (-not $hadExisting) {
            Remove-Item -LiteralPath $ProtectedConfigPath -Force -ErrorAction Stop
          }
        } catch {
          Fail 'CONFIG_WRITE_FAILED' 'Could not publish or roll back the protected configuration'
        }
      }
      Fail 'CONFIG_WRITE_FAILED' 'Could not publish the protected configuration'
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

# --- Actions ----------------------------------------------------------------------

function Write-IdentityResult($Bundle) {
  Write-Output ([ordered]@{
    pcId              = $Bundle.pcId
    recoveryParentId  = $Bundle.recoveryParentId
    adminPublicJwk    = $AdminPublicJwkPath
    pendingEnrollment = $PendingEnrollmentPath
  } | ConvertTo-Json -Depth 6)
}

function Invoke-NewPcIdentity {
  Assert-Administrator
  $target = Resolve-TargetAccount $TargetAccount
  $installed = Read-JsonFile $ProtectedConfigPath
  if ($installed) {
    $verification = Invoke-VerifyConfig
    Write-Output ([ordered]@{
      pcId             = $installed.membership.pcId
      recoveryParentId = $installed.admin.recoveryParentId
      configPath       = $ProtectedConfigPath
      verified         = $verification.verified
      noOp             = $true
    } | ConvertTo-Json -Depth 6)
    return
  }

  $existing = Read-JsonFile $PendingEnrollmentPath
  if ($existing) {
    Assert-PendingBundle $existing
    if (-not [string]::IsNullOrWhiteSpace($IanaTimeZone) -and $existing.ianaTimeZone -ne $IanaTimeZone) {
      Fail 'IDENTITY_MISMATCH' 'The pending identity uses a different IANA timezone; reset it explicitly before changing identity inputs'
    }
    Write-IdentityResult $existing
    return
  }

  $pcId = [Guid]::NewGuid().ToString()
  $recoveryParentId = [Guid]::NewGuid().ToString()
  $operationalKeyName = "PlaytimePact-$pcId-operational"
  $adminKeyName = "PlaytimePact-$pcId-admin"
  $createdKeyNames = @()
  try {
    $operatorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $operationalKey = New-NonExportableKey $operationalKeyName $operatorSid
    $createdKeyNames += $operationalKeyName
    try { $operationalJwk = Get-PublicJwk $operationalKey } finally { $operationalKey.Dispose() }
    $adminKey = New-NonExportableKey $adminKeyName $operatorSid
    $createdKeyNames += $adminKeyName
    try { $adminJwk = Get-PublicJwk $adminKey } finally { $adminKey.Dispose() }

    $bundle = [ordered]@{
      schemaVersion    = 1
      pcId             = $pcId
      recoveryParentId = $recoveryParentId
      windowsAccount    = $target.account
      windowsAccountSid = $target.sid
      mutableStateDir   = $target.mutableStateDir
      ianaTimeZone      = if ([string]::IsNullOrWhiteSpace($IanaTimeZone)) { 'UTC' } else { $IanaTimeZone }
      operational      = [ordered]@{ actorId = $pcId; keyName = $operationalKeyName; publicJwk = $operationalJwk }
      admin            = [ordered]@{ actorId = $recoveryParentId; keyName = $adminKeyName; publicJwk = $adminJwk }
    }
    Write-JsonAtomically $PendingEnrollmentPath $bundle
    Write-JsonAtomically $AdminPublicJwkPath $adminJwk
  } catch {
    Remove-Item -LiteralPath $PendingEnrollmentPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $AdminPublicJwkPath -Force -ErrorAction SilentlyContinue
    foreach ($keyName in $createdKeyNames) {
      if ([System.Security.Cryptography.CngKey]::Exists($keyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
        $createdKey = [System.Security.Cryptography.CngKey]::Open($keyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
        try { $createdKey.Delete() } finally { $createdKey.Dispose() }
      }
    }
    throw
  }
  Write-IdentityResult $bundle
}

function Invoke-RegisterPc {
  Assert-Administrator
  $base = Assert-HttpsEndpoint $BaseUrl
  Assert-Identifier 'HouseholdId' $HouseholdId
  $bundle = Get-PendingBundle
  $receiptPath = if ([string]::IsNullOrWhiteSpace($RegistrationReceipt)) { $DefaultRegistrationReceiptPath } else { [IO.Path]::GetFullPath($RegistrationReceipt) }

  if ($bundle.PSObject.Properties.Name -contains 'registration') {
    if ($bundle.registration.householdId -ne $HouseholdId) { Fail 'HOUSEHOLD_MISMATCH' "Pending enrollment is bound to $($bundle.registration.householdId). Use -Action ResetIdentity -ConfirmPcId $($bundle.pcId)" }
    if ($bundle.registration.baseUrl -ne $base) { Fail 'IDENTITY_MISMATCH' 'Pending enrollment is bound to another Worker origin' }
  } else {
    $bundle | Add-Member -NotePropertyName registration -NotePropertyValue ([pscustomobject]@{ householdId = $HouseholdId; baseUrl = $base })
    Write-JsonAtomically $PendingEnrollmentPath $bundle
  }

  $existingReceipt = Read-JsonFile $receiptPath
  if ($existingReceipt) {
    Assert-RegistrationReceipt $existingReceipt $bundle $base $HouseholdId
    Write-Output ($existingReceipt | ConvertTo-Json -Depth 12)
    return
  }

  $body = [ordered]@{
    householdId  = $HouseholdId
    pcId         = $bundle.pcId
    publicKey    = ($bundle.operational.publicJwk | ConvertTo-Json -Compress -Depth 4)
    ianaTimeZone = $bundle.ianaTimeZone
  }
  $payload = $body | ConvertTo-Json -Compress -Depth 8
  $url = "$base/v1/pcs"
  $idempotencyKey = "register-pc:$($bundle.pcId)"
  $adminKey = Open-ProvisionedKey $bundle.admin.keyName
  try {
    $proof = New-SignedProof -Key $adminKey -PublicJwk $bundle.admin.publicJwk -ActorId $bundle.admin.actorId -Method 'POST' -CanonicalUrl $url -Body $payload -IdempotencyKey $idempotencyKey -MembershipEpochClaim 1 -ServiceEpochClaim 1
  } finally { $adminKey.Dispose() }
  try {
    $response = Invoke-RestMethod -Method POST -Uri $url -Headers @{ authorization = $proof; 'content-type' = 'application/json' } -Body $payload -MaximumRedirection 0
  } catch {
    Fail 'REGISTRATION_FAILED' "POST /v1/pcs failed: $($_.Exception.Message)"
  }
  Assert-WorkerRegistrationReceipt $response $bundle $HouseholdId
  $receipt = [ordered]@{
    schemaVersion = 1
    householdId   = $HouseholdId
    pcId          = $bundle.pcId
    baseUrl       = $base
    operationKey  = $idempotencyKey
    workerReceipt = $response
  }
  Write-JsonAtomically $receiptPath $receipt
  Write-Output ($receipt | ConvertTo-Json -Depth 12)
}

function Invoke-IssuePairing {
  Assert-Administrator
  $base = Assert-HttpsEndpoint $BaseUrl
  Assert-Identifier 'HouseholdId' $HouseholdId
  $receiptPath = if ([string]::IsNullOrWhiteSpace($RegistrationReceipt)) { $DefaultRegistrationReceiptPath } else { [IO.Path]::GetFullPath($RegistrationReceipt) }
  $receipt = Read-JsonFile $receiptPath
  if (-not $receipt) { Fail 'RECEIPT_MISSING' "$receiptPath does not exist" }
  $bundle = Read-JsonFile $PendingEnrollmentPath
  if ($bundle) {
    Assert-PendingBundle $bundle
  } else {
    $config = Read-JsonFile $ProtectedConfigPath
    if (-not $config) { Fail 'ENROLLMENT_MISSING' 'No pending or protected remote identity exists' }
    Assert-ConfigShape $config
    if ($config.PSObject.Properties.Name -contains 'disabled' -and $config.disabled -eq $true) { Fail 'CONFIG_DISABLED' 'Protected remote approval is disabled' }
    $bundle = BundleFromConfig $config
    $bundle.ianaTimeZone = $receipt.workerReceipt.iana_time_zone
  }
  Assert-RegistrationReceipt $receipt $bundle $base $HouseholdId
  $body = [ordered]@{ householdId = $HouseholdId; pcId = $bundle.pcId }
  $payload = $body | ConvertTo-Json -Compress -Depth 4
  $url = "$base/v1/pairing-sessions"
  $operationKey = if ([string]::IsNullOrWhiteSpace($PairingOperationKey)) { "issue-pairing:$($bundle.pcId)" } else { $PairingOperationKey }
  Assert-Identifier 'PairingOperationKey' $operationKey
  $adminKey = Open-ProvisionedKey $bundle.admin.keyName
  try {
    $proof = New-SignedProof -Key $adminKey -PublicJwk $bundle.admin.publicJwk -ActorId $bundle.admin.actorId -Method 'POST' -CanonicalUrl $url -Body $payload -IdempotencyKey $operationKey -MembershipEpochClaim ([int]$receipt.workerReceipt.membership_epoch) -ServiceEpochClaim ([int]$receipt.workerReceipt.service_epoch)
  } finally { $adminKey.Dispose() }
  try {
    $response = Invoke-RestMethod -Method POST -Uri $url -Headers @{ authorization = $proof; 'content-type' = 'application/json' } -Body $payload -MaximumRedirection 0
  } catch {
    Fail 'PAIRING_ISSUE_FAILED' "POST /v1/pairing-sessions failed: $($_.Exception.Message)"
  }
  if ($response.operation -ne 'issuePairing' -or -not ([string]$response.pairing_session_id -match '^[A-Za-z0-9._:-]{1,128}$') -or -not ([string]$response.token -match '^[A-Za-z0-9_-]{43,128}$') -or $response.expires_at_ms -ne $response.created_at_ms + 300000) {
    Fail 'PAIRING_RECEIPT_INVALID' 'Worker returned an invalid pairing-session receipt'
  }
  Write-Output ($response | ConvertTo-Json -Depth 8)
}

function ConfigMatchesRegistration($Config, $Bundle, $Receipt, [string]$Base) {
  return $Config.baseUrl -eq $Base `
    -and $Config.mutableStateDir -eq $Bundle.mutableStateDir `
    -and $Config.windowsAccount -eq $Bundle.windowsAccount `
    -and $Config.windowsAccountSid -eq $Bundle.windowsAccountSid `
    -and $Config.membership.householdId -eq $Receipt.householdId `
    -and $Config.membership.pcId -eq $Bundle.pcId `
    -and $Config.membership.membershipEpoch -eq $Receipt.workerReceipt.membership_epoch `
    -and $Config.membership.serviceEpoch -eq $Receipt.workerReceipt.service_epoch `
    -and $Config.operational.actorId -eq $Bundle.operational.actorId `
    -and $Config.operational.keyName -eq $Bundle.operational.keyName `
    -and (Test-JwkEqual $Config.operational.publicJwk $Bundle.operational.publicJwk) `
    -and $Config.admin.actorId -eq $Bundle.admin.actorId `
    -and $Config.admin.keyName -eq $Bundle.admin.keyName `
    -and $Config.admin.recoveryParentId -eq $Bundle.recoveryParentId `
    -and (Test-JwkEqual $Config.admin.publicJwk $Bundle.admin.publicJwk) `
    -and (Test-JwkEqual $Config.admin.recoveryPublicJwk $Bundle.admin.publicJwk)
}

function BundleFromConfig($Config) {
  return [pscustomobject]@{
    schemaVersion = 1
    pcId = $Config.membership.pcId
    recoveryParentId = $Config.admin.recoveryParentId
    windowsAccount = $Config.windowsAccount
    windowsAccountSid = $Config.windowsAccountSid
    mutableStateDir = $Config.mutableStateDir
    ianaTimeZone = $null
    operational = $Config.operational
    admin = $Config.admin
  }
}

function Invoke-ImportRegistration {
  Assert-Administrator
  Assert-AppStopped
  $base = Assert-HttpsEndpoint $BaseUrl
  Assert-Identifier 'HouseholdId' $HouseholdId
  if ([string]::IsNullOrWhiteSpace($TargetAccount)) { Fail 'ARGUMENT_REQUIRED' '-TargetAccount is required' }
  $target = Resolve-TargetAccount $TargetAccount
  $receiptPath = if ([string]::IsNullOrWhiteSpace($RegistrationReceipt)) { $DefaultRegistrationReceiptPath } else { [IO.Path]::GetFullPath($RegistrationReceipt) }
  $receipt = Read-JsonFile $receiptPath
  if (-not $receipt) { Fail 'RECEIPT_MISSING' "$receiptPath does not exist" }
  $existing = Read-JsonFile $ProtectedConfigPath
  $bundle = Read-JsonFile $PendingEnrollmentPath
  if ($bundle) {
    Assert-PendingBundle $bundle -SkipKeyAccess
  } elseif ($existing) {
    Assert-ConfigShape $existing
    $bundle = BundleFromConfig $existing
    $bundle.ianaTimeZone = $receipt.workerReceipt.iana_time_zone
  } else {
    Fail 'ENROLLMENT_MISSING' "$PendingEnrollmentPath does not exist"
  }
  if ($bundle.windowsAccountSid -ne $target.sid -or $bundle.windowsAccount -ne $target.account) { Fail 'WRONG_WINDOWS_ACCOUNT' 'Pending identity was created for another Windows account' }
  Assert-RegistrationReceipt $receipt $bundle $base $HouseholdId

  if ($existing) {
    if ($existing.membership.pcId -ne $bundle.pcId) { Fail 'IDENTITY_MISMATCH' "This PC is already provisioned as $($existing.membership.pcId). Use -Action ResetIdentity -ConfirmPcId $($existing.membership.pcId)" }
    if ($existing.membership.householdId -ne $HouseholdId) { Fail 'HOUSEHOLD_MISMATCH' "This PC already belongs to $($existing.membership.householdId). Use -Action ResetIdentity -ConfirmPcId $($existing.membership.pcId)" }
    if (-not (ConfigMatchesRegistration $existing $bundle $receipt $base)) { Fail 'REGISTRATION_MISMATCH' "Existing protected configuration differs from the registration receipt. Use -Action ResetIdentity -ConfirmPcId $($existing.membership.pcId)" }
    Ensure-ServiceKeyBoundary $bundle
    $verification = Invoke-VerifyConfig
    Remove-Item -LiteralPath $PendingEnrollmentPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $AdminPublicJwkPath -Force -ErrorAction SilentlyContinue
    Write-Output ([ordered]@{ configPath = $ProtectedConfigPath; pcId = $bundle.pcId; verified = $verification.verified; noOp = $true } | ConvertTo-Json -Depth 6)
    return
  }

  $config = [ordered]@{
    schemaVersion   = 1
    baseUrl         = $base
    mutableStateDir = $bundle.mutableStateDir
    windowsAccount    = $bundle.windowsAccount
    windowsAccountSid = $bundle.windowsAccountSid
    membership        = [ordered]@{
      householdId     = $HouseholdId
      pcId            = $bundle.pcId
      membershipEpoch = [int]$receipt.workerReceipt.membership_epoch
      serviceEpoch    = [int]$receipt.workerReceipt.service_epoch
    }
    operational = [ordered]@{
      actorId   = $bundle.operational.actorId
      keyName   = $bundle.operational.keyName
      publicJwk = $bundle.operational.publicJwk
    }
    admin = [ordered]@{
      actorId           = $bundle.admin.actorId
      keyName           = $bundle.admin.keyName
      publicJwk         = $bundle.admin.publicJwk
      recoveryParentId  = $bundle.recoveryParentId
      recoveryPublicJwk = $bundle.admin.publicJwk
    }
  }
  if (-not (Test-Path -LiteralPath $bundle.mutableStateDir)) { New-Item -ItemType Directory -Path $bundle.mutableStateDir -Force | Out-Null }
  Ensure-ServiceKeyBoundary $bundle
  Install-ProtectedConfig $config $target.account -SkipKeyValidation
  $verification = Invoke-VerifyConfig
  Restart-PrivilegedBrokerIfInstalled
  Remove-Item -LiteralPath $PendingEnrollmentPath -Force
  Remove-Item -LiteralPath $AdminPublicJwkPath -Force -ErrorAction SilentlyContinue
  Write-Output ($verification | ConvertTo-Json -Depth 6)
}

function Invoke-Disable {
  Assert-Administrator
  Assert-AppStopped
  $config = Read-JsonFile $ProtectedConfigPath
  if (-not $config) { Fail 'CONFIG_MISSING' "$ProtectedConfigPath does not exist" }
  Assert-ConfigShape $config
  $config | Add-Member -NotePropertyName disabled -NotePropertyValue $true -Force
  Install-ProtectedConfig $config $config.windowsAccount -Replace -SkipKeyValidation
  Write-Output ([ordered]@{ configPath = $ProtectedConfigPath; disabled = $true } | ConvertTo-Json -Depth 4)
}

function Invoke-ResetIdentity {
  Assert-Administrator
  Assert-AppStopped
  $config = Read-JsonFile $ProtectedConfigPath
  $bundle = Read-JsonFile $PendingEnrollmentPath
  if ($config) {
    Assert-ConfigShape $config
    $identity = BundleFromConfig $config
  } elseif ($bundle) {
    Assert-PendingBundle $bundle
    $identity = $bundle
  } else {
    Fail 'CONFIG_MISSING' 'No protected or pending remote identity exists'
  }
  if ($ConfirmPcId -ne $identity.pcId) { Fail 'IDENTITY_MISMATCH' "Pass -ConfirmPcId $($identity.pcId) to remove this PC remote identity" }

  Remove-ProvisionedKeysAsSystem @($identity.operational.keyName, $identity.admin.keyName)
  Remove-Item -LiteralPath $ProtectedConfigPath -Force -ErrorAction SilentlyContinue
  foreach ($path in @($PendingEnrollmentPath, $AdminPublicJwkPath, $DefaultRegistrationReceiptPath, (Join-Path $MutableDir 'intent.json'), (Join-Path $MutableDir 'relaunch-fence.json'))) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
  Write-Output ([ordered]@{ removedPcId = $identity.pcId; localOnly = $true } | ConvertTo-Json -Depth 4)
}

switch ($Action) {
  'NewPcIdentity'      { Invoke-NewPcIdentity }
  'RegisterPc'         { Invoke-RegisterPc }
  'IssuePairing'       { Invoke-IssuePairing }
  'ImportRegistration' { Invoke-ImportRegistration }
  'VerifyConfig'       { Assert-Administrator; Invoke-VerifyConfig | ConvertTo-Json -Depth 6 }
  'Disable'            { Invoke-Disable }
  'ResetIdentity'      { Invoke-ResetIdentity }
}
