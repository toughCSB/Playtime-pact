import test from 'node:test'
import assert from 'node:assert/strict'
import { createD1Authority, createWorker } from '../remote-backend/src/worker.mjs'
import { SqliteD1Database } from './helpers/sqliteD1.mjs'

const schemaUrl = new URL('../remote-backend/schema.sql', import.meta.url)

function createHarness() {
  const db = new SqliteD1Database(schemaUrl)
  db.sqlite.prepare(`UPDATE environments SET mode='REMOTE_ENABLED',create_permission=1,respond_or_issue_permission=1,consume_permission=1 WHERE id='global'`).run()
  let now = 1_000_000
  let sequence = 0
  const authenticator = {
    async verify({ request, body }) {
      const url = new URL(request.url)
      const path = url.pathname
      const input = body ? JSON.parse(body) : Object.fromEntries(url.searchParams)
      const householdId = input.householdId || 'h'
      const idempotencyKey = request.headers.get('x-idempotency-key') || `idem-${++sequence}`
      if (path === '/v1/households/setup') {
        return { actorId: 'setup-authority', principalKind: 'setup-authority', householdId: null, membershipEpoch: 0, serviceEpoch: 1, jti: `${idempotencyKey}-j`, nonce: `${idempotencyKey}-n`, idempotencyKey }
      }
      if (path === '/v1/requests' && request.method === 'POST' || path === '/v1/pc/state' || path === '/v1/consume' || path === '/v1/telemetry') {
        return { actorId: input.pcId, principalKind: 'pc', householdId, membershipEpoch: 1, serviceEpoch: 1, jti: `${idempotencyKey}-j`, nonce: `${idempotencyKey}-n`, idempotencyKey }
      }
      const actorId = request.headers.get('x-actor-id') || (householdId === 'h2' ? 'parent2' : 'parent')
      return { actorId, principalKind: 'parent', householdId, membershipEpoch: 1, serviceEpoch: 1, jti: `${idempotencyKey}-j`, nonce: `${idempotencyKey}-n`, idempotencyKey }
    },
  }
  const worker = createWorker({ db, authenticator, now: () => now, pairingTokenSecret: 'test-pairing-token-secret-that-is-at-least-32-bytes', fcmTokenEncryptionKey:new Uint8Array(32).fill(7) })
  const call = async (path, body, { method = 'POST', idempotencyKey, actorId, headers = {} } = {}) => {
    if (body && path === '/v1/households/setup' && body.permissions === undefined) body = { ...body, permissions:{create:true,respond_or_issue:true,consume:true} }
    if (body && path === '/v1/pcs' && body.ianaTimeZone === undefined) body = { ...body, ianaTimeZone:'UTC' }
    if (body && path === '/v1/allowances' && body.version !== undefined) body = { householdId:body.householdId,pcId:'pc',gameId:body.gameId,expectedVersion:body.version-1,totalSeconds:body.remainingSeconds }
    if (body && path === '/v1/consume' && body.ianaDay === undefined) body = { ...body, ianaTimeZone:'UTC', ianaDay:'1970-01-01' }
    const response = await worker.fetch(new Request(`https://remote.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        ...(actorId ? { 'x-actor-id': actorId } : {}),
        ...headers,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }))
    const payload = await response.json()
    return { status: response.status, payload, headers: response.headers }
  }
  return { db, worker, authenticator, call, setNow(value) { now = value }, get now() { return now } }
}
const hashSecret = async (value) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex')
test('setup rejects an omitted permission tuple', async () => {
  const h=createHarness()
  try {
    const response=await h.worker.fetch(new Request('https://remote.test/v1/households/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({householdId:'h',initialParentId:'parent',publicJwk:'{}'})}))
    assert.equal(response.status,400)
    assert.deepEqual(await response.json(),{error:'BAD_PERMISSIONS'})
  } finally {
    h.db.close()
  }
})

test('mutation admission composes each production capability independently', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    const authority=createD1Authority(h.db,{now:()=>h.now})
    const claim=(capability,index)=>authority.beginOperation({householdId:'h',actorId:'pc',principalKind:'pc',capability,jti:`j-${index}`,nonce:`n-${index}`,idempotencyKey:`i-${index}`,operationDigest:`d-${index}`})
    const expectPolicy=async (permissions,version,allowed,denied,index) => {
      await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions,expectedVersion:version})
      await claim(allowed,index)
      await assert.rejects(claim(denied,index+1),/REMOTE_UNAVAILABLE/)
    }
    await expectPolicy({create:true,respond_or_issue:false,consume:false},1,'create','respond_or_issue',1)
    await expectPolicy({create:false,respond_or_issue:true,consume:false},2,'respond_or_issue','consume',3)
    await expectPolicy({create:false,respond_or_issue:false,consume:true},3,'consume','create',5)
  } finally {
    h.db.close()
  }
})

test('disabled households retain state reads and can re-enter through actual mutation routes', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    const authority=createD1Authority(h.db,{now:()=>h.now})
    await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:{create:false,respond_or_issue:false,consume:false},expectedVersion:1})
    assert.equal((await h.call('/v1/parent/state?householdId=h',null,{method:'GET'})).status,200)
    assert.equal((await h.call('/v1/pc/state?householdId=h&pcId=pc',null,{method:'GET'})).status,200)
    await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:{create:false,respond_or_issue:true,consume:false},expectedVersion:2})
    assert.equal((await h.call('/v1/parents',{householdId:'h',parentId:'parent-2',publicJwk:'{}'})).status,200)
  } finally {
    h.db.close()
  }
})
test('operator control mutations atomically audit and epoch only on any-true to all-false', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    const authority=createD1Authority(h.db,{now:()=>h.now})
    const on={create:true,respond_or_issue:true,consume:true}
    const off={create:false,respond_or_issue:false,consume:false}
    assert.equal((await authority.setEnvironmentControls({actorId:'operator',permissions:on,expectedVersion:1})).service_epoch,1)
    assert.equal((await authority.setEnvironmentControls({actorId:'operator',permissions:off,expectedVersion:2})).service_epoch,2)
    assert.equal((await authority.setEnvironmentControls({actorId:'operator',permissions:on,expectedVersion:3})).service_epoch,2)
    assert.equal((await authority.setEnvironmentControls({actorId:'operator',permissions:off,expectedVersion:4})).service_epoch,3)
    assert.equal((await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:{...on,consume:false},expectedVersion:1})).service_epoch,1)
    assert.equal((await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:off,expectedVersion:2})).service_epoch,2)
    const audit=h.db.sqlite.prepare("SELECT scope,previous_version,next_version,service_epoch FROM permission_control_audit ORDER BY created_at_ms,id").all()
    assert.equal(audit.length,6)
    assert.equal(audit.filter((row)=>row.scope==='environment').length,4)
    assert.equal(audit.filter((row)=>row.scope==='household').length,2)
    await assert.rejects(authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:on,expectedVersion:1}),/CONTROL_CAS_CONFLICT/)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM permission_control_audit").get().count,6)
  } finally {
    h.db.close()
  }
})
test('pairing binds independent global and household service epochs', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    const authority=createD1Authority(h.db,{now:()=>h.now})
    const on={create:true,respond_or_issue:true,consume:true}
    const off={create:false,respond_or_issue:false,consume:false}
    await authority.setEnvironmentControls({actorId:'operator',permissions:on,expectedVersion:1})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    await authority.issuePairingSession({id:'before-household-off',householdId:'h',parentId:'phone-1',secretHash:'secret-1',expiresAtMs:h.now+60_000,issuedByPcId:'pc'})
    await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:off,expectedVersion:1})
    await assert.rejects(authority.pair({householdId:'h',parentId:'phone-1',publicJwk:'{}',secretHash:'secret-1'}),/PAIRING_INVALID/)
    await authority.setHouseholdControls({householdId:'h',actorId:'operator',permissions:on,expectedVersion:2})
    const unequal=await authority.issuePairingSession({id:'unequal-epochs',householdId:'h',parentId:'phone-2',secretHash:'secret-2',expiresAtMs:h.now+60_000,issuedByPcId:'pc'})
    assert.equal(unequal.global_service_epoch,1)
    assert.equal(unequal.household_service_epoch,2)
    assert.equal((await authority.pair({householdId:'h',parentId:'phone-2',publicJwk:'{}',secretHash:'secret-2'})).parentId,'phone-2')
    await authority.issuePairingSession({id:'before-global-off',householdId:'h',parentId:'phone-3',secretHash:'secret-3',expiresAtMs:h.now+60_000,issuedByPcId:'pc'})
    await authority.setEnvironmentControls({actorId:'operator',permissions:off,expectedVersion:2})
    await assert.rejects(authority.pair({householdId:'h',parentId:'phone-3',publicJwk:'{}',secretHash:'secret-3'}),/PAIRING_INVALID/)
  } finally {
    h.db.close()
  }
})

test('one-time pairing redemption installs a parent and exposes authoritative parent state', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-pair' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 3_600 })
    await h.call('/v1/requests', { householdId: 'h', requestId: 'r-pair', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: '42', processStartedAt: 99 })
    const token = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
    h.db.sqlite.prepare(`INSERT INTO pairing_sessions(id,household_id,parent_id,secret_hash,membership_epoch,service_epoch,global_service_epoch,household_service_epoch,expires_at_ms,issued_by_pc_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('pair-1','h','phone',await hashSecret(token),1,1,1,1,h.now+60_000,'pc')
    const body = { householdId: 'h', parentId: 'phone', token, publicJwk: { kty: 'EC', crv: 'P-256', x: 'RD5y0WyFcRC0y6UpuVjP5BhpaJeydOWFaWKOj8gRGWM', y: 'IiMy7SxjNbsvY_agm_Lweo_jTeducGFpS5SWvxOjd4A' } }
    const paired = await h.call('/v1/pair', body, { headers: { 'x-pairing-token': token } })
    assert.equal(paired.status, 200, JSON.stringify({payload:paired.payload,session:h.db.sqlite.prepare("SELECT * FROM pairing_sessions WHERE id='pair-1'").get(),household:h.db.sqlite.prepare("SELECT h.*,e.* FROM households h JOIN environments e ON e.id='global' WHERE h.id='h'").get()}))
    assert.deepEqual(paired.payload, { parentId: 'phone', householdId: 'h', membershipEpoch: 1, serviceEpoch: 1 })
    assert.equal(h.db.sqlite.prepare("SELECT status FROM parent_devices WHERE id='phone'").get().status, 'active')
    assert.equal((await h.call('/v1/pair', body, { headers: { 'x-pairing-token': token } })).status, 400)
    const state = await h.call('/v1/parent/state?householdId=h', null, { method: 'GET', actorId: 'phone' })
    assert.equal(state.status, 200)
    assert.equal(state.payload.serverNowMs, h.now)
    assert.equal(state.payload.requests[0].requestId, 'r-pair')
    assert.equal(state.payload.requests[0].gameId, 'roblox')
    assert.equal(state.payload.requests[0].childName, 'pc')
    assert.equal(state.payload.requests[0].status, 'pending')
    assert.equal(state.payload.requests[0].personalDecision, null)
    assert.equal(state.payload.requests[0].todayUsedMinutes, 0)
    assert.equal(state.payload.requests[0].todayLimitMinutes, 60)
    assert.equal(state.payload.devices.some((device) => device.id === 'phone'), true)
    assert.deepEqual(state.payload.devices.find((device) => device.id === 'phone'), { id:'phone', name:'phone', platform:'Android', status:'active', registeredAt:h.now })
    assert.equal((await h.call('/v1/reject', { householdId: 'h', requestId: 'r-pair' }, { actorId: 'phone' })).status, 200)
    const rejectedState=await h.call('/v1/parent/state?householdId=h',null,{method:'GET',actorId:'phone'})
    assert.equal(rejectedState.payload.requests[0].requestId,'r-pair')
    assert.equal(rejectedState.payload.requests[0].personalDecision,'reject')
  } finally {
    h.db.close()
  }
})

test('admin pairing issuance and PC state are authoritative and replay-safe', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-runtime' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 3_600 })
    const issued = await h.call('/v1/pairing-sessions', { householdId: 'h', pcId: 'pc' }, { idempotencyKey: 'pairing-runtime' })
    const replay = await h.call('/v1/pairing-sessions', { householdId: 'h', pcId: 'pc' }, { idempotencyKey: 'pairing-runtime' })
    assert.equal(issued.status, 200)
    assert.deepEqual(replay.payload, issued.payload)
    assert.match(issued.payload.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM pairing_sessions').get().count, 1)

    const created=await h.call('/v1/requests', { householdId: 'h', requestId: 'runtime-request', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: '42', processStartedAt: 99 })
    assert.deepEqual(created.payload,{v:1,serverNowMs:h.now,request:{householdId:'h',requestId:'runtime-request',pcId:'pc',gameId:'roblox',allowanceVersion:1,processId:'42',processStartedAt:99,membershipEpoch:1,serviceEpoch:1,requestedAt:h.now,expiresAt:h.now+300000}})
    await h.call('/v1/approve', { householdId: 'h', requestId: 'runtime-request', minutes: 20 })
    const state = await h.call('/v1/pc/state?householdId=h&pcId=pc&gameId=roblox', null, { method: 'GET' })
    assert.equal(state.status, 200)
    assert.equal(state.payload.request.requestId, 'runtime-request')
    assert.equal(state.payload.grant.requestId, 'runtime-request')
    assert.equal(state.payload.grant.grantedAt, h.now)
    assert.equal(state.payload.health.lifecycle, 'online')
    assert.equal(state.payload.parentDevices[0].parentDeviceId, 'parent')
    assert.deepEqual(state.payload.allowance, { pcId:'pc', gameId:'roblox', ianaTimeZone:'UTC', ianaDay:'1970-01-01', allowanceVersion:1, totalSeconds:3600, committedSeconds:0, reservedSeconds:1200 })
  } finally {
    h.db.close()
  }
})
test('FCM tokens are encrypted at rest and revocation quarantines delivery eligibility', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    const token='opaque-fcm-token-value-at-least-sixteen'
    assert.equal((await h.call('/v1/fcm-tokens',{householdId:'h',token,tokenVersion:1})).status,200)
    const row=h.db.sqlite.prepare("SELECT token_hash,token_ciphertext,status FROM fcm_tokens WHERE household_id='h'").get()
    assert.equal(row.status,'active'); assert.notEqual(row.token_ciphertext,token); assert.notEqual(row.token_ciphertext,Buffer.from(token).toString('base64url')); assert.match(row.token_ciphertext,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    assert.equal((await h.call('/v1/fcm-tokens',{householdId:'h',tokenVersion:1},{method:'DELETE'})).status,200)
    assert.equal(h.db.sqlite.prepare("SELECT status FROM fcm_tokens WHERE household_id='h'").get().status,'revoked')
  } finally { h.db.close() }
})

