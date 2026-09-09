import { homedir } from 'os'
import { join } from 'path'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, renameSync } from 'fs'
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import type { DailyUsage, GamePresenceSpan, ManagedGameId, PrimarySelectionEvent, Session, Settings, TimerState } from '../shared/types'

import { DEFAULT_SETTINGS } from '../shared/types'
import { normalizeRequireApprovalBeforeStart } from '../shared/startPolicy'

const COMMON_APP_DATA_DIR = process.platform === 'win32' ? 'C:\\ProgramData' : homedir()
const PLAYTIME_PACT_DIR = join(COMMON_APP_DATA_DIR, 'PlaytimePact')
const ADMIN_DIR = join(PLAYTIME_PACT_DIR, 'Admin')
const DATA_DIR = join(PLAYTIME_PACT_DIR, 'Data')
const SETTINGS_PATH = join(PLAYTIME_PACT_DIR, 'settings.json')
const SETTINGS_BAK_PATH = join(PLAYTIME_PACT_DIR, 'settings.json.bak')
const ADMIN_SECRET_PATH = join(ADMIN_DIR, 'admin-secret.json')
const SESSIONS_PATH = join(DATA_DIR, 'sessions.json')
const TIMER_STATE_PATH = join(DATA_DIR, 'timer-state.json')
const DAILY_USAGE_PATH = join(DATA_DIR, 'daily-usage.json')
const DAILY_USAGE_INTEGRITY_PATH = join(DATA_DIR, 'daily-usage.integrity')
const DAILY_USAGE_KEY_PATH = join(ADMIN_DIR, 'daily-usage.key')
const LOCKED_ADMIN_PASSWORD_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
const ADMIN_SECRET_SCHEMA_VERSION = 1
const ADMIN_SECRET_ALGORITHM = 'pbkdf2-sha256'
const ADMIN_SECRET_ITERATIONS = 1_500_000
const ADMIN_SECRET_SALT_BYTES = 16
const ADMIN_SECRET_HASH_BYTES = 32

const MAX_DAILY_MS = 24 * 60 * 60 * 1000

type AdminPasswordSecretV1 = {
  schemaVersion: 1
  algorithm: 'pbkdf2-sha256'
  iterations: number
  salt: string
  hash: string
}

type LegacyAdminPasswordSecret = {
  adminPasswordHash: string
}

type AdminPasswordSecret = AdminPasswordSecretV1 | LegacyAdminPasswordSecret

function ensureDir(): void {
  tryMkdir(PLAYTIME_PACT_DIR)
  tryMkdir(ADMIN_DIR)
  tryMkdir(DATA_DIR)
}

function tryMkdir(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
  } catch {}
}

function normalizeManagedGameId(value: unknown): ManagedGameId {
  return value === 'minecraft' ? 'minecraft' : 'roblox'
}

function normalizeManagedGameIds(value: unknown): ManagedGameId[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized: ManagedGameId[] = []
  for (const entry of value) {
    const gameId = normalizeManagedGameId(entry)
    if (!normalized.includes(gameId)) normalized.push(gameId)
  }
  return normalized.length > 0 ? normalized : undefined
}

function normalizePresenceSpans(value: unknown): GamePresenceSpan[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as Partial<GamePresenceSpan>
    if (typeof candidate.startedAt !== 'string') return []
    const terminationReason: GamePresenceSpan['terminationReason'] = candidate.terminationReason === 'expired' || candidate.terminationReason === 'admin-stop'
      ? candidate.terminationReason
      : candidate.terminationReason === 'closed'
        ? 'closed'
        : undefined
    return [{
      gameId: normalizeManagedGameId(candidate.gameId),
      startedAt: candidate.startedAt,
      endedAt: typeof candidate.endedAt === 'string' ? candidate.endedAt : undefined,
      terminationReason,
    }]
  })
  return normalized.length > 0 ? normalized : undefined
}

function normalizePrimarySelectionEvents(value: unknown): PrimarySelectionEvent[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as Partial<PrimarySelectionEvent>
    if (typeof candidate.selectedAt !== 'string') return []
    return [{
      gameId: normalizeManagedGameId(candidate.gameId),
      selectedAt: candidate.selectedAt,
    }]
  })
  return normalized.length > 0 ? normalized : undefined
}

