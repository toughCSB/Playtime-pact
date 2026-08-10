import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import koffi from 'koffi'
import { verifyAdminPassword, writeAdminPasswordPin } from '../fileStore'
import type { ProtectedAccountingHighWater, ProtectedAccountingScope } from '../../shared/types'
import type { BrokerSignedProofOperations, RemoteApprovalOperation } from './apiClient'
import type { RemoteApprovalRuntimeConfig } from './runtimeBroker'

export const PRIVILEGED_PIPE = '\\\\.\\pipe\\PlaytimePactPrivilegedBroker-v1'
const MAX_FRAME_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 5_000
export type PrivilegedCapability = 'operational' | 'membership' | 'accounting'
export type PrivilegedPurpose = 'remote-approval' | 'membership-sync' | 'start-accounting'
export type PrivilegedRequest = { capability: PrivilegedCapability; purpose: PrivilegedPurpose; nonce: string; adminSession?: string; operation: string; payload: Record<string, unknown> }
export type AccountingFloor = { ianaDay: string; allowanceVersion: number }
export type AccountingState = { scopes: Record<string, ProtectedAccountingHighWater>; floors?: Record<string, AccountingFloor>; globalFloor?: AccountingFloor }
export type PeerVerifier = (socket: Socket) => string | null
export type ProtectedLocalPolicy = {
  version: number
  ianaTimeZone: string
  weekdayLimit: number
  weekendLimit: number
  weekdaySessionCount: number
  weekendSessionCount: number
  allowedStartHour: number
  allowedEndHour: number
  requireApprovalBeforeStart: boolean
}
const validProtectedLocalPolicy = (value: unknown): value is ProtectedLocalPolicy => {
  if (!value || typeof value !== 'object') return false
  const policy = value as Partial<ProtectedLocalPolicy>
  return Number.isSafeInteger(policy.version) && policy.version! > 0
    && typeof policy.ianaTimeZone === 'string' && /^[A-Za-z0-9_+./-]{1,128}$/.test(policy.ianaTimeZone)
    && [policy.weekdayLimit, policy.weekendLimit].every((entry) => Number.isSafeInteger(entry) && entry! > 0 && entry! <= 1440)
    && [policy.weekdaySessionCount, policy.weekendSessionCount].every((entry) => Number.isSafeInteger(entry) && entry! > 0 && entry! <= 48)
    && policy.weekdayLimit! * policy.weekdaySessionCount! <= 1440
    && policy.weekendLimit! * policy.weekendSessionCount! <= 1440
    && [policy.allowedStartHour, policy.allowedEndHour].every((entry) => Number.isSafeInteger(entry) && entry! >= 0 && entry! <= 23)
    && typeof policy.requireApprovalBeforeStart === 'boolean'
}
const nonce = () => randomBytes(24).toString('base64url')
const scopeKey = (scope: ProtectedAccountingScope) => `${scope.householdId}|${scope.pcId}|${scope.gameId}|${scope.ianaTimeZone}|${scope.ianaDay}|${scope.allowanceVersion}`
const validScope = (scope: unknown): scope is ProtectedAccountingScope => {
  if (!scope || typeof scope !== 'object') return false
  const value = scope as Partial<ProtectedAccountingScope>
  return [value.householdId, value.pcId, value.gameId].every((part) => typeof part === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(part))
    && typeof value.ianaTimeZone === 'string' && /^[A-Za-z0-9_+./-]{1,128}$/.test(value.ianaTimeZone)
    && typeof value.ianaDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.ianaDay)
    && Number.isSafeInteger(value.allowanceVersion) && value.allowanceVersion! > 0
    && Number.isSafeInteger(value.totalMs) && value.totalMs! >= 0
}
const validHighWater = (v: ProtectedAccountingHighWater) => Number.isSafeInteger(v.totalMs) && v.totalMs >= 0 && Number.isSafeInteger(v.committedMs) && v.committedMs >= 0 && Number.isSafeInteger(v.reservedMs) && v.reservedMs >= 0 && Number.isSafeInteger(v.version) && v.version >= 0 && v.committedMs + v.reservedMs <= v.totalMs
const validAccounting = (v: AccountingState) => Boolean(v && typeof v === 'object' && v.scopes && Object.values(v.scopes).every(validHighWater) && Object.keys(v.scopes).length <= 512
  && (!v.floors || Object.values(v.floors).every((floor) => /^\d{4}-\d{2}-\d{2}$/.test(floor.ianaDay) && Number.isSafeInteger(floor.allowanceVersion) && floor.allowanceVersion > 0) && Object.keys(v.floors).length <= 512)
  && (!v.globalFloor || (/^\d{4}-\d{2}-\d{2}$/.test(v.globalFloor.ianaDay) && Number.isSafeInteger(v.globalFloor.allowanceVersion) && v.globalFloor.allowanceVersion > 0)))
