import { createHash } from 'node:crypto'
import { compactVerify, importJWK } from 'jose'

export async function verifySignedUpdate({ compactJws, trustedPublicJwk, apkBytes, installedVersionCode, installedSignerSha256 }) {
  if (!(apkBytes instanceof Uint8Array)) throw new Error('APK bytes required')
  const key = await importJWK(trustedPublicJwk, 'ES256')
  const { payload, protectedHeader } = await compactVerify(compactJws, key, {
    algorithms: ['ES256'],
    typ: 'playtime-pact-update+jws',
  })
  if (protectedHeader.alg !== 'ES256') throw new Error('Unsupported update signature')
  const manifest = JSON.parse(new TextDecoder().decode(payload))
  const required = ['versionCode', 'minimumVersionCode', 'url', 'sha256', 'size', 'releaseNotes', 'signerSha256']
  if (required.some((field) => manifest[field] === undefined)) throw new Error('Incomplete update manifest')
  if (!Number.isInteger(manifest.versionCode) || !Number.isInteger(manifest.minimumVersionCode)) throw new Error('Invalid version metadata')
  if (manifest.versionCode <= installedVersionCode || installedVersionCode < manifest.minimumVersionCode) throw new Error('Update version policy denied')
  if (manifest.size !== apkBytes.byteLength) throw new Error('APK size mismatch')
  const digest = createHash('sha256').update(apkBytes).digest('hex')
  if (digest !== manifest.sha256) throw new Error('APK digest mismatch')
  if (manifest.signerSha256 !== installedSignerSha256) throw new Error('APK signer lineage mismatch')
  const parsedUrl = new URL(manifest.url)
  if (parsedUrl.protocol !== 'https:') throw new Error('HTTPS update URL required')
  return Object.freeze({ ...manifest })
}
