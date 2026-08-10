import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

import type { BrokerSignedProofOperations, RemoteApprovalOperation } from './apiClient'

interface RemoteIdentityConfig {
  actorId: string
  keyName: string
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}

const configPaths = new WeakMap<RemoteApprovalRuntimeConfig, string>()
const MAX_SERVER_CLOCK_OFFSET_MS = 5 * 60_000
const MAX_SERVER_CLOCK_ROLLBACK_MS = 1_000
function replaceFileAtomically(temporaryPath: string, path: string): void {
  const backupPath = `${path}.${process.pid}.bak`
  if (existsSync(backupPath)) unlinkSync(backupPath)
  if (!existsSync(path)) {
    renameSync(temporaryPath, path)
    return
  }
  renameSync(path, backupPath)
  try {
    renameSync(temporaryPath, path)
    unlinkSync(backupPath)
  } catch (error) {
    if (!existsSync(path) && existsSync(backupPath)) renameSync(backupPath, path)
    throw error
  }
}

export interface RemoteApprovalRuntimeConfig {
  schemaVersion: 1
  disabled?: boolean
  baseUrl: string
  membership: { householdId: string; pcId: string; membershipEpoch: number; serviceEpoch: number }
  operational: RemoteIdentityConfig
  admin: RemoteIdentityConfig & { recoveryParentId: string; recoveryPublicJwk: RemoteIdentityConfig['publicJwk'] }
}

