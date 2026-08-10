import { describe, expect, it } from 'vitest'

import {
  isHourAllowed,
  redactSettings,
  canUseAdminSession,
} from '../src/shared/policy'
import { normalizeTimerAdjustmentMinutes } from '../src/shared/timerAdjust'

const fullSettings = {
  weekdayLimit: 60,
  weekendLimit: 90,
  weekdaySessionCount: 1,
  weekendSessionCount: 2,
  allowedStartHour: 22,
  allowedEndHour: 6,
  adminPasswordHash: '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0',
  resumeTimerOnRestart: true,
  updatedAt: '2026-05-30T00:00:00.000Z',
}

describe('policy helpers', () => {
  it('redactSettings removes adminPasswordHash from renderer settings', () => {
    const redacted = redactSettings(fullSettings)
    expect(Object.hasOwn(redacted, 'adminPasswordHash')).toBe(false)
    expect(redacted.weekdayLimit).toBe(60)
  })

  it('isHourAllowed supports overnight windows and rejects outside hours', () => {
    expect(isHourAllowed(23, 22, 6)).toBe(true)
    expect(isHourAllowed(5, 22, 6)).toBe(true)
    expect(isHourAllowed(12, 22, 6)).toBe(false)
    expect(isHourAllowed(21, 16, 22)).toBe(true)
    expect(isHourAllowed(22, 16, 22)).toBe(false)
    expect(isHourAllowed(23, 16, 24)).toBe(true)
    expect(isHourAllowed(12, 0, 24)).toBe(true)
  })

  it('canUseAdminSession accepts only unexpired authenticated sessions', () => {
    expect(canUseAdminSession(1_000, 1_001)).toBe(true)
    expect(canUseAdminSession(1_000, 1_000)).toBe(false)
    expect(canUseAdminSession(1_000, 0)).toBe(false)
  })

  it('normalizeTimerAdjustmentMinutes accepts signed integer minute adjustments', () => {
    expect(normalizeTimerAdjustmentMinutes(5)).toBe(5)
    expect(normalizeTimerAdjustmentMinutes(-5)).toBe(-5)
    expect(normalizeTimerAdjustmentMinutes(240)).toBe(240)
    expect(normalizeTimerAdjustmentMinutes(-240)).toBe(-240)
  })

  it('normalizeTimerAdjustmentMinutes rejects empty, fractional, and excessive adjustments', () => {
    expect(() => normalizeTimerAdjustmentMinutes(0)).toThrow('invalid minutes')
    expect(() => normalizeTimerAdjustmentMinutes(1.5)).toThrow('invalid minutes')
    expect(() => normalizeTimerAdjustmentMinutes(241)).toThrow('invalid minutes')
    expect(() => normalizeTimerAdjustmentMinutes(-241)).toThrow('invalid minutes')
  })
})
