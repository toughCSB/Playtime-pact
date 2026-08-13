import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join, resolve, win32 } from 'node:path'
import koffi from 'koffi'
import { verifyAdminPassword, writeAdminPasswordPin } from '../fileStore'
import type { ProtectedAccountingHighWater, ProtectedAccountingScope, RemoteApprovalAuthoritySnapshot, RemoteApprovalPermissionTuple } from '../../shared/types'
import type { BrokerSignedProofOperations, RemoteApprovalOperation } from './apiClient'
import type { TimerStartHandoff } from './startCoordinator'
import { loadRemoteApprovalRuntimeConfigMetadata, type RemoteApprovalRuntimeConfig } from './runtimeBroker'
import { classifyWindowsPipeOpenError, privilegedHealthFailure, type PrivilegedHealthCode } from './privilegedHealthDiagnostic'

export const PRIVILEGED_PIPE = '\\\\.\\pipe\\PlaytimePactPrivilegedBroker-v1'
const MAX_FRAME_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 5_000
const MAX_PIN_ATTEMPTS = 5
const PIN_LOCK_MS = 30_000
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
const validOutcomeContext = (value: unknown, scope: ProtectedAccountingScope): value is { permission: RemoteApprovalPermissionTuple; authority: RemoteApprovalAuthoritySnapshot } => {
  if (!value || typeof value !== 'object') return false
  const { permission, authority } = value as { permission?: Partial<RemoteApprovalPermissionTuple>; authority?: Partial<RemoteApprovalAuthoritySnapshot> }
  return Boolean(permission && authority
    && permission.householdId === scope.householdId && permission.pcId === scope.pcId && permission.gameId === scope.gameId && permission.allowanceVersion === scope.allowanceVersion
    && [permission.requestId, permission.processId].every((part) => typeof part === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(part))
    && Number.isFinite(permission.processStartedAt)
    && [authority.membershipEpoch, authority.serviceEpoch, authority.authorityGeneration].every((part) => Number.isSafeInteger(part) && part! > 0))
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
const policySelectorName = (dir: string) => createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex')
const registryHive = (dir: string) => /^c:\\programdata\\playtimepact\\broker/i.test(resolve(dir)) ? 'LocalMachine' : 'CurrentUser'
const POLICY_SELECTOR_REGISTRY_PATH = 'SOFTWARE\\PlaytimePact\\PolicySelectors'
const ERROR_FILE_NOT_FOUND = 2
const REG_SZ = 1
const MAX_SELECTOR_BYTES = 4096
const registryRoot = (dir: string) => registryHive(dir) === 'LocalMachine' ? 0x80000002 : 0x80000001
function registryError(operation: string, status: number): Error {
  return new Error(`Protected policy selector ${operation} failed (win32=${status})`)
}
function closeRegistryKey(key: unknown): void {
  const status = RegCloseKey?.(key) ?? -1
  if (status !== 0) throw registryError('close', status)
}
function readPolicySelector(dir: string): string | null {
  if (process.platform !== 'win32') return existsSync(join(dir, '.policy-selector')) ? readFileSync(join(dir, '.policy-selector'), 'utf8').trim() : null
  if (!RegOpenKeyExW || !RegQueryValueExW || !RegCloseKey) throw registryError('API availability', -1)
  const opened: [unknown] = [null]
  const openStatus = RegOpenKeyExW(registryRoot(dir), POLICY_SELECTOR_REGISTRY_PATH, 0, 0x0001, opened)
  if (openStatus === ERROR_FILE_NOT_FOUND) return null
  if (openStatus !== 0 || !opened[0]) throw registryError('open', openStatus)
  try {
    const type = Buffer.alloc(4)
    const size = Buffer.alloc(4)
    const name = policySelectorName(dir)
    const sizeStatus = RegQueryValueExW(opened[0], name, null, type, null, size)
    if (sizeStatus === ERROR_FILE_NOT_FOUND) return null
    if (sizeStatus !== 0) throw registryError('size query', sizeStatus)
    const byteLength = size.readUInt32LE(0)
    if (type.readUInt32LE(0) !== REG_SZ || byteLength < 2 || byteLength > MAX_SELECTOR_BYTES || byteLength % 2 !== 0) {
      throw new Error('Protected policy selector registry value invalid')
    }
    const value = Buffer.alloc(byteLength)
    const readStatus = RegQueryValueExW(opened[0], name, null, type, value, size)
    if (readStatus !== 0) throw registryError('read', readStatus)
    const actualLength = size.readUInt32LE(0)
    if (type.readUInt32LE(0) !== REG_SZ || actualLength < 2 || actualLength > byteLength || actualLength % 2 !== 0 || value.readUInt16LE(actualLength - 2) !== 0) {
      throw new Error('Protected policy selector registry value invalid')
    }
    const selected = value.subarray(0, actualLength - 2).toString('utf16le').trim()
    if (!selected) throw new Error('Protected policy selector registry value invalid')
    return selected
  } finally {
    closeRegistryKey(opened[0])
  }
}
function writePolicySelector(dir: string, file: string): void {
  if (process.platform !== 'win32') {
    const path = join(dir, '.policy-selector'); const temporary = `${path}.${process.pid}.tmp`; durableTemporary(temporary, file); renameSync(temporary, path); return
  }
  if (!RegCreateKeyExW || !RegSetValueExW || !RegFlushKey || !RegCloseKey) throw registryError('API availability', -1)
  const opened: [unknown] = [null]
  const createStatus = RegCreateKeyExW(registryRoot(dir), POLICY_SELECTOR_REGISTRY_PATH, 0, null, 0, 0x0002, null, opened, null)
  if (createStatus !== 0 || !opened[0]) throw registryError('create', createStatus)
  try {
    const value = Buffer.from(`${file}\0`, 'utf16le')
    const writeStatus = RegSetValueExW(opened[0], policySelectorName(dir), 0, REG_SZ, value, value.length)
    if (writeStatus !== 0) throw registryError('write', writeStatus)
    const flushStatus = RegFlushKey(opened[0])
    if (flushStatus !== 0) throw registryError('flush', flushStatus)
  } finally {
    closeRegistryKey(opened[0])
  }
}
function readSelectedPolicy(dir: string, file: string): ProtectedLocalPolicy {
  const match = /^local-policy\.v(\d+)\.([a-f0-9]{64})\.json$/.exec(file)
  if (!match) throw new Error('Protected local policy integrity unavailable')
  const payload = readFileSync(join(dir, file), 'utf8')
  if (createHash('sha256').update(payload).digest('hex') !== match[2]) throw new Error('Protected local policy integrity unavailable')
  const policy = JSON.parse(payload) as unknown
  if (!validProtectedLocalPolicy(policy) || policy.version !== Number(match[1])) throw new Error('Protected local policy integrity unavailable')
  return { ...policy }
}
function readProtectedLocalPolicy(dir?: string): ProtectedLocalPolicy {
  if (!dir) throw new Error('Protected local policy uninitialized')
  const selected = readPolicySelector(dir)
  if (selected) return readSelectedPolicy(dir, selected)
  if (!existsSync(localPolicyPath(dir))) throw new Error('Protected local policy uninitialized')
  const legacy = JSON.parse(readFileSync(localPolicyPath(dir), 'utf8')) as unknown
  if (!validProtectedLocalPolicy(legacy)) throw new Error('Protected local policy integrity unavailable')
  writeProtectedLocalPolicy(dir, legacy)
  return readSelectedPolicy(dir, readPolicySelector(dir)!)
}
function durableTemporary(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const descriptor = openSync(path, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
function replaceSameDirectoryFile(temporary: string, target: string, failure: string): void {
  try {
    if (process.platform === 'win32') {
      if (!MoveFileExW?.(temporary, target, 0x1 | 0x8)) throw new Error(`${failure} (win32=${GetLastError?.() ?? 'unavailable'})`)
    } else {
      renameSync(temporary, target)
    }
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    if (error instanceof Error && error.message.startsWith(failure)) throw error
    throw new Error(failure)
  }
}
type PolicyPublicationHook = (phase: 'before-payload' | 'after-payload' | 'before-selector' | 'after-selector') => void
function writeProtectedLocalPolicy(dir: string, policy: ProtectedLocalPolicy, hook: PolicyPublicationHook = () => undefined): void {
  const payload = `${JSON.stringify(policy)}\n`
  const hash = createHash('sha256').update(payload).digest('hex')
  const file = `local-policy.v${policy.version}.${hash}.json`
  const payloadPath = join(dir, file)
  hook('before-payload')
  if (!existsSync(payloadPath)) {
    const handle = openSync(payloadPath, 'wx', 0o600)
    try { writeFileSync(handle, payload, 'utf8'); fsyncSync(handle) } finally { closeSync(handle) }
  }
  if (readFileSync(payloadPath, 'utf8') !== payload) throw new Error('Protected local policy integrity unavailable')
  readSelectedPolicy(dir, file)
  hook('after-payload')
  hook('before-selector')
  writePolicySelector(dir, file)
  hook('after-selector')
}
type JournalEntry = { previous: string; scopeKey: string; receipt: string; base: string; operation: string; amountMs: number; expiresAt?: number; terminal?: boolean; started?: boolean; attemptId?: string; permission?: RemoteApprovalPermissionTuple; authority?: RemoteApprovalAuthoritySnapshot; state: AccountingState; hash: string }
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
    const hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, started: entry.started, attemptId: entry.attemptId, permission: entry.permission, authority: entry.authority, state: entry.state })).digest('base64url')
    if (entry.previous !== previous || entry.hash !== hash || !validAccounting(entry.state)
      || entry.scopeKey !== scopeKeyFromEntry(entry) || !/^[A-Za-z0-9._:-]{16,256}$/.test(entry.receipt) || !/^[A-Za-z0-9._:-]{16,256}$/.test(entry.base)) throw new Error('Protected accounting integrity unavailable')
    previous = hash
    entries.push(entry)
  }
  return entries
}
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null
const advapi32 = process.platform === 'win32' ? koffi.load('advapi32.dll') : null
const RegOpenKeyExW = advapi32 && advapi32.func('int32_t __stdcall RegOpenKeyExW(void * Key, str16 SubKey, uint32_t Options, uint32_t Sam, _Out_ void ** Result)')
const RegQueryValueExW = advapi32 && advapi32.func('int32_t __stdcall RegQueryValueExW(void * Key, str16 ValueName, void * Reserved, _Out_ uint32_t * Type, _Out_ void * Data, _Inout_ uint32_t * DataSize)')
const RegCreateKeyExW = advapi32 && advapi32.func('int32_t __stdcall RegCreateKeyExW(void * Key, str16 SubKey, uint32_t Reserved, str16 Class, uint32_t Options, uint32_t Sam, void * SecurityAttributes, _Out_ void ** Result, _Out_ uint32_t * Disposition)')
const RegSetValueExW = advapi32 && advapi32.func('int32_t __stdcall RegSetValueExW(void * Key, str16 ValueName, uint32_t Reserved, uint32_t Type, void * Data, uint32_t DataSize)')
const RegFlushKey = advapi32 && advapi32.func('int32_t __stdcall RegFlushKey(void * Key)')
const RegCloseKey = advapi32 && advapi32.func('int32_t __stdcall RegCloseKey(void * Key)')
const SecurityAttributes = process.platform === 'win32'
  ? koffi.struct('PPT_SECURITY_ATTRIBUTES', { nLength: 'uint32_t', lpSecurityDescriptor: 'void *', bInheritHandle: 'int32_t' })
  : null
