import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto'
import { closeSync, createReadStream, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APPLICATION_ID = 'com.playtimepact.parent'
export const MAX_APK_BYTES = 200 * 1024 * 1024
export const CANONICAL_FIELDS = Object.freeze([
  'applicationId',
  'versionCode',
  'minimumSupportedVersionCode',
  'versionName',
  'apkSha256',
  'sizeBytes',
  'apkUrl',
  'releaseNotes',
  'signerLineageSha256',
  'issuedAtMillis',
  'expiresAtMillis',
])
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export function canonicalManifestBytes(manifest) {
  return Buffer.from(CANONICAL_FIELDS.map((field) => String(manifest[field])).join('\n'), 'utf8')
}

export function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--') || token === '--') throw new Error(`UNKNOWN_ARGUMENT: ${token}`)
    const name = token.slice(2)
    if (name in result) throw new Error(`DUPLICATE_ARGUMENT: --${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE: --${name}`)
    result[name] = value
    index += 1
  }
  return result
}

function required(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`MISSING_ARGUMENT: --${name}`)
  return value
}

export function parseInteger(value, name, { minimum = 0, allowNegativeOne = false } = {}) {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`INVALID_INTEGER: ${name}`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || (allowNegativeOne ? number < -1 : number < minimum)) throw new Error(`INVALID_INTEGER: ${name}`)
  return number
}

export function normalizeDigest(value, name) {
  const normalized = String(value).toLowerCase()
  if (!DIGEST_PATTERN.test(normalized)) throw new Error(`INVALID_SHA256: ${name}`)
  return normalized
}

export function validateHttpsUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('INVALID_APK_URL: HTTPS URL required') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('INVALID_APK_URL: HTTPS URL without credentials or fragment required')
  }
  return value
}

export function validateMetadata(manifest, nowMillis, { requireCurrentlyValid = true } = {}) {
  if (manifest.applicationId !== APPLICATION_ID) throw new Error('APPLICATION_ID_MISMATCH')
  if (!Number.isSafeInteger(manifest.versionCode) || manifest.versionCode <= 0) throw new Error('INVALID_VERSION_CODE')
  if (!Number.isSafeInteger(manifest.minimumSupportedVersionCode) || manifest.minimumSupportedVersionCode < 0 || manifest.minimumSupportedVersionCode > manifest.versionCode) throw new Error('INVALID_VERSION_FLOOR')
  if (typeof manifest.versionName !== 'string' || !manifest.versionName.trim() || /[\r\n]/.test(manifest.versionName)) throw new Error('INVALID_VERSION_NAME')
  normalizeDigest(manifest.apkSha256, 'apkSha256')
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 || manifest.sizeBytes > MAX_APK_BYTES) throw new Error('INVALID_APK_SIZE')
  validateHttpsUrl(manifest.apkUrl)
  if (typeof manifest.releaseNotes !== 'string' || manifest.releaseNotes.length > 16_384) throw new Error('INVALID_RELEASE_NOTES')
  normalizeDigest(manifest.signerLineageSha256, 'signerLineageSha256')
  if (!Number.isSafeInteger(manifest.issuedAtMillis) || manifest.issuedAtMillis < 0 || !Number.isSafeInteger(manifest.expiresAtMillis) || manifest.expiresAtMillis <= manifest.issuedAtMillis) throw new Error('INVALID_VALIDITY_INTERVAL')
  if (requireCurrentlyValid && manifest.issuedAtMillis > nowMillis) throw new Error('UPDATE_NOT_YET_VALID')
  if (requireCurrentlyValid && manifest.expiresAtMillis <= nowMillis) throw new Error('UPDATE_EXPIRED')
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function readP256PrivateKey(path) {
  let key
  try { key = createPrivateKey(readFileSync(path)) } catch { throw new Error('INVALID_SIGNING_KEY: expected an unencrypted P-256 private key') }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('INVALID_SIGNING_KEY: P-256 required')
  return key
}

