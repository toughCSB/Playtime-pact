export function shouldPauseTimerWhenSupportedGameMissing(timerRunning: boolean, supportedGameRunning: boolean): boolean {
  return timerRunning && !supportedGameRunning
}

export function shouldBlockTimerStartWithoutSupportedGame(isPackaged: boolean, supportedGameRunning: boolean): boolean {
  return isPackaged && !supportedGameRunning
}

export const shouldPauseTimerWhenRobloxMissing = shouldPauseTimerWhenSupportedGameMissing
export const shouldBlockTimerStartWithoutRoblox = shouldBlockTimerStartWithoutSupportedGame
