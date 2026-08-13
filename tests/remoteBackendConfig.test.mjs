import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REQUIRED_SECRET_NAMES, renderConfig, validateDeploymentPreflight, validateEnvironmentInput, validateRenderedConfig } from '../remote-backend/scripts/renderConfig.mjs'
import { runWrangler } from '../remote-backend/scripts/wrangler.mjs'

const staging = () => ({
  workerName: 'playtime-pact-remote-approval-staging',
  workerBaseUrl: 'https://staging.example.test',
  d1DatabaseName: 'playtime-pact-remote-approval-staging',
  d1DatabaseId: '11111111-2222-4333-8444-555555555555',
  firebaseProjectId: 'playtime-pact-staging',
  firebaseClientEmail: 'worker@playtime-pact-staging.iam.gserviceaccount.com',
  setupAuthorityActorId: 'global',
  operatorAuthorityActorId: 'operator-staging',
})

const withInputs = (body, mutate = (value) => value) => {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-config-'))
  const inputsPath = join(directory, 'inputs.json')
  writeFileSync(inputsPath, JSON.stringify(mutate({ staging: staging() })), 'utf8')
  try { return body({ directory, inputsPath }) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('rendering staging produces a deterministic secret-free config', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    const first = renderConfig({ env: 'staging', inputsPath, outputPath })
    const second = renderConfig({ env: 'staging', inputsPath, outputPath })
    assert.equal(first.contents, second.contents)
    const contents = readFileSync(outputPath, 'utf8')
    assert.match(contents, /name = "playtime-pact-remote-approval-staging"/)
    assert.match(contents, /database_id = "11111111-2222-4333-8444-555555555555"/)
    assert.match(contents, /FCM_PROJECT_ID = "playtime-pact-staging"/)
    assert.match(contents, /FCM_CLIENT_EMAIL = "worker@playtime-pact-staging\.iam\.gserviceaccount\.com"/)
    assert.match(contents, /^STAGING_OPERATOR_CLEANUP_ENABLED = "false"$/m)
    for (const secret of REQUIRED_SECRET_NAMES) assert.doesNotMatch(contents, new RegExp(`${secret}\\s*=`))
  })
})

test('a zero UUID database id is rejected before anything is written', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    assert.throws(() => renderConfig({ env: 'staging', inputsPath, outputPath }), /d1DatabaseId/)
    assert.throws(() => readFileSync(outputPath, 'utf8'), /ENOENT/)
  }, (value) => ({ staging: { ...value.staging, d1DatabaseId: '00000000-0000-0000-0000-000000000000' } }))
})

test('empty and placeholder identifiers are rejected with the offending key names', () => {
  for (const [key, bad] of [['workerName', ''], ['workerBaseUrl', 'https://example.com/<fill-me>'], ['firebaseProjectId', 'TODO'], ['operatorAuthorityActorId', '   ']]) {
    withInputs(({ directory, inputsPath }) => {
      assert.throws(
        () => renderConfig({ env: 'staging', inputsPath, outputPath: join(directory, 'staging.toml') }),
        new RegExp(key),
      )
    }, (value) => ({ staging: { ...value.staging, [key]: bad } }))
  }
})

test('a non-https worker base url is rejected', () => {
  withInputs(({ directory, inputsPath }) => {
    assert.throws(() => renderConfig({ env: 'staging', inputsPath, outputPath: join(directory, 'staging.toml') }), /workerBaseUrl/)
  }, (value) => ({ staging: { ...value.staging, workerBaseUrl: 'http://staging.example.test' } }))
})

test('only named release environments are accepted', () => {
  withInputs(({ directory, inputsPath }) => {
    assert.throws(() => renderConfig({ env: '../escape', inputsPath, outputPath: join(directory, 'escape.toml') }), /BAD_ENVIRONMENT/)
  }, (value) => ({ ...value, '../escape': staging() }))
})

test('TOML string injection is rejected before a config is written', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    assert.throws(() => renderConfig({ env: 'staging', inputsPath, outputPath }), /firebaseClientEmail/)
    assert.equal(existsSync(outputPath), false)
  }, (value) => ({ staging: { ...value.staging, firebaseClientEmail: 'worker"@example.com' } }))
})

test('a missing environment section names the environment rather than rendering defaults', () => {
  withInputs(({ directory, inputsPath }) => {
    assert.throws(() => renderConfig({ env: 'production', inputsPath, outputPath: join(directory, 'production.toml') }), /production/)
  })
})

test('validation of a rendered config reports the exact secrets that must exist externally', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    renderConfig({ env: 'staging', inputsPath, outputPath })
    const report = validateRenderedConfig({ env: 'staging', inputsPath, outputPath })
    assert.equal(report.ok, true)
    assert.deepEqual(report.requiredSecretNames, [...REQUIRED_SECRET_NAMES])
    assert.equal(report.secretValuesRead, false)
  })
})

