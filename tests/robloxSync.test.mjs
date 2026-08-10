import { describe, expect, it } from 'vitest'

import {
  shouldBlockTimerStartWithoutSupportedGame,
  shouldPauseTimerWhenSupportedGameMissing,
} from '../src/shared/robloxSync'

describe('supported-game/timer synchronization policy', () => {
  it('pauses an active timer as soon as the supported game is no longer running', () => {
    expect(shouldPauseTimerWhenSupportedGameMissing(true, false)).toBe(true)
    expect(shouldPauseTimerWhenSupportedGameMissing(true, true)).toBe(false)
    expect(shouldPauseTimerWhenSupportedGameMissing(false, false)).toBe(false)
  })

  it('blocks packaged timer starts when no supported game is running', () => {
    expect(shouldBlockTimerStartWithoutSupportedGame(true, false)).toBe(true)
    expect(shouldBlockTimerStartWithoutSupportedGame(true, true)).toBe(false)
  })

  it('allows non-packaged dev starts for local UI/test work', () => {
    expect(shouldBlockTimerStartWithoutSupportedGame(false, false)).toBe(false)
  })
})