function atomicWrite(path: string, data: string): void {
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, data, 'utf-8')
  try {
    renameSync(tmpPath, path)
  } catch {
    try {
      if (existsSync(path)) unlinkSync(path)
      renameSync(tmpPath, path)
    } catch {
      try { unlinkSync(tmpPath) } catch {}
      writeFileSync(path, data, 'utf-8')
    }
  }
}

function readJsonFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
  return JSON.parse(raw) as T
}

function safeInt(val: unknown, fallback: number, min: number, max: number): number {
  const n = Number(val)
  if (!isFinite(n) || n < min || n > max) return fallback
  return Math.round(n)
}

function normalizeSettings(settings: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  // 수치 필드 전체 검증 — NaN/Infinity/범위 초과 시 기본값으로 교체
  merged.weekdayLimit        = safeInt(merged.weekdayLimit,        DEFAULT_SETTINGS.weekdayLimit,        1, 480)
  merged.weekendLimit        = safeInt(merged.weekendLimit,        DEFAULT_SETTINGS.weekendLimit,        1, 480)
  merged.weekdaySessionCount = safeInt(merged.weekdaySessionCount, DEFAULT_SETTINGS.weekdaySessionCount, 1,  10)
  merged.weekendSessionCount = safeInt(merged.weekendSessionCount, DEFAULT_SETTINGS.weekendSessionCount, 1,  10)
  merged.allowedStartHour    = safeInt(merged.allowedStartHour,    DEFAULT_SETTINGS.allowedStartHour,    0,  23)
  merged.allowedEndHour      = safeInt(merged.allowedEndHour,      DEFAULT_SETTINGS.allowedEndHour,      0,  24)
  if (merged.allowedStartHour === merged.allowedEndHour) {
    merged.allowedStartHour = DEFAULT_SETTINGS.allowedStartHour
    merged.allowedEndHour = DEFAULT_SETTINGS.allowedEndHour
  }
  merged.adminPasswordHash = normalizeAdminPasswordHash(merged.adminPasswordHash)
  if (typeof merged.resumeTimerOnRestart !== 'boolean') {
    merged.resumeTimerOnRestart = DEFAULT_SETTINGS.resumeTimerOnRestart
  }
  merged.requireApprovalBeforeStart = normalizeRequireApprovalBeforeStart(merged.requireApprovalBeforeStart)
  if (typeof merged.updatedAt !== 'string') {
    merged.updatedAt = new Date().toISOString()
  }
  return merged
}

function normalizeAdminPasswordHash(hash: unknown): string {
  return isAdminPasswordHash(hash)
    ? hash
    : DEFAULT_SETTINGS.adminPasswordHash
}

function isAdminPasswordHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
}

function isAdminPasswordSalt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 16) return false
  try {
    return Buffer.from(value, 'base64').length === ADMIN_SECRET_SALT_BYTES
  } catch {
    return false
  }
}

function isAdminPasswordSecretV1(value: unknown): value is AdminPasswordSecretV1 {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AdminPasswordSecretV1>
  return candidate.schemaVersion === ADMIN_SECRET_SCHEMA_VERSION
    && candidate.algorithm === ADMIN_SECRET_ALGORITHM
    && Number.isInteger(candidate.iterations)
    && typeof candidate.iterations === 'number'
    && candidate.iterations >= 100_000
    && candidate.iterations <= 10_000_000
    && isAdminPasswordSalt(candidate.salt)
    && isAdminPasswordHash(candidate.hash)
}

function isLegacyAdminPasswordSecret(value: unknown): value is LegacyAdminPasswordSecret {
  if (!value || typeof value !== 'object') return false
  return isAdminPasswordHash((value as Partial<LegacyAdminPasswordSecret>).adminPasswordHash)
}

function hashAdminPassword(pin: string): string {
  return createHash('sha256').update(pin).digest('hex')
}

function deriveAdminPasswordHash(pin: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(pin, salt, iterations, ADMIN_SECRET_HASH_BYTES, 'sha256')
}

