#!/usr/bin/env node
/**
 * Ordered D1 migration driver.
 *
 * Modes:
 *   fresh  - the database is empty; apply 0000 and every later migration.
 *   legacy - the database is a recognizable pre-0001 schema with no ledger;
 *            record 0000 in the ledger without re-running it, then apply 0001+.
 *   auto   - detect fresh/legacy/current; abort on any unknown or drifted schema.
 *
 * There is no cross-file transaction. Wrangler/D1 records one ledger row per
 * successfully applied file, so a crash leaves only ledger-recorded files applied
 * and a rerun verifies the fingerprint and applies the pending files exactly once.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASELINE_NAME, applyChain, ensureLedger, hasLedger, isCloudflareReservedObject, MIGRATIONS_TABLE, migrationNames, readMigration, tableNames } from './schemaFingerprint.mjs'
import { resolveEnvironment } from './renderConfig.mjs'
import { runWrangler } from './wrangler.mjs'

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })

const wordCharacter = /[A-Za-z0-9_$\u0080-\uFFFF]/
const multiCharacterOperators = ['->>', '||', '->', '<<', '>>', '<=', '>=', '==', '!=', '<>']

/** Tokenizes canonical SQLite schema SQL without changing quoted token contents. */
function canonicalSql(sql) {
  const source = String(sql)
  const tokens = []
  for (let index = 0; index < source.length;) {
    const character = source[index]
    if (/\s/.test(character)) { index += 1; continue }
    if (source.startsWith('--', index)) {
      const newline = source.indexOf('\n', index + 2)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 2
      continue
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character
      let token = character
      index += 1
      while (index < source.length) {
        token += source[index]
        if (source[index] === close) {
          if (close !== ']' && source[index + 1] === close) {
            token += source[index + 1]
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      tokens.push(token)
      continue
    }
    if (wordCharacter.test(character)) {
      let token = character
      index += 1
      while (index < source.length && wordCharacter.test(source[index])) token += source[index++]
      tokens.push(token)
      continue
    }
    const operator = multiCharacterOperators.find((candidate) => source.startsWith(candidate, index))
    if (operator) {
      tokens.push(operator)
      index += operator.length
      continue
    }
    tokens.push(character)
    index += 1
  }
  return tokens
}

/**
 * Migration contract digest, including the canonical SQL that carries CHECK,
 * FOREIGN KEY and table-level constraints omitted by PRAGMA table_info.
 */
export function migrationFingerprint(sqlite) {
  const objects = sqlite
    .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND lower(substr(name,1,4))<>'_cf_' AND lower(substr(tbl_name,1,4))<>'_cf_' AND name<>'${MIGRATIONS_TABLE}' ORDER BY type,name`)
    .all()
    .map((object) => ({ ...object, sql: canonicalSql(object.sql) }))
  return createHash('sha256').update(JSON.stringify(objects)).digest('hex')
}

/** Fingerprint of a pristine chain state, computed in a throwaway in-memory database. */
function referenceFingerprint(names) {
  const sqlite = new DatabaseSync(':memory:')
  try {
    for (const name of names) sqlite.exec(readMigration(name))
    return migrationFingerprint(sqlite)
  } finally {
    sqlite.close()
  }
}

export function detectMode(sqlite) {
  const names = migrationNames()
  const tables = tableNames(sqlite).filter((name) => name !== MIGRATIONS_TABLE)
  if (hasLedger(sqlite)) {
    const applied = new Set(sqlite.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name))
    const unknown = [...applied].filter((name) => !names.includes(name))
    if (unknown.length > 0) throw fail('SCHEMA_DRIFT', `ledger contains unknown migrations: ${unknown.join(', ')}`)
    const expectedPrefix = names.slice(0, applied.size)
    if (expectedPrefix.length !== applied.size || expectedPrefix.some((name) => !applied.has(name))) {
      throw fail('SCHEMA_DRIFT', 'migration ledger is not an exact filename-ordered prefix')
    }
    const expected = referenceFingerprint(expectedPrefix)
    if (migrationFingerprint(sqlite) !== expected) throw fail('SCHEMA_DRIFT', 'ledger state does not match the recorded migration chain')
    return applied.size === names.length ? 'current' : 'resume'
  }
  if (tables.length === 0) return 'fresh'
  if (migrationFingerprint(sqlite) === referenceFingerprint([BASELINE_NAME])) return 'legacy'
  throw fail('SCHEMA_DRIFT', 'ledger-less schema is not the recognizable pre-0001 baseline')
}

export function planMigration(sqlite, { mode = 'auto' } = {}) {
  if (!['auto', 'fresh', 'legacy'].includes(mode)) throw fail('BAD_ARGUMENT', 'mode must be auto, fresh or legacy')
  const names = migrationNames()
  const detected = detectMode(sqlite)
  if (mode !== 'auto' && mode !== detected && !(mode === 'legacy' && detected === 'legacy')) {
    if (mode === 'fresh' && detected !== 'fresh') throw fail('NOT_EMPTY', `fresh mode requires an empty database but detected "${detected}"`)
    if (mode === 'legacy' && detected !== 'legacy') throw fail('SCHEMA_DRIFT', `legacy mode requires the recognizable pre-0001 baseline but detected "${detected}"`)
  }
  const applied = hasLedger(sqlite) ? new Set(sqlite.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name)) : new Set()
  const pending = names.filter((name) => !applied.has(name))
  return { mode: detected, pending, markOnly: detected === 'legacy' && !applied.has(BASELINE_NAME) ? [BASELINE_NAME] : [] }
}

export function runMigration(sqlite, { mode = 'auto', stopAfter } = {}) {
  const plan = planMigration(sqlite, { mode })
  if (stopAfter && !plan.pending.includes(stopAfter)) throw fail('BAD_ARGUMENT', `--stop-after does not name a pending migration: ${stopAfter}`)
  ensureLedger(sqlite)
  const names = stopAfter ? plan.pending.slice(0, plan.pending.indexOf(stopAfter) + 1) : plan.pending
  const applied = applyChain(sqlite, names, { markOnly: new Set(plan.markOnly) })
  return { mode: plan.mode, applied }
}

const resultRows = (stdout) => {
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? []
}

/** Reconstructs structural D1 state and its migration ledger in an offline SQLite mirror. */
export function reconstructD1Mirror(schemaRows, appliedNames = []) {
  if (!Array.isArray(schemaRows) || !Array.isArray(appliedNames)) throw fail('SCHEMA_READBACK_INVALID', 'D1 schema readback must be arrays')
  const mirror = new DatabaseSync(':memory:')
  const rank = { table: 0, index: 1, trigger: 2, view: 3 }
  let pending = schemaRows
    .filter((row) => row && typeof row.sql === 'string'
      && !String(row.name ?? '').startsWith('sqlite_')
      && !isCloudflareReservedObject(row.name)
      && !isCloudflareReservedObject(row.tbl_name))
    .sort((left, right) => (rank[left.type] ?? 9) - (rank[right.type] ?? 9) || String(left.name).localeCompare(String(right.name)))
  try {
    while (pending.length > 0) {
      const failed = []
      let progress = 0
      for (const row of pending) {
        try {
          mirror.exec(row.sql)
          progress += 1
        } catch (error) {
          failed.push({ row, error })
        }
      }
      if (progress === 0) throw fail('SCHEMA_READBACK_INVALID', `could not reconstruct D1 object ${failed[0]?.row?.name ?? '<unknown>'}: ${failed[0]?.error?.message ?? 'invalid SQL'}`)
      pending = failed.map(({ row }) => row)
    }
    if (appliedNames.length > 0 && !hasLedger(mirror)) throw fail('SCHEMA_READBACK_INVALID', 'D1 returned migration rows without a migration ledger table')
    for (const name of appliedNames) {
      if (typeof name !== 'string') throw fail('SCHEMA_READBACK_INVALID', 'D1 returned a non-string migration name')
      mirror.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE}(name,applied_at) VALUES(?,datetime('now'))`).run(name)
    }
    return mirror
  } catch (error) {
    mirror.close()
    throw error
  }
}