const CNG_SIGN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$key = [System.Security.Cryptography.CngKey]::Open($env:PLAYTIME_PACT_CNG_KEY, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::None)
if ($key.Provider.Provider -ne 'Microsoft Software Key Storage Provider' -or $key.AlgorithmGroup.AlgorithmGroup -ne 'ECDsa' -or $key.KeySize -ne 256) { throw 'CNG key/provider/curve invalid' }
$forbidden = [System.Security.Cryptography.CngExportPolicies]::AllowExport -bor [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextExport -bor [System.Security.Cryptography.CngExportPolicies]::AllowArchiving -bor [System.Security.Cryptography.CngExportPolicies]::AllowPlaintextArchiving
if (($key.ExportPolicy -band $forbidden) -ne 0) { throw 'CNG key export or archive policy invalid' }
$blob = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
if ($blob.Length -ne 72) { throw 'CNG public key size invalid' }
$x = [Convert]::ToBase64String($blob[8..39]).TrimEnd('=').Replace('+','-').Replace('/','_')
$y = [Convert]::ToBase64String($blob[40..71]).TrimEnd('=').Replace('+','-').Replace('/','_')
if ($x -ne $env:PLAYTIME_PACT_CNG_PUBLIC_X -or $y -ne $env:PLAYTIME_PACT_CNG_PUBLIC_Y) { throw 'CNG public JWK does not match configuration' }
$signer = [System.Security.Cryptography.ECDsaCng]::new($key)
$data = [Convert]::FromBase64String($env:PLAYTIME_PACT_SIGNING_INPUT)
$signature = $signer.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
[Convert]::ToBase64String($signature).TrimEnd('=').Replace('+','-').Replace('/','_')
`

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value)
}

function positiveEpoch(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0
}

function validIdentity(value: unknown): value is RemoteIdentityConfig {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<RemoteIdentityConfig>
  const jwk = identity.publicJwk
  return opaque(identity.actorId) && opaque(identity.keyName)
    && jwk?.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    && typeof jwk.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk.y)
}

export function loadRemoteApprovalRuntimeConfig(path = process.env.PLAYTIME_PACT_REMOTE_CONFIG): RemoteApprovalRuntimeConfig | null {
  if (!path) return null
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RemoteApprovalRuntimeConfig>
  if (value.disabled === true && !existsSync(`${path}.intent.json`)) return null
  const membership = value.membership
  const admin = value.admin
  if (value.schemaVersion !== 1 || !membership || !validIdentity(value.operational) || !validIdentity(admin)
    || !opaque(membership.householdId) || !opaque(membership.pcId)
    || !positiveEpoch(membership.membershipEpoch) || !positiveEpoch(membership.serviceEpoch)
    || value.operational.actorId !== membership.pcId
    || admin.actorId !== admin.recoveryParentId
    || admin.actorId === value.operational.actorId
    || admin.keyName === value.operational.keyName
    || admin.publicJwk.x === value.operational.publicJwk.x && admin.publicJwk.y === value.operational.publicJwk.y
    || !opaque(admin.recoveryParentId) || !validIdentity({ ...admin, publicJwk: admin.recoveryPublicJwk })
    || admin.recoveryPublicJwk.x !== admin.publicJwk.x || admin.recoveryPublicJwk.y !== admin.publicJwk.y) {
    throw new Error('Remote approval configuration is invalid')
  }
  const baseUrl = new URL(String(value.baseUrl))
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(baseUrl.hostname))) {
    throw new Error('Remote approval endpoint must use HTTPS')
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '')
  const config = { ...value, baseUrl: baseUrl.toString().replace(/\/$/, '') } as RemoteApprovalRuntimeConfig
  configPaths.set(config, path)
  return config
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signWithWindowsCng(keyName: string, signingInput: string, publicJwk?: RemoteIdentityConfig['publicJwk']): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows CNG is unavailable'))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CNG_SIGN_SCRIPT], {
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        PLAYTIME_PACT_CNG_KEY: keyName,
        PLAYTIME_PACT_CNG_PUBLIC_X: publicJwk?.x ?? '',
        PLAYTIME_PACT_CNG_PUBLIC_Y: publicJwk?.y ?? '',
        PLAYTIME_PACT_SIGNING_INPUT: Buffer.from(signingInput, 'ascii').toString('base64'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      const signature = stdout.trim()
      if (code !== 0 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) reject(new Error(stderr.trim() || 'CNG signing failed'))
      else resolve(signature)
    })
  })
}

type Route = { method: 'GET' | 'POST' | 'DELETE'; path: string; identity: 'operational' | 'admin'; body: Record<string, unknown> }

function route(operation: RemoteApprovalOperation, payload: Record<string, unknown>, config: RemoteApprovalRuntimeConfig): Route {
  const householdId = config.membership.householdId
  const pcId = config.membership.pcId
  switch (operation) {
    case 'create-request': return { method: 'POST', path: '/v1/requests', identity: 'operational', body: payload.request as Record<string, unknown> }
    case 'consume-grant': {
      const grant = payload.grant as Record<string, unknown>
      const scope = payload.accountingScope as Record<string, unknown>
      return {
        method: 'POST',
        path: '/v1/consume',
        identity: 'operational',
        body: { ...grant, ianaTimeZone: scope.ianaTimeZone, ianaDay: scope.ianaDay },
      }
    }
    case 'read-status': return { method: 'GET', path: '/v1/pc/state', identity: 'operational', body: { householdId, pcId } }
    case 'pair-parent': return { method: 'POST', path: '/v1/pairing-sessions', identity: 'admin', body: { householdId, pcId } }
    case 'revoke-parent': return { method: 'DELETE', path: '/v1/parents', identity: 'admin', body: { householdId, parentId: payload.parentDeviceId } }
    case 'reset-household': return { method: 'POST', path: '/v1/reset', identity: 'admin', body: { householdId, recoveryParentId: config.admin.recoveryParentId, recoveryPublicJwk: JSON.stringify(config.admin.recoveryPublicJwk) } }
    case 'delete-household': return { method: 'DELETE', path: '/v1/household', identity: 'admin', body: { householdId } }
    case 'reconcile-reset': return { method: 'GET', path: '/v1/reset/reconcile', identity: 'admin', body: { householdId } }
    case 'reconcile-delete': return { method: 'GET', path: '/v1/delete/reconcile', identity: 'admin', body: { householdId } }
  }
}

export class WindowsCngRemoteApprovalBroker implements BrokerSignedProofOperations {
  private serverOffsetMs: number | null = null
  private lastServerNowMs = -Infinity
  constructor(
    private readonly config: RemoteApprovalRuntimeConfig,
    private readonly request: typeof fetch = fetch,
    private readonly signer: (keyName: string, signingInput: string, publicJwk?: RemoteIdentityConfig['publicJwk']) => Promise<string> = signWithWindowsCng,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private persist(): void {
    const path = configPaths.get(this.config)
    if (!path) return
    const temporaryPath = `${path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    replaceFileAtomically(temporaryPath, path)
  }

  updateMembership(membership: { membershipEpoch: number; serviceEpoch: number }): void {
    if (!positiveEpoch(membership.membershipEpoch) || !positiveEpoch(membership.serviceEpoch)) throw new Error('Invalid membership epochs')
    this.config.membership = { ...this.config.membership, ...membership }
    this.persist()
  }

  disable(): void {
    this.config.disabled = true
    this.persist()
  }

  authoritativeNow(): number | null {
    if (this.serverOffsetMs === null) return null
    const candidate = this.now() + this.serverOffsetMs
    return Number.isFinite(candidate) && candidate >= this.lastServerNowMs ? candidate : null
  }

  private acceptServerTime(result: unknown, required: boolean): void {
    const serverNowMs = (result as { serverNowMs?: unknown } | null)?.serverNowMs
    if (serverNowMs === undefined && !required) return
    if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) {
      throw Object.assign(new Error('Remote approval server timestamp is unavailable'), { code: 'INVALID_RESPONSE' })
    }
    const offset = serverNowMs - this.now()
    if (Math.abs(offset) > MAX_SERVER_CLOCK_OFFSET_MS
      || serverNowMs + MAX_SERVER_CLOCK_ROLLBACK_MS < this.lastServerNowMs
      || (this.serverOffsetMs !== null && Math.abs(offset - this.serverOffsetMs) > MAX_SERVER_CLOCK_OFFSET_MS)) {
      throw Object.assign(new Error('Remote approval server clock is invalid'), { code: 'INVALID_RESPONSE' })
    }
    this.serverOffsetMs = offset
    this.lastServerNowMs = Math.max(this.lastServerNowMs, serverNowMs)
  }

  async invoke<T>({ operation, payload, idempotencyKey }: { operation: RemoteApprovalOperation; payload: Record<string, unknown>; idempotencyKey: string }): Promise<T> {
    const target = route(operation, payload, this.config)
    const identity = this.config[target.identity]
    const url = new URL(target.path, `${this.config.baseUrl}/`)
    if (target.method === 'GET') {
      for (const [key, value] of Object.entries(target.body)) url.searchParams.set(key, String(value))
    }
    const body = target.method === 'GET' ? '' : JSON.stringify(target.body)
    const protectedHeader = base64url(JSON.stringify({ alg: 'ES256', typ: 'remote-approval+jws', jwk: identity.publicJwk }))
    const contentDigest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
    const claims = base64url(JSON.stringify({
      actorId: identity.actorId,
      htm: target.method,
      htu: url.toString(),
      contentDigest,
      iat: Math.floor(this.now() / 1000),
      idempotencyKey,
      jti: randomUUID(),
      nonce: randomUUID(),
      membershipEpoch: this.config.membership.membershipEpoch,
      serviceEpoch: this.config.membership.serviceEpoch,
    }))
    const signature = await this.signer(identity.keyName, `${protectedHeader}.${claims}`, identity.publicJwk)
    let response: Response
    try {
      response = await this.request(url, {
        method: target.method,
        headers: { authorization: `Bearer ${JSON.stringify({ protected: protectedHeader, payload: claims, signature })}`, 'content-type': 'application/json' },
        body: target.method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw Object.assign(new Error('Remote approval endpoint unavailable'), { code: 'UNAVAILABLE', cause: error })
    }
    const result = await response.json() as T & { error?: string; base_url?: string }
    if (!response.ok) throw Object.assign(new Error('Remote approval request failed'), { code: result?.error ?? `HTTP_${response.status}` })
    this.acceptServerTime(result, operation === 'create-request' || operation === 'consume-grant' || operation === 'read-status')
    if (operation === 'pair-parent') result.base_url = this.config.baseUrl
    return result
  }
}
