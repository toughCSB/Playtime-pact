import type { DailyUsage, Session } from './types'

const MAX_DAILY_MS = 24 * 60 * 60 * 1000

type SessionLike = Pick<Session, 'date' | 'terminated'>

function safeCompleted(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function safeRemainingMs(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_DAILY_MS) : 0
}

export function countCompletedSessionsForDate(
  sessions: readonly SessionLike[],
  dateKey: string,
): number {
  return sessions.filter(session => session.date === dateKey && session.terminated).length
}

export function normalizeDailyUsage(options: {
  storedUsage: DailyUsage | null
  sessions: readonly SessionLike[]
  dateKey: string
}): DailyUsage {
  const storedToday = options.storedUsage?.date === options.dateKey ? options.storedUsage : null
  const completedFromStored = storedToday ? safeCompleted(storedToday.sessionsCompleted) : 0
  const completedFromHistory = countCompletedSessionsForDate(options.sessions, options.dateKey)

  return {
    date: options.dateKey,
    sessionsCompleted: Math.max(completedFromStored, completedFromHistory),
    currentSessionRemainingMs: storedToday
      ? safeRemainingMs(storedToday.currentSessionRemainingMs)
      : 0,
  }
}

export function shouldPersistNormalizedDailyUsage(
  storedUsage: DailyUsage | null,
  normalizedUsage: DailyUsage,
): boolean {
  return (
    !storedUsage ||
    storedUsage.date !== normalizedUsage.date ||
    storedUsage.sessionsCompleted !== normalizedUsage.sessionsCompleted ||
    storedUsage.currentSessionRemainingMs !== normalizedUsage.currentSessionRemainingMs
  )
}

export function isDailyUsageExhausted(usage: DailyUsage, sessionsPerDay: number): boolean {
  return usage.sessionsCompleted >= sessionsPerDay && usage.currentSessionRemainingMs <= 0
}
