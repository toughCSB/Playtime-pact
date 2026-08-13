import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { exportJWK, exportPKCS8, flattenedVerify, FlattenedSign, generateKeyPair, importJWK } from 'jose'
import { describe, expect, it } from 'vitest'

import { RemoteApprovalController } from '../src/main/remoteApproval/controller'
import { loadRemoteApprovalRuntimeConfig, remoteMutableStatePath } from '../src/main/remoteApproval/runtimeBroker'
import { ServerClock } from '../src/main/remoteApproval/serverClock'
import { migrateEnvironment } from '../remote-backend/scripts/migrate.mjs'
import { renderConfig } from '../remote-backend/scripts/renderConfig.mjs'
import { createWranglerLocalHarness } from './helpers/wranglerLocal.mjs'

const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) }
const adminJwk = { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }
const provisioningScript = resolve('scripts', 'provision-remote-approval.ps1')
const authorityScript = resolve('scripts', 'invoke-remote-authority.ps1')
const elevatedDriver = resolve('tests', 'drivers', 'verify-provisioning-elevated.ps1')
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const windowsIt = process.platform === 'win32' ? it : it.skip
const elevated = process.platform === 'win32' && spawnSync(powershell, [
  '-NoProfile', '-NonInteractive', '-Command',
  'exit [int](-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))',
]).status === 0
const elevatedWindowsIt = elevated ? it : it.skip

const configFor = (mutableStateDir) => ({
  schemaVersion: 1,
  baseUrl: 'https://approval.example',
  mutableStateDir,
  windowsAccount: 'TEST\Child',
  windowsAccountSid: 'S-1-5-21-111-222-333-1001',
  membership: { householdId: 'household-1', pcId: 'pc-1', membershipEpoch: 3, serviceEpoch: 7 },
  operational: { actorId: 'pc-1', keyName: 'PlaytimePact-pc-1-operational', publicJwk: jwk },
  admin: { actorId: 'parent-admin', keyName: 'PlaytimePact-pc-1-admin', publicJwk: adminJwk, recoveryParentId: 'parent-admin', recoveryPublicJwk: adminJwk },
})

async function sandbox(body) {
  const directory = mkdtempSync(join(tmpdir(), 'playtime-pact-provisioning-'))
  const protectedDir = join(directory, 'ProgramData', 'PlaytimePact', 'remote')
  const mutableDir = join(directory, 'LocalAppData', 'PlaytimePact', 'remote')
  mkdirSync(protectedDir, { recursive: true })
  mkdirSync(mutableDir, { recursive: true })
  const configPath = join(protectedDir, 'config.json')
  try {
    return await body({ directory, protectedDir, mutableDir, configPath })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function runPowerShell(args, { env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    const timeout = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      resolvePromise({ code: null, stdout, stderr, error })
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

const runScript = (path, args, options) => runPowerShell(['-File', path, ...args], options)

function successful(result) {
  expect(result.error).toBeUndefined()
  expect(result.code, result.stderr || result.stdout).toBe(0)
  return result.stdout ? JSON.parse(result.stdout) : null
}

function stateEnvironment(directory) {
  const env = { ...process.env }
  const values = {
    localappdata: join(directory, 'LocalAppData'),
    programdata: join(directory, 'ProgramData'),
  }
  for (const key of Object.keys(env)) {
    const value = values[key.toLowerCase()]
    if (value) env[key] = value
  }
  env.LOCALAPPDATA = values.localappdata
  env.ProgramData = values.programdata
  return env
}

async function inspectAndDeleteKeys(keyNames) {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$names = $env:PLAYTIME_PACT_TEST_KEYS | ConvertFrom-Json
$rows = foreach ($name in $names) {
  $exists = [System.Security.Cryptography.CngKey]::Exists($name, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
  if ($exists) {
    $key = [System.Security.Cryptography.CngKey]::Open($name, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
    try {
      [pscustomobject]@{ name = $name; algorithm = $key.Algorithm.Algorithm; keySize = $key.KeySize; exportPolicy = [string]$key.ExportPolicy }
      $key.Delete()
    } finally { $key.Dispose() }
  }
}
@($rows) | ConvertTo-Json -Compress
`
  const result = await runPowerShell(['-Command', command], {
    env: { ...process.env, PLAYTIME_PACT_TEST_KEYS: JSON.stringify(keyNames) },
  })
  return successful(result) ?? []
}

function publicOnly(value) {
  expect(value).toMatchObject({ kty: 'EC', crv: 'P-256' })
  expect(value.x).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(value.y).toMatch(/^[A-Za-z0-9_-]{43}$/)
  for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) expect(value).not.toHaveProperty(member)
}

function localHttpHarness(responseFor = () => ({ ok: true })) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const captured = {
        method: request.method,
        url: `http://127.0.0.1:${server.address().port}${request.url}`,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(captured)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseFor(captured)))
    })
  })
  return {
    server,
    requests,
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolvePromise)
      })
      return `http://127.0.0.1:${server.address().port}`
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    },
  }
}

