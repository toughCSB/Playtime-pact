/**
 * Signed operator client for the permission-control endpoints.
 *
 * Proofs are ES256 flattened JWS bound to method, canonical URL and content digest,
 * exactly like every other authenticated route. The private key never leaves the
 * caller: either a local JWK (offline operator workstation) or an injected signer.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { FlattenedSign, importJWK } from 'jose'

export const PERMISSION_KEYS = Object.freeze(['create', 'respond_or_issue', 'consume'])

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })

export function parsePermissions(value) {
  if (value === 'all-false') return { create: false, respond_or_issue: false, consume: false }
  const entries = String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  const parsed = {}
  for (const entry of entries) {
    const [key, raw] = entry.split('=')
    if (!PERMISSION_KEYS.includes(key)) throw fail('BAD_PERMISSIONS', `unknown permission "${key}"`)
    if (raw !== 'true' && raw !== 'false') throw fail('BAD_PERMISSIONS', `permission "${key}" must be true or false`)
    if (key in parsed) throw fail('BAD_PERMISSIONS', `permission "${key}" was specified twice`)
    parsed[key] = raw === 'true'
  }
  if (Object.keys(parsed).length !== PERMISSION_KEYS.length) throw fail('BAD_PERMISSIONS', `all of ${PERMISSION_KEYS.join(', ')} must be specified`)
  return { create: parsed.create, respond_or_issue: parsed.respond_or_issue, consume: parsed.consume }
}

const contentDigest = (body) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
const b64url = (value) => Buffer.from(value).toString('base64url')

/** Loads a local private JWK signer. Used only on the offline operator workstation. */
export async function localJwkSigner({ actorId, privateJwkPath }) {
  let jwk
  try { jwk = JSON.parse(readFileSync(privateJwkPath, 'utf8')) } catch (error) { throw fail('BAD_SIGNING_KEY', `${privateJwkPath} is not valid JSON: ${error.message}`) }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw fail('BAD_SIGNING_KEY', `${privateJwkPath} must be a private P-256 EC JWK`)
  return { actorId, privateKey: await importJWK(jwk, 'ES256'), publicJwk: { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } }
}

async function signedProof({ signer, method, url, body, now }) {
  const claims = {
    actorId: signer.actorId,
    htm: method,
    htu: url,
    contentDigest: contentDigest(body),
    iat: Math.floor(now() / 1000),
    idempotencyKey: randomUUID(),
    jti: randomUUID(),
    nonce: randomUUID(),
  }
  if (signer.sign) return signer.sign({ claims, publicJwk: signer.publicJwk })
  const token = await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: signer.publicJwk })
    .sign(signer.privateKey)
  return `Bearer ${JSON.stringify(token)}`
}

async function call({ baseUrl, method, path, query = {}, body, signer, fetchImpl = fetch, now = () => Date.now() }) {
  const url = new URL(path, `${String(baseUrl).replace(/\/$/, '')}/`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  const payload = method === 'GET' ? '' : JSON.stringify(body)
  const proof = await signedProof({ signer, method, url: url.toString(), body: payload, now })
  const response = await fetchImpl(url.toString(), {
    method,
    headers: { authorization: proof, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : payload,
  })
  const result = await response.json()
  if (!response.ok) throw fail(result?.error === 'CONTROL_CAS_CONFLICT' ? 'CONTROL_CAS_CONFLICT' : 'CONTROLS_REJECTED', `${method} ${path} failed with ${response.status} ${result?.error ?? ''}`.trim())
  return result
}

const tuple = (row, prefix) => ({
  create: row[`${prefix}_create`] === 1,
  respond_or_issue: row[`${prefix}_respond_or_issue`] === 1,
  consume: row[`${prefix}_consume`] === 1,
  controlVersion: row[`${prefix}_version`],
  serviceEpoch: row[`${prefix}_service_epoch`],
})

export async function getControls({ baseUrl, householdId, signer, fetchImpl, now }) {
  if (!householdId) throw fail('BAD_ARGUMENT', '--household-id is required')
  const row = await call({ baseUrl, method: 'GET', path: '/v1/controls', query: { householdId }, signer, fetchImpl, now })
  return { householdId: row.household_id, environment: tuple(row, 'environment'), household: tuple(row, 'household') }
}

export async function setControls({ baseUrl, scope, householdId, permissions, expectedVersion, signer, fetchImpl, now }) {
  if (scope !== 'environment' && scope !== 'household') throw fail('BAD_ARGUMENT', '--scope must be environment or household')
  if (scope === 'household' && !householdId) throw fail('BAD_ARGUMENT', '--household-id is required for household scope')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail('BAD_ARGUMENT', '--expected-version must be a positive integer')
  const body = scope === 'environment' ? { permissions, expectedVersion } : { householdId, permissions, expectedVersion }
  const row = await call({ baseUrl, method: 'PUT', path: `/v1/${scope}/controls`, body, signer, fetchImpl, now })
  return {
    scope,
    householdId: scope === 'household' ? householdId : undefined,
    create: row.create_permission === 1,
    respond_or_issue: row.respond_or_issue_permission === 1,
    consume: row.consume_permission === 1,
    controlVersion: row.control_version,
    serviceEpoch: row.service_epoch,
  }
}
