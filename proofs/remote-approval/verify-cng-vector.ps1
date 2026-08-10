$ErrorActionPreference = 'Stop'

function Decode-Base64Url([string]$Value) {
  $normalized = $Value.Replace('-', '+').Replace('_', '/')
  while (($normalized.Length % 4) -ne 0) { $normalized += '=' }
  return [Convert]::FromBase64String($normalized)
}

$protected = 'eyJhbGciOiJFUzI1NiIsImp3ayI6eyJrdHkiOiJFQyIsIngiOiJSRDV5MFd5RmNSQzB5NlVwdVZqUDVCaHBhSmV5ZE9XRmFXS09qOGdSR1dNIiwieSI6IklpTXk3U3hqTmJzdllfYWdtX0x3ZW9falRlZHVjR0ZwUzVTV3Z4T2pkNEEiLCJjcnYiOiJQLTI1NiJ9LCJ0eXAiOiJyZW1vdGUtYXBwcm92YWwrandzIn0'
$payload = 'eyJhY3RvcklkIjoicGFyZW50LXZlY3RvciIsImNvbnRlbnREaWdlc3QiOiJzaGEtMjU2PTp5Z28zdGFuSFZ5TE84MUdST1ZNcEhHQ05XT3dKK3puQjZLaVJnUVNDbVl3PToiLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9hcHByb3ZhbC5leGFtcGxlL3YxL3JlcXVlc3RzL3IxL3Jlc3BvbmQiLCJpYXQiOjQwMDAsImlkZW1wb3RlbmN5S2V5IjoiaWRlbXBvdGVuY3ktdmVjdG9yLTAwMDEiLCJqdGkiOiJqdGktdmVjdG9yLTAwMDEiLCJtZW1iZXJzaGlwRXBvY2giOjMsIm5vbmNlIjoibm9uY2UtdmVjdG9yLTAwMDEiLCJzZXJ2aWNlRXBvY2giOjh9'
$signature = Decode-Base64Url 'oMW_tE4_aBvjKzbMjnx68FrJpm1Y4l3gvJtjV81YTrJwUF3DcC4jQVtpP1lzLpApEeAWRc6KRBukgGftspxNNA'
$data = [Text.Encoding]::ASCII.GetBytes("$protected.$payload")
$format = [System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation

$parameters = [System.Security.Cryptography.ECParameters]::new()
$parameters.Curve = [System.Security.Cryptography.ECCurve]::CreateFromFriendlyName('nistP256')
$point = [System.Security.Cryptography.ECPoint]::new()
$point.X = Decode-Base64Url 'RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM'
$point.Y = Decode-Base64Url 'IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A'
$parameters.Q = $point

$vectorVerifier = [System.Security.Cryptography.ECDsaCng]::new()
$vectorVerifier.ImportParameters($parameters)
if (-not $vectorVerifier.VerifyData($data, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, $format)) {
  throw 'CNG rejected the Node ES256 golden vector.'
}

$cngSigner = [System.Security.Cryptography.ECDsaCng]::new(256)
$cngSignature = $cngSigner.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, $format)
if (-not $cngSigner.VerifyData($data, $cngSignature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, $format)) {
  throw 'CNG failed to verify its own ES256 signature.'
}

[pscustomobject]@{
  schemaVersion = 1
  provider = $cngSigner.Key.Algorithm
  vectorVerified = $true
  cngSignVerify = $true
  signatureBytes = $cngSignature.Length
} | ConvertTo-Json
