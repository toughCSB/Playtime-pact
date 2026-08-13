import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RemoteApprovalClientError } from '../src/main/remoteApproval/apiClient'
import { RemoteApprovalController } from '../src/main/remoteApproval/controller'
import { WindowsCngRemoteApprovalBroker } from '../src/main/remoteApproval/runtimeBroker'
import { ServerClock } from '../src/main/remoteApproval/serverClock'
import { RemoteStartCoordinator } from '../src/main/remoteApproval/startCoordinator'

const membership = { householdId: 'household-1', pcId: 'pc-1', membershipEpoch: 3, serviceEpoch: 7 }
const authority = (authorityGeneration = 1, membershipEpoch = 3, serviceEpoch = 7) => Object.freeze({ membershipEpoch, serviceEpoch, authorityGeneration })
const permission = {
  householdId: 'household-1',
  requestId: 'request-1',
  pcId: 'pc-1',
  gameId: 'roblox',
  allowanceVersion: 1,
  processId: 'blocked-process',
  processStartedAt: 100,
}
const grant = {
  ...permission,
  grantId: 'grant-1',
  allowanceReservationId: 'reservation-1',
  membershipEpoch: 3,
  serviceEpoch: 7,
  approvedMinutes: 20,
  grantedAt: 1_000,
  expiresAt: 301_000,
  launchGame: false,
}
const processTuple = { gameId: 'roblox', processId: 'relaunched-process', processStartedAt: 200 }
const scope = {
  householdId: 'household-1',
  pcId: 'pc-1',
  gameId: 'roblox',
  ianaTimeZone: 'UTC',
  ianaDay: '2026-08-10',
  allowanceVersion: 1,
  totalMs: 1_200_000,
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function accountingRecorder() {
  const calls = { commits: [] }
  const committed = new Map()
  const materialized = new Set()
  return {
    calls,
    accounting: {
      async commitTimerStart(handoff) {
        const previous = committed.get(handoff.receipt)
        if (previous && JSON.stringify(previous) !== JSON.stringify(handoff)) throw new Error('receipt conflict')
        if (!previous) {
          const captured = structuredClone(handoff)
          committed.set(handoff.receipt, captured)
          calls.commits.push(captured)
        }
      },
      async listRecoverableTimerStarts() { return [...committed.values()].filter((handoff) => !materialized.has(handoff.receipt)).map((handoff) => structuredClone(handoff)) },
      async acknowledgeTimerMaterialized(handoff) {
        const committedHandoff = committed.get(handoff.receipt)
        if (!committedHandoff || JSON.stringify(committedHandoff) !== JSON.stringify(handoff)) throw new Error('materialized receipt conflict')
        materialized.add(handoff.receipt)
      },
    },
  }
}

function coordinatorHarness(overrides = {}) {
  let remoteNow = overrides.remoteNow === undefined ? 2_000 : overrides.remoteNow
  let monotonicNow = overrides.monotonicNow ?? 10_000
  let currentAuthority = overrides.currentAuthority ?? authority()
  let timerStarts = 0
  const recorder = overrides.recorder ?? accountingRecorder()
  const api = overrides.api ?? { async consumeGrant({ grant: claimedGrant }) { return claimedGrant } }
  const coordinator = new RemoteStartCoordinator(
    api,
    overrides.finalRecheck ?? (() => true),
    overrides.startTimer ?? (() => { timerStarts += 1; return true }),
    recorder.accounting,
    () => remoteNow,
    () => monotonicNow,
    () => currentAuthority,
    overrides.scopeFor ?? (() => scope),
  )
  return {
    coordinator,
    recorder,
    get timerStarts() { return timerStarts },
    setRemoteNow(value) { remoteNow = value },
    setMonotonicNow(value) { monotonicNow = value },
    setAuthority(value) { currentAuthority = value },
  }
}

describe('Wave 1 server clock authority', () => {
  it('uses monotonic sample age with an exclusive 30-second freshness boundary and recovers after expiry', () => {
    let wallNow = 1_000_000
    let monotonicNow = 500
    const clock = new ServerClock(() => wallNow, () => monotonicNow)

    clock.accept(1_000_100)
    wallNow -= 60_000
    monotonicNow += 29_999
    expect(clock.authoritativeNow()).toBe(1_030_099)

    monotonicNow += 1
    expect(clock.authoritativeNow()).toBeNull()

    wallNow = 1_030_000
    clock.accept(1_030_100)
    expect(clock.authoritativeNow()).toBe(1_030_100)
  })

  it('invalidates immediately on rollback, invalid samples, monotonic rollback, and explicit sync failure', () => {
    let monotonicNow = 10
    const clock = new ServerClock(() => 1_000, () => monotonicNow)

    clock.accept(1_100)
    expect(() => clock.accept(1_099)).toThrow()
    expect(clock.authoritativeNow()).toBeNull()

    clock.accept(1_101)
    expect(() => clock.accept(Number.NaN)).toThrow()
    expect(clock.authoritativeNow()).toBeNull()

    clock.accept(1_102)
    monotonicNow = 9
    expect(clock.authoritativeNow()).toBeNull()

    monotonicNow = 20
    clock.accept(1_120)
    clock.invalidate()
    expect(clock.authoritativeNow()).toBeNull()
  })

  it('makes the CNG broker use the shared clock and invalidate it when a required synchronization fails', async () => {
    let wallNow = 1_000
    let monotonicNow = 0
    let serverNowMs = 1_000
    const clock = new ServerClock(() => wallNow, () => monotonicNow)
    const broker = new WindowsCngRemoteApprovalBroker(
      {
        schemaVersion: 1,
        baseUrl: 'https://approval.example',
        membership,
        operational: { actorId: 'pc-1', keyName: 'operational-key', publicJwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) } },
        admin: { actorId: 'parent', keyName: 'admin-key', publicJwk: { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }, recoveryParentId: 'parent', recoveryPublicJwk: { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) } },
      },
      async () => new Response(JSON.stringify({ serverNowMs, health: {} }), { status: 200 }),
      async () => 'S'.repeat(86),
      () => wallNow,
      clock,
    )

    await broker.invoke({ operation: 'read-status', payload: {}, idempotencyKey: 'status:1' })
    monotonicNow = 29_999
    expect(broker.authoritativeNow()).toBe(30_999)

    serverNowMs = Number.NaN
    await expect(broker.invoke({ operation: 'read-status', payload: {}, idempotencyKey: 'status:2' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(clock.authoritativeNow()).toBeNull()
  })
})

describe('Wave 1 controller authority snapshots', () => {
  it('allows PIN fallback only for positively classified connectivity failures', async () => {
    const permissionDenied = new RemoteApprovalController({
      readStatus: async () => { throw new RemoteApprovalClientError('permission-denied') },
    }, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => 0))
    permissionDenied.configureMembership(membership)

    await permissionDenied.sync()

    expect(permissionDenied.getState().lifecycle).toBe('error')
    expect(permissionDenied.allowsLocalFallback()).toBe(false)

    const offline = new RemoteApprovalController({
      readStatus: async () => { throw new RemoteApprovalClientError('offline') },
    }, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => 0))
    offline.configureMembership(membership)

    await offline.sync()

    expect(offline.getState().lifecycle).toBe('offline')
    expect(offline.allowsLocalFallback()).toBe(true)
  })

  it('returns immutable snapshots, changes generation only for authority replacement, and ignores an old deferred sync response', async () => {
    let wallNow = 1_000
    let monotonicNow = 0
    const staleStatus = deferred()
    const syncEntered = deferred()
    let reads = 0
    const client = {
      readStatus() {
        reads += 1
        if (reads === 1) return Promise.resolve({ serverNowMs: 1_000, health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1_000 } })
        syncEntered.resolve()
        return staleStatus.promise
      },
    }
    const controller = new RemoteApprovalController(client, 10_000, () => wallNow, undefined, new ServerClock(() => wallNow, () => monotonicNow))

    controller.configureMembership(membership)
    const first = controller.getAuthoritySnapshot()
    expect(Object.isFrozen(first)).toBe(true)
    await controller.sync()
    expect(controller.getAuthoritySnapshot()).toEqual(first)

    const staleSync = controller.sync()
    await syncEntered.promise
    controller.configureMembership({ ...membership, membershipEpoch: 4 })
    const replacement = controller.getAuthoritySnapshot()
    expect(replacement).toEqual({ membershipEpoch: 4, serviceEpoch: 7, authorityGeneration: first.authorityGeneration + 1 })

    staleStatus.resolve({
      serverNowMs: 1_001,
      grant,
      health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1_001 },
    })
    await staleSync
    expect(controller.getState()).toMatchObject({ membershipEpoch: 4, serviceEpoch: 7 })
    expect(controller.getState().grant).toBeUndefined()
    expect(controller.authoritativeNow()).toBeNull()
  })

  it('increments authority generation exactly once before a deferred reset installs its replacement epochs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-wave1-reset-'))
    const configPath = join(directory, 'remote.json')
    const previousConfig = process.env.PLAYTIME_PACT_REMOTE_CONFIG
    const resetEntered = deferred()
    const resetResponse = deferred()
    const client = {
      readStatus: async () => ({ serverNowMs: 1_000, health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1_000 } }),
      resetMembership: async () => { resetEntered.resolve(); return resetResponse.promise },
      reconcileReset: async () => { throw new Error('unexpected reconcile') },
      persistMembership() {},
    }

    try {
      process.env.PLAYTIME_PACT_REMOTE_CONFIG = configPath
      const controller = new RemoteApprovalController(client, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => 0))
      if (previousConfig === undefined) delete process.env.PLAYTIME_PACT_REMOTE_CONFIG
      else process.env.PLAYTIME_PACT_REMOTE_CONFIG = previousConfig
      controller.configureMembership(membership)
      await controller.sync()
      const before = controller.getAuthoritySnapshot()

      const resetting = controller.resetMembership()
      await resetEntered.promise
      expect(controller.getAuthoritySnapshot()).toEqual({ ...before, authorityGeneration: before.authorityGeneration + 1 })

      resetResponse.resolve({ membershipEpoch: 4, serviceEpoch: 7 })
      await resetting
      expect(controller.getAuthoritySnapshot()).toEqual({ membershipEpoch: 4, serviceEpoch: 7, authorityGeneration: before.authorityGeneration + 1 })
    } finally {
      if (previousConfig === undefined) delete process.env.PLAYTIME_PACT_REMOTE_CONFIG
      else process.env.PLAYTIME_PACT_REMOTE_CONFIG = previousConfig
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('Wave 1 fail-closed remote and memory-only local authority', () => {
  it('rejects remote request creation before the API call when the server sample is stale', async () => {
    let monotonicNow = 0
    let createCalls = 0
    const client = {
      readStatus: async () => ({ serverNowMs: 1_000, health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1_000 } }),
      createRequest: async (request) => { createCalls += 1; return request },
    }
    const controller = new RemoteApprovalController(client, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => monotonicNow))
    controller.configureMembership(membership)
    await controller.sync()

    monotonicNow = 30_000
    await expect(controller.createRequest({ gameId: 'roblox', allowanceVersion: 1, processId: 'process', processStartedAt: 100 })).rejects.toMatchObject({ code: 'offline' })
    expect(createCalls).toBe(0)
    expect(controller.getState().lifecycle).toBe('offline')
  })

  it('does not call the remote consume API without fresh authority, while a PIN-issued local grant uses only monotonic expiry', async () => {
    let apiCalls = 0
    const harness = coordinatorHarness({
      remoteNow: null,
      api: { async consumeGrant() { apiCalls += 1; return grant } },
    })

    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, authority())).resolves.toBe('denied')
    expect(apiCalls).toBe(0)
    await expect(harness.coordinator.consumeLocalPreauthorization(processTuple, 20)).resolves.toBe(false)

    const local = await harness.coordinator.issueLocalPreauthorization({
      permission: { ...permission, requestId: 'local-pin-1', processId: 'first-fresh-process', processStartedAt: 100 },
      bindFirstProcess: true,
    }, 20)
    expect(local).toMatchObject({ state: 'armed', issuedAt: 10_000, expiresAt: 310_000, membershipEpoch: 3, serviceEpoch: 7, authorityGeneration: 1 })

    harness.setMonotonicNow(309_999)
    await expect(harness.coordinator.consumeLocalPreauthorization(processTuple, 20)).resolves.toBe(true)
    expect(harness.timerStarts).toBe(1)
    expect(harness.recorder.calls.commits).toEqual([expect.objectContaining({
      receipt: 'timer:household-1:local-pin-1', minutes: 20, scope,
      permission: expect.objectContaining({ processId: processTuple.processId, processStartedAt: processTuple.processStartedAt }),
    })])
    expect(apiCalls).toBe(0)
  })

  it('expires an armed local grant at exactly its monotonic boundary without synthesizing an outcome', async () => {
    const harness = coordinatorHarness()
    await harness.coordinator.issueLocalPreauthorization({
      permission: { ...permission, requestId: 'local-expiry', processId: 'first-fresh-process', processStartedAt: 100 },
      bindFirstProcess: true,
    }, 20)

    harness.setMonotonicNow(310_000)
    await expect(harness.coordinator.consumeLocalPreauthorization(processTuple, 20)).resolves.toBe(false)
    expect(harness.recorder.calls.commits).toHaveLength(0)
  })
  it('carries protected policy revision 2 through a positively classified offline PIN start', async () => {
    const offline = new RemoteApprovalController({
      readStatus: async () => { throw new RemoteApprovalClientError('offline') },
    }, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => 0))
    offline.configureMembership(membership)
    await offline.sync()
    expect(offline.allowsLocalFallback()).toBe(true)

    const protectedPolicy = { version: 2 }
    const stableLocalScope = { ...scope, householdId: 'local-outage', allowanceVersion: 1 }
    const harness = coordinatorHarness({ scopeFor: (captured) => ({ ...stableLocalScope, pcId: captured.pcId, gameId: captured.gameId }) })
    await harness.coordinator.issueLocalPreauthorization({
      permission: { ...permission, householdId: 'local-outage', requestId: `local-policy-v${protectedPolicy.version}`, allowanceVersion: 1, processId: 'first-fresh-process', processStartedAt: 100 },
      bindFirstProcess: true,
    }, 20)

    await expect(harness.coordinator.consumeLocalPreauthorization(processTuple)).resolves.toBe(true)
    expect(harness.recorder.calls.commits).toEqual([expect.objectContaining({
      receipt: 'timer:local-outage:local-policy-v2', minutes: 20, scope: stableLocalScope,
    })])
    expect(harness.recorder.calls.commits[0].scope.allowanceVersion).toBe(1)
  })
})

