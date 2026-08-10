import { describe, expect, it } from 'vitest'
import { createPublicKey, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { assertHeadroom, modelAbuseCeiling, modelD1Usage } from '../proofs/remote-approval/cost-model.mjs'
import { createDeviceKeyPair, createRequestProof, verifyRequestProof } from '../proofs/remote-approval/auth-vector.mjs'
import { authenticateBrokerPrincipal, authorizeBrokerCall, CAPABILITIES, LocalPreauthorization, ProtectedAccountingJournal } from '../proofs/remote-approval/broker-boundary.mjs'
import { RemoteApprovalModel, RemoteStartCoordinatorModel } from '../proofs/remote-approval/state-race-model.mjs'
import { CompactSign, importJWK } from 'jose'
import { verifySignedUpdate } from '../proofs/remote-approval/update-manifest.mjs'

const requestInput = { id: 'r1', householdId: 'h1', pcId: 'pc1', gameId: 'roblox', allowanceVersion: 7, createdAt: 1_000_000 }
const enabledModel = () => {
  const model = new RemoteApprovalModel()
  model.enableRemoteEnvironment()
  model.setHouseholdRemote('h1', true)
  return model
}

describe('remote approval Stage 0 proofs', () => {
  it('retains at least 5x D1 headroom at modeled 5x use and stays below limits at the rate-limited abuse ceiling', () => {
    expect(assertHeadroom(modelD1Usage(undefined, 5)).minimumHeadroomFactor).toBeGreaterThan(5)
    expect(assertHeadroom(modelAbuseCeiling()).minimumHeadroomFactor).toBeGreaterThan(1)
  })

  it('defaults environment and unknown households to LOCAL_ONLY', () => {
    const model = new RemoteApprovalModel()
    expect(() => model.createRequest(requestInput)).toThrow('LOCAL_ONLY')
    model.enableRemoteEnvironment()
    expect(() => model.createRequest(requestInput)).toThrow('LOCAL_ONLY')
    model.setHouseholdRemote('h1', true)
    expect(model.createRequest(requestInput).status).toBe('pending')
  })

  it('binds ES256 proofs to the registered device, request, independent replay keys and content-bound idempotency', async () => {
    const { privateKey, publicKey } = createDeviceKeyPair()
    const input = {
      privateKey,
      publicKey,
      method: 'POST',
      url: 'https://approval.example/v1/requests/r1/respond',
      body: '{"decision":"approve","minutes":20}',
      actorId: 'parent-1',
      membershipEpoch: 3,
      serviceEpoch: 8,
      nonce: 'server-nonce-1',
      idempotencyKey: 'idem-1',
      nowSeconds: 4_000,
      jti: 'proof-1',
    }
    const stores = { replayJtis: new Set(), consumedNonces: new Set(), idempotencyRecords: new Map() }
    const verifyInput = {
      method: input.method,
      url: input.url,
      body: input.body,
      expectedActorId: input.actorId,
      expectedMembershipEpoch: 3,
      expectedServiceEpoch: 8,
      nowSeconds: 4_001,
      registeredPublicKey: publicKey,
      ...stores,
    }
    const proof = await createRequestProof(input)
    const first = await verifyRequestProof({ proof, expectedNonce: input.nonce, ...verifyInput })
    expect(first).toMatchObject({ payload: { actorId: 'parent-1' }, idempotency: 'new' })
    expect(first.idempotencyClaim).toBeTruthy()
    stores.idempotencyRecords.set(first.idempotencyClaim.key, {
      operationDigest: first.idempotencyClaim.operationDigest,
      resultJson: '{"status":"approved","winner":"parent-1"}',
    })
    await expect(verifyRequestProof({ proof, expectedNonce: input.nonce, ...verifyInput })).rejects.toThrow('JTI replay detected')

    const retryInput = { ...input, nonce: 'server-nonce-2', jti: 'proof-2' }
    await expect(verifyRequestProof({ proof: await createRequestProof(retryInput), expectedNonce: retryInput.nonce, ...verifyInput }))
      .resolves.toMatchObject({ idempotency: 'retry', cachedResult: '{"status":"approved","winner":"parent-1"}' })

    const conflictInput = { ...input, body: '{"decision":"approve","minutes":30}', nonce: 'server-nonce-3', jti: 'proof-3' }
    await expect(verifyRequestProof({
      ...verifyInput,
      proof: await createRequestProof(conflictInput),
      body: conflictInput.body,
      expectedNonce: conflictInput.nonce,
    })).rejects.toThrow('Idempotency conflict')

    const attacker = createDeviceKeyPair()
    await expect(verifyRequestProof({
      proof: await createRequestProof({ ...input, privateKey: attacker.privateKey, publicKey: attacker.publicKey, nonce: 'server-nonce-4', jti: 'proof-4' }),
      expectedNonce: 'server-nonce-4',
      ...verifyInput,
    })).rejects.toThrow()
  })

  it('verifies the pinned ES256 cross-platform golden vector', async () => {
    const vector = JSON.parse(readFileSync(new URL('../proofs/remote-approval/auth-golden-vector.json', import.meta.url), 'utf8'))
    expect(vector.library).toEqual({ name: 'jose', version: '6.2.8' })
    await expect(verifyRequestProof({
      proof: vector.proof,
      registeredPublicKey: createPublicKey({ key: vector.publicJwk, format: 'jwk' }),
      method: vector.request.method,
      url: vector.request.url,
      body: vector.request.body,
      expectedActorId: vector.request.actorId,
      expectedMembershipEpoch: vector.request.membershipEpoch,
      expectedServiceEpoch: vector.request.serviceEpoch,
      expectedNonce: vector.request.nonce,
      nowSeconds: vector.request.nowSeconds,
      replayJtis: new Set(),
      consumedNonces: new Set(),
      idempotencyRecords: new Map(),
    })).resolves.toMatchObject({ idempotency: 'new' })
  })

  it('expires requests exactly at 300000ms, keeps rejection personal, picks one approval winner and consumes once', () => {
    const model = enabledModel()
    model.createRequest(requestInput)
    expect(model.respond({ requestId: 'r1', parentId: 'p1', decision: 'reject', now: 1_299_999 }).won).toBe(false)
    const winner = model.respond({ requestId: 'r1', parentId: 'p2', decision: 'approve', minutes: 20, now: 1_299_999 })
    expect(winner.won).toBe(true)
    expect(model.respond({ requestId: 'r1', parentId: 'p3', decision: 'approve', minutes: 30, now: 1_299_999 }).won).toBe(false)
    const consumeInput = { requestId: 'r1', pcId: 'pc1', gameId: 'roblox', allowanceVersion: 7, processEpoch: 11, processIdentity: 'pid:4102:start:abc', now: 1_599_998 }
    expect(model.consume(consumeInput).state).toBe('consumed')
    expect(() => model.consume(consumeInput)).toThrow('already consumed')

    const expired = enabledModel()
    expired.createRequest({ ...requestInput, id: 'r2' })
    expect(() => expired.respond({ requestId: 'r2', parentId: 'p1', decision: 'approve', minutes: 20, now: 1_300_000 })).toThrow('Request expired')
  })

  it('rejects request-id reuse with different immutable bindings', () => {
    const model = enabledModel()
    model.createRequest(requestInput)
    expect(() => model.createRequest({ ...requestInput, gameId: 'minecraft' })).toThrow('Request idempotency conflict')
  })

  it('invalidates stale epochs and rejects mismatched grant bindings', () => {
    const model = enabledModel()
    model.createRequest(requestInput)
    model.respond({ requestId: 'r1', parentId: 'p1', decision: 'approve', minutes: 20, now: 1_000_001 })
    const consumeInput = { requestId: 'r1', pcId: 'pc1', gameId: 'roblox', allowanceVersion: 7, processEpoch: 11, processIdentity: 'pid:4102:start:abc', now: 1_000_002 }
    expect(() => model.consume({ ...consumeInput, pcId: 'pc2' })).toThrow('binding mismatch')
    model.enterLocalOnly()
    expect(() => model.consume(consumeInput)).toThrow('LOCAL_ONLY')
    expect(() => model.createRequest({ ...requestInput, id: 'r2' })).toThrow('LOCAL_ONLY')
    model.enableRemoteEnvironment()
    expect(() => model.consume(consumeInput)).toThrow('Stale grant epoch')
  })

  it('keeps personal rejection immutable, validates before mutation, and preserves approved terminal state', () => {
    const model = enabledModel()
    model.createRequest(requestInput)
    expect(() => model.respond({ requestId: 'r1', parentId: 'p1', decision: 'approve', minutes: 0, now: 1_000_001 })).toThrow('Invalid minutes')
    expect(model.requests.get('r1').responses.size).toBe(0)
    model.respond({ requestId: 'r1', parentId: 'p1', decision: 'reject', now: 1_000_002 })
    expect(() => model.respond({ requestId: 'r1', parentId: 'p1', decision: 'approve', minutes: 20, now: 1_000_003 })).toThrow('Personal response conflict')
    model.respond({ requestId: 'r1', parentId: 'p2', decision: 'approve', minutes: 20, now: 1_000_004 })
    expect(model.respond({ requestId: 'r1', parentId: 'p3', decision: 'approve', minutes: 30, now: 1_400_000 }).request.status).toBe('approved')
  })

  it('invalidates grants on household disable and revoked-parent membership epoch changes', () => {
    const household = enabledModel()
    household.createRequest(requestInput)
    household.respond({ requestId: 'r1', parentId: 'p1', decision: 'approve', minutes: 20, now: 1_000_001 })
    household.setHouseholdRemote('h1', false)
    expect(() => household.consume({ requestId: 'r1', pcId: 'pc1', gameId: 'roblox', allowanceVersion: 7, processEpoch: 11, processIdentity: 'pid:1', now: 1_000_002 })).toThrow('LOCAL_ONLY')
    household.setHouseholdRemote('h1', true)
    expect(() => household.consume({ requestId: 'r1', pcId: 'pc1', gameId: 'roblox', allowanceVersion: 7, processEpoch: 11, processIdentity: 'pid:1', now: 1_000_002 })).toThrow('Stale grant epoch')

    const revoked = enabledModel()
    revoked.createRequest(requestInput)
    revoked.revokeParent('p1')
    expect(() => revoked.respond({ requestId: 'r1', parentId: 'p1', decision: 'approve', minutes: 20, now: 1_000_002 })).toThrow()
  })

  it('serializes asynchronous local and remote consume/start outcomes by exact process identity', async () => {
    const local = new RemoteStartCoordinatorModel()
    local.issueLocal({ contextId: 'blocked-1', gameId: 'roblox', processEpochFloor: 10, expiresAt: 5_000 })
    const localInput = {
      contextId: 'blocked-1',
      gameId: 'roblox',
      candidates: [
        { pid: 12, startTime: 102, gameId: 'roblox', processEpoch: 12, observedAt: 4_002 },
        { pid: 11, startTime: 101, gameId: 'roblox', processEpoch: 11, observedAt: 4_001 },
      ],
      now: 4_100,
      finalPolicyAllows: async () => true,
    }
    const [firstLocal, duplicateLocal] = await Promise.all([
      local.claimLocal(localInput),
      local.claimLocal({ ...localInput, candidates: [] }),
    ])
    expect(firstLocal.process.pid).toBe(11)
    expect(duplicateLocal.status).toBe('joined')

    const denied = new RemoteStartCoordinatorModel()
    denied.issueLocal({ contextId: 'blocked-2', gameId: 'roblox', processEpochFloor: 10, expiresAt: 5_000 })
    expect((await denied.claimLocal({ ...localInput, contextId: 'blocked-2', finalPolicyAllows: async () => false })).status).toBe('denied-after-claim')
    await expect(denied.claimLocal({ ...localInput, contextId: 'blocked-2' })).rejects.toThrow('Local grant unavailable')

    const remote = new RemoteStartCoordinatorModel()
    let consumes = 0
    const candidate = { pid: 20, startTime: 500, gameId: 'roblox', processEpoch: 20, observedAt: 5_000 }
    const consumeInput = {
      requestId: 'r1',
      candidate,
      consume: async () => { consumes += 1; await Promise.resolve(); return { status: 'consumed' } },
      finalPolicyAllows: async () => true,
    }
    const [firstRemote, duplicateRemote] = await Promise.all([
      remote.consumeRemote(consumeInput),
      remote.consumeRemote(consumeInput),
    ])
    expect(firstRemote.status).toBe('started')
    expect(duplicateRemote.status).toBe('joined')
    expect(consumes).toBe(1)
    expect((await remote.consumeRemote({ ...consumeInput, requestId: 'different' })).status).toBe('lost-race')
    expect((await remote.consumeRemote({ ...consumeInput, candidate: { ...candidate, startTime: 501 } })).status).toBe('lost-race')

    const uncertain = new RemoteStartCoordinatorModel()
    expect((await uncertain.consumeRemote({ requestId: 'r2', candidate, consume: async () => ({ status: 'indeterminate' }), finalPolicyAllows: async () => true })).status).toBe('indeterminate')
    expect((await uncertain.consumeRemote({ requestId: 'r2', candidate, consume: async () => ({ status: 'consumed' }), finalPolicyAllows: async () => true })).status).toBe('indeterminate')
    expect(await uncertain.reconcileIndeterminate('not-consumed')).toBe('idle')
  })

  it('derives immutable broker capabilities from trusted credentials and detects protected-journal rollback', () => {
    const trustedCredentials = new Map([
      ['electron-key', 'electron-operational'],
      ['admin-key', 'local-admin-broker'],
      ['accounting-key', 'protected-accounting-broker'],
    ])
    const operational = authenticateBrokerPrincipal({ credentialId: 'electron-key', signatureVerified: true }, trustedCredentials)
    const membership = authenticateBrokerPrincipal({ credentialId: 'admin-key', signatureVerified: true }, trustedCredentials)
    expect(authorizeBrokerCall({ authenticatedPrincipal: operational, operation: 'create-request', adminSession: null, integrityHealthy: true })).toBe(true)
    expect(() => authorizeBrokerCall({ authenticatedPrincipal: operational, operation: 'reset-household', adminSession: { authenticated: true }, integrityHealthy: true })).toThrow('Capability denied')
    expect(() => authorizeBrokerCall({ authenticatedPrincipal: membership, operation: 'revoke-parent', adminSession: null, integrityHealthy: true })).toThrow('Admin broker session required')
    expect(() => authenticateBrokerPrincipal({ credentialId: 'electron-key', signatureVerified: false }, trustedCredentials)).toThrow('Unsigned caller')
    expect(() => authorizeBrokerCall({
      authenticatedPrincipal: { credentialId: 'forged', kind: 'protected-accounting-broker', capability: 'accounting' },
      operation: 'append-debit',
      integrityHealthy: true,
    })).toThrow('Unauthenticated principal')
    expect(() => { CAPABILITIES['create-request'] = 'accounting' }).toThrow()
    expect(CAPABILITIES['create-request']).toBe('operational')

    const secret = randomBytes(32)
    const highWater = { sequence: 0, allowanceVersion: 0, mac: null }
    const journal = new ProtectedAccountingJournal(secret, highWater)
    journal.append({ sequence: 1, allowanceVersion: 7, debitSeconds: 60, requestId: 'r1' })
    journal.append({ sequence: 2, allowanceVersion: 8, debitSeconds: 120, requestId: 'r2' })
    expect(journal.verify()).toBe(true)
    const persistedEntries = structuredClone(journal.entries)
    expect(new ProtectedAccountingJournal(secret, highWater, persistedEntries).verify()).toBe(true)
    expect(() => new ProtectedAccountingJournal(secret)).toThrow('Protected high-water required')
    journal.entries.pop()
    expect(journal.verify()).toBe(false)
    expect(() => journal.append({ sequence: 2, allowanceVersion: 9, debitSeconds: 30, requestId: 'r3' })).toThrow('Protected journal mismatch')
    expect(() => new ProtectedAccountingJournal(secret, highWater, journal.entries)).toThrow('Protected journal mismatch')
  })

  it('executes D1-style CAS transitions with grant and debit triggers in the same statement transaction', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(readFileSync(new URL('../proofs/remote-approval/d1-transitions.sql', import.meta.url), 'utf8'))
    db.prepare('INSERT INTO environments VALUES (?, ?, ?)').run('global', 'LOCAL_ONLY', 1)
    db.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run('h1', 0, 1, 1)
    db.prepare(`INSERT INTO approval_requests (
      id, household_id, pc_id, game_id, allowance_version, membership_epoch,
      service_epoch, household_service_epoch, status, created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('r1', 'h1', 'pc1', 'roblox', 7, 1, 1, 1, 'pending', 1_000_000, 1_300_000)
    const approve = db.prepare(`UPDATE approval_requests AS request
      SET status='approved', approved_at_ms=?1, approved_by=?2, approved_minutes=?3
      WHERE id=?4 AND status='pending' AND expires_at_ms>?1
        AND membership_epoch=?5 AND service_epoch=?6 AND household_service_epoch=?7
        AND EXISTS (SELECT 1 FROM environments environment WHERE environment.id='global' AND environment.mode='REMOTE_ENABLED' AND environment.service_epoch=?6)
        AND EXISTS (SELECT 1 FROM households household WHERE household.id=request.household_id AND household.remote_enabled=1 AND household.membership_epoch=?5 AND household.service_epoch=?7)`)
    expect(approve.run(1_299_999, 'p1', 20, 'r1', 1, 1, 1).changes).toBe(0)
    db.prepare(`UPDATE environments SET mode='REMOTE_ENABLED' WHERE id='global'`).run()
    db.prepare('UPDATE households SET remote_enabled=1 WHERE id=?').run('h1')

    db.exec('BEGIN IMMEDIATE')
    db.prepare('INSERT INTO idempotency_records VALUES (?, ?, ?, ?, NULL, ?)').run('p1', 1, 'idem-approve', 'digest-approve', 1_400_000)
    expect(approve.run(1_299_999, 'p1', 20, 'r1', 1, 1, 1).changes).toBe(1)
    db.prepare('UPDATE idempotency_records SET result_json=? WHERE actor_id=? AND membership_epoch=? AND idempotency_key=?')
      .run('{\"status\":\"approved\",\"winner\":\"p1\"}', 'p1', 1, 'idem-approve')
    db.exec('COMMIT')
    expect(() => {
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO idempotency_records VALUES (?, ?, ?, ?, NULL, ?)').run('p1', 1, 'idem-approve', 'digest-approve', 1_400_000)
    }).toThrow()
    db.exec('ROLLBACK')
    expect(db.prepare('SELECT result_json FROM idempotency_records WHERE actor_id=? AND membership_epoch=? AND idempotency_key=?').get('p1', 1, 'idem-approve').result_json)
      .toBe('{\"status\":\"approved\",\"winner\":\"p1\"}')
    expect(approve.run(1_299_999, 'p2', 30, 'r1', 1, 1, 1).changes).toBe(0)
    expect(db.prepare('SELECT approved_by FROM approval_grants WHERE request_id=?').get('r1').approved_by).toBe('p1')

    const consume = db.prepare(`UPDATE approval_grants AS grant_row
      SET state='consumed', consumed_at_ms=?1
      WHERE request_id=?2 AND state='issued' AND expires_at_ms>?1
        AND pc_id=?3 AND game_id=?4 AND allowance_version=?5
        AND membership_epoch=?6 AND service_epoch=?7 AND household_service_epoch=?8
        AND EXISTS (SELECT 1 FROM environments environment WHERE environment.id='global' AND environment.mode='REMOTE_ENABLED' AND environment.service_epoch=?7)
        AND EXISTS (SELECT 1 FROM households household WHERE household.id=grant_row.household_id AND household.remote_enabled=1 AND household.membership_epoch=?6 AND household.service_epoch=?8)`)
    db.prepare('UPDATE households SET remote_enabled=0 WHERE id=?').run('h1')
    expect(consume.run(1_599_998, 'r1', 'pc1', 'roblox', 7, 1, 1, 1).changes).toBe(0)
    db.prepare('UPDATE households SET remote_enabled=1 WHERE id=?').run('h1')
    expect(consume.run(1_599_998, 'r1', 'pc1', 'roblox', 7, 1, 1, 1).changes).toBe(1)
    expect(consume.run(1_599_998, 'r1', 'pc1', 'roblox', 7, 1, 1, 1).changes).toBe(0)
    expect(db.prepare('SELECT debit_seconds FROM allowance_debits WHERE request_id=?').get('r1').debit_seconds).toBe(1_200)
    db.close()
  })

  it('claims only one later matching process from memory-only local preauthorization', () => {
    const grant = new LocalPreauthorization({ contextId: 'blocked-1', gameId: 'roblox', processEpochFloor: 10, expiresAt: 5_000 })
    expect(() => grant.claim({ contextId: 'blocked-1', gameId: 'roblox', processEpoch: 10, now: 4_000 })).toThrow('Process claim mismatch')
    expect(grant.claim({ contextId: 'blocked-1', gameId: 'roblox', processEpoch: 11, now: 4_000 })).toEqual({ gameId: 'roblox', processEpoch: 11 })
    expect(() => grant.claim({ contextId: 'blocked-1', gameId: 'roblox', processEpoch: 12, now: 4_001 })).toThrow('already claimed')
  })
  it('fails signed Android update metadata closed on downgrade, digest, and signer-lineage mismatch', async () => {
    const vector = JSON.parse(readFileSync(new URL('../proofs/remote-approval/auth-golden-vector.json', import.meta.url), 'utf8'))
    const apkBytes = new TextEncoder().encode('test-apk-bytes')
    const manifest = {
      versionCode: 2,
      minimumVersionCode: 1,
      url: 'https://updates.example/playtime-pact-2.apk',
      sha256: '664bc98735ecb91595df2e654eb5d653c436a79c18fe212c0b54971663e4ebb9',
      size: apkBytes.byteLength,
      releaseNotes: 'Test update',
      signerSha256: 'trusted-lineage',
    }
    const privateKey = await importJWK(vector.testOnlyPrivateJwk, 'ES256')
    const sign = (value) => new CompactSign(new TextEncoder().encode(JSON.stringify(value)))
      .setProtectedHeader({ alg: 'ES256', typ: 'playtime-pact-update+jws' })
      .sign(privateKey)
    const compactJws = await sign(manifest)
    await expect(verifySignedUpdate({
      compactJws,
      trustedPublicJwk: vector.publicJwk,
      apkBytes,
      installedVersionCode: 1,
      installedSignerSha256: 'trusted-lineage',
    })).resolves.toMatchObject({ versionCode: 2 })
    await expect(verifySignedUpdate({
      compactJws,
      trustedPublicJwk: vector.publicJwk,
      apkBytes: new TextEncoder().encode('tampered-apk'),
      installedVersionCode: 1,
      installedSignerSha256: 'trusted-lineage',
    })).rejects.toThrow()
    await expect(verifySignedUpdate({
      compactJws,
      trustedPublicJwk: vector.publicJwk,
      apkBytes,
      installedVersionCode: 2,
      installedSignerSha256: 'trusted-lineage',
    })).rejects.toThrow('Update version policy denied')
    await expect(verifySignedUpdate({
      compactJws,
      trustedPublicJwk: vector.publicJwk,
      apkBytes,
      installedVersionCode: 1,
      installedSignerSha256: 'different-lineage',
    })).rejects.toThrow('APK signer lineage mismatch')
  })
})
