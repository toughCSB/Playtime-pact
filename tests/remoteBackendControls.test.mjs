import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose'
import { createWorker } from '../remote-backend/src/worker.mjs'
import { createAuthenticator } from '../remote-backend/src/authenticator.mjs'
import { SqliteD1Database } from './helpers/sqliteD1.mjs'
import { PERMISSION_KEYS, getControls, setControls, parsePermissions } from '../remote-backend/scripts/controlPermissions.mjs'

const schemaUrl = new URL('../remote-backend/schema.sql', import.meta.url)

async function harness(body) {
  const db = new SqliteD1Database(schemaUrl)
  const now = 1_700_000_000_000
  const operator = await generateKeyPair('ES256', { extractable: true })
  const operatorJwk = await exportJWK(operator.publicKey)
  const stranger = await generateKeyPair('ES256', { extractable: true })
  const strangerJwk = await exportJWK(stranger.publicKey)
  db.sqlite.prepare(`INSERT INTO operator_authorities(id,public_jwk,status,created_at_ms) VALUES(?,?,'active',?)`).run('operator-staging', JSON.stringify({ crv: 'P-256', kty: 'EC', x: operatorJwk.x, y: operatorJwk.y }), now)
  db.sqlite.prepare(`INSERT INTO households(id,setup_token,remote_enabled,service_epoch,membership_epoch) VALUES('h','token',0,1,1)`).run()
  const worker = createWorker({
    db,
    authenticator: createAuthenticator(db, { now: () => now }),
    now: () => now,
    pairingTokenSecret: 'test-pairing-token-secret-that-is-at-least-32-bytes',
  })
  const fetchImpl = (input, init) => worker.fetch(new Request(input, init))
  const signerFor = (keys, jwk) => ({
    actorId: 'operator-staging',
    privateKey: keys.privateKey,
    publicJwk: { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y },
  })
  try {
    return await body({
      db,
      now,
      fetchImpl,
      baseUrl: 'https://remote.test',
      operator: signerFor(operator, operatorJwk),
      stranger: signerFor(stranger, strangerJwk),
    })
  } finally {
    db.close()
  }
}

const allFalse = { create: false, respond_or_issue: false, consume: false }
const publicJwk = (jwk) => ({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })

