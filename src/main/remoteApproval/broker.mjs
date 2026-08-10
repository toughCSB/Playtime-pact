const OPERATION_CAPABILITY = Object.freeze({
  'create-request': 'operational', 'consume-grant': 'operational', 'read-status': 'operational',
  'pair-parent': 'membership', 'revoke-parent': 'membership', 'reset-household': 'membership', 'delete-household': 'membership',
  'append-debit': 'accounting', 'read-high-water': 'accounting',
})
const PRINCIPAL_CAPABILITY = Object.freeze({
  'electron-operational': 'operational', 'local-admin-broker': 'membership', 'protected-accounting-broker': 'accounting',
})
const principalBrand = new WeakSet()

export const CAPABILITIES = OPERATION_CAPABILITY

export function assertCngSigningAdapter(adapter) {
  if (!adapter || typeof adapter.sign !== 'function' || typeof adapter.verify !== 'function') throw new Error('CNG signing adapter must provide sign and verify')
  if (adapter.nonExportable !== true || typeof adapter.keyId !== 'string' || adapter.keyId.length === 0) throw new Error('CNG signer must assert non-exportable key identity')
  if ('privateKey' in adapter || typeof adapter.exportPrivateKey === 'function') throw new Error('CNG signing adapter must not expose private keys')
  return adapter
}
export function createWindowsCngChildAdapter({ execute, keyId }) {
  if (typeof execute !== 'function' || typeof keyId !== 'string' || keyId.length === 0) throw new Error('Windows CNG child adapter requires executor and key identity')
  const adapter = {
    nonExportable: true,
    keyId,
    async sign(payload) { return execute({ operation: 'sign', keyId, payload: Buffer.from(payload).toString('base64') }) },
    async verify(payload, signature) { return execute({ operation: 'verify', keyId, payload: Buffer.from(payload).toString('base64'), signature }) },
  }
  return assertCngSigningAdapter(Object.freeze(adapter))
}

function assertIpcEvidence(evidence, { audience, operation, payloadDigest, now, maxAgeMs }) {
  if (!evidence || typeof evidence !== 'object' || evidence.audience !== audience || evidence.operation !== operation || evidence.payloadDigest !== payloadDigest
    || typeof evidence.nonce !== 'string' || evidence.nonce.length < 16 || !Number.isFinite(evidence.issuedAt)
    || evidence.issuedAt > now || now - evidence.issuedAt > maxAgeMs) throw new Error('OS-authenticated IPC evidence invalid')
}

export async function authenticateBrokerPrincipal({ credentialId, operation, payloadDigest, ipcEvidence }, credentialRegistry, { audience, now = Date.now(), maxAgeMs = 30_000 } = {}) {
  if (!credentialRegistry || typeof credentialRegistry.verify !== 'function' || typeof audience !== 'string' || !Object.hasOwn(OPERATION_CAPABILITY, operation)) throw new Error('Trusted credential registry, IPC audience, and operation required')
  assertIpcEvidence(ipcEvidence, { audience, operation, payloadDigest, now, maxAgeMs })
  const kind = await credentialRegistry.verify({ credentialId, audience, operation, payloadDigest, nonce: ipcEvidence.nonce, issuedAt: ipcEvidence.issuedAt, proof: ipcEvidence.proof })
  if (!Object.hasOwn(PRINCIPAL_CAPABILITY, kind)) throw new Error('Unknown broker credential')
  const principal = Object.freeze({ credentialId, kind, capability: PRINCIPAL_CAPABILITY[kind], audience, operation, payloadDigest, nonce: ipcEvidence.nonce })
  principalBrand.add(principal)
  return principal
}

export async function authorizeBrokerCall({ authenticatedPrincipal, operation, payloadDigest, adminSessionProof, integrityEvidence, replayStore }) {
  if (!principalBrand.has(authenticatedPrincipal) || authenticatedPrincipal.payloadDigest !== payloadDigest || authenticatedPrincipal.operation !== operation) throw new Error('Unauthenticated principal')
  if (!replayStore || typeof replayStore.consume !== 'function' || !(await replayStore.consume({ audience: authenticatedPrincipal.audience, operation, payloadDigest, nonce: authenticatedPrincipal.nonce }))) throw new Error('IPC nonce replayed or unavailable')
  if (!integrityEvidence || typeof integrityEvidence.verify !== 'function' || !(await integrityEvidence.verify())) throw new Error('Broker integrity unavailable')
  const requiredCapability = OPERATION_CAPABILITY[operation]
  if (!requiredCapability || authenticatedPrincipal.capability !== requiredCapability) throw new Error('Capability denied')
  if (requiredCapability === 'membership' && (authenticatedPrincipal.kind !== 'local-admin-broker' || !adminSessionProof || typeof adminSessionProof.verify !== 'function' || !(await adminSessionProof.verify({ audience: authenticatedPrincipal.audience, operation, payloadDigest, nonce: authenticatedPrincipal.nonce })))) throw new Error('Admin broker session required')
  if (requiredCapability === 'accounting' && authenticatedPrincipal.kind !== 'protected-accounting-broker') throw new Error('Accounting broker required')
  return true
}

export class PrivilegedBroker {
  constructor({ credentialRegistry, integrityEvidence, cngSigningAdapter, audience, replayStore, clock = () => Date.now(), maxIpcAgeMs = 30_000 }) {
    if (!credentialRegistry || !integrityEvidence || !replayStore || typeof replayStore.consume !== 'function' || typeof audience !== 'string' || !Number.isFinite(maxIpcAgeMs) || maxIpcAgeMs <= 0) throw new Error('Broker dependencies required')
    this.credentialRegistry = credentialRegistry
    this.integrityEvidence = integrityEvidence
    this.cngSigningAdapter = assertCngSigningAdapter(cngSigningAdapter)
    this.audience = audience
    this.replayStore = replayStore
    this.clock = clock
    this.maxIpcAgeMs = maxIpcAgeMs
  }

  authenticate(caller) { return authenticateBrokerPrincipal(caller, this.credentialRegistry, { audience: this.audience, now: this.clock(), maxAgeMs: this.maxIpcAgeMs }) }
  async authorize(principal, operation, payloadDigest, adminSessionProof) {
    await authorizeBrokerCall({ authenticatedPrincipal: principal, operation, payloadDigest, adminSessionProof, integrityEvidence: this.integrityEvidence, replayStore: this.replayStore })
    return Object.freeze({ operation, principal })
  }
}
