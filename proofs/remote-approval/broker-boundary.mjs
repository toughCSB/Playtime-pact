import { createHmac, timingSafeEqual } from 'node:crypto'

const OPERATION_CAPABILITY = Object.freeze({
  'create-request': 'operational',
  'consume-grant': 'operational',
  'read-status': 'operational',
  'pair-parent': 'membership',
  'revoke-parent': 'membership',
  'reset-household': 'membership',
  'delete-household': 'membership',
  'append-debit': 'accounting',
  'read-high-water': 'accounting',
})

const PRINCIPAL_CAPABILITY = Object.freeze({
  'electron-operational': 'operational',
  'local-admin-broker': 'membership',
  'protected-accounting-broker': 'accounting',
})

export const CAPABILITIES = Object.freeze({ ...OPERATION_CAPABILITY })

export function authenticateBrokerPrincipal({ credentialId, signatureVerified }, trustedCredentials) {
  if (!signatureVerified) throw new Error('Unsigned caller')
  const kind = trustedCredentials?.get(credentialId)
  if (!kind || !Object.hasOwn(PRINCIPAL_CAPABILITY, kind)) throw new Error('Unknown broker credential')
  return Object.freeze({ credentialId, kind, capability: PRINCIPAL_CAPABILITY[kind] })
}

export function authorizeBrokerCall({ authenticatedPrincipal, operation, adminSession, integrityHealthy }) {
  if (!integrityHealthy) throw new Error('Broker integrity unavailable')
  if (!Object.isFrozen(authenticatedPrincipal)) throw new Error('Unauthenticated principal')
  const requiredCapability = OPERATION_CAPABILITY[operation]
  if (!requiredCapability || authenticatedPrincipal.capability !== requiredCapability) throw new Error('Capability denied')
  if (requiredCapability === 'accounting' && authenticatedPrincipal.kind !== 'protected-accounting-broker') throw new Error('Accounting broker required')
  if (requiredCapability === 'membership' && (!adminSession?.authenticated || authenticatedPrincipal.kind !== 'local-admin-broker')) throw new Error('Admin broker session required')
  return true
}

export class ProtectedAccountingJournal {
  constructor(secret, protectedHighWater, entries = []) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error('Protected secret required')
    if (!protectedHighWater || !Number.isInteger(protectedHighWater.sequence) || protectedHighWater.sequence < 0) throw new Error('Protected high-water required')
    if (!Number.isInteger(protectedHighWater.allowanceVersion) || protectedHighWater.allowanceVersion < 0) throw new Error('Protected allowance high-water required')
    if ((protectedHighWater.sequence === 0) !== (protectedHighWater.mac === null)) throw new Error('Protected high-water shape invalid')
    this.secret = secret
    this.protectedHighWater = protectedHighWater
    this.entries = entries.map((entry) => ({ ...entry }))
    if (!this.verify()) throw new Error('Protected journal mismatch')
  }

  append({ sequence, allowanceVersion, debitSeconds, requestId }) {
    if (!this.verify()) throw new Error('Protected journal mismatch')
    const prior = this.entries.at(-1)
    if (sequence !== (prior?.sequence ?? 0) + 1) throw new Error('Non-monotonic sequence')
    if (!Number.isInteger(allowanceVersion) || allowanceVersion <= 0 || allowanceVersion < (prior?.allowanceVersion ?? 0)) throw new Error('Allowance rollback')
    if (!Number.isInteger(debitSeconds) || debitSeconds <= 0) throw new Error('Invalid debit')
    const payload = { sequence, allowanceVersion, debitSeconds, requestId, priorMac: prior?.mac ?? null }
    const mac = this.#mac(payload)
    const entry = { ...payload, mac }
    this.entries.push(entry)
    this.protectedHighWater.sequence = entry.sequence
    this.protectedHighWater.allowanceVersion = entry.allowanceVersion
    this.protectedHighWater.mac = entry.mac
    return entry
  }

  verify() {
    let priorMac = null
    let priorVersion = 0
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]
      if (entry.sequence !== index + 1 || entry.priorMac !== priorMac || entry.allowanceVersion < priorVersion) return false
      const expected = Buffer.from(this.#mac({ sequence: entry.sequence, allowanceVersion: entry.allowanceVersion, debitSeconds: entry.debitSeconds, requestId: entry.requestId, priorMac: entry.priorMac }), 'hex')
      const actual = Buffer.from(entry.mac, 'hex')
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
      priorMac = entry.mac
      priorVersion = entry.allowanceVersion
    }
    return this.protectedHighWater.sequence === this.entries.length
      && this.protectedHighWater.allowanceVersion === priorVersion
      && this.protectedHighWater.mac === priorMac
  }

  #mac(value) {
    return createHmac('sha256', this.secret).update(JSON.stringify(value)).digest('hex')
  }
}

export class LocalPreauthorization {
  constructor({ contextId, gameId, processEpochFloor, expiresAt }) {
    this.contextId = contextId
    this.gameId = gameId
    this.processEpochFloor = processEpochFloor
    this.expiresAt = expiresAt
    this.claimed = false
  }

  claim({ contextId, gameId, processEpoch, now }) {
    if (this.claimed) throw new Error('Preauthorization already claimed')
    if (now >= this.expiresAt) throw new Error('Preauthorization expired')
    if (contextId !== this.contextId || gameId !== this.gameId || processEpoch <= this.processEpochFloor) throw new Error('Process claim mismatch')
    this.claimed = true
    return { gameId, processEpoch }
  }
}
