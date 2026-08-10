import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createMemoryAuthority, createWorker } from '../remote-backend/src/worker.mjs'
import { createAuthenticator, contentDigest } from '../remote-backend/src/authenticator.mjs'
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const pairingEpochMigration = readFileSync(fileURLToPath(new URL('../remote-backend/migrations/0001_pairing_dual_service_epochs.sql', import.meta.url)), 'utf8')
const controlAuditMigration = readFileSync(fileURLToPath(new URL('../remote-backend/migrations/0002_atomic_permission_control_audit.sql', import.meta.url)), 'utf8')
const deletionReceiptMigration = readFileSync(fileURLToPath(new URL('../remote-backend/migrations/0003_authenticated_deletion_receipts.sql', import.meta.url)), 'utf8')
test('pairing dual-service-epoch migration revokes stale legacy sessions rather than inventing independent authority epochs', () => {
  assert.match(pairingEpochMigration, /ADD COLUMN global_service_epoch INTEGER NOT NULL DEFAULT 0/)
  assert.match(pairingEpochMigration, /ADD COLUMN household_service_epoch INTEGER NOT NULL DEFAULT 0/)
  assert.match(pairingEpochMigration, /SET revoked_at_ms/)
  assert.match(pairingEpochMigration, /expires_at_ms = CASE WHEN used_at_ms IS NULL THEN 0/)
  assert.doesNotMatch(pairingEpochMigration, /global_service_epoch = service_epoch/)
})
test('pairing epoch migration executes against legacy rows and revokes only unredeemed sessions', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE pairing_sessions(id TEXT PRIMARY KEY, used_at_ms INTEGER, revoked_at_ms INTEGER, expires_at_ms INTEGER NOT NULL) STRICT')
    db.exec("INSERT INTO pairing_sessions VALUES('unused',NULL,NULL,9999),('used',1000,NULL,9999)")
    db.exec(pairingEpochMigration)
    assert.deepEqual(db.prepare('SELECT id,used_at_ms,revoked_at_ms,expires_at_ms,global_service_epoch,household_service_epoch FROM pairing_sessions ORDER BY id').all().map((row) => ({ ...row })), [
      { id:'unused', used_at_ms:null, revoked_at_ms:0, expires_at_ms:0, global_service_epoch:0, household_service_epoch:0 },
      { id:'used', used_at_ms:1000, revoked_at_ms:null, expires_at_ms:9999, global_service_epoch:0, household_service_epoch:0 },
    ])
  } finally {
    db.close()
  }
})
test('permission-control migration makes audit insertion trigger-atomic', () => {
  assert.match(controlAuditMigration, /AFTER UPDATE OF control_version ON environments/)
  assert.match(controlAuditMigration, /AFTER UPDATE OF control_version ON households/)
  assert.match(controlAuditMigration, /NEW\.control_version = OLD\.control_version \+ 1/)
  assert.match(controlAuditMigration, /INSERT INTO permission_control_audit/)
})
test('deletion receipt migration retains the operation-bound verifier required after purge', () => {
  assert.match(deletionReceiptMigration, /CREATE TABLE IF NOT EXISTS deletion_receipts/)
  assert.match(deletionReceiptMigration, /operation_key TEXT NOT NULL/)
  assert.match(deletionReceiptMigration, /public_jwk TEXT NOT NULL CHECK\(json_valid\(public_jwk\)\)/)
  assert.match(deletionReceiptMigration, /membership_epoch INTEGER NOT NULL/)
  assert.match(deletionReceiptMigration, /service_epoch INTEGER NOT NULL/)
  assert.match(deletionReceiptMigration, /expires_at_ms INTEGER NOT NULL/)
})
let clock = 1_000_000
const make = () => { clock = 1_000_000; const a = createMemoryAuthority({ now: () => clock }); a.setup({ householdId:'h', parentId:'p1', publicJwk:'public-jwk', permissions:{create:true,respond_or_issue:true,consume:true} }); return a }
let n = 0
const proof = () => ({ jti:`j${++n}`, nonce:`n${n}`, idempotencyKey:`i${n}` })
const request = (overrides = {}) => ({ householdId:'h',requestId:'r',pcId:'pc',gameId:'game',allowanceVersion:7,processId:'42',processStartedAt:99,...overrides })
const prepare = (a) => { a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'pc-public',...proof()}); return a.createRequest(request()) }
const rejects = (fn, code) => assert.throws(fn, (e) => e.code === code)

