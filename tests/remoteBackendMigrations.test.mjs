import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyChain, BASELINE_NAME, MIGRATIONS_TABLE, migrationNames, readMigration, schemaFingerprint, tableNames } from '../remote-backend/scripts/schemaFingerprint.mjs'
import { migrateEnvironment, migrationFingerprint, planMigration, reconstructD1Mirror, runMigration } from '../remote-backend/scripts/migrate.mjs'
import { generateSnapshot } from '../remote-backend/scripts/generate-schema-snapshot.mjs'
import { renderConfig } from '../remote-backend/scripts/renderConfig.mjs'
import { createWranglerLocalHarness } from './helpers/wranglerLocal.mjs'

const schemaPath = fileURLToPath(new URL('../remote-backend/schema.sql', import.meta.url))

const snapshotDatabase = () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(schemaPath, 'utf8'))
  return sqlite
}

const applyLiterally = (names) => {
  const sqlite = new DatabaseSync(':memory:')
  for (const name of names) sqlite.exec(readMigration(name))
  return sqlite
}

test('migration chain starts at the explicit baseline and is ordered by file name', () => {
  const names = migrationNames()
  assert.equal(names[0], BASELINE_NAME)
  assert.deepEqual(names, [...names].sort())
})

test('a directory without the explicit baseline is rejected as an invalid chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-missing-baseline-'))
  try {
    writeFileSync(join(directory, '0001_later.sql'), 'CREATE TABLE later (id TEXT);', 'utf8')
    assert.throws(() => migrationNames(directory), /MIGRATION_CHAIN_INVALID.*0000_baseline/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('baseline plus every later migration reproduces the generated schema snapshot exactly', () => {
  const chain = applyLiterally(migrationNames())
  const snapshot = snapshotDatabase()
  try {
    assert.equal(schemaFingerprint(chain), schemaFingerprint(snapshot))
    assert.deepEqual(tableNames(chain), tableNames(snapshot))
    assert.deepEqual(
      chain.prepare('SELECT id,mode,service_epoch,create_permission,respond_or_issue_permission,consume_permission,control_version FROM environments').all(),
      snapshot.prepare('SELECT id,mode,service_epoch,create_permission,respond_or_issue_permission,consume_permission,control_version FROM environments').all(),
    )
  } finally {
    chain.close()
    snapshot.close()
  }
})

test('the baseline alone does not already contain post-baseline objects', () => {
  const baseline = applyLiterally([BASELINE_NAME])
  try {
    assert.equal(baseline.prepare(`SELECT name FROM sqlite_master WHERE name='deletion_receipts'`).get(), undefined)
    assert.equal(baseline.prepare(`SELECT name FROM sqlite_master WHERE name='permission_control_audit_environment'`).get(), undefined)
    assert.equal(baseline.prepare('PRAGMA table_info(pairing_sessions)').all().some((c) => c.name === 'global_service_epoch'), false)
  } finally {
    baseline.close()
  }
})

test('Cloudflare-reserved objects are excluded from fingerprints, table detection and planning', () => {
  const sqlite = applyLiterally([BASELINE_NAME])
  let mirror
  try {
    const baselineFingerprint = schemaFingerprint(sqlite)
    sqlite.exec('CREATE TABLE _cf_internal_state (id TEXT PRIMARY KEY); CREATE INDEX ordinary_name_on_cf_state ON _cf_internal_state(id);')
    assert.equal(schemaFingerprint(sqlite), baselineFingerprint)
    assert.equal(tableNames(sqlite).includes('_cf_internal_state'), false)
    assert.equal(planMigration(sqlite, { mode: 'auto' }).mode, 'legacy')

    const schemaRows = sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()
    mirror = reconstructD1Mirror(schemaRows, [])
    assert.equal(planMigration(mirror, { mode: 'auto' }).mode, 'legacy')
  } finally {
    mirror?.close()
    sqlite.close()
  }
})

test('an empty database applies 0000 and every later migration once and is resumable', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const first = runMigration(sqlite, { mode: 'auto' })
    assert.equal(first.mode, 'fresh')
    assert.deepEqual(first.applied.map((entry) => entry.name), migrationNames())
    assert.equal(first.applied.every((entry) => entry.marked === false), true)
    assert.equal(schemaFingerprint(sqlite), schemaFingerprint(snapshotDatabase()))

    const second = runMigration(sqlite, { mode: 'auto' })
    assert.equal(second.mode, 'current')
    assert.deepEqual(second.applied, [])
  } finally {
    sqlite.close()
  }
})

