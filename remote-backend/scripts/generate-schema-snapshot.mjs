#!/usr/bin/env node
/**
 * Regenerates remote-backend/schema.sql from the canonical ordered migration chain.
 * The snapshot exists only so tests and local harnesses can create the current schema
 * in one statement; the migrations remain the source of truth.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrationNames, readMigration } from './schemaFingerprint.mjs'
import { REPOSITORY_ROOT } from './wrangler.mjs'

const SNAPSHOT_PATH = join(REPOSITORY_ROOT, 'remote-backend', 'schema.sql')
const HEADER = '-- Generated from remote-backend/migrations by scripts/generate-schema-snapshot.mjs. Do not edit by hand.\n'

export function generateSnapshot() {
  const sqlite = new DatabaseSync(':memory:')
  try {
    for (const name of migrationNames()) sqlite.exec(readMigration(name))
    const objects = sqlite
      .prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
      .all()
    const lines = ['PRAGMA foreign_keys = ON;']
    for (const object of objects) {
      lines.push(`${object.sql.replace(/\s+/g, ' ').trim()};`)
      if (object.name === 'environments' && object.type === 'table') {
        const seed = sqlite.prepare('SELECT id,mode,service_epoch,create_permission,respond_or_issue_permission,consume_permission,control_version,updated_at_ms FROM environments').all()
        for (const row of seed) {
          lines.push(`INSERT INTO environments(id,mode,service_epoch,create_permission,respond_or_issue_permission,consume_permission,control_version,updated_at_ms) VALUES('${row.id}','${row.mode}',${row.service_epoch},${row.create_permission},${row.respond_or_issue_permission},${row.consume_permission},${row.control_version},${row.updated_at_ms});`)
        }
      }
    }
    return `${HEADER}${lines.join('\n')}\n`
  } finally {
    sqlite.close()
  }
}

export function snapshotIsCurrent(path = SNAPSHOT_PATH) {
  return readFileSync(path, 'utf8') === generateSnapshot()
}

export { SNAPSHOT_PATH }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const contents = generateSnapshot()
  const check = process.argv.includes('--check')
  if (check) {
    if (readFileSync(SNAPSHOT_PATH, 'utf8') !== contents) {
      process.stderr.write('SCHEMA_SNAPSHOT_DRIFT: remote-backend/schema.sql does not match the migration chain\n')
      process.exitCode = 1
    }
  } else {
    writeFileSync(SNAPSHOT_PATH, contents, 'utf8')
    process.stdout.write(`${SNAPSHOT_PATH}\n`)
  }
}
