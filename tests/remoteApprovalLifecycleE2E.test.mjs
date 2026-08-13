import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { exportJWK, FlattenedSign, generateKeyPair } from 'jose'

import { migrateEnvironment } from '../remote-backend/scripts/migrate.mjs'
import { renderConfig } from '../remote-backend/scripts/renderConfig.mjs'
import { createWranglerLocalHarness } from './helpers/wranglerLocal.mjs'

const lifecycleWorkerEntry = fileURLToPath(new URL('./helpers/remoteLifecycleWorker.mjs', import.meta.url))

const encoder = new TextEncoder()
const permissions = { create: true, respond_or_issue: true, consume: true }
const pairingSecret = 'local-e2e-pairing-token-material-000000000000'
const tokenEncryptionKey = createHash('sha256').update('local-e2e-fcm-token-key').digest('base64')

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`
const rowsFrom = (stdout) => {
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? []
}

async function identity() {
  const keys = await generateKeyPair('ES256', { extractable: true })
  const exported = await exportJWK(keys.publicKey)
  return {
    privateKey: keys.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
  }
}

async function signedRequest({ baseUrl, path, method = 'POST', body, signer, actorId, membershipEpoch, serviceEpoch, idempotencyKey = `e2e-${randomUUID()}`, jti = `jti-${randomUUID()}`, nonce = `nonce-${randomUUID()}` }) {
  const url = new URL(path, `${baseUrl}/`)
  const raw = method === 'GET' ? '' : JSON.stringify(body)
  const claims = {
    actorId,
    clientVersionCode: 1,
    contentDigest: `sha-256=:${createHash('sha256').update(raw).digest('base64')}:`,
    htm: method,
    htu: url.toString(),
    iat: Math.floor(Number(signer.now) / 1_000),
    idempotencyKey,
    jti,
    membershipEpoch,
    nonce,
    serviceEpoch,
  }
  const token = await new FlattenedSign(encoder.encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: signer.publicJwk })
    .sign(signer.privateKey)
  return {
    request: new Request(url, {
      method,
      headers: { authorization: `Bearer ${JSON.stringify(token)}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : raw,
    }),
    replay: { path, method, body, signer, actorId, membershipEpoch, serviceEpoch, idempotencyKey, jti, nonce },
  }
}

async function responseRecord(response) {
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text), headers: response.headers }
}

const forbiddenFetchPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

async function availableWorkerPort(createPortServer = createServer) {
  const server = createPortServer()
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await boundedSignal(listening, 'worker port reservation')
  const address = server.address()
  assert.notEqual(typeof address, 'string')
  const closed = once(server, 'close')
  server.close()
  await boundedSignal(closed, 'worker port reservation close')
  if (forbiddenFetchPorts.has(address.port)) {
    throw Object.assign(new Error(`OS-assigned Worker port ${address.port} is forbidden by fetch`), { code: 'WORKER_PORT_FORBIDDEN' })
  }
  return address.port
}

function assignedPortServer(port) {
  return () => {
    const server = new EventEmitter()
    server.listen = () => queueMicrotask(() => server.emit('listening'))
    server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port })
    server.close = () => queueMicrotask(() => server.emit('close'))
    return server
  }
}

test('OS-assigned forbidden Worker ports fail preflight before Wrangler launch', async () => {
  let wranglerLaunched = false
  const launch = async () => {
    const workerPort = await availableWorkerPort(assignedPortServer(1719))
    wranglerLaunched = true
    return workerPort
  }

  await assert.rejects(launch, (error) => {
    assert.equal(error.code, 'WORKER_PORT_FORBIDDEN')
    assert.equal(error.message, 'OS-assigned Worker port 1719 is forbidden by fetch')
    return true
  })
  assert.equal(wranglerLaunched, false)
})

test('an allowed OS-assigned Worker port passes through after reservation close', async () => {
  assert.equal(await availableWorkerPort(assignedPortServer(43210)), 43210)
})

