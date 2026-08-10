import { createHash, generateKeyPairSync } from 'node:crypto'
import { FlattenedSign, flattenedVerify } from 'jose'

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}
const canonicalJson = (value) => JSON.stringify(canonicalize(value))

export function createDeviceKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' })
}

export function contentDigest(body) {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
}

export async function createRequestProof({ privateKey, publicKey, method, url, body, actorId, membershipEpoch, serviceEpoch, nonce, idempotencyKey, nowSeconds, jti }) {
  const protectedHeader = { alg: 'ES256', jwk: publicKey.export({ format: 'jwk' }), typ: 'remote-approval+jws' }
  const payload = {
    actorId,
    contentDigest: contentDigest(body),
    htm: method.toUpperCase(),
    htu: new URL(url).toString(),
    iat: nowSeconds,
    idempotencyKey,
    jti,
    membershipEpoch,
    nonce,
    serviceEpoch,
  }
  return new FlattenedSign(Buffer.from(canonicalJson(payload)))
    .setProtectedHeader(protectedHeader)
    .sign(privateKey)
}

export async function verifyRequestProof({
  proof,
  registeredPublicKey,
  method,
  url,
  body,
  expectedActorId,
  expectedMembershipEpoch,
  expectedServiceEpoch,
  expectedNonce,
  nowSeconds,
  replayJtis,
  consumedNonces,
  idempotencyRecords,
}) {
  const { payload: verifiedPayload, protectedHeader: header } = await flattenedVerify(proof, registeredPublicKey, { algorithms: ['ES256'] })
  const payload = JSON.parse(Buffer.from(verifiedPayload))
  if (header.alg !== 'ES256' || header.typ !== 'remote-approval+jws') throw new Error('Unsupported proof header')
  const registeredJwk = registeredPublicKey.export({ format: 'jwk' })
  if (canonicalJson(header.jwk) !== canonicalJson(registeredJwk)) throw new Error('Unregistered device key')
  if (payload.htm !== method.toUpperCase() || payload.htu !== new URL(url).toString()) throw new Error('Request target mismatch')
  if (payload.contentDigest !== contentDigest(body)) throw new Error('Body digest mismatch')
  if (payload.actorId !== expectedActorId) throw new Error('Actor mismatch')
  if (payload.membershipEpoch !== expectedMembershipEpoch || payload.serviceEpoch !== expectedServiceEpoch) throw new Error('Stale epoch')
  if (payload.nonce !== expectedNonce) throw new Error('Nonce mismatch')
  if (!Number.isInteger(payload.iat) || Math.abs(nowSeconds - payload.iat) > 60) throw new Error('Proof time outside window')
  const jtiKey = `${payload.actorId}:${payload.membershipEpoch}:${payload.jti}`
  const nonceKey = `${payload.actorId}:${payload.membershipEpoch}:${payload.nonce}`
  if (replayJtis.has(jtiKey)) throw new Error('JTI replay detected')
  if (consumedNonces.has(nonceKey)) throw new Error('Nonce replay detected')
  const idempotencyKey = `${payload.actorId}:${payload.membershipEpoch}:${payload.idempotencyKey}`
  const operationDigest = `${payload.htm}:${payload.htu}:${payload.contentDigest}`
  const existing = idempotencyRecords.get(idempotencyKey)
  if (existing && existing.operationDigest !== operationDigest) throw new Error('Idempotency conflict')
  if (existing && existing.resultJson == null) throw new Error('Idempotency result pending')
  replayJtis.add(jtiKey)
  consumedNonces.add(nonceKey)
  return {
    payload,
    idempotency: existing ? 'retry' : 'new',
    cachedResult: existing ? existing.resultJson : undefined,
    idempotencyClaim: existing ? undefined : { key: idempotencyKey, operationDigest },
  }
}
