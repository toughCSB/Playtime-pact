/**
 * Direct-D1 operator tool that registers the public setup and operator authority rows
 * before the Worker is deployed. It never handles private key material and never calls
 * the Worker, so it is usable on a brand-new database.
 */
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolveEnvironment } from './renderConfig.mjs'
import { runWrangler } from './wrangler.mjs'

const ACTOR_ID = /^[A-Za-z0-9._:-]{1,128}$/
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })

export function validateAuthorityArguments({ setupActor, operatorActor }) {
  for (const [name, value] of [['setup', setupActor], ['operator', operatorActor]]) {
    if (typeof value !== 'string' || !ACTOR_ID.test(value)) throw fail('BAD_ACTOR_ID', `${name} actor id must match ${ACTOR_ID}`)
  }
  if (setupActor === operatorActor) throw fail('DUPLICATE_ACTOR_ID', 'setup and operator actor ids must differ')
  return { setupActor, operatorActor }
}

/** Reads a public P-256 JWK from disk and refuses anything carrying private material. */
export function readPublicJwk(path) {
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw fail('BAD_PUBLIC_JWK', `${path} is not valid JSON: ${error.message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('BAD_PUBLIC_JWK', `${path} is not a JWK object`)
  for (const member of PRIVATE_JWK_MEMBERS) {
    if (member in value) throw fail('PRIVATE_KEY_REJECTED', `${path} contains private key member "${member}"`)
  }
  if (value.kty !== 'EC' || value.crv !== 'P-256' || !B64URL_32.test(String(value.x)) || !B64URL_32.test(String(value.y))) {
    throw fail('BAD_PUBLIC_JWK', `${path} must be a public P-256 EC JWK with base64url x and y`)
  }
  const canonical = { crv: 'P-256', kty: 'EC', x: value.x, y: value.y }
  try { createPublicKey({ key: canonical, format: 'jwk' }) } catch { throw fail('BAD_PUBLIC_JWK', `${path} is not a valid point on P-256`) }
  // Canonical member order matches the on-the-wire pinned key comparison in the authenticator.
  return JSON.stringify(canonical)
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`

function upsertStatement(table, actorId, publicJwk, nowMs) {
  return `INSERT INTO ${table}(id,public_jwk,status,created_at_ms) VALUES(${quote(actorId)},${quote(publicJwk)},'active',${Number(nowMs)}) ON CONFLICT(id) DO UPDATE SET public_jwk=excluded.public_jwk,status='active';`
}

const selectStatement = (table, actorId) => `SELECT id,public_jwk,status FROM ${table} WHERE id=${quote(actorId)};`

function wranglerExecutors(environment, { local }) {
  const base = ['d1', 'execute', environment.d1DatabaseName, '--config', environment.configPath, local ? '--local' : '--remote']
  return {
    async execute(sql) { await runWrangler([...base, '--yes', '--command', sql]); return { ok: true } },
    async query(sql) {
      const { stdout } = await runWrangler([...base, '--json', '--command', sql])
      const parsed = JSON.parse(stdout)
      return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? []
    },
  }
}

async function readAuthority(query, table, actorId) {
  const rows = await query(selectStatement(table, actorId))
  if (rows.length !== 1) throw fail('AUTHORITY_MISSING', `${table} has no active row for ${actorId}`)
  return rows[0]
}

function assertMatches(table, row, actorId, publicJwk) {
  if (row.id !== actorId) throw fail('AUTHORITY_MISSING', `${table} returned ${row.id} instead of ${actorId}`)
  if (row.status !== 'active') throw fail('AUTHORITY_STATUS_INVALID', `${table}.${actorId} status is ${row.status}`)
  if (row.public_jwk !== publicJwk) throw fail('AUTHORITY_JWK_MISMATCH', `${table}.${actorId} public key does not match the supplied JWK file`)
}

export async function bootstrapAuthorities({ setupActor, operatorActor, setupJwkPath, operatorJwkPath, execute, query, now = () => Date.now() } = {}) {
  validateAuthorityArguments({ setupActor, operatorActor })
  const setupJwk = readPublicJwk(setupJwkPath)
  const operatorJwk = readPublicJwk(operatorJwkPath)
  const timestamp = now()
  await execute(upsertStatement('setup_authorities', setupActor, setupJwk, timestamp))
  await execute(upsertStatement('operator_authorities', operatorActor, operatorJwk, timestamp))
  const setupRow = await readAuthority(query, 'setup_authorities', setupActor)
  const operatorRow = await readAuthority(query, 'operator_authorities', operatorActor)
  assertMatches('setup_authorities', setupRow, setupActor, setupJwk)
  assertMatches('operator_authorities', operatorRow, operatorActor, operatorJwk)
  return { setup: { actorId: setupActor, status: setupRow.status }, operator: { actorId: operatorActor, status: operatorRow.status } }
}

export async function verifyAuthorities({ setupActor, operatorActor, setupJwkPath, operatorJwkPath, query } = {}) {
  validateAuthorityArguments({ setupActor, operatorActor })
  const setupJwk = readPublicJwk(setupJwkPath)
  const operatorJwk = readPublicJwk(operatorJwkPath)
  const setupRow = await readAuthority(query, 'setup_authorities', setupActor)
  const operatorRow = await readAuthority(query, 'operator_authorities', operatorActor)
  assertMatches('setup_authorities', setupRow, setupActor, setupJwk)
  assertMatches('operator_authorities', operatorRow, operatorActor, operatorJwk)
  return {
    ok: true,
    setup: { actorId: setupActor, status: setupRow.status, publicJwkMatches: true },
    operator: { actorId: operatorActor, status: operatorRow.status, publicJwkMatches: true },
  }
}

/** Resolves actor ids and JWK paths from CLI flags, falling back to the local inventory. */
export function resolveAuthorityOptions({ env, setupActor, operatorActor, setupJwkPath, operatorJwkPath, inputsPath, local = false }) {
  const environment = resolveEnvironment(env, { inputsPath })
  const inventory = readInventoryPaths(env, inputsPath)
  const options = {
    environment,
    local,
    setupActor: setupActor ?? environment.setupAuthorityActorId,
    operatorActor: operatorActor ?? environment.operatorAuthorityActorId,
    setupJwkPath: setupJwkPath ?? inventory.setupAuthorityPublicJwkPath,
    operatorJwkPath: operatorJwkPath ?? inventory.operatorAuthorityPublicJwkPath,
  }
  if (!options.setupJwkPath) throw fail('BAD_ARGUMENT', '--setup-jwk is required (or set staging.setupAuthorityPublicJwkPath)')
  if (!options.operatorJwkPath) throw fail('BAD_ARGUMENT', '--operator-jwk is required (or set staging.operatorAuthorityPublicJwkPath)')
  return options
}

function readInventoryPaths(env, inputsPath) {
  try {
    const environment = resolveEnvironment(env, { inputsPath })
    return {
      setupAuthorityPublicJwkPath: environment.setupAuthorityPublicJwkPath,
      operatorAuthorityPublicJwkPath: environment.operatorAuthorityPublicJwkPath,
    }
  } catch { return {} }
}

export async function runAuthorityCommand(action, options) {
  const resolved = resolveAuthorityOptions(options)
  const executors = wranglerExecutors(resolved.environment, { local: resolved.local })
  if (action === 'verify') return verifyAuthorities({ ...resolved, query: executors.query })
  return bootstrapAuthorities({ ...resolved, ...executors })
}
