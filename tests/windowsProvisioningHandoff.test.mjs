import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import builderConfig from '../electron-builder.config.cjs'
import { loadRemoteApprovalRuntimeConfig, loadRemoteApprovalRuntimeConfigMetadata } from '../src/main/remoteApproval/runtimeBroker'
import { privilegedPipeSddl } from '../src/main/remoteApproval/privilegedService'

const mainHarness = vi.hoisted(() => ({ serviceWaiters: [] }))
vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: () => tmpdir(),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: {},
  screen: {},
  Tray: class {},
}))
vi.mock('../src/main/remoteApproval/privilegedService', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    __actualNamedPipeTransport: actual.namedPipeTransport,
    __actualStartPrivilegedPipeServer: actual.startPrivilegedPipeServer,
    startPrivilegedPipeServer: async (service) => {
      const waiter = mainHarness.serviceWaiters.shift()
      if (!waiter) throw new Error('Unexpected privileged service start')
      waiter(service)
      return { close: vi.fn() }
    },
  }
})

const originalRemoteConfig = process.env.PLAYTIME_PACT_REMOTE_CONFIG
const originalProgramData = process.env.ProgramData
const sandboxes = []

const jwk = (x, y) => ({ kty: 'EC', crv: 'P-256', x: x.repeat(43), y: y.repeat(43) })

function validConfig(mutableStateDir, householdId) {
  return {
    schemaVersion: 1,
    baseUrl: 'https://approval.example',
    mutableStateDir,
    windowsAccount: 'TEST\Child',
    windowsAccountSid: 'S-1-5-21-111-222-333-1001',
    membership: { householdId, pcId: 'pc-1', membershipEpoch: 3, serviceEpoch: 7 },
    operational: { actorId: 'pc-1', keyName: 'operational-key', publicJwk: jwk('A', 'B') },
    admin: {
      actorId: 'parent-admin',
      keyName: 'admin-key',
      publicJwk: jwk('C', 'D'),
      recoveryParentId: 'parent-admin',
      recoveryPublicJwk: jwk('C', 'D'),
    },
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'playtime-pact-handoff-'))
  sandboxes.push(root)
  const programData = join(root, 'ProgramData')
  const protectedDir = join(programData, 'PlaytimePact', 'remote')
  const mutableDir = join(root, 'LocalAppData', 'PlaytimePact', 'remote')
  mkdirSync(protectedDir, { recursive: true })
  mkdirSync(mutableDir, { recursive: true })
  return { root, programData, protectedDir, mutableDir, defaultPath: join(protectedDir, 'config.json') }
}

async function captureMainPrivilegedService() {
  let resolveService
  const serviceStarted = new Promise((resolve) => { resolveService = resolve })
  mainHarness.serviceWaiters.push(resolveService)
  process.argv.push('--privileged-broker-service')
  vi.resetModules()
  try {
    await import('../src/main/main.ts')
    return await serviceStarted
  } finally {
    const index = process.argv.lastIndexOf('--privileged-broker-service')
    if (index >= 0) process.argv.splice(index, 1)
  }
}

function bootstrapMembership(service, nonce) {
  return service.invoke({
    capability: 'operational',
    purpose: 'remote-approval',
    nonce,
    operation: 'bootstrap-membership',
    payload: {},
  }, 'handoff-test-peer')
}

function restoreEnvironment() {
  if (originalRemoteConfig === undefined) delete process.env.PLAYTIME_PACT_REMOTE_CONFIG
  else process.env.PLAYTIME_PACT_REMOTE_CONFIG = originalRemoteConfig
  if (originalProgramData === undefined) delete process.env.ProgramData
  else process.env.ProgramData = originalProgramData
}