test('defaults fail closed and setup exposes only public parent key records', () => {
  const a=createMemoryAuthority({now:()=>clock}); rejects(()=>a.createRequest(request()),'NOT_FOUND')
  rejects(()=>a.setup({householdId:'h',parentId:'p1',publicJwk:'jwk',mode:'LOCAL_ONLY'}),'BAD_PERMISSIONS')
  const result=a.setup({householdId:'h',parentId:'p1',publicJwk:'jwk',mode:'LOCAL_ONLY',permissions:{create:false,respond_or_issue:false,consume:false}})
  assert.equal(result.serviceEpoch,1); rejects(()=>a.createRequest(request()),'REMOTE_UNAVAILABLE')
  assert.equal(a.state.devices.get('p1').publicJwk,'jwk'); assert.equal('privateKey' in a.state.devices.get('p1'),false)
})

test('equal active parents may register and list requests, while invalid actors cannot', () => {
  const a=make(); a.addParent({householdId:'h',actorId:'p1',parentId:'p2',publicJwk:'p2',...proof()}); prepare(a)
  assert.equal(a.getRequest({householdId:'h',actorId:'p2',requestId:'r'}).status,'pending')
  assert.equal(a.listRequests({householdId:'h',actorId:'p2'}).length,1)
  rejects(()=>a.listRequests({householdId:'h',actorId:'stranger'}),'FORBIDDEN')
})
test('permission tuples are AND-composed per operation and active peers cross-revoke', () => {
  const a=createMemoryAuthority({now:()=>clock})
  a.setup({householdId:'h',parentId:'p1',publicJwk:'jwk',permissions:{create:false,respond_or_issue:true,consume:true}})
  a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'k',...proof()})
  rejects(()=>a.createRequest(request()),'REMOTE_UNAVAILABLE')
  a.setup({householdId:'h',parentId:'p1',publicJwk:'jwk',permissions:{create:true,respond_or_issue:true,consume:true}})
  a.addParent({householdId:'h',actorId:'p1',parentId:'p2',publicJwk:'p2',...proof()})
  assert.equal(a.revokeParent({householdId:'h',actorId:'p2',parentId:'p1',...proof()}).status,'revoked')
})

test('personal rejection is immutable, and first approval wins under a race', () => {
  const a=make(); a.addParent({householdId:'h',actorId:'p1',parentId:'p2',publicJwk:'p2',...proof()}); prepare(a)
  assert.deepEqual(a.reject({householdId:'h',actorId:'p1',requestId:'r',...proof()}),{requestId:'r',decision:'reject'})
  rejects(()=>a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:5,...proof()}),'PERSONAL_REJECT_IMMUTABLE')
  const winner=a.approve({householdId:'h',actorId:'p2',requestId:'r',minutes:6,...proof()}); assert.equal(winner.approvedBy,'p2')
  rejects(()=>a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:8,...proof()}),'NOT_APPROVABLE')
})

test('expiry is strict at exactly 300 seconds for both request and grant', () => {
  const a=make(); prepare(a); clock += 300_000
  rejects(()=>a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:5,...proof()}),'NOT_APPROVABLE')
  const b=make(); prepare(b); const g=b.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:5,...proof()}); clock=g.expiresAt
  rejects(()=>b.consume(request()),'GRANT_INVALID')
})

test('consume is exactly once and binds every remote identity tuple member', () => {
  const a=make(); prepare(a); a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:4,...proof()})
  rejects(()=>a.consume(request({processId:'other'})),'GRANT_INVALID')
  const consumed=a.consume(request()); assert.equal(consumed.state,'consumed'); assert.equal(a.state.debits.get('r').debitSeconds,240)
  rejects(()=>a.consume(request()),'GRANT_INVALID')
})

test('replay, nonce and digest-bound idempotency preserve committed result', () => {
  const a=make(); const p=proof(); const first=a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'k',...p})
  assert.deepEqual(a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'k',...p}),first)
  rejects(()=>a.registerPc({householdId:'h',actorId:'p1',pcId:'other',publicKey:'k',...p}),'IDEMPOTENCY_CONFLICT')
  const q=proof(); a.registerPc({householdId:'h',actorId:'p1',pcId:'pc2',publicKey:'k',...q})
  rejects(()=>a.registerPc({householdId:'h',actorId:'p1',pcId:'pc3',publicKey:'k',jti:q.jti,nonce:'fresh',idempotencyKey:'new'}),'REPLAY')
})

