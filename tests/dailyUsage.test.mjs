import { describe, expect, it } from 'vitest'

import {
  isDailyUsageExhausted,
  normalizeDailyUsage,
  shouldPersistNormalizedDailyUsage,
} from '../src/shared/dailyUsage'

describe('daily usage recovery', () => {
  it('recovers completed sessions from durable session history when daily usage is missing', () => {
    const usage = normalizeDailyUsage({
      storedUsage: null,
      sessions: [
        { date: '2026-06-01', terminated: true },
        { date: '2026-06-01', terminated: true },
        { date: '2026-06-01', terminated: false },
        { date: '2026-05-31', terminated: true },
      ],
      dateKey: '2026-06-01',
    })

    expect(usage.sessionsCompleted).toBe(2)
    expect(usage.currentSessionRemainingMs).toBe(0)
    expect(isDailyUsageExhausted(usage, 2)).toBe(true)
  })

  it('keeps the larger completed count between stored usage and session history', () => {
    const usage = normalizeDailyUsage({
      storedUsage: {
        date: '2026-06-01',
        sessionsCompleted: 1,
        currentSessionRemainingMs: 12_000,
      },
      sessions: [
        { date: '2026-06-01', terminated: true },
        { date: '2026-06-01', terminated: true },
      ],
      dateKey: '2026-06-01',
    })

    expect(usage.sessionsCompleted).toBe(2)
    expect(usage.currentSessionRemainingMs).toBe(12_000)
  })

  it('persists only when normalized usage differs from the stored snapshot', () => {
    const storedUsage = {
      date: '2026-06-01',
      sessionsCompleted: 2,
      currentSessionRemainingMs: 12_000,
    }

    expect(shouldPersistNormalizedDailyUsage(storedUsage, { ...storedUsage })).toBe(false)
    expect(shouldPersistNormalizedDailyUsage(null, storedUsage)).toBe(true)
    expect(shouldPersistNormalizedDailyUsage(storedUsage, {
      ...storedUsage,
      sessionsCompleted: 3,
    })).toBe(true)
  })
})