afterEach(() => {
  restoreEnvironment()
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows remote configuration discovery', () => {
  it('prefers an existing PLAYTIME_PACT_REMOTE_CONFIG over the ProgramData candidate', () => {
    const { root, programData, defaultPath } = sandbox()
    const overrideMutable = join(root, 'OverrideState')
    const defaultMutable = join(root, 'DefaultState')
    const overrideProtected = join(root, 'OverrideProtected')
    mkdirSync(overrideMutable)
    mkdirSync(defaultMutable)
    mkdirSync(overrideProtected)
    const overridePath = join(overrideProtected, 'config.json')
    writeFileSync(defaultPath, JSON.stringify(validConfig(defaultMutable, 'default-household')))
    writeFileSync(overridePath, JSON.stringify(validConfig(overrideMutable, 'override-household')))
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = overridePath

    expect(loadRemoteApprovalRuntimeConfig()?.membership.householdId).toBe('override-household')
  })

  it('falls back to an existing ProgramData config when the override candidate is absent', () => {
    const { root, programData, defaultPath, mutableDir } = sandbox()
    writeFileSync(defaultPath, JSON.stringify(validConfig(mutableDir, 'default-household')))
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = join(root, 'missing-override.json')

    expect(loadRemoteApprovalRuntimeConfig()?.membership.householdId).toBe('default-household')
  })

  it('retains the exact pipe account SID when a valid provisioned config is disabled', () => {
    const { programData, defaultPath, mutableDir } = sandbox()
    writeFileSync(defaultPath, JSON.stringify({ ...validConfig(mutableDir, 'disabled-household'), disabled: true }))
    process.env.ProgramData = programData
    delete process.env.PLAYTIME_PACT_REMOTE_CONFIG

    expect(loadRemoteApprovalRuntimeConfig()).toBeNull()
    expect(loadRemoteApprovalRuntimeConfigMetadata()?.windowsAccountSid).toBe('S-1-5-21-111-222-333-1001')
  })

  it('returns local-only mode when neither candidate exists', () => {
    const { root, programData } = sandbox()
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = join(root, 'missing-override.json')

    expect(loadRemoteApprovalRuntimeConfig()).toBeNull()
  })

  it('classifies a malformed present override and does not fall through to ProgramData', () => {
    const { root, programData, defaultPath, mutableDir } = sandbox()
    const overridePath = join(root, 'override.json')
    writeFileSync(defaultPath, JSON.stringify(validConfig(mutableDir, 'default-household')))
    writeFileSync(overridePath, '{not-json')
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = overridePath

    expect(() => loadRemoteApprovalRuntimeConfig()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', configPath: resolve(overridePath) }))
  })

  it('classifies an unreadable present override and does not treat it as absent', () => {
    const { root, programData } = sandbox()
    const unreadableCandidate = join(root, 'config-directory')
    mkdirSync(unreadableCandidate)
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = unreadableCandidate

    expect(() => loadRemoteApprovalRuntimeConfig()).toThrow(expect.objectContaining({ code: 'CONFIG_UNREADABLE', configPath: resolve(unreadableCandidate) }))
  })
})

describe('privileged-service configuration handoff', () => {
  it('bootstraps documented local-only membership when protected config discovery is genuinely absent', async () => {
    const { root, programData } = sandbox()
    process.env.ProgramData = programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = join(root, 'missing-override.json')

    const service = await captureMainPrivilegedService()

    await expect(bootstrapMembership(service, 'absent-config-bootstrap')).resolves.toEqual({
      householdId: 'local-only',
      pcId: 'local-pc',
      membershipEpoch: 1,
      serviceEpoch: 1,
    })
  })

  it.each([
    ['CONFIG_INVALID', ({ root }) => {
      const path = join(root, 'malformed.json')
      writeFileSync(path, '{not-json')
      return path
    }],
    ['CONFIG_UNREADABLE', ({ root }) => {
      const path = join(root, 'unreadable-directory')
      mkdirSync(path)
      return path
    }],
  ])('rejects privileged bootstrap with %s instead of synthesizing local-only membership', async (code, candidate) => {
    const value = sandbox()
    process.env.ProgramData = value.programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = candidate(value)

    const service = await captureMainPrivilegedService()

    await expect(bootstrapMembership(service, `invalid-config-${code}`)).rejects.toMatchObject({ code })
    await expect(service.invoke({
      capability: 'operational',
      purpose: 'remote-approval',
      nonce: `remote-operation-${code}`,
      operation: 'create-request',
      payload: {},
    }, 'handoff-test-peer')).rejects.toMatchObject({ code })
  })

  it('preserves the configuration error code across the privileged transport boundary', async () => {
    const value = sandbox()
    const malformedPath = join(value.root, 'malformed.json')
    writeFileSync(malformedPath, '{not-json')
    process.env.ProgramData = value.programData
    process.env.PLAYTIME_PACT_REMOTE_CONFIG = malformedPath
    const service = await captureMainPrivilegedService()
    const { __actualNamedPipeTransport: namedPipeTransport, __actualStartPrivilegedPipeServer: startPrivilegedPipeServer } = await import('../src/main/remoteApproval/privilegedService')
    const pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\PlaytimePactConfigHandoff-${process.pid}`
      : join(value.root, 'config-handoff.sock')
    const server = await startPrivilegedPipeServer(service, pipe, () => 'handoff-test-peer')

    try {
      const transport = namedPipeTransport(pipe, 1_000, false)
      await expect(transport({
        capability: 'operational',
        purpose: 'remote-approval',
        nonce: 'transport-invalid-config',
        operation: 'bootstrap-membership',
        payload: {},
      })).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('Windows provisioning resource mapping', () => {
  it('binds machine CNG keys, service identity, and pipe access to the privileged boundary', () => {
    const provisioning = readFileSync(resolve('scripts', 'provision-remote-approval.ps1'), 'utf8')
    const installer = readFileSync(resolve('build', 'installer.nsh'), 'utf8')
    const service = readFileSync(resolve('src/main/remoteApproval/privilegedService.ts'), 'utf8')
    const targetSid = 'S-1-5-21-111-222-333-1001'

    expect(provisioning).toContain('CngKeyCreationOptions]::MachineKey')
    expect(provisioning).toContain('CngKeyOpenOptions]::MachineKey')
    expect(provisioning).toContain("'Security Descr'")
    expect(provisioning).toContain('O:SYG:SYD:P(A;;GA;;;SY)')
    expect(provisioning).not.toContain('(A;;GA;;;BA)')
    expect(provisioning).toContain('Resolve-TargetAccount')
    expect(provisioning).toContain('windowsAccount    = $target.account')
    expect(provisioning).toContain('windowsAccountSid = $target.sid')
    expect(provisioning).toContain('mutableStateDir   = $target.mutableStateDir')
    expect(provisioning).not.toContain('$TargetAccount -ne $currentAccount')
    expect(provisioning).not.toContain('$verification = [pscustomobject]@{ verified = $true }')
    expect(provisioning.indexOf('Ensure-ServiceKeyBoundary $bundle')).toBeLessThan(provisioning.indexOf('Install-ProtectedConfig $config $target.account'))
    expect(provisioning).toMatch(/Invoke-NewPcIdentity[\s\S]*?Assert-Administrator/)
    expect(installer).toContain('<user>SYSTEM</user>')
    expect(service).toContain('loadRemoteApprovalRuntimeConfigMetadata()?.windowsAccountSid')
    expect(readFileSync(resolve('tests/drivers/verify-provisioning-elevated.ps1'), 'utf8')).toContain("$stage = 'interrupted key hardening recovery'")
    expect(privilegedPipeSddl(targetSid)).toContain(`(A;;GRGW;;;${targetSid})`)
    expect(privilegedPipeSddl(targetSid)).not.toContain(';;;AU)')
  })

  it('ships only the generic provisioning script at the documented resource path', () => {
    expect(builderConfig.extraResources).toContainEqual({
      from: 'scripts/provision-remote-approval.ps1',
      to: 'provisioning/provision-remote-approval.ps1',
    })
  })

  // Every packaged source must stay on this allowlist. A new entry here is a deliberate
  // decision to ship those bytes to every child PC, so it has to be reviewed as one.
  const ALLOWED_PACKAGED_SOURCES = ['resources', 'scripts/provision-remote-approval.ps1']

  it('packages no source outside the reviewed provisioning/asset allowlist', () => {
    const declared = [...(builderConfig.extraResources ?? []), ...(builderConfig.extraFiles ?? [])]
      .map((entry) => (typeof entry === 'string' ? entry : entry.from))
    expect(declared).not.toHaveLength(0)
    expect([...declared].sort()).toEqual([...ALLOWED_PACKAGED_SOURCES].sort())

    // Bundled app code is limited to build output plus manifest; no environment files.
    const included = (builderConfig.files ?? []).filter((pattern) => !pattern.startsWith('!'))
    expect([...included].sort()).toEqual(['out/**/*', 'package.json'])
  })

  const SECRET_BEARING_NAMES = /(^\.env($|\.)|^\.dev\.vars($|\.)|wrangler.*\.toml$|(^|[.-])config\.json$|google-services\.json$|\.(pem|pfx|p12|jks|keystore|key)$)/i
  const SECRET_BEARING_CONTENT = [
    ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|"d"\s*:\s*"[A-Za-z0-9_-]{20,}/],
    ['firebase credential', /AIza[0-9A-Za-z_-]{30,}|\.iam\.gserviceaccount\.com|messagingSenderId/],
    ['d1/cloudflare identifier', /database_id|d1_databases|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/],
    ['signing credential', /CSC_KEY_PASSWORD|WIN_CSC_LINK|STORE_PASSWORD\s*[:=]\s*\S|AZURE_TRUSTED_SIGNING_[A-Z_]*\s*[:=]\s*\S/],
    ['household/token literal', /householdId"?\s*[:=]\s*["'][A-Za-z0-9._:-]{3,}|pairing[-_]?token"?\s*[:=]\s*["'][A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9_-]{20,}/],
  ]

  function filesUnder(root) {
    if (!existsSync(root)) return []
    if (statSync(root).isFile()) return [root]
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => filesUnder(join(root, entry.name)))
  }

  it('keeps every concretely packaged source free of secret-bearing names and content', () => {
    const sources = ALLOWED_PACKAGED_SOURCES.flatMap((source) => filesUnder(resolve(source)))
    expect(sources).not.toHaveLength(0)

    for (const file of sources) {
      const name = file.split(sep).pop()
      expect(SECRET_BEARING_NAMES.test(name), `${file} has a secret-bearing file name`).toBe(false)
      const contents = readFileSync(file)
      if (contents.includes(0)) continue
      const text = contents.toString('utf8')
      for (const [label, pattern] of SECRET_BEARING_CONTENT) {
        expect(pattern.test(text), `${file} contains a ${label}`).toBe(false)
      }
    }
  })

  it('exposes the provisioning script and no secret-bearing file in a produced artifact tree', () => {
    const packagedRoot = resolve('dist', 'win-unpacked', 'resources')
    if (!existsSync(packagedRoot)) return

    const provisioned = join(packagedRoot, 'provisioning', 'provision-remote-approval.ps1')
    expect(existsSync(provisioned), `${provisioned} is missing from the packaged tree`).toBe(true)
    expect(readFileSync(provisioned)).toEqual(readFileSync(resolve('scripts', 'provision-remote-approval.ps1')))

    const packagedPaths = filesUnder(packagedRoot).map((file) => relative(packagedRoot, file).split(sep).join(posix.sep))
    expect(packagedPaths).toContain('provisioning/provision-remote-approval.ps1')
    for (const packagedPath of packagedPaths) {
      const name = packagedPath.split(posix.sep).pop()
      expect(SECRET_BEARING_NAMES.test(name), `${packagedPath} has a secret-bearing file name`).toBe(false)
    }
  })
})