const floorKey = (scope: ProtectedAccountingScope) => `${scope.householdId}|${scope.pcId}|${scope.gameId}|${scope.ianaTimeZone}`
function compareFloor(left: AccountingFloor, right: AccountingFloor): number {
  return left.ianaDay.localeCompare(right.ianaDay) || left.allowanceVersion - right.allowanceVersion
}
function scopeFromKey(key: string, highWater: ProtectedAccountingHighWater): ProtectedAccountingScope | null {
  const [householdId, pcId, gameId, ianaTimeZone, ianaDay, rawVersion] = key.split('|')
  const allowanceVersion = Number(rawVersion)
  return householdId && pcId && gameId && ianaTimeZone && /^\d{4}-\d{2}-\d{2}$/.test(ianaDay) && Number.isSafeInteger(allowanceVersion)
    ? { householdId, pcId, gameId, ianaTimeZone, ianaDay, allowanceVersion, totalMs: highWater.totalMs }
    : null
}
const currentScopeDay = (scope: ProtectedAccountingScope) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: scope.ianaTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts()
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
function normalizeAccounting(value: AccountingState | ProtectedAccountingHighWater): AccountingState {
  return 'scopes' in value ? value : { scopes: { 'legacy|legacy|legacy|UTC|1970-01-01|1': value } }
}
const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); if (body.length > MAX_FRAME_BYTES) throw new Error('Privileged message too large'); const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]) }
const statePath = (dir: string) => join(dir, 'accounting.journal')
const localPolicyPath = (dir: string) => join(dir, 'local-policy.json')
function readProtectedLocalPolicy(dir?: string): ProtectedLocalPolicy {
  if (!dir || !existsSync(localPolicyPath(dir))) throw new Error('Protected local policy uninitialized')
  const value = JSON.parse(readFileSync(localPolicyPath(dir), 'utf8')) as unknown
  if (!validProtectedLocalPolicy(value)) throw new Error('Protected local policy integrity unavailable')
  return { ...value }
}
function writeProtectedLocalPolicy(dir: string, policy: ProtectedLocalPolicy): void {
  const target = localPolicyPath(dir)
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(policy)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  if (process.platform === 'win32') {
    if (!MoveFileExW || !MoveFileExW(temporary, target, 0x1 | 0x8)) throw new Error('Protected local policy commit failed')
  } else {
    renameSync(temporary, target)
  }
}
type JournalEntry = { previous: string; scopeKey: string; receipt: string; base: string; operation: string; amountMs: number; expiresAt?: number; terminal?: boolean; state: AccountingState; hash: string }
function scopeKeyFromEntry(entry: JournalEntry): string {
  return /^[A-Za-z0-9._:|+-]{1,768}$/.test(entry.scopeKey) ? entry.scopeKey : ''
}
function readJournal(dir: string): JournalEntry[] {
  if (!existsSync(statePath(dir))) return []
  let previous = ''
  const entries: JournalEntry[] = []
  for (const line of readFileSync(statePath(dir), 'utf8').trim().split('\n')) {
    if (!line) continue
    const entry = JSON.parse(line) as JournalEntry
    const hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, state: entry.state })).digest('base64url')
    if (entry.previous !== previous || entry.hash !== hash || !validAccounting(entry.state)
      || entry.scopeKey !== scopeKeyFromEntry(entry) || !/^[A-Za-z0-9._:-]{16,256}$/.test(entry.receipt) || !/^[A-Za-z0-9._:-]{16,256}$/.test(entry.base)) throw new Error('Protected accounting integrity unavailable')
    previous = hash
    entries.push(entry)
  }
  return entries
}
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null
const advapi32 = process.platform === 'win32' ? koffi.load('advapi32.dll') : null
const SecurityAttributes = process.platform === 'win32'
  ? koffi.struct('PPT_SECURITY_ATTRIBUTES', { nLength: 'uint32_t', lpSecurityDescriptor: 'void *', bInheritHandle: 'int32_t' })
  : null
const CreateNamedPipeW = kernel32 && kernel32.func('void * __stdcall CreateNamedPipeW(str16 Name, uint32_t OpenMode, uint32_t PipeMode, uint32_t MaxInstances, uint32_t OutBufferSize, uint32_t InBufferSize, uint32_t DefaultTimeout, PPT_SECURITY_ATTRIBUTES * SecurityAttributes)')
const CreateFileW = kernel32 && kernel32.func('void * __stdcall CreateFileW(str16 Name, uint32_t DesiredAccess, uint32_t ShareMode, void * SecurityAttributes, uint32_t CreationDisposition, uint32_t Flags, void * TemplateFile)')
const ConnectNamedPipe = kernel32 && kernel32.func('bool __stdcall ConnectNamedPipe(void * Pipe, void * Overlapped)')
const ReadFile = kernel32 && kernel32.func('bool __stdcall ReadFile(void * File, void * Buffer, uint32_t BytesToRead, uint32_t * BytesRead, void * Overlapped)')
const WriteFile = kernel32 && kernel32.func('bool __stdcall WriteFile(void * File, void * Buffer, uint32_t BytesToWrite, uint32_t * BytesWritten, void * Overlapped)')
const DisconnectNamedPipe = kernel32 && kernel32.func('bool __stdcall DisconnectNamedPipe(void * Pipe)')
const CancelIoEx = kernel32 && kernel32.func('bool __stdcall CancelIoEx(void * File, void * Overlapped)')
const ConvertStringSecurityDescriptorToSecurityDescriptorW = advapi32 && advapi32.func('int32_t __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 Sddl, uint32_t Revision, _Out_ void ** Descriptor, uint32_t * Size)')
const LocalFree = kernel32 && kernel32.func('void * __stdcall LocalFree(void * Memory)')
const MoveFileExW = kernel32 && kernel32.func('bool __stdcall MoveFileExW(str16 ExistingName, str16 NewName, uint32_t Flags)')
const GetNamedPipeClientProcessId = kernel32 && kernel32.func('bool __stdcall GetNamedPipeClientProcessId(void * Pipe, uint32_t * ClientProcessId)')
const GetNamedPipeServerProcessId = kernel32 && kernel32.func('bool __stdcall GetNamedPipeServerProcessId(void * Pipe, uint32_t * ServerProcessId)')
const OpenSCManagerW = advapi32 && advapi32.func('void * __stdcall OpenSCManagerW(str16 MachineName, str16 DatabaseName, uint32_t DesiredAccess)')
const OpenServiceW = advapi32 && advapi32.func('void * __stdcall OpenServiceW(void * Manager, str16 ServiceName, uint32_t DesiredAccess)')
const QueryServiceStatusEx = advapi32 && advapi32.func('bool __stdcall QueryServiceStatusEx(void * Service, uint32_t InfoLevel, void * Buffer, uint32_t BufferSize, uint32_t * BytesNeeded)')
const OpenProcess = kernel32 && kernel32.func('void * __stdcall OpenProcess(uint32_t Access, bool Inherit, uint32_t ProcessId)')
const QueryFullProcessImageNameW = kernel32 && kernel32.func('bool __stdcall QueryFullProcessImageNameW(void * Process, uint32_t Flags, uint16_t * Name, uint32_t * Size)')
const CloseHandle = kernel32 && kernel32.func('bool __stdcall CloseHandle(void * Handle)')

