import { createAuthenticator } from './authenticator.mjs'
/* Cloudflare Worker.  All timestamps are milliseconds; expiration is exclusive. */
const TTL = 300_000
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const fail = (code, message = code) => Object.assign(new Error(message), { code })
const useCached = (value) => {
  if (value?.error) throw fail(value.error)
  return value
}
const operationReceipt = (operation, input) => {
  const serverNowMs=input.serverNowMs
  if (operation === 'createRequest') return { v:1,serverNowMs,request:{householdId:input.householdId,requestId:input.requestId,pcId:input.pcId,gameId:input.gameId,allowanceVersion:input.allowanceVersion,processId:input.processId,processStartedAt:input.processStartedAt,membershipEpoch:input.membershipEpoch,serviceEpoch:input.serviceEpoch,requestedAt:serverNowMs,expiresAt:serverNowMs+TTL} }
  if (operation === 'consume') return { v:1,serverNowMs,grant:{grantId:input.requestId,allowanceReservationId:input.requestId,householdId:input.householdId,requestId:input.requestId,pcId:input.pcId,gameId:input.gameId,allowanceVersion:input.allowanceVersion,processId:input.processId,processStartedAt:input.processStartedAt,membershipEpoch:input.membershipEpoch,serviceEpoch:input.serviceEpoch,approvedMinutes:input.approvedMinutes,grantedAt:input.grantedAt,expiresAt:input.expiresAt,launchGame:false} }
  if (operation === 'setAllowance') return { v:1,serverNowMs,allowance:{pcId:input.pcId,gameId:input.gameId,ianaTimeZone:input.ianaTimeZone,ianaDay:input.ianaDay,allowanceVersion:input.expectedVersion+1,totalSeconds:input.totalSeconds,committedSeconds:input.committedSeconds||0,reservedSeconds:input.reservedSeconds||0} }
  if (operation === 'registerFcmToken' || operation === 'revokeFcmToken') return { v:1,serverNowMs,fcm_token:{household_id:input.householdId,parent_id:input.actorId,token_version:input.tokenVersion,status:operation==='revokeFcmToken'?'revoked':'active'} }
  const receipt = { v:1,serverNowMs,operation }
  for (const key of ['householdId','requestId','pcId','parentId','recoveryParentId','gameId','allowanceVersion','ianaDay','ianaTimeZone','processId','processStartedAt','version','telemetryId']) if (input[key] !== undefined) receipt[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = input[key]
  if (operation==='issuePairing') { receipt.pairing_session_id=input.pairingSessionId; receipt.membership_epoch=input.membershipEpoch; receipt.created_at_ms=input.createdAt; receipt.expires_at_ms=input.expiresAt }
  if (operation==='reset') { receipt.parent_id=input.recoveryParentId; receipt.membership_epoch=input.nextMembershipEpoch; receipt.service_epoch=input.serviceEpoch }
  if (operation==='delete') receipt.last_operation_key=input.operationKey
  return receipt
}
const canonicalReceipt = (operation, input) => JSON.stringify(operationReceipt(operation, input))
const OPERATION_LEASE_MS = 1_000
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const digest = (value) => JSON.stringify(value, Object.keys(value).sort())
const tuple = (x) => {
  const ids = ['householdId', 'requestId', 'pcId', 'gameId', 'processId']
  return ids.every((key) => typeof x[key] === 'string' && x[key].length > 0 && x[key].length <= 128)
    && Number.isSafeInteger(x.allowanceVersion) && x.allowanceVersion > 0
    && Number.isSafeInteger(x.processStartedAt) && x.processStartedAt >= 0
}
const capabilityFor = (operation) => ({ createRequest:'create', telemetry:'create', consume:'consume', approve:'respond_or_issue', reject:'respond_or_issue', issuePairing:'respond_or_issue', addParent:'respond_or_issue', revokeParent:'respond_or_issue', registerPc:'respond_or_issue', revokePc:'respond_or_issue', setAllowance:'respond_or_issue' })[operation]
const permissionTuple = (value = {}) => {
  const permissions = value.permissions ?? value
  if (!['create', 'respond_or_issue', 'consume'].every((key) => typeof permissions[key] === 'boolean')) throw fail('BAD_PERMISSIONS')
  return permissions
}
const localDay = (timeZone, at) => {
  if (typeof timeZone !== 'string' || timeZone.length > 128) throw fail('BAD_TIME_ZONE')
  let parts
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(at)) }
  catch { throw fail('BAD_TIME_ZONE') }
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}
const tokenProtector = (keyMaterial) => {
  if (!(keyMaterial instanceof Uint8Array) || keyMaterial.byteLength !== 32) throw new TypeError('FCM_TOKEN_ENCRYPTION_KEY must be a 32-byte Uint8Array')
  const keyPromise=crypto.subtle.importKey('raw',keyMaterial,{name:'AES-GCM'},false,['encrypt','decrypt'])
  const decode=(text)=>Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
  return {
    async encrypt(token) { const iv=crypto.getRandomValues(new Uint8Array(12)), key=await keyPromise, encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(token))); return `${base64url(iv)}.${base64url(encrypted)}` },
    async decrypt(ciphertext) { const [ivText,bodyText]=String(ciphertext).split('.'); if(!ivText||!bodyText) throw fail('FCM_CIPHERTEXT_INVALID'); const key=await keyPromise; return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(ivText),tagLength:128},key,decode(bodyText))) },
  }
}
const mapRequest = (row) => row && ({ householdId:row.household_id,requestId:row.id,childName:row.pc_id,pcId:row.pc_id,gameId:row.game_id,allowanceVersion:row.allowance_version,processId:row.process_id,processStartedAt:row.process_started_at,membershipEpoch:row.membership_epoch,serviceEpoch:row.service_epoch,status:row.effective_status ?? row.status,personalDecision:row.personal_decision ?? null,requestedAt:row.created_at_ms,expiresAt:row.expires_at_ms,todayUsedMinutes:Math.floor(Number(row.today_used_seconds ?? 0)/60),todayLimitMinutes:Math.floor(Number(row.today_limit_seconds ?? 0)/60)})
const mapGrant = (row) => row && ({ grantId:row.request_id,allowanceReservationId:row.request_id,householdId:row.household_id,requestId:row.request_id,pcId:row.pc_id,gameId:row.game_id,allowanceVersion:row.allowance_version,processId:row.process_id,processStartedAt:row.process_started_at,membershipEpoch:row.membership_epoch,serviceEpoch:row.service_epoch,approvedMinutes:row.approved_minutes,grantedAt:row.issued_at_ms,expiresAt:row.expires_at_ms,launchGame:false })
const mapAllowance = (row) => row && ({ pcId:row.pc_id,gameId:row.game_id,ianaTimeZone:row.iana_time_zone,ianaDay:row.iana_day,allowanceVersion:row.version,totalSeconds:row.total_seconds,committedSeconds:row.committed_seconds,reservedSeconds:row.reserved_seconds })
const sha256Hex = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('')
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const pairingToken = async (secret, actorId, householdId, membershipEpoch, idempotencyKey) => {
  if (typeof secret !== 'string' || secret.length < 32) throw fail('PAIRING_UNAVAILABLE')
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign'])
  const message=`${actorId}\n${householdId}\n${membershipEpoch}\n${idempotencyKey}`
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message))))
}