function removeIfPresent(path) {
  try { unlinkSync(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function atomicWrite(path, contents, mode) {
  const target = resolve(path)
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, contents)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    removeIfPresent(temporary)
  }
}

export async function signAndroidUpdate(options) {
  const apkPath = resolve(options.apkPath)
  const outputPath = resolve(options.outputPath)
  const publicKeyOutputPath = resolve(options.publicKeyOutputPath)
  const signingKeyPath = resolve(options.signingKeyPath)
  if (new Set([apkPath, outputPath, publicKeyOutputPath, signingKeyPath]).size !== 4) throw new Error('OUTPUT_PATH_COLLISION')

  // A failed or interrupted repeat must not leave an older manifest looking like this run succeeded.
  removeIfPresent(outputPath)
  removeIfPresent(publicKeyOutputPath)

  const apkStat = statSync(apkPath)
  if (!apkStat.isFile() || apkStat.size <= 0 || apkStat.size > MAX_APK_BYTES) throw new Error('INVALID_APK_SIZE')
  const nowMillis = options.nowMillis ?? Date.now()
  const manifest = {
    applicationId: APPLICATION_ID,
    versionCode: options.versionCode,
    minimumSupportedVersionCode: options.minimumSupportedVersionCode,
    versionName: options.versionName,
    apkSha256: await hashFile(apkPath),
    sizeBytes: apkStat.size,
    apkUrl: options.apkUrl,
    releaseNotes: options.releaseNotes,
    signerLineageSha256: normalizeDigest(options.signerLineageSha256, 'signerLineageSha256'),
    issuedAtMillis: options.issuedAtMillis,
    expiresAtMillis: options.expiresAtMillis,
  }
  validateMetadata(manifest, nowMillis)
  const privateKey = readP256PrivateKey(signingKeyPath)
  const publicKey = createPublicKey(privateKey)
  const signature = cryptoSign('sha256', canonicalManifestBytes(manifest), { key: privateKey, dsaEncoding: 'der' }).toString('base64url')
  const signedManifest = { ...manifest, signature }
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  // Publish the manifest last: interruption may leave a harmless public key, never a manifest without its key.
  atomicWrite(publicKeyOutputPath, `${publicKeyBase64}\n`, 0o644)
  atomicWrite(outputPath, `${JSON.stringify(signedManifest, null, 2)}\n`, 0o644)
  return { manifest: signedManifest, publicKeyBase64, outputPath, publicKeyOutputPath }
}

function usage() {
  return `Usage: npm run update:sign -- --apk <path> --apk-url <https-url> --version-code <n> --minimum-supported-version-code <n> --version-name <name> --signer-lineage-sha256 <hex> --issued-at-millis <ms> --expires-at-millis <ms> --output <manifest.json> --public-key-output <public-key.b64> [--release-notes <text> | --release-notes-file <path>]\n\nPLAYTIME_PACT_UPDATE_SIGNING_KEY must name an external unencrypted P-256 private-key file.`
}

async function main(argv) {
  const args = parseArguments(argv)
  const allowed = new Set(['apk', 'apk-url', 'version-code', 'minimum-supported-version-code', 'version-name', 'signer-lineage-sha256', 'issued-at-millis', 'expires-at-millis', 'output', 'public-key-output', 'release-notes', 'release-notes-file'])
  for (const name of Object.keys(args)) if (!allowed.has(name)) throw new Error(`UNKNOWN_ARGUMENT: --${name}`)
  if (args['release-notes'] !== undefined && args['release-notes-file'] !== undefined) throw new Error('CONFLICTING_ARGUMENTS: release notes')
  const signingKeyPath = process.env.PLAYTIME_PACT_UPDATE_SIGNING_KEY
  if (!signingKeyPath) throw new Error('MISSING_SIGNING_KEY: set PLAYTIME_PACT_UPDATE_SIGNING_KEY to an external key path')
  const releaseNotes = args['release-notes-file'] === undefined ? (args['release-notes'] ?? '') : readFileSync(required(args, 'release-notes-file'), 'utf8')
  const result = await signAndroidUpdate({
    apkPath: required(args, 'apk'), apkUrl: required(args, 'apk-url'),
    versionCode: parseInteger(required(args, 'version-code'), 'version-code', { minimum: 1 }),
    minimumSupportedVersionCode: parseInteger(required(args, 'minimum-supported-version-code'), 'minimum-supported-version-code'),
    versionName: required(args, 'version-name'), signerLineageSha256: required(args, 'signer-lineage-sha256'),
    issuedAtMillis: parseInteger(required(args, 'issued-at-millis'), 'issued-at-millis'),
    expiresAtMillis: parseInteger(required(args, 'expires-at-millis'), 'expires-at-millis'),
    outputPath: required(args, 'output'), publicKeyOutputPath: required(args, 'public-key-output'),
    releaseNotes, signingKeyPath,
  })
  console.log(`PASS signed Android update manifest: ${result.outputPath}`)
  console.log(`PASS Base64 X.509 public key: ${result.publicKeyOutputPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL ${error.message}`)
    console.error(usage())
    process.exitCode = 1
  })
}