export function createAdminPasswordSecret(pin: string): AdminPasswordSecretV1 {
  const salt = randomBytes(ADMIN_SECRET_SALT_BYTES)
  return {
    schemaVersion: ADMIN_SECRET_SCHEMA_VERSION,
    algorithm: ADMIN_SECRET_ALGORITHM,
    iterations: ADMIN_SECRET_ITERATIONS,
    salt: salt.toString('base64'),
    hash: deriveAdminPasswordHash(pin, salt, ADMIN_SECRET_ITERATIONS).toString('hex'),
  }
}

export function verifyAdminPasswordSecret(secret: unknown, pin: string): { ok: boolean; needsMigration: boolean } {
  if (isAdminPasswordSecretV1(secret)) {
    const expected = Buffer.from(secret.hash, 'hex')
    const actual = deriveAdminPasswordHash(pin, Buffer.from(secret.salt, 'base64'), secret.iterations)
    return { ok: actual.length === expected.length && timingSafeEqual(actual, expected), needsMigration: false }
  }
  if (isLegacyAdminPasswordSecret(secret)) {
    return { ok: hashAdminPassword(pin) === secret.adminPasswordHash, needsMigration: true }
  }
  return { ok: false, needsMigration: false }
}

function readLegacyAdminPasswordHash(): string | null {
  for (const path of [SETTINGS_PATH]) {
    try {
      const parsed = readJsonFile<Partial<Settings>>(path)
      if (isAdminPasswordHash(parsed.adminPasswordHash)) {
        return parsed.adminPasswordHash
      }
    } catch {}
  }
  return null
}

function readPersistedAdminPasswordSecret(): AdminPasswordSecret | null {
  try {
    const parsed = readJsonFile<unknown>(ADMIN_SECRET_PATH)
    if (isAdminPasswordSecretV1(parsed) || isLegacyAdminPasswordSecret(parsed)) {
      return parsed
    }
  } catch {}
  return null
}

export function readAdminPasswordHash(): string {
  ensureDir()
  const persistedSecret = readPersistedAdminPasswordSecret()
  if (isLegacyAdminPasswordSecret(persistedSecret)) return persistedSecret.adminPasswordHash
  if (persistedSecret) return LOCKED_ADMIN_PASSWORD_HASH
  if (process.platform === 'win32') return LOCKED_ADMIN_PASSWORD_HASH
  if (existsSync(ADMIN_SECRET_PATH)) return LOCKED_ADMIN_PASSWORD_HASH
  const legacyHash = readLegacyAdminPasswordHash()
  if (legacyHash) {
    try {
      writeLegacyAdminPasswordHash(legacyHash)
    } catch {}
    return legacyHash
  }
  try {
    writeAdminPasswordPin('0000')
  } catch {}
  return DEFAULT_SETTINGS.adminPasswordHash
}

export function verifyAdminPassword(pin: string): boolean {
  ensureDir()
  const persistedSecret = readPersistedAdminPasswordSecret()
  if (persistedSecret) {
    const result = verifyAdminPasswordSecret(persistedSecret, pin)
    if (result.ok && result.needsMigration) {
      try {
        writeAdminPasswordPin(pin)
      } catch {}
    }
    return result.ok
  }
  if (process.platform === 'win32') return false
  const legacyHash = readLegacyAdminPasswordHash()
  if (!legacyHash) {
    const ok = pin === '0000'
    if (ok) {
      try {
        writeAdminPasswordPin(pin)
      } catch {}
    }
    return ok
  }
  const result = verifyAdminPasswordSecret({ adminPasswordHash: legacyHash }, pin)
  if (result.ok) {
    try {
      writeAdminPasswordPin(pin)
    } catch {}
  }
  return result.ok
}

export function writeAdminPasswordPin(pin: string): void {
  writeAdminPasswordSecret(createAdminPasswordSecret(pin))
}

function writeLegacyAdminPasswordHash(hash: string): void {
  writeAdminPasswordSecret({ adminPasswordHash: normalizeAdminPasswordHash(hash) })
}

function writeAdminPasswordSecret(secret: AdminPasswordSecret): void {
  ensureDir()
  const serialized = JSON.stringify(secret, null, 2)
  atomicWrite(ADMIN_SECRET_PATH, serialized)
}