test('notification dispatch persists provider acknowledgement, deferred retry, and terminal failure', async () => {
  const h=createHarness()
  try {
    const authority=createD1Authority(h.db,{now:()=>h.now,fcmProtector:{async decrypt(){ return 'provider-token' }},notificationProvider:{async send({intentId}) { if(intentId==='retry') throw Object.assign(new Error('down'),{code:'PROVIDER_TRANSIENT'}); if(intentId==='terminal') throw Object.assign(new Error('bad'),{code:'PROVIDER_REJECTED'}); return 'ack-1' }}})
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    for(const id of ['ack','retry','terminal']) h.db.sqlite.prepare("INSERT INTO notification_intents VALUES(?,?,NULL,'request-created','{}',?,NULL)").run(id,'h',h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens(id,household_id,parent_id,token_hash,token_ciphertext,token_version,status,created_at_ms,rotated_at_ms,revoked_at_ms,last_operation_key) VALUES('token','h','parent','hash','cipher',1,'active',?,NULL,NULL,'k')").run(h.now)
    const result=await authority.dispatchNotifications()
    assert.deepEqual(result,{attempted:3,delivered:1,retried:1})
    assert.equal(h.db.sqlite.prepare("SELECT provider_receipt FROM notification_deliveries WHERE intent_id='ack'").get().provider_receipt,'ack-1')
    const retry=h.db.sqlite.prepare("SELECT state,next_attempt_at_ms FROM notification_deliveries WHERE intent_id='retry'").get()
    assert.equal(retry.state,'retry'); assert.ok(retry.next_attempt_at_ms>h.now)
    assert.equal(h.db.sqlite.prepare("SELECT state FROM notification_deliveries WHERE intent_id='terminal'").get().state,'error')
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:0,delivered:0,retried:0})
  } finally { h.db.close() }
})
test('invalid FCM device token is terminal and quarantined from later intents', async () => {
  const h=createHarness()
  try {
    const authority=createD1Authority(h.db,{now:()=>h.now,fcmProtector:{async decrypt(){return 'invalid-device-token'}},notificationProvider:{async send(){throw Object.assign(new Error('invalid token'),{code:'FCM_DEVICE_TOKEN_INVALID',retryable:false})}}})
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    h.db.sqlite.prepare("INSERT INTO notification_intents VALUES('invalid-token-intent','h',NULL,'request-created','{}',?,NULL)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens(id,household_id,parent_id,token_hash,token_ciphertext,token_version,status,created_at_ms,rotated_at_ms,revoked_at_ms,last_operation_key) VALUES('invalid-token','h','parent','hash','cipher',1,'active',?,NULL,NULL,'k')").run(h.now)

    assert.deepEqual(await authority.dispatchNotifications(),{attempted:1,delivered:0,retried:0})
    assert.equal(h.db.sqlite.prepare("SELECT state FROM notification_deliveries WHERE token_id='invalid-token'").get().state,'error')
    assert.equal(h.db.sqlite.prepare("SELECT status FROM fcm_tokens WHERE id='invalid-token'").get().status,'quarantined')
    h.db.sqlite.prepare("INSERT INTO notification_intents VALUES('later-intent','h',NULL,'request-created','{}',?,NULL)").run(h.now+1)
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:0,delivered:0,retried:0})
  } finally { h.db.close() }
})