async function createLifecycle(name, now = 1_700_000_000_000, { providerFailure = false } = {}) {
  assert.equal(existsSync(lifecycleWorkerEntry), true, 'test Worker entry must exist')
  const nodeDirectory = dirname(process.execPath)
  const inheritedPath = process.env.Path ?? process.env.PATH ?? ''
  const wrangler = createWranglerLocalHarness(`playtime-pact-lifecycle-${name}-`, {
    processEnv: { ...process.env, Path: `${nodeDirectory};${inheritedPath}`, PATH: `${nodeDirectory};${inheritedPath}` },
  })
  const inputsPath = resolve(wrangler.root, 'inputs.json')
  const configPath = resolve(wrangler.root, 'wrangler.toml')
  const statePath = wrangler.statePath(name)
  const databaseName = `lifecycle-${name}`
  const inputs = {
    staging: {
      workerName: `lifecycle-${name}`,
      workerBaseUrl: 'https://local.invalid',
      d1DatabaseName: databaseName,
      d1DatabaseId: '77777777-7777-4777-8777-777777777777',
      firebaseProjectId: 'local-e2e',
      firebaseClientEmail: 'local-e2e@example.invalid',
      setupAuthorityActorId: 'setup-local',
      operatorAuthorityActorId: 'operator-local',
    },
  }
  writeFileSync(inputsPath, JSON.stringify(inputs), 'utf8')
  renderConfig({ env: 'staging', inputsPath, outputPath: configPath })
  let config = readFileSync(configPath, 'utf8')
    .replace('main = "../src/worker.mjs"', `main = "${lifecycleWorkerEntry.replace(/\\/g, '/')}"`)
    .replace('[vars]', `[vars]\nTEST_NOW_MS = "${now}"\nTEST_PROVIDER_FAILURE = "${providerFailure ? 'true' : 'false'}"`)
  writeFileSync(configPath, config, 'utf8')
  writeFileSync(resolve(wrangler.root, '.dev.vars'), [
    `PAIRING_TOKEN_SECRET=${JSON.stringify(pairingSecret)}`,
    `FCM_TOKEN_ENCRYPTION_KEY=${JSON.stringify(tokenEncryptionKey)}`,
  ].join('\n'), 'utf8')
  try {
    await migrateEnvironment({ env: 'staging', inputsPath, configPath, local: true, persistTo: statePath, mode: 'fresh', runner: (argv) => wrangler.run(argv) })
  } catch (error) {
    await wrangler.cleanup()
    throw error
  }
  const execute = (tail) => wrangler.run(['d1', 'execute', databaseName, '--config', configPath, '--local', '--persist-to', statePath, ...tail])
  let server
  let baseUrl
  const start = async () => {
    const workerPort = await availableWorkerPort()
    server = wrangler.startWorker([
      'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', '0',
      '--persist-to', statePath, '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'info',
    ])
    baseUrl = await server.readiness
    return baseUrl
  }
  const stop = async () => {
    if (!server) return
    await server.stop()
    server = undefined
  }
  const setNow = async (value) => {
    const response = await fetch(`${baseUrl}/__test/clock`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nowMs: value }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.nowMs, value)
    now = value
    return baseUrl
  }
  const query = async (sql) => rowsFrom((await execute(['--json', '--command', sql])).stdout).map((row) => ({ ...row }))
  const waitForWorkerOutput = (marker) => {
    if (!server) throw new Error('Worker is not running')
    return server.waitForOutput(marker)
  }
  const bootstrap = async () => {
    const setup = await identity()
    const admin = await identity()
    const pc = await identity()
    setup.now = admin.now = pc.now = now
    await execute(['--command', `INSERT INTO setup_authorities(id,public_jwk,status,created_at_ms) VALUES('setup-local',${sqlLiteral(JSON.stringify(setup.publicJwk))},'active',${now}); UPDATE environments SET mode='REMOTE_ENABLED',create_permission=1,respond_or_issue_permission=1,consume_permission=1 WHERE id='global';`, '--yes'])
    await start()
    const setupEnvelope = await signedRequest({ baseUrl, path: '/v1/households/setup', body: { householdId: `household-${name}`, initialParentId: `admin-${name}`, publicJwk: JSON.stringify(admin.publicJwk), permissions }, signer: setup, actorId: 'setup-local', membershipEpoch: 0, serviceEpoch: 1, idempotencyKey: `setup-${name}` })
    const setupResponse = await responseRecord(await fetch(setupEnvelope.request))
    assert.equal(setupResponse.status, 200, setupResponse.text)
    const pcEnvelope = await signedRequest({ baseUrl, path: '/v1/pcs', body: { householdId: `household-${name}`, pcId: `pc-${name}`, publicKey: JSON.stringify(pc.publicJwk), ianaTimeZone: 'UTC' }, signer: admin, actorId: `admin-${name}`, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: `register-${name}` })
    const pcResponse = await responseRecord(await fetch(pcEnvelope.request))
    assert.equal(pcResponse.status, 200, pcResponse.text)
    return { setup, admin, pc, householdId: `household-${name}`, adminId: `admin-${name}`, pcId: `pc-${name}` }
  }
  const cleanup = async () => { await stop(); await wrangler.cleanup() }
  return { bootstrap, cleanup, execute, get baseUrl() { return baseUrl }, get now() { return now }, query, setNow, start, stop, waitForWorkerOutput }
}