test('reset, disable and delete invalidate concurrent grants through epochs and mode', () => {
  for (const op of ['reset','disable','delete']) { const a=make(); prepare(a); a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:1,...proof()}); a[op]({householdId:'h',actorId:'p1',...proof()}); rejects(()=>a.consume(request()), op === 'delete' ? 'NOT_FOUND' : 'GRANT_INVALID') }
})

test('bad tuple, remote mode, quota and telemetry contracts are conservative', () => {
  const a=make(); a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'k',...proof()}); rejects(()=>a.createRequest({householdId:'h',requestId:'x',pcId:'pc',gameId:'g',allowanceVersion:1}),'BAD_TUPLE')
  assert.deepEqual(a.telemetry({householdId:'h',kind:'request-created',payload:{requestId:'x'}}),{accepted:true})
  rejects(()=>a.telemetry({householdId:'h',kind:'x',payload:{data:'x'.repeat(5000)}}),'BAD_TELEMETRY')
})
test('HTTP route table requires an injected signed-proof verifier and never trusts body actorId', async () => {
  const seen=[]
  const db={
    prepare(sql) { return { sql, bind(...args) { return { sql, args, async all() {
      seen.push({sql,args})
      if(sql.startsWith('SELECT h.*')) return {results:[{id:'h',remote_enabled:1,deleted_at_ms:null,delete_state:'active',membership_epoch:1,service_epoch:1,mode:'REMOTE_ENABLED',global_epoch:1,create_permission:1,respond_or_issue_permission:1,consume_permission:1,environment_create_permission:1,environment_respond_or_issue_permission:1,environment_consume_permission:1}]}
      if(sql.startsWith('SELECT id FROM parent_devices')) return {results:[{id:'verified-parent'}]}
      if(sql.startsWith('SELECT operation_digest')) return {results:[]}
      if(sql.startsWith('SELECT 1 FROM idempotency')) return {results:[]}
      if(sql.startsWith('SELECT *,CASE')) return {results:[]}
      if(sql.startsWith('UPDATE idempotency')) return {results:[{result_json:'[]'}]}
      return {results:[]}
    } } } } },
    async batch() { return [{results:[]},{results:[]}] },
  }
  const worker=createWorker({db,authenticator:{async verify(input) { assert.equal(input.body,''); return {actorId:'verified-parent',principalKind:'parent',householdId:'h',jti:'j',nonce:'n',idempotencyKey:'i'} }},pairingTokenSecret:'test-pairing-token-secret-that-is-at-least-32-bytes'})
  const response=await worker.fetch(new Request('https://remote.test/v1/requests?householdId=h&actorId=forged'))
  assert.equal(response.status,200)
  assert.ok(seen.some(({args}) => args.includes('verified-parent')))
  assert.equal((await worker.fetch(new Request('https://remote.test/unlisted'))).status,404)
  assert.throws(() => createWorker({db}), /authenticator/)
})

