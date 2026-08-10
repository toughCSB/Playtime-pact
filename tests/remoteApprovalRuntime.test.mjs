import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RemoteApprovalApiClient, RemoteApprovalClientError } from '../src/main/remoteApproval/apiClient'
import { loadRemoteApprovalRuntimeConfig, WindowsCngRemoteApprovalBroker } from '../src/main/remoteApproval/runtimeBroker'
import { RemoteStartCoordinator } from '../src/main/remoteApproval/startCoordinator'
import { PRIVILEGED_PIPE, PrivilegedApprovalService, PrivilegedBrokerClient, namedPipeTransport, startPrivilegedPipeServer } from '../src/main/remoteApproval/privilegedService'

const accounting = { reservePreauthorization: async () => {}, authorizeTimerStart: async () => {}, recordTimerOutcome: async () => {} }
const scopeFor = (permission) => ({
  householdId: permission.householdId,
  pcId: permission.pcId,
  gameId: permission.gameId,
  ianaTimeZone: 'UTC',
  ianaDay: '2026-08-05',
  allowanceVersion: permission.allowanceVersion,
  totalMs: 1_000_000,
})
const accountingScope = { householdId: 'household-1', pcId: 'pc-1', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 1_000 }
const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }
const adminJwk = { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }
const config = {
  schemaVersion: 1,
  baseUrl: 'https://approval.example',
  membership: { householdId: 'household-1', pcId: 'pc-1', membershipEpoch: 3, serviceEpoch: 7 },
  operational: { actorId: 'pc-1', keyName: 'operational-key', publicJwk: jwk },
  admin: { actorId: 'parent-admin', keyName: 'admin-key', publicJwk: adminJwk, recoveryParentId: 'parent-admin', recoveryPublicJwk: adminJwk },
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

describe('runtime remote approval broker', () => {
  it('binds the operational CNG proof to the exact PC-state URL and epochs', async () => {
    let request
    let signing
    const broker = new WindowsCngRemoteApprovalBroker(
      config,
      async (url, init) => {
        request = { url: url.toString(), init }
        return new Response(JSON.stringify({ serverNowMs: Date.now(), health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1 } }), { status: 200 })
      },
      async (keyName, signingInput) => {
        signing = { keyName, signingInput }
        return 'S'.repeat(86)
      },
    )

    await broker.invoke({ operation: 'read-status', payload: {}, idempotencyKey: 'status:1' })
    expect(request.url).toBe('https://approval.example/v1/pc/state?householdId=household-1&pcId=pc-1')
    expect(request.init.method).toBe('GET')
    expect(signing.keyName).toBe('operational-key')
    const [, encodedClaims] = signing.signingInput.split('.')
    expect(decode(encodedClaims)).toMatchObject({ actorId: 'pc-1', htm: 'GET', htu: request.url, membershipEpoch: 3, serviceEpoch: 7, idempotencyKey: 'status:1' })
  })

  it('uses the admin CNG identity for one-time pairing and emits an Android-compatible URI', async () => {
    const calls = []
    const broker = new WindowsCngRemoteApprovalBroker(
      config,
      async (url, init) => {
        calls.push({ url: url.toString(), init })
        return new Response(JSON.stringify({ operation: 'issuePairing', pairing_session_id: 'pair-1', token: 'T'.repeat(43), created_at_ms: 1000, expires_at_ms: 301000 }), { status: 200 })
      },
      async (keyName) => {
        expect(keyName).toBe('admin-key')
        return 'S'.repeat(86)
      },
    )
    const client = new RemoteApprovalApiClient(broker, 0)
    const session = await client.createPairingSession({ ...config.membership, idempotencyKey: 'pair:1' })
    expect(calls[0].url).toBe('https://approval.example/v1/pairing-sessions')
    expect(session.uri).toContain('playtimepact://pair?')
    expect(session.uri).toContain('baseUrl=https%3A%2F%2Fapproval.example')
    expect(session.uri).toContain('parentId=pair-1')
    expect(session.expiresAt - session.createdAt).toBe(300000)
  })

  it('accepts only tuple-bound mutation receipts and never treats approval as a launch command', async () => {
    const request = {
      requestId: 'request-1', householdId: 'household-1', pcId: 'pc-1', gameId: 'roblox', allowanceVersion: 1,
      processId: '42', processStartedAt: 100, membershipEpoch: 3, serviceEpoch: 7, requestedAt: 1000, expiresAt: 301000,
    }
    const broker = {
      async invoke({ operation }) {
        expect(operation).toBe('create-request')
        return { v: 1, request }
      },
    }
    const client = new RemoteApprovalApiClient(broker, 0)
    await expect(client.createRequest(request, 'request:1')).resolves.toEqual(request)
  })
  it('rebinds one approved grant to the first trusted relaunch process and starts no game', async () => {
    const now = 2000
    const grant = {
      grantId: 'grant-1', allowanceReservationId: 'reservation-1', householdId: 'household-1', requestId: 'request-1',
      pcId: 'pc-1', gameId: 'roblox', allowanceVersion: 1, processId: 'blocked-process', processStartedAt: 100,
      membershipEpoch: 3, serviceEpoch: 7, approvedMinutes: 20, grantedAt: 1000, expiresAt: 301000, launchGame: false,
    }
    let consumedClaim
    let timerStarts = 0
    const api = {
      async consumeGrant({ grant: claim }) {
        consumedClaim = claim
        return claim
      },
    }
    const coordinator = new RemoteStartCoordinator(
      api,
      ({ permission }) => permission.processId === 'relaunched-process' && permission.processStartedAt === 300,
      () => { timerStarts += 1; return true },
      accounting,
      () => now,
      scopeFor,
    )
    const process = { gameId: 'roblox', processId: 'relaunched-process', processStartedAt: 300 }
    const [first, duplicate] = await Promise.all([
      coordinator.consumeRemoteGrant(grant, process, 3, 7),
      coordinator.consumeRemoteGrant(grant, process, 3, 7),
    ])
    expect([first, duplicate].filter((result) => result === 'started')).toHaveLength(1)
    expect(consumedClaim).toMatchObject({ processId: 'relaunched-process', processStartedAt: 300, launchGame: false })
    expect(timerStarts).toBe(1)
  })
  it('requires protected reserve/start/debit receipts before policy timer start', async () => {
    const receipts = []
    const coordinator = new RemoteStartCoordinator(
      null,
      () => true,
      () => true,
      { reservePreauthorization: async () => {}, authorizeTimerStart: async (receipt, minutes) => { receipts.push({ receipt, minutes }) }, recordTimerOutcome: async () => {} },
      () => 1_000,
      scopeFor,
    )
    await expect(coordinator.startPolicyAuthorized({ gameId: 'roblox', processId: 'fresh-process', processStartedAt: 2_000 }, 20)).resolves.toBe(true)
    expect(receipts).toEqual([{ receipt: 'timer:policy:policy-fresh-process-2000', minutes: 20 }])
    const denied = new RemoteStartCoordinator(null, () => true, () => true, null, () => 1_000, scopeFor)
    await expect(denied.startPolicyAuthorized({ gameId: 'roblox', processId: 'other-process', processStartedAt: 2_001 }, 20)).resolves.toBe(false)
  })
  it('audits a false or throwing timer start with a terminal accounting outcome', async () => {
    const outcomes = []
    const authority = {
      reservePreauthorization: async () => {},
      authorizeTimerStart: async () => {},
      recordTimerOutcome: async (_receipt, _minutes, started) => { outcomes.push(started) },
    }
    const falseStart = new RemoteStartCoordinator(null, () => true, () => false, authority, () => 1_000, scopeFor)
    await expect(falseStart.startPolicyAuthorized({ gameId: 'roblox', processId: 'false-start', processStartedAt: 2_000 }, 20)).resolves.toBe(false)
    const throwingStart = new RemoteStartCoordinator(null, () => true, () => { throw new Error('timer failed') }, authority, () => 1_000, scopeFor)
    await expect(throwingStart.startPolicyAuthorized({ gameId: 'roblox', processId: 'throw-start', processStartedAt: 2_001 }, 20)).resolves.toBe(false)
    expect(outcomes).toEqual([false, false])
  })
  it('rejects skewed or rolled-back authoritative server time', async () => {
    let responseTime = 1_000
    const broker = new WindowsCngRemoteApprovalBroker(
      config,
      async () => new Response(JSON.stringify({ serverNowMs: responseTime, health: {} }), { status: 200 }),
      async () => 'S'.repeat(86),
      () => 1_000,
    )
    await broker.invoke({ operation: 'read-status', payload: {}, idempotencyKey: 'status:clock-1' })
    expect(broker.authoritativeNow()).toBe(1_000)
    responseTime = -1
    await expect(broker.invoke({ operation: 'read-status', payload: {}, idempotencyKey: 'status:clock-2' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('fails closed when a protected remote configuration is tampered', () => {
    const tampered = { ...config, operational: { ...config.operational, actorId: 'not-the-configured-pc' } }
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-remote-tampered-'))
    const path = join(directory, 'remote.json')
    try {
      writeFileSync(path, JSON.stringify(tampered))
      expect(() => loadRemoteApprovalRuntimeConfig(path)).toThrow('invalid')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('keeps capability and replay boundaries separate', async () => {
    const service = new PrivilegedApprovalService(async () => ({ ok: 'operational' }), async () => ({ ok: 'membership' }), { totalMs: 1_000, committedMs: 0, reservedMs: 0, version: 1 })
    const request = { capability: 'accounting', purpose: 'start-accounting', nonce: 'A'.repeat(16), operation: 'read', payload: { scope: accountingScope } }
    await expect(service.invoke(request)).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(service.invoke(request)).rejects.toThrow('replay')
    await expect(service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'B'.repeat(16), operation: 'update', payload: {} })).rejects.toThrow('capability')
  })
  it('round-trips peer-validated framed requests and persists accounting CAS', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-privileged-'))
    const pipe = process.platform === 'win32' ? `${PRIVILEGED_PIPE}-test-${Date.now()}` : join(directory, 'broker.sock')
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
    const server = await startPrivilegedPipeServer(service, pipe, () => 'test-peer')
    try {
      const request = { capability: 'accounting', purpose: 'start-accounting', nonce: 'G'.repeat(16), operation: 'reserve', payload: { scope: accountingScope, receipt: 'receipt-runtime-0001:reserve', expectedVersion: 0, amountMs: 1 } }
      await expect(namedPipeTransport(pipe)(request)).resolves.toMatchObject({ scopes: expect.any(Object) })
      expect(PrivilegedApprovalService.loadAccounting(directory)).toMatchObject({ scopes: expect.any(Object) })
    } finally {
      await new Promise((resolve) => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  ;(process.platform === 'win32' ? it : it.skip)('authenticates a real Windows pipe client from its native process handle', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-native-pipe-'))
    const pipe = `${PRIVILEGED_PIPE}-native-${process.pid}-${Date.now()}`
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
    const server = await startPrivilegedPipeServer(service, pipe)
    try {
      const request = { capability: 'accounting', purpose: 'start-accounting', nonce: 'H'.repeat(16), operation: 'read', payload: { scope: accountingScope } }
      await expect(namedPipeTransport(pipe)(request)).resolves.toMatchObject({ scopes: expect.any(Object) })
    } finally {
      await new Promise((resolve) => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  ;(process.platform === 'win32' ? it : it.skip)('rejects a native broker that is not the running SCM service before sending a request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-unregistered-pipe-'))
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
    const server = await startPrivilegedPipeServer(service)
    try {
      const request = { capability: 'accounting', purpose: 'start-accounting', nonce: 'S'.repeat(16), operation: 'read', payload: { scope: accountingScope } }
      await expect(namedPipeTransport()(request)).rejects.toThrow('identity denied')
    } finally {
      await new Promise((resolve) => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  ;(process.platform === 'win32' ? it : it.skip)('keeps the native broker pipe first-instance exclusive', async () => {
    const pipe = `${PRIVILEGED_PIPE}-exclusive-${process.pid}-${Date.now()}`
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} })
    const server = await startPrivilegedPipeServer(service, pipe)
    try {
      await expect(startPrivilegedPipeServer(service, pipe)).rejects.toThrow('first-instance')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
  it('persists only administrator-authenticated protected local policy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-local-policy-'))
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, (pin) => pin === '1234')
      const verified = await service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'policy-verify-001', operation: 'verify-pin', payload: { pin: '1234' } }, 'peer-a')
      const policy = {
        ianaTimeZone: 'Asia/Seoul',
        weekdayLimit: 30,
        weekendLimit: 60,
        weekdaySessionCount: 2,
        weekendSessionCount: 2,
        allowedStartHour: 8,
        allowedEndHour: 22,
        requireApprovalBeforeStart: true,
      }
      await expect(service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'policy-write-0001', adminSession: verified.token, operation: 'set-local-policy', payload: { policy } }, 'peer-a')).resolves.toMatchObject({ version: 1, ianaTimeZone: 'Asia/Seoul' })
      await expect(service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'policy-write-0002', operation: 'set-local-policy', payload: { policy } }, 'peer-a')).rejects.toThrow('capability')
      expect(PrivilegedApprovalService.loadLocalPolicy(directory)).toMatchObject({ version: 1, weekdayLimit: 30, weekdaySessionCount: 2 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('makes journal receipts idempotent and rejects conflicting or out-of-order transitions', async () => {
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { totalMs: 1_000, committedMs: 0, reservedMs: 0, version: 0 })
    const call = (nonce, operation, payload) => service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce, operation, payload: { scope: accountingScope, ...payload } }, 'peer-a')
    const reserve = { receipt: 'timer-adversarial-0001:reserve', expectedVersion: 0, amountMs: 100 }
    await expect(call('I'.repeat(16), 'reserve', reserve)).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(call('J'.repeat(16), 'reserve', reserve)).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(call('K'.repeat(16), 'reserve', { ...reserve, amountMs: 101 })).rejects.toThrow('conflict')
    await expect(call('L'.repeat(16), 'debit', { receipt: 'timer-adversarial-0001:debit', expectedVersion: 1, amountMs: 100 })).rejects.toThrow('transition')
    await expect(call('M'.repeat(16), 'start', { receipt: 'timer-adversarial-0001:start', expectedVersion: 1 })).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(call('N'.repeat(16), 'debit', { receipt: 'timer-adversarial-0001:debit', expectedVersion: 2, amountMs: 99 })).rejects.toThrow('transition')
  })
  it('preserves receipt idempotency across restart and rejects tampered journals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-journal-'))
    try {
      const request = { capability: 'accounting', purpose: 'start-accounting', nonce: 'O'.repeat(16), operation: 'reserve', payload: { scope: accountingScope, receipt: 'timer-restart-0001:reserve', expectedVersion: 0, amountMs: 10 } }
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      await first.invoke(request, 'peer-a')
      const resumed = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      await expect(resumed.invoke({ ...request, nonce: 'P'.repeat(16) }, 'peer-a')).resolves.toMatchObject({ scopes: expect.any(Object) })
      const path = join(directory, 'accounting.journal')
      writeFileSync(path, readFileSync(path, 'utf8').replace('"amountMs":10', '"amountMs":11'))
      expect(() => PrivilegedApprovalService.loadAccounting(directory)).toThrow('integrity')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('durably releases an expired reserve-only entry during service restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-expired-reserve-'))
    let now = 10
    try {
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => now)
      await first.invoke({
        capability: 'accounting',
        purpose: 'start-accounting',
        nonce: 'expiry-reserve-01',
        operation: 'reserve',
        payload: { scope: accountingScope, receipt: 'timer-expiry-0001:reserve', expectedVersion: 0, amountMs: 100, expiresAt: 20 },
      }, 'peer-a')
      now = 21
      new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory, () => now)
      const restored = PrivilegedApprovalService.loadAccounting(directory)
      expect(restored.scopes['household-1|pc-1|roblox|UTC|2026-08-05|1']).toMatchObject({ reservedMs: 0, committedMs: 0, version: 2 })
      expect(readFileSync(join(directory, 'accounting.journal'), 'utf8')).toContain('timer-expiry-0001:reconcile-terminal')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('compacts inactive scopes before scope 513 while preserving protected current high-water', async () => {
    const scopes = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [
      `household|pc|game-${index}|UTC|2026-08-05|1`,
      { totalMs: 1, committedMs: 1, reservedMs: 0, version: 1 },
    ]))
    const nextScope = { householdId: 'household', pcId: 'pc', gameId: 'game-512', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 1 }
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes }, undefined, () => 10)
    await expect(service.invoke({
      capability: 'accounting',
      purpose: 'start-accounting',
      nonce: 'scope-capacity-01',
      operation: 'reserve',
      payload: { scope: nextScope, receipt: 'scope-capacity-0001:reserve', expectedVersion: 0, amountMs: 1 },
    }, 'peer-a')).resolves.toMatchObject({ scopes: expect.any(Object) })
    const existingScope = { householdId: 'household', pcId: 'pc', gameId: 'game-0', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 1 }
    await expect(service.invoke({
      capability: 'accounting',
      purpose: 'start-accounting',
      nonce: 'scope-capacity-02',
      operation: 'read',
      payload: { scope: existingScope },
    }, 'peer-a')).rejects.toThrow('rollback')
    const retainedScope = { ...existingScope, gameId: 'game-1' }
    await expect(service.invoke({
      capability: 'accounting',
      purpose: 'start-accounting',
      nonce: 'scope-capacity-03',
      operation: 'read',
      payload: { scope: retainedScope },
    }, 'peer-a')).resolves.toMatchObject({ scopes: expect.any(Object) })
  })
  it('isolates accounting high-water by game/day/version scope', async () => {
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} })
    const scope = (gameId, ianaDay, allowanceVersion) => ({ householdId: 'h', pcId: 'p', gameId, ianaTimeZone: 'UTC', ianaDay, allowanceVersion, totalMs: 100 })
    const call = (nonce, scoped, receipt) => service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce, operation: 'reserve', payload: { scope: scoped, receipt, expectedVersion: 0, amountMs: 10 } }, 'peer')
    await expect(call('Q'.repeat(16), scope('roblox', '2026-08-05', 1), 'scope-roblox-day-1:reserve')).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(call('R'.repeat(16), scope('minecraft', '2026-08-05', 1), 'scope-minecraft-day-1:reserve')).resolves.toMatchObject({ scopes: expect.any(Object) })
    await expect(call('S'.repeat(16), scope('roblox', '2026-08-06', 2), 'scope-roblox-day-2:reserve')).resolves.toMatchObject({ scopes: expect.any(Object) })
  })
  it('fails closed when pipe client is unavailable', async () => {
    const client = namedPipeTransport(process.platform === 'win32' ? `${PRIVILEGED_PIPE}-missing` : join(tmpdir(), 'missing-broker.sock'), 20)
    await expect(client({ capability: 'accounting', purpose: 'start-accounting', nonce: 'H'.repeat(16), operation: 'read', payload: {} })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
  it('requires a process strictly later than local preauthorization issuance', async () => {
    const coordinator = new RemoteStartCoordinator(null, () => true, () => true, accounting, () => 1_000, scopeFor)
    coordinator.issueLocalPreauthorization({
      permission: { householdId: 'local', requestId: 'request', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: 'candidate', processStartedAt: 1 },
      membershipEpoch: 1,
      serviceEpoch: 1,
      expiresAt: 2_000,
      bindFirstProcess: true,
    })
    await expect(coordinator.consumeLocalPreauthorization({ gameId: 'roblox', processId: 'at-issue', processStartedAt: 1_000 }, 1, 1, 20)).resolves.toBe(false)
    await expect(coordinator.consumeLocalPreauthorization({ gameId: 'roblox', processId: 'after-issue', processStartedAt: 1_001 }, 1, 1, 20)).resolves.toBe(true)
  })
  it('reconciles an indeterminate consume with the original receipt tuple and idempotency key', async () => {
    const grant = {
      grantId: 'grant-timeout', allowanceReservationId: 'reservation-timeout', householdId: 'household-1', requestId: 'request-timeout',
      pcId: 'pc-1', gameId: 'roblox', allowanceVersion: 1, processId: 'blocked', processStartedAt: 1,
      membershipEpoch: 3, serviceEpoch: 7, approvedMinutes: 20, grantedAt: 1_000, expiresAt: 301_000, launchGame: false,
    }
    const calls = []
    const api = {
      async consumeGrant(input) {
        calls.push(input)
        if (calls.length === 1) throw new RemoteApprovalClientError('unavailable')
        return input.grant
      },
    }
    const coordinator = new RemoteStartCoordinator(api, () => true, () => true, accounting, () => 2_000, scopeFor)
    const process = { gameId: 'roblox', processId: 'relaunch', processStartedAt: 2 }
    await expect(coordinator.consumeRemoteGrant(grant, process, 3, 7)).resolves.toBe('indeterminate')
    await expect(coordinator.consumeRemoteGrant(grant, process, 3, 7)).resolves.toBe('started')
    expect(calls).toHaveLength(2)
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey)
    expect(calls[1].grant).toEqual(calls[0].grant)
  })
  it('atomically persists reset epochs and disables deleted household configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-remote-'))
    const path = join(directory, 'remote.json')
    try {
      writeFileSync(path, JSON.stringify(config))
      const loaded = loadRemoteApprovalRuntimeConfig(path)
      expect(loaded).not.toBeNull()
      const broker = new WindowsCngRemoteApprovalBroker(loaded)
      broker.updateMembership({ membershipEpoch: 4, serviceEpoch: 7 })
      expect(JSON.parse(readFileSync(path, 'utf8')).membership).toMatchObject({ membershipEpoch: 4, serviceEpoch: 7 })
      broker.disable()
      expect(loadRemoteApprovalRuntimeConfig(path)).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('denies uninitialized protected policy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-'))
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      await expect(service.invoke({ capability: 'operational', purpose: 'remote-approval', nonce: 'U'.repeat(16), operation: 'read-local-policy', payload: {} }, 'peer')).rejects.toThrow('uninitialized')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('keeps protected policy revision and high-water conservative across no-op, schedule, lower, and raise edits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-revision-'))
    const policy = { ianaTimeZone: 'UTC', weekdayLimit: 20, weekendLimit: 20, weekdaySessionCount: 2, weekendSessionCount: 2, allowedStartHour: 16, allowedEndHour: 22, requireApprovalBeforeStart: true }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true)
      const invoke = (nonce, operation, payload, adminSession) => service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce, operation, payload, adminSession }, 'peer')
      const verified = await invoke('V'.repeat(16), 'verify-pin', { pin: '0000' })
      const token = verified.token
      const first = await invoke('W'.repeat(16), 'set-local-policy', { policy }, token)
      const same = await invoke('X'.repeat(16), 'set-local-policy', { policy }, token)
      expect(same.version).toBe(first.version)
      const scheduled = await invoke('Y'.repeat(16), 'set-local-policy', { policy: { ...policy, allowedEndHour: 21 } }, token)
      expect(scheduled.version).toBe(first.version + 1)
      const lowered = await invoke('Z'.repeat(16), 'set-local-policy', { policy: { ...policy, weekdayLimit: 10 } }, token)
      expect(lowered.version).toBe(scheduled.version + 1)
      const raised = await invoke('a'.repeat(16), 'set-local-policy', { policy: { ...policy, weekdayLimit: 30 } }, token)
      expect(raised.version).toBe(lowered.version + 1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('persists compacted rollback floors across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-compact-floor-'))
    try {
      const scope = { householdId: 'h', pcId: 'p', gameId: 'g', ianaTimeZone: 'UTC', ianaDay: '2025-01-01', allowanceVersion: 1, totalMs: 10 }
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      for (let index = 0; index < 1025; index++) {
        const scoped = { ...scope, ianaDay: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10), allowanceVersion: index + 1 }
        const receipt = `compact-receipt-${index}`
        await service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `compact-${index}`.padEnd(16, 'x'), operation: 'reserve', payload: { scope: scoped, receipt: `${receipt}:reserve`, expectedVersion: 0, amountMs: 1 } }, 'peer')
        await service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `release-${index}`.padEnd(16, 'y'), operation: 'reconcile', payload: { scope: scoped, receipt: `${receipt}:reconcile-terminal`, expectedVersion: 1, terminal: true } }, 'peer')
      }
      const restored = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      await expect(restored.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: 'rollback-replay01', operation: 'reserve', payload: { scope, receipt: 'rollback-replay-01:reserve', expectedVersion: 0, amountMs: 1 } }, 'peer')).rejects.toThrow('rollback')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
