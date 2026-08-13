import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPLICATION_ID,
  CANONICAL_FIELDS,
  MAX_APK_BYTES,
  canonicalManifestBytes,
  hashFile,
  normalizeDigest,
  parseArguments,
  parseInteger,
  validateMetadata,
} from './sign-android-update.mjs'

const MANIFEST_FIELDS = new Set([...CANONICAL_FIELDS, 'signature'])

function required(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`MISSING_ARGUMENT: --${name}`)
  return value
}

function readManifest(path) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) throw new Error('INVALID_MANIFEST_SIZE')
  let manifest
  try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('MALFORMED_MANIFEST') }
  if (manifest === null || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('MALFORMED_MANIFEST')
  const fields = Object.keys(manifest)
  if (fields.length !== MANIFEST_FIELDS.size || fields.some((field) => !MANIFEST_FIELDS.has(field))) throw new Error('UNEXPECTED_MANIFEST_FIELDS')
  for (const field of MANIFEST_FIELDS) if (!Object.hasOwn(manifest, field)) throw new Error(`MISSING_MANIFEST_FIELD: ${field}`)
  for (const field of ['versionCode', 'minimumSupportedVersionCode', 'sizeBytes', 'issuedAtMillis', 'expiresAtMillis']) {
    if (!Number.isSafeInteger(manifest[field])) throw new Error(`INVALID_MANIFEST_FIELD: ${field}`)
  }
  for (const field of ['applicationId', 'versionName', 'apkSha256', 'apkUrl', 'releaseNotes', 'signerLineageSha256', 'signature']) {
    if (typeof manifest[field] !== 'string') throw new Error(`INVALID_MANIFEST_FIELD: ${field}`)
  }
  manifest.apkSha256 = normalizeDigest(manifest.apkSha256, 'apkSha256')
  manifest.signerLineageSha256 = normalizeDigest(manifest.signerLineageSha256, 'signerLineageSha256')
  return manifest
}

function readPublicKey(path) {
  const encoded = readFileSync(path, 'utf8').trim()
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('INVALID_PUBLIC_KEY: expected Base64 X.509')
  const der = Buffer.from(encoded, 'base64')
  if (!der.length || der.toString('base64') !== encoded) throw new Error('INVALID_PUBLIC_KEY: expected canonical Base64 X.509')
  let key
  try { key = createPublicKey({ key: der, type: 'spki', format: 'der' }) } catch { throw new Error('INVALID_PUBLIC_KEY: expected Base64 X.509') }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('INVALID_PUBLIC_KEY: P-256 required')
  return key
}

function decodeSignature(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_SIGNATURE_ENCODING')
  const decoded = Buffer.from(value, 'base64url')
  if (!decoded.length || decoded.toString('base64url') !== value) throw new Error('INVALID_SIGNATURE_ENCODING')
  return decoded
}

export async function verifyAndroidUpdate(options) {
  const nowMillis = options.nowMillis ?? Date.now()
  if (!Number.isSafeInteger(nowMillis) || nowMillis < 0) throw new Error('INVALID_NOW_MILLIS')
  const manifest = readManifest(options.manifestPath)
  validateMetadata(manifest, nowMillis)
  if (manifest.applicationId !== (options.applicationId ?? APPLICATION_ID)) throw new Error('APPLICATION_ID_MISMATCH')
  if (manifest.versionCode <= options.installedVersionCode) throw new Error('UPDATE_DOWNGRADE_OR_NOT_NEWER')
  const expectedLineage = normalizeDigest(options.signerLineageSha256, 'expected-signer-lineage-sha256')
  if (manifest.signerLineageSha256 !== expectedLineage) throw new Error('SIGNER_LINEAGE_MISMATCH')

  const publicKey = readPublicKey(options.publicKeyPath)
  const signature = decodeSignature(manifest.signature)
  if (!cryptoVerify('sha256', canonicalManifestBytes(manifest), publicKey, signature)) throw new Error('SIGNATURE_MISMATCH')

  const apkStat = statSync(options.apkPath)
  if (!apkStat.isFile() || apkStat.size <= 0 || apkStat.size > MAX_APK_BYTES || apkStat.size !== manifest.sizeBytes) throw new Error('APK_SIZE_MISMATCH')
  const actualDigest = await hashFile(options.apkPath)
  if (actualDigest !== manifest.apkSha256) throw new Error('APK_SHA256_MISMATCH')
  // Re-check size after hashing so an artifact replaced during verification cannot be reported as verified.
  if (statSync(options.apkPath).size !== manifest.sizeBytes) throw new Error('APK_CHANGED_DURING_VERIFICATION')

  return { ok: true, applicationId: manifest.applicationId, versionCode: manifest.versionCode, apkSha256: actualDigest }
}

function usage() {
  return 'Usage: npm run update:verify -- --manifest <manifest.json> --apk <path> --public-key <public-key.b64> --installed-version-code <n> --signer-lineage-sha256 <hex> [--now-millis <ms>]'
}

async function main(argv) {
  const args = parseArguments(argv)
  const allowed = new Set(['manifest', 'apk', 'public-key', 'installed-version-code', 'signer-lineage-sha256', 'now-millis'])
  for (const name of Object.keys(args)) if (!allowed.has(name)) throw new Error(`UNKNOWN_ARGUMENT: --${name}`)
  const result = await verifyAndroidUpdate({
    manifestPath: resolve(required(args, 'manifest')),
    apkPath: resolve(required(args, 'apk')),
    publicKeyPath: resolve(required(args, 'public-key')),
    installedVersionCode: parseInteger(required(args, 'installed-version-code'), 'installed-version-code'),
    signerLineageSha256: required(args, 'signer-lineage-sha256'),
    nowMillis: args['now-millis'] === undefined ? Date.now() : parseInteger(args['now-millis'], 'now-millis'),
  })
  console.log(`PASS Android update verified before upload/install: ${result.applicationId} versionCode=${result.versionCode} sha256=${result.apkSha256}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error.message}`)
    console.error(usage())
    process.exitCode = 1
  })
}
