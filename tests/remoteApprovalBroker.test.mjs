import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PrivilegedBroker, authenticateBrokerPrincipal, authorizeBrokerCall, createWindowsCngChildAdapter } from '../src/main/remoteApproval/broker.mjs'
import { ProtectedAccountingJournal } from '../src/main/remoteApproval/accountingJournal.mjs'
import { MemoryPreauthorization, RemoteStartCoordinator } from '../src/main/remoteApproval/preauthorization.mjs'

const signer = {
  nonExportable: true, keyId: 'windows-cng-test-key',
  sign(payload) { return createHmac('sha256', 'test-only-key').update(payload).digest('hex') },
  verify(payload, signature) { return this.sign(payload) === signature },
}
const water = () => ({ sequence: 0, allowanceVersion: 0, signature: null })

function adapters() {
  let committed = { entries: [], highWater: water() }
  let prepared = null
  let anchor = water()
  let failNextCommit = false
  return {
    persistence: {
      async recover() { return structuredClone({ committed, prepared }) },
      async prepare(snapshot) { if (prepared) throw new Error('Outstanding prepare owned by recovery'); prepared = { id: `prepare-${snapshot.highWater.sequence}`, snapshot: structuredClone(snapshot) }; return { id: prepared.id } },
      async commit(id) { if (failNextCommit) { failNextCommit = false; throw new Error('injected commit failure') } if (!prepared || prepared.id !== id) throw new Error('bad prepare'); committed = prepared.snapshot; prepared = null },
      async abort(id) { if (prepared?.id === id) prepared = null },
    },
    highWaterAnchor: {
      async read() { return structuredClone(anchor) },
      async compareAndSwap(expected, next) {
        if (JSON.stringify(expected) !== JSON.stringify(anchor)) return false
        anchor = structuredClone(next); return true
      },
    },
    signer,
    state: {
      failNextCommit() { failNextCommit = true },
      tamperCommitted(mutator) { mutator(committed) },
      setAnchor(next) { anchor = next },
      get committed() { return committed },
    },
  }
}

function ipc(operation = 'create-request', payloadDigest = 'digest', nonce = 'a-unique-nonce-123') {
  return { audience: 'guardian.broker', operation, payloadDigest, nonce, issuedAt: 1_000, proof: 'os-authenticated' }
}