test('concrete ES256 authenticator binds registered key, body, URL, actor, and live epochs', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('FROM parent_devices')) return { results: [{ id: 'parent', public_jwk: JSON.stringify(publicJwk), principal_kind: 'parent', membership_epoch: 3, household_id: 'h' }] }
              if (sql.includes('FROM idempotency_records')) return { results: [] }
              if (sql.includes('FROM households h')) return { results: [{ membership_epoch: 3, service_epoch: 4, global_epoch: 8 }] }
              return { results: [] }
            },
          }
        },
      }
    },
  }
  const url = 'https://remote.test/v1/approve'
  const body = JSON.stringify({ householdId: 'h', requestId: 'r', minutes: 20 })
  const claims = {
    actorId: 'parent',
    htm: 'POST',
    htu: url,
    contentDigest: await contentDigest(body),
    jti: 'j-auth',
    nonce: 'n-auth',
    idempotencyKey: 'i-auth',
    membershipEpoch: 3,
    serviceEpoch: 8,
    clientVersionCode: 1,
    iat: 4_000,
  }
  const token = await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: publicJwk })
    .sign(privateKey)
  const authenticator = createAuthenticator(db, { now: () => 4_000_000 })
  const verified = await authenticator.verify({
    request: new Request(url),
    method: 'POST',
    canonicalUrl: url,
    body,
    proof: `Bearer ${JSON.stringify(token)}`,
  })
  assert.equal(verified.actorId, 'parent')
  assert.equal(verified.clientVersionCode,1)
  const oldAuthenticator=createAuthenticator(db,{now:()=>4_000_000,minimumParentClientVersion:2})
  await assert.rejects(() => oldAuthenticator.verify({
    request:new Request(url),method:'POST',canonicalUrl:url,body,proof:`Bearer ${JSON.stringify(token)}`,
  }), (error)=>error.code==='AUTH_REQUIRED')
  assert.throws(() => createAuthenticator(db,{minimumParentClientVersion:0}), /positive safe integer/)
  await assert.rejects(() => authenticator.verify({
    request: new Request(url),
    method: 'POST',
    canonicalUrl: url,
    body: `${body} `,
    proof: `Bearer ${JSON.stringify(token)}`,
  }), /binding mismatch/)
})
test('reset reconciliation accepts the retained recovery key after replay TTL expiry only for its durable commit', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  const publicJwk=await exportJWK(publicKey)
  const db={
    prepare(sql) {
      return { bind(...args) { return { async all() {
        if(sql.includes('FROM parent_devices')) return {results:[{id:'parent',public_jwk:JSON.stringify(publicJwk),principal_kind:'parent',membership_epoch:4,household_id:'h'}]}
        if(sql.includes('FROM idempotency_records')) return {results:[]}
        if(sql.includes('FROM households h')) return {results:[{membership_epoch:4,service_epoch:5,global_epoch:8}]}
        if(sql.includes('FROM reset_commits c') && args.includes('reset-durable')) return {results:[{operation_key:'reset-durable'}]}
        return {results:[]}
      }}}
    }},
  }
  const url='https://remote.test/v1/reset/reconcile?householdId=h'
  const claims={actorId:'parent',htm:'GET',htu:url,contentDigest:await contentDigest(''),jti:'j-reconcile',nonce:'n-reconcile',idempotencyKey:'reset-durable',membershipEpoch:3,serviceEpoch:8,clientVersionCode:1,iat:4_000}
  const token=await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({alg:'ES256',typ:'remote-approval+jws',jwk:publicJwk})
    .sign(privateKey)
  const verified=await createAuthenticator(db,{now:()=>4_000_000}).verify({
    request:new Request(url),method:'GET',canonicalUrl:url,body:'',proof:`Bearer ${JSON.stringify(token)}`,
  })
  assert.equal(verified.actorId,'parent')
  assert.equal(verified.idempotencyKey,'reset-durable')
})
test('delete reconciliation authenticates the retained operation verifier after product purge', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const db = {
    prepare(sql) {
      return { bind(...args) { return { async all() {
        if (sql.includes('FROM parent_devices')) return { results: [] }
        if (sql.includes('FROM deletion_receipts') && sql.includes('public_jwk') && args.includes('delete-durable')) {
          return { results: [{ id: 'parent', public_jwk: JSON.stringify(publicJwk), principal_kind: 'parent', membership_epoch: 3, household_id: 'h' }] }
        }
        if (sql.includes('FROM idempotency_records')) return { results: [] }
        if (sql.includes('FROM households h')) return { results: [] }
        if (sql.includes('FROM deletion_receipts') && args.includes('delete-durable')) return { results: [{ household_id: 'h' }] }
        return { results: [] }
      } } } }
    },
  }
  const url = 'https://remote.test/v1/delete/reconcile?householdId=h&operationKey=delete-durable'
  const claims = { actorId: 'parent', htm: 'GET', htu: url, contentDigest: await contentDigest(''), jti: 'j-delete', nonce: 'n-delete', idempotencyKey: 'delete-durable', membershipEpoch: 3, serviceEpoch: 8, clientVersionCode: 1, iat: 4_000 }
  const token = await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: publicJwk })
    .sign(privateKey)
  const verified = await createAuthenticator(db, { now: () => 4_000_000 }).verify({
    request: new Request(url), method: 'GET', canonicalUrl: url, body: '', proof: `Bearer ${JSON.stringify(token)}`,
  })
  assert.equal(verified.actorId, 'parent')
  assert.equal(verified.idempotencyKey, 'delete-durable')
})
test('fast specification rejects malformed tuple and approval minutes above server maximum', () => {
  const a=make()
  a.registerPc({householdId:'h',actorId:'p1',pcId:'pc',publicKey:'k',...proof()})
  rejects(()=>a.createRequest({householdId:'h',requestId:'r',pcId:'pc',gameId:'g',allowanceVersion:'1',processId:'1',processStartedAt:1}),'BAD_TUPLE')
  prepare(a)
  rejects(()=>a.approve({householdId:'h',actorId:'p1',requestId:'r',minutes:241,...proof()}),'BAD_MINUTES')
})
