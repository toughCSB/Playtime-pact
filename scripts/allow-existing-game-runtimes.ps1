#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$TargetUser,

  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$rulePrefix = 'Playtime Pact game runtime'
$trustedPublisherSubjects = @(
  'Azul Systems, Inc.',
  'Microsoft Corporation',
  'Mojang AB',
  'Oracle America, Inc.',
  'Eclipse Foundation, Inc.'
)
$target = Get-LocalUser -Name $TargetUser -ErrorAction Stop
$targetSid = $target.Sid.Value
$profileRoot = Join-Path $env:SystemDrive ("Users\{0}" -f $TargetUser)
$runtimeRoots = @(
  (Join-Path $profileRoot '.lunarclient\jre'),
  (Join-Path $profileRoot 'AppData\Roaming\.minecraft\runtime')
)

$runtimeFiles = @(
  foreach ($root in $runtimeRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Recurse -File |
        Where-Object { $_.Name -in @('java.exe', 'javaw.exe') }
    }
  }
) | Sort-Object FullName -Unique

if ($runtimeFiles.Count -eq 0) {
  throw "No Lunar or Minecraft Java runtime was found for '$TargetUser'."
}

function Get-RuntimeDecision {
  param(
    [Parameter(Mandatory = $true)]$Policy,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $result = Test-AppLockerPolicy -PolicyObject $Policy -Path $Path -User $targetSid
  return [string]$result.PolicyDecision
}

$effectivePolicy = Get-AppLockerPolicy -Effective
$blockedFiles = @(
  foreach ($file in $runtimeFiles) {
    $decision = Get-RuntimeDecision -Policy $effectivePolicy -Path $file.FullName
    if ($decision -notin @('Allowed', 'AllowedByDefault')) { $file }
  }
)

Write-Output ("Checked {0} Lunar/Minecraft runtime executables for {1}." -f $runtimeFiles.Count, $TargetUser)
foreach ($file in $runtimeFiles) {
  $decision = Get-RuntimeDecision -Policy $effectivePolicy -Path $file.FullName
  Write-Output ("{0}: {1}" -f $decision, $file.FullName)
}

if (-not $Apply) {
  if ($blockedFiles.Count -gt 0) {
    Write-Output ("{0} runtime executables need an allow rule. Re-run from elevated Windows PowerShell with -Apply." -f $blockedFiles.Count)
  }
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator elevation is required to merge AppLocker rules.'
}

if ($blockedFiles.Count -eq 0) {
  Write-Output 'All discovered game runtimes are already allowed. No policy change was required.'
  exit 0
}

$generatedPolicies = @()
foreach ($file in $blockedFiles) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $trustedPublisher = $signature.Status -eq 'Valid' -and @(
    $trustedPublisherSubjects | Where-Object { $signature.SignerCertificate.Subject -like "*$_*" }
  ).Count -gt 0
  $ruleType = if ($trustedPublisher) { 'Publisher' } else { 'Hash' }
  $fileInformation = Get-AppLockerFileInformation -Path $file.FullName
  $generatedPolicies += New-AppLockerPolicy `
    -FileInformation $fileInformation `
    -RuleType $ruleType `
    -User $targetSid `
    -RuleNamePrefix $rulePrefix `
    -Xml
}

$outputDocument = [xml]'<AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="NotConfigured" /></AppLockerPolicy>'
$outputCollection = $outputDocument.AppLockerPolicy.RuleCollection
$keys = @{}

foreach ($policyXml in $generatedPolicies) {
  $document = [xml]$policyXml
  foreach ($rule in $document.AppLockerPolicy.RuleCollection.ChildNodes) {
    if ($rule.LocalName -eq 'FilePublisherRule') {
      $condition = $rule.Conditions.FilePublisherCondition
      $range = $condition.BinaryVersionRange
      $majorVersion = ([version]$range.LowSection).Major
      $range.LowSection = ("{0}.0.0.0" -f $majorVersion)
      $range.HighSection = '*'
      $rule.SetAttribute('Name', ("{0}: {1} {2} v{3}+" -f $rulePrefix, $condition.ProductName, $condition.BinaryName, $majorVersion))
      $key = "publisher|$($condition.PublisherName)|$($condition.ProductName)|$($condition.BinaryName)|$majorVersion"
    } elseif ($rule.LocalName -eq 'FileHashRule') {
      $hash = $rule.Conditions.FileHashCondition.FileHash
      $rule.SetAttribute('Name', ("{0}: {1} exact hash" -f $rulePrefix, $hash.SourceFileName))
      $key = "hash|$($hash.Type)|$($hash.Data)|$($hash.SourceFileLength)"
    } else {
      continue
    }

    if ($keys.ContainsKey($key)) { continue }
    $keys[$key] = $true
    $rule.SetAttribute('Id', [guid]::NewGuid().ToString())
    $imported = $outputDocument.ImportNode($rule, $true)
    [void]$outputCollection.AppendChild($imported)
  }
}

$temporaryPolicy = Join-Path ([IO.Path]::GetTempPath()) ("playtime-pact-applocker-{0}.xml" -f [guid]::NewGuid())
try {
  $outputDocument.Save($temporaryPolicy)
  Set-AppLockerPolicy -XmlPolicy $temporaryPolicy -Merge
} finally {
  Remove-Item -LiteralPath $temporaryPolicy -Force -ErrorAction SilentlyContinue
}

$updatedPolicy = Get-AppLockerPolicy -Effective
$failed = @(
  foreach ($file in $runtimeFiles) {
    $decision = Get-RuntimeDecision -Policy $updatedPolicy -Path $file.FullName
    Write-Output ("After merge - {0}: {1}" -f $decision, $file.FullName)
    if ($decision -notin @('Allowed', 'AllowedByDefault')) { $file.FullName }
  }
)

if ($failed.Count -gt 0) {
  throw ("AppLocker still blocks game runtimes: {0}" -f ($failed -join ', '))
}

Write-Output 'Lunar/Minecraft runtime allow rules were merged without changing Store or MSI enforcement.'