test('notification delivery failure preserves request and approval state across retry re-entry', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    await h.call('/v1/allowances',{householdId:'h',pcId:'pc',gameId:'game',expectedVersion:0,totalSeconds:600})
    const request={householdId:'h',requestId:'notify-state',pcId:'pc',gameId:'game',allowanceVersion:1,processId:'pid',processStartedAt:7}
    await h.call('/v1/requests',request,{idempotencyKey:'request-notify-state'})
    await h.call('/v1/fcm-tokens',{householdId:'h',token:'opaque-fcm-token-value-at-least-sixteen',tokenVersion:1},{idempotencyKey:'token-notify-state'})
    const firstApproval=await h.call('/v1/approve',{householdId:'h',requestId:'notify-state',minutes:5},{idempotencyKey:'approve-notify-state'})
    const authority=createD1Authority(h.db,{now:()=>h.now,fcmProtector:{async decrypt(){return 'provider-token'}},notificationProvider:{async send(){throw Object.assign(new Error('temporary'),{code:'PROVIDER_TRANSIENT',retryable:true})}}})

    assert.deepEqual(await authority.dispatchNotifications(),{attempted:2,delivered:0,retried:2})
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:0,delivered:0,retried:0})
    const replay=await h.call('/v1/approve',{householdId:'h',requestId:'notify-state',minutes:5},{idempotencyKey:'approve-notify-state'})

    assert.deepEqual(replay.payload,firstApproval.payload)
    assert.equal(h.db.sqlite.prepare("SELECT status FROM approval_requests WHERE id='notify-state'").get().status,'approved')
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM approval_grants WHERE request_id='notify-state'").get().count,1)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_intents WHERE request_id='notify-state' AND kind='grant-issued'").get().count,1)
  } finally { h.db.close() }
})