const invalidWindowsHandle = (handle: unknown) => !handle || handle === -1n || handle === 0xffffffffffffffffn || handle === 0xffffffffn

function windowsProcessForPipe(handle: unknown, getProcessId: typeof GetNamedPipeClientProcessId, installedExecutable: string): { id: number; peer: string } | null {
  if (!getProcessId || !OpenProcess || !QueryFullProcessImageNameW || !CloseHandle) return null
  const pid = Buffer.alloc(4)
  if (!getProcessId(handle, pid) || pid.readUInt32LE(0) === 0) return null
  const processId = pid.readUInt32LE(0)
  const processHandle = OpenProcess(0x1000, false, processId)
  if (invalidWindowsHandle(processHandle)) return null
  try {
    const path = Buffer.alloc(32768)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(16384)
    if (!QueryFullProcessImageNameW(processHandle, 0, path, length)) return null
    const image = path.subarray(0, length.readUInt32LE(0) * 2).toString('utf16le').replace(/\0+$/, '')
    const expected = resolve(installedExecutable).toLowerCase()
    return resolve(image).toLowerCase() === expected ? { id: processId, peer: `${processId}:${expected}` } : null
  } finally {
    CloseHandle(processHandle)
  }
}

function windowsServiceProcessId(): number | null {
  if (!OpenSCManagerW || !OpenServiceW || !QueryServiceStatusEx || !CloseHandle) return null
  const manager = OpenSCManagerW(null, null, 0x0001)
  if (invalidWindowsHandle(manager)) return null
  try {
    const service = OpenServiceW(manager, 'PlaytimePactPrivilegedBroker', 0x0004)
    if (invalidWindowsHandle(service)) return null
    try {
      const status = Buffer.alloc(36)
      const needed = Buffer.alloc(4)
      if (!QueryServiceStatusEx(service, 0, status, status.length, needed) || status.readUInt32LE(4) !== 4) return null
      return status.readUInt32LE(28) || null
    } finally {
      CloseHandle(service)
    }
  } finally {
    CloseHandle(manager)
  }
}
function createSecuredWindowsPipe(pipe: string): unknown {
  if (!CreateNamedPipeW || !ConvertStringSecurityDescriptorToSecurityDescriptorW || !LocalFree || !SecurityAttributes) return null
  const descriptor: [unknown] = [null]
  const sddl = 'D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)'
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, descriptor, null) || !descriptor[0]) return null
  try {
    const handle = CreateNamedPipeW(
      pipe,
      0x00000003 | 0x00080000,
      0x00000004,
      1,
      MAX_FRAME_BYTES + 4,
      MAX_FRAME_BYTES + 4,
      REQUEST_TIMEOUT_MS,
      { nLength: process.arch === 'x64' ? 24 : 12, lpSecurityDescriptor: descriptor[0], bInheritHandle: 0 },
    )
    return invalidWindowsHandle(handle) ? null : handle
  } finally {
    LocalFree(descriptor[0])
  }
}

