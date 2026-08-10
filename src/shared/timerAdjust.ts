export const MAX_TIMER_ADJUST_MINUTES = 240

export function normalizeTimerAdjustmentMinutes(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > MAX_TIMER_ADJUST_MINUTES) {
    throw new Error('invalid minutes')
  }
  return minutes
}