test('notification dispatch exposes missing production dependencies', async () => {
  const h=createHarness()
  try {
    const authority=createD1Authority(h.db,{now:()=>h.now})
    await assert.rejects(authority.dispatchNotifications(),(error)=>error.code==='DEPENDENCY_UNAVAILABLE')
  } finally {
    h.db.close()
  }
})
test('real SQLite D1-compatible HTTP lifecycle enforces winner side effects, one-use consume, and retry cache', async () => {
  const h = createHarness()
  try {
    const setupBody = { householdId: 'h', initialParentId: 'parent', publicJwk: '{"kty":"EC"}', enable: true }
    assert.equal((await h.call('/v1/households/setup', setupBody, { idempotencyKey: 'setup-1' })).status, 200)
    assert.equal((await h.call('/v1/households/setup', setupBody, { idempotencyKey: 'setup-1' })).status, 200)
    assert.equal((await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{"kty":"EC"}' })).status, 200)
    assert.equal((await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 3_600 })).status, 200)
    const request = { householdId: 'h', requestId: 'r1', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: '42', processStartedAt: 99 }
    assert.equal((await h.call('/v1/requests', request, { idempotencyKey: 'request-1' })).status, 200)
    assert.equal((await h.call('/v1/approve', { householdId: 'h', requestId: 'r1', minutes: 20 }, { idempotencyKey: 'approve-1' })).status, 200)
    assert.equal((await h.call('/v1/approve', { householdId: 'h', requestId: 'r1', minutes: 30 }, { idempotencyKey: 'approve-loser' })).status, 400)
    assert.equal((await h.call('/v1/approve', { householdId: 'h', requestId: 'r1', minutes: 30 }, { idempotencyKey: 'approve-loser' })).status, 400)
    assert.equal(h.db.sqlite.prepare("SELECT reserved_seconds FROM pc_daily_allowances WHERE household_id='h' AND game_id='roblox' AND version=1").get().reserved_seconds, 1_200)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_intents WHERE request_id='r1' AND kind='grant-issued'").get().count, 1)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_intents WHERE request_id='r1' AND kind='request-created'").get().count, 1)
    const consume = { ...request, processId: '84', processStartedAt: 199 }
    const firstConsume = await h.call('/v1/consume', consume, { idempotencyKey: 'consume-1' })
    assert.equal(firstConsume.status, 200)
    const retryConsume = await h.call('/v1/consume', consume, { idempotencyKey: 'consume-1' })
    assert.equal(retryConsume.status, 200)
    assert.equal((await h.call('/v1/consume', consume, { idempotencyKey: 'consume-second-key' })).status, 400)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM allowance_debits WHERE request_id='r1'").get().count, 1)
    assert.equal(h.db.sqlite.prepare("SELECT state FROM allowance_reservations WHERE request_id='r1'").get().state, 'settled')
    assert.equal(h.db.sqlite.prepare("SELECT process_id FROM approval_grants WHERE request_id='r1'").get().process_id, '84')
    const recoveredState = await h.call('/v1/pc/state?householdId=h&pcId=pc', null, { method: 'GET', idempotencyKey: 'state-after-consume' })
    assert.equal(recoveredState.status, 200)
    assert.equal(recoveredState.payload.grant.processId, '84')
    assert.equal(recoveredState.payload.grant.processStartedAt, 199)
    assert.equal(h.db.sqlite.prepare("SELECT process_started_at FROM approval_grants WHERE request_id='r1'").get().process_started_at, 199)
  } finally {
    h.db.close()
  }
})

test('real schema rejects cross-household PC takeover and refunds expiry/disable reservations', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-h' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 1_800 })
    assert.equal((await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 9_999 })).status, 400)
    const request = { householdId: 'h', requestId: 'r-expire', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: '43', processStartedAt: 100 }
    await h.call('/v1/requests', request)
    await h.call('/v1/approve', { householdId: 'h', requestId: 'r-expire', minutes: 10 })
    assert.equal(h.db.sqlite.prepare("SELECT reserved_seconds FROM pc_daily_allowances WHERE household_id='h'").get().reserved_seconds, 600)
    h.setNow(h.now + 300_001)
    await Promise.all([
      h.call('/v1/requests?householdId=h', null, { method: 'GET' }),
      h.call('/v1/requests?householdId=h', null, { method: 'GET' }),
    ])
    assert.equal(h.db.sqlite.prepare("SELECT reserved_seconds FROM pc_daily_allowances WHERE household_id='h'").get().reserved_seconds, 0)
    assert.equal(h.db.sqlite.prepare("SELECT state FROM allowance_reservations WHERE request_id='r-expire'").get().state, 'released')
    const disableRequest = { ...request, requestId: 'r-disable', processId: '44', processStartedAt: 101 }
    assert.equal((await h.call('/v1/requests', disableRequest)).status, 200)
    assert.equal((await h.call('/v1/approve', { householdId: 'h', requestId: 'r-disable', minutes: 5 })).status, 200)
    assert.equal(h.db.sqlite.prepare("SELECT reserved_seconds FROM pc_daily_allowances WHERE household_id='h'").get().reserved_seconds, 300)
    assert.equal((await h.call('/v1/disable', { householdId: 'h' })).status, 200)
    assert.equal(h.db.sqlite.prepare("SELECT reserved_seconds FROM pc_daily_allowances WHERE household_id='h'").get().reserved_seconds, 0)
    assert.equal(h.db.sqlite.prepare("SELECT state FROM allowance_reservations WHERE request_id='r-disable'").get().state, 'released')

    assert.equal((await h.call('/v1/households/setup', { householdId: 'h2', initialParentId: 'parent2', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-h2' })).status, 200)
    assert.equal((await h.call('/v1/pcs', { householdId: 'h2', pcId: 'pc', publicKey: '{\"replacement\":true}' })).status, 400)
    assert.equal(h.db.sqlite.prepare("SELECT household_id FROM pcs WHERE id='pc'").get().household_id, 'h')
  } finally {
    h.db.close()
  }
})

test('adding another household does not advance the global epoch or invalidate an existing grant', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-a' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId: 'h', gameId: 'roblox', version: 1, remainingSeconds: 600 })
    const request = { householdId: 'h', requestId: 'r-cross', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, processId: '55', processStartedAt: 200 }
    await h.call('/v1/requests', request)
    await h.call('/v1/approve', { householdId: 'h', requestId: 'r-cross', minutes: 5 })
    await h.call('/v1/households/setup', { householdId: 'h2', initialParentId: 'parent2', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-b' })
    assert.equal(h.db.sqlite.prepare("SELECT service_epoch FROM environments WHERE id='global'").get().service_epoch, 1)
    assert.equal((await h.call('/v1/consume', request, { idempotencyKey: 'consume-cross' })).status, 200)
  } finally {
    h.db.close()
  }
})

test('setup parent collision rolls back household creation and leaves local-only mode unchanged', async () => {
  const h = createHarness()
  try {
    h.db.sqlite.prepare(`
      INSERT INTO households(id,setup_token,remote_enabled,service_epoch,membership_epoch,deleted_at_ms,last_operation_key)
      VALUES('existing','seed',0,1,1,NULL,NULL)
    `).run()
    h.db.sqlite.prepare(`
      INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms)
      VALUES('taken-parent','existing','{}','active',1,0)
    `).run()

    const result = await h.call('/v1/households/setup', {
      householdId: 'new-household',
      initialParentId: 'taken-parent',
      publicJwk: '{}',
      enable: true,
    }, { idempotencyKey: 'setup-collision' })

    assert.equal(result.status, 400)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM households WHERE id='new-household'").get().count, 0)
    assert.equal(h.db.sqlite.prepare("SELECT mode FROM environments WHERE id='global'").get().mode, 'REMOTE_ENABLED')
  } finally {
    h.db.close()
  }
})

test('reset atomically installs a recovery parent that can administer the new epoch', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', {
      householdId: 'h',
      initialParentId: 'parent',
      publicJwk: '{"old":true}',
      enable: true,
    }, { idempotencyKey: 'setup-reset' })

    const resetBody = {
      householdId: 'h',
      recoveryParentId: 'parent-new',
      recoveryPublicJwk: '{"new":true}',
    }
    const first = await h.call('/v1/reset', resetBody, { idempotencyKey: 'reset-1' })
    assert.equal(first.status, 200)
    assert.equal(first.payload.parent_id, 'parent-new')
    assert.equal(first.payload.membership_epoch, 2)
    assert.equal(first.payload.service_epoch, 1)
    assert.equal((await h.call('/v1/reset', resetBody, { idempotencyKey: 'reset-1' })).status, 200)
    h.db.sqlite.prepare("DELETE FROM idempotency_commit_assertions WHERE idempotency_key='reset-1'").run()
    h.db.sqlite.prepare("DELETE FROM idempotency_records WHERE idempotency_key='reset-1'").run()
    const reconciled=await h.call('/v1/reset/reconcile?householdId=h',null,{method:'GET',actorId:'parent-new',idempotencyKey:'reset-1'})
    assert.equal(reconciled.status,200)
    assert.equal(reconciled.payload.membership_epoch,2)
    assert.equal(reconciled.payload.parent_id,'parent-new')

    const oldParent = await h.call('/v1/pcs', {
      householdId: 'h',
      pcId: 'old-parent-pc',
      publicKey: '{}',
    }, { actorId: 'parent' })
    assert.equal(oldParent.status, 403)

    const recovered = await h.call('/v1/pcs', {
      householdId: 'h',
      pcId: 'recovered-pc',
      publicKey: '{}',
    }, { actorId: 'parent-new' })
    assert.equal(recovered.status, 200)
    assert.equal(h.db.sqlite.prepare("SELECT status FROM parent_devices WHERE id='parent-new'").get().status, 'active')
    assert.equal(h.db.sqlite.prepare("SELECT status FROM parent_devices WHERE id='parent'").get().status, 'revoked')
  } finally {
    h.db.close()
  }
})
test('a durable claim without a mutation retries by executing exactly once', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-claim' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    const request = { householdId: 'h', requestId: 'claimed-request', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, ianaTimeZone:'UTC', ianaDay:'1970-01-01', processId: '77', processStartedAt: 300 }
    await h.call('/v1/allowances', { householdId:'h',pcId:'pc',gameId:'roblox',ianaTimeZone:'UTC',ianaDay:'1970-01-01',expectedVersion:0,totalSeconds:600 })
    const raw = JSON.stringify(request)
    h.db.sqlite.prepare(`INSERT INTO idempotency_records(actor_id,membership_epoch,idempotency_key,operation_digest,owner_token,lease_expires_at_ms,result_json,expires_at_ms) VALUES(?,?,?,?,?,?,NULL,?)`).run('pc', 1, 'claimed', `POST:https://remote.test/v1/requests:${raw}`, 'abandoned-owner', h.now - 1, h.now + 300_000)
    const result = await h.call('/v1/requests', request, { idempotencyKey: 'claimed' })
    assert.equal(result.status, 200)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE id='claimed-request'").get().count, 1)
    assert.ok(h.db.sqlite.prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key='claimed'").get().result_json)
  } finally {
    h.db.close()
  }
})