describe('Wave 1 local preauthorization reset races', () => {
  it('drops an armed grant on authority invalidation without an outcome', async () => {
    const harness = coordinatorHarness()
    await harness.coordinator.issueLocalPreauthorization({
      permission: { ...permission, requestId: 'local-armed-reset', processId: 'first-fresh-process', processStartedAt: 100 },
      bindFirstProcess: true,
    }, 20)

    harness.setAuthority(authority(2, 4, 7))
    await harness.coordinator.invalidateLocalPreauthorization('membership-reset')
    await expect(harness.coordinator.consumeLocalPreauthorization(processTuple, 20)).resolves.toBe(false)
    expect(harness.recorder.calls.commits).toHaveLength(0)
    expect(harness.timerStarts).toBe(0)
  })

  it('does not commit a handoff when reset occurs after claim but before finalize', async () => {
    const finalRecheckEntered = deferred()
    const releaseFinalRecheck = deferred()
    const harness = coordinatorHarness({
      finalRecheck: async () => {
        finalRecheckEntered.resolve()
        return releaseFinalRecheck.promise
      },
    })
    await harness.coordinator.issueLocalPreauthorization({
      permission: { ...permission, requestId: 'local-claimed-reset', processId: 'first-fresh-process', processStartedAt: 100 },
      bindFirstProcess: true,
    }, 20)

    const consuming = harness.coordinator.consumeLocalPreauthorization(processTuple, 20)
    await finalRecheckEntered.promise
    harness.setAuthority(authority(2, 4, 7))
    const invalidating = harness.coordinator.invalidateLocalPreauthorization('membership-reset')
    releaseFinalRecheck.resolve(true)

    await expect(consuming).resolves.toBe(false)
    await invalidating
    expect(harness.recorder.calls.commits).toHaveLength(0)
    expect(harness.timerStarts).toBe(0)
  })
})