test('a recognizable pre-0001 legacy database marks the baseline and applies only 0001+', () => {
  const sqlite = applyLiterally([BASELINE_NAME])
  try {
    const result = runMigration(sqlite, { mode: 'auto' })
    assert.equal(result.mode, 'legacy')
    assert.equal(result.applied[0].name, BASELINE_NAME)
    assert.equal(result.applied[0].marked, true)
    assert.deepEqual(result.applied.slice(1).map((entry) => entry.marked), [false, false, false])
    assert.equal(schemaFingerprint(sqlite), schemaFingerprint(snapshotDatabase()))

    const rerun = runMigration(sqlite, { mode: 'auto' })
    assert.deepEqual(rerun.applied, [])
  } finally {
    sqlite.close()
  }
})

test('a constraint-drifted legacy schema is rejected before the baseline is marked', () => {
  const sqlite = new DatabaseSync(':memory:')
  const driftedBaseline = readMigration(BASELINE_NAME).replace("CHECK(id='global')", "CHECK(id IN ('global','evil'))")
  assert.notEqual(driftedBaseline, readMigration(BASELINE_NAME))
  sqlite.exec(driftedBaseline)
  const objectsBefore = sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
  try {
    assert.throws(() => runMigration(sqlite, { mode: 'auto' }), /SCHEMA_DRIFT/)
    assert.deepEqual(sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(), objectsBefore)
    assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(MIGRATIONS_TABLE), undefined)
    assert.doesNotThrow(() => sqlite.exec("INSERT INTO environments(id,mode,service_epoch) VALUES('evil','LOCAL_ONLY',1)"))
  } finally {
    sqlite.close()
  }
})

const fingerprintSql = (sql) => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(sql)
    return migrationFingerprint(sqlite)
  } finally {
    sqlite.close()
  }
}

test('quoted whitespace remains material across every constraint-bearing schema object', () => {
  const quotedParent = (quote) => `CREATE TABLE parent(${quote[0]}a b${quote[1]} TEXT UNIQUE, ${quote[0]}a  b${quote[1]} TEXT UNIQUE);`
  const cases = [
    ['single-quoted CHECK literal', "CREATE TABLE t(v TEXT CHECK(v='a b'));", "CREATE TABLE t(v TEXT CHECK(v='a  b'));"],
    ['escaped single-quote CHECK literal', "CREATE TABLE t(v TEXT CHECK(v='a '' b'));", "CREATE TABLE t(v TEXT CHECK(v='a  '' b'));"],
    ['double-quoted foreign-key identifier', `${quotedParent(['"', '"'])} CREATE TABLE child(v TEXT REFERENCES parent("a b"));`, `${quotedParent(['"', '"'])} CREATE TABLE child(v TEXT REFERENCES parent("a  b"));`],
    ['escaped double-quote foreign-key identifier', 'CREATE TABLE parent("a "" b" TEXT UNIQUE, "a  "" b" TEXT UNIQUE); CREATE TABLE child(v TEXT REFERENCES parent("a "" b"));', 'CREATE TABLE parent("a "" b" TEXT UNIQUE, "a  "" b" TEXT UNIQUE); CREATE TABLE child(v TEXT REFERENCES parent("a  "" b"));'],
    ['bracketed foreign-key identifier', `${quotedParent(['[', ']'])} CREATE TABLE child(v TEXT REFERENCES parent([a b]));`, `${quotedParent(['[', ']'])} CREATE TABLE child(v TEXT REFERENCES parent([a  b]));`],
    ['backtick foreign-key identifier', `${quotedParent(['`', '`'])} CREATE TABLE child(v TEXT REFERENCES parent(\`a b\`));`, `${quotedParent(['`', '`'])} CREATE TABLE child(v TEXT REFERENCES parent(\`a  b\`));`],
    ['partial-index predicate', "CREATE TABLE t(v TEXT); CREATE INDEX selected ON t(v) WHERE v='a b';", "CREATE TABLE t(v TEXT); CREATE INDEX selected ON t(v) WHERE v='a  b';"],
    ['trigger predicate', "CREATE TABLE t(v TEXT); CREATE TRIGGER selected AFTER INSERT ON t WHEN NEW.v='a b' BEGIN SELECT 1; END;", "CREATE TABLE t(v TEXT); CREATE TRIGGER selected AFTER INSERT ON t WHEN NEW.v='a  b' BEGIN SELECT 1; END;"],
    ['view predicate', "CREATE TABLE t(v TEXT); CREATE VIEW selected AS SELECT * FROM t WHERE v='a b';", "CREATE TABLE t(v TEXT); CREATE VIEW selected AS SELECT * FROM t WHERE v='a  b';"],
  ]
  const collisions = cases.filter(([, canonical, drifted]) => fingerprintSql(canonical) === fingerprintSql(drifted)).map(([name]) => name)
  assert.deepEqual(collisions, [])
})

test('formatting-only whitespace outside SQL tokens has a stable migration fingerprint', () => {
  assert.equal(
    fingerprintSql("CREATE TABLE t(v TEXT CHECK(v='a  b')) STRICT;"),
    fingerprintSql("CREATE /* formatting only */ TABLE t ( v TEXT CHECK ( v = 'a  b' ) ) STRICT;"),
  )
})