test('committed mutation retry returns the identical compact receipt', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-receipt' })
    const body = { householdId: 'h', pcId: 'pc', publicKey: '{}' }
    const first = await h.call('/v1/pcs', body, { idempotencyKey: 'pc-receipt' })
    const retry = await h.call('/v1/pcs', body, { idempotencyKey: 'pc-receipt' })
    assert.equal(retry.status, first.status)
    assert.deepEqual(retry.payload, first.payload)
    assert.equal(JSON.stringify(retry.payload), JSON.stringify(first.payload))
  } finally {
    h.db.close()
  }
})
test('two Worker instances return one immutable receipt for concurrent same-key mutation', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true }, { idempotencyKey: 'setup-concurrent' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId:'h',pcId:'pc',gameId:'roblox',ianaTimeZone:'UTC',ianaDay:'1970-01-01',expectedVersion:0,totalSeconds:600 })
    const first = createWorker({ db: h.db, authenticator: h.authenticator, now: () => h.now, pairingTokenSecret: 'test-pairing-token-secret-that-is-at-least-32-bytes' })
    const second = createWorker({ db: h.db, authenticator: h.authenticator, now: () => h.now, pairingTokenSecret: 'test-pairing-token-secret-that-is-at-least-32-bytes' })
    const body = JSON.stringify({ householdId: 'h', requestId: 'race-request', pcId: 'pc', gameId: 'roblox', allowanceVersion: 1, ianaTimeZone:'UTC', ianaDay:'1970-01-01', processId: '88', processStartedAt: 400 })
    const request = () => new Request('https://remote.test/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': 'race-key' }, body })
    const [a, b] = await Promise.all([first.fetch(request()), second.fetch(request())])
    const firstText = await a.text()
    const secondText = await b.text()
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(firstText, secondText)
    const later = await first.fetch(request())
    assert.equal(await later.text(), firstText)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE id='race-request'").get().count, 1)
  } finally {
    h.db.close()
  }
})

test('a stale lease owner cannot commit business writes after ownership changes', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', {
      householdId: 'h',
      initialParentId: 'parent',
      publicJwk: '{}',
      enable: true,
    }, { idempotencyKey: 'setup-fence' })

    const digest = 'POST:https://remote.test/v1/allowances:stale-owner'
    h.db.sqlite.prepare(`
      INSERT INTO idempotency_records(
        actor_id,membership_epoch,idempotency_key,operation_digest,
        owner_token,lease_expires_at_ms,result_json,expires_at_ms
      ) VALUES('parent',1,'stale-owner',?,'new-owner',2000000,NULL,3000000)
    `).run(digest)

    const authority = createD1Authority(h.db, { now: () => h.now })
    const receipt = JSON.stringify({
      operation: 'setAllowance',
      household_id: 'h',
      game_id: 'roblox',
      version: 1,
    })

    await assert.rejects(authority.withCommit({
      actorId: 'parent',
      membershipEpoch: 1,
      idempotencyKey: 'stale-owner',
      operationDigest: digest,
      ownerToken: 'old-owner',
      receipt,
    }, () => authority.setAllowance({
      householdId: 'h',
      actorId: 'parent',
      gameId: 'roblox',
      version: 1,
      remainingSeconds: 600,
      operationKey: 'stale-owner',
    })))

    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM pc_daily_allowances WHERE household_id='h'").get().count, 0)
  } finally {
    h.db.close()
  }
})
test('active peers may issue pairing and disable; a device cannot revoke itself', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', permissions: { create: true, respond_or_issue: true, consume: true } }, { idempotencyKey: 'setup-admin' })
    await h.call('/v1/parents', { householdId: 'h', parentId: 'ordinary', publicJwk: '{}' })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    const issued = await h.call('/v1/pairing-sessions', { householdId: 'h', pcId: 'pc' }, { actorId: 'ordinary' })
    assert.equal(issued.status, 200)
    assert.equal(issued.headers.get('cache-control'), 'no-store')
    assert.equal(h.db.sqlite.prepare("SELECT result_json FROM idempotency_records WHERE actor_id='ordinary' ORDER BY expires_at_ms DESC LIMIT 1").get().result_json.includes(issued.payload.token), false)
    assert.equal((await h.call('/v1/disable', { householdId: 'h' }, { actorId: 'ordinary' })).status, 200)
  } finally { h.db.close() }
})

