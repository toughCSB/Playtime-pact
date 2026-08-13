<#
.SYNOPSIS
  Offline setup/operator authority client for Playtime Pact remote approval.

.DESCRIPTION
  Opens non-exportable P-256 keys from the current user's Microsoft Software KSP
  and signs the Worker's flattened ES256 proof envelope in place. Private key
  material is never exported or written by this script.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('SetupHousehold','GetControls','SetControls')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [string]$HouseholdId,

  # SetupHousehold
  [string]$InitialParentId,
  [string]$InitialParentJwk,
  [string]$SetupKeyName,
  [string]$SetupActorId = 'global',

  # GetControls / SetControls
  [string]$OperatorActorId,
  [string]$OperatorKeyName,
  [ValidateSet('environment','household')]
  [string]$Scope,
  [switch]$Create,
  [switch]$RespondOrIssue,
  [switch]$Consume,
  [int]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Code, [string]$Message) { throw "$Code`: $Message" }

function Assert-Identifier([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9._:-]{1,128}$') {
    Fail 'BAD_IDENTIFIER' "$Name must contain 1-128 letters, digits, dot, underscore, colon or hyphen characters"
  }
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Assert-HttpsEndpoint([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Fail 'ARGUMENT_REQUIRED' '-BaseUrl is required' }
  try { $uri = [Uri]$Value } catch { Fail 'BAD_ENDPOINT' "$Value is not an absolute URL" }
  if (-not $uri.IsAbsoluteUri) { Fail 'BAD_ENDPOINT' "$Value is not an absolute URL" }
  $localHttp = $uri.Scheme -eq 'http' -and ($uri.Host -eq 'localhost' -or $uri.Host -eq '127.0.0.1')
  if ($uri.Scheme -ne 'https' -and -not $localHttp) { Fail 'INSECURE_ENDPOINT' "$Value must use HTTPS" }
  if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or ($uri.AbsolutePath -ne '/')) {
    Fail 'BAD_ENDPOINT' '-BaseUrl must be an origin without credentials, path, query or fragment'
  }
  return $uri
}

function Open-SigningKey([string]$KeyName) {
  if ([string]::IsNullOrWhiteSpace($KeyName)) { Fail 'KEY_NAME_REQUIRED' 'A CNG key name is required' }
  if (-not [System.Security.Cryptography.CngKey]::Exists($KeyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider)) {
    Fail 'KEY_MISSING' "$KeyName does not exist for the current Windows account"
  }
  $key = [System.Security.Cryptography.CngKey]::Open(
    $KeyName,
    [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,
    [System.Security.Cryptography.CngKeyOpenOptions]::None)
  if ($key.Provider.Provider -ne 'Microsoft Software Key Storage Provider' -or $key.AlgorithmGroup.AlgorithmGroup -ne 'ECDsa' -or $key.KeySize -ne 256) {
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
    $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Body))
    return "sha-256=:$([Convert]::ToBase64String($hash)):"
  } finally { $sha.Dispose() }
}

function New-SignedProof {
  param(
    [System.Security.Cryptography.CngKey]$Key,
    [System.Collections.IDictionary]$PublicJwk,
    [string]$ActorId,
    [string]$Method,
    [string]$CanonicalUrl,
    [string]$Body,
    [string]$IdempotencyKey
  )
  $header = [ordered]@{ alg = 'ES256'; typ = 'remote-approval+jws'; jwk = $PublicJwk }
  $claims = [ordered]@{
    actorId        = $ActorId
    contentDigest  = Get-ContentDigest $Body
    htm            = $Method
    htu            = $CanonicalUrl
    iat            = [long][Math]::Floor(([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() / 1000)
    idempotencyKey = $IdempotencyKey
    jti            = [Guid]::NewGuid().ToString()
    nonce          = [Guid]::NewGuid().ToString()
  }
  $protectedSegment = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($header | ConvertTo-Json -Compress -Depth 6)))
  $payloadSegment = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($claims | ConvertTo-Json -Compress -Depth 6)))
  $signingInput = [Text.Encoding]::ASCII.GetBytes("$protectedSegment.$payloadSegment")
  $signer = [System.Security.Cryptography.ECDsaCng]::new($Key)
  try {
    # Windows PowerShell 5.1 exposes the two-argument overload and ECDsaCng returns
    # the IEEE-P1363 r||s form required by JOSE.
    $signature = $signer.SignData($signingInput, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  } finally { $signer.Dispose() }
  if ($signature.Length -ne 64) { Fail 'SIGNATURE_FORMAT_INVALID' 'CNG did not return a 64-byte ES256 signature' }
  $token = [ordered]@{
    protected = $protectedSegment
    payload   = $payloadSegment
    signature = ConvertTo-Base64Url $signature
  }
  return "Bearer $($token | ConvertTo-Json -Compress -Depth 4)"
}