async function call(harness, input) {
  input.signer.now = harness.now
  const envelope = await signedRequest({ baseUrl: harness.baseUrl, ...input })
  return { envelope, response: await responseRecord(await fetch(envelope.request)) }
}

async function replay(harness, envelope) {
  envelope.replay.signer.now = harness.now
  const repeated = await signedRequest({ baseUrl: harness.baseUrl, ...envelope.replay })
  return responseRecord(await fetch(repeated.request))
}

async function boundedSignal(promise, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function subscribeConsumeBarrier(harness) {
  let releaseResponse
  let resolveReached
  const reachedRequest = new Promise((resolveReachedRequest) => { resolveReached = resolveReachedRequest })
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/' || releaseResponse) {
      response.writeHead(409).end()
      return
    }
    releaseResponse = response
    resolveReached()
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await boundedSignal(listening, 'consume barrier server')
  const address = server.address()
  assert.notEqual(typeof address, 'string')
  const reachedOutput = harness.waitForWorkerOutput('PLAYTIME_PACT_TEST_CONSUME_PRE_COMMIT_REACHED')
  const armed = await responseRecord(await fetch(`${harness.baseUrl}/__test/consume-barrier`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/` }),
  }))
  assert.equal(armed.status, 200, armed.text)
  assert.deepEqual(armed.body, { state: 'armed' })
  return {
    async reached() {
      assert.equal(await boundedSignal(reachedOutput, 'consume pre-commit barrier output'), 'PLAYTIME_PACT_TEST_CONSUME_PRE_COMMIT_REACHED')
      await boundedSignal(reachedRequest, 'consume pre-commit barrier request')
    },
    async release() {
      const closed = once(server, 'close')
      if (releaseResponse) releaseResponse.writeHead(204).end()
      server.close()
      await boundedSignal(closed, 'consume barrier server close')
    },
  }
}

async function allowance(h, actors, gameId = 'game', key = `allowance-${randomUUID()}`) {
  const result = await call(h, { path: '/v1/allowances', body: { householdId: actors.householdId, pcId: actors.pcId, gameId, expectedVersion: 0, totalSeconds: 3_600 }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: key })
  assert.equal(result.response.status, 200, result.response.text)
  return result.response.body.allowance
}

async function requestAndApprove(h, actors, requestId, { gameId = 'game', minutes = 5 } = {}) {
  const tuple = { householdId: actors.householdId, requestId, pcId: actors.pcId, gameId, allowanceVersion: 1, ianaTimeZone: 'UTC', ianaDay: new Date(h.now).toISOString().slice(0, 10), processId: `process-${requestId}`, processStartedAt: 101 }
  const created = await call(h, { path: '/v1/requests', body: tuple, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: `request-${requestId}` })
  assert.equal(created.response.status, 200, created.response.text)
  const approved = await call(h, { path: '/v1/approve', body: { householdId: actors.householdId, requestId, minutes }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: `approve-${requestId}` })
  assert.equal(approved.response.status, 200, approved.response.text)
  return { tuple, created, approved }
}

test('real local Worker/D1 completes pair -> allowance -> request -> reject/approve -> consume -> accounting with byte-identical replay', { timeout: 180_000 }, async () => {
  const h = await createLifecycle('happy')
  try {
    const actors = await h.bootstrap()
    const phone = await identity()
    phone.now = h.now
    const issued = await call(h, { path: '/v1/pairing-sessions', body: { householdId: actors.householdId, pcId: actors.pcId }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'pair-happy' })
    assert.equal(issued.response.status, 200, issued.response.text)
    const pairingReplay = await replay(h, issued.envelope)
    assert.equal(pairingReplay.text, issued.response.text)
    const paired = await responseRecord(await fetch(new URL('/v1/pair', h.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json', 'x-pairing-token': issued.response.body.token }, body: JSON.stringify({ householdId: actors.householdId, parentId: issued.response.body.pairing_session_id, publicJwk: phone.publicJwk, token: issued.response.body.token }) }))
    assert.equal(paired.status, 200, paired.text)

    await allowance(h, actors, 'game', 'allowance-happy')
    const tuple = { householdId: actors.householdId, requestId: 'request-happy', pcId: actors.pcId, gameId: 'game', allowanceVersion: 1, ianaTimeZone: 'UTC', ianaDay: new Date(h.now).toISOString().slice(0, 10), processId: 'process-happy', processStartedAt: 101 }
    const created = await call(h, { path: '/v1/requests', body: tuple, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'request-happy' })
    assert.equal(created.response.status, 200, created.response.text)
    assert.equal((await replay(h, created.envelope)).text, created.response.text)

    const phoneId = issued.response.body.pairing_session_id
    const rejected = await call(h, { path: '/v1/reject', body: { householdId: actors.householdId, requestId: tuple.requestId }, signer: phone, actorId: phoneId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'reject-happy' })
    assert.equal(rejected.response.status, 200, rejected.response.text)
    const approved = await call(h, { path: '/v1/approve', body: { householdId: actors.householdId, requestId: tuple.requestId, minutes: 5 }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'approve-happy' })
    assert.equal(approved.response.status, 200, approved.response.text)
    assert.equal((await replay(h, approved.envelope)).text, approved.response.text)

    const consumed = await call(h, { path: '/v1/consume', body: tuple, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'consume-happy' })
    assert.equal(consumed.response.status, 200, consumed.response.text)
    assert.equal((await replay(h, consumed.envelope)).text, consumed.response.text)
    await h.stop()
    assert.deepEqual(await h.query("SELECT a.committed_seconds,a.reserved_seconds,a.version,r.state,g.state AS grant_state,d.debit_seconds,(SELECT COUNT(*) FROM personal_responses) AS rejects FROM pc_daily_allowances a JOIN allowance_reservations r ON r.request_id='request-happy' JOIN approval_grants g ON g.request_id=r.request_id JOIN allowance_debits d ON d.request_id=r.request_id"), [{ committed_seconds: 300, reserved_seconds: 0, version: 1, state: 'settled', grant_state: 'consumed', debit_seconds: 300, rejects: 1 }])
    assert.deepEqual(await h.query("SELECT COUNT(*) AS count FROM idempotency_records WHERE result_json IS NOT NULL AND idempotency_key IN('pair-happy','request-happy','approve-happy','consume-happy')"), [{ count: 4 }])
  } finally { await h.cleanup() }
})

test('injected clock enforces exact request/grant expiry and an injected provider outage persists retry state', { timeout: 180_000 }, async () => {
  const h = await createLifecycle('expiry-provider', 1_700_000_100_000, { providerFailure: true })
  try {
    const actors = await h.bootstrap()
    await allowance(h, actors, 'game', 'allowance-expiry')
    const expiredRequest = { householdId: actors.householdId, requestId: 'request-expired', pcId: actors.pcId, gameId: 'game', allowanceVersion: 1, processId: 'expired-process', processStartedAt: 201 }
    const created = await call(h, { path: '/v1/requests', body: expiredRequest, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'request-expired' })
    assert.equal(created.response.body.request.expiresAt, h.now + 300_000)
    await h.setNow(created.response.body.request.expiresAt - 1)
    const requestBeforeBoundary = await call(h, { path: `/v1/request?householdId=${actors.householdId}&requestId=${expiredRequest.requestId}`, method: 'GET', signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1 })
    assert.equal(requestBeforeBoundary.response.body.status, 'pending')
    await h.setNow(created.response.body.request.expiresAt)
    const lateApproval = await call(h, { path: '/v1/approve', body: { householdId: actors.householdId, requestId: expiredRequest.requestId, minutes: 5 }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'approve-expired' })
    assert.deepEqual(lateApproval.response.body, { error: 'NOT_APPROVABLE' })

    const grantFlow = await requestAndApprove(h, actors, 'grant-expired')
    const grantExpiry = grantFlow.approved.response.body.serverNowMs + 300_000
    await h.setNow(grantExpiry - 1)
    const grantBeforeBoundary = await call(h, { path: `/v1/pc/state?householdId=${actors.householdId}&pcId=${actors.pcId}`, method: 'GET', signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1 })
    assert.equal(grantBeforeBoundary.response.body.grant.requestId, grantFlow.tuple.requestId)
    await h.setNow(grantExpiry)
    const lateConsume = await call(h, { path: '/v1/consume', body: grantFlow.tuple, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'consume-expired' })
    assert.deepEqual(lateConsume.response.body, { error: 'GRANT_INVALID' })

    const token = await call(h, { path: '/v1/fcm-tokens', body: { householdId: actors.householdId, token: 'disposable-device-token-0000000000', tokenVersion: 1 }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'fcm-expiry' })
    assert.equal(token.response.status, 200, token.response.text)
    const notificationRequest = { householdId: actors.householdId, requestId: 'provider-notification', pcId: actors.pcId, gameId: 'game', allowanceVersion: 1, processId: 'provider-process', processStartedAt: 202 }
    const notified = await call(h, { path: '/v1/requests', body: notificationRequest, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'request-provider-notification' })
    assert.equal(notified.response.status, 200, notified.response.text)
    const scheduled = await fetch(`${h.baseUrl}/__scheduled?cron=*+*+*+*+*`)
    assert.equal(scheduled.status, 200)
    await h.stop()
    assert.deepEqual(await h.query("SELECT state,error_code,attempt,next_attempt_at_ms FROM notification_deliveries ORDER BY created_at_ms LIMIT 1"), [{ state: 'retry', error_code: 'PROVIDER_TRANSIENT', attempt: 1, next_attempt_at_ms: h.now + 60_000 }])
    assert.deepEqual(await h.query("SELECT state FROM allowance_reservations WHERE request_id='grant-expired'"), [{ state: 'released' }])
  } finally { await h.cleanup() }
})

test('reset wins a deterministic in-flight consume race at the shipped authenticated pre-commit seam', { timeout: 180_000 }, async () => {
  const h = await createLifecycle('reset-race', 1_700_000_200_000)
  let barrier
  try {
    const actors = await h.bootstrap()
    await allowance(h, actors, 'game', 'allowance-reset')
    const flow = await requestAndApprove(h, actors, 'request-reset')
    barrier = await subscribeConsumeBarrier(h)
    const consumeEnvelope = await signedRequest({ baseUrl: h.baseUrl, path: '/v1/consume', body: flow.tuple, signer: actors.pc, actorId: actors.pcId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'consume-before-reset' })
    const consumeResponse = fetch(consumeEnvelope.request).then(responseRecord, (error) => ({ transportError: error }))
    await barrier.reached()

    const recovery = await identity()
    recovery.now = h.now
    const reset = await call(h, { path: '/v1/reset', body: { householdId: actors.householdId, recoveryParentId: 'recovery-reset', recoveryPublicJwk: JSON.stringify(recovery.publicJwk) }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'reset-durable' })
    assert.equal(reset.response.status, 200, reset.response.text)
    await barrier.release()
    barrier = undefined

    const staleConsume = await consumeResponse
    assert.equal(staleConsume.transportError, undefined)
    assert.equal(staleConsume.status, 400)
    assert.deepEqual(staleConsume.body, { error: 'GRANT_INVALID' })
    const reconciled = await call(h, { path: `/v1/reset/reconcile?householdId=${actors.householdId}`, method: 'GET', signer: recovery, actorId: 'recovery-reset', membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'reset-durable' })
    assert.equal(reconciled.response.status, 200, reconciled.response.text)
    assert.equal(reconciled.response.body.membership_epoch, 2)
    await h.stop()
    assert.deepEqual(await h.query("SELECT membership_epoch,service_epoch,last_operation_key FROM households"), [{ membership_epoch: 2, service_epoch: 2, last_operation_key: 'reset-durable' }])
    assert.deepEqual(await h.query("SELECT state FROM allowance_reservations WHERE request_id='request-reset'"), [{ state: 'released' }])
    assert.deepEqual(await h.query("SELECT state,consumed_at_ms FROM approval_grants WHERE request_id='request-reset'"), [{ state: 'issued', consumed_at_ms: null }])
    assert.deepEqual(await h.query("SELECT committed_seconds,reserved_seconds FROM pc_daily_allowances WHERE household_id='household-reset-race'"), [{ committed_seconds: 0, reserved_seconds: 0 }])
    assert.deepEqual(await h.query("SELECT COUNT(*) AS count FROM allowance_debits WHERE request_id='request-reset'"), [{ count: 0 }])
  } finally {
    if (barrier) await barrier.release().catch(() => undefined)
    await h.cleanup()
  }
})

test('delete releases outstanding accounting and remains byte-identically replayable and reconcilable', { timeout: 180_000 }, async () => {
  const h = await createLifecycle('delete', 1_700_000_300_000)
  try {
    const actors = await h.bootstrap()
    await allowance(h, actors, 'game', 'allowance-delete')
    await requestAndApprove(h, actors, 'request-delete')
    const deleted = await call(h, { path: '/v1/household', method: 'DELETE', body: { householdId: actors.householdId }, signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'delete-durable' })
    assert.equal(deleted.response.status, 200, deleted.response.text)
    assert.equal((await replay(h, deleted.envelope)).text, deleted.response.text)
    await h.stop()
    await h.execute(['--command', "DELETE FROM idempotency_commit_assertions WHERE idempotency_key='delete-durable'; DELETE FROM idempotency_records WHERE idempotency_key='delete-durable';", '--yes'])
    await h.start()
    const reconciled = await call(h, { path: `/v1/delete/reconcile?householdId=${actors.householdId}&operationKey=delete-durable`, method: 'GET', signer: actors.admin, actorId: actors.adminId, membershipEpoch: 1, serviceEpoch: 1, idempotencyKey: 'delete-durable' })
    assert.equal(reconciled.response.status, 200, reconciled.response.text)
    assert.equal(reconciled.response.body.last_operation_key, 'delete-durable')
    await h.stop()
    assert.deepEqual(await h.query("SELECT delete_state,remote_enabled,deleted_at_ms,last_operation_key FROM households"), [{ delete_state: 'pending_purge', remote_enabled: 0, deleted_at_ms: h.now, last_operation_key: 'delete-durable' }])
    assert.deepEqual(await h.query("SELECT state FROM allowance_reservations WHERE request_id='request-delete'"), [{ state: 'released' }])
    assert.deepEqual(await h.query("SELECT operation_key,membership_epoch,service_epoch FROM deletion_receipts"), [{ operation_key: 'delete-durable', membership_epoch: 1, service_epoch: 1 }])
  } finally { await h.cleanup() }
})