const ProcessEntry32W = process.platform === 'win32'
  ? koffi.struct('PPT_PROCESSENTRY32W', {
      dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t',
      dwFlags: 'uint32_t', szExeFile: 'uint16_t[260]',
    })
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
const GetLastError = kernel32 && kernel32.func('uint32_t __stdcall GetLastError()')
const GetNamedPipeClientProcessId = kernel32 && kernel32.func('bool __stdcall GetNamedPipeClientProcessId(void * Pipe, uint32_t * ClientProcessId)')
const GetNamedPipeServerProcessId = kernel32 && kernel32.func('bool __stdcall GetNamedPipeServerProcessId(void * Pipe, uint32_t * ServerProcessId)')
const OpenSCManagerW = advapi32 && advapi32.func('void * __stdcall OpenSCManagerW(str16 MachineName, str16 DatabaseName, uint32_t DesiredAccess)')
const OpenServiceW = advapi32 && advapi32.func('void * __stdcall OpenServiceW(void * Manager, str16 ServiceName, uint32_t DesiredAccess)')
const QueryServiceStatusEx = advapi32 && advapi32.func('bool __stdcall QueryServiceStatusEx(void * Service, uint32_t InfoLevel, void * Buffer, uint32_t BufferSize, uint32_t * BytesNeeded)')
const QueryServiceConfigW = advapi32 && advapi32.func('bool __stdcall QueryServiceConfigW(void * Service, void * Config, uint32_t BufferSize, uint32_t * BytesNeeded)')
const OpenProcess = kernel32 && kernel32.func('void * __stdcall OpenProcess(uint32_t Access, bool Inherit, uint32_t ProcessId)')
const QueryFullProcessImageNameW = kernel32 && kernel32.func('bool __stdcall QueryFullProcessImageNameW(void * Process, uint32_t Flags, uint16_t * Name, uint32_t * Size)')
const CreateToolhelp32Snapshot = kernel32 && kernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t Flags, uint32_t ProcessId)')
const Process32FirstW = kernel32 && kernel32.func('bool __stdcall Process32FirstW(void * Snapshot, _Inout_ PPT_PROCESSENTRY32W * Entry)')
const Process32NextW = kernel32 && kernel32.func('bool __stdcall Process32NextW(void * Snapshot, _Inout_ PPT_PROCESSENTRY32W * Entry)')
const CloseHandle = kernel32 && kernel32.func('bool __stdcall CloseHandle(void * Handle)')