test('malformed identity tuples, approval bounds, and duplicate active process requests fail', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}' })
    await h.call('/v1/allowances', { householdId: 'h', gameId: 'game', version: 1, remainingSeconds: 20_000 })
    const request = { householdId: 'h', requestId: 'r', pcId: 'pc', gameId: 'game', allowanceVersion: 1, processId: 'pid', processStartedAt: 1 }
    assert.equal((await h.call('/v1/requests', { ...request, allowanceVersion: '1' })).status, 400)
    assert.equal((await h.call('/v1/requests', request)).status, 200)
    const duplicate = await h.call('/v1/requests', { ...request, requestId: 'r2', processId: 'different-pid', processStartedAt: 2 })
    assert.equal(duplicate.status, 400)
    assert.equal(duplicate.payload.error, 'ACTIVE_REQUEST_EXISTS', JSON.stringify(duplicate.payload))
    assert.equal((await h.call('/v1/approve', { householdId: 'h', requestId: 'r', minutes: 241 })).status, 400)
  } finally { h.db.close() }
})
test('active parents have equal peer revoke authority while self-revoke is denied', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', permissions: { create: true, respond_or_issue: true, consume: true } })
    await h.call('/v1/parents', { householdId: 'h', parentId: 'ordinary', publicJwk: '{}' })
    assert.equal((await h.call('/v1/parents', { householdId: 'h', parentId: 'parent' }, { method: 'DELETE', actorId: 'ordinary' })).status, 200)
    assert.equal((await h.call('/v1/parents', { householdId: 'h', parentId: 'ordinary' }, { method: 'DELETE', actorId: 'ordinary' })).status, 403)
  } finally { h.db.close() }
})
test('per-PC local-day allowance CAS validates IANA day and cannot lower below reserved state', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', permissions: { create: true, respond_or_issue: true, consume: true } })
    await h.call('/v1/pcs', { householdId: 'h', pcId: 'pc', publicKey: '{}', ianaTimeZone:'America/Los_Angeles' })
    assert.equal((await h.call('/v1/pcs', { householdId:'h', pcId:'bad-zone', publicKey:'{}', ianaTimeZone:'not/a-zone' })).status,400)
    const allowance = { householdId:'h', pcId:'pc', gameId:'game', ianaTimeZone:'America/Los_Angeles', ianaDay:'1969-12-31', expectedVersion:0, totalSeconds:600 }
    { const response=await h.call('/v1/allowances', allowance); assert.equal(response.status, 200, JSON.stringify(response.payload)) }
    assert.equal((await h.call('/v1/allowances', { ...allowance, expectedVersion:0, totalSeconds:900 })).status, 400)
    h.db.sqlite.prepare("UPDATE pc_daily_allowances SET reserved_seconds=500 WHERE household_id='h' AND pc_id='pc' AND game_id='game'").run()
    assert.equal((await h.call('/v1/allowances', { ...allowance, expectedVersion:1, totalSeconds:499 })).status, 400)
    assert.equal((await h.call('/v1/allowances', { ...allowance, ianaDay:'1970-01-01', expectedVersion:1, totalSeconds:900 })).status, 200)
  } finally { h.db.close() }
})
test('IANA local-day keys remain deterministic through DST spring and fall boundaries', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId:'h', initialParentId:'parent', publicJwk:'{}', permissions:{create:true,respond_or_issue:true,consume:true} })
    await h.call('/v1/pcs', { householdId:'h', pcId:'pc', publicKey:'{}', ianaTimeZone:'America/Los_Angeles' })
    h.setNow(Date.parse('2024-03-10T10:00:00Z'))
    assert.equal((await h.call('/v1/allowances', { householdId:'h',pcId:'pc',gameId:'spring',ianaTimeZone:'America/Los_Angeles',ianaDay:'2024-03-10',expectedVersion:0,totalSeconds:60 })).status,200)
    h.setNow(Date.parse('2024-11-03T10:00:00Z'))
    assert.equal((await h.call('/v1/allowances', { householdId:'h',pcId:'pc',gameId:'fall',ianaTimeZone:'America/Los_Angeles',ianaDay:'2024-11-03',expectedVersion:0,totalSeconds:60 })).status,200)
  } finally { h.db.close() }
})
test('a running consumed session preserves committed use and later starts are denied after reduction', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}',permissions:{create:true,respond_or_issue:true,consume:true}})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    const allowance={householdId:'h',pcId:'pc',gameId:'game',ianaTimeZone:'UTC',ianaDay:'1970-01-01',expectedVersion:0,totalSeconds:300}
    await h.call('/v1/allowances',allowance)
    const running={householdId:'h',requestId:'running',pcId:'pc',gameId:'game',allowanceVersion:1,ianaTimeZone:'UTC',ianaDay:'1970-01-01',processId:'one',processStartedAt:1}
    await h.call('/v1/requests',running); await h.call('/v1/approve',{householdId:'h',requestId:'running',minutes:5}); assert.equal((await h.call('/v1/consume',running)).status,200)
    assert.equal((await h.call('/v1/allowances',{...allowance,expectedVersion:1,totalSeconds:299})).status,400)
    h.setNow(h.now + 300_001)
    const later={...running,requestId:'later',allowanceVersion:1,processId:'two',processStartedAt:2}
    assert.equal((await h.call('/v1/requests',later)).status,200)
    assert.equal((await h.call('/v1/approve',{householdId:'h',requestId:'later',minutes:1})).status,400)
  } finally { h.db.close() }
})