export class PrivilegedApprovalService {
  private readonly seen = new Map<string, number>(); private readonly tokens = new Map<string, { peer: string; expires: number }>()
  private readonly journal: JournalEntry[]
  private accounting: AccountingState
  private localPolicy: ProtectedLocalPolicy | null
  constructor(private readonly operational: (operation: string, payload: Record<string, unknown>) => Promise<unknown>, private readonly membership: (operation: string, payload: Record<string, unknown>) => Promise<unknown>, accounting: AccountingState | ProtectedAccountingHighWater, private readonly stateDir?: string, private readonly now = () => Date.now(), private readonly verifyPin = (pin: string) => verifyAdminPassword(pin)) {
    this.accounting = normalizeAccounting(accounting)
    this.journal = stateDir ? readJournal(stateDir) : []
    this.localPolicy = stateDir && existsSync(localPolicyPath(stateDir)) ? readProtectedLocalPolicy(stateDir) : null
    this.releaseExpiredReservations()
  }
  static loadAccounting(dir: string): AccountingState {
    const entries = readJournal(dir)
    const state = entries.at(-1)?.state
    return state ? {
      scopes: { ...state.scopes },
      ...(state.floors ? { floors: { ...state.floors } } : {}),
      ...(state.globalFloor ? { globalFloor: { ...state.globalFloor } } : {}),
    } : { scopes: {} }
  }
  static loadLocalPolicy(dir?: string): ProtectedLocalPolicy { return readProtectedLocalPolicy(dir) }
  async invoke(request: PrivilegedRequest, peer: string): Promise<unknown> {
    for (const [value, expires] of this.seen) if (expires < this.now()) this.seen.delete(value)
    if (this.seen.size >= 4096) throw new Error('Privileged service replay capacity denied')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce) || this.seen.has(request.nonce)) throw new Error('Privileged service replay denied')
    this.seen.set(request.nonce, this.now() + 300000)
    if ((request.capability === 'operational' && request.purpose !== 'remote-approval') || (request.capability === 'membership' && request.purpose !== 'membership-sync') || (request.capability === 'accounting' && request.purpose !== 'start-accounting')) throw new Error('Privileged service capability denied')
    if (request.operation === 'verify-pin') { if (request.capability !== 'membership' || !this.verifyPin(String(request.payload.pin ?? ''))) return { ok: false }; if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value!); const token = nonce(); this.tokens.set(token, { peer, expires: this.now() + 300000 }); return { ok: true, token } }
    if (request.capability === 'membership' && !this.consume(request.adminSession, peer)) throw new Error('Privileged service capability denied')
    if (request.operation === 'change-pin') { const pin = String(request.payload.newPin ?? ''); if (!/^\d{4}$/.test(pin)) throw new Error('invalid pin'); writeAdminPasswordPin(pin); for (const [token, session] of this.tokens) if (session.peer === peer) this.tokens.delete(token); return true }
    if (request.operation === 'read-local-policy') {
      if (request.capability !== 'operational' || !this.localPolicy) throw new Error('Protected local policy uninitialized')
      return { ...this.localPolicy }
    }
    if (request.operation === 'set-local-policy') {
      if (request.capability !== 'membership' || !this.stateDir) throw new Error('Privileged service capability denied')
      const proposed = request.payload.policy as Omit<ProtectedLocalPolicy, 'version'>
      const { version: _version, ...current } = this.localPolicy ?? { version: 0, ...proposed }
      const unchanged = this.localPolicy !== null && JSON.stringify(proposed) === JSON.stringify(current)
      const candidate = { ...proposed, version: unchanged ? (this.localPolicy?.version ?? 0) : (this.localPolicy?.version ?? 0) + 1 }
      if (!validProtectedLocalPolicy(candidate)) throw new Error('Protected local policy invalid')
      if (!unchanged) writeProtectedLocalPolicy(this.stateDir, candidate)
      this.localPolicy = candidate
      return { ...candidate }
    }
    if (request.capability === 'operational') return this.operational(request.operation, request.payload)
    if (request.capability === 'membership') return this.membership(request.operation, request.payload)
    return this.accountingOp(request.operation, request.payload)
  }
  private consume(token: string | undefined, peer: string): boolean { const session = token && this.tokens.get(token); return Boolean(session && session.peer === peer && session.expires >= this.now()) }
  private releaseExpiredReservations(): void {
    for (const reserve of this.journal.filter((entry) => entry.operation === 'reserve' && entry.expiresAt !== undefined && entry.expiresAt <= this.now())) {
      const related = this.journal.filter((entry) => entry.base === reserve.base && entry.scopeKey === reserve.scopeKey)
      if (related.some((entry) => entry.operation === 'start' || entry.operation === 'debit' || entry.terminal)) continue
      const [householdId, pcId, gameId, ianaTimeZone, ianaDay, rawVersion] = reserve.scopeKey.split('|')
      const current = this.accounting.scopes[reserve.scopeKey]
      if (!current) continue
      try {
        this.accountingOp('reconcile', { scope: { householdId, pcId, gameId, ianaTimeZone, ianaDay, allowanceVersion: Number(rawVersion), totalMs: current.totalMs }, receipt: `${reserve.base}:reconcile-terminal`, expectedVersion: current.version, terminal: true })
      } catch { throw new Error('Protected accounting integrity unavailable') }
    }
  }
  private compactJournal(): void {
    if (!this.stateDir || this.journal.length <= 1024) return
    const retainedScopes: Record<string, ProtectedAccountingHighWater> = {}
    const floors = { ...(this.accounting.floors ?? {}) }
    let globalFloor = this.accounting.globalFloor
    for (const [key, highWater] of Object.entries(this.accounting.scopes)) {
      const scope = scopeFromKey(key, highWater)
      if (!scope) throw new Error('Protected accounting integrity unavailable')
      const floor = { ianaDay: scope.ianaDay, allowanceVersion: scope.allowanceVersion }
      if (highWater.reservedMs > 0 || scope.ianaDay === currentScopeDay(scope)) retainedScopes[key] = highWater
      else {
        const domain = floorKey(scope)
        if (!floors[domain] || compareFloor(floors[domain], floor) < 0) floors[domain] = floor
        if (!globalFloor || compareFloor(globalFloor, floor) < 0) globalFloor = floor
      }
    }
    const boundedFloors = Object.fromEntries(Object.entries(floors).sort(([, a], [, b]) => compareFloor(b, a)).slice(0, 512))
    const checkpointState: AccountingState = { scopes: retainedScopes, floors: boundedFloors, ...(globalFloor ? { globalFloor } : {}) }
    if (!validAccounting(checkpointState) || Object.keys(retainedScopes).length === 0) throw new Error('Protected accounting compaction unavailable')
    const checkpointKey = Object.keys(retainedScopes)[0]
    const base = `checkpoint-${Date.now()}-0001`
    const hash = createHash('sha256').update(JSON.stringify({ previous: '', scopeKey: checkpointKey, receipt: `${base}:reconcile`, base, operation: 'checkpoint', amountMs: 0, state: checkpointState })).digest('base64url')
    const checkpoint: JournalEntry = { previous: '', scopeKey: checkpointKey, receipt: `${base}:reconcile`, base, operation: 'checkpoint', amountMs: 0, state: checkpointState, hash }
    const activeEntries = this.journal.filter((entry) => checkpointState.scopes[entry.scopeKey]?.reservedMs > 0)
    const compacted = [checkpoint]
    for (const original of activeEntries) {
      const entry: JournalEntry = { ...original, previous: compacted.at(-1)!.hash, state: checkpointState, hash: '' }
      entry.hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, state: entry.state })).digest('base64url')
      compacted.push(entry)
    }
    const temporary = `${statePath(this.stateDir)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, `${compacted.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (process.platform === 'win32') {
      if (!MoveFileExW || !MoveFileExW(temporary, statePath(this.stateDir), 0x1 | 0x8)) throw new Error('Protected accounting compaction commit failed')
    } else {
      renameSync(temporary, statePath(this.stateDir))
    }
    this.accounting = checkpointState
    this.journal.splice(0, this.journal.length, ...compacted)
  }
  private accountingOp(operation: string, payload: Record<string, unknown>): AccountingState {
    if (!validAccounting(this.accounting)) throw new Error('Protected accounting integrity unavailable')
    const scope = payload.scope
    if (!validScope(scope)) throw new Error('Protected accounting scope invalid')
    const key = scopeKey(scope)
    const existing = this.accounting.scopes[key] ?? this.journal.slice().reverse().find((entry) => entry.scopeKey === key)?.state.scopes[key]
    const requestedFloor = { ianaDay: scope.ianaDay, allowanceVersion: scope.allowanceVersion }
    const floor = this.accounting.floors?.[floorKey(scope)] ?? this.accounting.globalFloor
    if (!existing && floor && compareFloor(requestedFloor, floor) <= 0) throw new Error('Protected accounting rollback denied')
    const current = existing ?? { totalMs: scope.totalMs, committedMs: 0, reservedMs: 0, version: 0 }
    const effectiveTotalMs = existing ? Math.min(existing.totalMs, scope.totalMs) : scope.totalMs
    if (effectiveTotalMs < current.committedMs + current.reservedMs) throw new Error('Protected accounting scope conflict')
    if (operation === 'read') {
      this.releaseExpiredReservations()
      return { scopes: { ...this.accounting.scopes, [key]: this.accounting.scopes[key] ?? current } }
    }
    const receipt = String(payload.receipt ?? '')
    const match = /^(.+):(reserve|start|debit|reconcile)(-terminal)?$/.exec(receipt)
    if (!match || !/^[A-Za-z0-9._:-]{16,256}$/.test(receipt)) throw new Error('Protected accounting receipt invalid')
    const [, base, receiptOperation, terminalSuffix] = match
    if (receiptOperation !== operation) throw new Error('Protected accounting receipt transition invalid')
    const amountMs = operation === 'reserve' || operation === 'debit' ? Number(payload.amountMs) : 0
    const terminal = operation === 'reconcile' ? terminalSuffix === '-terminal' && payload.terminal === true : undefined
    const expiresAt = operation === 'reserve' && payload.expiresAt !== undefined ? Number(payload.expiresAt) : undefined
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= this.now())) throw new Error('Protected accounting reservation expiry invalid')
    const duplicate = this.journal.find((entry) => entry.receipt === receipt)
    if (duplicate) {
      if (duplicate.scopeKey !== key || duplicate.base !== base || duplicate.operation !== operation || duplicate.amountMs !== amountMs || (expiresAt !== undefined && duplicate.expiresAt !== expiresAt) || duplicate.terminal !== terminal) throw new Error('Protected accounting receipt conflict')
      return { ...duplicate.state }
    }
    const entries = this.journal.filter((entry) => entry.base === base && entry.scopeKey === key)
    const reserve = entries.find((entry) => entry.operation === 'reserve')
    const start = entries.find((entry) => entry.operation === 'start')
    const debit = entries.find((entry) => entry.operation === 'debit')
    const terminalEntry = entries.find((entry) => entry.operation === 'reconcile' && entry.terminal)
    if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion !== current.version) throw new Error('Protected accounting compare-and-swap failed')
    let nextHighWater: ProtectedAccountingHighWater
    if (operation === 'reserve') {
      if (entries.length > 0 || !Number.isSafeInteger(amountMs) || amountMs <= 0 || current.committedMs + current.reservedMs + amountMs > effectiveTotalMs) throw new Error('Protected accounting reserve denied')
      nextHighWater = { ...current, totalMs: effectiveTotalMs, reservedMs: current.reservedMs + amountMs, version: current.version + 1 }
    } else if (operation === 'start') {
      if (!reserve || start || debit || terminalEntry) throw new Error('Protected accounting start transition denied')
      nextHighWater = { ...current, version: current.version + 1 }
    } else if (operation === 'debit') {
      if (!reserve || !start || debit || terminalEntry || amountMs !== reserve.amountMs || amountMs > current.reservedMs) throw new Error('Protected accounting debit transition denied')
      nextHighWater = { ...current, reservedMs: current.reservedMs - amountMs, committedMs: current.committedMs + amountMs, version: current.version + 1 }
    } else {
      if (!reserve || debit || terminalEntry || (!start && !terminal)) throw new Error('Protected accounting reconcile transition denied')
      nextHighWater = terminal ? { ...current, reservedMs: current.reservedMs - reserve.amountMs, version: current.version + 1 } : { ...current, version: current.version + 1 }
    }
    const retainedScopes = { ...this.accounting.scopes, [key]: nextHighWater }
    const floors = { ...(this.accounting.floors ?? {}) }
    for (const removed of Object.keys(retainedScopes)) {
      if (Object.keys(retainedScopes).length <= 512) break
      if (removed !== key && retainedScopes[removed].reservedMs === 0) {
        const removedScope = scopeFromKey(removed, retainedScopes[removed])
        if (!removedScope) throw new Error('Protected accounting integrity unavailable')
        const nextFloor = { ianaDay: removedScope.ianaDay, allowanceVersion: removedScope.allowanceVersion }
        const domain = floorKey(removedScope)
        if (!floors[domain] || compareFloor(floors[domain], nextFloor) < 0) floors[domain] = nextFloor
        delete retainedScopes[removed]
      }
    }
    const next = { scopes: retainedScopes, floors, globalFloor: this.accounting.globalFloor }
    if (!validAccounting(next)) throw new Error('Protected accounting scope capacity denied')
    const previous = this.journal.at(-1)?.hash ?? ''
    const entry: JournalEntry = { previous, scopeKey: key, receipt, base, operation, amountMs, expiresAt, terminal, state: next, hash: '' }
    entry.hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, state: entry.state })).digest('base64url')
    this.accounting = next; this.journal.push(entry)
    if (this.stateDir) {
      writeFileSync(statePath(this.stateDir), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
      this.compactJournal()
    }
    return { ...next }
  }
}
function startNativeWindowsPipeServer(service: PrivilegedApprovalService, pipe: string, installedExecutable: string): Promise<Server> {
  if (!ConnectNamedPipe || !ReadFile || !WriteFile || !DisconnectNamedPipe || !CancelIoEx || !CloseHandle) {
    return Promise.reject(new Error('Native Windows named-pipe authority unavailable'))
  }
  const handle = createSecuredWindowsPipe(pipe)
  if (!handle) return Promise.reject(new Error('Protected named-pipe first-instance authority unavailable'))
  let stopped = false
  let generation = 0
  const close = (callback?: (error?: Error) => void) => {
    if (!stopped) {
      stopped = true
      generation++
      CancelIoEx(handle, null)
      DisconnectNamedPipe(handle)
      CloseHandle(handle)
    }
    if (callback) queueMicrotask(callback)
    return server
  }
  const server = { close } as unknown as Server
  const accept = () => {
    if (stopped) return
    ConnectNamedPipe.async(handle, null, () => {
      if (stopped) return
      const connection = ++generation
      const peer = windowsProcessForPipe(handle, GetNamedPipeClientProcessId, installedExecutable)?.peer
      const finish = () => {
        if (stopped || connection !== generation) return
        generation++
        CancelIoEx(handle, null)
        DisconnectNamedPipe(handle)
        setTimeout(accept, 0)
      }
      const timer = setTimeout(finish, REQUEST_TIMEOUT_MS)
      if (!peer) {
        clearTimeout(timer)
        finish()
        return
      }
      const input = Buffer.alloc(MAX_FRAME_BYTES + 4)
      const bytesRead = Buffer.alloc(4)
      ReadFile.async(handle, input, input.length, bytesRead, null, (_readError: unknown, readOk: boolean) => {
        if (stopped || connection !== generation) return
        const length = bytesRead.readUInt32LE(0)
        if (!readOk || length < 4 || length > input.length || input.readUInt32BE(0) !== length - 4) {
          clearTimeout(timer)
          finish()
          return
        }
        let request: PrivilegedRequest
        try {
          request = JSON.parse(input.subarray(4, length).toString()) as PrivilegedRequest
        } catch {
          clearTimeout(timer)
          finish()
          return
        }
        void service.invoke(request, peer).then(
          (result) => ({ ok: true, nonce: request.nonce, result }),
          (error) => ({ ok: false, nonce: request.nonce, code: redactedCode(error) }),
        ).then((response) => {
          if (stopped || connection !== generation) return
          const output = frame(response)
          const bytesWritten = Buffer.alloc(4)
          WriteFile.async(handle, output, output.length, bytesWritten, null, () => {
            if (stopped || connection !== generation) return
            clearTimeout(timer)
            finish()
          })
        })
      })
    })
  }
  accept()
  return Promise.resolve(server)
}

