import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { uptime } from 'node:os'
import type { DailyUsage } from '../../shared/types'

export type ProtectedUsageSnapshot = { revision: number; usage: DailyUsage; credits: string[]; runningUntil?: number; bootEpochMs?: number; countsTowardDailySessions?: boolean; pinApprovedSession?: boolean }
export type ProtectedUsageView = Pick<ProtectedUsageSnapshot, 'revision' | 'usage' | 'runningUntil' | 'pinApprovedSession'>
export const publicUsageView = ({ revision, usage, runningUntil, pinApprovedSession }: ProtectedUsageSnapshot): ProtectedUsageView => ({ revision, usage,
  ...(runningUntil === undefined ? {} : { runningUntil }), ...(pinApprovedSession === undefined ? {} : { pinApprovedSession }) })
export type UsageCredit = { receipt: string; amountMs: number; date: string; countsTowardDailySessions?: boolean; pinApprovedSession?: boolean }
const MAX_MS = 86_400_000
// Shared by every store instance in this service process. A new Windows boot
// changes this value even when the wall clock advances while the PC is off.
const SERVICE_BOOT_EPOCH_MS = Math.round(Date.now() - uptime() * 1000)
const SAME_BOOT_TOLERANCE_MS = 3_000
const validUsage = (usage: DailyUsage): boolean => Boolean(usage && /^\d{4}-\d{2}-\d{2}$/.test(usage.date)
  && Number.isSafeInteger(usage.sessionsCompleted) && usage.sessionsCompleted >= 0 && usage.sessionsCompleted <= 1000
  && Number.isSafeInteger(usage.currentSessionRemainingMs) && usage.currentSessionRemainingMs >= 0 && usage.currentSessionRemainingMs <= MAX_MS)

