import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair } from 'jose'

const builtModuleRoot = process.env.PLAYTIME_PACT_DESKTOP_MODULE_ROOT
const desktopModuleUrl = (name) => builtModuleRoot
  ? new URL(`${name}.js`, pathToFileURL(`${resolve(builtModuleRoot)}/`))
  : new URL(`../src/main/remoteApproval/${name}.ts`, import.meta.url)
const [
  { RemoteApprovalApiClient },
  { RemoteApprovalController },
  { WindowsCngRemoteApprovalBroker },
  { ServerClock },
  { RemoteStartCoordinator },
] = await Promise.all(['apiClient', 'controller', 'runtimeBroker', 'serverClock', 'startCoordinator'].map((name) => import(desktopModuleUrl(name))))
import { createAuthenticator } from '../remote-backend/src/authenticator.mjs'
import { createD1Authority, createWorker } from '../remote-backend/src/worker.mjs'
import { SqliteD1Database } from './helpers/sqliteD1.mjs'

const schemaUrl = new URL('../remote-backend/schema.sql', import.meta.url)
const nowMs = 1_700_001_000_000
const pairingTokenSecret = 'desktop-integration-pairing-secret-000000000000'
const membership = { householdId: 'desktop-household', pcId: 'desktop-pc', membershipEpoch: 1, serviceEpoch: 1 }
const gameId = 'roblox'
const day = new Date(nowMs).toISOString().slice(0, 10)
const openDatabases = new Set()

async function identity(actorId, keyName) {
  const keys = await generateKeyPair('ES256', { extractable: true })
  const publicJwk = await exportJWK(keys.publicKey)
  return {
    actorId,
    keyName,
    privateKey: keys.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
  }
}

function bounded(promise, label) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000) }),
  ]).finally(() => clearTimeout(timeout))
}

function nextControllerState(controller, predicate, label) {
  let unsubscribe = () => {}
  const signal = new Promise((resolve) => {
    unsubscribe = controller.subscribe((state) => {
      if (predicate(state)) resolve(state)
    })
  })
  return bounded(signal, label).finally(() => unsubscribe())
}