export function startPrivilegedPipeServer(service: PrivilegedApprovalService, pipe = PRIVILEGED_PIPE, verify?: PeerVerifier): Promise<Server> {
  if (process.platform === 'win32' && !verify) return startNativeWindowsPipeServer(service, pipe, process.execPath)
  const peerVerifier = verify ?? (() => null)
  return new Promise((ok, bad) => {
    const server = createServer((socket) => {
      const peer = peerVerifier(socket)
      if (!peer) return socket.destroy()
      serve(socket, service, peer)
    })
    server.once('error', bad)
    server.listen(pipe, () => ok(server))
  })
}
function redactedCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
  return ['UNAVAILABLE', 'OFFLINE', 'EPOCH_MISMATCH', 'STALE_EPOCH', 'PERMISSION_DENIED', 'FORBIDDEN', 'AUTH_REQUIRED', 'DEPENDENCY_UNAVAILABLE', 'INVALID_RESPONSE'].includes(code) ? code : undefined
}
function serve(socket: Socket, service: PrivilegedApprovalService, peer: string): void { let data = Buffer.alloc(0); socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy()); socket.on('data', (part: Buffer) => { data = Buffer.concat([data, part]); if (data.length < 4) return; const size = data.readUInt32BE(0); if (size > MAX_FRAME_BYTES || data.length !== size + 4) return socket.destroy(); try { const request = JSON.parse(data.subarray(4).toString()) as PrivilegedRequest; void service.invoke(request, peer).then((result) => socket.end(frame({ ok: true, nonce: request.nonce, result })), (error) => socket.end(frame({ ok: false, nonce: request.nonce, code: redactedCode(error) }))) } catch { socket.destroy() } }) }
function nativeWindowsPipeTransport(pipe: string, timeout: number, requireServiceIdentity: boolean) {
  return (request: PrivilegedRequest) => new Promise<unknown>((ok, bad) => {
    if (!CreateFileW || !WriteFile || !ReadFile || !CancelIoEx || !CloseHandle) {
      bad(Object.assign(new Error('Native Windows named-pipe client unavailable'), { code: 'UNAVAILABLE' }))
      return
    }
    const handle = CreateFileW(pipe, 0xc0000000, 0, null, 3, 0, null)
    if (invalidWindowsHandle(handle)) {
      bad(Object.assign(new Error('Protected named-pipe service unavailable'), { code: 'UNAVAILABLE' }))
      return
    }
    let settled = false
    let timer: NodeJS.Timeout
    const close = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      CancelIoEx(handle, null)
      CloseHandle(handle)
      return true
    }
    const fail = (error: unknown) => {
      if (close()) bad(error)
    }
    const succeed = (value: unknown) => {
      if (close()) ok(value)
    }
    timer = setTimeout(() => fail(Object.assign(new Error('Privileged service timeout'), { code: 'UNAVAILABLE' })), timeout)
    const server = windowsProcessForPipe(handle, GetNamedPipeServerProcessId, process.execPath)
    if (!server || (requireServiceIdentity && windowsServiceProcessId() !== server.id)) {
      fail(Object.assign(new Error('Privileged service identity denied'), { code: 'UNAVAILABLE' }))
      return
    }
    const output = frame(request)
    const bytesWritten = Buffer.alloc(4)
    WriteFile.async(handle, output, output.length, bytesWritten, null, (_writeError: unknown, writeOk: boolean) => {
      if (settled) return
      if (!writeOk || bytesWritten.readUInt32LE(0) !== output.length) {
        fail(Object.assign(new Error('Privileged service write failed'), { code: 'UNAVAILABLE' }))
        return
      }
      const input = Buffer.alloc(MAX_FRAME_BYTES + 4)
      const bytesRead = Buffer.alloc(4)
      ReadFile.async(handle, input, input.length, bytesRead, null, (_readError: unknown, readOk: boolean) => {
        if (settled) return
        try {
          const length = bytesRead.readUInt32LE(0)
          if (!readOk || length < 4 || length > input.length || input.readUInt32BE(0) !== length - 4) throw new Error('Malformed privileged response')
          const response = JSON.parse(input.subarray(4, length).toString()) as { ok: boolean; nonce: string; result?: unknown; code?: string }
          if (response.nonce !== request.nonce) throw new Error('Unbound privileged response')
          if (response.ok) succeed(response.result)
          else fail(response.code ? Object.assign(new Error(response.code), { code: response.code }) : new Error('Privileged service denied'))
        } catch (error) {
          fail(error)
        }
      })
    })
  })
}

