import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RemoteApprovalApiClient, RemoteApprovalClientError } from '../src/main/remoteApproval/apiClient'
import { loadRemoteApprovalRuntimeConfig, WindowsCngRemoteApprovalBroker } from '../src/main/remoteApproval/runtimeBroker'
import { ServerClock } from '../src/main/remoteApproval/serverClock'
import { RemoteStartCoordinator } from '../src/main/remoteApproval/startCoordinator'
import { PRIVILEGED_PIPE, PrivilegedApprovalService, PrivilegedBrokerClient, namedPipeTransport, startPrivilegedPipeServer, windowsServiceOwnsPipeServer } from '../src/main/remoteApproval/privilegedService'

const accounting = { commitTimerStart: async () => {}, listRecoverableTimerStarts: async () => [], acknowledgeTimerMaterialized: async () => {} }
const authority = (membershipEpoch = 3, serviceEpoch = 7, authorityGeneration = 1) => ({ membershipEpoch, serviceEpoch, authorityGeneration })
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
const outcomeContext = (requestId) => ({
  permission: { householdId: 'household-1', requestId, pcId: 'pc-1', gameId: 'roblox', allowanceVersion: 1, processId: 'process-1', processStartedAt: 1 },
  authority: authority(),
})
function testPolicySelectorName(directory) {
  return createHash('sha256').update(resolve(directory).toLowerCase()).digest('hex')
}
function removeTestPolicySelector(directory) {
  if (process.platform !== 'win32') return true
  const script = "$b=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('SOFTWARE\\PlaytimePact',$true);if($null-ne$b){try{$k=$b.OpenSubKey('PolicySelectors',$true);if($null-ne$k){try{$k.DeleteValue($env:PP_NAME,$false);$k.Flush();$empty=($k.ValueCount-eq0-and$k.SubKeyCount-eq0)}finally{$k.Dispose()};if($empty){$b.DeleteSubKey('PolicySelectors',$false)}}}finally{$b.Dispose()}};$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('SOFTWARE\\PlaytimePact\\PolicySelectors');if($null-eq$k){[Console]::Out.Write('absent')}else{try{if($null-eq$k.GetValue($env:PP_NAME,$null)){[Console]::Out.Write('absent')}else{[Console]::Out.Write('present')}}finally{$k.Dispose()}}"
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PP_NAME: testPolicySelectorName(directory) } }).trim() === 'absent'
}
function writeInvalidTestPolicySelector(directory, kind) {
  const script = "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('SOFTWARE\\PlaytimePact\\PolicySelectors');try{if($env:PP_KIND-eq'empty-string'){$k.SetValue($env:PP_NAME,'',[Microsoft.Win32.RegistryValueKind]::String)}else{$k.SetValue($env:PP_NAME,1,[Microsoft.Win32.RegistryValueKind]::DWord)};$k.Flush()}finally{$k.Dispose()}"
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, PP_KIND: kind, PP_NAME: testPolicySelectorName(directory) } })
}
const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }
const adminJwk = { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }
const config = {
  schemaVersion: 1,
  baseUrl: 'https://approval.example',
  mutableStateDir: join(tmpdir(), 'playtime-pact-runtime-mutable'),
  windowsAccount: 'TEST\Child',
  windowsAccountSid: 'S-1-5-21-111-222-333-1001',
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
      () => now,
      () => authority(),
      scopeFor,
    )
    const process = { gameId: 'roblox', processId: 'relaunched-process', processStartedAt: 300 }
    const [first, duplicate] = await Promise.all([
      coordinator.consumeRemoteGrant(grant, process, authority()),
      coordinator.consumeRemoteGrant(grant, process, authority()),
    ])
    expect([first, duplicate].filter((result) => result === 'started')).toHaveLength(1)
    expect(consumedClaim).toMatchObject({ processId: 'relaunched-process', processStartedAt: 300, launchGame: false })
    expect(timerStarts).toBe(1)
  })
  it('requires a durable committed handoff before policy timer materialization', async () => {
    const receipts = []
    const coordinator = new RemoteStartCoordinator(
      null,
      () => true,
      () => true,
      { commitTimerStart: async (handoff) => { receipts.push(handoff) } },
      () => null,
      () => 1_000,
      () => authority(1, 1),
      scopeFor,
    )
    await expect(coordinator.startPolicyAuthorized({ gameId: 'roblox', processId: 'fresh-process', processStartedAt: 2_000 }, 20)).resolves.toBe(true)
    expect(receipts).toEqual([expect.objectContaining({ receipt: 'timer:policy:policy-fresh-process-2000', minutes: 20, permission: expect.objectContaining({ processId: 'fresh-process' }) })])
    const denied = new RemoteStartCoordinator(null, () => true, () => true, null, () => null, () => 1_000, () => authority(1, 1), scopeFor)
    await expect(denied.startPolicyAuthorized({ gameId: 'roblox', processId: 'other-process', processStartedAt: 2_001 }, 20)).resolves.toBe(false)
  })
  it('journals a confirmed remote non-start outcome without requiring a prior local start reserve', async () => {
    const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} })
    const client = new PrivilegedBrokerClient((request) => service.invoke(request, 'peer'))
    const remoteScope = { ...accountingScope, totalMs: 2_000_000 }

    await client.recordTimerOutcome('timer:household-1:remote-consume-not-started', 20, false, remoteScope, outcomeContext('remote-consume-not-started'))

    await expect(client.readAccounting(remoteScope)).resolves.toMatchObject({ committedMs: 0, reservedMs: 0, version: 2 })
  })
  it('keeps a failed timer materialization committed and recoverable', async () => {
    const handoffs = []
    const authority = {
      commitTimerStart: async (handoff) => { handoffs.push(handoff) },
      listRecoverableTimerStarts: async () => handoffs,
      acknowledgeTimerMaterialized: async () => {},
    }
    const falseStart = new RemoteStartCoordinator(null, () => true, () => false, authority, () => null, () => 1_000, () => ({ membershipEpoch: 1, serviceEpoch: 1, authorityGeneration: 1 }), scopeFor)
    await expect(falseStart.startPolicyAuthorized({ gameId: 'roblox', processId: 'false-start', processStartedAt: 2_000 }, 20)).resolves.toBe(false)
    const throwingStart = new RemoteStartCoordinator(null, () => true, () => { throw new Error('timer failed') }, authority, () => null, () => 1_000, () => ({ membershipEpoch: 1, serviceEpoch: 1, authorityGeneration: 1 }), scopeFor)
    await expect(throwingStart.startPolicyAuthorized({ gameId: 'roblox', processId: 'throw-start', processStartedAt: 2_001 }, 20)).resolves.toBe(false)
    expect(handoffs).toHaveLength(2)
    let recovered = 0
    const recovery = new RemoteStartCoordinator(null, () => true, () => { recovered += 1; return true }, authority, () => null, () => 1_000, () => ({ membershipEpoch: 1, serviceEpoch: 1, authorityGeneration: 1 }), scopeFor)
    await recovery.recoverCommittedTimerStarts()
    expect(recovered).toBe(2)
  })
  it('rejects skewed or rolled-back authoritative server time', async () => {
    let responseTime = 1_000
    let monotonicNow = 0
    const broker = new WindowsCngRemoteApprovalBroker(
      config,
      async () => new Response(JSON.stringify({ serverNowMs: responseTime, health: {} }), { status: 200 }),
      async () => 'S'.repeat(86),
      () => 1_000,
      new ServerClock(() => 1_000, () => monotonicNow),
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
  it('health-checks without reading or mutating protected broker state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-health-check-'))
    const policy = {
      version: 1,
      ianaTimeZone: 'UTC',
      weekdayLimit: 20,
      weekendLimit: 30,
      weekdaySessionCount: 2,
      weekendSessionCount: 2,
      allowedStartHour: 8,
      allowedEndHour: 22,
      requireApprovalBeforeStart: true,
    }
    try {
      const journalService = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      await journalService.invoke({
        capability: 'accounting',
        purpose: 'start-accounting',
        nonce: 'health-baseline-01',
        operation: 'reserve',
        payload: { scope: accountingScope, receipt: 'health-baseline-0001:reserve', expectedVersion: 0, amountMs: 1 },
      }, 'health-peer')
      writeFileSync(join(directory, 'local-policy.json'), `${JSON.stringify(policy)}\n`)
      const protectedAccounting = {
        ...PrivilegedApprovalService.loadAccounting(directory),
        globalFloor: { ianaDay: '2099-12-31', allowanceVersion: 99 },
      }
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), protectedAccounting, directory)
      const client = new PrivilegedBrokerClient((request) => service.invoke(request, 'health-peer'))
      const filesBefore = Object.fromEntries(readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name))]))
      const accountingBefore = structuredClone(protectedAccounting)
      const policyBefore = PrivilegedApprovalService.loadLocalPolicy(directory)

      await expect(client.healthCheck()).resolves.toBe('ok')
      const replay = { capability: 'accounting', purpose: 'start-accounting', nonce: 'health-replay-001', operation: 'health-check', payload: {} }
      await expect(service.invoke(replay, 'health-peer')).resolves.toBe('ok')
      await expect(service.invoke(replay, 'health-peer')).rejects.toThrow('replay')
      await expect(service.invoke({ ...replay, capability: 'operational', purpose: 'remote-approval', nonce: 'health-wrong-cap1' }, 'health-peer')).rejects.toThrow('capability')
      await expect(service.invoke({ ...replay, purpose: 'remote-approval', nonce: 'health-wrong-purpose' }, 'health-peer')).rejects.toThrow('capability')

      expect(protectedAccounting).toEqual(accountingBefore)
      expect(PrivilegedApprovalService.loadLocalPolicy(directory)).toEqual(policyBefore)
      expect(Object.fromEntries(readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name))]))).toEqual(filesBefore)
    } finally {
      expect(removeTestPolicySelector(directory)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
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
  it('anchors an installed broker to either the SCM process or its direct WinSW child only', () => {
    const installedExecutable = 'C:\\Program Files\\Playtime Pact\\Playtime Pact.exe'
    const wrapperImage = 'C:\\Program Files\\Playtime Pact\\PlaytimePactPrivilegedBroker.exe'
    const service = { name: 'PlaytimePactPrivilegedBroker', state: 4, processId: 200, image: wrapperImage }
    const server = { processId: 300, parentProcessId: 200, image: installedExecutable }

    expect(windowsServiceOwnsPipeServer(service, server, installedExecutable)).toBe(true)
    expect(windowsServiceOwnsPipeServer(
      { ...service, processId: 300, image: installedExecutable },
      server,
      installedExecutable,
    )).toBe(true)

    const rejected = [
      ['unrelated same-image process', service, { ...server, processId: 301, parentProcessId: 777 }],
      ['grandchild', service, { ...server, parentProcessId: 250 }],
      ['stopped service', { ...service, state: 1 }, server],
      ['wrong parent', { ...service, processId: 201 }, server],
      ['wrong wrapper image', { ...service, image: 'C:\\Windows\\System32\\winsw.exe' }, server],
      ['wrong service identity', { ...service, name: 'UnrelatedPrivilegedBroker' }, server],
      ['wrong Electron image', service, { ...server, image: 'C:\\Program Files\\Playtime Pact\\Unrelated Electron.exe' }],
    ]
    for (const [reason, candidateService, candidateServer] of rejected) {
      expect(windowsServiceOwnsPipeServer(candidateService, candidateServer, installedExecutable), reason).toBe(false)
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
      expect(removeTestPolicySelector(directory)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('throttles PIN verification globally and per caller at the UI lockout boundary', async () => {
    let now = 1_000
    let verifications = 0
    const service = new PrivilegedApprovalService(
      async () => ({}), async () => ({}), { scopes: {} }, undefined, () => now,
      (pin) => { verifications += 1; return pin === '1234' },
    )
    const verify = (peer, index, pin = '0000') => service.invoke({
      capability: 'membership', purpose: 'membership-sync', nonce: `pin-${peer}-${index}`.padEnd(16, 'x'), operation: 'verify-pin', payload: { pin },
    }, peer)

    for (let index = 0; index < 5; index++) await expect(verify(`peer-${index}`, index)).resolves.toEqual({ ok: false })
    await expect(verify('fresh-peer', 6, '1234')).resolves.toEqual({ ok: false })
    expect(verifications).toBe(5)

    now += 30_000
    await expect(verify('fresh-peer', 7, '1234')).resolves.toMatchObject({ ok: true, token: expect.any(String) })
    expect(verifications).toBe(6)
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
  it('owns a timer side effect durably before its result and resolves an abandoned attempt exactly once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-start-attempt-'))
    const durableScope = { householdId: 'policy', pcId: 'policy', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 2_000_000 }
    let timerStarts = 0
    let persistedReceipt = null
    let sideEffectReached
    const sideEffect = new Promise((resolve) => { sideEffectReached = resolve })
    const abandonedResult = new Promise(() => {})
    try {
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      const client = new PrivilegedBrokerClient((request) => first.invoke(request, 'peer-a'))
      const coordinator = new RemoteStartCoordinator(
        null,
        () => true,
        (_minutes, receipt) => { persistedReceipt = receipt; timerStarts += 1; sideEffectReached(); return abandonedResult },
        client,
        () => null,
        () => 1_000,
        () => authority(1, 1),
        () => durableScope,
      )

      void coordinator.startPolicyAuthorized({ gameId: 'roblox', processId: 'crash-process', processStartedAt: 2_000 }, 20)
      await sideEffect
      const entries = readFileSync(join(directory, 'accounting.journal'), 'utf8').trim().split('\n').map(JSON.parse)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        operation: 'commit', receipt: 'timer:policy:policy-crash-process-2000', amountMs: 1_200_000,
        permission: { processId: 'crash-process', processStartedAt: 2_000 },
      })
      const handoff = {
        receipt: 'timer:policy:policy-crash-process-2000', minutes: 20,
        permission: { householdId: 'policy', requestId: 'policy-crash-process-2000', pcId: 'policy', gameId: 'roblox', allowanceVersion: 1, processId: 'crash-process', processStartedAt: 2_000 },
        authority: authority(1, 1), scope: durableScope,
      }
      await expect(client.commitTimerStart(handoff)).resolves.toBeUndefined()
      await expect(client.commitTimerStart({ ...handoff, minutes: 19 })).rejects.toThrow('conflict')
      expect(readFileSync(join(directory, 'accounting.journal'), 'utf8').trim().split('\n')).toHaveLength(1)

      const restarted = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      const once = PrivilegedApprovalService.loadAccounting(directory).scopes['policy|policy|roblox|UTC|2026-08-05|1']
      expect(once).toEqual({ totalMs: 2_000_000, committedMs: 1_200_000, reservedMs: 0, version: 1 })

      const restartedTwice = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      expect(PrivilegedApprovalService.loadAccounting(directory).scopes['policy|policy|roblox|UTC|2026-08-05|1']).toEqual(once)
      let recoveredStarts = 0
      const recoveryClient = new PrivilegedBrokerClient((request) => restartedTwice.invoke(request, 'peer-b'))
      const recovery = new RemoteStartCoordinator(null, () => true, (_minutes, receipt) => {
        if (persistedReceipt !== receipt) { persistedReceipt = receipt; recoveredStarts += 1 }
        return true
      }, recoveryClient, () => null, () => 1_000, () => authority(1, 1), () => durableScope)
      await recovery.recoverCommittedTimerStarts()
      await recovery.recoverCommittedTimerStarts()
      expect(recoveredStarts).toBe(0)
      expect(timerStarts).toBe(1)
      await expect(recoveryClient.listRecoverableTimerStarts()).resolves.toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('recovers a crash after durable timer-state persistence before effect exactly once, then never lists it again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-before-effect-'))
    const durableScope = { householdId: 'policy', pcId: 'policy', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 2_000_000 }
    let persistedReceipt = null
    let persisted
    const statePersisted = new Promise((resolve) => { persisted = resolve })
    const processDeath = new Promise(() => {})
    try {
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      const firstClient = new PrivilegedBrokerClient((request) => first.invoke(request, 'before-effect-a'))
      const coordinator = new RemoteStartCoordinator(null, () => true, (_minutes, receipt) => { persistedReceipt = receipt; persisted(); return processDeath }, firstClient, () => null, () => 1_000, () => authority(1, 1), () => durableScope)
      void coordinator.startPolicyAuthorized({ gameId: 'roblox', processId: 'before-effect', processStartedAt: 2_000 }, 20)
      await statePersisted

      let recoveryEffects = 0
      const restarted = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      const recoveryClient = new PrivilegedBrokerClient((request) => restarted.invoke(request, 'before-effect-b'))
      const recovery = new RemoteStartCoordinator(null, () => true, (_minutes, receipt) => {
        if (persistedReceipt !== receipt) recoveryEffects += 1
        return true
      }, recoveryClient, () => null, () => 1_000, () => authority(1, 1), () => durableScope)
      await recovery.recoverCommittedTimerStarts()
      expect(recoveryEffects).toBe(0)
      let ordinaryResumeEffects = 0
      if (persistedReceipt) ordinaryResumeEffects += 1
      expect(ordinaryResumeEffects).toBe(1)
      await expect(recoveryClient.listRecoverableTimerStarts()).resolves.toEqual([])
      const later = new PrivilegedBrokerClient((request) => new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory).invoke(request, 'before-effect-c'))
      await expect(later.listRecoverableTimerStarts()).resolves.toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('persists materialization acknowledgement, excludes settled handoffs, and rejects conflicting acknowledgement reuse', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-materialized-ack-'))
    const durableScope = { householdId: 'policy', pcId: 'policy', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 2_000_000 }
    const handoff = {
      receipt: 'timer:policy:policy-ack-process-2000', minutes: 20,
      permission: { householdId: 'policy', requestId: 'policy-ack-process-2000', pcId: 'policy', gameId: 'roblox', allowanceVersion: 1, processId: 'ack-process', processStartedAt: 2_000 },
      authority: authority(1, 1), scope: durableScope,
    }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      const client = new PrivilegedBrokerClient((request) => service.invoke(request, 'ack-peer'))
      await client.commitTimerStart(handoff)
      await expect(client.listRecoverableTimerStarts()).resolves.toEqual([handoff])
      await expect(client.acknowledgeTimerMaterialized(handoff)).resolves.toBeUndefined()
      await expect(client.acknowledgeTimerMaterialized(handoff)).resolves.toBeUndefined()
      await expect(client.acknowledgeTimerMaterialized({ ...handoff, minutes: 19 })).rejects.toThrow('conflict')
      await expect(new PrivilegedBrokerClient((request) => new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory).invoke(request, 'restart-peer')).listRecoverableTimerStarts()).resolves.toEqual([])
      expect(readFileSync(join(directory, 'accounting.journal'), 'utf8').trim().split('\n').map(JSON.parse).map(({ operation }) => operation)).toEqual(['commit', 'materialized'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('leaves a handoff recoverable when materialized acknowledgement append fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-materialized-fail-'))
    const durableScope = { householdId: 'policy', pcId: 'policy', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2026-08-05', allowanceVersion: 1, totalMs: 2_000_000 }
    const handoff = {
      receipt: 'timer:policy:policy-ack-fail-2000', minutes: 20,
      permission: { householdId: 'policy', requestId: 'policy-ack-fail-2000', pcId: 'policy', gameId: 'roblox', allowanceVersion: 1, processId: 'ack-fail', processStartedAt: 2_000 },
      authority: authority(1, 1), scope: durableScope,
    }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true, undefined, (operation) => { if (operation === 'materialized') throw new Error('injected ack append failure') })
      const client = new PrivilegedBrokerClient((request) => service.invoke(request, 'ack-fail-peer'))
      await client.commitTimerStart(handoff)
      await expect(client.acknowledgeTimerMaterialized(handoff)).rejects.toThrow('injected ack append failure')
      await expect(client.listRecoverableTimerStarts()).resolves.toEqual([handoff])
      expect(readFileSync(join(directory, 'accounting.journal'), 'utf8').trim().split('\n')).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each([true, false])('recovers a durable started=%s outcome after client exit without double finalization', async (started) => {
    const directory = mkdtempSync(join(tmpdir(), `playtime-pact-outcome-${started}-`))
    const durableScope = { ...accountingScope, totalMs: 2_000_000 }
    try {
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      let outcomePersisted = false
      const interrupted = new PrivilegedBrokerClient(async (request) => {
        if (outcomePersisted) throw Object.assign(new Error('injected process exit'), { code: 'UNAVAILABLE' })
        const result = await first.invoke(request, 'peer-a')
        if (request.operation === 'outcome') outcomePersisted = true
        return result
      })
      const receipt = `timer:household-1:restart-outcome-${started}`
      if (started) await interrupted.authorizeTimerStart(receipt, 20, durableScope)

      await expect(interrupted.recordTimerOutcome(receipt, 20, started, durableScope, outcomeContext(`restart-outcome-${started}`))).rejects.toThrow('process exit')
      const journal = readFileSync(join(directory, 'accounting.journal'), 'utf8')
      expect(journal).toContain(`outcome-${started ? 'started' : 'not-started'}`)
      expect(journal).toContain(`\"requestId\":\"restart-outcome-${started}\"`)
      expect(journal).toContain('\"authorityGeneration\":1')

      new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      const once = PrivilegedApprovalService.loadAccounting(directory).scopes['household-1|pc-1|roblox|UTC|2026-08-05|1']
      expect(once).toMatchObject(started
        ? { committedMs: 1_200_000, reservedMs: 0, version: 3 }
        : { committedMs: 0, reservedMs: 0, version: 2 })

      new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      expect(PrivilegedApprovalService.loadAccounting(directory).scopes['household-1|pc-1|roblox|UTC|2026-08-05|1']).toEqual(once)
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
  it('retains an old-day unresolved committed handoff and its conservative high-water across real journal compaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-unresolved-compact-'))
    const oldScope = { householdId: 'old-household', pcId: 'old-pc', gameId: 'roblox', ianaTimeZone: 'UTC', ianaDay: '2025-01-01', allowanceVersion: 1, totalMs: 2_000_000 }
    const handoff = {
      receipt: 'timer:old-household:old-unresolved-request', minutes: 20,
      permission: { householdId: 'old-household', requestId: 'old-unresolved-request', pcId: 'old-pc', gameId: 'roblox', allowanceVersion: 1, processId: 'old-process', processStartedAt: 2_000 },
      authority: authority(1, 1), scope: oldScope,
    }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)
      const client = new PrivilegedBrokerClient((request) => service.invoke(request, 'compact-peer'))
      await client.commitTimerStart(handoff)
      for (let index = 0; index < 512; index++) {
        const scope = { householdId: 'settled-household', pcId: 'settled-pc', gameId: `game-${index}`, ianaTimeZone: 'UTC', ianaDay: '2025-02-01', allowanceVersion: 1, totalMs: 1 }
        const base = `settled-compaction-${index}`
        await service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `settled-r-${index}`.padEnd(16, 'r'), operation: 'reserve', payload: { scope, receipt: `${base}:reserve`, expectedVersion: 0, amountMs: 1 } }, 'compact-peer')
        await service.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `settled-t-${index}`.padEnd(16, 't'), operation: 'reconcile', payload: { scope, receipt: `${base}:reconcile-terminal`, expectedVersion: 1, terminal: true } }, 'compact-peer')
      }
      const compacted = readFileSync(join(directory, 'accounting.journal'), 'utf8').trim().split('\n').map(JSON.parse)
      expect(compacted[0].operation).toBe('checkpoint')
      expect(compacted.some(({ operation, receipt }) => operation === 'commit' && receipt === handoff.receipt)).toBe(true)

      const restartedService = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      const restarted = new PrivilegedBrokerClient((request) => restartedService.invoke(request, 'compact-restart'))
      await expect(restarted.listRecoverableTimerStarts()).resolves.toEqual([handoff])
      await expect(restarted.readAccounting(oldScope)).resolves.toEqual({ totalMs: 2_000_000, committedMs: 1_200_000, reservedMs: 0, version: 1 })
      await restarted.acknowledgeTimerMaterialized(handoff)
      await restarted.acknowledgeTimerMaterialized(handoff)
      await expect(restarted.listRecoverableTimerStarts()).resolves.toEqual([])
      const settledJournal = readFileSync(join(directory, 'accounting.journal'), 'utf8')
      expect(settledJournal.match(/\"operation\":\"commit\"/g)).toHaveLength(1)
      expect(settledJournal.match(/\"operation\":\"materialized\"/g)).toHaveLength(1)

      for (let index = 0; index < 510; index++) {
        const scope = { householdId: 'post-ack-household', pcId: 'post-ack-pc', gameId: `game-${index}`, ianaTimeZone: 'UTC', ianaDay: '2025-03-01', allowanceVersion: 1, totalMs: 1 }
        const base = `post-ack-compaction-${index}`
        await restartedService.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `post-r-${index}`.padEnd(16, 'r'), operation: 'reserve', payload: { scope, receipt: `${base}:reserve`, expectedVersion: 0, amountMs: 1 } }, 'compact-restart')
        await restartedService.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: `post-t-${index}`.padEnd(16, 't'), operation: 'reconcile', payload: { scope, receipt: `${base}:reconcile-terminal`, expectedVersion: 1, terminal: true } }, 'compact-restart')
      }
      const postAckActiveScope = { householdId: 'post-ack-active', pcId: 'post-ack-pc', gameId: 'active-game', ianaTimeZone: 'UTC', ianaDay: '2025-03-01', allowanceVersion: 1, totalMs: 1 }
      await restartedService.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: 'post-active-reserve', operation: 'reserve', payload: { scope: postAckActiveScope, receipt: 'post-ack-active-0001:reserve', expectedVersion: 0, amountMs: 1 } }, 'compact-restart')
      await restartedService.invoke({ capability: 'accounting', purpose: 'start-accounting', nonce: 'post-active-start', operation: 'start', payload: { scope: postAckActiveScope, receipt: 'post-ack-active-0001:start', expectedVersion: 1 } }, 'compact-restart')
      const finalService = new PrivilegedApprovalService(async () => ({}), async () => ({}), PrivilegedApprovalService.loadAccounting(directory), directory)
      const finalClient = new PrivilegedBrokerClient((request) => finalService.invoke(request, 'compact-final'))
      await expect(finalClient.listRecoverableTimerStarts()).resolves.toEqual([])
      await expect(finalClient.readAccounting(oldScope)).rejects.toThrow('rollback')
      expect(readFileSync(join(directory, 'accounting.journal'), 'utf8')).not.toContain(handoff.receipt)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
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
    const coordinator = new RemoteStartCoordinator(null, () => true, () => true, accounting, () => null, () => 1_000, () => authority(1, 1), scopeFor)
    await coordinator.issueLocalPreauthorization({
      permission: { householdId: 'local', requestId: 'request', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: 'candidate', processStartedAt: 1_000 },
      bindFirstProcess: true,
    }, 20)
    await expect(coordinator.consumeLocalPreauthorization({ gameId: 'roblox', processId: 'at-issue', processStartedAt: 1_000 })).resolves.toBe(false)
    await expect(coordinator.consumeLocalPreauthorization({ gameId: 'roblox', processId: 'after-issue', processStartedAt: 1_001 })).resolves.toBe(true)
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
    const coordinator = new RemoteStartCoordinator(api, () => true, () => true, accounting, () => 2_000, () => 2_000, () => authority(), scopeFor)
    const process = { gameId: 'roblox', processId: 'relaunch', processStartedAt: 2 }
    await expect(coordinator.consumeRemoteGrant(grant, process, authority())).resolves.toBe('indeterminate')
    await expect(coordinator.consumeRemoteGrant(grant, process, authority())).resolves.toBe('started')
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
  ;(process.platform === 'win32' ? it : it.skip).each(['non-string', 'empty-string'])('rejects a present %s policy selector instead of treating it as absent', (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-invalid-selector-'))
    try {
      writeInvalidTestPolicySelector(directory, kind)
      expect(() => new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory)).toThrow('registry value invalid')
    } finally {
      expect(removeTestPolicySelector(directory)).toBe(true)
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
      expect(removeTestPolicySelector(directory)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  ;(process.platform === 'win32' ? it : it.skip)('keeps the old immutable policy current when pointer publication is forced to fail', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-failure-'))
    const policy = { ianaTimeZone: 'UTC', weekdayLimit: 20, weekendLimit: 20, weekdaySessionCount: 2, weekendSessionCount: 2, allowedStartHour: 16, allowedEndHour: 22, requireApprovalBeforeStart: true }
    try {
      const first = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true)
      const verified = await first.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'failure-verify-01', operation: 'verify-pin', payload: { pin: '0000' } }, 'peer')
      await first.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'failure-policy-01', adminSession: verified.token, operation: 'set-local-policy', payload: { policy } }, 'peer')

      const failing = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true, () => { throw new Error('injected pointer failure') })
      const verifiedAgain = await failing.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'failure-verify-02', operation: 'verify-pin', payload: { pin: '0000' } }, 'peer')
      await expect(failing.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'failure-policy-02', adminSession: verifiedAgain.token, operation: 'set-local-policy', payload: { policy: { ...policy, weekdayLimit: 21 } } }, 'peer')).rejects.toThrow('injected pointer failure')
      expect(PrivilegedApprovalService.loadLocalPolicy(directory)).toMatchObject({ version: 1, weekdayLimit: 20 })
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      expect(removeTestPolicySelector(directory)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  ;(process.platform === 'win32' ? it : it.skip)('publishes 200 immutable policy versions through one atomic selector in a single run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-loop-'))
    const policy = { ianaTimeZone: 'UTC', weekdayLimit: 20, weekendLimit: 20, weekdaySessionCount: 2, weekendSessionCount: 2, allowedStartHour: 16, allowedEndHour: 22, requireApprovalBeforeStart: true }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true)
      const verified = await service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'loop-verify-0001', operation: 'verify-pin', payload: { pin: '0000' } }, 'peer')
      let current
      for (let index = 0; index < 200; index++) {
        current = await service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: `loop-policy-${index}`.padEnd(16, 'x'), adminSession: verified.token, operation: 'set-local-policy', payload: { policy: { ...policy, allowedEndHour: index % 2 ? 21 : 22 } } }, 'peer')
      }
      expect(PrivilegedApprovalService.loadLocalPolicy(directory)).toEqual(current)
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      expect(removeTestPolicySelector(directory)).toBe(true)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
  ;(process.platform === 'win32' ? it : it.skip)('publishes while the selected immutable payload is held open without delete sharing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-policy-replace-'))
    const policy = { ianaTimeZone: 'UTC', weekdayLimit: 20, weekendLimit: 20, weekdaySessionCount: 2, weekendSessionCount: 2, allowedStartHour: 16, allowedEndHour: 22, requireApprovalBeforeStart: true }
    try {
      const service = new PrivilegedApprovalService(async () => ({}), async () => ({}), { scopes: {} }, directory, () => 1_000, () => true)
      const verified = await service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'replace-verify-01', operation: 'verify-pin', payload: { pin: '0000' } }, 'peer')
      await service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'replace-policy-01', adminSession: verified.token, operation: 'set-local-policy', payload: { policy } }, 'peer')
      await expect(service.invoke({ capability: 'membership', purpose: 'membership-sync', nonce: 'replace-policy-02', adminSession: verified.token, operation: 'set-local-policy', payload: { policy: { ...policy, weekdayLimit: 21 } } }, 'peer')).resolves.toMatchObject({ version: 2, weekdayLimit: 21 })
      expect(PrivilegedApprovalService.loadLocalPolicy(directory)).toMatchObject({ version: 2, weekdayLimit: 21 })
      expect(readdirSync(directory).filter((name) => name.startsWith('local-policy.v'))).toHaveLength(2)
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      expect(removeTestPolicySelector(directory)).toBe(true)
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
  }, 30_000)
})