async function createHarness() {
  const db = new SqliteD1Database(schemaUrl)
  openDatabases.add(db)
  const admin = await identity('desktop-admin', 'desktop-admin-key')
  const operational = await identity(membership.pcId, 'desktop-operational-key')
  const phone = await identity('desktop-phone', 'unused-phone-key')
  db.sqlite.exec("UPDATE environments SET mode='REMOTE_ENABLED',create_permission=1,respond_or_issue_permission=1,consume_permission=1 WHERE id='global'")
  db.sqlite.prepare('INSERT INTO households(id,setup_token,remote_enabled,service_epoch,membership_epoch,create_permission,respond_or_issue_permission,consume_permission) VALUES(?,?,1,1,1,1,1,1)')
    .run(membership.householdId, 'desktop-setup')
  db.sqlite.prepare("INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) VALUES(?,?,?,'active',1,?)")
    .run(admin.actorId, membership.householdId, JSON.stringify(admin.publicJwk), nowMs)
  db.sqlite.prepare("INSERT INTO pcs(id,household_id,public_key,iana_time_zone,status,created_at_ms) VALUES(?,?,?,'UTC','active',?)")
    .run(membership.pcId, membership.householdId, JSON.stringify(operational.publicJwk), nowMs)
  db.sqlite.prepare("INSERT INTO pc_daily_allowances(household_id,pc_id,game_id,iana_day,iana_time_zone,total_seconds,committed_seconds,reserved_seconds,version,updated_at_ms) VALUES(?,?,?,?,'UTC',3600,0,0,1,?)")
    .run(membership.householdId, membership.pcId, gameId, day, nowMs)
  const authenticator = createAuthenticator(db, { now: () => nowMs })
  const worker = createWorker({ db, authenticator, now: () => nowMs, pairingTokenSecret })
  const workerEvents = []
  let backendAvailable = true
  let afterConsumeResponse = () => {}
  const request = async (url, init) => {
    if (!backendAvailable) throw Object.assign(new Error('injected backend outage'), { code: 'ECONNRESET' })
    const path = new URL(url).pathname
    workerEvents.push(`entered:${path}`)
    const response = await worker.fetch(new Request(url, init))
    workerEvents.push(`completed:${path}:${response.status}`)
    if (path === '/v1/consume') afterConsumeResponse()
    return response
  }
  const privateKeys = new Map([[admin.keyName, admin.privateKey], [operational.keyName, operational.privateKey]])
  const signer = async (keyName, signingInput) => {
    const key = privateKeys.get(keyName)
    if (!key) throw new Error(`Unknown injected key ${keyName}`)
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signingInput, 'ascii'))
    return Buffer.from(signature).toString('base64url')
  }
  let monotonicNow = 0
  const serverClock = new ServerClock(() => nowMs, () => monotonicNow)
  const config = {
    schemaVersion: 1,
    baseUrl: 'https://desktop-worker.test',
    mutableStateDir: 'C:\\desktop-integration-state',
    membership: { ...membership },
    operational: { actorId: operational.actorId, keyName: operational.keyName, publicJwk: operational.publicJwk },
    admin: { actorId: admin.actorId, keyName: admin.keyName, publicJwk: admin.publicJwk, recoveryParentId: admin.actorId, recoveryPublicJwk: admin.publicJwk },
  }
  const broker = new WindowsCngRemoteApprovalBroker(config, request, signer, () => nowMs, serverClock)
  const client = new RemoteApprovalApiClient(broker, 0)
  const controllerClock = new ServerClock(() => nowMs, () => monotonicNow)
  const controller = new RemoteApprovalController(client, 10_000, () => nowMs, undefined, controllerClock, null)
  controller.configureMembership(membership)
  let timerStarts = 0
  const accountingEvents = []
  const committedHandoffs = new Map()
  const materializedReceipts = new Set()
  const accounting = {
    async commitTimerStart(handoff) {
      const previous = committedHandoffs.get(handoff.receipt)
      if (previous && JSON.stringify(previous) !== JSON.stringify(handoff)) throw new Error('committed handoff receipt conflict')
      if (!previous) {
        const captured = structuredClone(handoff)
        committedHandoffs.set(handoff.receipt, captured)
        accountingEvents.push(`committed:${handoff.receipt}`)
      }
    },
    async listRecoverableTimerStarts() { return [...committedHandoffs.values()].filter((handoff) => !materializedReceipts.has(handoff.receipt)).map((handoff) => structuredClone(handoff)) },
    async acknowledgeTimerMaterialized(handoff) {
      const committed = committedHandoffs.get(handoff.receipt)
      if (!committed || JSON.stringify(committed) !== JSON.stringify(handoff)) throw new Error('materialized receipt conflict')
      materializedReceipts.add(handoff.receipt)
    },
  }
  const coordinator = new RemoteStartCoordinator(
    client,
    () => true,
    () => { timerStarts += 1; return true },
    accounting,
    () => controller.authoritativeNow(),
    () => nowMs,
    () => controller.getAuthoritySnapshot(),
    (permission) => ({ householdId: permission.householdId, pcId: permission.pcId, gameId: permission.gameId, ianaTimeZone: 'UTC', ianaDay: day, allowanceVersion: permission.allowanceVersion, totalMs: 3_600_000 }),
  )
  const authority = createD1Authority(db, { now: () => nowMs })
  return {
    admin, authority, broker, client, controller, coordinator, db, phone, worker, workerEvents, accountingEvents,
    get timerStarts() { return timerStarts },
    setBackendAvailable(value) { backendAvailable = value },
    setAfterConsumeResponse(callback) { afterConsumeResponse = callback },
    setMonotonicNow(value) { monotonicNow = value },
  }
}

async function synchronize(h) {
  const online = nextControllerState(h.controller, (state) => state.lifecycle === 'online', 'controller online')
  await h.controller.sync()
  await online
}

async function requestAndApprove(h, suffix) {
  await synchronize(h)
  const pending = nextControllerState(h.controller, (state) => state.lifecycle === 'request-pending', `${suffix} request pending`)
  const request = await h.controller.createRequest({ gameId, allowanceVersion: 1, processId: `desktop-process-${suffix}`, processStartedAt: 101 })
  await pending
  await h.authority.approve({ householdId: membership.householdId, actorId: h.admin.actorId, requestId: request.requestId, minutes: 5, operationKey: `approve-${suffix}` })
  const approved = nextControllerState(h.controller, (state) => state.lifecycle === 'approved', `${suffix} approved`)
  await h.controller.sync()
  return { request, state: await approved, authority: h.controller.getAuthoritySnapshot() }
}