export function namedPipeTransport(pipe = PRIVILEGED_PIPE, timeout = REQUEST_TIMEOUT_MS, requireServiceIdentity = pipe === PRIVILEGED_PIPE) {
  if (process.platform === 'win32') return nativeWindowsPipeTransport(pipe, timeout, requireServiceIdentity)
  return (request: PrivilegedRequest) => new Promise<unknown>((ok, bad) => {
    const socket = createConnection(pipe)
    let data = Buffer.alloc(0)
    const timer = setTimeout(() => {
      socket.destroy()
      bad(Object.assign(new Error('Privileged service timeout'), { code: 'UNAVAILABLE' }))
    }, timeout)
    socket.once('error', (error) => {
      clearTimeout(timer)
      bad(Object.assign(error, { code: 'UNAVAILABLE' }))
    })
    socket.on('data', (part: Buffer) => {
      data = Buffer.concat([data, part])
      if (data.length < 4) return
      try {
        const size = data.readUInt32BE(0)
        if (size > MAX_FRAME_BYTES || data.length !== size + 4) throw new Error('Malformed privileged response')
        const response = JSON.parse(data.subarray(4).toString()) as { ok: boolean; nonce: string; result?: unknown; code?: string }
        clearTimeout(timer)
        if (response.nonce !== request.nonce) throw new Error('Unbound privileged response')
        if (response.ok) ok(response.result)
        else bad(response.code ? Object.assign(new Error(response.code), { code: response.code }) : new Error('Privileged service denied'))
      } catch (error) {
        clearTimeout(timer)
        bad(error)
      }
    })
    socket.once('connect', () => socket.write(frame(request)))
  })
}
function serializedTransport(transport: (request: PrivilegedRequest) => Promise<unknown>): (request: PrivilegedRequest) => Promise<unknown> {
  let queue: Promise<unknown> = Promise.resolve(undefined)
  return (request) => {
    const result = queue.then(() => transport(request))
    queue = result.catch(() => undefined)
    return result
  }
}
export class PrivilegedBrokerClient implements BrokerSignedProofOperations {
  private token: string | undefined
  private readonly transport: (request: PrivilegedRequest) => Promise<unknown>
  constructor(transport = namedPipeTransport()) { this.transport = serializedTransport(transport) }
  async invoke<T>(input: { operation: RemoteApprovalOperation; payload: Record<string, unknown>; idempotencyKey: string }): Promise<T> {
    const membership = ['pair-parent', 'revoke-parent', 'reset-household', 'delete-household', 'reconcile-reset', 'reconcile-delete'].includes(input.operation)
    return this.transport({ capability: membership ? 'membership' : 'operational', purpose: membership ? 'membership-sync' : 'remote-approval', nonce: nonce(), adminSession: membership ? this.token : undefined, operation: input.operation, payload: { ...input.payload, __privilegedIdempotencyKey: input.idempotencyKey } }) as Promise<T>
  }
  async readAccounting(scope: ProtectedAccountingScope): Promise<ProtectedAccountingHighWater> {
    const state = await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation: 'read', payload: { scope } }) as AccountingState
    return state.scopes[scopeKey(scope)] ?? { totalMs: scope.totalMs, committedMs: 0, reservedMs: 0, version: 0 }
  }
  private async journal(operation: 'reserve' | 'start' | 'debit' | 'reconcile', receipt: string, amountMs: number, terminal: boolean, scope: ProtectedAccountingScope): Promise<ProtectedAccountingHighWater> {
    const state = await this.readAccounting(scope)
    const result = await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation, payload: { scope, receipt, expectedVersion: state.version, ...(amountMs > 0 ? { amountMs } : {}), ...(terminal ? { terminal: true } : {}) } }) as AccountingState
    return result.scopes[scopeKey(scope)]
  }
  async reservePreauthorization(receipt: string, minutes: number, scope: ProtectedAccountingScope, expiresAt?: number): Promise<void> {
    const amountMs = Math.round(minutes * 60_000)
    if (!Number.isSafeInteger(amountMs) || amountMs <= 0) throw new Error('Protected accounting amount invalid')
    const state = await this.readAccounting(scope)
    await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation: 'reserve', payload: { scope, receipt: `${receipt}:reserve`, expectedVersion: state.version, amountMs, ...(expiresAt === undefined ? {} : { expiresAt }) } })
  }
  async authorizeTimerStart(receipt: string, minutes: number, scope: ProtectedAccountingScope): Promise<void> {
    const amountMs = Math.round(minutes * 60_000)
    if (!Number.isSafeInteger(amountMs) || amountMs <= 0) throw new Error('Protected accounting amount invalid')
    await this.journal('reserve', `${receipt}:reserve`, amountMs, false, scope)
    await this.journal('start', `${receipt}:start`, 0, false, scope)
  }
  async recordTimerOutcome(receipt: string, minutes: number, started: boolean, scope: ProtectedAccountingScope): Promise<void> {
    const amountMs = Math.round(minutes * 60_000)
    if (started) await this.journal('debit', `${receipt}:debit`, amountMs, false, scope)
    else await this.journal('reconcile', `${receipt}:reconcile-terminal`, 0, true, scope)
  }
  async verifyPin(pin: string): Promise<boolean> { const result = await this.transport({ capability: 'membership', purpose: 'membership-sync', nonce: nonce(), operation: 'verify-pin', payload: { pin } }) as { ok?: boolean; token?: string }; this.token = result.ok ? result.token : undefined; return Boolean(this.token) }
  async changePin(newPin: string): Promise<void> { await this.transport({ capability: 'membership', purpose: 'membership-sync', nonce: nonce(), adminSession: this.token, operation: 'change-pin', payload: { newPin } }); this.token = undefined }
  async readLocalPolicy(): Promise<ProtectedLocalPolicy> {
    return this.transport({ capability: 'operational', purpose: 'remote-approval', nonce: nonce(), operation: 'read-local-policy', payload: {} }) as Promise<ProtectedLocalPolicy>
  }
  async setLocalPolicy(policy: Omit<ProtectedLocalPolicy, 'version'>): Promise<ProtectedLocalPolicy> {
    return this.transport({ capability: 'membership', purpose: 'membership-sync', nonce: nonce(), adminSession: this.token, operation: 'set-local-policy', payload: { policy } }) as Promise<ProtectedLocalPolicy>
  }
  async bootstrapMembership(): Promise<RemoteApprovalRuntimeConfig['membership']> { return this.transport({ capability: 'operational', purpose: 'remote-approval', nonce: nonce(), operation: 'bootstrap-membership', payload: {} }) as Promise<RemoteApprovalRuntimeConfig['membership']> }
}