describe('privileged broker IPC and CNG boundary', () => {
  it('requires fresh OS-authenticated audience-bound payload and nonce evidence', async () => {
    const registry = { async verify(request) { return request.proof === 'os-authenticated' && request.audience === 'guardian.broker' && request.operation === 'create-request' && request.payloadDigest === 'digest' ? 'electron-operational' : null } }
    const used = new Set()
    const replayStore = { async consume(binding) { const key = JSON.stringify(binding); if (used.has(key)) return false; used.add(key); return true } }
    const broker = new PrivilegedBroker({ credentialRegistry: registry, integrityEvidence: { async verify() { return true } }, cngSigningAdapter: signer, audience: 'guardian.broker', replayStore, clock: () => 2_000 })
    const principal = await broker.authenticate({ credentialId: 'renderer', operation: 'create-request', payloadDigest: 'digest', ipcEvidence: ipc() })
    await expect(broker.authorize(principal, 'create-request', 'digest')).resolves.toMatchObject({ operation: 'create-request' })
    await expect(broker.authorize(principal, 'create-request', 'digest')).rejects.toThrow('replayed')
    await expect(broker.authorize(principal, 'read-status', 'digest')).rejects.toThrow('Unauthenticated')
    await expect(broker.authenticate({ credentialId: 'renderer', operation: 'create-request', payloadDigest: 'other', ipcEvidence: ipc() })).rejects.toThrow('IPC evidence')
    await expect(authenticateBrokerPrincipal({ credentialId: 'renderer', operation: 'create-request', payloadDigest: 'digest', ipcEvidence: { ...ipc(), issuedAt: 0 } }, registry, { audience: 'guardian.broker', now: 100_000, maxAgeMs: 30_000 })).rejects.toThrow('IPC evidence')
    expect(() => new PrivilegedBroker({ credentialRegistry: registry, integrityEvidence: {}, cngSigningAdapter: { ...signer, nonExportable: false }, audience: 'guardian.broker', replayStore })).toThrow('non-exportable')
    const childCalls = []
    const child = createWindowsCngChildAdapter({ keyId: 'Windows-Machine-Key', execute: async (request) => { childCalls.push(request); return request.operation === 'verify' } })
    await child.sign(new Uint8Array([1]))
    expect(await child.verify(new Uint8Array([1]), 'signature')).toBe(true)
    expect(childCalls).toEqual([
      { operation: 'sign', keyId: 'Windows-Machine-Key', payload: 'AQ==' },
      { operation: 'verify', keyId: 'Windows-Machine-Key', payload: 'AQ==', signature: 'signature' },
    ])
  })

  it('requires verified admin proof for every membership/reset/delete operation', async () => {
    const registry = { async verify() { return 'local-admin-broker' } }
    const integrityEvidence = { async verify() { return true } }
    const adminSessionProof = { async verify(binding) { return binding.audience === 'guardian.broker' && binding.payloadDigest === 'digest' } }
    const replayStore = { async consume() { return true } }
    for (const operation of ['pair-parent', 'revoke-parent', 'reset-household', 'delete-household']) {
      const principal = await authenticateBrokerPrincipal({ credentialId: 'admin', operation, payloadDigest: 'digest', ipcEvidence: ipc(operation, 'digest', `a-unique-nonce-${operation}`) }, registry, { audience: 'guardian.broker', now: 2_000 })
      await expect(authorizeBrokerCall({ authenticatedPrincipal: principal, operation, payloadDigest: 'digest', adminSessionProof, integrityEvidence, replayStore })).resolves.toBe(true)
    }
    const principal = await authenticateBrokerPrincipal({ credentialId: 'admin', operation: 'delete-household', payloadDigest: 'digest', ipcEvidence: ipc('delete-household', 'digest', 'another-unique-nonce') }, registry, { audience: 'guardian.broker', now: 2_000 })
    await expect(authorizeBrokerCall({ authenticatedPrincipal: principal, operation: 'delete-household', payloadDigest: 'digest', integrityEvidence, replayStore })).rejects.toThrow('Admin broker session')
  })
})

describe('protected accounting journal', () => {
  it('serializes appends and makes duplicate request ids idempotent but conflicts fail', async () => {
    const journal = await ProtectedAccountingJournal.open(adapters())
    const input = { allowanceVersion: 1, domain: 'remote:h:p:roblox', debitSeconds: 60, requestId: 'r1' }
    const [first, duplicate] = await Promise.all([journal.append(input), journal.append(input)])
    expect(first).toEqual(duplicate)
    expect(journal.snapshot().entries).toHaveLength(1)
    await expect(journal.append({ ...input, debitSeconds: 61 })).rejects.toThrow('conflict')
    await journal.append({ ...input, allowanceVersion: 2, requestId: 'r2' })
    await expect(journal.append({ ...input, allowanceVersion: 1, debitSeconds: 1, requestId: 'r3' })).rejects.toThrow('rollback')
  })

  it('recovers a durable prepare after anchor CAS/commit failure and rejects tamper and truncation', async () => {
    const faulted = adapters()
    faulted.state.failNextCommit()
    const journal = await ProtectedAccountingJournal.open(faulted)
    await expect(journal.append({ allowanceVersion: 1, domain: 'd', debitSeconds: 1, requestId: 'r' })).rejects.toThrow('commit failure')
    await expect(journal.append({ allowanceVersion: 2, domain: 'd', debitSeconds: 1, requestId: 'second' })).rejects.toThrow('poisoned')
    expect((await ProtectedAccountingJournal.open(faulted)).snapshot().entries).toHaveLength(1)
    const normal = adapters()
    const durable = await ProtectedAccountingJournal.open(normal)
    await durable.append({ allowanceVersion: 1, domain: 'd', debitSeconds: 1, requestId: 'r' })
    normal.state.tamperCommitted((snapshot) => { snapshot.entries[0].debitSeconds = 2 })
    await expect(ProtectedAccountingJournal.open(normal)).rejects.toThrow('signature')
    normal.state.tamperCommitted((snapshot) => { snapshot.entries = [] })
    await expect(ProtectedAccountingJournal.open(normal)).rejects.toThrow(/truncated|high-water/)
  })
})