const WINDOWS_SERVICE_NAME = 'PlaytimePactPrivilegedBroker'
const WINDOWS_SERVICE_RUNNING = 4
const invalidWindowsHandle = (handle: unknown) => !handle || handle === -1n || handle === 0xffffffffffffffffn || handle === 0xffffffffn
const normalizeWindowsImage = (image: string) => win32.normalize(image).toLowerCase()
type WindowsProcessIdentity = { processId: number; parentProcessId: number | null; image: string | null }
type WindowsServiceIdentity = { name: string; state: number; processId: number; image: string | null; configuredBinaryPath: string | null }

function windowsProcessImage(processId: number): string | null {
  if (!OpenProcess || !QueryFullProcessImageNameW || !CloseHandle) return null
  const processHandle = OpenProcess(0x1000, false, processId)
  if (invalidWindowsHandle(processHandle)) return null
  try {
    const path = Buffer.alloc(32768)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(16384)
    if (!QueryFullProcessImageNameW(processHandle, 0, path, length)) return null
    return path.subarray(0, length.readUInt32LE(0) * 2).toString('utf16le').replace(/\0+$/, '')
  } finally {
    CloseHandle(processHandle)
  }
}

function windowsParentProcessId(processId: number): number | null {
  if (!CreateToolhelp32Snapshot || !Process32FirstW || !Process32NextW || !CloseHandle || !ProcessEntry32W) return null
  const snapshot = CreateToolhelp32Snapshot(0x00000002, 0)
  if (invalidWindowsHandle(snapshot)) return null
  try {
    const entry = { dwSize: koffi.sizeof(ProcessEntry32W) } as { dwSize: number; th32ProcessID?: number; th32ParentProcessID?: number }
    for (let found = Process32FirstW(snapshot, entry); found; found = Process32NextW(snapshot, entry)) {
      if (entry.th32ProcessID === processId) return entry.th32ParentProcessID || null
      entry.dwSize = koffi.sizeof(ProcessEntry32W)
    }
    return null
  } finally {
    CloseHandle(snapshot)
  }
}

type WindowsPipeProcess = { id: number; image: string | null }
function windowsPipeProcess(handle: unknown, getProcessId: typeof GetNamedPipeClientProcessId): WindowsPipeProcess | null {
  if (!getProcessId) return null
  const pid = Buffer.alloc(4)
  if (!getProcessId(handle, pid)) return null
  const processId = pid.readUInt32LE(0)
  return processId === 0 ? null : { id: processId, image: windowsProcessImage(processId) }
}

function windowsProcessForPipe(handle: unknown, getProcessId: typeof GetNamedPipeClientProcessId, installedExecutable: string): { id: number; image: string; peer: string } | null {
  const process = windowsPipeProcess(handle, getProcessId)
  const expected = normalizeWindowsImage(installedExecutable)
  return process?.image && normalizeWindowsImage(process.image) === expected
    ? { id: process.id, image: process.image, peer: `${process.id}:${expected}` }
    : null
}

const MAX_SERVICE_CONFIG_BYTES = 64 * 1024
function windowsServiceConfiguredBinary(service: unknown): string | null {
  if (!QueryServiceConfigW || !GetLastError) return null
  const needed = Buffer.alloc(4)
  if (QueryServiceConfigW(service, null, 0, needed) || GetLastError() !== 122) return null
  const size = needed.readUInt32LE(0)
  const pointerOffset = process.arch === 'x64' ? 16 : 12
  const headerSize = process.arch === 'x64' ? 64 : 36
  const pointerSize = process.arch === 'x64' ? 8 : 4
  if (size < headerSize || size > MAX_SERVICE_CONFIG_BYTES) return null
  const config = Buffer.alloc(size)
  if (!QueryServiceConfigW(service, config, config.length, needed)) return null
  const base = koffi.address(config)
  const pointer = pointerSize === 8 ? config.readBigUInt64LE(pointerOffset) : BigInt(config.readUInt32LE(pointerOffset))
  const endAddress = base + BigInt(config.length)
  if (pointer < base + BigInt(headerSize) || pointer >= endAddress) return null
  const offset = Number(pointer - base)
  if (offset % 2 !== 0) return null
  let end = offset
  while (end + 1 < config.length && config.readUInt16LE(end) !== 0) end += 2
  if (end + 1 >= config.length || end === offset) return null
  return config.subarray(offset, end).toString('utf16le')
}

function windowsServiceStatus(service: unknown): { state: number; processId: number } | null {
  if (!QueryServiceStatusEx) return null
  const status = Buffer.alloc(36)
  const needed = Buffer.alloc(4)
  if (!QueryServiceStatusEx(service, 0, status, status.length, needed)) return null
  return { state: status.readUInt32LE(4), processId: status.readUInt32LE(28) }
}

function windowsServiceIdentity(): WindowsServiceIdentity | null {
  if (!OpenSCManagerW || !OpenServiceW || !QueryServiceStatusEx || !QueryServiceConfigW || !CloseHandle) return null
  const manager = OpenSCManagerW(null, null, 0x0001)
  if (invalidWindowsHandle(manager)) return null
  try {
    const service = OpenServiceW(manager, WINDOWS_SERVICE_NAME, 0x0004 | 0x0001)
    if (invalidWindowsHandle(service)) return null
    try {
      const before = windowsServiceStatus(service)
      if (!before || before.state !== WINDOWS_SERVICE_RUNNING || before.processId === 0) return null
      const configuredBinaryPath = windowsServiceConfiguredBinary(service)
      if (!configuredBinaryPath) return null
      const after = windowsServiceStatus(service)
      if (!after || after.state !== before.state || after.processId !== before.processId) return null
      return {
        name: WINDOWS_SERVICE_NAME,
        state: after.state,
        processId: after.processId,
        image: windowsProcessImage(after.processId),
        configuredBinaryPath,
      }
    } finally {
      CloseHandle(service)
    }
  } finally {
    CloseHandle(manager)
  }
}