test('delete reconciliation survives idempotency receipt loss for the original administrator', async () => {
  const h = createHarness()
  try {
    await h.call('/v1/households/setup', { householdId: 'h', initialParentId: 'parent', publicJwk: '{}', enable: true })
    const deleted=await h.call('/v1/household', { householdId: 'h' }, { method: 'DELETE', idempotencyKey: 'delete-loss' })
    assert.equal(deleted.status, 200)
    h.db.sqlite.prepare("DELETE FROM idempotency_commit_assertions WHERE idempotency_key='delete-loss'").run()
    h.db.sqlite.prepare("DELETE FROM idempotency_records WHERE idempotency_key='delete-loss'").run()
    const reconciled=await h.call('/v1/delete/reconcile?householdId=h&operationKey=delete-loss', null, { method: 'GET', actorId: 'parent', idempotencyKey: 'delete-loss' })
    assert.equal(reconciled.status, 200)
    assert.equal(reconciled.payload.last_operation_key, 'delete-loss')
    assert.ok(reconciled.payload.deleted_at_ms)
    const purgeAfter=h.db.sqlite.prepare("SELECT purge_after_ms FROM households WHERE id='h'").get().purge_after_ms
    h.setNow(purgeAfter + 1)
    const purgeResult=await createD1Authority(h.db,{now:()=>h.now}).purgeDeleted()
    assert.equal(purgeResult.purged,1)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM households WHERE id='h'").get().count, 0)
    const receiptExpiry=h.db.sqlite.prepare("SELECT expires_at_ms FROM deletion_receipts WHERE household_id='h'").get().expires_at_ms
    const tombstoneExpiry=h.db.sqlite.prepare("SELECT expires_at_ms FROM delete_tombstones WHERE household_id='h'").get().expires_at_ms
    assert.equal(receiptExpiry,tombstoneExpiry)
    h.setNow(receiptExpiry - 1)
    const finalWindow=await h.call('/v1/delete/reconcile?householdId=h&operationKey=delete-loss', null, { method:'GET', actorId:'parent', idempotencyKey:'delete-loss' })
    assert.equal(finalWindow.status,200)
    assert.equal(finalWindow.payload.last_operation_key,'delete-loss')
  } finally { h.db.close() }
})
test('operator cleanup immediately purges only explicitly synthetic staging households', async () => {
  const h=createHarness()
  try {
    const syntheticId='11111111-1111-4111-8111-111111111111'
    const householdId=`household-staging-${syntheticId}`
    await h.call('/v1/households/setup',{householdId,initialParentId:'parent',publicJwk:'{}'},{idempotencyKey:`synthetic:${syntheticId}`})
    h.db.sqlite.prepare("INSERT INTO operator_authorities VALUES('staging-operator','{}','active',?)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO telemetry VALUES('synthetic-event',?,'event',?,'{}')").run(householdId,h.now)
    h.db.sqlite.prepare("INSERT INTO rate_windows VALUES(?,?,1)").run('mutation:parent',1)
    h.db.sqlite.prepare("INSERT INTO rate_windows VALUES(?,?,1)").run(`telemetry:${householdId}`,1)
    const authority=createD1Authority(h.db,{now:()=>h.now})
    const result=await authority.operatorPurgeSynthetic({householdId,actorId:'staging-operator',operationKey:'cleanup-1'})
    assert.equal(result.purged,true)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM households WHERE id=?').get(householdId).count,0)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM parent_devices WHERE household_id=?').get(householdId).count,0)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM telemetry WHERE household_id=?').get(householdId).count,0)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM rate_windows WHERE scope IN('mutation:parent',?)").get(`telemetry:${householdId}`).count,0)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM delete_tombstones WHERE household_id=?').get(householdId).count,1)
    const replay=await authority.operatorPurgeSynthetic({householdId,actorId:'staging-operator',operationKey:'cleanup-retry'})
    assert.equal(replay.purged,true);assert.equal(replay.operationKey,'cleanup-1')
    const fcmSyntheticId='22222222-2222-4222-8222-222222222222'
    const fcmHouseholdId=`household-fcm-${fcmSyntheticId}`
    await h.call('/v1/households/setup',{householdId:fcmHouseholdId,initialParentId:'fcm-parent',publicJwk:'{}'},{idempotencyKey:`synthetic:${fcmSyntheticId}`})
    const fcmResult=await authority.operatorPurgeSynthetic({householdId:fcmHouseholdId,actorId:'staging-operator',operationKey:'cleanup-fcm'})
    assert.equal(fcmResult.purged,true)
    const legitimateId='household-staging-33333333-3333-4333-8333-333333333333'
    await h.call('/v1/households/setup',{householdId:legitimateId,initialParentId:'legitimate-parent',publicJwk:'{}'})
    await assert.rejects(authority.operatorPurgeSynthetic({householdId:legitimateId,actorId:'staging-operator',operationKey:'cleanup-legitimate'}),/SYNTHETIC_CLEANUP_REQUIRED/)
    assert.equal(h.db.sqlite.prepare('SELECT COUNT(*) AS count FROM households WHERE id=?').get(legitimateId).count,1)
    await assert.rejects(authority.operatorPurgeSynthetic({householdId:'household-staging-33333333-3333-4333-8333-333333333333-extra',actorId:'staging-operator',operationKey:'cleanup-malformed'}),/SYNTHETIC_CLEANUP_REQUIRED/)
    await assert.rejects(authority.operatorPurgeSynthetic({householdId:'production-family',actorId:'staging-operator',operationKey:'cleanup-2'}),/SYNTHETIC_CLEANUP_REQUIRED/)
  } finally { h.db.close() }
})