function toPersistedSettings(settings: Settings): Omit<Settings, 'adminPasswordHash'> {
  const { adminPasswordHash: _adminPasswordHash, ...persisted } = normalizeSettings(settings)
  return persisted
}

export function readSettings(): Settings {
  ensureDir()
  try {
    return { ...normalizeSettings(readJsonFile<Partial<Settings>>(SETTINGS_PATH)), adminPasswordHash: readAdminPasswordHash() }
  } catch {
    return { ...DEFAULT_SETTINGS, adminPasswordHash: readAdminPasswordHash() }
  }
}

export function writeSettings(settings: Settings): void {
  ensureDir()
  if (existsSync(SETTINGS_PATH)) {
    copyFileSync(SETTINGS_PATH, SETTINGS_BAK_PATH)
  }
  try {
    atomicWrite(SETTINGS_PATH, JSON.stringify(toPersistedSettings(settings), null, 2))
  } catch (err) {
    if (existsSync(SETTINGS_BAK_PATH)) {
      copyFileSync(SETTINGS_BAK_PATH, SETTINGS_PATH)
    }
    throw err
  }
}

export function readSessions(): Session[] {
  ensureDir()
  try {
    return readJsonFile<Session[]>(SESSIONS_PATH).map((session) => ({
      ...session,
      gameId: normalizeManagedGameId(session.gameId),
      primaryGameId: session.primaryGameId ? normalizeManagedGameId(session.primaryGameId) : undefined,
      activeGameIds: normalizeManagedGameIds(session.activeGameIds),
      presenceSpans: normalizePresenceSpans(session.presenceSpans),
      primarySelectionEvents: normalizePrimarySelectionEvents(session.primarySelectionEvents),
    }))
  } catch {
    return []
  }
}


export function appendSession(sessionData: Omit<Session, 'id'>): void {
  ensureDir()
  const sessions = readSessions()
  const newSession: Session = {
    id: randomUUID(),
    ...sessionData,
    gameId: normalizeManagedGameId(sessionData.gameId),
  }
  sessions.push(newSession)
  atomicWrite(SESSIONS_PATH, JSON.stringify(sessions, null, 2))
}

export function readTimerState(): TimerState | null {
  try {
    const parsed = readJsonFile<TimerState>(TIMER_STATE_PATH)
    if (!isFinite(parsed.startTime) || !isFinite(parsed.limitMs) ||
        parsed.limitMs <= 0 || parsed.limitMs > MAX_DAILY_MS) return null
    if (parsed.pausedRemainingMs !== undefined) {
      if (!isFinite(parsed.pausedRemainingMs) ||
          parsed.pausedRemainingMs < 0 || parsed.pausedRemainingMs > MAX_DAILY_MS) {
        delete parsed.pausedRemainingMs
      }
    }
    if (parsed.sessionStartTime !== undefined && typeof parsed.sessionStartTime !== 'string') {
      delete parsed.sessionStartTime
    }
    if (parsed.limitAtSession !== undefined && (!isFinite(parsed.limitAtSession) || parsed.limitAtSession <= 0)) {
      delete parsed.limitAtSession
    }
    if (parsed.startReceipt !== undefined && (typeof parsed.startReceipt !== 'string' || !/^[A-Za-z0-9._:-]{16,256}$/.test(parsed.startReceipt))) delete parsed.startReceipt
    parsed.primaryGameId = parsed.primaryGameId ? normalizeManagedGameId(parsed.primaryGameId) : undefined
    parsed.activeGameIds = normalizeManagedGameIds(parsed.activeGameIds)
    parsed.presenceSpans = normalizePresenceSpans(parsed.presenceSpans)
    parsed.primarySelectionEvents = normalizePrimarySelectionEvents(parsed.primarySelectionEvents)
    return parsed
  } catch {
    return null
  }
}

