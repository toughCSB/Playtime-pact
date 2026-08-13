import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootstrapAuthorities, readPublicJwk, verifyAuthorities, validateAuthorityArguments } from '../remote-backend/scripts/bootstrapAuthorities.mjs'

const schemaPath = fileURLToPath(new URL('../remote-backend/schema.sql', import.meta.url))

const SETUP_JWK = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' }
const OPERATOR_JWK = { kty: 'EC', crv: 'P-256', x: '0XPqD0dDieR5RDFTYtOL0xTl04joetIpM0259g4YarU', y: 'RtNwJz-qLZZoa-x-nEoi5OkEBDLXlKVc__Efnnd92sw' }
// The authenticator pins keys by their sorted-member canonical form, so that is what is stored.
const canonical = (jwk) => JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })

async function harness(body) {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-authority-'))
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(schemaPath, 'utf8'))
  const setupJwkPath = join(directory, 'setup.jwk.json')
  const operatorJwkPath = join(directory, 'operator.jwk.json')
  writeFileSync(setupJwkPath, JSON.stringify(SETUP_JWK), 'utf8')
  writeFileSync(operatorJwkPath, JSON.stringify(OPERATOR_JWK), 'utf8')
  // A local sqlite executor stands in for `wrangler d1 execute` so the tool is exercised offline.
  const executed = []
  const execute = async (sql) => { executed.push(sql); sqlite.exec(sql); return { ok: true } }
  const query = async (sql) => sqlite.prepare(sql).all()
  try {
    return await body({ directory, sqlite, setupJwkPath, operatorJwkPath, execute, query, executed })
  } finally {
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

const args = (overrides = {}) => ({ setupActor: 'global', operatorActor: 'operator-staging', now: () => 1_700_000_000_000, ...overrides })

test('bootstrap inserts exactly the two public authority rows and reads them back', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, execute, query, sqlite }) => {
    const result = await bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath, execute, query })
    assert.deepEqual(result.setup, { actorId: 'global', status: 'active' })
    assert.deepEqual(result.operator, { actorId: 'operator-staging', status: 'active' })
    const rows = (table) => sqlite.prepare(`SELECT id,public_jwk,status FROM ${table}`).all().map((row) => ({ ...row }))
    assert.deepEqual(rows('setup_authorities'), [{ id: 'global', public_jwk: canonical(SETUP_JWK), status: 'active' }])
    assert.deepEqual(rows('operator_authorities'), [{ id: 'operator-staging', public_jwk: canonical(OPERATOR_JWK), status: 'active' }])
  })
})

test('bootstrap is idempotent and never writes private material or extra rows', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, execute, query, sqlite, executed }) => {
    await bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath, execute, query })
    await bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath, execute, query })
    assert.equal(sqlite.prepare('SELECT count(*) AS c FROM setup_authorities').get().c, 1)
    assert.equal(sqlite.prepare('SELECT count(*) AS c FROM operator_authorities').get().c, 1)
    for (const sql of executed) assert.doesNotMatch(sql, /"d"|'d'\s*:/)
  })
})

test('verify reads back the exact actor, JWK and status values', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, execute, query }) => {
    await bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath, execute, query })
    const report = await verifyAuthorities({ ...args(), setupJwkPath, operatorJwkPath, query })
    assert.equal(report.ok, true)
    assert.deepEqual(report.setup, { actorId: 'global', status: 'active', publicJwkMatches: true })
    assert.deepEqual(report.operator, { actorId: 'operator-staging', status: 'active', publicJwkMatches: true })
  })
})

test('verify fails loudly when an authority row is missing', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, query }) => {
    await assert.rejects(() => verifyAuthorities({ ...args(), setupJwkPath, operatorJwkPath, query }), /AUTHORITY_MISSING/)
  })
})

test('verify fails when the stored public key drifted from the operator file', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, execute, query, sqlite }) => {
    await bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath, execute, query })
    sqlite.exec(`UPDATE operator_authorities SET public_jwk='{"kty":"EC","crv":"P-256","x":"AAAA","y":"BBBB"}'`)
    await assert.rejects(() => verifyAuthorities({ ...args(), setupJwkPath, operatorJwkPath, query }), /AUTHORITY_JWK_MISMATCH/)
  })
})

test('a private JWK is rejected before any statement is executed', async () => {
  await harness(async ({ directory, setupJwkPath, operatorJwkPath, execute, query, executed }) => {
    const privatePath = join(directory, 'private.jwk.json')
    writeFileSync(privatePath, JSON.stringify({ ...OPERATOR_JWK, d: 'PRIVATE-SCALAR-MUST-NEVER-BE-ACCEPTED' }), 'utf8')
    await assert.rejects(() => bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath: privatePath, execute, query }), /PRIVATE_KEY_REJECTED/)
    assert.deepEqual(executed, [])
  })
})

test('a duplicate actor id for setup and operator is rejected', async () => {
  await harness(async ({ setupJwkPath, operatorJwkPath, execute, query, executed }) => {
    await assert.rejects(
      () => bootstrapAuthorities({ ...args({ operatorActor: 'global' }), setupJwkPath, operatorJwkPath, execute, query }),
      /DUPLICATE_ACTOR_ID/,
    )
    assert.deepEqual(executed, [])
  })
})

test('a malformed P-256 public JWK is rejected', async () => {
  await harness(async ({ directory, setupJwkPath, execute, query, executed }) => {
    const badPath = join(directory, 'bad.jwk.json')
    writeFileSync(badPath, JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }), 'utf8')
    await assert.rejects(() => bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath: badPath, execute, query }), /BAD_PUBLIC_JWK/)
    assert.deepEqual(executed, [])
  })
})

test('base64url-sized coordinates that are not a point on P-256 are rejected', async () => {
  await harness(async ({ directory, setupJwkPath, execute, query, executed }) => {
    const badPath = join(directory, 'off-curve.jwk.json')
    writeFileSync(badPath, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }), 'utf8')
    assert.throws(() => readPublicJwk(badPath), /BAD_PUBLIC_JWK/)
    await assert.rejects(() => bootstrapAuthorities({ ...args(), setupJwkPath, operatorJwkPath: badPath, execute, query }), /BAD_PUBLIC_JWK/)
    assert.deepEqual(executed, [])
  })
})

test('actor ids are validated before they can reach a SQL statement', () => {
  assert.throws(() => validateAuthorityArguments({ setupActor: "global'; DROP TABLE setup_authorities;--", operatorActor: 'operator' }), /BAD_ACTOR_ID/)
  assert.throws(() => validateAuthorityArguments({ setupActor: '', operatorActor: 'operator' }), /BAD_ACTOR_ID/)
  assert.deepEqual(validateAuthorityArguments({ setupActor: 'global', operatorActor: 'operator-staging' }), { setupActor: 'global', operatorActor: 'operator-staging' })
})