function Invoke-SignedRequest {
  param(
    [string]$KeyName,
    [string]$ActorId,
    [string]$Method,
    [string]$Path,
    [hashtable]$Query = @{},
    $Body = $null,
    [string]$IdempotencyKey = ([Guid]::NewGuid().ToString())
  )
  Assert-Identifier 'ActorId' $ActorId
  if ([string]::IsNullOrWhiteSpace($IdempotencyKey)) { Fail 'ARGUMENT_REQUIRED' 'An idempotency key is required' }
  $base = Assert-HttpsEndpoint $BaseUrl
  $builder = [UriBuilder]::new($base)
  $builder.Path = $Path
  if ($Query.Count -gt 0) {
    $pairs = foreach ($name in ($Query.Keys | Sort-Object)) {
      "$([Uri]::EscapeDataString([string]$name))=$([Uri]::EscapeDataString([string]$Query[$name]))"
    }
    $builder.Query = ($pairs -join '&')
  }
  $canonicalUrl = $builder.Uri.AbsoluteUri
  $payload = if ($Method -eq 'GET') { '' } else { $Body | ConvertTo-Json -Compress -Depth 8 }
  $key = Open-SigningKey $KeyName
  try {
    $publicJwk = Get-PublicJwk $key
    $proof = New-SignedProof -Key $key -PublicJwk $publicJwk -ActorId $ActorId -Method $Method -CanonicalUrl $canonicalUrl -Body $payload -IdempotencyKey $IdempotencyKey
  } finally { $key.Dispose() }
  $headers = @{ authorization = $proof; 'content-type' = 'application/json' }
  try {
    if ($Method -eq 'GET') {
      return Invoke-RestMethod -Method GET -Uri $canonicalUrl -Headers $headers -MaximumRedirection 0
    }
    return Invoke-RestMethod -Method $Method -Uri $canonicalUrl -Headers $headers -Body $payload -MaximumRedirection 0
  } catch {
    Fail 'REQUEST_FAILED' "$Method $Path failed: $($_.Exception.Message)"
  }
}

function Read-PublicJwkFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail 'JWK_MISSING' "$Path does not exist" }
  $jwk = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  foreach ($member in @('d','p','q','dp','dq','qi','k')) {
    if ($jwk.PSObject.Properties.Name -contains $member) { Fail 'PRIVATE_KEY_REJECTED' "$Path contains private key member $member" }
  }
  if ($jwk.kty -ne 'EC' -or $jwk.crv -ne 'P-256' -or -not ($jwk.x -match '^[A-Za-z0-9_-]{43}$') -or -not ($jwk.y -match '^[A-Za-z0-9_-]{43}$')) {
    Fail 'BAD_PUBLIC_JWK' "$Path must be a public P-256 EC JWK"
  }
  [ordered]@{ crv = 'P-256'; kty = 'EC'; x = $jwk.x; y = $jwk.y }
}

switch ($Action) {
  'SetupHousehold' {
    Assert-Identifier 'HouseholdId' $HouseholdId
    Assert-Identifier 'InitialParentId' $InitialParentId
    if ([string]::IsNullOrWhiteSpace($SetupKeyName)) { Fail 'ARGUMENT_REQUIRED' '-SetupKeyName is required' }
    Assert-Identifier 'SetupActorId' $SetupActorId
    $adminJwk = Read-PublicJwkFile $InitialParentJwk
    $body = [ordered]@{
      householdId     = $HouseholdId
      initialParentId = $InitialParentId
      publicJwk       = ($adminJwk | ConvertTo-Json -Compress -Depth 4)
      permissions     = [ordered]@{ create = $false; respond_or_issue = $false; consume = $false }
    }
    $operationKey = "setup-household:$HouseholdId`:$InitialParentId"
    $result = Invoke-SignedRequest -KeyName $SetupKeyName -ActorId $SetupActorId -Method 'POST' -Path '/v1/households/setup' -Body $body -IdempotencyKey $operationKey
    $result | ConvertTo-Json -Depth 8
  }
  'GetControls' {
    Assert-Identifier 'HouseholdId' $HouseholdId
    Assert-Identifier 'OperatorActorId' $OperatorActorId
    if ([string]::IsNullOrWhiteSpace($OperatorKeyName)) { Fail 'ARGUMENT_REQUIRED' '-OperatorKeyName is required' }
    $result = Invoke-SignedRequest -KeyName $OperatorKeyName -ActorId $OperatorActorId -Method 'GET' -Path '/v1/controls' -Query @{ householdId = $HouseholdId }
    $result | ConvertTo-Json -Depth 8
  }
  'SetControls' {
    Assert-Identifier 'OperatorActorId' $OperatorActorId
    if ([string]::IsNullOrWhiteSpace($OperatorKeyName)) { Fail 'ARGUMENT_REQUIRED' '-OperatorKeyName is required' }
    if ([string]::IsNullOrWhiteSpace($Scope)) { Fail 'ARGUMENT_REQUIRED' '-Scope is required' }
    if ($ExpectedVersion -lt 1) { Fail 'ARGUMENT_REQUIRED' '-ExpectedVersion must be a positive integer' }
    $permissions = [ordered]@{ create = [bool]$Create; respond_or_issue = [bool]$RespondOrIssue; consume = [bool]$Consume }
    if ($Scope -eq 'environment') {
      $body = [ordered]@{ permissions = $permissions; expectedVersion = $ExpectedVersion }
      $path = '/v1/environment/controls'
    } else {
      Assert-Identifier 'HouseholdId' $HouseholdId
      $body = [ordered]@{ householdId = $HouseholdId; permissions = $permissions; expectedVersion = $ExpectedVersion }
      $path = '/v1/household/controls'
    }
    $result = Invoke-SignedRequest -KeyName $OperatorKeyName -ActorId $OperatorActorId -Method 'PUT' -Path $path -Body $body
    $result | ConvertTo-Json -Depth 8
  }
}