function workerAccounting(h, requestId) {
  return {
    allowance: h.db.sqlite.prepare('SELECT committed_seconds,reserved_seconds FROM pc_daily_allowances').get(),
    reservation: h.db.sqlite.prepare('SELECT state FROM allowance_reservations WHERE request_id=?').get(requestId),
    grant: h.db.sqlite.prepare('SELECT state FROM approval_grants WHERE request_id=?').get(requestId),
    debits: h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM allowance_debits WHERE request_id=?').get(requestId).count,
  }
}

afterEach(() => {
  for (const db of openDatabases) db.close()
  openDatabases.clear()
})

describe('deployed desktop remote approval integration', () => {
  it('pairs, requests, approves and consumes through the shipped broker/client/controller/coordinator exactly once', async () => {
    const h = await createHarness()
    const online = nextControllerState(h.controller, (state) => state.lifecycle === 'online', 'controller online')
    await h.controller.sync()
    await online

    const pairing = await h.controller.createPairingSession()
    const paired = await h.worker.fetch(new Request('https://desktop-worker.test/v1/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pairing-token': new URL(pairing.uri).searchParams.get('token') },
      body: JSON.stringify({ householdId: membership.householdId, parentId: pairing.pairingSessionId, publicJwk: h.phone.publicJwk, token: new URL(pairing.uri).searchParams.get('token') }),
    }))
    expect(paired.status).toBe(200)

    const pending = nextControllerState(h.controller, (state) => state.lifecycle === 'request-pending', 'request pending')
    const request = await h.controller.createRequest({ gameId, allowanceVersion: 1, processId: 'desktop-process', processStartedAt: 101 })
    await pending
    await h.authority.approve({ householdId: membership.householdId, actorId: pairing.pairingSessionId, requestId: request.requestId, minutes: 5, operationKey: 'desktop-approve' })
    const approved = nextControllerState(h.controller, (state) => state.lifecycle === 'approved', 'request approved')
    await h.controller.sync()
    const approvedState = await approved

    const result = await h.coordinator.consumeRemoteGrant(approvedState.grant, { gameId, processId: request.processId, processStartedAt: request.processStartedAt }, h.controller.getAuthoritySnapshot())
    expect(result).toBe('started')
    expect(h.timerStarts).toBe(1)
    expect(h.accountingEvents).toEqual([`committed:timer:${membership.householdId}:${request.requestId}`])
    expect(h.db.sqlite.prepare('SELECT committed_seconds,reserved_seconds FROM pc_daily_allowances').get()).toEqual({ committed_seconds: 300, reserved_seconds: 0 })
    expect(h.db.sqlite.prepare('SELECT state FROM allowance_reservations WHERE request_id=?').get(request.requestId)).toEqual({ state: 'settled' })
    expect(h.db.sqlite.prepare('SELECT state FROM approval_grants WHERE request_id=?').get(request.requestId)).toEqual({ state: 'consumed' })
    expect(h.workerEvents.filter((event) => event.startsWith('entered:/v1/consume'))).toHaveLength(1)
    if (process.env.PLAYTIME_PACT_MANUAL_QA === '1') {
      console.log(`DESKTOP_QA ${JSON.stringify({ timerStarts: h.timerStarts, accounting: workerAccounting(h, request.requestId) })}`)
    }
  })

  it('fails closed before consume when server authority is stale and leaves the issued reservation untouched', async () => {
    const h = await createHarness()
    const flow = await requestAndApprove(h, 'stale-before')
    h.setMonotonicNow(30_000)

    const result = await h.coordinator.consumeRemoteGrant(flow.state.grant, { gameId, processId: flow.request.processId, processStartedAt: flow.request.processStartedAt }, flow.authority)

    expect(result).toBe('denied')
    expect(h.timerStarts).toBe(0)
    expect(h.workerEvents.filter((event) => event.startsWith('entered:/v1/consume'))).toHaveLength(0)
    expect(workerAccounting(h, flow.request.requestId)).toEqual({
      allowance: { committed_seconds: 0, reserved_seconds: 300 },
      reservation: { state: 'reserved' }, grant: { state: 'issued' }, debits: 0,
    })
  })

  it('fails closed after a committed consume when the server sample becomes stale and preserves Worker accounting', async () => {
    const h = await createHarness()
    const flow = await requestAndApprove(h, 'stale-after')
    h.setAfterConsumeResponse(() => h.setMonotonicNow(30_000))

    const result = await h.coordinator.consumeRemoteGrant(flow.state.grant, { gameId, processId: flow.request.processId, processStartedAt: flow.request.processStartedAt }, flow.authority)

    expect(result).toBe('denied')
    expect(h.timerStarts).toBe(0)
    expect(h.accountingEvents).toEqual([])
    expect(workerAccounting(h, flow.request.requestId)).toEqual({
      allowance: { committed_seconds: 300, reserved_seconds: 0 },
      reservation: { state: 'settled' }, grant: { state: 'consumed' }, debits: 1,
    })
  })

  it('observes a personal rejection without consuming or starting a timer', async () => {
    const h = await createHarness()
    await synchronize(h)
    const pending = nextControllerState(h.controller, (state) => state.lifecycle === 'request-pending', 'rejected request pending')
    const request = await h.controller.createRequest({ gameId, allowanceVersion: 1, processId: 'rejected-process', processStartedAt: 102 })
    await pending
    await h.authority.reject({ householdId: membership.householdId, actorId: h.admin.actorId, requestId: request.requestId })
    const stillPending = nextControllerState(h.controller, (state) => state.lifecycle === 'request-pending', 'personal rejection state')
    await h.controller.sync()
    await stillPending

    expect(h.timerStarts).toBe(0)
    expect(h.db.sqlite.prepare('SELECT decision FROM personal_responses WHERE request_id=?').get(request.requestId)).toEqual({ decision: 'reject' })
    expect(workerAccounting(h, request.requestId)).toEqual({
      allowance: { committed_seconds: 0, reserved_seconds: 0 },
      reservation: undefined, grant: undefined, debits: 0,
    })
  })

  it('returns an indeterminate result during an injected backend outage without changing Worker state', async () => {
    const h = await createHarness()
    const flow = await requestAndApprove(h, 'outage')
    h.setBackendAvailable(false)

    const result = await h.coordinator.consumeRemoteGrant(flow.state.grant, { gameId, processId: flow.request.processId, processStartedAt: flow.request.processStartedAt }, flow.authority)

    expect(result).toBe('indeterminate')
    expect(h.timerStarts).toBe(0)
    expect(workerAccounting(h, flow.request.requestId)).toEqual({
      allowance: { committed_seconds: 0, reserved_seconds: 300 },
      reservation: { state: 'reserved' }, grant: { state: 'issued' }, debits: 0,
    })
  })

  it('loses a generation-reset race after Worker commit without starting a timer', async () => {
    const h = await createHarness()
    const flow = await requestAndApprove(h, 'generation-race')
    h.setAfterConsumeResponse(() => h.controller.configureMembership({ ...membership, membershipEpoch: 2 }))

    const result = await h.coordinator.consumeRemoteGrant(flow.state.grant, { gameId, processId: flow.request.processId, processStartedAt: flow.request.processStartedAt }, flow.authority)

    expect(result).toBe('denied')
    expect(h.timerStarts).toBe(0)
    expect(h.controller.getAuthoritySnapshot().authorityGeneration).toBe(flow.authority.authorityGeneration + 1)
    expect(workerAccounting(h, flow.request.requestId)).toEqual({
      allowance: { committed_seconds: 300, reserved_seconds: 0 },
      reservation: { state: 'settled' }, grant: { state: 'consumed' }, debits: 1,
    })
  })

  it('rejects a malformed request tuple at the real Worker boundary without mutating accounting', async () => {
    const h = await createHarness()
    await synchronize(h)
    const malformed = h.controller.createRequest({ gameId, allowanceVersion: 0, processId: 'malformed-process', processStartedAt: 103 })

    await expect(malformed).rejects.toMatchObject({ code: 'failed' })
    expect(h.timerStarts).toBe(0)
    expect(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM approval_requests').get()).toEqual({ count: 0 })
    expect(h.db.sqlite.prepare('SELECT committed_seconds,reserved_seconds FROM pc_daily_allowances').get()).toEqual({ committed_seconds: 0, reserved_seconds: 0 })
  })
})