test('a partially applied chain resumes at exactly the pending files', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    runMigration(sqlite, { mode: 'auto', stopAfter: '0001_pairing_dual_service_epochs.sql' })
    const resumed = runMigration(sqlite, { mode: 'auto' })
    assert.deepEqual(resumed.applied.map((entry) => entry.name), ['0002_atomic_permission_control_audit.sql', '0003_authenticated_deletion_receipts.sql'])
    assert.equal(schemaFingerprint(sqlite), schemaFingerprint(snapshotDatabase()))
  } finally {
    sqlite.close()
  }
})

test('D1 schema readback restores migration ledger rows before planning a resume', () => {
  const source = new DatabaseSync(':memory:')
  let mirror
  try {
    runMigration(source, { mode: 'auto', stopAfter: '0001_pairing_dual_service_epochs.sql' })
    const schemaRows = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()
    const appliedNames = source.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).all().map((row) => row.name)

    mirror = reconstructD1Mirror(schemaRows, appliedNames)
    const plan = planMigration(mirror, { mode: 'auto' })

    assert.equal(plan.mode, 'resume')
    assert.deepEqual(plan.pending, ['0002_atomic_permission_control_audit.sql', '0003_authenticated_deletion_receipts.sql'])
  } finally {
    mirror?.close()
    source.close()
  }
})

test('a ledger cannot claim a migration when its schema objects are absent', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(`CREATE TABLE ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)`)
    sqlite.prepare(`INSERT INTO ${MIGRATIONS_TABLE}(name,applied_at) VALUES(?,datetime('now'))`).run(BASELINE_NAME)
    assert.throws(() => planMigration(sqlite, { mode: 'auto' }), /SCHEMA_DRIFT/)
  } finally {
    sqlite.close()
  }
})