/** Only the privileged service opens this protected file. No caller-selected paths. */
export class ProtectedUsageStore {
  private readonly path: string
  constructor(directory: string, private readonly today: () => string, private readonly now = () => Date.now(),
    private readonly bootEpochMs = () => SERVICE_BOOT_EPOCH_MS) { this.path = join(directory, 'desktop-usage.json') }
  initialize(migrate: () => DailyUsage | null): void {
    if (existsSync(this.path)) { this.load(); return }
    const usage = migrate() ?? { date: this.today(), sessionsCompleted: 0, currentSessionRemainingMs: 0 }
    if (!validUsage(usage)) throw new Error('Protected usage migration invalid')
    this.persist({ revision: 0, usage, credits: [], countsTowardDailySessions: usage.currentSessionRemainingMs > 0 })
  }
  private load(): ProtectedUsageSnapshot {
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as ProtectedUsageSnapshot
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !validUsage(value.usage)
      || (value.runningUntil !== undefined && (!Number.isSafeInteger(value.runningUntil) || value.runningUntil < 0))
      || (value.bootEpochMs !== undefined && (!Number.isSafeInteger(value.bootEpochMs) || value.bootEpochMs < 0))
      || (value.countsTowardDailySessions !== undefined && typeof value.countsTowardDailySessions !== 'boolean')
      || (value.pinApprovedSession !== undefined && typeof value.pinApprovedSession !== 'boolean')
      || !Array.isArray(value.credits) || value.credits.length > 4096
      || value.credits.some((receipt) => typeof receipt !== 'string' || !/^[A-Za-z0-9._:-]{16,256}$/.test(receipt))) {
      throw new Error('Protected usage integrity unavailable')
    }
    return value
  }
  private persist(value: ProtectedUsageSnapshot): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    const handle = openSync(temporary, 'w', 0o600)
    try { writeFileSync(handle, `${JSON.stringify(value)}\n`, 'utf8'); fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(temporary, this.path)
  }
  read(): ProtectedUsageSnapshot {
    return this.readAt(this.today(), this.now())
  }
  pauseForShutdown(): void {
    const current = this.read()
    if (current.runningUntil === undefined) return
    const { runningUntil: _deadline, bootEpochMs: _boot, ...paused } = current
    this.persist({ ...paused, revision: current.revision + 1 })
  }
  approveRepeatSession(): ProtectedUsageSnapshot {
    const current = this.read()
    if (current.usage.sessionsCompleted < 1 || current.usage.currentSessionRemainingMs <= 0) {
      throw new Error('No repeat session balance to approve')
    }
    const { runningUntil: _deadline, bootEpochMs: _boot, ...paused } = current
    const approved = { ...paused, revision: current.revision + 1, pinApprovedSession: true }
    this.persist(approved)
    return approved
  }
  private readAt(day: string, now: number): ProtectedUsageSnapshot {
    const current = this.load()
    if (current.usage.date > day) throw new Error('Protected usage date rollback denied')
    if (current.usage.date < day) {
      const next = { revision: current.revision + 1, usage: { date: day, sessionsCompleted: 0, currentSessionRemainingMs: 0 }, credits: [] }
      this.persist(next)
      return next
    }
    if (current.runningUntil === undefined) return current
    if (current.bootEpochMs !== undefined && Math.abs(current.bootEpochMs - this.bootEpochMs()) > SAME_BOOT_TOLERANCE_MS) {
      // A reboot ends every game process. Preserve the last durable heartbeat,
      // rather than spending the hours for which Windows was powered off.
      const { runningUntil: _deadline, bootEpochMs: _boot, ...paused } = current
      return paused
    }
    const remaining = Math.min(current.usage.currentSessionRemainingMs, Math.max(0, current.runningUntil - now))
    return { ...current, usage: { ...current.usage, currentSessionRemainingMs: remaining,
      sessionsCompleted: current.usage.sessionsCompleted + (remaining === 0 && current.countsTowardDailySessions ? 1 : 0) },
      pinApprovedSession: remaining > 0 && current.pinApprovedSession === true }
  }
  write(usage: DailyUsage, expectedRevision: number, credit?: UsageCredit, running = false): ProtectedUsageSnapshot {
    const day = this.today(), now = this.now()
    if (!validUsage(usage) || usage.date !== day) throw new Error('Protected usage date or value invalid')
    const current = this.readAt(day, now)
    if (expectedRevision !== current.revision) throw new Error('Protected usage revision conflict')
    const stored = this.load()
    if (usage.sessionsCompleted < stored.usage.sessionsCompleted) throw new Error('Protected usage counter rollback denied')
    if (credit && (credit.date !== usage.date || !Number.isSafeInteger(credit.amountMs) || credit.amountMs <= 0
      || !/^[A-Za-z0-9._:-]{16,256}$/.test(credit.receipt))) throw new Error('Protected usage credit invalid')
    const unusedCredit = credit && !current.credits.includes(credit.receipt) ? credit : undefined
    if (usage.currentSessionRemainingMs > stored.usage.currentSessionRemainingMs + (unusedCredit?.amountMs ?? 0)) {
      throw new Error('Protected usage increase requires unused credit')
    }
    // Network/queue delay cannot move an existing protected deadline into the future.
    const remaining = Math.min(usage.currentSessionRemainingMs, current.usage.currentSessionRemainingMs + (unusedCredit?.amountMs ?? 0))
    const completed = Math.max(usage.sessionsCompleted, current.usage.sessionsCompleted)
    const pendingBase = Boolean(stored.countsTowardDailySessions) && completed === stored.usage.sessionsCompleted
    const next = { revision: current.revision + 1, usage: { ...usage, sessionsCompleted: completed, currentSessionRemainingMs: remaining },
      credits: unusedCredit ? [...current.credits, unusedCredit.receipt] : current.credits,
      countsTowardDailySessions: remaining > 0 && (pendingBase || Boolean(unusedCredit && unusedCredit.countsTowardDailySessions !== false)),
      pinApprovedSession: remaining > 0 && (unusedCredit?.pinApprovedSession === true
        || (current.pinApprovedSession === true && completed === stored.usage.sessionsCompleted)),
      ...(running && remaining > 0 ? { runningUntil: now + remaining, bootEpochMs: this.bootEpochMs() } : {}) }
    if (!validUsage(next.usage)) throw new Error('Protected usage value invalid')
    if (next.credits.length > 4096) throw new Error('Protected usage credit capacity denied')
    this.persist(next)
    return next
  }
}