/** Fast specification model for deterministic unit tests only; never selected by fetch. */
export function createMemoryAuthority({ now = () => Date.now() } = {}) {
  const s = { mode: 'LOCAL_ONLY', epoch: 1, households: new Map(), devices: new Map(), pcs: new Map(), requests: new Map(), grants: new Map(), rejects: new Set(), replay: new Set(), nonces: new Set(), idem: new Map(), debits: new Map(), quota: new Map(), telemetry: [], tokens: new Map() }
  const permitted = (h, capability) => s.mode === 'REMOTE_ENABLED' && h?.permissions?.[capability] && !h.deleted
  const enabled = (h) => permitted(h, 'create')
  const household = (id) => { const h = s.households.get(id); if (!h || h.deleted) throw fail('NOT_FOUND'); return h }
  const parent = (h, actor) => { const d = s.devices.get(actor); if (!d || d.householdId !== h.id || d.status !== 'active' || d.membershipEpoch !== h.membershipEpoch) throw fail('FORBIDDEN'); return d }
  const quota = (scope, limit = 60) => { const bucket = Math.floor(now() / 60_000), key = `${scope}:${bucket}`, n = (s.quota.get(key) || 0) + 1; s.quota.set(key, n); if (n > limit) throw fail('RATE_LIMITED') }
  const epochs = (h) => ({ serviceEpoch: s.epoch, householdServiceEpoch: h.serviceEpoch, membershipEpoch: h.membershipEpoch })
  const auth = ({ householdId, actorId, jti, nonce, idempotencyKey, operation }) => {
    const h = household(householdId); parent(h, actorId); quota(`actor:${actorId}`)
    if (!jti || !nonce || !idempotencyKey) throw fail('AUTH_REQUIRED')
    const rk = `${actorId}:${h.membershipEpoch}:${jti}`, nk = `${actorId}:${h.membershipEpoch}:${nonce}`, ik = `${actorId}:${h.membershipEpoch}:${idempotencyKey}`, d = digest(operation)
    const old = s.idem.get(ik); if (old) { if (old.digest !== d) throw fail('IDEMPOTENCY_CONFLICT'); if (old.result === undefined) throw fail('RETRY_PENDING'); return { h, cached: old.result } }
    if (s.replay.has(rk) || s.nonces.has(nk)) throw fail('REPLAY')
    s.replay.add(rk); s.nonces.add(nk); s.idem.set(ik, { digest: d }); return { h, ik }
  }
  const commit = (a, result) => { if (a.ik) s.idem.get(a.ik).result = result; return result }
  return {
    state: s,
    setup({ householdId, parentId, publicJwk, mode = 'REMOTE_ENABLED', permissions }) { if (!publicJwk) throw fail('PUBLIC_KEY_REQUIRED'); const p=permissionTuple(permissions); if (mode !== 'LOCAL_ONLY' && mode !== 'REMOTE_ENABLED') throw fail('BAD_MODE'); s.mode = mode; const old = s.households.get(householdId); const h = { id: householdId, permissions:p, deleted: false, serviceEpoch: (old?.serviceEpoch || 0) + 1, membershipEpoch: (old?.membershipEpoch || 0) + 1 }; s.households.set(householdId, h); s.devices.set(parentId, { householdId, status: 'active', membershipEpoch: h.membershipEpoch, publicJwk }); return { householdId, ...epochs(h) } },
    reset({ householdId, actorId, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: { op:'reset', householdId } }); if (a.cached) return a.cached; a.h.serviceEpoch++; a.h.membershipEpoch++; for (const d of s.devices.values()) if (d.householdId === householdId) d.status = 'revoked'; return commit(a, { ...epochs(a.h) }) },
    disable({ householdId, actorId, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: { op:'disable', householdId } }); if (a.cached) return a.cached; a.h.permissions = { create:false, respond_or_issue:false, consume:false }; a.h.serviceEpoch++; return commit(a, { ...epochs(a.h) }) },
    delete({ householdId, actorId, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: { op:'delete', householdId } }); if (a.cached) return a.cached; a.h.deleted = true; a.h.permissions = { create:false, respond_or_issue:false, consume:false }; a.h.serviceEpoch++; return commit(a, { deleted: true, ...epochs(a.h) }) },
    addParent({ householdId, actorId, parentId, publicJwk, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: { op:'addParent', parentId, publicJwk } }); if (a.cached) return a.cached; if (!publicJwk) throw fail('PUBLIC_KEY_REQUIRED'); s.devices.set(parentId, { householdId, status:'active', membershipEpoch:a.h.membershipEpoch, publicJwk }); return commit(a, { parentId, ...epochs(a.h) }) },
    revokeParent({ householdId, actorId, parentId, ...proof }) { const a=auth({ householdId, actorId, ...proof, operation:{op:'revokeParent',parentId} }); if(a.cached) return a.cached; if(parentId===actorId) throw fail('FORBIDDEN'); const d=s.devices.get(parentId); if(!d||d.householdId!==householdId||d.status!=='active'||d.membershipEpoch!==a.h.membershipEpoch) throw fail('NOT_FOUND'); d.status='revoked'; return commit(a,{parentId,status:'revoked'}) },
    registerPc({ householdId, actorId, pcId, publicKey, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: { op:'registerPc', pcId, publicKey } }); if (a.cached) return a.cached; if (!publicKey) throw fail('PUBLIC_KEY_REQUIRED'); s.pcs.set(pcId, { householdId, status:'active', publicKey }); return commit(a, { pcId }) },
    createRequest(x) { const h = household(x.householdId); quota(`pc:${x.pcId}`); const pc = s.pcs.get(x.pcId); if (!enabled(h) || !pc || pc.householdId !== h.id || pc.status !== 'active') throw fail('REMOTE_UNAVAILABLE'); if (!tuple(x)) throw fail('BAD_TUPLE'); const t = now(), r = { ...x, status:'pending', createdAt:t, expiresAt:t + TTL, ...epochs(h) }; s.requests.set(x.requestId, r); return r },
    getRequest({ householdId, actorId, requestId }) { const h = household(householdId); parent(h, actorId); const r = s.requests.get(requestId); if (!r || r.householdId !== h.id) throw fail('NOT_FOUND'); return { ...r, status: r.status === 'pending' && now() >= r.expiresAt ? 'expired' : r.status } },
    listRequests({ householdId, actorId }) { const h = household(householdId); parent(h, actorId); return [...s.requests.values()].filter((r) => r.householdId === h.id).map((r) => ({...r, status:r.status === 'pending' && now() >= r.expiresAt ? 'expired' : r.status})) },
    reject({ householdId, actorId, requestId, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation: {op:'reject',requestId} }); if (a.cached) return a.cached; const r = s.requests.get(requestId); if (!r || r.householdId !== householdId) throw fail('NOT_FOUND'); const k = `${requestId}:${actorId}:${a.h.membershipEpoch}`; if (s.rejects.has(k)) throw fail('ALREADY_RESPONDED'); s.rejects.add(k); return commit(a, { requestId, decision:'reject' }) },
    approve({ householdId, actorId, requestId, minutes, ...proof }) { const a = auth({ householdId, actorId, ...proof, operation:{op:'approve',requestId,minutes} }); if (a.cached) return a.cached; const r=s.requests.get(requestId), t=now(); if (!permitted(a.h,'respond_or_issue') || !r || r.householdId !== householdId || r.status !== 'pending' || t >= r.expiresAt || r.membershipEpoch !== a.h.membershipEpoch || r.serviceEpoch !== s.epoch || r.householdServiceEpoch !== a.h.serviceEpoch) throw fail('NOT_APPROVABLE'); const key=`${requestId}:${actorId}:${a.h.membershipEpoch}`; if(s.rejects.has(key)) throw fail('PERSONAL_REJECT_IMMUTABLE'); if(!Number.isInteger(minutes)||minutes<1||minutes>240) throw fail('BAD_MINUTES'); r.status='approved'; r.approvedBy=actorId; r.approvedAt=t; r.approvedMinutes=minutes; const g={ ...r, issuedAt:t, expiresAt:t+TTL, state:'issued' }; s.grants.set(requestId,g); return commit(a,g) },
    consume(x) { const h=household(x.householdId), g=s.grants.get(x.requestId); if (!permitted(h,'consume') || !g || !tuple(x) || g.state !== 'issued' || now() >= g.expiresAt || ['householdId','pcId','gameId','allowanceVersion','processId','processStartedAt'].some((k)=>g[k]!==x[k]) || g.membershipEpoch!==h.membershipEpoch || g.serviceEpoch!==s.epoch || g.householdServiceEpoch!==h.serviceEpoch) throw fail('GRANT_INVALID'); g.state='consumed'; g.consumedAt=now(); s.debits.set(g.requestId,{requestId:g.requestId,allowanceVersion:g.allowanceVersion,debitSeconds:g.approvedMinutes*60}); return { ...g } },
    telemetry({ householdId, kind, payload }) { const h=household(householdId); if (!enabled(h)) throw fail('REMOTE_UNAVAILABLE'); if (!kind || digest(payload).length > 4096) throw fail('BAD_TELEMETRY'); s.telemetry.push({ householdId, kind, payload, at:now() }); return { accepted:true } },
  }
}

