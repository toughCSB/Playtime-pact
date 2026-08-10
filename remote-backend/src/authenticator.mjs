import { flattenedVerify, importJWK } from 'jose'

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const stable = (value) => JSON.stringify(canonical(value))
const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
const contentDigest = async (body) => `sha-256=:${b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))))}:`
const bad = (message) => Object.assign(new Error(message), { code: 'AUTH_REQUIRED' })

/**
 * Verifies a flattened ES256 proof against the public key currently registered in D1.
 * Setup is exceptional: it is authenticated by the separately provisioned public
 * setup-authority record, never by a request-body key.
 */
export function createAuthenticator(db, { now = () => Date.now(), setupAuthorityId = 'global', minimumParentClientVersion = 1 } = {}) {
  if (!db?.prepare) throw new TypeError('A D1 database is required')
  if (!Number.isSafeInteger(minimumParentClientVersion) || minimumParentClientVersion <= 0) throw new TypeError('minimumParentClientVersion must be a positive safe integer')
  const row = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results?.[0]
  return {
    async verify({ request, method, canonicalUrl, body, proof }) {
      if (!proof?.startsWith('Bearer ')) throw bad('Missing proof')
      const token = JSON.parse(proof.slice(7))
      if (!token?.protected || !token?.payload || !token?.signature) throw bad('Malformed flattened proof')
      const untrusted = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))
      const path = new URL(canonicalUrl).pathname
      const setup = path === '/v1/households/setup'
      const operator = path === '/v1/environment/controls' || path === '/v1/household/controls' || path === '/v1/controls'
      let keyRecord
      let principalKind
      if (setup) {
        keyRecord = await row(`SELECT id,public_jwk FROM setup_authorities WHERE id=? AND status='active'`, setupAuthorityId)
        principalKind = 'setup-authority'
      } else if (operator) {
        keyRecord = await row(`SELECT id,public_jwk,'operator' AS principal_kind,NULL AS membership_epoch,NULL AS household_id FROM operator_authorities WHERE id=? AND status='active'`, untrusted.actorId)
        principalKind = 'operator'
      } else {
        keyRecord = await row(`SELECT p.id,p.public_jwk,'parent' AS principal_kind,p.membership_epoch,p.household_id FROM parent_devices p WHERE p.id=? AND p.status='active' AND NOT EXISTS(SELECT 1 FROM delete_tombstones t WHERE t.household_id=p.household_id AND t.expires_at_ms>?) UNION ALL SELECT p.id,p.public_key AS public_jwk,'pc' AS principal_kind,NULL AS membership_epoch,p.household_id FROM pcs p WHERE p.id=? AND p.status='active' AND NOT EXISTS(SELECT 1 FROM delete_tombstones t WHERE t.household_id=p.household_id AND t.expires_at_ms>?) LIMIT 1`, untrusted.actorId,now(),untrusted.actorId,now())
        principalKind = keyRecord?.principal_kind
      }
      if (!keyRecord && path === '/v1/delete/reconcile') {
        keyRecord = await row(`SELECT actor_id AS id,public_jwk,'parent' AS principal_kind,membership_epoch,household_id FROM deletion_receipts WHERE actor_id=? AND operation_key=? AND expires_at_ms>?`, untrusted.actorId, untrusted.idempotencyKey, now())
        principalKind = keyRecord?.principal_kind
      }
      if (!keyRecord) throw bad('Unknown or revoked signing device')
      let registered
      try { registered = JSON.parse(keyRecord.public_jwk) } catch { throw bad('Invalid registered public key') }
      const { payload, protectedHeader } = await flattenedVerify(token, await importJWK(registered, 'ES256'), { algorithms: ['ES256'] })
      if (protectedHeader.alg !== 'ES256' || protectedHeader.typ !== 'remote-approval+jws' || stable(protectedHeader.jwk) !== stable(registered)) throw bad('Unsupported or unpinned proof key')
      const claims = JSON.parse(new TextDecoder().decode(payload))
      if (!claims.actorId || claims.actorId !== keyRecord.id || claims.htm !== method || claims.htu !== canonicalUrl || claims.contentDigest !== await contentDigest(body)) throw bad('Proof binding mismatch')
      if (!claims.jti || !claims.nonce || !claims.idempotencyKey || !Number.isInteger(claims.iat) || Math.abs(Math.floor(now() / 1000) - claims.iat) > 60) throw bad('Invalid proof claims')
      if (principalKind === 'parent' && (!Number.isSafeInteger(claims.clientVersionCode) || claims.clientVersionCode < minimumParentClientVersion)) throw bad('Unsupported parent client version')
      if (!setup && !operator) {
        const replay = await row(`SELECT operation_digest FROM idempotency_records WHERE actor_id=? AND idempotency_key=? ORDER BY expires_at_ms DESC LIMIT 1`, claims.actorId, claims.idempotencyKey)
        const operationDigest = `${method}:${canonicalUrl}:${body}`
        if (replay && replay.operation_digest !== operationDigest) throw bad('Idempotency digest mismatch')
        if (!replay) {
          const epochs = await row(`SELECT h.membership_epoch,h.service_epoch,e.service_epoch AS global_epoch FROM households h JOIN environments e ON e.id='global' WHERE h.id=? AND h.deleted_at_ms IS NULL`, keyRecord.household_id)
          const current = epochs && claims.membershipEpoch === epochs.membership_epoch && claims.serviceEpoch === epochs.global_epoch && (keyRecord.membership_epoch === null || keyRecord.membership_epoch === epochs.membership_epoch)
          if (!current) {
            const path = new URL(canonicalUrl).pathname
            const resetReconcile = path === '/v1/reset/reconcile'
            const deleteReconcile = path === '/v1/delete/reconcile'
            const committed = principalKind === 'parent' && (
              resetReconcile && await row(`SELECT c.operation_key FROM reset_commits c JOIN households h ON h.id=c.household_id JOIN environments e ON e.id='global' JOIN parent_devices p ON p.id=c.parent_id AND p.household_id=h.id WHERE c.household_id=? AND c.parent_id=? AND c.operation_key=? AND h.deleted_at_ms IS NULL AND h.membership_epoch=? AND e.service_epoch=? AND p.status='active' AND p.membership_epoch=h.membership_epoch`,keyRecord.household_id,claims.actorId,claims.idempotencyKey,claims.membershipEpoch+1,claims.serviceEpoch)
              || deleteReconcile && await row(`SELECT household_id FROM deletion_receipts WHERE household_id=? AND actor_id=? AND operation_key=? AND membership_epoch=? AND service_epoch=? AND expires_at_ms>?`,keyRecord.household_id,claims.actorId,claims.idempotencyKey,claims.membershipEpoch,claims.serviceEpoch,now())
            )
            if (!committed) throw bad('Stale proof epoch')
          }
        }
      }
      return { actorId: claims.actorId, principalKind, householdId: keyRecord.household_id, membershipEpoch: claims.membershipEpoch, serviceEpoch: claims.serviceEpoch, clientVersionCode:claims.clientVersionCode, jti: claims.jti, nonce: claims.nonce, idempotencyKey: claims.idempotencyKey }
    },
  }
}
export { contentDigest }