function configuredServiceBinaryMatches(configuredBinaryPath: string | null, expectedImage: string): boolean {
  if (!configuredBinaryPath || configuredBinaryPath.includes('\0')) return false
  const quoted = configuredBinaryPath.startsWith('"') && configuredBinaryPath.endsWith('"')
  const candidate = quoted ? configuredBinaryPath.slice(1, -1) : configuredBinaryPath
  if (!candidate || candidate.includes('"') || !quoted && /\s/.test(candidate)) return false
  return normalizeWindowsImage(candidate) === normalizeWindowsImage(expectedImage)
}

export function windowsServiceOwnsPipeServer(service: WindowsServiceIdentity | null, server: WindowsProcessIdentity | null, installedExecutable: string): boolean {
  if (!service || !server || service.name !== WINDOWS_SERVICE_NAME || service.state !== WINDOWS_SERVICE_RUNNING
    || service.processId === 0 || server.processId === 0) return false
  const expectedServer = normalizeWindowsImage(installedExecutable)
  if (server.image !== null && normalizeWindowsImage(server.image) !== expectedServer) return false
  if (service.processId === server.processId) {
    return server.image !== null
      && service.image !== null
      && normalizeWindowsImage(service.image) === expectedServer
      && configuredServiceBinaryMatches(service.configuredBinaryPath, installedExecutable)
  }
  const expectedWrapper = win32.join(win32.dirname(installedExecutable), `${WINDOWS_SERVICE_NAME}.exe`)
  return server.parentProcessId === service.processId
    && configuredServiceBinaryMatches(service.configuredBinaryPath, expectedWrapper)
    && (service.image === null || normalizeWindowsImage(service.image) === normalizeWindowsImage(expectedWrapper))
}
export function privilegedPipeSddl(targetAccountSid = 'IU'): string {
  if (targetAccountSid !== 'IU' && !/^S-1-5-(?:\d+-){1,14}\d+$/.test(targetAccountSid)) throw new Error('Protected named-pipe account SID invalid')
  return `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;${targetAccountSid})`
}
function createSecuredWindowsPipe(pipe: string): unknown {
  if (!CreateNamedPipeW || !ConvertStringSecurityDescriptorToSecurityDescriptorW || !LocalFree || !SecurityAttributes) return null
  const descriptor: [unknown] = [null]
  // Before remote provisioning, only an interactive logon may use local-only
  // accounting. Once provisioned, the DACL narrows to the configured account SID.
  const sddl = privilegedPipeSddl(loadRemoteApprovalRuntimeConfigMetadata()?.windowsAccountSid)
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
  private readonly pinCallers = new Map<string, { attempts: number; lockedUntil: number }>()
  private pinGlobal = { attempts: 0, lockedUntil: 0 }
  private readonly journal: JournalEntry[]
  private accounting: AccountingState
  private localPolicy: ProtectedLocalPolicy | null
  constructor(private readonly operational: (operation: string, payload: Record<string, unknown>) => Promise<unknown>, private readonly membership: (operation: string, payload: Record<string, unknown>) => Promise<unknown>, accounting: AccountingState | ProtectedAccountingHighWater, private readonly stateDir?: string, private readonly now = () => Date.now(), private readonly verifyPin = (pin: string) => verifyAdminPassword(pin), private readonly policyPublicationHook: PolicyPublicationHook = () => undefined, private readonly journalAppendHook: (operation: string) => void = () => undefined) {
    this.accounting = normalizeAccounting(accounting)
    this.journal = stateDir ? readJournal(stateDir) : []
    this.localPolicy = stateDir && (readPolicySelector(stateDir) || existsSync(localPolicyPath(stateDir))) ? readProtectedLocalPolicy(stateDir) : null
    this.finishPendingOutcomes()
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
    if (request.operation === 'verify-pin') {
      if (request.capability !== 'membership' || !this.pinAllowed(peer)) return { ok: false }
      const ok = this.verifyPin(String(request.payload.pin ?? ''))
      this.recordPinAttempt(peer, ok)
      if (!ok) return { ok: false }
      if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value!)
      const token = nonce(); this.tokens.set(token, { peer, expires: this.now() + 300000 }); return { ok: true, token }
    }
    if (request.capability === 'membership' && !this.consume(request.adminSession, peer)) throw new Error('Privileged service capability denied')
    if (request.operation === 'change-pin') { const pin = String(request.payload.newPin ?? ''); if (!/^\d{4}$/.test(pin)) throw new Error('invalid pin'); writeAdminPasswordPin(pin); for (const [token, session] of this.tokens) if (session.peer === peer) this.tokens.delete(token); return true }
    if (request.operation === 'read-local-policy') {
      if (request.capability !== 'operational' || !this.localPolicy) throw new Error('Protected local policy uninitialized')
      return { ...this.localPolicy }
    }
    if (request.operation === 'health-check') {
      if (request.capability !== 'accounting' || Object.keys(request.payload).length !== 0) throw new Error('Privileged service capability denied')
      return 'ok'
    }
    if (request.operation === 'list-recoverable-timer-starts') {
      if (request.capability !== 'accounting') throw new Error('Privileged service capability denied')
      return this.journal.filter((entry) => entry.operation === 'commit'
        && !this.journal.some((candidate) => candidate.operation === 'materialized' && candidate.base === entry.receipt && candidate.scopeKey === entry.scopeKey)).map((entry) => ({
        receipt: entry.receipt, minutes: entry.amountMs / 60_000, permission: entry.permission, authority: entry.authority,
        scope: scopeFromKey(entry.scopeKey, entry.state.scopes[entry.scopeKey]!),
      }))
    }
    if (request.operation === 'set-local-policy') {
      if (request.capability !== 'membership' || !this.stateDir) throw new Error('Privileged service capability denied')
      const proposed = request.payload.policy as Omit<ProtectedLocalPolicy, 'version'>
      const { version: _version, ...current } = this.localPolicy ?? { version: 0, ...proposed }
      const unchanged = this.localPolicy !== null && JSON.stringify(proposed) === JSON.stringify(current)
      const candidate = { ...proposed, version: unchanged ? (this.localPolicy?.version ?? 0) : (this.localPolicy?.version ?? 0) + 1 }
      if (!validProtectedLocalPolicy(candidate)) throw new Error('Protected local policy invalid')
      if (!unchanged) {
        try { writeProtectedLocalPolicy(this.stateDir, candidate, this.policyPublicationHook) }
        catch (error) { this.localPolicy = readPolicySelector(this.stateDir) ? readProtectedLocalPolicy(this.stateDir) : this.localPolicy; throw error }
      }
      this.localPolicy = candidate
      return { ...candidate }
    }
    if (request.capability === 'operational') return this.operational(request.operation, request.payload)
    if (request.capability === 'membership') return this.membership(request.operation, request.payload)
    return this.accountingOp(request.operation, request.payload)
  }
  private pinAllowed(peer: string): boolean {
    const now = this.now()
    return this.pinGlobal.lockedUntil <= now && (this.pinCallers.get(peer)?.lockedUntil ?? 0) <= now
  }
  private recordPinAttempt(peer: string, ok: boolean): void {
    if (ok) { this.pinGlobal = { attempts: 0, lockedUntil: 0 }; this.pinCallers.delete(peer); return }
    const now = this.now()
    const increment = (state: { attempts: number; lockedUntil: number } | undefined) => {
      const attempts = (state?.lockedUntil ?? 0) <= now ? (state?.attempts ?? 0) + 1 : (state?.attempts ?? 0)
      return { attempts, lockedUntil: attempts >= MAX_PIN_ATTEMPTS ? now + PIN_LOCK_MS : 0 }
    }
    this.pinGlobal = increment(this.pinGlobal)
    this.pinCallers.set(peer, increment(this.pinCallers.get(peer)))
    if (this.pinCallers.size > 4096) this.pinCallers.delete(this.pinCallers.keys().next().value!)
  }
  private consume(token: string | undefined, peer: string): boolean { const session = token && this.tokens.get(token); return Boolean(session && session.peer === peer && session.expires >= this.now()) }
  private finishPendingOutcomes(): void {
    for (const start of this.journal.filter((entry) => entry.operation === 'start')) {
      const related = this.journal.filter((entry) => entry.base === start.base && entry.scopeKey === start.scopeKey)
      if (related.some((entry) => entry.operation === 'debit' || entry.operation === 'commit' || entry.terminal)) continue
      const reserve = related.find((entry) => entry.operation === 'reserve')
      const current = this.accounting.scopes[start.scopeKey]
      const scope = current && scopeFromKey(start.scopeKey, current)
      if (!reserve || !scope) throw new Error('Protected accounting integrity unavailable')
      try { this.accountingOp('debit', { scope, receipt: `${start.base}:debit`, expectedVersion: current.version, amountMs: reserve.amountMs }) }
      catch { throw new Error('Protected accounting integrity unavailable') }
    }
    for (const attempt of this.journal.filter((entry) => entry.operation === 'attempt')) {
      const related = this.journal.filter((entry) => entry.base === attempt.base && entry.scopeKey === attempt.scopeKey)
      if (related.some((entry) => entry.operation === 'outcome' || entry.operation === 'debit' || (entry.operation === 'reconcile' && entry.terminal))) continue
      const current = this.accounting.scopes[attempt.scopeKey]
      const scope = current && scopeFromKey(attempt.scopeKey, current)
      if (!scope || !attempt.attemptId || !attempt.permission || !attempt.authority) throw new Error('Protected accounting integrity unavailable')
      try {
        this.accountingOp('outcome', { scope, receipt: `${attempt.base}:outcome-started`, expectedVersion: current.version, amountMs: attempt.amountMs, started: true, attemptId: attempt.attemptId, context: { permission: attempt.permission, authority: attempt.authority } })
      } catch { throw new Error('Protected accounting integrity unavailable') }
    }
    for (const outcome of this.journal.filter((entry) => entry.operation === 'outcome')) {
      const related = this.journal.filter((entry) => entry.base === outcome.base && entry.scopeKey === outcome.scopeKey)
      if (related.some((entry) => entry.operation === 'debit' || (entry.operation === 'reconcile' && entry.terminal))) continue
      const current = this.accounting.scopes[outcome.scopeKey]
      const scope = current && scopeFromKey(outcome.scopeKey, current)
      if (!scope || typeof outcome.started !== 'boolean') throw new Error('Protected accounting integrity unavailable')
      try {
        if (outcome.started) {
          this.accountingOp('debit', { scope, receipt: `${outcome.base}:debit`, expectedVersion: current.version, amountMs: outcome.amountMs })
        } else {
          if (!related.some((entry) => entry.operation === 'reserve')) {
            this.accountingOp('reserve', { scope, receipt: `${outcome.base}:reserve`, expectedVersion: current.version, amountMs: outcome.amountMs })
          }
          const reserved = this.accounting.scopes[outcome.scopeKey]
          this.accountingOp('reconcile', { scope, receipt: `${outcome.base}:reconcile-terminal`, expectedVersion: reserved.version, terminal: true })
        }
      } catch { throw new Error('Protected accounting integrity unavailable') }
    }
  }
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
    const unresolvedCommits = this.journal.filter((entry) => entry.operation === 'commit'
      && !this.journal.some((candidate) => candidate.operation === 'materialized' && candidate.base === entry.receipt && candidate.scopeKey === entry.scopeKey))
    const unresolvedScopeKeys = new Set(unresolvedCommits.map((entry) => entry.scopeKey))
    const retainedScopes: Record<string, ProtectedAccountingHighWater> = {}
    const floors = { ...(this.accounting.floors ?? {}) }
    let globalFloor = this.accounting.globalFloor
    for (const [key, highWater] of Object.entries(this.accounting.scopes)) {
      const scope = scopeFromKey(key, highWater)
      if (!scope) throw new Error('Protected accounting integrity unavailable')
      const floor = { ianaDay: scope.ianaDay, allowanceVersion: scope.allowanceVersion }
      if (highWater.reservedMs > 0 || scope.ianaDay === currentScopeDay(scope) || unresolvedScopeKeys.has(key)) retainedScopes[key] = highWater
      else {
        const domain = floorKey(scope)
        if (!floors[domain] || compareFloor(floors[domain], floor) < 0) floors[domain] = floor
        if (!globalFloor || compareFloor(globalFloor, floor) < 0) globalFloor = floor
      }
    }
    for (const commit of unresolvedCommits) {
      const highWater = commit.state.scopes[commit.scopeKey]
      if (!highWater) throw new Error('Protected accounting compaction unavailable')
      retainedScopes[commit.scopeKey] = highWater
    }
    const boundedFloors = Object.fromEntries(Object.entries(floors).sort(([, a], [, b]) => compareFloor(b, a)).slice(0, 512))
    const checkpointState: AccountingState = { scopes: retainedScopes, floors: boundedFloors, ...(globalFloor ? { globalFloor } : {}) }
    if (!validAccounting(checkpointState) || Object.keys(retainedScopes).length === 0) throw new Error('Protected accounting compaction unavailable')
    const checkpointKey = Object.keys(retainedScopes)[0]
    const base = `checkpoint-${Date.now()}-0001`
    const hash = createHash('sha256').update(JSON.stringify({ previous: '', scopeKey: checkpointKey, receipt: `${base}:reconcile`, base, operation: 'checkpoint', amountMs: 0, state: checkpointState })).digest('base64url')
    const checkpoint: JournalEntry = { previous: '', scopeKey: checkpointKey, receipt: `${base}:reconcile`, base, operation: 'checkpoint', amountMs: 0, state: checkpointState, hash }
    const recoverableReceipts = new Set(unresolvedCommits.map((entry) => entry.receipt))
    const activeEntries = this.journal.filter((entry) => checkpointState.scopes[entry.scopeKey]?.reservedMs > 0
      || (entry.operation === 'commit' && recoverableReceipts.has(entry.receipt)))
    const compacted = [checkpoint]
    for (const original of activeEntries) {
      const entry: JournalEntry = { ...original, previous: compacted.at(-1)!.hash, state: checkpointState, hash: '' }
      entry.hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, started: entry.started, attemptId: entry.attemptId, permission: entry.permission, authority: entry.authority, state: entry.state })).digest('base64url')
      compacted.push(entry)
    }
    const temporary = `${statePath(this.stateDir)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    durableTemporary(temporary, `${compacted.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
    replaceSameDirectoryFile(temporary, statePath(this.stateDir), 'Protected accounting compaction commit failed')
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
    const match = operation === 'commit' ? [receipt, receipt, 'commit', undefined] : /^(.+):(reserve|start|debit|reconcile|attempt|outcome|materialized)(-terminal|-started|-not-started)?$/.exec(receipt)
    if (!match || !/^[A-Za-z0-9._:-]{16,256}$/.test(receipt)) throw new Error('Protected accounting receipt invalid')
    const [, rawBase, receiptOperation, operationSuffix] = match
    const base = rawBase!
    if (receiptOperation !== operation) throw new Error('Protected accounting receipt transition invalid')
    const amountMs = ['reserve', 'debit', 'attempt', 'outcome', 'commit', 'materialized'].includes(operation) ? Number(payload.amountMs) : 0
    const terminal = operation === 'reconcile' ? operationSuffix === '-terminal' && payload.terminal === true : undefined
    const started = operation === 'outcome'
      ? operationSuffix === (payload.started === true ? '-started' : '-not-started') && typeof payload.started === 'boolean' ? payload.started : undefined
      : undefined
    const context = operation === 'attempt' || operation === 'outcome' || operation === 'commit' || operation === 'materialized' ? payload.context : undefined
    const attemptId = operation === 'attempt' || operation === 'outcome'
      ? payload.attemptId === undefined ? undefined : String(payload.attemptId)
      : undefined
    if ((operation === 'attempt' && !/^[0-9a-f-]{36}$/.test(attemptId ?? ''))
      || (operation === 'outcome' && attemptId !== undefined && !/^[0-9a-f-]{36}$/.test(attemptId))
      || ((operation === 'attempt' || operation === 'outcome' || operation === 'commit' || operation === 'materialized') && !validOutcomeContext(context, scope))) throw new Error('Protected accounting attempt invalid')
    if (operation === 'outcome' && started === undefined) throw new Error('Protected accounting outcome invalid')
    const expiresAt = operation === 'reserve' && payload.expiresAt !== undefined ? Number(payload.expiresAt) : undefined
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= this.now())) throw new Error('Protected accounting reservation expiry invalid')
    const duplicate = this.journal.find((entry) => entry.receipt === receipt)
    if (duplicate) {
      if (duplicate.scopeKey !== key || duplicate.base !== base || duplicate.operation !== operation || duplicate.amountMs !== amountMs || (expiresAt !== undefined && duplicate.expiresAt !== expiresAt) || duplicate.terminal !== terminal || duplicate.started !== started || duplicate.attemptId !== attemptId || ((operation === 'attempt' || operation === 'outcome' || operation === 'commit' || operation === 'materialized') && JSON.stringify({ permission: duplicate.permission, authority: duplicate.authority }) !== JSON.stringify(context))) throw new Error('Protected accounting receipt conflict')
      return { ...duplicate.state }
    }
    const entries = this.journal.filter((entry) => entry.base === base && entry.scopeKey === key)
    const reserve = entries.find((entry) => entry.operation === 'reserve')
    const start = entries.find((entry) => entry.operation === 'start')
    const debit = entries.find((entry) => entry.operation === 'debit')
    const terminalEntry = entries.find((entry) => entry.operation === 'reconcile' && entry.terminal)
    const attempt = entries.find((entry) => entry.operation === 'attempt')
    const outcome = entries.find((entry) => entry.operation === 'outcome')
    if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion !== current.version) throw new Error('Protected accounting compare-and-swap failed')
    let nextHighWater: ProtectedAccountingHighWater
    if (operation === 'materialized') {
      const committed = this.journal.find((entry) => entry.operation === 'commit' && entry.receipt === base && entry.scopeKey === key)
      if (!committed || committed.amountMs !== amountMs || JSON.stringify({ permission: committed.permission, authority: committed.authority }) !== JSON.stringify(context)) throw new Error('Protected accounting materialized conflict')
      nextHighWater = current
    } else if (operation === 'commit') {
      if (!Number.isSafeInteger(amountMs) || amountMs <= 0) throw new Error('Protected accounting commit denied')
      const matchingReserve = this.journal.find((entry) => entry.base === base && entry.scopeKey === key && entry.operation === 'reserve')
      if (matchingReserve && (matchingReserve.amountMs !== amountMs || amountMs > current.reservedMs)) throw new Error('Protected accounting commit conflict')
      if (!matchingReserve && current.committedMs + current.reservedMs + amountMs > effectiveTotalMs) throw new Error('Protected accounting commit denied')
      nextHighWater = { ...current, totalMs: effectiveTotalMs, reservedMs: current.reservedMs - (matchingReserve?.amountMs ?? 0), committedMs: current.committedMs + amountMs, version: current.version + 1 }
    } else if (operation === 'reserve') {
      if (entries.some((entry) => entry.operation !== 'outcome') || (outcome && outcome.started !== false) || !Number.isSafeInteger(amountMs) || amountMs <= 0 || current.committedMs + current.reservedMs + amountMs > effectiveTotalMs) throw new Error('Protected accounting reserve denied')
      nextHighWater = { ...current, totalMs: effectiveTotalMs, reservedMs: current.reservedMs + amountMs, version: current.version + 1 }
    } else if (operation === 'start') {
      if (!reserve || start || debit || terminalEntry) throw new Error('Protected accounting start transition denied')
      nextHighWater = { ...current, version: current.version + 1 }
    } else if (operation === 'debit') {
      if (!reserve || !start || debit || terminalEntry || amountMs !== reserve.amountMs || amountMs > current.reservedMs) throw new Error('Protected accounting debit transition denied')
      nextHighWater = { ...current, reservedMs: current.reservedMs - amountMs, committedMs: current.committedMs + amountMs, version: current.version + 1 }
    } else if (operation === 'reconcile') {
      if (!reserve || debit || terminalEntry || (!start && !terminal)) throw new Error('Protected accounting reconcile transition denied')
      nextHighWater = terminal ? { ...current, reservedMs: current.reservedMs - reserve.amountMs, version: current.version + 1 } : { ...current, version: current.version + 1 }
    } else if (operation === 'attempt') {
      if (attempt || outcome || debit || terminalEntry || !reserve || !start || !Number.isSafeInteger(amountMs) || amountMs !== reserve.amountMs) throw new Error('Protected accounting attempt transition denied')
      nextHighWater = { ...current, totalMs: effectiveTotalMs }
    } else {
      if (outcome || debit || terminalEntry || !Number.isSafeInteger(amountMs) || amountMs <= 0 || (attempt ? attempt.attemptId !== attemptId : attemptId !== undefined)) throw new Error('Protected accounting outcome transition denied')
      if (started && (!reserve || !start)) throw new Error('Protected accounting outcome transition denied')
      nextHighWater = { ...current, totalMs: effectiveTotalMs }
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
    const entry: JournalEntry = { previous, scopeKey: key, receipt, base, operation, amountMs, expiresAt, terminal, started, attemptId, ...(context ? context : {}), state: next, hash: '' }
    entry.hash = createHash('sha256').update(JSON.stringify({ previous: entry.previous, scopeKey: entry.scopeKey, receipt: entry.receipt, base: entry.base, operation: entry.operation, amountMs: entry.amountMs, expiresAt: entry.expiresAt, terminal: entry.terminal, started: entry.started, attemptId: entry.attemptId, permission: entry.permission, authority: entry.authority, state: entry.state })).digest('base64url')
    if (this.stateDir) {
      this.journalAppendHook(operation)
      const handle = openSync(statePath(this.stateDir), 'a', 0o600)
      try { writeFileSync(handle, `${JSON.stringify(entry)}\n`, 'utf8'); fsyncSync(handle) } finally { closeSync(handle) }
    }
    this.accounting = next; this.journal.push(entry)
    if (this.stateDir) this.compactJournal()
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
const REDACTED_CODES: readonly PrivilegedHealthCode[] = ['UNAVAILABLE', 'OFFLINE', 'EPOCH_MISMATCH', 'STALE_EPOCH', 'PERMISSION_DENIED', 'FORBIDDEN', 'AUTH_REQUIRED', 'DEPENDENCY_UNAVAILABLE', 'INVALID_RESPONSE', 'CONFIG_INVALID', 'CONFIG_UNREADABLE']
function redactedCode(error: unknown): PrivilegedHealthCode | undefined {
  const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
  return REDACTED_CODES.find((candidate) => candidate === code)
}
function serve(socket: Socket, service: PrivilegedApprovalService, peer: string): void { let data = Buffer.alloc(0); socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy()); socket.on('data', (part: Buffer) => { data = Buffer.concat([data, part]); if (data.length < 4) return; const size = data.readUInt32BE(0); if (size > MAX_FRAME_BYTES || data.length !== size + 4) return socket.destroy(); try { const request = JSON.parse(data.subarray(4).toString()) as PrivilegedRequest; void service.invoke(request, peer).then((result) => socket.end(frame({ ok: true, nonce: request.nonce, result })), (error) => socket.end(frame({ ok: false, nonce: request.nonce, code: redactedCode(error) }))) } catch { socket.destroy() } }) }
function nativeWindowsPipeTransport(pipe: string, timeout: number, requireServiceIdentity: boolean) {
  return (request: PrivilegedRequest) => new Promise<unknown>((ok, bad) => {
    if (!CreateFileW || !WriteFile || !ReadFile || !CancelIoEx || !CloseHandle) {
      bad(privilegedHealthFailure('client-init', 'NATIVE_API_UNAVAILABLE', 'Native Windows named-pipe client unavailable'))
      return
    }
    const handle = CreateFileW(pipe, 0xc0000000, 0, null, 3, 0, null)
    if (invalidWindowsHandle(handle)) {
      const win32Error = GetLastError?.()
      bad(privilegedHealthFailure('pipe-open', classifyWindowsPipeOpenError(win32Error), 'Protected named-pipe service unavailable'))
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
    timer = setTimeout(() => fail(privilegedHealthFailure('response-read', 'RESPONSE_TIMEOUT', 'Privileged service timeout')), timeout)
    if (requireServiceIdentity) {
      const server = windowsPipeProcess(handle, GetNamedPipeServerProcessId)
      if (!server) {
        fail(privilegedHealthFailure('server-identity', 'SERVER_IDENTITY_UNAVAILABLE', 'Privileged service identity unavailable'))
        return
      }
      const service = windowsServiceIdentity()
      const parentProcessId = windowsParentProcessId(server.id)
      const confirmedServer = windowsPipeProcess(handle, GetNamedPipeServerProcessId)
      const confirmedService = windowsServiceIdentity()
      const serviceStable = service && confirmedService
        && service.name === confirmedService.name
        && service.state === confirmedService.state
        && service.processId === confirmedService.processId
        && service.configuredBinaryPath === confirmedService.configuredBinaryPath
      if (!serviceStable || !confirmedServer || confirmedServer.id !== server.id
        || !windowsServiceOwnsPipeServer(confirmedService, { processId: server.id, parentProcessId, image: server.image }, process.execPath)
        || !windowsServiceOwnsPipeServer(confirmedService, { processId: confirmedServer.id, parentProcessId, image: confirmedServer.image }, process.execPath)) {
        fail(privilegedHealthFailure('scm-lineage', 'SCM_LINEAGE_MISMATCH', 'Privileged service identity denied'))
        return
      }
    } else if (!windowsProcessForPipe(handle, GetNamedPipeServerProcessId, process.execPath)) {
      fail(privilegedHealthFailure('server-identity', 'SERVER_IDENTITY_UNAVAILABLE', 'Privileged service identity unavailable'))
      return
    }
    const output = frame(request)
    const bytesWritten = Buffer.alloc(4)
    WriteFile.async(handle, output, output.length, bytesWritten, null, (_writeError: unknown, writeOk: boolean) => {
      if (settled) return
      if (!writeOk || bytesWritten.readUInt32LE(0) !== output.length) {
        fail(privilegedHealthFailure('request-write', 'REQUEST_WRITE_FAILED', 'Privileged service write failed'))
        return
      }
      const input = Buffer.alloc(MAX_FRAME_BYTES + 4)
      const bytesRead = Buffer.alloc(4)
      ReadFile.async(handle, input, input.length, bytesRead, null, (_readError: unknown, readOk: boolean) => {
        if (settled) return
        try {
          const length = bytesRead.readUInt32LE(0)
          if (!readOk) throw privilegedHealthFailure('response-read', 'RESPONSE_READ_FAILED', 'Privileged service read failed')
          if (length < 4 || length > input.length || input.readUInt32BE(0) !== length - 4) {
            throw privilegedHealthFailure('response-frame', 'RESPONSE_FRAME_INVALID', 'Malformed privileged response')
          }
          let response: { ok: boolean; nonce: string; result?: unknown; code?: string }
          try {
            response = JSON.parse(input.subarray(4, length).toString()) as typeof response
          } catch {
            throw privilegedHealthFailure('response-frame', 'RESPONSE_FRAME_INVALID', 'Malformed privileged response')
          }
          if (response.nonce !== request.nonce) throw privilegedHealthFailure('response-binding', 'RESPONSE_NONCE_MISMATCH', 'Unbound privileged response')
          if (response.ok) succeed(response.result)
          else fail(privilegedHealthFailure('service-operation', redactedCode({ code: response.code }) ?? 'OPERATION_DENIED', 'Privileged service denied', response.code ?? 'UNAVAILABLE'))
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
      bad(privilegedHealthFailure('response-read', 'RESPONSE_TIMEOUT', 'Privileged service timeout'))
    }, timeout)
    socket.once('error', () => {
      clearTimeout(timer)
      bad(privilegedHealthFailure('pipe-open', 'PIPE_UNAVAILABLE', 'Protected named-pipe service unavailable'))
    })
    socket.on('data', (part: Buffer) => {
      data = Buffer.concat([data, part])
      if (data.length < 4) return
      try {
        const size = data.readUInt32BE(0)
        if (size > MAX_FRAME_BYTES || data.length !== size + 4) throw privilegedHealthFailure('response-frame', 'RESPONSE_FRAME_INVALID', 'Malformed privileged response')
        let response: { ok: boolean; nonce: string; result?: unknown; code?: string }
        try {
          response = JSON.parse(data.subarray(4).toString()) as typeof response
        } catch {
          throw privilegedHealthFailure('response-frame', 'RESPONSE_FRAME_INVALID', 'Malformed privileged response')
        }
        clearTimeout(timer)
        if (response.nonce !== request.nonce) throw privilegedHealthFailure('response-binding', 'RESPONSE_NONCE_MISMATCH', 'Unbound privileged response')
        if (response.ok) ok(response.result)
        else bad(privilegedHealthFailure('service-operation', redactedCode({ code: response.code }) ?? 'OPERATION_DENIED', 'Privileged service denied', response.code ?? 'UNAVAILABLE'))
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
  async healthCheck(): Promise<'ok'> {
    const result = await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation: 'health-check', payload: {} })
    if (result !== 'ok') throw privilegedHealthFailure('health-response', 'HEALTH_RESPONSE_INVALID', 'Privileged service health response invalid', 'INVALID_RESPONSE')
    return result
  }
  async readAccounting(scope: ProtectedAccountingScope): Promise<ProtectedAccountingHighWater> {
    const state = await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation: 'read', payload: { scope } }) as AccountingState
    return state.scopes[scopeKey(scope)] ?? { totalMs: scope.totalMs, committedMs: 0, reservedMs: 0, version: 0 }
  }
  private async journal(operation: 'reserve' | 'start' | 'debit' | 'reconcile' | 'attempt' | 'outcome' | 'commit' | 'materialized', receipt: string, amountMs: number, terminal: boolean, scope: ProtectedAccountingScope, started?: boolean, context?: { permission: RemoteApprovalPermissionTuple; authority: RemoteApprovalAuthoritySnapshot }, attemptId?: string): Promise<ProtectedAccountingHighWater> {
    const state = await this.readAccounting(scope)
    const result = await this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation, payload: { scope, receipt, expectedVersion: state.version, ...(amountMs > 0 ? { amountMs } : {}), ...(terminal ? { terminal: true } : {}), ...(context ? { context } : {}), ...(started === undefined ? {} : { started }), ...(attemptId ? { attemptId } : {}) } }) as AccountingState
    return result.scopes[scopeKey(scope)]
  }
  async commitTimerStart(handoff: TimerStartHandoff): Promise<void> {
    const amountMs = Math.round(handoff.minutes * 60_000)
    if (!Number.isSafeInteger(amountMs) || amountMs <= 0) throw new Error('Protected accounting amount invalid')
    await this.journal('commit', handoff.receipt, amountMs, false, handoff.scope, undefined, { permission: handoff.permission, authority: handoff.authority })
  }
  async listRecoverableTimerStarts(): Promise<TimerStartHandoff[]> {
    return this.transport({ capability: 'accounting', purpose: 'start-accounting', nonce: nonce(), operation: 'list-recoverable-timer-starts', payload: {} }) as Promise<TimerStartHandoff[]>
  }
  async acknowledgeTimerMaterialized(handoff: TimerStartHandoff): Promise<void> {
    const amountMs = Math.round(handoff.minutes * 60_000)
    if (!Number.isSafeInteger(amountMs) || amountMs <= 0) throw new Error('Protected accounting amount invalid')
    await this.journal('materialized', `${handoff.receipt}:materialized`, amountMs, false, handoff.scope, undefined, { permission: handoff.permission, authority: handoff.authority })
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
  async prepareTimerStartAttempt(receipt: string, minutes: number, attemptId: string, scope: ProtectedAccountingScope, context: { permission: RemoteApprovalPermissionTuple; authority: RemoteApprovalAuthoritySnapshot }): Promise<void> {
    const amountMs = Math.round(minutes * 60_000)
    await this.journal('attempt', `${receipt}:attempt`, amountMs, false, scope, undefined, context, attemptId)
  }
  async recordTimerOutcome(receipt: string, minutes: number, started: boolean, scope: ProtectedAccountingScope, context: { permission: RemoteApprovalPermissionTuple; authority: RemoteApprovalAuthoritySnapshot }, attemptId?: string): Promise<void> {
    const amountMs = Math.round(minutes * 60_000)
    await this.journal('outcome', `${receipt}:outcome-${started ? 'started' : 'not-started'}`, amountMs, false, scope, started, context, attemptId)
    if (started) {
      await this.journal('debit', `${receipt}:debit`, amountMs, false, scope)
    } else {
      await this.journal('reserve', `${receipt}:reserve`, amountMs, false, scope)
      await this.journal('reconcile', `${receipt}:reconcile-terminal`, 0, true, scope)
    }
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
