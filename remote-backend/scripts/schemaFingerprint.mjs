import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))
export const BASELINE_NAME = '0000_baseline.sql'
export const MIGRATIONS_TABLE = 'd1_migrations'
export const isCloudflareReservedObject = (name) => typeof name === 'string' && name.toLowerCase().startsWith('_cf_')

/** Ordered migration file names; filename order is the canonical apply order. */
export function migrationNames(directory = MIGRATIONS_DIR) {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (names[0] !== BASELINE_NAME) throw Object.assign(new Error(`MIGRATION_CHAIN_INVALID: ${BASELINE_NAME} must be the first migration`), { code: 'MIGRATION_CHAIN_INVALID' })
  const malformed = names.find((name) => !/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name))
  if (malformed) throw Object.assign(new Error(`MIGRATION_CHAIN_INVALID: malformed migration filename ${malformed}`), { code: 'MIGRATION_CHAIN_INVALID' })
  return names
}

export function readMigration(name, directory = MIGRATIONS_DIR) {
  return readFileSync(join(directory, name), 'utf8')
}

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim()

/**
 * Structural digest of a SQLite schema. Column order differences produced by
 * ALTER TABLE ADD COLUMN must not be treated as drift, so columns are sorted by
 * name and compared on name/type/notnull/default/pk only.
 */
export function schemaStructure(sqlite) {
  const objects = sqlite
    .prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND lower(substr(name,1,4))<>'_cf_' AND lower(substr(tbl_name,1,4))<>'_cf_' AND name<>'${MIGRATIONS_TABLE}' ORDER BY type,name`)
    .all()
  return objects.map((object) => {
    if (object.type !== 'table') return { type: object.type, name: object.name, sql: normalizeSql(object.sql) }
    const columns = sqlite
      .prepare(`PRAGMA table_info(${JSON.stringify(object.name)})`)
      .all()
      .map((column) => ({ name: column.name, type: column.type, notnull: column.notnull, dflt_value: column.dflt_value, pk: column.pk }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { type: 'table', name: object.name, columns }
  })
}

export function schemaFingerprint(sqlite) {
  return createHash('sha256').update(JSON.stringify(schemaStructure(sqlite))).digest('hex')
}

/** Applies the ordered chain to an open sqlite handle, recording the ledger. */
export function applyChain(sqlite, names, { directory = MIGRATIONS_DIR, markOnly = new Set() } = {}) {
  ensureLedger(sqlite)
  const applied = new Set(sqlite.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name))
  const performed = []
  for (const name of names) {
    if (applied.has(name)) continue
    sqlite.exec('PRAGMA foreign_keys = ON')
    sqlite.exec('BEGIN IMMEDIATE')
    try {
      if (!markOnly.has(name)) sqlite.exec(readMigration(name, directory))
      sqlite.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE}(name,applied_at) VALUES(?,datetime('now'))`).run(name)
      if (!sqlite.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} WHERE name=?`).get(name)) throw new Error(`Migration ledger readback failed for ${name}`)
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
    applied.add(name)
    performed.push({ name, marked: markOnly.has(name) })
  }
  return performed
}

export function ensureLedger(sqlite) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)`)
}

export function hasLedger(sqlite) {
  return Boolean(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE))
}

export function tableNames(sqlite) {
  return sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND lower(substr(name,1,4))<>'_cf_' ORDER BY name`)
    .all()
    .map((row) => row.name)
}