test('bounded purge removes only due household personal data and tombstone prevents resurrection', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/households/setup',{householdId:'h2',initialParentId:'parent2',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    await h.call('/v1/pcs',{householdId:'h2',pcId:'pc2',publicKey:'{}'})
    h.db.sqlite.prepare("INSERT INTO telemetry VALUES('t','h','event',?,'{}')").run(h.now)
    h.db.sqlite.prepare("INSERT INTO telemetry VALUES('t2','h2','event',?,'{}')").run(h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens(id,household_id,parent_id,token_hash,token_ciphertext,token_version,status,created_at_ms,rotated_at_ms,revoked_at_ms,last_operation_key) VALUES('f','h','parent','hash-h','cipher',1,'active',?,NULL,NULL,'k')").run(h.now)
    h.db.sqlite.prepare("INSERT INTO notification_intents VALUES('i','h',NULL,'event','{}',?,NULL)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO notification_deliveries VALUES('d','i','f',1,'pending',NULL,NULL,NULL,?,NULL)").run(h.now)
    h.db.sqlite.prepare("UPDATE households SET deleted_at_ms=?,delete_state='pending_purge',purge_after_ms=?,last_operation_key='delete-h' WHERE id='h'").run(h.now,h.now)
    const authority=createD1Authority(h.db,{now:()=>h.now})
    assert.deepEqual(await authority.purgeDeleted(h.now,1),{purged:1})
    for(const [table,column,value] of [['households','id','h'],['pcs','household_id','h'],['parent_devices','household_id','h'],['telemetry','household_id','h'],['fcm_tokens','household_id','h'],['notification_intents','household_id','h'],['notification_deliveries','intent_id','i'],['setup_commits','household_id','h']]) assert.equal(h.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(value).count,0,table)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE json_extract(result_json,'$.household_id')='h'").get().count,0)
    assert.ok(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE json_extract(result_json,'$.household_id')='h2'").get().count>0)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM delete_tombstones WHERE household_id='h'").get().count,1)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM deletion_observations WHERE household_id=? AND state='purged'").get(await hashSecret('h')).count,1)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM households WHERE id='h2'").get().count,1)
    assert.deepEqual(await authority.purgeDeleted(h.now,1),{purged:0})
    assert.equal((await h.call('/v1/households/setup',{householdId:'h',initialParentId:'new-parent',publicJwk:'{}'})).status,400)
    h.db.sqlite.prepare("INSERT INTO households(id,setup_token,remote_enabled,service_epoch,membership_epoch) VALUES('h','restored-token',1,1,1)").run()
    h.db.sqlite.prepare("INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) VALUES('restored-parent','h','{}','active',1,?)").run(h.now)
    assert.deepEqual(await authority.purgeDeleted(h.now+1,1),{purged:1})
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM households WHERE id='h'").get().count,0)
    const retentionEnd=h.now+90*24*60*60*1000+2
    assert.deepEqual(await authority.purgeDeleted(retentionEnd,1),{purged:0})
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM delete_tombstones WHERE household_id='h'").get().count,0)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM deletion_observations WHERE household_id=?").get(await hashSecret('h')).count,0)
  } finally { h.db.close() }
})
test('one intent completes only after each active parent token reaches a terminal result', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    h.db.sqlite.prepare("INSERT INTO parent_devices VALUES('parent2','h','{}','active',1,?)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO parent_devices VALUES('parent3','h','{}','active',1,?)").run(h.now+1)
    h.db.sqlite.prepare("INSERT INTO notification_intents VALUES('mixed','h',NULL,'event','{}',?,NULL)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens VALUES('a','h','parent','ha','ca',1,'active',?,NULL,NULL,'k')").run(h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens VALUES('b','h','parent2','hb','cb',1,'active',?,NULL,NULL,'k')").run(h.now)
    h.db.sqlite.prepare("INSERT INTO fcm_tokens VALUES('late','h','parent3','hc','cc',1,'active',?,NULL,NULL,'k')").run(h.now+1)
    let bAttempts=0
    const authority=createD1Authority(h.db,{now:()=>h.now,fcmProtector:{async decrypt(value){return value}},notificationProvider:{async send({token}) { if(token==='cb' && bAttempts++===0) throw Object.assign(new Error('transient'),{code:'PROVIDER_TRANSIENT'}); return `ack-${token}` }}})
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:2,delivered:1,retried:1})
    assert.equal(h.db.sqlite.prepare("SELECT delivered_at_ms FROM notification_intents WHERE id='mixed'").get().delivered_at_ms,null)
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:0,delivered:0,retried:0})
    h.setNow(h.now+60_000)
    assert.deepEqual(await authority.dispatchNotifications(),{attempted:1,delivered:1,retried:0})
    assert.ok(h.db.sqlite.prepare("SELECT delivered_at_ms FROM notification_intents WHERE id='mixed'").get().delivered_at_ms)
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE token_id='late'").get().count,0)
  } finally { h.db.close() }
})
test('reset removes old FCM rows so recovered parent may register token version one', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    const authority=createD1Authority(h.db,{now:()=>h.now,fcmProtector:{async encrypt(){return 'cipher'}}})
    await authority.registerFcmToken({householdId:'h',actorId:'parent',token:'token-value-at-least-sixteen',tokenVersion:1,operationKey:'old'})
    await authority.reset({householdId:'h',actorId:'parent',operationKey:'reset',recoveryParentId:'parent-new',recoveryPublicJwk:'{}'})
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS count FROM fcm_tokens WHERE household_id='h'").get().count,0)
    assert.equal((await authority.registerFcmToken({householdId:'h',actorId:'parent-new',token:'new-token-value-at-least',tokenVersion:1,operationKey:'new'})).token_version,1)
  } finally { h.db.close() }
})
test('allowance and consume HTTP envelopes use authoritative persisted values and replay byte-identically', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}'})
    const allowance=await h.call('/v1/allowances',{householdId:'h',pcId:'pc',gameId:'game',expectedVersion:0,totalSeconds:600},{idempotencyKey:'allowance'})
    assert.deepEqual(allowance.payload,{v:1,serverNowMs:h.now,allowance:{pcId:'pc',gameId:'game',ianaTimeZone:'UTC',ianaDay:'1970-01-01',allowanceVersion:1,totalSeconds:600,committedSeconds:0,reservedSeconds:0}})
    const request={householdId:'h',requestId:'consume-envelope',pcId:'pc',gameId:'game',allowanceVersion:1,processId:'pid',processStartedAt:7}
    await h.call('/v1/requests',request)
    await h.call('/v1/approve',{householdId:'h',requestId:'consume-envelope',minutes:5})
    const first=await h.call('/v1/consume',request,{idempotencyKey:'consume-envelope'})
    const second=await h.call('/v1/consume',request,{idempotencyKey:'consume-envelope'})
    assert.deepEqual(second.payload,first.payload)
    assert.deepEqual(first.payload,{v:1,serverNowMs:h.now,grant:{grantId:'consume-envelope',allowanceReservationId:'consume-envelope',householdId:'h',requestId:'consume-envelope',pcId:'pc',gameId:'game',allowanceVersion:1,processId:'pid',processStartedAt:7,membershipEpoch:1,serviceEpoch:1,approvedMinutes:5,grantedAt:h.now,expiresAt:h.now+300000,launchGame:false}})
    h.db.sqlite.prepare("UPDATE pc_daily_allowances SET reserved_seconds=300 WHERE household_id='h' AND pc_id='pc' AND game_id='game' AND version=1").run()
    assert.equal(h.db.sqlite.prepare("SELECT version FROM pc_daily_allowances WHERE household_id='h' AND pc_id='pc' AND game_id='game'").get().version,1)
    const updated=await h.call('/v1/allowances',{householdId:'h',pcId:'pc',gameId:'game',expectedVersion:1,totalSeconds:601},{idempotencyKey:'allowance-nonzero'})
    assert.deepEqual(updated.payload,{v:1,serverNowMs:h.now,allowance:{pcId:'pc',gameId:'game',ianaTimeZone:'UTC',ianaDay:'1970-01-01',allowanceVersion:2,totalSeconds:601,committedSeconds:300,reservedSeconds:300}})
    assert.deepEqual((await h.call('/v1/allowances',{householdId:'h',pcId:'pc',gameId:'game',expectedVersion:1,totalSeconds:601},{idempotencyKey:'allowance-nonzero'})).payload,updated.payload)
  } finally { h.db.close() }
})
test('parent state exposes only current-day editable allowances with per-PC IANA authority', async () => {
  const h=createHarness()
  try {
    await h.call('/v1/households/setup',{householdId:'h',initialParentId:'parent',publicJwk:'{}'})
    await h.call('/v1/pcs',{householdId:'h',pcId:'pc',publicKey:'{}',ianaTimeZone:'America/Los_Angeles'})
    h.db.sqlite.prepare("INSERT INTO pc_daily_allowances VALUES('h','pc','today','1969-12-31','America/Los_Angeles',600,60,30,1,?)").run(h.now)
    h.db.sqlite.prepare("INSERT INTO pc_daily_allowances VALUES('h','pc','old','1969-12-30','America/Los_Angeles',600,0,0,1,?)").run(h.now)
    const state=await h.call('/v1/parent/state?householdId=h',null,{method:'GET'})
    assert.equal(state.status,200)
    assert.equal(state.payload.v,1)
    assert.equal(state.payload.serverNowMs,h.now)
    assert.deepEqual(state.payload.devices[0],{id:'parent',name:'parent',platform:'Android',status:'active',registeredAt:h.now})
    assert.deepEqual(state.payload.allowances.map((allowance)=>allowance.gameId),['today'])
    assert.equal(state.payload.allowances[0].ianaTimeZone,'America/Los_Angeles')
    assert.equal(state.payload.allowances[0].ianaDay,'1969-12-31')
  } finally { h.db.close() }
})