export function writeTimerState(state: TimerState): void {
  ensureDir()
  const temporary = `${TIMER_STATE_PATH}.${process.pid}.tmp`
  const handle = openSync(temporary, 'w', 0o600)
  try { writeFileSync(handle, JSON.stringify(state, null, 2), 'utf8'); fsyncSync(handle) } finally { closeSync(handle) }
  try { renameSync(temporary, TIMER_STATE_PATH) } catch (error) {
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

export function clearTimerState(): void {
  try {
    if (existsSync(TIMER_STATE_PATH)) unlinkSync(TIMER_STATE_PATH)
  } catch { /* ignore */ }
}

export function readDailyUsage(): DailyUsage | null {
  try {
    const parsed = readJsonFile<DailyUsage>(DAILY_USAGE_PATH)
    if (!isDailyUsageIntegrityAvailable()) return null
    if (typeof parsed.date !== 'string' || parsed.date.length !== 10) return null
    const sessionsCompleted = isFinite(parsed.sessionsCompleted) && parsed.sessionsCompleted >= 0
      ? Math.floor(parsed.sessionsCompleted) : 0
    const currentSessionRemainingMs = isFinite(parsed.currentSessionRemainingMs) && parsed.currentSessionRemainingMs >= 0
      ? Math.min(parsed.currentSessionRemainingMs, MAX_DAILY_MS) : 0
    return { date: parsed.date, sessionsCompleted, currentSessionRemainingMs }
  } catch {
    return null
  }
}
export function readVerifiedDailyUsageForMigration(): DailyUsage | null {
  if (!existsSync(DAILY_USAGE_PATH)) return null
  if (!isDailyUsageIntegrityAvailable()) throw new Error('Legacy daily usage integrity unavailable')
  const usage = readDailyUsage()
  if (!usage) throw new Error('Legacy daily usage invalid')
  return usage
}
function dailyUsagePayload(usage: DailyUsage): string {
  return JSON.stringify({
    date: usage.date,
    sessionsCompleted: usage.sessionsCompleted,
    currentSessionRemainingMs: usage.currentSessionRemainingMs,
  })
}

function dailyUsageKey(create: boolean): Buffer | null {
  try {
    if (existsSync(DAILY_USAGE_KEY_PATH)) {
      const key = Buffer.from(readFileSync(DAILY_USAGE_KEY_PATH, 'utf8').trim(), 'base64url')
      return key.length === 32 ? key : null
    }
    if (!create) return null
    ensureDir()
    const key = randomBytes(32)
    writeFileSync(DAILY_USAGE_KEY_PATH, `${key.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return key
  } catch {
    return null
  }
}

function dailyUsageIntegrity(usage: DailyUsage, key: Buffer): string {
  return createHmac('sha256', key).update(dailyUsagePayload(usage)).digest('base64url')
}

export function isDailyUsageIntegrityAvailable(): boolean {
  if (!existsSync(DAILY_USAGE_PATH)) return dailyUsageKey(true) !== null
  const key = dailyUsageKey(false)
  if (!key || !existsSync(DAILY_USAGE_INTEGRITY_PATH)) return false
  try {
    const usage = readJsonFile<DailyUsage>(DAILY_USAGE_PATH)
    const signature = readFileSync(DAILY_USAGE_INTEGRITY_PATH, 'utf8').trim()
    return signature.length === 43 && timingSafeEqual(Buffer.from(signature), Buffer.from(dailyUsageIntegrity(usage, key)))
  } catch {
    return false
  }
}


export function writeDailyUsage(usage: DailyUsage): void {
  ensureDir()
  const sessionsCompleted = safeInt(usage.sessionsCompleted, 0, 0, 1000)
  const currentSessionRemainingMs = Math.min(MAX_DAILY_MS, Math.max(0, Number(usage.currentSessionRemainingMs) || 0))
  const normalized = { date: usage.date, sessionsCompleted, currentSessionRemainingMs }
  const key = dailyUsageKey(true)
  if (!key) throw new Error('Daily usage integrity authority is unavailable')
  atomicWrite(DAILY_USAGE_PATH, JSON.stringify(normalized, null, 2))
  atomicWrite(DAILY_USAGE_INTEGRITY_PATH, `${dailyUsageIntegrity(normalized, key)}\n`)
}

export function clearDailyUsage(): void {
  try {
    if (existsSync(DAILY_USAGE_PATH)) unlinkSync(DAILY_USAGE_PATH)
    if (existsSync(DAILY_USAGE_INTEGRITY_PATH)) unlinkSync(DAILY_USAGE_INTEGRITY_PATH)
  } catch { /* ignore */ }
}