/** Reads the remote/local D1 schema into a throwaway local mirror so detection is offline-safe. */
const d1TargetArgs = (environment, { local, persistTo }) => {
  if (persistTo && !local) throw fail('BAD_ARGUMENT', '--persist-to is valid only with --local')
  return [
    'd1', 'execute', environment.d1DatabaseName,
    '--config', environment.configPath,
    local ? '--local' : '--remote',
    ...(persistTo ? ['--persist-to', persistTo] : []),
  ]
}

export async function readRemoteSchema(environment, { local, persistTo, runner = runWrangler }) {
  const target = d1TargetArgs(environment, { local, persistTo })
  const schemaResult = await runner([
    ...target,
    '--json',
    '--command', "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND lower(substr(name,1,4))<>'_cf_' AND lower(substr(tbl_name,1,4))<>'_cf_' ORDER BY type,name",
  ])
  const schemaRows = resultRows(schemaResult.stdout)
  const hasRemoteLedger = schemaRows.some((row) => row.type === 'table' && row.name === MIGRATIONS_TABLE)
  let appliedNames = []
  if (hasRemoteLedger) {
    const ledgerResult = await runner([
      ...target,
      '--json',
      '--command', `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`,
    ])
    appliedNames = resultRows(ledgerResult.stdout).map((row) => row.name)
  }
  return reconstructD1Mirror(schemaRows, appliedNames)
}