describe('memory-only observed-launch authorization', () => {
  it('uses random one-use tokens, exact expiry eviction, and a bounded memory cap', () => {
    const grants = new MemoryPreauthorization({ maxActive: 1 })
    const one = grants.issue({ contextId: 'c', householdId: 'h', requestId: 'r', pcId: 'p', gameId: 'roblox', allowanceVersion: 1, expiresAt: 10, now: 1 })
    expect(one.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(() => grants.issue({ contextId: 'x', householdId: 'h', requestId: 'x', pcId: 'p', gameId: 'roblox', allowanceVersion: 1, expiresAt: 10, now: 1 })).toThrow('capacity')
    expect(grants.get(one.token, 10)).toBeUndefined()
    const two = grants.issue({ contextId: 'c', householdId: 'h', requestId: 'r', pcId: 'p', gameId: 'roblox', allowanceVersion: 1, expiresAt: 20, now: 10 })
    expect(() => grants.consume({ token: two.token, contextId: 'c', gameId: 'roblox', processId: 4, processStartedAt: 2, now: 20 })).toThrow('unavailable')
  })

  it('only claims an observed user process after final policy, serializes detector races, and never rebinds after exit', async () => {
    const grants = new MemoryPreauthorization()
    const issued = grants.issue({ contextId: 'c', householdId: 'h', requestId: 'r', pcId: 'p', gameId: 'roblox', allowanceVersion: 1, expiresAt: 100, now: 0 })
    let policyChecks = 0
    const coordinator = new RemoteStartCoordinator({ preauthorizations: grants, finalPolicy: async () => { policyChecks += 1; return true } })
    const [a, b] = await Promise.all([
      coordinator.observedUserLaunch({ token: issued.token, contextId: 'c', gameId: 'roblox', processId: 1, processStartedAt: 10, now: 1 }),
      coordinator.observedUserLaunch({ token: issued.token, contextId: 'c', gameId: 'roblox', processId: 2, processStartedAt: 11, now: 1 }),
    ])
    expect([a.status, b.status]).toContain('running')
    expect(policyChecks).toBe(1)
    await coordinator.processExited({ contextId: 'c', processId: 1, processStartedAt: 10 })
    expect((await coordinator.observedUserLaunch({ token: issued.token, contextId: 'c', gameId: 'roblox', processId: 3, processStartedAt: 12, now: 2 })).status).toBe('ignored')
  })

  it('denies policy changes and leaves consume failures terminal without reconciliation promotion', async () => {
    const grants = new MemoryPreauthorization()
    const token = grants.issue({ contextId: 'd', householdId: 'h', requestId: 'r', pcId: 'p', gameId: 'roblox', allowanceVersion: 1, expiresAt: 100, now: 0 }).token
    const denied = new RemoteStartCoordinator({ preauthorizations: grants, finalPolicy: async () => false })
    expect((await denied.observedUserLaunch({ token, contextId: 'd', gameId: 'roblox', processId: 1, processStartedAt: 1, now: 1 })).status).toBe('denied')
    const broken = new RemoteStartCoordinator({ preauthorizations: { consume() { throw new Error('claim lost') } }, finalPolicy: async () => true, reconcile: async () => ({ processId: 2, processStartedAt: 2 }) })
    expect((await broken.observedUserLaunch({ token: 'missing', contextId: 'e', gameId: 'roblox', processId: 2, processStartedAt: 2, now: 1 })).status).toBe('failed')
    expect((await broken.reconcileIndeterminate('e')).status).toBe('failed')
  })
})