test('local config validation never performs external secret-list preflight', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    renderConfig({ env: 'staging', inputsPath, outputPath })
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'remote-backend', 'scripts', 'render-config.mjs'),
      '--validate', '--env', 'staging', '--inputs', inputsPath, '--out', outputPath,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.secretValuesRead, false)
    assert.equal(report.requiredSecretsPresent, undefined)
  })
})

test('external deployment preflight requires every named Worker secret without reading values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-config-preflight-'))
  const inputsPath = join(directory, 'inputs.json')
  const outputPath = join(directory, 'staging.toml')
  writeFileSync(inputsPath, JSON.stringify({ staging: staging() }), 'utf8')
  renderConfig({ env: 'staging', inputsPath, outputPath })
  const calls = []
  try {
    const runner = async (argv) => {
      calls.push(argv)
      return { stdout: JSON.stringify(REQUIRED_SECRET_NAMES.slice(0, -1).map((name) => ({ name, type: 'secret_text' }))) }
    }
    await assert.rejects(
      () => validateDeploymentPreflight({ env: 'staging', inputsPath, outputPath }, { runner }),
      /SECRETS_MISSING.*PAIRING_TOKEN_SECRET/,
    )
    const report = await validateDeploymentPreflight(
      { env: 'staging', inputsPath, outputPath },
      { runner: async (argv) => {
        calls.push(argv)
        return { stdout: JSON.stringify(REQUIRED_SECRET_NAMES.map((name) => ({ name, type: 'secret_text' }))) }
      } },
    )
    assert.equal(report.requiredSecretsPresent, true)
    assert.deepEqual(calls, [
      ['secret', 'list', '--config', outputPath, '--format', 'json'],
      ['secret', 'list', '--config', outputPath, '--format', 'json'],
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('validation fails when the rendered config drifted from the current inputs', () => {
  withInputs(({ directory, inputsPath }) => {
    const outputPath = join(directory, 'staging.toml')
    renderConfig({ env: 'staging', inputsPath, outputPath })
    writeFileSync(outputPath, readFileSync(outputPath, 'utf8').replace('playtime-pact-remote-approval-staging', 'tampered'), 'utf8')
    assert.throws(() => validateRenderedConfig({ env: 'staging', inputsPath, outputPath }), /CONFIG_DRIFT/)
  })
})

test('validateEnvironmentInput accepts only well-formed identifiers', () => {
  assert.deepEqual(validateEnvironmentInput('staging', staging()).errors, [])
  assert.deepEqual(validateEnvironmentInput('staging', { ...staging(), d1DatabaseId: 'not-a-uuid' }).errors, ['staging.d1DatabaseId must be a non-zero UUID'])
})

test('the Wrangler runner resolves the root offline binary on this platform', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-wrangler-version-'))
  try {
    const result = await runWrangler(['--version'], { env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg-config') } })
    assert.match(result.stdout.trim(), /^4\./)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('root and backend npm scripts preserve the documented delegation contract', () => {
  const rootPackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const backendPackage = JSON.parse(readFileSync(join(process.cwd(), 'remote-backend', 'package.json'), 'utf8'))
  const commands = {
    'remote:config:render': ['config:render', 'node scripts/render-config.mjs'],
    'remote:config:validate': ['config:validate', 'node scripts/render-config.mjs --validate'],
    'remote:db:migrate': ['db:migrate', 'node scripts/migrate.mjs'],
    'remote:authority:bootstrap': ['authority:bootstrap', 'node scripts/bootstrap-authorities.mjs'],
    'remote:authority:verify': ['authority:verify', 'node scripts/bootstrap-authorities.mjs --verify'],
    'remote:controls:get': ['controls:get', 'node scripts/control-permissions.mjs'],
    'remote:controls:set': ['controls:set', 'node scripts/control-permissions.mjs --set'],
  }
  for (const [rootName, [backendName, backendCommand]] of Object.entries(commands)) {
    assert.equal(rootPackage.scripts[rootName], `npm --prefix remote-backend run ${backendName} --`)
    assert.equal(backendPackage.scripts[backendName], backendCommand)
  }
  const nodeTestPhase = rootPackage.scripts.test.split('&&')[1]?.trim()
  assert.match(nodeTestPhase, /^node --test --test-concurrency=1 /, 'real local Wrangler integrations must not compete with parallel Node test files')
})

test('deployed Worker consumes only the direct FCM environment contract', () => {
  const source = readFileSync(join(process.cwd(), 'remote-backend', 'src', 'worker.mjs'), 'utf8')
  assert.match(source, /createFcmProvider\(\{projectId:env\.FCM_PROJECT_ID,clientEmail:env\.FCM_CLIENT_EMAIL,privateKey:env\.FCM_PRIVATE_KEY\}\)/)
  assert.doesNotMatch(source, /NOTIFICATION_PROVIDER_ENDPOINT|NOTIFICATION_PROVIDER_BEARER/)
})

test('the obsolete zero-UUID Wrangler config is not a deployable tracked surface', () => {
  assert.equal(existsSync(join(process.cwd(), 'remote-backend', 'wrangler.toml')), false)
})