async function applyRemote(environment, plan, { local, persistTo, dryRun, runner = runWrangler }) {
  const staging = mkdtempSync(join(tmpdir(), 'playtime-pact-migrate-'))
  const target = d1TargetArgs(environment, { local, persistTo })
  const receipts = []
  try {
    for (const name of plan.pending) {
      const marked = plan.markOnly.includes(name)
      const body = marked ? '' : readMigration(name)
      const ledger = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT);\nINSERT OR IGNORE INTO ${MIGRATIONS_TABLE}(name,applied_at) VALUES('${name}',datetime('now'));\n`
      const file = join(staging, name)
      writeFileSync(file, `${body}\n${ledger}`, 'utf8')
      const argv = [...target, '--file', file, '--yes']
      if (dryRun) { receipts.push({ name, marked, command: `npx --no-install wrangler ${argv.join(' ')}`, executed: false }); continue }
      await runner(argv)
      const readback = await runner([...target, '--json', '--command', `SELECT name FROM ${MIGRATIONS_TABLE} WHERE name='${name}'`])
      const rows = resultRows(readback.stdout)
      if (rows.length !== 1) throw fail('LEDGER_READBACK_FAILED', `${name} was not recorded in ${MIGRATIONS_TABLE}`)
      receipts.push({ name, marked, executed: true })
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return receipts
}

export async function migrateEnvironment({ env, mode = 'auto', local = false, persistTo, dryRun = false, stopAfter, inputsPath, configPath, runner = runWrangler } = {}) {
  const environment = resolveEnvironment(env, { inputsPath, ...(configPath ? { outputPath: configPath } : {}) })
  if (!existsSync(environment.configPath)) throw fail('CONFIG_MISSING', `render the config first: npm run remote:config:render -- --env ${env}`)
  const mirror = await readRemoteSchema(environment, { local, persistTo, runner })
  try {
    const plan = planMigration(mirror, { mode })
    if (stopAfter && !plan.pending.includes(stopAfter)) throw fail('BAD_ARGUMENT', `--stop-after does not name a pending migration: ${stopAfter}`)
    const selected = stopAfter ? { ...plan, pending: plan.pending.slice(0, plan.pending.indexOf(stopAfter) + 1) } : plan
    const receipts = await applyRemote(environment, selected, { local, persistTo, dryRun, runner })
    return { env, mode: plan.mode, local, dryRun, applied: receipts }
  } finally {
    mirror.close()
  }
}

function parseArgv(argv) {
  const options = { mode: 'auto', local: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--env') options.env = argv[++index]
    else if (flag === '--mode') options.mode = argv[++index]
    else if (flag === '--inputs') options.inputsPath = argv[++index]
    else if (flag === '--config') options.configPath = argv[++index]
    else if (flag === '--persist-to') options.persistTo = argv[++index]
    else if (flag === '--stop-after') options.stopAfter = argv[++index]
    else if (flag === '--local') options.local = true
    else if (flag === '--dry-run') options.dryRun = true
    else throw fail('BAD_ARGUMENT', `unrecognized argument ${flag}`)
  }
  if (!['auto', 'fresh', 'legacy'].includes(options.mode)) throw fail('BAD_ARGUMENT', `--mode must be auto, fresh or legacy`)
  if (!options.env) throw fail('BAD_ARGUMENT', '--env is required')
  if (options.persistTo && !options.local) throw fail('BAD_ARGUMENT', '--persist-to requires --local')
  return options
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  migrateEnvironment(parseArgv(process.argv.slice(2)))
    .then((result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`) })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