describe('Wave 1 post-await remote grant revalidation', () => {
  it.each([true, false])('retries a failed durable commit before materialization without consuming or starting twice (materialized=%s)', async (started) => {
    let consumes = 0
    let timerStarts = 0
    let commitAttempts = 0
    const recorder = accountingRecorder()
    const durableCommit = recorder.accounting.commitTimerStart
    recorder.accounting.commitTimerStart = async (handoff) => {
      commitAttempts += 1
      if (commitAttempts === 1) throw new Error('accounting pipe unavailable')
      await durableCommit(handoff)
    }
    const harness = coordinatorHarness({
      recorder,
      api: {
        async consumeGrant({ grant: claimedGrant }) {
          consumes += 1
          return claimedGrant
        },
      },
      startTimer: () => {
        timerStarts += 1
        return started
      },
    })
    const capturedAuthority = authority()

    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)).resolves.toBe('denied')
    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)).resolves.toBe(started ? 'started' : 'denied')

    expect(commitAttempts).toBe(2)
    expect(recorder.calls.commits).toHaveLength(1)
    expect(consumes).toBe(1)
    expect(timerStarts).toBe(1)
  })

  it('records one non-start outcome and never retries consumption when authority changes during the API consume', async () => {
    const consumeEntered = deferred()
    const consumeResponse = deferred()
    let consumes = 0
    const harness = coordinatorHarness({
      api: {
        consumeGrant() {
          consumes += 1
          consumeEntered.resolve()
          return consumeResponse.promise
        },
      },
    })
    const capturedAuthority = authority()

    const consuming = harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)
    await consumeEntered.promise
    harness.setAuthority(authority(2, 4, 7))
    consumeResponse.resolve({ ...grant, processId: processTuple.processId, processStartedAt: processTuple.processStartedAt })

    await expect(consuming).resolves.toBe('denied')
    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)).resolves.toBe('denied')
    expect(consumes).toBe(1)
    expect(harness.recorder.calls.commits).toHaveLength(0)
    expect(harness.timerStarts).toBe(0)
  })

  it('revalidates fresh server authority after consume and fails closed if the sample was invalidated', async () => {
    const consumeEntered = deferred()
    const consumeResponse = deferred()
    const harness = coordinatorHarness({
      api: {
        consumeGrant() {
          consumeEntered.resolve()
          return consumeResponse.promise
        },
      },
    })

    const consuming = harness.coordinator.consumeRemoteGrant(grant, processTuple, authority())
    await consumeEntered.promise
    harness.setRemoteNow(null)
    consumeResponse.resolve({ ...grant, processId: processTuple.processId, processStartedAt: processTuple.processStartedAt })

    await expect(consuming).resolves.toBe('denied')
    expect(harness.recorder.calls.commits).toHaveLength(0)
    expect(harness.timerStarts).toBe(0)
  })

  it('retries a confirmed-not-started grant without a second consume only under the same authority snapshot', async () => {
    let consumes = 0
    let finalChecks = 0
    const harness = coordinatorHarness({
      api: {
        async consumeGrant({ grant: claimedGrant }) {
          consumes += 1
          return claimedGrant
        },
      },
      finalRecheck: () => {
        finalChecks += 1
        return finalChecks > 1
      },
    })
    const capturedAuthority = authority()

    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)).resolves.toBe('denied')
    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, capturedAuthority)).resolves.toBe('started')
    expect(consumes).toBe(1)
    expect(harness.recorder.calls.commits).toEqual([expect.objectContaining({
      receipt: 'timer:household-1:request-1', minutes: 20, scope,
    })])
    expect(harness.timerStarts).toBe(1)
  })

  it('fails closed on a mismatched receipt tuple and preserves the originally captured accounting scope', async () => {
    const originalScope = { ...scope }
    let scopeReads = 0
    const harness = coordinatorHarness({
      api: {
        async consumeGrant({ grant: claimedGrant }) {
          return { ...claimedGrant, gameId: 'minecraft' }
        },
      },
      scopeFor: () => {
        scopeReads += 1
        return originalScope
      },
    })

    await expect(harness.coordinator.consumeRemoteGrant(grant, processTuple, authority())).resolves.toBe('denied')
    expect(scopeReads).toBe(1)
    expect(harness.recorder.calls.commits).toHaveLength(0)
    expect(harness.timerStarts).toBe(0)
  })
})