async function signedRequest({ keys, jwk, actorId, method = 'POST', url, body, idempotencyKey, membershipEpoch, serviceEpoch, sequence = 1 }) {
  const payload = method === 'GET' ? '' : JSON.stringify(body)
  const claims = {
    actorId,
    clientVersionCode: 1,
    contentDigest: `sha-256=:${createHash('sha256').update(payload).digest('base64')}:`,
    htm: method,
    htu: url,
    iat: 1_700_000_000,
    idempotencyKey,
    jti: `${idempotencyKey}-jti-${sequence}`,
    nonce: `${idempotencyKey}-nonce-${sequence}`,
    ...(membershipEpoch === undefined ? {} : { membershipEpoch }),
    ...(serviceEpoch === undefined ? {} : { serviceEpoch }),
  }
  const token = await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: publicJwk(jwk) })
    .sign(keys.privateKey)
  return new Request(url, {
    method,
    headers: { authorization: `Bearer ${JSON.stringify(token)}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : payload,
  })
}

async function enrollmentHarness(body) {
  const db = new SqliteD1Database(schemaUrl)
  const now = 1_700_000_000_000
  const setup = await generateKeyPair('ES256', { extractable: true })
  const setupJwk = await exportJWK(setup.publicKey)
  const admin = await generateKeyPair('ES256', { extractable: true })
  const adminJwk = await exportJWK(admin.publicKey)
  const operational = await generateKeyPair('ES256', { extractable: true })
  const operationalJwk = await exportJWK(operational.publicKey)
  const stranger = await generateKeyPair('ES256', { extractable: true })
  const strangerJwk = await exportJWK(stranger.publicKey)
  db.sqlite.prepare(`INSERT INTO setup_authorities(id,public_jwk,status,created_at_ms) VALUES(?,?,'active',?)`).run('global', JSON.stringify(publicJwk(setupJwk)), now)
  const worker = createWorker({
    db,
    authenticator: createAuthenticator(db, { now: () => now }),
    now: () => now,
    pairingTokenSecret: 'test-pairing-token-secret-that-is-at-least-32-bytes',
  })
  try {
    return await body({ db, now, worker, setup, setupJwk, admin, adminJwk, operationalJwk, stranger, strangerJwk })
  } finally {
    db.close()
  }
}

test('environment controls round-trip their effective tuple through a signed operator proof', async () => {
  await harness(async ({ fetchImpl, baseUrl, operator, now }) => {
    const initial = await getControls({ baseUrl, householdId: 'h', signer: operator, fetchImpl, now: () => now })
    assert.deepEqual(initial.environment, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })
    assert.deepEqual(initial.household, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })

    const updated = await setControls({
      baseUrl, scope: 'environment', permissions: { create: false, respond_or_issue: false, consume: true },
      expectedVersion: 1, signer: operator, fetchImpl, now: () => now,
    })
    assert.equal(updated.controlVersion, 2)

    const after = await getControls({ baseUrl, householdId: 'h', signer: operator, fetchImpl, now: () => now })
    assert.deepEqual(after.environment, { create: false, respond_or_issue: false, consume: true, controlVersion: 2, serviceEpoch: 1 })
    assert.deepEqual(after.household, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })
  })
})

test('household controls round-trip independently of the environment tuple', async () => {
  await harness(async ({ fetchImpl, baseUrl, operator, now }) => {
    await setControls({ baseUrl, scope: 'household', householdId: 'h', permissions: { create: true, respond_or_issue: true, consume: true }, expectedVersion: 1, signer: operator, fetchImpl, now: () => now })
    const after = await getControls({ baseUrl, householdId: 'h', signer: operator, fetchImpl, now: () => now })
    assert.deepEqual(after.household, { create: true, respond_or_issue: true, consume: true, controlVersion: 2, serviceEpoch: 1 })
    assert.deepEqual(after.environment, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })
  })
})

test('an unregistered operator key is rejected and changes nothing', async () => {
  await harness(async ({ fetchImpl, baseUrl, operator, stranger, now, db }) => {
    await assert.rejects(
      () => setControls({ baseUrl, scope: 'environment', permissions: { create: true, respond_or_issue: true, consume: true }, expectedVersion: 1, signer: { ...stranger, actorId: 'unknown-operator' }, fetchImpl, now: () => now }),
      /CONTROLS_REJECTED/,
    )
    const after = await getControls({ baseUrl, householdId: 'h', signer: operator, fetchImpl, now: () => now })
    assert.deepEqual(after.environment, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })
    assert.equal(db.sqlite.prepare('SELECT count(*) AS c FROM permission_control_audit').get().c, 0)
  })
})

test('a signature from a registered actor id but the wrong key is rejected', async () => {
  await harness(async ({ fetchImpl, baseUrl, operator, stranger, now }) => {
    await assert.rejects(
      () => setControls({ baseUrl, scope: 'environment', permissions: { create: true, respond_or_issue: true, consume: true }, expectedVersion: 1, signer: stranger, fetchImpl, now: () => now }),
      /CONTROLS_REJECTED/,
    )
    const after = await getControls({ baseUrl, householdId: 'h', signer: operator, fetchImpl, now: () => now })
    assert.deepEqual(after.environment, { ...allFalse, controlVersion: 1, serviceEpoch: 1 })
  })
})

test('a stale expected control version is refused rather than clobbering a concurrent change', async () => {
  await harness(async ({ fetchImpl, baseUrl, operator, now }) => {
    await setControls({ baseUrl, scope: 'environment', permissions: { create: false, respond_or_issue: false, consume: true }, expectedVersion: 1, signer: operator, fetchImpl, now: () => now })
    await assert.rejects(
      () => setControls({ baseUrl, scope: 'environment', permissions: { create: true, respond_or_issue: true, consume: true }, expectedVersion: 1, signer: operator, fetchImpl, now: () => now }),
      /CONTROL_CAS_CONFLICT/,
    )
  })
})

test('permission parsing requires the whole tuple and rejects unknown keys', () => {
  assert.deepEqual(parsePermissions('create=false,respond_or_issue=false,consume=true'), { create: false, respond_or_issue: false, consume: true })
  assert.deepEqual(parsePermissions('all-false'), { create: false, respond_or_issue: false, consume: false })
  assert.throws(() => parsePermissions('create=true'), /BAD_PERMISSIONS/)
  assert.throws(() => parsePermissions('create=true,respond_or_issue=true,consume=true,extra=true'), /BAD_PERMISSIONS/)
  assert.throws(() => parsePermissions('create=maybe,respond_or_issue=true,consume=true'), /BAD_PERMISSIONS/)
  assert.deepEqual(PERMISSION_KEYS, ['create', 'respond_or_issue', 'consume'])
})

test('all-false setup permits exactly one recovery-parent-signed bootstrap PC and returns an importable receipt', async () => {
  await enrollmentHarness(async ({ db, worker, setup, setupJwk, admin, adminJwk, operationalJwk, stranger, strangerJwk }) => {
    const setupUrl = 'https://remote.test/v1/households/setup'
    const setupBody = {
      householdId: 'household-bootstrap',
      initialParentId: 'recovery-parent',
      publicJwk: JSON.stringify(publicJwk(adminJwk)),
      permissions: allFalse,
    }

    const unregistered = await worker.fetch(await signedRequest({
      keys: stranger,
      jwk: strangerJwk,
      actorId: 'global',
      url: setupUrl,
      body: setupBody,
      idempotencyKey: 'setup-unregistered',
    }))
    assert.equal(unregistered.status, 401)
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM households').get().count, 0)

    const setupResponse = await worker.fetch(await signedRequest({
      keys: setup,
      jwk: setupJwk,
      actorId: 'global',
      url: setupUrl,
      body: setupBody,
      idempotencyKey: 'setup-household-bootstrap',
    }))
    assert.equal(setupResponse.status, 200, await setupResponse.text())
    assert.deepEqual(
      { ...db.sqlite.prepare("SELECT mode,create_permission,respond_or_issue_permission,consume_permission FROM environments WHERE id='global'").get() },
      { mode: 'LOCAL_ONLY', create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0 },
    )
    assert.deepEqual(
      { ...db.sqlite.prepare("SELECT remote_enabled,create_permission,respond_or_issue_permission,consume_permission FROM households WHERE id='household-bootstrap'").get() },
      { remote_enabled: 0, create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0 },
    )

    const registerUrl = 'https://remote.test/v1/pcs'
    const registerBody = {
      householdId: 'household-bootstrap',
      pcId: 'pc-bootstrap',
      publicKey: JSON.stringify(publicJwk(operationalJwk)),
      ianaTimeZone: 'UTC',
    }
    const wrongParent = await worker.fetch(await signedRequest({
      keys: stranger,
      jwk: strangerJwk,
      actorId: 'recovery-parent',
      url: registerUrl,
      body: registerBody,
      idempotencyKey: 'register-wrong-parent',
      membershipEpoch: 1,
      serviceEpoch: 1,
    }))
    assert.equal(wrongParent.status, 401)
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM pcs').get().count, 0)

    const firstRequest = await signedRequest({
      keys: admin,
      jwk: adminJwk,
      actorId: 'recovery-parent',
      url: registerUrl,
      body: registerBody,
      idempotencyKey: 'register-pc-bootstrap',
      membershipEpoch: 1,
      serviceEpoch: 1,
    })
    const firstResponse = await worker.fetch(firstRequest)
    const firstText = await firstResponse.text()
    assert.equal(firstResponse.status, 200, firstText)
    const receipt = JSON.parse(firstText)
    assert.deepEqual(receipt, {
      v: 1,
      serverNowMs: 1_700_000_000_000,
      operation: 'registerPc',
      household_id: 'household-bootstrap',
      pc_id: 'pc-bootstrap',
      public_key: registerBody.publicKey,
      iana_time_zone: 'UTC',
      membership_epoch: 1,
      service_epoch: 1,
    })

    const retryResponse = await worker.fetch(await signedRequest({
      keys: admin,
      jwk: adminJwk,
      actorId: 'recovery-parent',
      url: registerUrl,
      body: registerBody,
      idempotencyKey: 'register-pc-bootstrap',
      membershipEpoch: 1,
      serviceEpoch: 1,
      sequence: 2,
    }))
    assert.equal(retryResponse.status, 200)
    assert.equal(await retryResponse.text(), firstText)

    const changedKey = JSON.stringify({ ...publicJwk(operationalJwk), x: setupJwk.x })
    const changedResponse = await worker.fetch(await signedRequest({
      keys: admin,
      jwk: adminJwk,
      actorId: 'recovery-parent',
      url: registerUrl,
      body: { ...registerBody, publicKey: changedKey },
      idempotencyKey: 'register-pc-changed-key',
      membershipEpoch: 1,
      serviceEpoch: 1,
    }))
    assert.equal(changedResponse.status, 400)
    assert.equal((await changedResponse.json()).error, 'PC_ID_CONFLICT')

    const secondPcResponse = await worker.fetch(await signedRequest({
      keys: admin,
      jwk: adminJwk,
      actorId: 'recovery-parent',
      url: registerUrl,
      body: { ...registerBody, pcId: 'pc-other' },
      idempotencyKey: 'register-second-pc-while-disabled',
      membershipEpoch: 1,
      serviceEpoch: 1,
    }))
    assert.equal(secondPcResponse.status, 400)
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM pcs WHERE household_id='household-bootstrap'").get().count, 1)
    assert.equal(db.sqlite.prepare("SELECT public_key FROM pcs WHERE id='pc-bootstrap'").get().public_key, registerBody.publicKey)
  })
})