// Production adapter.  `actorId` is only accepted from createWorker's verified proof,
// never from an untrusted JSON body.
export function createD1Authority(db, { now = () => Date.now(), fcmProtector, notificationProvider } = {}) {
  if (!db?.prepare || !db?.batch) throw new TypeError('A D1 database is required')
  let committing
  let commitQueue = Promise.resolve()
  const rawBatch = db.batch.bind(db)
  const commitStatement = () => db.prepare(`UPDATE idempotency_records SET result_json=?,lease_expires_at_ms=? WHERE actor_id=? AND membership_epoch=? AND idempotency_key=? AND operation_digest=? AND owner_token=? AND result_json IS NULL AND changes()>0 RETURNING result_json`).bind(committing.receipt,now(),committing.actorId,committing.membershipEpoch,committing.idempotencyKey,committing.operationDigest,committing.ownerToken)
  const commitAssertionStatement = () => db.prepare(`INSERT INTO idempotency_commit_assertions(actor_id,membership_epoch,idempotency_key,owner_token,result_json) SELECT ?,?,?,?,result_json FROM idempotency_records WHERE actor_id=? AND membership_epoch=? AND idempotency_key=? AND operation_digest=? AND owner_token=? AND result_json=? ON CONFLICT(actor_id,membership_epoch,idempotency_key) DO UPDATE SET owner_token=excluded.owner_token,result_json=excluded.result_json`).bind(committing.actorId,committing.membershipEpoch,committing.idempotencyKey,committing.ownerToken,committing.actorId,committing.membershipEpoch,committing.idempotencyKey,committing.operationDigest,committing.ownerToken,committing.receipt)
  const batch = (statements) => rawBatch(committing ? [...statements,commitStatement(),commitAssertionStatement()] : statements)
  const all = async (sql, ...values) => (await db.prepare(sql).bind(...values).all()).results || []
  const one = async (sql, ...values) => {
    const statement=db.prepare(sql).bind(...values)
    const writesBusiness=/^\s*(INSERT INTO (parent_devices|pcs|pairing_sessions|approval_requests|personal_responses|telemetry|allowance_reservations|approval_grants)|UPDATE (parent_devices|pcs|pairing_sessions|approval_requests|approval_grants|pc_daily_allowances|allowance_reservations|households))/i.test(sql)
    if (committing && writesBusiness) return (await rawBatch([statement,commitStatement(),commitAssertionStatement()]))[0].results?.[0]
    return (await statement.all()).results?.[0]
  }
  const failIf = (row, code) => { if (!row) throw fail(code); return row }
  const active = async (householdId, actorId, remote = true, capability) => {
    const h = failIf(await one(`SELECT h.*,e.mode,e.service_epoch AS global_epoch,e.create_permission AS environment_create_permission,e.respond_or_issue_permission AS environment_respond_or_issue_permission,e.consume_permission AS environment_consume_permission FROM households h JOIN environments e ON e.id='global' WHERE h.id=? AND h.deleted_at_ms IS NULL AND h.delete_state='active' AND NOT EXISTS(SELECT 1 FROM delete_tombstones t WHERE t.household_id=h.id AND t.expires_at_ms>?)`, householdId,now()), 'NOT_FOUND')
    if (remote) {
      const cap=capability || 'respond_or_issue'
      if (!['create','respond_or_issue','consume'].includes(cap) || h.mode !== 'REMOTE_ENABLED' || !h[`${cap}_permission`] || !h[`environment_${cap}_permission`]) throw fail('REMOTE_UNAVAILABLE')
    }
    if (actorId) failIf(await one(`SELECT id FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?`, actorId, householdId, h.membership_epoch), 'FORBIDDEN')
    return h
  }
  const quota = async (scope) => {
    const bucket = Math.floor(now() / 60_000)
    await all(`DELETE FROM rate_windows WHERE bucket<? RETURNING scope`,bucket-1_440)
    const r = await one(`INSERT INTO rate_windows(scope,bucket,count) VALUES(?,?,1) ON CONFLICT(scope,bucket) DO UPDATE SET count=count+1 RETURNING count`, scope, bucket)
    if (r.count > 60) throw fail('RATE_LIMITED')
  }
  const remotePredicate = `EXISTS(SELECT 1 FROM environments e WHERE e.id='global' AND e.mode='REMOTE_ENABLED' AND e.service_epoch=?) AND EXISTS(SELECT 1 FROM households h WHERE h.id=? AND h.remote_enabled=1 AND h.deleted_at_ms IS NULL AND h.service_epoch=? AND h.membership_epoch=?)`
  const recordIntent = (id, h, requestId, kind, payload, t) => db.prepare(`INSERT INTO notification_intents VALUES(?,?,?,?,?,?,NULL)`).bind(id,h,requestId,kind,payload,t)
  const administrator = async (householdId, actorId) => failIf(await one(`SELECT c.parent_id FROM setup_commits c JOIN households h ON h.id=c.household_id JOIN parent_devices p ON p.id=c.parent_id WHERE c.household_id=? AND c.parent_id=? AND p.status='active' AND p.membership_epoch=h.membership_epoch`, householdId, actorId), 'FORBIDDEN')
  const waitForLease = async ({ actorId, idempotencyKey, operationDigest }) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const record = await one(`SELECT membership_epoch,operation_digest,owner_token,lease_expires_at_ms,result_json FROM idempotency_records WHERE actor_id=? AND idempotency_key=? ORDER BY expires_at_ms DESC LIMIT 1`, actorId, idempotencyKey)
      if (!record) return null
      if (record.operation_digest !== operationDigest) throw fail('IDEMPOTENCY_CONFLICT')
      if (record.result_json !== null) return { cached: JSON.parse(record.result_json) }
      const ownerToken = crypto.randomUUID()
      if (record.lease_expires_at_ms <= now()) {
        const acquired = await one(`UPDATE idempotency_records SET owner_token=?,lease_expires_at_ms=? WHERE actor_id=? AND membership_epoch=? AND idempotency_key=? AND operation_digest=? AND owner_token=? AND lease_expires_at_ms<=? AND result_json IS NULL RETURNING membership_epoch`, ownerToken, now() + OPERATION_LEASE_MS, actorId, record.membership_epoch, idempotencyKey, operationDigest, record.owner_token, now())
        if (acquired) return { membershipEpoch: acquired.membership_epoch, ownerToken }
      }
      await pause(5)
    }
    throw fail('OPERATION_IN_PROGRESS')
  }
  return {
    async withCommit(context, work) {
      const previous=commitQueue
      let release
      commitQueue=new Promise((resolve) => { release=resolve })
      await previous
      committing=context
      try { return await work() } finally { committing=undefined; release() }
    },
    async setEnvironmentControls({actorId,permissions,expectedVersion}) {
      const p=permissionTuple(permissions)
      if(!Number.isInteger(expectedVersion)||expectedVersion<1) throw fail('BAD_CONTROL_VERSION')
      const t=now()
      const row=await one(`UPDATE environments SET mode=CASE WHEN ? OR ? OR ? THEN 'REMOTE_ENABLED' ELSE 'LOCAL_ONLY' END,create_permission=?,respond_or_issue_permission=?,consume_permission=?,control_version=control_version+1,service_epoch=CASE WHEN (create_permission=1 OR respond_or_issue_permission=1 OR consume_permission=1) AND ?=0 AND ?=0 AND ?=0 THEN service_epoch+1 ELSE service_epoch END,updated_at_ms=?,updated_by_operator_id=? WHERE id='global' AND control_version=? RETURNING *`,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,t,actorId,expectedVersion)
      return failIf(row,'CONTROL_CAS_CONFLICT')
    },
    async setHouseholdControls({householdId,actorId,permissions,expectedVersion}) {
      const p=permissionTuple(permissions)
      if(!Number.isInteger(expectedVersion)||expectedVersion<1) throw fail('BAD_CONTROL_VERSION')
      const t=now()
      const row=await one(`UPDATE households SET remote_enabled=CASE WHEN ? OR ? OR ? THEN 1 ELSE 0 END,create_permission=?,respond_or_issue_permission=?,consume_permission=?,control_version=control_version+1,service_epoch=CASE WHEN (create_permission=1 OR respond_or_issue_permission=1 OR consume_permission=1) AND ?=0 AND ?=0 AND ?=0 THEN service_epoch+1 ELSE service_epoch END,controls_updated_at_ms=?,controls_updated_by_operator_id=? WHERE id=? AND deleted_at_ms IS NULL AND control_version=? RETURNING *`,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,t,actorId,householdId,expectedVersion)
      return failIf(row,'CONTROL_CAS_CONFLICT')
    },
    async controls({householdId}) {
      const row=await one(`SELECT h.id AS household_id,h.control_version AS household_version,h.create_permission AS household_create,h.respond_or_issue_permission AS household_respond_or_issue,h.consume_permission AS household_consume,h.service_epoch AS household_service_epoch,e.control_version AS environment_version,e.create_permission AS environment_create,e.respond_or_issue_permission AS environment_respond_or_issue,e.consume_permission AS environment_consume,e.service_epoch AS environment_service_epoch FROM households h JOIN environments e ON e.id='global' WHERE h.id=? AND h.deleted_at_ms IS NULL`,householdId)
      return failIf(row,'NOT_FOUND')
    },
    async setup({ householdId, parentId, publicJwk, setupToken, permissions }) {
      if (!parentId || !publicJwk || !setupToken) throw fail('PUBLIC_KEY_REQUIRED')
      const p=permissionTuple(permissions), t=now(), remoteEnabled=p.create||p.respond_or_issue||p.consume
      await one(`DELETE FROM delete_tombstones WHERE expires_at_ms<=? RETURNING household_id`,t)
      const rows=await batch([
        db.prepare(`INSERT INTO households(id,setup_token,remote_enabled,service_epoch,membership_epoch,deleted_at_ms,last_operation_key,create_permission,respond_or_issue_permission,consume_permission) SELECT ?,?,?,?, ?,NULL,NULL,?,?,? WHERE NOT EXISTS(SELECT 1 FROM delete_tombstones WHERE household_id=?) ON CONFLICT DO NOTHING RETURNING *`).bind(householdId,setupToken,remoteEnabled?1:0,1,1,p.create?1:0,p.respond_or_issue?1:0,p.consume?1:0,householdId),
        db.prepare(`INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) SELECT ?,h.id,?,'active',h.membership_epoch,? FROM households h WHERE h.id=? AND h.setup_token=? ON CONFLICT(id) DO NOTHING RETURNING id`).bind(parentId,publicJwk,t,householdId,setupToken),
        db.prepare(`INSERT INTO setup_commits(household_id,parent_id) VALUES((SELECT id FROM households WHERE id=? AND setup_token=?),(SELECT id FROM parent_devices WHERE id=? AND household_id=?)) RETURNING *`).bind(householdId,setupToken,parentId,householdId),
      ])
      if (!rows[0].results?.length || !rows[1].results?.length || !rows[2].results?.length) throw fail('HOUSEHOLD_EXISTS')
      return rows[0].results[0]
    },
    async issuePairingSession({id,householdId,parentId,secretHash,expiresAtMs,issuedByPcId}) {
      if (!id || !householdId || !parentId || !secretHash || !issuedByPcId || !Number.isInteger(expiresAtMs)) throw fail('BAD_PAIRING_SESSION')
      const h=await active(householdId,null,true,'respond_or_issue')
      if (expiresAtMs<=now() || expiresAtMs>now()+TTL) throw fail('BAD_PAIRING_SESSION')
      return failIf(await one(`INSERT INTO pairing_sessions(id,household_id,parent_id,secret_hash,membership_epoch,service_epoch,global_service_epoch,household_service_epoch,expires_at_ms,used_at_ms,redemption_id,revoked_at_ms,issued_by_pc_id) SELECT ?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,? WHERE EXISTS(SELECT 1 FROM pcs WHERE id=? AND household_id=? AND status='active') RETURNING id,household_id,parent_id,membership_epoch,service_epoch,global_service_epoch,household_service_epoch,expires_at_ms`,id,householdId,parentId,secretHash,h.membership_epoch,h.global_epoch,h.global_epoch,h.service_epoch,expiresAtMs,issuedByPcId,issuedByPcId,householdId),'FORBIDDEN')
    },
    async pair({householdId,parentId,publicJwk,secretHash}) {
      if (!householdId || !parentId || !publicJwk || !secretHash) throw fail('PAIRING_REQUIRED')
      const t=now(), redemptionId=crypto.randomUUID()
      const rows=await batch([
        db.prepare(`UPDATE pairing_sessions SET used_at_ms=?,redemption_id=? WHERE secret_hash=? AND household_id=? AND parent_id=? AND used_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms>? AND EXISTS(SELECT 1 FROM households h JOIN environments e ON e.id='global' WHERE h.id=pairing_sessions.household_id AND h.deleted_at_ms IS NULL AND h.remote_enabled=1 AND e.mode='REMOTE_ENABLED' AND h.membership_epoch=pairing_sessions.membership_epoch AND h.service_epoch=pairing_sessions.household_service_epoch AND e.service_epoch=pairing_sessions.global_service_epoch) RETURNING membership_epoch,global_service_epoch`).bind(t,redemptionId,secretHash,householdId,parentId,t),
        db.prepare(`INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) SELECT s.parent_id,s.household_id,?,'active',s.membership_epoch,? FROM pairing_sessions s WHERE s.redemption_id=? AND s.used_at_ms=? ON CONFLICT(id) DO NOTHING RETURNING id,household_id,status,membership_epoch`).bind(publicJwk,t,redemptionId,t),
      ])
      if (!rows[0].results?.length || !rows[1].results?.length) throw fail('PAIRING_INVALID')
      return {parentId,householdId,membershipEpoch:rows[0].results[0].membership_epoch,serviceEpoch:rows[0].results[0].global_service_epoch}
    },
    async addParent({householdId,actorId,parentId,publicJwk}) { const h=await active(householdId,actorId); if(!publicJwk) throw fail('PUBLIC_KEY_REQUIRED'); return failIf(await one(`INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) SELECT ?,?,?,'active',?,? WHERE ${remotePredicate} AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?) RETURNING id,household_id,status,membership_epoch`,parentId,householdId,publicJwk,h.membership_epoch,now(),h.global_epoch,householdId,h.service_epoch,h.membership_epoch,actorId,householdId,h.membership_epoch),'REMOTE_UNAVAILABLE') },
    async revokeParent({householdId,actorId,parentId}) {
      const h=await active(householdId,actorId,true,'respond_or_issue')
      if (parentId === actorId) throw fail('FORBIDDEN')
      return failIf(await one(`UPDATE parent_devices SET status='revoked' WHERE id=? AND household_id=? AND status='active' AND EXISTS(SELECT 1 FROM households h JOIN environments e ON e.id='global' WHERE h.id=? AND h.remote_enabled=1 AND h.deleted_at_ms IS NULL AND e.mode='REMOTE_ENABLED' AND h.service_epoch=? AND h.membership_epoch=?) RETURNING id,status`,parentId,householdId,householdId,h.service_epoch,h.membership_epoch),'NOT_FOUND')
    },
    async registerPc({householdId,actorId,pcId,publicKey,ianaTimeZone}) { const h=await active(householdId,actorId); if(!publicKey) throw fail('PUBLIC_KEY_REQUIRED'); localDay(ianaTimeZone,now()); return failIf(await one(`INSERT INTO pcs(id,household_id,public_key,iana_time_zone,status,created_at_ms) SELECT ?,?,?,?,'active',? WHERE ${remotePredicate} AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?) ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key,iana_time_zone=excluded.iana_time_zone,status='active' WHERE pcs.household_id=excluded.household_id RETURNING id,household_id,iana_time_zone,status`,pcId,householdId,publicKey,ianaTimeZone,now(),h.global_epoch,householdId,h.service_epoch,h.membership_epoch,actorId,householdId,h.membership_epoch),'PC_ID_CONFLICT') },
    async revokePc({householdId,actorId,pcId}) { const h=await active(householdId,actorId); return failIf(await one(`UPDATE pcs SET status='revoked' WHERE id=? AND household_id=? AND status='active' AND ${remotePredicate} AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?) RETURNING id,status`,pcId,householdId,h.global_epoch,householdId,h.service_epoch,h.membership_epoch,actorId,householdId,h.membership_epoch),'NOT_FOUND') },
    async issuePairing({householdId,actorId,pcId,pairingSessionId,pairingToken,createdAt,expiresAt}) {
      const h=await active(householdId,actorId,true,'respond_or_issue')
      if(typeof pairingSessionId!=='string'||!pairingSessionId||typeof pairingToken!=='string'||!pairingToken||!Number.isSafeInteger(createdAt)||!Number.isSafeInteger(expiresAt)||expiresAt!==createdAt+TTL) throw fail('BAD_PAIRING_SESSION')
      const secretHash=await sha256Hex(pairingToken)
      return failIf(await one(`INSERT INTO pairing_sessions(id,household_id,parent_id,secret_hash,membership_epoch,service_epoch,global_service_epoch,household_service_epoch,expires_at_ms,issued_by_pc_id) SELECT ?,?,?,?,h.membership_epoch,e.service_epoch,e.service_epoch,h.service_epoch,?,? FROM households h JOIN environments e ON e.id='global' WHERE h.id=? AND h.deleted_at_ms IS NULL AND h.remote_enabled=1 AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=h.id AND status='active' AND membership_epoch=h.membership_epoch) AND EXISTS(SELECT 1 FROM pcs WHERE id=? AND household_id=h.id AND status='active') RETURNING id,household_id,membership_epoch,service_epoch,global_service_epoch,household_service_epoch,expires_at_ms`,pairingSessionId,householdId,pairingSessionId,secretHash,expiresAt,pcId,householdId,actorId,pcId),'REMOTE_UNAVAILABLE')
    },
    async createRequest(x) {
      const h=await active(x.householdId,null,true,'create')
      await quota(`pc:${x.pcId}`)
      if(!tuple(x)) throw fail('BAD_TUPLE')
      const pc=failIf(await one(`SELECT iana_time_zone FROM pcs WHERE id=? AND household_id=? AND status='active'`,x.pcId,x.householdId),'FORBIDDEN')
      const t=x.serverNowMs ?? now(), day=localDay(pc.iana_time_zone,t), intent=`request:${x.requestId}`
      const rows=await batch([
        db.prepare(`INSERT INTO approval_requests(id,household_id,pc_id,game_id,allowance_version,allowance_day,iana_time_zone,membership_epoch,service_epoch,household_service_epoch,status,created_at_ms,expires_at_ms,process_id,process_started_at,last_operation_key) SELECT ?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pc_daily_allowances a WHERE a.household_id=? AND a.pc_id=? AND a.game_id=? AND a.iana_day=? AND a.iana_time_zone=? AND a.version=?) AND NOT EXISTS(SELECT 1 FROM approval_requests r WHERE r.household_id=? AND r.pc_id=? AND r.status='pending' AND r.expires_at_ms>?) AND NOT EXISTS(SELECT 1 FROM approval_grants g WHERE g.household_id=? AND g.pc_id=? AND g.state='issued' AND g.expires_at_ms>?) AND ${remotePredicate} RETURNING *`).bind(x.requestId,x.householdId,x.pcId,x.gameId,x.allowanceVersion,day,pc.iana_time_zone,h.membership_epoch,h.global_epoch,h.service_epoch,t,t+TTL,x.processId,x.processStartedAt,x.operationKey,x.householdId,x.pcId,x.gameId,day,pc.iana_time_zone,x.allowanceVersion,x.householdId,x.pcId,t,x.householdId,x.pcId,t,h.global_epoch,x.householdId,h.service_epoch,h.membership_epoch),
        db.prepare(`INSERT INTO notification_intents(id,household_id,request_id,kind,opaque_payload,created_at_ms,delivered_at_ms) SELECT ?,?,?,'request-created','{}',?,NULL WHERE EXISTS(SELECT 1 FROM approval_requests WHERE id=? AND household_id=?) AND NOT EXISTS(SELECT 1 FROM notification_intents WHERE id=?) RETURNING id`).bind(intent,x.householdId,x.requestId,t,x.requestId,x.householdId,intent),
      ])
      if(!rows[0].results?.length) throw fail('ACTIVE_REQUEST_EXISTS')
      if(!rows[1].results?.length) throw fail('REMOTE_UNAVAILABLE')
      return rows[0].results[0]
    },
    async getRequest({householdId,actorId,requestId}) {
      await active(householdId,actorId,false)
      const row=failIf(await one(`SELECT r.*,CASE WHEN r.status='pending' AND r.expires_at_ms<=? THEN 'expired' ELSE r.status END AS effective_status,(SELECT decision FROM personal_responses WHERE request_id=r.id AND parent_id=? AND membership_epoch=r.membership_epoch) AS personal_decision,COALESCE(a.committed_seconds,0) AS today_used_seconds,COALESCE(a.total_seconds,0) AS today_limit_seconds FROM approval_requests r LEFT JOIN pc_daily_allowances a ON a.household_id=r.household_id AND a.pc_id=r.pc_id AND a.game_id=r.game_id AND a.iana_day=r.allowance_day AND a.iana_time_zone=r.iana_time_zone AND a.version=r.allowance_version WHERE r.id=? AND r.household_id=?`,now(),actorId,requestId,householdId),'NOT_FOUND')
      return mapRequest(row)
    },
    async pcState({householdId,actorId,pcId,gameId}) {
      const h=await active(householdId,null,false)
      if(actorId!==pcId) throw fail('FORBIDDEN')
      const pc=failIf(await one(`SELECT iana_time_zone FROM pcs WHERE id=? AND household_id=? AND status='active'`,pcId,householdId),'FORBIDDEN')
      const request=await one(`SELECT * FROM approval_requests WHERE household_id=? AND pc_id=? ORDER BY created_at_ms DESC LIMIT 1`,householdId,pcId)
      const grant=request&&await one(`SELECT * FROM approval_grants WHERE request_id=? AND household_id=? AND pc_id=? AND state IN('issued','consumed') AND expires_at_ms>? ORDER BY issued_at_ms DESC LIMIT 1`,request.id,householdId,pcId,now())
      const selectedGame=gameId || request?.game_id
      const allowance=selectedGame && await one(`SELECT pc_id,game_id,iana_time_zone,iana_day,version,total_seconds,committed_seconds,reserved_seconds FROM pc_daily_allowances WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=?`,householdId,pcId,selectedGame,localDay(pc.iana_time_zone,now()))
      const devices=await all(`SELECT id,created_at_ms,status FROM parent_devices WHERE household_id=? AND membership_epoch=? ORDER BY created_at_ms`,householdId,h.membership_epoch)
      const parentDevices=devices.map((device)=>({parentDeviceId:device.id,householdId,displayName:device.id,membershipEpoch:h.membership_epoch,registeredAt:device.created_at_ms}))
      return {serverNowMs:now(),request:mapRequest(request),grant:mapGrant(grant),allowance:mapAllowance(allowance),parentDevices,health:{lifecycle:'online',serviceEpoch:h.global_epoch,checkedAt:now()}}
    },
    async listRequests({householdId,actorId}) {
      await active(householdId,actorId,false)
      const rows=await all(`SELECT r.*,CASE WHEN r.status='pending' AND r.expires_at_ms<=? THEN 'expired' ELSE r.status END AS effective_status,(SELECT decision FROM personal_responses WHERE request_id=r.id AND parent_id=? AND membership_epoch=r.membership_epoch) AS personal_decision,COALESCE(a.committed_seconds,0) AS today_used_seconds,COALESCE(a.total_seconds,0) AS today_limit_seconds FROM approval_requests r LEFT JOIN pc_daily_allowances a ON a.household_id=r.household_id AND a.pc_id=r.pc_id AND a.game_id=r.game_id AND a.iana_day=r.allowance_day AND a.iana_time_zone=r.iana_time_zone AND a.version=r.allowance_version WHERE r.household_id=? ORDER BY r.created_at_ms DESC`,now(),actorId,householdId)
      return rows.map(mapRequest)
    },
    async parentState({householdId,actorId}) {
      await active(householdId,actorId,false)
      const t=now()
      const requests=await all(`SELECT r.*,CASE WHEN r.status='pending' AND r.expires_at_ms<=? THEN 'expired' ELSE r.status END AS effective_status,(SELECT decision FROM personal_responses WHERE request_id=r.id AND parent_id=? AND membership_epoch=r.membership_epoch) AS personal_decision FROM approval_requests r WHERE r.household_id=? ORDER BY r.created_at_ms DESC`,t,actorId,householdId)
      const pcs=await all(`SELECT id,iana_time_zone FROM pcs WHERE household_id=? AND status='active' ORDER BY id`,householdId)
      const devices=await all(`SELECT id,status,created_at_ms FROM parent_devices WHERE household_id=? ORDER BY created_at_ms`,householdId)
      const allowances=await all(`SELECT pc_id,game_id,iana_time_zone,iana_day,version,total_seconds,committed_seconds,reserved_seconds FROM pc_daily_allowances WHERE household_id=? ORDER BY pc_id,game_id,iana_day`,householdId)
      const pcDays=new Map(pcs.map((pc)=>[pc.id,localDay(pc.iana_time_zone,t)]))
      const editable=allowances.filter((allowance)=>pcDays.get(allowance.pc_id)===allowance.iana_day)
      const currentAllowances=new Map(editable.map((allowance)=>[`${allowance.pc_id}\0${allowance.game_id}`,allowance]))
      const mappedRequests=requests.map((request)=>{
        const allowance=currentAllowances.get(`${request.pc_id}\0${request.game_id}`)
        return mapRequest({...request,today_used_seconds:allowance?.committed_seconds ?? 0,today_limit_seconds:allowance?.total_seconds ?? 0})
      })
      return {v:1,serverNowMs:t,requests:mappedRequests,devices:devices.map((device)=>({id:device.id,name:device.id,platform:'Android',status:device.status,registeredAt:device.created_at_ms})),allowances:editable.map(mapAllowance)}
    },
    async reject({householdId,actorId,requestId}) { const h=await active(householdId,actorId); const t=now(); return failIf(await one(`INSERT INTO personal_responses(request_id,parent_id,membership_epoch,decision,responded_at_ms) SELECT ?,?,?,'reject',? WHERE EXISTS(SELECT 1 FROM approval_requests WHERE id=? AND household_id=? AND status='pending' AND expires_at_ms>? AND membership_epoch=? AND service_epoch=? AND household_service_epoch=?) AND ${remotePredicate} AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?) RETURNING *`,requestId,actorId,h.membership_epoch,t,requestId,householdId,t,h.membership_epoch,h.global_epoch,h.service_epoch,h.global_epoch,householdId,h.service_epoch,h.membership_epoch,actorId,householdId,h.membership_epoch),'ALREADY_RESPONDED') },
    async approve({householdId,actorId,requestId,minutes,operationKey}) {
      const h=await active(householdId,actorId,true,'respond_or_issue'); if(!Number.isInteger(minutes)||minutes<1||minutes>240) throw fail('BAD_MINUTES'); const t=now(), seconds=minutes*60, intent=`grant:${requestId}`
      const rows=await batch([
        db.prepare(`UPDATE approval_requests SET status='approved',approved_at_ms=?,approved_by=?,approved_minutes=?,last_operation_key=? WHERE id=? AND household_id=? AND status='pending' AND expires_at_ms>? AND membership_epoch=? AND service_epoch=? AND household_service_epoch=? AND EXISTS(SELECT 1 FROM pc_daily_allowances a WHERE a.household_id=approval_requests.household_id AND a.pc_id=approval_requests.pc_id AND a.game_id=approval_requests.game_id AND a.iana_day=approval_requests.allowance_day AND a.iana_time_zone=approval_requests.iana_time_zone AND a.version=approval_requests.allowance_version AND a.total_seconds>=a.committed_seconds+a.reserved_seconds+?) AND NOT EXISTS(SELECT 1 FROM personal_responses WHERE request_id=? AND parent_id=? AND membership_epoch=?) AND ${remotePredicate} RETURNING *`).bind(t,actorId,minutes,operationKey,requestId,householdId,t,h.membership_epoch,h.global_epoch,h.service_epoch,seconds,requestId,actorId,h.membership_epoch,h.global_epoch,householdId,h.service_epoch,h.membership_epoch),
        db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds+?,updated_at_ms=? WHERE household_id=? AND pc_id=(SELECT pc_id FROM approval_requests WHERE id=? AND approved_at_ms=? AND approved_by=?) AND game_id=(SELECT game_id FROM approval_requests WHERE id=?) AND iana_day=(SELECT allowance_day FROM approval_requests WHERE id=?) AND iana_time_zone=(SELECT iana_time_zone FROM approval_requests WHERE id=?) AND version=(SELECT allowance_version FROM approval_requests WHERE id=?) AND total_seconds>=committed_seconds+reserved_seconds+? RETURNING *`).bind(seconds,t,householdId,requestId,t,actorId,requestId,requestId,requestId,requestId,seconds),
        db.prepare(`INSERT INTO allowance_reservations(request_id,household_id,pc_id,game_id,allowance_day,iana_time_zone,allowance_version,reserved_seconds,state,created_at_ms,settled_at_ms) SELECT id,household_id,pc_id,game_id,allowance_day,iana_time_zone,allowance_version,?,'reserved',?,NULL FROM approval_requests WHERE id=? AND approved_at_ms=? AND approved_by=? RETURNING *`).bind(seconds,t,requestId,t,actorId),
        db.prepare(`INSERT INTO approval_grants(request_id,household_id,pc_id,game_id,allowance_version,allowance_day,iana_time_zone,membership_epoch,service_epoch,household_service_epoch,process_id,process_started_at,approved_by,approved_minutes,issued_at_ms,expires_at_ms,state,last_operation_key) SELECT id,household_id,pc_id,game_id,allowance_version,allowance_day,iana_time_zone,membership_epoch,service_epoch,household_service_epoch,process_id,process_started_at,approved_by,approved_minutes,?,?,'issued',last_operation_key FROM approval_requests WHERE id=? AND approved_at_ms=? AND approved_by=? AND last_operation_key=? RETURNING *`).bind(t,t+TTL,requestId,t,actorId,operationKey),
        db.prepare(`INSERT INTO notification_intents(id,household_id,request_id,kind,opaque_payload,created_at_ms,delivered_at_ms) VALUES(?,?,?,'grant-issued','{}',?,NULL) RETURNING id`).bind(intent,householdId,requestId,t),
      ]); if(!rows[0].results?.length || !rows[1].results?.length || !rows[2].results?.length || !rows[3].results?.length) throw fail('NOT_APPROVABLE'); return rows[3].results[0]
    },
    async consume(x) { const h=await active(x.householdId,null,true,'consume'); if(!tuple(x) || typeof x.ianaTimeZone!=='string' || typeof x.ianaDay!=='string') throw fail('BAD_TUPLE'); const t=x.serverNowMs ?? now(); const rows=await batch([
      db.prepare(`UPDATE approval_grants SET state='consumed',process_id=?,process_started_at=?,consumed_at_ms=?,last_operation_key=? WHERE request_id=? AND household_id=? AND pc_id=? AND game_id=? AND allowance_version=? AND allowance_day=? AND iana_time_zone=? AND state='issued' AND expires_at_ms>? AND membership_epoch=? AND service_epoch=? AND household_service_epoch=? AND ${remotePredicate} AND EXISTS(SELECT 1 FROM pcs WHERE id=? AND household_id=? AND status='active') RETURNING *`).bind(x.processId,x.processStartedAt,t,x.operationKey,x.requestId,x.householdId,x.pcId,x.gameId,x.allowanceVersion,x.ianaDay,x.ianaTimeZone,t,h.membership_epoch,h.global_epoch,h.service_epoch,h.global_epoch,x.householdId,h.service_epoch,h.membership_epoch,x.pcId,x.householdId),
      db.prepare(`UPDATE allowance_reservations SET state='settled',settled_at_ms=? WHERE request_id=? AND state='reserved' RETURNING *`).bind(t,x.requestId),
      db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds-(SELECT reserved_seconds FROM allowance_reservations WHERE request_id=? AND state='settled'),committed_seconds=committed_seconds+(SELECT reserved_seconds FROM allowance_reservations WHERE request_id=? AND state='settled'),updated_at_ms=? WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=? AND iana_time_zone=? AND version=? AND EXISTS(SELECT 1 FROM approval_grants WHERE request_id=? AND state='consumed') RETURNING *`).bind(x.requestId,x.requestId,t,x.householdId,x.pcId,x.gameId,x.ianaDay,x.ianaTimeZone,x.allowanceVersion,x.requestId),
      db.prepare(`INSERT INTO allowance_debits(request_id,allowance_version,debit_seconds,created_at_ms) SELECT request_id,allowance_version,approved_minutes*60,consumed_at_ms FROM approval_grants WHERE request_id=? AND state='consumed' AND NOT EXISTS(SELECT 1 FROM allowance_debits WHERE request_id=?) RETURNING *`).bind(x.requestId,x.requestId),
    ]); if(!rows[0].results?.length || !rows[1].results?.length || !rows[2].results?.length) throw fail('GRANT_INVALID'); return rows[0].results[0] },
    async setAllowance({householdId,actorId,pcId,gameId,expectedVersion,totalSeconds,serverNowMs,ianaTimeZone,ianaDay}) {
      if (!gameId || !pcId || !Number.isInteger(expectedVersion) || expectedVersion < 0 || !Number.isInteger(totalSeconds) || totalSeconds < 0 || !ianaTimeZone || !ianaDay) throw fail('BAD_ALLOWANCE')
      const h=await active(householdId,actorId,true,'respond_or_issue')
      const t=serverNowMs ?? now(), nextVersion=expectedVersion+1
      const row=expectedVersion===0
        ? await one(`INSERT INTO pc_daily_allowances(household_id,pc_id,game_id,iana_day,iana_time_zone,total_seconds,committed_seconds,reserved_seconds,version,updated_at_ms) SELECT ?,?,?,?,?,?,0,0,?,? WHERE ${remotePredicate} RETURNING *`,householdId,pcId,gameId,ianaDay,ianaTimeZone,totalSeconds,nextVersion,t,h.global_epoch,householdId,h.service_epoch,h.membership_epoch)
        : await one(`UPDATE pc_daily_allowances SET total_seconds=?,version=?,updated_at_ms=? WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=? AND iana_time_zone=? AND version=? AND ? >= committed_seconds+reserved_seconds RETURNING *`,totalSeconds,nextVersion,t,householdId,pcId,gameId,ianaDay,ianaTimeZone,expectedVersion,totalSeconds)
      return failIf(row,'ALLOWANCE_CAS_CONFLICT')
    },
    async hydrateResponseInput(operation,input) {
      if(operation==='setAllowance') {
        const pc=failIf(await one(`SELECT iana_time_zone FROM pcs WHERE id=? AND household_id=? AND status='active'`,input.pcId,input.householdId),'NOT_FOUND')
        input.ianaTimeZone=pc.iana_time_zone
        input.ianaDay=localDay(input.ianaTimeZone,input.serverNowMs)
        const current=await one(`SELECT committed_seconds,reserved_seconds FROM pc_daily_allowances WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=? AND iana_time_zone=? AND version=?`,input.householdId,input.pcId,input.gameId,input.ianaDay,input.ianaTimeZone,input.expectedVersion)
        input.committedSeconds=current?.committed_seconds || 0
        input.reservedSeconds=current?.reserved_seconds || 0
      }
      if(operation==='consume') {
        const grant=failIf(await one(`SELECT approved_minutes,issued_at_ms,expires_at_ms FROM approval_grants WHERE request_id=? AND household_id=? AND state='issued'`,input.requestId,input.householdId),'GRANT_INVALID')
        input.approvedMinutes=grant.approved_minutes
        input.grantedAt=grant.issued_at_ms
        input.expiresAt=grant.expires_at_ms
      }
      return input
    },
    async reset({householdId,actorId,operationKey,recoveryParentId,recoveryPublicJwk}) {
      if (!operationKey || !recoveryParentId || !recoveryPublicJwk) throw fail('RECOVERY_PARENT_REQUIRED')
      const h=await active(householdId,actorId,false)
      const t=now()
      const rows=await batch([
        db.prepare(`UPDATE households SET service_epoch=service_epoch+1,membership_epoch=membership_epoch+1,last_operation_key=? WHERE id=? AND service_epoch=? AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=households.membership_epoch) AND NOT EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id<>?) RETURNING *`).bind(operationKey,householdId,h.service_epoch,actorId,householdId,recoveryParentId,householdId),
        db.prepare(`DELETE FROM notification_deliveries WHERE token_id IN(SELECT id FROM fcm_tokens WHERE household_id=?)`).bind(householdId),
        db.prepare(`DELETE FROM fcm_tokens WHERE household_id=?`).bind(householdId),
        db.prepare(`UPDATE parent_devices SET status='revoked' WHERE household_id=? AND EXISTS(SELECT 1 FROM households WHERE id=? AND last_operation_key=?) RETURNING id`).bind(householdId,householdId,operationKey),
        db.prepare(`INSERT INTO parent_devices(id,household_id,public_jwk,status,membership_epoch,created_at_ms) SELECT ?,h.id,?,'active',h.membership_epoch,? FROM households h WHERE h.id=? AND h.last_operation_key=? ON CONFLICT(id) DO UPDATE SET public_jwk=excluded.public_jwk,status='active',membership_epoch=excluded.membership_epoch WHERE parent_devices.household_id=excluded.household_id RETURNING id`).bind(recoveryParentId,recoveryPublicJwk,t,householdId,operationKey),
        db.prepare(`INSERT INTO reset_commits(household_id,operation_key,parent_id) VALUES((SELECT id FROM households WHERE id=? AND last_operation_key=?),?,(SELECT id FROM parent_devices WHERE id=? AND household_id=? AND status='active')) RETURNING *`).bind(householdId,operationKey,operationKey,recoveryParentId,householdId),
        db.prepare(`UPDATE setup_commits SET parent_id=? WHERE household_id=? AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active') RETURNING parent_id`).bind(recoveryParentId,householdId,recoveryParentId,householdId),
        db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds-(SELECT COALESCE(SUM(r.reserved_seconds),0) FROM allowance_reservations r WHERE r.household_id=pc_daily_allowances.household_id AND r.pc_id=pc_daily_allowances.pc_id AND r.game_id=pc_daily_allowances.game_id AND r.allowance_day=pc_daily_allowances.iana_day AND r.iana_time_zone=pc_daily_allowances.iana_time_zone AND r.state='reserved') WHERE EXISTS(SELECT 1 FROM reset_commits WHERE household_id=? AND operation_key=?) RETURNING *`).bind(householdId,operationKey),
        db.prepare(`UPDATE allowance_reservations SET state='released',settled_at_ms=? WHERE state='reserved' AND household_id=? AND EXISTS(SELECT 1 FROM reset_commits WHERE household_id=? AND operation_key=?) RETURNING *`).bind(t,householdId,householdId,operationKey),
        db.prepare(`UPDATE households SET last_operation_key=last_operation_key WHERE id=? AND last_operation_key=? RETURNING id`).bind(householdId,operationKey),
      ])
      return failIf(rows[4].results?.[0],'RETRY_CONFLICT')
    },
    async reconcileReset({householdId,actorId,operationKey}) {
      const row=failIf(await one(`SELECT h.id AS household_id,c.parent_id,h.membership_epoch,e.service_epoch FROM reset_commits c JOIN households h ON h.id=c.household_id JOIN environments e ON e.id='global' JOIN parent_devices p ON p.id=c.parent_id AND p.household_id=h.id WHERE c.household_id=? AND c.parent_id=? AND c.operation_key=? AND h.deleted_at_ms IS NULL AND p.status='active' AND p.membership_epoch=h.membership_epoch`,householdId,actorId,operationKey),'NOT_FOUND')
      return { operation:'reset', ...row }
    },
    async reconcileDelete({householdId,actorId,operationKey}) {
      const live=await one(`SELECT h.id AS household_id,h.last_operation_key,h.deleted_at_ms,h.service_epoch,h.membership_epoch FROM households h JOIN parent_devices p ON p.household_id=h.id WHERE h.id=? AND p.id=? AND h.last_operation_key=? AND h.deleted_at_ms IS NOT NULL AND p.status='active' AND p.membership_epoch=h.membership_epoch`,householdId,actorId,operationKey)
      if(live) return { operation:'delete', ...live }
      const retained=await one(`SELECT receipt_json FROM deletion_receipts WHERE household_id=? AND actor_id=? AND operation_key=? AND expires_at_ms>?`,householdId,actorId,operationKey,now())
      return failIf(retained && JSON.parse(retained.receipt_json),'NOT_FOUND')
    },
    async releaseExpiredReservations(nowMs = now()) {
      const rows=await all(`SELECT request_id,household_id,pc_id,game_id,allowance_day,iana_time_zone,allowance_version,reserved_seconds FROM allowance_reservations WHERE state='reserved' AND (EXISTS(SELECT 1 FROM approval_grants g WHERE g.request_id=allowance_reservations.request_id AND g.expires_at_ms<=?) OR EXISTS(SELECT 1 FROM households h WHERE h.id=allowance_reservations.household_id AND (h.remote_enabled=0 OR h.deleted_at_ms IS NOT NULL)))`,nowMs)
      for (const r of rows) {
        const releaseToken=crypto.randomUUID()
        await batch([
          db.prepare(`UPDATE allowance_reservations SET state='released',settled_at_ms=?,release_token=? WHERE request_id=? AND state='reserved' RETURNING request_id`).bind(nowMs,releaseToken,r.request_id),
          db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds-? WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=? AND iana_time_zone=? AND version=? AND EXISTS(SELECT 1 FROM allowance_reservations WHERE request_id=? AND state='released' AND release_token=?) RETURNING *`).bind(r.reserved_seconds,r.household_id,r.pc_id,r.game_id,r.allowance_day,r.iana_time_zone,r.allowance_version,r.request_id,releaseToken),
        ])
      }
      return rows.length
    },
    async disable({householdId,actorId,operationKey}) {
      const h=await active(householdId,actorId,false)
      const t=now()
      const rows=await batch([
        db.prepare(`UPDATE households SET remote_enabled=0,service_epoch=service_epoch+1,last_operation_key=? WHERE id=? AND service_epoch=? AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=households.membership_epoch) RETURNING *`).bind(operationKey,householdId,h.service_epoch,actorId,householdId),
        db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds-(SELECT COALESCE(SUM(r.reserved_seconds),0) FROM allowance_reservations r WHERE r.household_id=pc_daily_allowances.household_id AND r.pc_id=pc_daily_allowances.pc_id AND r.game_id=pc_daily_allowances.game_id AND r.allowance_day=pc_daily_allowances.iana_day AND r.iana_time_zone=pc_daily_allowances.iana_time_zone AND r.state='reserved') WHERE EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND remote_enabled=0) RETURNING *`).bind(householdId,h.service_epoch+1),
        db.prepare(`UPDATE allowance_reservations SET state='released',settled_at_ms=? WHERE state='reserved' AND household_id=? AND EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND remote_enabled=0) RETURNING *`).bind(t,householdId,householdId,h.service_epoch+1),
        db.prepare(`UPDATE fcm_tokens SET status='quarantined',revoked_at_ms=? WHERE household_id=? AND status='active' AND EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND remote_enabled=0) RETURNING id`).bind(t,householdId,householdId,h.service_epoch+1),
        db.prepare(`UPDATE households SET last_operation_key=last_operation_key WHERE id=? AND last_operation_key=? AND remote_enabled=0 RETURNING id`).bind(householdId,operationKey),
      ])
      return failIf(rows[0].results?.[0],'RETRY_CONFLICT')
    },
    async delete({householdId,actorId,operationKey}) {
      const h=await active(householdId,actorId,false)
      const t=now(), purgeAfter=t+30*24*60*60*1000
      const rows=await batch([
        db.prepare(`UPDATE households SET remote_enabled=0,create_permission=0,respond_or_issue_permission=0,consume_permission=0,deleted_at_ms=?,delete_state='pending_purge',purge_after_ms=?,service_epoch=service_epoch+1,last_operation_key=? WHERE id=? AND service_epoch=? AND deleted_at_ms IS NULL AND EXISTS(SELECT 1 FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=households.membership_epoch) RETURNING *`).bind(t,purgeAfter,operationKey,householdId,h.service_epoch,actorId,householdId),
        db.prepare(`UPDATE pc_daily_allowances SET reserved_seconds=reserved_seconds-(SELECT COALESCE(SUM(r.reserved_seconds),0) FROM allowance_reservations r WHERE r.household_id=pc_daily_allowances.household_id AND r.pc_id=pc_daily_allowances.pc_id AND r.game_id=pc_daily_allowances.game_id AND r.allowance_day=pc_daily_allowances.iana_day AND r.iana_time_zone=pc_daily_allowances.iana_time_zone AND r.state='reserved') WHERE EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND deleted_at_ms=?) RETURNING *`).bind(householdId,h.service_epoch+1,t),
        db.prepare(`UPDATE allowance_reservations SET state='released',settled_at_ms=? WHERE state='reserved' AND household_id=? AND EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND deleted_at_ms=?) RETURNING *`).bind(t,householdId,householdId,h.service_epoch+1,t),
        db.prepare(`UPDATE fcm_tokens SET status='quarantined',revoked_at_ms=? WHERE household_id=? AND status='active' AND EXISTS(SELECT 1 FROM households WHERE id=? AND service_epoch=? AND deleted_at_ms=?) RETURNING id`).bind(t,householdId,householdId,h.service_epoch+1,t),
        db.prepare(`INSERT INTO deletion_receipts(household_id,actor_id,operation_key,public_jwk,membership_epoch,service_epoch,receipt_json,expires_at_ms,created_at_ms) SELECT h.id,?,?,p.public_jwk,h.membership_epoch,e.service_epoch,json_object('operation','delete','household_id',h.id,'last_operation_key',h.last_operation_key,'deleted_at_ms',h.deleted_at_ms,'service_epoch',h.service_epoch,'membership_epoch',h.membership_epoch),?,? FROM households h JOIN parent_devices p ON p.id=? AND p.household_id=h.id JOIN environments e ON e.id='global' WHERE h.id=? AND h.last_operation_key=? ON CONFLICT(household_id) DO UPDATE SET actor_id=excluded.actor_id,operation_key=excluded.operation_key,public_jwk=excluded.public_jwk,membership_epoch=excluded.membership_epoch,service_epoch=excluded.service_epoch,receipt_json=excluded.receipt_json,expires_at_ms=excluded.expires_at_ms,created_at_ms=excluded.created_at_ms RETURNING household_id`).bind(actorId,operationKey,t+120*24*60*60*1000,t,actorId,householdId,operationKey),
        db.prepare(`UPDATE households SET last_operation_key=last_operation_key WHERE id=? AND last_operation_key=? AND deleted_at_ms IS NOT NULL RETURNING id`).bind(householdId,operationKey),
      ])
      return failIf(rows[0].results?.[0],'RETRY_CONFLICT')
    },
    async beginSetupOperation({actorId,jti,nonce,idempotencyKey,operationDigest}) {
      if(!jti||!nonce||!idempotencyKey) throw fail('AUTH_REQUIRED')
      await quota(`setup:${actorId}`)
      const existing=await waitForLease({actorId,idempotencyKey,operationDigest})
      if (existing) return existing
      const ownerToken=crypto.randomUUID()
      try {
        await rawBatch([
          db.prepare(`INSERT INTO auth_replays(actor_id,membership_epoch,jti,nonce,expires_at_ms) VALUES(?,?,?,?,?)`).bind(actorId,0,jti,nonce,now()+TTL),
          db.prepare(`INSERT INTO idempotency_records(actor_id,membership_epoch,idempotency_key,operation_digest,owner_token,lease_expires_at_ms,result_json,expires_at_ms) VALUES(?,?,?,?,?,?,NULL,?)`).bind(actorId,0,idempotencyKey,operationDigest,ownerToken,now()+OPERATION_LEASE_MS,now()+TTL),
        ])
        return {membershipEpoch:0,ownerToken}
      } catch {
        return waitForLease({actorId,idempotencyKey,operationDigest})
      }
    },
    async beginOperation({householdId,actorId,principalKind,capability,allowDisabled=false,jti,nonce,idempotencyKey,operationDigest}) {
      if(!jti||!nonce||!idempotencyKey||!operationDigest) throw fail('AUTH_REQUIRED')
      await quota(`mutation:${actorId}`)
      await one(`DELETE FROM auth_replays WHERE expires_at_ms<=? RETURNING actor_id`, now() - TTL)
      await one(`DELETE FROM idempotency_commit_assertions WHERE EXISTS(SELECT 1 FROM idempotency_records r WHERE r.actor_id=idempotency_commit_assertions.actor_id AND r.membership_epoch=idempotency_commit_assertions.membership_epoch AND r.idempotency_key=idempotency_commit_assertions.idempotency_key AND r.expires_at_ms<=?) RETURNING actor_id`, now() - TTL)
      await one(`DELETE FROM idempotency_records WHERE expires_at_ms<=? RETURNING actor_id`, now() - TTL)
      const existing=await waitForLease({actorId,idempotencyKey,operationDigest})
      if (existing) return existing
      const h=await active(householdId,null,!allowDisabled,capability)
      if (principalKind === 'parent') failIf(await one(`SELECT id FROM parent_devices WHERE id=? AND household_id=? AND status='active' AND membership_epoch=?`,actorId,householdId,h.membership_epoch),'FORBIDDEN')
      else if (principalKind === 'pc') failIf(await one(`SELECT id FROM pcs WHERE id=? AND household_id=? AND status='active'`,actorId,householdId),'FORBIDDEN')
      else throw fail('FORBIDDEN')
      const ownerToken=crypto.randomUUID()
      try {
        await rawBatch([
          db.prepare(`INSERT INTO auth_replays(actor_id,membership_epoch,jti,nonce,expires_at_ms) VALUES(?,?,?,?,?)`).bind(actorId,h.membership_epoch,jti,nonce,now()+TTL),
          db.prepare(`INSERT INTO idempotency_records(actor_id,membership_epoch,idempotency_key,operation_digest,owner_token,lease_expires_at_ms,result_json,expires_at_ms) VALUES(?,?,?,?,?,?,NULL,?)`).bind(actorId,h.membership_epoch,idempotencyKey,operationDigest,ownerToken,now()+OPERATION_LEASE_MS,now()+TTL),
        ])
        return {membershipEpoch:h.membership_epoch,ownerToken}
      } catch {
        return waitForLease({actorId,idempotencyKey,operationDigest})
      }
    },
    async completeOperation({actorId,membershipEpoch,idempotencyKey,operationDigest,ownerToken,result}) {
      return one(`UPDATE idempotency_records SET result_json=?,lease_expires_at_ms=? WHERE actor_id=? AND membership_epoch=? AND idempotency_key=? AND operation_digest=? AND owner_token=? AND result_json IS NULL RETURNING result_json`,JSON.stringify(result),now(),actorId,membershipEpoch,idempotencyKey,operationDigest,ownerToken)
    },
    async reconstructOperation({operation,input}) {
      if (operation==='approve') return one(`SELECT * FROM approval_grants WHERE request_id=? AND approved_by=? AND approved_minutes=?`,input.requestId,input.actorId,input.minutes)
      if (operation==='reject') return one(`SELECT * FROM personal_responses WHERE request_id=? AND parent_id=? ORDER BY responded_at_ms DESC LIMIT 1`,input.requestId,input.actorId)
      if (operation==='consume') return one(`SELECT * FROM approval_grants WHERE request_id=? AND household_id=? AND pc_id=? AND game_id=? AND allowance_version=? AND process_id=? AND process_started_at=? AND state='consumed'`,input.requestId,input.householdId,input.pcId,input.gameId,input.allowanceVersion,input.processId,input.processStartedAt)
      if (operation==='registerPc') return one(`SELECT * FROM pcs WHERE id=? AND household_id=? AND public_key=? AND iana_time_zone=? AND status='active'`,input.pcId,input.householdId,input.publicKey,input.ianaTimeZone)
      if (operation==='revokePc') return one(`SELECT * FROM pcs WHERE id=? AND household_id=? AND status='revoked'`,input.pcId,input.householdId)
      if (operation==='addParent') return one(`SELECT * FROM parent_devices WHERE id=? AND household_id=? AND public_jwk=? AND status='active'`,input.parentId,input.householdId,input.publicJwk)
      if (operation==='revokeParent') return one(`SELECT * FROM parent_devices WHERE id=? AND household_id=? AND status='revoked'`,input.parentId,input.householdId)
      if (operation==='reset') return one(`SELECT h.* FROM households h JOIN reset_commits c ON c.household_id=h.id AND c.operation_key=? WHERE h.id=? AND h.last_operation_key=? AND c.parent_id=?`,input.operationKey,input.householdId,input.operationKey,input.recoveryParentId)
      if (operation==='disable') return one(`SELECT * FROM households WHERE id=? AND last_operation_key=? AND remote_enabled=0`,input.householdId,input.operationKey)
      if (operation==='delete') return one(`SELECT * FROM households WHERE id=? AND last_operation_key=? AND deleted_at_ms IS NOT NULL`,input.householdId,input.operationKey)
      if (operation==='setAllowance') return one(`SELECT * FROM pc_daily_allowances WHERE household_id=? AND pc_id=? AND game_id=? AND iana_day=? AND iana_time_zone=? AND version=?`,input.householdId,input.pcId,input.gameId,input.ianaDay,input.ianaTimeZone,input.expectedVersion+1)
      if (operation==='createRequest') return one(`SELECT * FROM approval_requests WHERE id=? AND household_id=? AND pc_id=? AND game_id=? AND allowance_version=? AND process_id=? AND process_started_at=?`,input.requestId,input.householdId,input.pcId,input.gameId,input.allowanceVersion,input.processId,input.processStartedAt)
      if (operation==='telemetry') return one(`SELECT id,household_id,kind,created_at_ms FROM telemetry WHERE id=? AND household_id=? AND kind=? AND payload_json=?`,input.telemetryId,input.householdId,input.kind,JSON.stringify(input.payload))
      if (operation==='setup') return one(`SELECT * FROM households WHERE id=? AND setup_token=? AND deleted_at_ms IS NULL`,input.householdId,input.setupToken)
      return null
    },
    async registerFcmToken({householdId,actorId,token,tokenVersion,operationKey}) {
      await active(householdId,actorId,true,'respond_or_issue')
      if(typeof token!=='string'||token.length<16||token.length>4096||!Number.isSafeInteger(tokenVersion)||tokenVersion<=0) throw fail('BAD_FCM_TOKEN')
      if(!fcmProtector) throw fail('FCM_ENCRYPTION_UNAVAILABLE')
      const tokenHash=await sha256Hex(token), tokenCiphertext=await fcmProtector.encrypt(token), id=crypto.randomUUID(), t=now()
      return failIf(await one(`INSERT INTO fcm_tokens(id,household_id,parent_id,token_hash,token_ciphertext,token_version,status,created_at_ms,rotated_at_ms,revoked_at_ms,last_operation_key) VALUES(?,?,?,?,?,?,'active',?,NULL,NULL,?) ON CONFLICT(household_id,parent_id) DO UPDATE SET token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,token_version=excluded.token_version,status='active',rotated_at_ms=excluded.created_at_ms,revoked_at_ms=NULL,last_operation_key=excluded.last_operation_key WHERE excluded.token_version>fcm_tokens.token_version RETURNING id,household_id,parent_id,token_version,status`,id,householdId,actorId,tokenHash,tokenCiphertext,tokenVersion,t,operationKey),'FCM_TOKEN_CONFLICT')
    },
    async revokeFcmToken({householdId,actorId,tokenVersion,operationKey}) {
      await active(householdId,actorId,true,'respond_or_issue')
      if(!Number.isSafeInteger(tokenVersion)||tokenVersion<=0) throw fail('BAD_FCM_TOKEN')
      return failIf(await one(`UPDATE fcm_tokens SET status='revoked',revoked_at_ms=?,last_operation_key=? WHERE household_id=? AND parent_id=? AND token_version=? AND status='active' RETURNING id,token_version,status`,now(),operationKey,householdId,actorId,tokenVersion),'NOT_FOUND')
    },
    async reconcileNotifications({householdId,actorId}) {
      await active(householdId,actorId,true,'respond_or_issue')
      return { serverTimeMillis:now(), intents:await all(`SELECT id,request_id,kind,created_at_ms FROM notification_intents WHERE household_id=? AND delivered_at_ms IS NULL ORDER BY created_at_ms LIMIT 100`,householdId) }
    },
    async dispatchNotifications(limit = 25) {
      if(!fcmProtector || !notificationProvider?.send) throw fail('DEPENDENCY_UNAVAILABLE')
      const due=now()
      const pending=await all(`SELECT i.id AS intent_id,t.id AS token_id,t.token_ciphertext,COALESCE(MAX(d.attempt),0) AS attempts FROM notification_intents i JOIN fcm_tokens t ON t.household_id=i.household_id AND t.status='active' AND t.created_at_ms<=i.created_at_ms LEFT JOIN notification_deliveries d ON d.intent_id=i.id AND d.token_id=t.id WHERE NOT EXISTS(SELECT 1 FROM notification_deliveries done WHERE done.intent_id=i.id AND done.token_id=t.id AND done.state IN('delivered','error')) GROUP BY i.id,t.id HAVING COALESCE(MAX(CASE WHEN d.state='retry' THEN d.next_attempt_at_ms END),0)<=? LIMIT ?`,due,limit)
      let delivered=0, retried=0
      for(const row of pending) {
        const attempt=row.attempts+1, deliveryId=crypto.randomUUID(), createdAt=now()
        try {
          const receipt=await notificationProvider.send({ token:await fcmProtector.decrypt(row.token_ciphertext), intentId:row.intent_id })
          if(typeof receipt!=='string'||!receipt) throw fail('PROVIDER_RECEIPT_REQUIRED')
          await batch([
            db.prepare(`INSERT INTO notification_deliveries(id,intent_id,token_id,attempt,state,provider_receipt,error_code,next_attempt_at_ms,created_at_ms,delivered_at_ms) VALUES(?,?,?,?,'delivered',?,NULL,NULL,?,?)`).bind(deliveryId,row.intent_id,row.token_id,attempt,receipt,createdAt,createdAt),
            db.prepare(`UPDATE notification_intents SET delivered_at_ms=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM fcm_tokens t WHERE t.household_id=notification_intents.household_id AND t.status='active' AND t.created_at_ms<=notification_intents.created_at_ms AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.intent_id=notification_intents.id AND d.token_id=t.id AND d.state IN('delivered','error')) )`).bind(createdAt,row.intent_id),
          ]); delivered++
        } catch(error) {
          const retryable=attempt<3 && error?.code!=='PROVIDER_REJECTED' && error?.code!=='PROVIDER_RECEIPT_REQUIRED', next=retryable ? createdAt+attempt*60_000 : null
          await batch([
            db.prepare(`INSERT INTO notification_deliveries(id,intent_id,token_id,attempt,state,provider_receipt,error_code,next_attempt_at_ms,created_at_ms,delivered_at_ms) VALUES(?,?,?,?,?,NULL,?,?,?,NULL)`).bind(deliveryId,row.intent_id,row.token_id,attempt,retryable?'retry':'error',error?.code||'DELIVERY_FAILED',next,createdAt),
            db.prepare(`UPDATE notification_intents SET delivered_at_ms=? WHERE id=? AND ?='error' AND NOT EXISTS(SELECT 1 FROM fcm_tokens t WHERE t.household_id=notification_intents.household_id AND t.status='active' AND t.created_at_ms<=notification_intents.created_at_ms AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.intent_id=notification_intents.id AND d.token_id=t.id AND d.state IN('delivered','error')) )`).bind(createdAt,row.intent_id,retryable?'retry':'error'),
          ])
          retried+=retryable?1:0
        }
      }
      return { attempted:pending.length, delivered, retried }
    },
    async purgeDeleted(nowMs = now(), limit = 25) {
      await all(`DELETE FROM delete_tombstones WHERE household_id IN(SELECT household_id FROM delete_tombstones WHERE expires_at_ms<=? LIMIT 100) RETURNING household_id`,nowMs)
      await all(`DELETE FROM deletion_observations WHERE id IN(SELECT id FROM deletion_observations WHERE observed_at_ms<? LIMIT 100) RETURNING id`,nowMs-90*24*60*60*1000)
      const rows=await all(`SELECT h.id,h.deleted_at_ms,h.purge_after_ms,h.last_operation_key FROM households h WHERE (h.delete_state='pending_purge' AND h.purge_after_ms<=?) OR EXISTS(SELECT 1 FROM delete_tombstones t WHERE t.household_id=h.id AND t.expires_at_ms>?) ORDER BY h.purge_after_ms LIMIT ?`,nowMs,nowMs,limit)
      await all(`DELETE FROM deletion_receipts WHERE expires_at_ms<=? RETURNING household_id`,nowMs)
      for(const row of rows) {
        const identityHash=await sha256Hex(row.id)
        await batch([
          db.prepare(`INSERT INTO delete_tombstones(household_id,identity_hash,deleted_at_ms,purge_after_ms,tombstoned_at_ms,expires_at_ms,delete_operation_key) SELECT ?,?,?,?,?,?,? WHERE ? IS NOT NULL ON CONFLICT(household_id) DO NOTHING`).bind(row.id,identityHash,row.deleted_at_ms,row.purge_after_ms,nowMs,nowMs+90*24*60*60*1000,row.last_operation_key,row.deleted_at_ms),
          db.prepare(`INSERT INTO deletion_observations VALUES(?,?,?,?,?)`).bind(crypto.randomUUID(),identityHash,'purged',nowMs,JSON.stringify({purgeAfterMs:row.purge_after_ms})),
          db.prepare(`UPDATE deletion_receipts SET expires_at_ms=MAX(expires_at_ms,?) WHERE household_id=? RETURNING household_id`).bind(nowMs+90*24*60*60*1000,row.id),
          db.prepare(`DELETE FROM notification_deliveries WHERE intent_id IN(SELECT id FROM notification_intents WHERE household_id=?)`).bind(row.id),
          db.prepare(`DELETE FROM notification_intents WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM allowance_debits WHERE request_id IN(SELECT request_id FROM approval_grants WHERE household_id=?)`).bind(row.id),
          db.prepare(`DELETE FROM allowance_reservations WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM approval_grants WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM personal_responses WHERE request_id IN(SELECT id FROM approval_requests WHERE household_id=?)`).bind(row.id),
          db.prepare(`DELETE FROM approval_requests WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM pc_daily_allowances WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM telemetry WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM pairing_sessions WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM reset_commits WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM setup_commits WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM permission_control_audit WHERE scope='household' AND household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM idempotency_commit_assertions WHERE (actor_id,membership_epoch,idempotency_key) IN(SELECT actor_id,membership_epoch,idempotency_key FROM idempotency_records WHERE json_extract(result_json,'$.household_id')=?)`).bind(row.id),
          db.prepare(`DELETE FROM idempotency_records WHERE json_extract(result_json,'$.household_id')=?`).bind(row.id),
          db.prepare(`DELETE FROM idempotency_commit_assertions WHERE actor_id IN(SELECT id FROM parent_devices WHERE household_id=? UNION SELECT id FROM pcs WHERE household_id=?)`).bind(row.id,row.id),
          db.prepare(`DELETE FROM idempotency_records WHERE actor_id IN(SELECT id FROM parent_devices WHERE household_id=? UNION SELECT id FROM pcs WHERE household_id=?)`).bind(row.id,row.id),
          db.prepare(`DELETE FROM auth_replays WHERE actor_id IN(SELECT id FROM parent_devices WHERE household_id=? UNION SELECT id FROM pcs WHERE household_id=?)`).bind(row.id,row.id),
          db.prepare(`DELETE FROM fcm_tokens WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM pcs WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM parent_devices WHERE household_id=?`).bind(row.id),
          db.prepare(`DELETE FROM households WHERE id=? AND (delete_state='pending_purge' OR EXISTS(SELECT 1 FROM delete_tombstones t WHERE t.household_id=households.id AND t.expires_at_ms>?))`).bind(row.id,nowMs),
        ])
      }
      return { purged:rows.length }
    },
    async telemetry({householdId,kind,payload,telemetryId}) { const h=await active(householdId,null,true,'create'); await quota(`telemetry:${householdId}`); await all(`DELETE FROM telemetry WHERE created_at_ms<? RETURNING id`,now()-90*24*60*60*1000); const encoded=JSON.stringify(payload); if(!h || !kind||!telemetryId||encoded.length>4096) throw fail('BAD_TELEMETRY'); return one(`INSERT INTO telemetry VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`,telemetryId,householdId,kind,now(),encoded) },
  }
}
const httpsNotificationProvider = ({ endpoint, bearerToken, fetchImpl = fetch } = {}) => {
  if(typeof endpoint!=='string' || typeof bearerToken!=='string' || !bearerToken) return null
  let url
  try { url=new URL(endpoint) } catch { return null }
  if(url.protocol!=='https:') return null
  return { async send({ token, intentId }) {
    const response=await fetchImpl(url,{method:'POST',headers:{authorization:`Bearer ${bearerToken}`,'content-type':'application/json'},body:JSON.stringify({token,intentId})})
    if(!response.ok) throw fail(response.status>=500||response.status===429?'PROVIDER_TRANSIENT':'PROVIDER_REJECTED')
    const receipt=response.headers.get('x-provider-receipt') || (await response.text()).trim()
    if(!receipt || receipt.length>512) throw fail('PROVIDER_RECEIPT_REQUIRED')
    return receipt
  } }
}
const routes = Object.freeze({
  'POST /v1/households/setup':'setup','PUT /v1/environment/controls':'setEnvironmentControls','PUT /v1/household/controls':'setHouseholdControls','GET /v1/controls':'controls','POST /v1/pair':'pair','POST /v1/pairing-sessions':'issuePairing','POST /v1/parents':'addParent','DELETE /v1/parents':'revokeParent','POST /v1/pcs':'registerPc','DELETE /v1/pcs':'revokePc','POST /v1/requests':'createRequest','GET /v1/requests':'listRequests','GET /v1/request':'getRequest','GET /v1/pc/state':'pcState','GET /v1/parent/state':'parentState','POST /v1/reject':'reject','POST /v1/approve':'approve','POST /v1/consume':'consume','POST /v1/allowances':'setAllowance','POST /v1/reset':'reset','GET /v1/reset/reconcile':'reconcileReset','POST /v1/disable':'disable','DELETE /v1/household':'delete','GET /v1/delete/reconcile':'reconcileDelete','POST /v1/fcm-tokens':'registerFcmToken','DELETE /v1/fcm-tokens':'revokeFcmToken','GET /v1/notifications/reconcile':'reconcileNotifications','POST /v1/telemetry':'telemetry',
})
const parentOperations = new Set(['issuePairing','addParent','revokeParent','registerPc','revokePc','getRequest','listRequests','parentState','reconcileReset','reconcileDelete','reject','approve','setAllowance','reset','disable','delete','registerFcmToken','revokeFcmToken','reconcileNotifications'])
const pcOperations = new Set(['createRequest','pcState','consume','telemetry'])
export function createWorker({ db, authenticator, now = () => Date.now(), pairingTokenSecret, fcmTokenEncryptionKey, notificationProvider } = {}) {
  if (!db || !authenticator?.verify) throw new TypeError('Production Worker requires D1 and an authenticator')
  const authority=createD1Authority(db,{now,fcmProtector:fcmTokenEncryptionKey ? tokenProtector(fcmTokenEncryptionKey) : null,notificationProvider})
  return { async fetch(request) {
    try {
      const url=new URL(request.url), operation=routes[`${request.method} ${url.pathname}`]
      if(!operation) return json({error:'NOT_FOUND'},404)
      const raw=request.method==='GET' ? '' : await request.text()
      const body=request.method==='GET' ? Object.fromEntries(url.searchParams) : JSON.parse(raw || '{}')
      if (operation === 'pair') {
        const token=request.headers.get('x-pairing-token')
        if (!token) throw fail('PAIRING_TOKEN_REQUIRED')
        if (token.length<43 || token.length>128 || !/^[A-Za-z0-9_-]+$/.test(token)) throw fail('PAIRING_TOKEN_INVALID')
        if (token!==body.token) throw fail('PAIRING_TOKEN_MISMATCH')
        if (Object.keys(body).sort().join(',')!=='householdId,parentId,publicJwk,token') throw fail('PAIRING_BODY_INVALID')
        if (typeof body.publicJwk!=='object' || body.publicJwk===null || Object.keys(body.publicJwk).sort().join(',')!=='crv,kty,x,y' || body.publicJwk.kty!=='EC' || body.publicJwk.crv!=='P-256' || !/^[A-Za-z0-9_-]{43}$/.test(body.publicJwk.x) || !/^[A-Za-z0-9_-]{43}$/.test(body.publicJwk.y)) throw fail('PAIRING_KEY_INVALID')
        try { await crypto.subtle.importKey('jwk',body.publicJwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']) }
        catch { throw fail('PAIRING_KEY_INVALID') }
        return json(await authority.pair({...body,publicJwk:JSON.stringify(body.publicJwk),secretHash:await sha256Hex(token)}))
      }
      const proof=await authenticator.verify({ request, db, method:request.method, canonicalUrl:url.toString(), body:raw, proof:request.headers.get('authorization') })
      if(!proof?.actorId) throw fail('AUTH_REQUIRED')
      const input={...body,actorId:proof.actorId,operationKey:proof.idempotencyKey}
      input.telemetryId = `${proof.actorId}:${proof.idempotencyKey}`
      const operationDigest=`${request.method}:${url.toString()}:${raw}`
      if (operation === 'setup') {
        if (proof.principalKind !== 'setup-authority' || !body.initialParentId || !body.publicJwk || body.initialParentId === proof.actorId) throw fail('FORBIDDEN')
        input.parentId = body.initialParentId
        input.setupToken = proof.idempotencyKey
        const claim=await authority.beginSetupOperation({actorId:proof.actorId,jti:proof.jti,nonce:proof.nonce,idempotencyKey:proof.idempotencyKey,operationDigest})
        if(claim.cached) return json(useCached(claim.cached))
        const result=operationReceipt(operation,input)
        try {
          await authority.withCommit({actorId:proof.actorId,membershipEpoch:0,idempotencyKey:proof.idempotencyKey,operationDigest,ownerToken:claim.ownerToken,receipt:canonicalReceipt(operation,input)}, () => authority.setup(input))
        } catch (error) {
          const terminal={error:error.code||'BAD_REQUEST'}
          await authority.completeOperation({actorId:proof.actorId,membershipEpoch:0,idempotencyKey:proof.idempotencyKey,operationDigest,ownerToken:claim.ownerToken,result:terminal})
          throw error
        }
        return json(result)
      }
      if (operation === 'controls') {
        if (proof.principalKind !== 'operator') throw fail('FORBIDDEN')
        return json(await authority.controls(input))
      }
      if (operation === 'setEnvironmentControls' || operation === 'setHouseholdControls') {
        if (proof.principalKind !== 'operator') throw fail('FORBIDDEN')
        return json(await authority[operation](input))
      }
      await authority.releaseExpiredReservations()
      if (parentOperations.has(operation) && proof.principalKind !== 'parent') throw fail('FORBIDDEN')
      if (pcOperations.has(operation) && (proof.principalKind !== 'pc' || proof.actorId !== input.pcId || proof.householdId !== input.householdId)) throw fail('FORBIDDEN')
      if(request.method==='GET') return json(await authority[operation](input))
      const claim=await authority.beginOperation({householdId:input.householdId,actorId:proof.actorId,principalKind:proof.principalKind,capability:capabilityFor(operation),allowDisabled:operation==='reset'||operation==='disable'||operation==='delete',jti:proof.jti,nonce:proof.nonce,idempotencyKey:proof.idempotencyKey,operationDigest})
      if(claim.cached) {
        const cached=useCached(claim.cached)
        if (operation === 'issuePairing') return json({ ...cached, token: await pairingToken(pairingTokenSecret, proof.actorId, input.householdId, cached.membership_epoch, proof.idempotencyKey) }, 200, { 'Cache-Control': 'no-store' })
        return json(cached)
      }
      input.serverNowMs=now()
      input.membershipEpoch=claim.membershipEpoch
      input.serviceEpoch=proof.serviceEpoch
      if (operation === 'issuePairing') {
        input.pairingSessionId=crypto.randomUUID()
        input.membershipEpoch=claim.membershipEpoch
        input.pairingToken=await pairingToken(pairingTokenSecret, proof.actorId, input.householdId, claim.membershipEpoch, proof.idempotencyKey)
        input.createdAt=now()
        input.expiresAt=input.createdAt+TTL
      }
      if (operation === 'reset') {
        input.nextMembershipEpoch = claim.membershipEpoch + 1
        input.serviceEpoch = proof.serviceEpoch
      }
      await authority.hydrateResponseInput(operation,input)
      const result=operationReceipt(operation,input)
      try {
        await authority.withCommit({actorId:proof.actorId,membershipEpoch:claim.membershipEpoch,idempotencyKey:proof.idempotencyKey,operationDigest,ownerToken:claim.ownerToken,receipt:canonicalReceipt(operation,input)}, () => authority[operation](input))
      } catch (error) {
        const terminal={error:error.code||'BAD_REQUEST'}
        await authority.completeOperation({actorId:proof.actorId,membershipEpoch:claim.membershipEpoch,idempotencyKey:proof.idempotencyKey,operationDigest,ownerToken:claim.ownerToken,result:terminal})
        throw error
      }
      return json(operation === 'issuePairing' ? { ...result, token: input.pairingToken } : result, 200, operation === 'issuePairing' ? { 'Cache-Control': 'no-store' } : {})
    } catch(e) { return json({error:e.code||'BAD_REQUEST'},e.code==='NOT_FOUND'?404:e.code==='FORBIDDEN'?403:e.code==='AUTH_REQUIRED'?401:400) }
  },
  async scheduled() {
    try { return { notifications:await authority.dispatchNotifications(), deletion:await authority.purgeDeleted() } }
    catch (error) { if(error.code==='DEPENDENCY_UNAVAILABLE') return { error:'DEPENDENCY_UNAVAILABLE' }; throw error }
  } }
}
const deployedWorker = (env) => {
  const minimumParentClientVersion=Number(env.MINIMUM_PARENT_CLIENT_VERSION)
  if (!Number.isSafeInteger(minimumParentClientVersion) || minimumParentClientVersion<=0) throw new TypeError('MINIMUM_PARENT_CLIENT_VERSION must be a positive safe integer')
  return createWorker({
    db:env.DB,
    authenticator:createAuthenticator(env.DB,{setupAuthorityId:env.SETUP_AUTHORITY_ID||'global',minimumParentClientVersion}),
    pairingTokenSecret:env.PAIRING_TOKEN_SECRET,
    fcmTokenEncryptionKey:env.FCM_TOKEN_ENCRYPTION_KEY ? Uint8Array.from(atob(env.FCM_TOKEN_ENCRYPTION_KEY),c=>c.charCodeAt(0)) : undefined,
    notificationProvider:httpsNotificationProvider({endpoint:env.NOTIFICATION_PROVIDER_ENDPOINT,bearerToken:env.NOTIFICATION_PROVIDER_BEARER}),
  })
}
export default {
  fetch(request, env) {
    try { return deployedWorker(env).fetch(request) }
    catch { return json({error:'DEPENDENCY_UNAVAILABLE'},503) }
  },
  scheduled(_event, env) {
    return deployedWorker(env).scheduled()
  },
}