test('a migration ledger must be an exact filename-ordered prefix', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    runMigration(sqlite, { mode: 'auto', stopAfter: '0002_atomic_permission_control_audit.sql' })
    sqlite.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name='0001_pairing_dual_service_epochs.sql'`).run()

    assert.throws(() => planMigration(sqlite, { mode: 'auto' }), /SCHEMA_DRIFT.*ordered prefix/)
  } finally {
    sqlite.close()
  }
})

test('a failed migration rolls back its schema changes and ledger row together', () => {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-bad-migration-'))
  const sqlite = new DatabaseSync(':memory:')
  const name = '0000_bad.sql'
  writeFileSync(join(directory, name), 'CREATE TABLE partial_apply (id TEXT PRIMARY KEY);\nINSERT INTO missing_table VALUES(1);\n', 'utf8')
  try {
    assert.throws(() => applyChain(sqlite, [name], { directory }), /missing_table/)
    assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial_apply'").get(), undefined)
    assert.equal(sqlite.prepare(`SELECT count(*) AS count FROM ${MIGRATIONS_TABLE}`).get().count, 0)
  } finally {
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unknown or drifted ledger-less schema aborts before changing anything', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE households (id TEXT PRIMARY KEY) STRICT')
  try {
    assert.throws(() => runMigration(sqlite, { mode: 'auto' }), /SCHEMA_DRIFT/)
    assert.deepEqual(tableNames(sqlite), ['households'])
  } finally {
    sqlite.close()
  }
})

test('fresh mode refuses to run against a database that already has tables', () => {
  const sqlite = applyLiterally([BASELINE_NAME])
  try {
    assert.throws(() => runMigration(sqlite, { mode: 'fresh' }), /NOT_EMPTY/)
  } finally {
    sqlite.close()
  }
})

test('legacy mode refuses a database that is not the recognizable pre-0001 baseline', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    assert.throws(() => runMigration(sqlite, { mode: 'legacy' }), /SCHEMA_DRIFT/)
  } finally {
    sqlite.close()
  }
})

test('the committed schema snapshot has not drifted from the migration chain', () => {
  assert.equal(readFileSync(schemaPath, 'utf8'), generateSnapshot())
})

test('invalid mode and stop-after arguments do not mutate an empty database', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    assert.throws(() => planMigration(sqlite, { mode: 'guess' }), /BAD_ARGUMENT/)
    assert.throws(() => runMigration(sqlite, { stopAfter: '9999_missing.sql' }), /BAD_ARGUMENT/)
    assert.deepEqual(tableNames(sqlite), [])
  } finally {
    sqlite.close()
  }
})

test('planMigration reports the pending files without mutating the database', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const plan = planMigration(sqlite, { mode: 'auto' })
    assert.equal(plan.mode, 'fresh')
    assert.deepEqual(plan.pending, migrationNames())
    assert.deepEqual(tableNames(sqlite), [])
  } finally {
    sqlite.close()
  }
})

test('real Wrangler local D1 handles reserved objects across fresh, legacy, resume and drift paths', { timeout: 240_000 }, async () => {
  const harness = createWranglerLocalHarness('playtime-pact-migrations-real-')
  const inputsPath = join(harness.root, 'inputs.json')
  const configPath = join(harness.root, 'wrangler.toml')
  const baselinePath = join(harness.root, '0000_baseline.sql')
  const databaseName = 'playtime-pact-real-migrations'
  const inputs = {
    staging: {
      workerName: 'playtime-pact-real-migrations',
      workerBaseUrl: 'https://local.example.test',
      d1DatabaseName: databaseName,
      d1DatabaseId: '11111111-2222-4333-8444-555555555555',
      firebaseProjectId: 'playtime-pact-local',
      firebaseClientEmail: 'worker@playtime-pact-local.example',
      setupAuthorityActorId: 'global',
      operatorAuthorityActorId: 'operator-local',
    },
  }
  writeFileSync(inputsPath, JSON.stringify(inputs), 'utf8')
  writeFileSync(baselinePath, readMigration(BASELINE_NAME), 'utf8')
  renderConfig({ env: 'staging', inputsPath, outputPath: configPath })
  const absoluteMain = resolve('remote-backend', 'src', 'worker.mjs').replace(/\\/g, '/')
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('main = "../src/worker.mjs"', `main = "${absoluteMain}"`), 'utf8')
  const runner = (argv) => harness.run(argv)
  const migrate = (state, options = {}) => migrateEnvironment({
    env: 'staging',
    inputsPath,
    configPath,
    local: true,
    persistTo: state,
    runner,
    ...options,
  })
  const execute = (state, tail) => harness.run([
    'd1', 'execute', databaseName, '--config', configPath, '--local', '--persist-to', state, ...tail,
  ])
  try {
    const freshState = harness.statePath('fresh')
    const fresh = await migrate(freshState, { mode: 'fresh' })
    assert.deepEqual(fresh.applied.map((entry) => entry.name), migrationNames())
    const reservedResult = await execute(freshState, ['--json', '--command', "SELECT name FROM sqlite_master WHERE lower(substr(name,1,4))='_cf_' ORDER BY name"])
    const reservedPayload = JSON.parse(reservedResult.stdout)
    const reservedRows = (Array.isArray(reservedPayload) ? reservedPayload[0]?.results : reservedPayload?.results) ?? []
    assert.ok(reservedRows.length > 0, 'Wrangler local D1 must expose its reserved _cf_* metadata object')
    const immediate = await migrate(freshState, { mode: 'auto' })
    assert.equal(immediate.mode, 'current')
    assert.deepEqual(immediate.applied, [])

    const legacyState = harness.statePath('legacy')
    await execute(legacyState, ['--file', baselinePath, '--yes'])
    const legacy = await migrate(legacyState, { mode: 'auto' })
    assert.equal(legacy.mode, 'legacy')
    assert.equal(legacy.applied[0].name, BASELINE_NAME)
    assert.equal(legacy.applied[0].marked, true)
    assert.deepEqual(legacy.applied.slice(1).map((entry) => entry.name), migrationNames().slice(1))
    assert.equal((await migrate(legacyState, { mode: 'auto' })).mode, 'current')

    const resumeState = harness.statePath('resume')
    const interrupted = await migrate(resumeState, { mode: 'fresh', stopAfter: '0001_pairing_dual_service_epochs.sql' })
    assert.deepEqual(interrupted.applied.map((entry) => entry.name), migrationNames().slice(0, 2))
    const resumed = await migrate(resumeState, { mode: 'auto' })
    assert.equal(resumed.mode, 'resume')
    assert.deepEqual(resumed.applied.map((entry) => entry.name), migrationNames().slice(2))
    assert.equal((await migrate(resumeState, { mode: 'auto' })).mode, 'current')

    const driftState = harness.statePath('drift')
    await execute(driftState, ['--command', 'CREATE TABLE genuine_operator_drift (id TEXT PRIMARY KEY) STRICT;', '--yes'])
    await assert.rejects(() => migrate(driftState, { mode: 'auto' }), /SCHEMA_DRIFT/)
    const driftReadback = await execute(driftState, ['--json', '--command', "SELECT name FROM sqlite_master WHERE name='genuine_operator_drift'"])
    const driftPayload = JSON.parse(driftReadback.stdout)
    const driftRows = (Array.isArray(driftPayload) ? driftPayload[0]?.results : driftPayload?.results) ?? []
    assert.deepEqual(driftRows.map((row) => row.name), ['genuine_operator_drift'])
  } finally {
    const cleanup = await harness.cleanup()
    assert.deepEqual(cleanup.remainingProcessIds, [])
  }
})