async function signedWorkerRequest({ baseUrl, path, method = 'POST', body, actorId, keys, jwk: signingJwk, membershipEpoch, serviceEpoch }) {
  const url = new URL(path, `${baseUrl}/`)
  const payload = method === 'GET' ? '' : JSON.stringify(body)
  const id = randomUUID()
  const claims = {
    actorId,
    clientVersionCode: 1,
    contentDigest: `sha-256=:${createHash('sha256').update(payload).digest('base64')}:`,
    htm: method,
    htu: url.toString(),
    iat: Math.floor(Date.now() / 1000),
    idempotencyKey: `local-e2e-${id}`,
    jti: `local-e2e-jti-${id}`,
    membershipEpoch,
    nonce: `local-e2e-nonce-${id}`,
    serviceEpoch,
  }
  const publicKey = { crv: 'P-256', kty: 'EC', x: signingJwk.x, y: signingJwk.y }
  const token = await new FlattenedSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'ES256', typ: 'remote-approval+jws', jwk: publicKey })
    .sign(keys.privateKey)
  return fetch(url, {
    method,
    headers: { authorization: `Bearer ${JSON.stringify(token)}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : payload,
  })
}

const wranglerRows = (stdout) => {
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? []
}

async function verifyProof(request, expectedJwk) {
  expect(request.headers.authorization).toMatch(/^Bearer /)
  const token = JSON.parse(request.headers.authorization.slice(7))
  const verified = await flattenedVerify(token, await importJWK(expectedJwk, 'ES256'), { algorithms: ['ES256'] })
  const claims = JSON.parse(new TextDecoder().decode(verified.payload))
  expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', typ: 'remote-approval+jws', jwk: expectedJwk })
  expect(claims).toMatchObject({
    htm: request.method,
    htu: request.url,
    contentDigest: `sha-256=:${createHash('sha256').update(request.body).digest('base64')}:`,
  })
  return claims
}

describe('protected configuration and separated mutable state', () => {
  it('loads a protected configuration that declares an explicit mutable state directory', async () => {
    await sandbox(async ({ configPath, mutableDir }) => {
      writeFileSync(configPath, JSON.stringify(configFor(mutableDir)))
      const loaded = loadRemoteApprovalRuntimeConfig(configPath)
      expect(loaded?.mutableStateDir).toBe(mutableDir)
    })
  })

  it('rejects a configuration whose mutable state directory is missing, relative or inside the protected directory', async () => {
    await sandbox(async ({ configPath, protectedDir, mutableDir }) => {
      const { mutableStateDir, ...withoutMutableDir } = configFor(mutableDir)
      writeFileSync(configPath, JSON.stringify(withoutMutableDir))
      expect(() => loadRemoteApprovalRuntimeConfig(configPath)).toThrow('invalid')

      writeFileSync(configPath, JSON.stringify(configFor('relative\\state')))
      expect(() => loadRemoteApprovalRuntimeConfig(configPath)).toThrow('invalid')

      writeFileSync(configPath, JSON.stringify(configFor(protectedDir)))
      expect(() => loadRemoteApprovalRuntimeConfig(configPath)).toThrow('invalid')
    })
  })

  it('derives every mutable runtime path from the configured mutable state directory, never from the protected config', async () => {
    await sandbox(async ({ configPath, mutableDir, protectedDir }) => {
      writeFileSync(configPath, JSON.stringify(configFor(mutableDir)))
      const loaded = loadRemoteApprovalRuntimeConfig(configPath)
      const intentPath = remoteMutableStatePath(loaded, 'intent.json')
      const fencePath = remoteMutableStatePath(loaded, 'relaunch-fence.json')
      expect(intentPath).toBe(join(mutableDir, 'intent.json'))
      expect(fencePath).toBe(join(mutableDir, 'relaunch-fence.json'))
      expect(intentPath.startsWith(protectedDir)).toBe(false)
      expect(fencePath.startsWith(protectedDir)).toBe(false)
    })
  })

  it('writes controller durable intent into mutable state and leaves protected config untouched', async () => {
    await sandbox(async ({ configPath, mutableDir }) => {
      const contents = JSON.stringify(configFor(mutableDir))
      writeFileSync(configPath, contents)
      const loaded = loadRemoteApprovalRuntimeConfig(configPath)
      const intentPath = remoteMutableStatePath(loaded, 'intent.json')
      const client = {
        readStatus: async () => ({ serverNowMs: 1_000, health: { lifecycle: 'online', serviceEpoch: 7, checkedAt: 1_000 } }),
        resetMembership: async () => ({ membershipEpoch: 4, serviceEpoch: 7 }),
        persistMembership() {},
      }
      const controller = new RemoteApprovalController(client, 10_000, () => 1_000, undefined, new ServerClock(() => 1_000, () => 0), intentPath)
      controller.configureMembership({ householdId: 'household-1', pcId: 'pc-1', membershipEpoch: 3, serviceEpoch: 7 })
      await controller.resetMembership()

      expect(readFileSync(configPath, 'utf8')).toBe(contents)
      expect(existsSync(`${configPath}.intent.json`)).toBe(false)
      expect(existsSync(intentPath)).toBe(false)
    })
  })

  it('keeps a disabled configuration active only while mutable reconciliation intent remains', async () => {
    await sandbox(async ({ configPath, mutableDir }) => {
      writeFileSync(configPath, JSON.stringify({ ...configFor(mutableDir), disabled: true }))
      expect(loadRemoteApprovalRuntimeConfig(configPath)).toBeNull()

      writeFileSync(join(mutableDir, 'intent.json'), JSON.stringify({ operation: 'reset', membership: {}, idempotencyKey: 'k' }))
      expect(loadRemoteApprovalRuntimeConfig(configPath)).not.toBeNull()
    })
  })
})

describe('Windows provisioning command contracts', () => {
  windowsIt('PowerShell 5.1 parses the exact action and parameter surfaces', async () => {
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$result = foreach ($path in @($env:PLAYTIME_PACT_PROVISION_SCRIPT, $env:PLAYTIME_PACT_AUTHORITY_SCRIPT, $env:PLAYTIME_PACT_ELEVATED_DRIVER)) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { throw ($errors | ForEach-Object Message | Out-String) }
  $parameters = @{}
  foreach ($parameter in $ast.ParamBlock.Parameters) {
    $name = $parameter.Name.VariablePath.UserPath
    $type = @($parameter.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] } | ForEach-Object { $_.TypeName.FullName })[0]
    $validateSet = @($parameter.Attributes | Where-Object { $_.TypeName.FullName -eq 'ValidateSet' } | ForEach-Object { $_.PositionalArguments | ForEach-Object { $_.SafeGetValue() } })
    $parameters[$name] = @{ type = $type; validateSet = $validateSet }
  }
  [pscustomobject]@{ path = $path; parameters = $parameters }
}
@($result) | ConvertTo-Json -Compress -Depth 8
`
    const result = successful(await runPowerShell(['-Command', command], {
      env: {
        ...process.env,
        PLAYTIME_PACT_PROVISION_SCRIPT: provisioningScript,
        PLAYTIME_PACT_AUTHORITY_SCRIPT: authorityScript,
        PLAYTIME_PACT_ELEVATED_DRIVER: elevatedDriver,
      },
    }))
    const [provisioning, authority, driver] = result
    expect(provisioning.parameters.Action.validateSet).toEqual(['NewPcIdentity', 'RegisterPc', 'IssuePairing', 'ImportRegistration', 'VerifyConfig', 'Disable', 'ResetIdentity'])
    expect(authority.parameters.Action.validateSet).toEqual(['SetupHousehold', 'GetControls', 'SetControls'])
    expect(authority.parameters.Create.type).toBe('switch')
    expect(authority.parameters.RespondOrIssue.type).toBe('switch')
    expect(authority.parameters.Consume.type).toBe('switch')
    expect(driver.parameters.PreflightOnly.type).toBe('switch')
    expect(driver.parameters.ResultPath.type).toBe('string')
  })

  windowsIt('retains an elevated Disable scenario between the idempotent import and ResetIdentity', async () => {
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PLAYTIME_PACT_ELEVATED_DRIVER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | ForEach-Object Message | Out-String) }
$stages = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left.Extent.Text -eq '$stage' -and
  $node.Right.Extent.Text -match "^'"
}, $true) | ForEach-Object { $_.Right.Extent.Text.Trim("'") })
$disableInvocations = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.HashtableAst] -and
  @($node.KeyValuePairs | Where-Object { $_.Item1.Extent.Text -eq 'Action' -and $_.Item2.Extent.Text -eq "'Disable'" }).Count -gt 0
}, $true)).Count
$publishedFields = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
  $node.GetCommandName() -eq 'Publish-Result'
}, $true) | ForEach-Object {
  $_.FindAll({ param($inner) $inner -is [System.Management.Automation.Language.HashtableAst] }, $true)
} | ForEach-Object { $_.KeyValuePairs } | ForEach-Object { $_.Item1.Extent.Text })
[pscustomobject]@{ stages = $stages; disableInvocations = $disableInvocations; publishedFields = $publishedFields } | ConvertTo-Json -Compress -Depth 6
`
    const report = successful(await runPowerShell(['-Command', command], {
      env: { ...process.env, PLAYTIME_PACT_ELEVATED_DRIVER: elevatedDriver },
    }))

    expect(report.disableInvocations).toBeGreaterThanOrEqual(2)
    const disableStages = report.stages.filter((stage) => /disable/i.test(stage))
    expect(disableStages).not.toHaveLength(0)
    const firstDisable = report.stages.indexOf(disableStages[0])
    expect(firstDisable).toBeGreaterThan(report.stages.indexOf('second idempotent import'))
    expect(firstDisable).toBeLessThan(report.stages.indexOf('identity reset'))
    for (const field of ['disableVerified', 'disableIdempotentVerified']) expect(report.publishedFields).toContain(field)
  }, 30_000)

  it('treats a disabled protected configuration as runtime-off unless mutable intent survives', async () => {
    await sandbox(async ({ configPath, mutableDir }) => {
      const enabled = configFor(mutableDir)
      writeFileSync(configPath, JSON.stringify(enabled))
      expect(loadRemoteApprovalRuntimeConfig(configPath)).not.toBeNull()

      const disabled = { ...enabled, disabled: true }
      writeFileSync(configPath, JSON.stringify(disabled))
      expect(loadRemoteApprovalRuntimeConfig(configPath)).toBeNull()
      expect(disabled.operational.keyName).toBe(enabled.operational.keyName)
      expect(disabled.admin.keyName).toBe(enabled.admin.keyName)
      expect(disabled.membership).toEqual(enabled.membership)
    })
  })

  windowsIt('rejects import before any file access when the elevated driver runs non-elevated', async () => {
    const residue = () => readdirSync(tmpdir()).filter((name) => name.startsWith('PlaytimePact-Elevated-')).sort()
    const before = residue()
    const report = successful(await runScript(elevatedDriver, ['-PreflightOnly'], { timeoutMs: 30_000 }))
    expect(report).toMatchObject({ schemaVersion: 1, elevated: expect.any(Boolean) })
    if (report.elevated) {
      const full = successful(await runScript(elevatedDriver, [], { timeoutMs: 120_000 }))
      expect(full).toMatchObject({ importsVerified: 2, exactAclVerified: true, receiptMismatchRejected: true, unwritableProgramDataAtomic: true, cancellationResumeVerified: true, disableVerified: true, disableIdempotentVerified: true, resetCleanupVerified: true })
    } else {
      expect(report).toMatchObject({ nonElevatedImportRejected: true, fullDriverRequired: true })
      const full = await runScript(elevatedDriver, [], { timeoutMs: 30_000 })
      expect(full.code).toBe(1)
      expect(`${full.stdout}\n${full.stderr}`).toContain('ELEVATION_REQUIRED')
    }
    expect(residue()).toEqual(before)
  })

  elevatedWindowsIt('classifies every present config missing a required property separately from an absent config', async () => {
    await sandbox(async ({ directory, configPath }) => {
      const env = stateEnvironment(directory)
      for (const malformed of [{}, { schemaVersion: 1 }]) {
        const serialized = JSON.stringify(malformed)
        writeFileSync(configPath, serialized, 'utf8')

        const invalid = await runScript(provisioningScript, ['-Action', 'VerifyConfig'], { env })
        expect(invalid.code).toBe(1)
        expect(`${invalid.stdout}\n${invalid.stderr}`).toContain('CONFIG_INVALID')
        expect(readFileSync(configPath, 'utf8')).toBe(serialized)
      }

      rmSync(configPath)
      const missing = await runScript(provisioningScript, ['-Action', 'VerifyConfig'], { env })
      expect(missing.code).toBe(1)
      expect(`${missing.stdout}\n${missing.stderr}`).toContain('CONFIG_MISSING')
    })
  })

  elevatedWindowsIt('creates one stable dual-CNG identity, rejects pending-bundle drift, and verifies both keys offline', async () => {
    await sandbox(async ({ directory, mutableDir, configPath }) => {
      const env = stateEnvironment(directory)
      let pcId
      let keyReport = []
      try {
        const first = successful(await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env }))
        pcId = first.pcId
        const keyNames = [`PlaytimePact-${pcId}-operational`, `PlaytimePact-${pcId}-admin`]
        const pendingBytes = readFileSync(first.pendingEnrollment)
        expect(pendingBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
        const bundle = JSON.parse(pendingBytes.toString('utf8'))
        const adminPublic = JSON.parse(readFileSync(first.adminPublicJwk, 'utf8'))
        expect(bundle).toMatchObject({
          schemaVersion: 1,
          pcId,
          recoveryParentId: first.recoveryParentId,
          ianaTimeZone: 'UTC',
          operational: { actorId: pcId, keyName: keyNames[0] },
          admin: { actorId: first.recoveryParentId, keyName: keyNames[1] },
        })
        publicOnly(bundle.operational.publicJwk)
        publicOnly(bundle.admin.publicJwk)
        expect(adminPublic).toEqual(bundle.admin.publicJwk)

        const second = successful(await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env }))
        expect(second).toMatchObject({ pcId: first.pcId, recoveryParentId: first.recoveryParentId })

        writeFileSync(first.pendingEnrollment, JSON.stringify({ ...bundle, operational: { ...bundle.operational, actorId: 'tampered-pc' } }), 'utf8')
        const drifted = await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env })
        expect(drifted.code).toBe(1)
        expect(`${drifted.stdout}\n${drifted.stderr}`).toContain('IDENTITY_MISMATCH')
        writeFileSync(first.pendingEnrollment, JSON.stringify(bundle), 'utf8')

        const config = {
          schemaVersion: 1,
          baseUrl: 'https://approval.example',
          mutableStateDir: mutableDir,
          windowsAccount: bundle.windowsAccount,
          membership: { householdId: 'household-local', pcId, membershipEpoch: 1, serviceEpoch: 1 },
          operational: bundle.operational,
          admin: {
            ...bundle.admin,
            recoveryParentId: bundle.recoveryParentId,
            recoveryPublicJwk: bundle.admin.publicJwk,
          },
        }
        writeFileSync(configPath, JSON.stringify({ ...config, operational: { ...config.operational, keyName: config.admin.keyName } }), 'utf8')
        const badConfig = await runScript(provisioningScript, ['-Action', 'VerifyConfig'], { env })
        expect(badConfig.code).toBe(1)
        expect(`${badConfig.stdout}\n${badConfig.stderr}`).toContain('CONFIG_INVALID')

        writeFileSync(configPath, JSON.stringify(config), 'utf8')
        const verified = successful(await runScript(provisioningScript, ['-Action', 'VerifyConfig'], { env }))
        expect(verified).toMatchObject({ householdId: 'household-local', pcId, mutableStateDir: mutableDir, verified: true })
      } finally {
        if (pcId) keyReport = await inspectAndDeleteKeys([`PlaytimePact-${pcId}-operational`, `PlaytimePact-${pcId}-admin`])
      }
      expect(keyReport).toHaveLength(2)
      for (const key of keyReport) expect(key).toMatchObject({ algorithm: 'ECDSA_P256', keySize: 256, exportPolicy: 'None' })
    })
  }, 30_000)

  elevatedWindowsIt('registers the pending PC with the recovery-parent key and preserves one importable receipt', async () => {
    await sandbox(async ({ directory }) => {
      const env = stateEnvironment(directory)
      const http = localHttpHarness((request) => {
        const body = JSON.parse(request.body)
        return {
          v: 1,
          serverNowMs: 1_700_000_000_000,
          operation: 'registerPc',
          household_id: body.householdId,
          pc_id: body.pcId,
          public_key: body.publicKey,
          iana_time_zone: body.ianaTimeZone,
          membership_epoch: 1,
          service_epoch: 1,
        }
      })
      let pcId
      try {
        const identity = successful(await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env }))
        pcId = identity.pcId
        const bundle = JSON.parse(readFileSync(identity.pendingEnrollment, 'utf8'))
        const baseUrl = await http.listen()
        const args = ['-Action', 'RegisterPc', '-BaseUrl', baseUrl, '-HouseholdId', 'household-local']
        const first = successful(await runScript(provisioningScript, args, { env }))
        expect(first).toMatchObject({ schemaVersion: 1, householdId: 'household-local', pcId, baseUrl })
        expect(first.workerReceipt).toMatchObject({
          operation: 'registerPc',
          household_id: 'household-local',
          pc_id: pcId,
          membership_epoch: 1,
          service_epoch: 1,
        })
        expect(http.requests).toHaveLength(1)
        expect(new URL(http.requests[0].url).pathname).toBe('/v1/pcs')
        expect(JSON.parse(http.requests[0].body)).toEqual({
          householdId: 'household-local',
          pcId,
          publicKey: JSON.stringify(bundle.operational.publicJwk),
          ianaTimeZone: 'UTC',
        })
        const claims = await verifyProof(http.requests[0], bundle.admin.publicJwk)
        expect(claims).toMatchObject({
          actorId: bundle.recoveryParentId,
          idempotencyKey: `register-pc:${pcId}`,
          membershipEpoch: 1,
          serviceEpoch: 1,
        })

        const second = successful(await runScript(provisioningScript, args, { env }))
        expect(second).toEqual(first)
        expect(http.requests).toHaveLength(1)

        const conflicting = await runScript(provisioningScript, ['-Action', 'RegisterPc', '-BaseUrl', baseUrl, '-HouseholdId', 'household-other'], { env })
        expect(conflicting.code).toBe(1)
        expect(`${conflicting.stdout}\n${conflicting.stderr}`).toContain('HOUSEHOLD_MISMATCH')
        expect(http.requests).toHaveLength(1)
      } finally {
        await http.close()
        if (pcId) await inspectAndDeleteKeys([`PlaytimePact-${pcId}-operational`, `PlaytimePact-${pcId}-admin`])
      }
    })
  }, 30_000)

  elevatedWindowsIt('emits Worker-compatible setup and control proofs through the real PowerShell 5.1 surface', async () => {
    await sandbox(async ({ directory }) => {
      const env = stateEnvironment(directory)
      const http = localHttpHarness()
      let pcId
      try {
        const identity = successful(await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env }))
        pcId = identity.pcId
        const bundle = JSON.parse(readFileSync(identity.pendingEnrollment, 'utf8'))
        const baseUrl = await http.listen()
        const setupArgs = [
          '-Action', 'SetupHousehold',
          '-BaseUrl', baseUrl,
          '-HouseholdId', 'household-local',
          '-InitialParentId', bundle.recoveryParentId,
          '-InitialParentJwk', identity.adminPublicJwk,
          '-SetupKeyName', bundle.operational.keyName,
          '-SetupActorId', 'global',
        ]

        successful(await runScript(authorityScript, setupArgs, { env }))
        successful(await runScript(authorityScript, setupArgs, { env }))
        expect(http.requests).toHaveLength(2)
        const firstSetupClaims = await verifyProof(http.requests[0], bundle.operational.publicJwk)
        const secondSetupClaims = await verifyProof(http.requests[1], bundle.operational.publicJwk)
        expect(firstSetupClaims.actorId).toBe('global')
        expect(secondSetupClaims.idempotencyKey).toBe(firstSetupClaims.idempotencyKey)
        expect(JSON.parse(http.requests[0].body)).toEqual({
          householdId: 'household-local',
          initialParentId: bundle.recoveryParentId,
          publicJwk: JSON.stringify(bundle.admin.publicJwk),
          permissions: { create: false, respond_or_issue: false, consume: false },
        })

        successful(await runScript(authorityScript, [
          '-Action', 'GetControls', '-BaseUrl', baseUrl, '-HouseholdId', 'household-local',
          '-OperatorActorId', 'operator-local', '-OperatorKeyName', bundle.operational.keyName,
        ], { env }))
        const getRequest = http.requests[2]
        const getClaims = await verifyProof(getRequest, bundle.operational.publicJwk)
        expect(getClaims.actorId).toBe('operator-local')
        expect(new URL(getRequest.url).pathname).toBe('/v1/controls')
        expect(new URL(getRequest.url).searchParams.get('householdId')).toBe('household-local')
        expect(getRequest.body).toBe('')

        successful(await runScript(authorityScript, [
          '-Action', 'SetControls', '-BaseUrl', baseUrl, '-Scope', 'environment', '-ExpectedVersion', '1',
          '-OperatorActorId', 'operator-local', '-OperatorKeyName', bundle.operational.keyName, '-Consume',
        ], { env }))
        const setRequest = http.requests[3]
        await verifyProof(setRequest, bundle.operational.publicJwk)
        expect(new URL(setRequest.url).pathname).toBe('/v1/environment/controls')
        expect(JSON.parse(setRequest.body)).toEqual({
          permissions: { create: false, respond_or_issue: false, consume: true },
          expectedVersion: 1,
        })
      } finally {
        await http.close()
        if (pcId) await inspectAndDeleteKeys([`PlaytimePact-${pcId}-operational`, `PlaytimePact-${pcId}-admin`])
      }
    })
  }, 30_000)

  elevatedWindowsIt('completes the all-false first-PC pairing window against real Wrangler and restores least privilege', async () => {
    // Local Wrangler reads only these disposable runtime secrets from the config-colocated .dev.vars.
    // JSON string literals are valid dotenv quoted values and preserve the PKCS#8 newlines without
    // placing secrets in command arguments or the repository.
    const disposableServiceAccountKey = await exportPKCS8((await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 })).privateKey)
    const workerSecrets = {
      FCM_PRIVATE_KEY: disposableServiceAccountKey,
      FCM_TOKEN_ENCRYPTION_KEY: createHash('sha256').update('playtime-pact-first-pc-real-token-encryption-key').digest('base64'),
      PAIRING_TOKEN_SECRET: 'test-pairing-token-secret-that-is-at-least-32-bytes',
    }
    const hostileHostEnvironment = {
      FCM_PROJECT_ID: 'hostile-project',
      FCM_CLIENT_EMAIL: 'hostile@example.invalid',
      SETUP_AUTHORITY_ID: 'hostile-authority',
      MINIMUM_PARENT_CLIENT_VERSION: '999999',
      PLAYTIME_PACT_UNRELATED_HOST_SENTINEL: 'must-not-be-a-worker-binding',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
    }
    const observedParentNames = [...Object.keys(hostileHostEnvironment), ...Object.keys(workerSecrets)]
    const parentEnvironmentBefore = observedParentNames.map((name) => ({ name, present: Object.hasOwn(process.env, name), value: process.env[name] }))
    const expectParentEnvironmentUnchanged = () => {
      for (const before of parentEnvironmentBefore) {
        expect(Object.hasOwn(process.env, before.name), before.name).toBe(before.present)
        expect(process.env[before.name], before.name).toBe(before.value)
      }
    }
    // Only fingerprints are checked for accidental output; complete secret values never enter assertions.
    const secretFingerprints = Object.entries(workerSecrets).map(([name, value]) => [name, value.replace(/-----[A-Z ]+-----|\s/g, '').slice(0, 32)])
    const wrangler = createWranglerLocalHarness('playtime-pact-first-pc-real-', {
      processEnv: { ...process.env, ...hostileHostEnvironment },
    })
    expectParentEnvironmentUnchanged()
    let workerServer
    try {
      await sandbox(async ({ directory }) => {
        const env = stateEnvironment(directory)
        const inputsPath = join(wrangler.root, 'inputs.json')
        const configPath = join(wrangler.root, 'wrangler.toml')
        const statePath = wrangler.statePath('worker')
        const databaseName = 'playtime-pact-first-pc-real'
        const inputs = {
          staging: {
            workerName: 'playtime-pact-first-pc-real',
            workerBaseUrl: 'https://local.example.test',
            d1DatabaseName: databaseName,
            d1DatabaseId: '22222222-3333-4444-8555-666666666666',
            firebaseProjectId: 'playtime-pact-local',
            firebaseClientEmail: 'worker@playtime-pact-local.example',
            setupAuthorityActorId: 'global',
            operatorAuthorityActorId: 'operator-local',
          },
        }
        writeFileSync(inputsPath, JSON.stringify(inputs), 'utf8')
        renderConfig({ env: 'staging', inputsPath, outputPath: configPath })
        const absoluteMain = resolve('remote-backend', 'src', 'worker.mjs').replace(/\\/g, '/')
        writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('main = "../src/worker.mjs"', `main = "${absoluteMain}"`), 'utf8')
        writeFileSync(join(wrangler.root, '.dev.vars'), Object.entries(workerSecrets).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n'), 'utf8')
        const runner = (argv) => wrangler.run(argv)
        await migrateEnvironment({ env: 'staging', inputsPath, configPath, local: true, persistTo: statePath, mode: 'fresh', runner })
        const execute = (tail) => wrangler.run(['d1', 'execute', databaseName, '--config', configPath, '--local', '--persist-to', statePath, ...tail])

        let pcId
        let environmentOpened = false
        let householdOpened = false
        let baseUrl
        let bundle
        const setControl = (scope, expectedVersion, enabled) => runScript(authorityScript, [
          '-Action', 'SetControls', '-BaseUrl', baseUrl, '-Scope', scope, '-ExpectedVersion', String(expectedVersion),
          ...(scope === 'household' ? ['-HouseholdId', 'household-real'] : []),
          '-OperatorActorId', 'operator-local', '-OperatorKeyName', bundle.operational.keyName,
          ...(enabled ? ['-RespondOrIssue'] : []),
        ], { env, timeoutMs: 30_000 })
        try {
          const identity = successful(await runScript(provisioningScript, ['-Action', 'NewPcIdentity', '-IanaTimeZone', 'UTC'], { env, timeoutMs: 30_000 }))
          pcId = identity.pcId
          bundle = JSON.parse(readFileSync(identity.pendingEnrollment, 'utf8'))
          const canonicalPublicJwk = JSON.stringify(bundle.operational.publicJwk).replaceAll("'", "''")
          await execute(['--command', `INSERT INTO setup_authorities(id,public_jwk,status,created_at_ms) VALUES('global','${canonicalPublicJwk}','active',1); INSERT INTO operator_authorities(id,public_jwk,status,created_at_ms) VALUES('operator-local','${canonicalPublicJwk}','active',1);`, '--yes'])

          workerServer = wrangler.startWorker([
            'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', '0', '--inspector-port', '0',
            '--persist-to', statePath,
            '--show-interactive-dev-session=false', '--log-level', 'info',
          ])
          baseUrl = await workerServer.readiness

          const startupOutput = `${workerServer.output().stdout}\n${workerServer.output().stderr}`
          for (const [name, expected] of [
            ['FCM_PROJECT_ID', inputs.staging.firebaseProjectId],
            ['FCM_CLIENT_EMAIL', inputs.staging.firebaseClientEmail],
            ['SETUP_AUTHORITY_ID', inputs.staging.setupAuthorityActorId],
            ['MINIMUM_PARENT_CLIENT_VERSION', '1'],
          ]) {
            expect(startupOutput, name).toContain(`${name} (${JSON.stringify(expected)})`)
            expect(startupOutput, name).not.toContain(`${name} (${JSON.stringify(hostileHostEnvironment[name])})`)
          }
          expect(startupOutput).not.toContain('PLAYTIME_PACT_UNRELATED_HOST_SENTINEL')
          expectParentEnvironmentUnchanged()

          const firstResponse = await fetch(`${baseUrl}/v1/households/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const firstBody = await firstResponse.json()
          expect(firstResponse.status, JSON.stringify(firstBody)).toBe(401)
          expect(firstBody).toEqual({ error: 'AUTH_REQUIRED' })

          successful(await runScript(authorityScript, [
            '-Action', 'SetupHousehold', '-BaseUrl', baseUrl, '-HouseholdId', 'household-real',
            '-InitialParentId', bundle.recoveryParentId, '-InitialParentJwk', identity.adminPublicJwk,
            '-SetupKeyName', bundle.operational.keyName, '-SetupActorId', 'global',
          ], { env, timeoutMs: 30_000 }))
          const registration = successful(await runScript(provisioningScript, [
            '-Action', 'RegisterPc', '-BaseUrl', baseUrl, '-HouseholdId', 'household-real',
          ], { env, timeoutMs: 30_000 }))
          expect(registration.workerReceipt).toMatchObject({ operation: 'registerPc', membership_epoch: 1, service_epoch: 1 })

          const initial = successful(await runScript(authorityScript, [
            '-Action', 'GetControls', '-BaseUrl', baseUrl, '-HouseholdId', 'household-real',
            '-OperatorActorId', 'operator-local', '-OperatorKeyName', bundle.operational.keyName,
          ], { env, timeoutMs: 30_000 }))
          expect(initial).toMatchObject({
            environment_create: 0, environment_respond_or_issue: 0, environment_consume: 0, environment_version: 1,
            household_create: 0, household_respond_or_issue: 0, household_consume: 0, household_version: 1,
          })

          const environmentEnabled = successful(await setControl('environment', 1, true))
          environmentOpened = true
          expect(environmentEnabled).toMatchObject({ create_permission: 0, respond_or_issue_permission: 1, consume_permission: 0, control_version: 2 })
          const householdEnabled = successful(await setControl('household', 1, true))
          householdOpened = true
          expect(householdEnabled).toMatchObject({ create_permission: 0, respond_or_issue_permission: 1, consume_permission: 0, control_version: 2 })

          const pairing = successful(await runScript(provisioningScript, [
            '-Action', 'IssuePairing', '-BaseUrl', baseUrl, '-HouseholdId', 'household-real',
          ], { env, timeoutMs: 30_000 }))
          expect(pairing).toMatchObject({ operation: 'issuePairing' })
          expect(pairing.token).toMatch(/^[A-Za-z0-9_-]{43,128}$/)

          const androidKeys = await generateKeyPair('ES256', { extractable: true })
          const androidExport = await exportJWK(androidKeys.publicKey)
          const androidJwk = { crv: 'P-256', kty: 'EC', x: androidExport.x, y: androidExport.y }
          const pairedResponse = await fetch(`${baseUrl}/v1/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pairing-token': pairing.token },
            body: JSON.stringify({ householdId: 'household-real', parentId: pairing.pairing_session_id, publicJwk: androidJwk, token: pairing.token }),
          })
          const paired = await pairedResponse.json()
          expect(pairedResponse.status, JSON.stringify(paired)).toBe(200)
          expect(paired).toMatchObject({ parentId: pairing.pairing_session_id, householdId: 'household-real', membershipEpoch: 1, serviceEpoch: 1 })

          const householdDisabled = successful(await setControl('household', 2, false))
          householdOpened = false
          expect(householdDisabled).toMatchObject({ create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0, control_version: 3, service_epoch: 2 })
          const environmentDisabled = successful(await setControl('environment', 2, false))
          environmentOpened = false
          expect(environmentDisabled).toMatchObject({ create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0, control_version: 3, service_epoch: 2 })

          const finalControls = successful(await runScript(authorityScript, [
            '-Action', 'GetControls', '-BaseUrl', baseUrl, '-HouseholdId', 'household-real',
            '-OperatorActorId', 'operator-local', '-OperatorKeyName', bundle.operational.keyName,
          ], { env, timeoutMs: 30_000 }))
          expect(finalControls).toMatchObject({
            environment_create: 0, environment_respond_or_issue: 0, environment_consume: 0, environment_version: 3, environment_service_epoch: 2,
            household_create: 0, household_respond_or_issue: 0, household_consume: 0, household_version: 3, household_service_epoch: 2,
          })

          const parentStateResponse = await signedWorkerRequest({
            baseUrl,
            path: `/v1/parent/state?householdId=${encodeURIComponent('household-real')}`,
            method: 'GET',
            actorId: pairing.pairing_session_id,
            keys: androidKeys,
            jwk: androidExport,
            membershipEpoch: 1,
            serviceEpoch: 2,
          })
          const parentState = await parentStateResponse.json()
          expect(parentStateResponse.status, JSON.stringify(parentState)).toBe(200)
          expect(parentState).toMatchObject({ v: 1 })
          expect(parentState.devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: pairing.pairing_session_id, status: 'active' })]))

          const workerOutput = `${workerServer.output().stdout}\n${workerServer.output().stderr}`.replace(/\s/g, '')
          expect(secretFingerprints.filter(([, fingerprint]) => workerOutput.includes(fingerprint)).map(([name]) => name)).toEqual([])

          await workerServer.stop()
          workerServer = undefined
          const audit = wranglerRows((await execute(['--json', '--command', 'SELECT scope,previous_version,next_version,create_permission,respond_or_issue_permission,consume_permission FROM permission_control_audit ORDER BY rowid'])).stdout)
          expect(audit.map((row) => ({ ...row }))).toEqual([
            { scope: 'environment', previous_version: 1, next_version: 2, create_permission: 0, respond_or_issue_permission: 1, consume_permission: 0 },
            { scope: 'household', previous_version: 1, next_version: 2, create_permission: 0, respond_or_issue_permission: 1, consume_permission: 0 },
            { scope: 'household', previous_version: 2, next_version: 3, create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0 },
            { scope: 'environment', previous_version: 2, next_version: 3, create_permission: 0, respond_or_issue_permission: 0, consume_permission: 0 },
          ])
          const parentRows = wranglerRows((await execute(['--json', '--command', `SELECT id,status,membership_epoch FROM parent_devices WHERE id='${pairing.pairing_session_id}'`])).stdout)
          expect(parentRows.map((row) => ({ ...row }))).toEqual([{ id: pairing.pairing_session_id, status: 'active', membership_epoch: 1 }])
        } finally {
          if (workerServer && baseUrl && bundle) {
            if (householdOpened) await setControl('household', 2, false).catch(() => undefined)
            if (environmentOpened) await setControl('environment', 2, false).catch(() => undefined)
          }
          if (workerServer) {
            await workerServer.stop()
            workerServer = undefined
          }
          if (pcId) await inspectAndDeleteKeys([`PlaytimePact-${pcId}-operational`, `PlaytimePact-${pcId}-admin`])
        }
      })
    } finally {
      if (workerServer) await workerServer.stop()
      await wrangler.cleanup()
      expectParentEnvironmentUnchanged()
    }
  }, 180_000)
})
