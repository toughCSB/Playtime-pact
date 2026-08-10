import { describe, expect, it } from 'vitest'
import { INITIAL_TIMER_PRESENTATION, reduceTimerPresentation } from '../src/renderer/src/timerPresentation.ts'

const reduce = (events) => events.reduce(reduceTimerPresentation, INITIAL_TIMER_PRESENTATION)

describe('timer presentation reducer', () => {
  it('keeps the active expiry sequence shutdown-first and terminal', () => {
    const shutdown = reduce([{ type: 'RUNNING' }, { type: 'MODE_SHUTDOWN' }])
    expect(shutdown.mode).toBe('shutdown')
    expect(reduceTimerPresentation(shutdown, { type: 'EXPIRED' })).toEqual({ mode: 'expired', blockedReason: null })
  })

  it.each(['outside-hours', 'daily-exhausted', 'approval-required'])('makes direct %s termination failure sticky without a shutdown event', (reason) => {
    const failed = reduce([
      { type: 'BLOCKED', reason },
      { type: 'TERMINATION_FAILED' },
    ])
    expect(failed).toEqual({ mode: 'termination-failed-sticky', blockedReason: reason })
    expect(reduceTimerPresentation(failed, { type: 'STATUS', running: false })).toEqual(failed)
  })

  it('only clears sticky failures through authoritative exits', () => {
    const failed = reduce([
      { type: 'BLOCKED', reason: 'outside-hours' },
      { type: 'TERMINATION_FAILED' },
    ])
    expect(reduceTimerPresentation(failed, { type: 'GAME_CLOSED', activeGameCount: 1 })).toEqual(failed)
    expect(reduceTimerPresentation(failed, { type: 'GAME_CLOSED', activeGameCount: 0 })).toEqual({ mode: 'full-page', blockedReason: null })
    expect(reduceTimerPresentation(failed, { type: 'ADMIN_STOPPED' })).toEqual({ mode: 'full-page', blockedReason: null })
    expect(reduceTimerPresentation(failed, { type: 'RUNNING' })).toEqual({ mode: 'active-overlay', blockedReason: null })
  })
})
