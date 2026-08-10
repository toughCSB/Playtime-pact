export type BlockedReason = 'outside-hours' | 'daily-exhausted' | 'approval-required'

export type TimerPresentationState =
  | { mode: 'full-page'; blockedReason: BlockedReason | null }
  | { mode: 'active-overlay'; blockedReason: null }
  | { mode: 'shutdown'; blockedReason: BlockedReason | null }
  | { mode: 'termination-failed-sticky'; blockedReason: BlockedReason | null }
  | { mode: 'expired'; blockedReason: null }

export type TimerPresentationEvent =
  | { type: 'BLOCKED'; reason: BlockedReason }
  | { type: 'RUNNING' }
  | { type: 'MODE_SHUTDOWN' }
  | { type: 'TERMINATION_FAILED' }
  | { type: 'GAME_CLOSED'; activeGameCount: number }
  | { type: 'ADMIN_STOPPED' }
  | { type: 'EXPIRED' }
  | { type: 'STATUS'; running: boolean }

export const INITIAL_TIMER_PRESENTATION: TimerPresentationState = {
  mode: 'full-page',
  blockedReason: null,
}

export function reduceTimerPresentation(
  state: TimerPresentationState,
  event: TimerPresentationEvent,
): TimerPresentationState {
  switch (event.type) {
    case 'BLOCKED':
      return { mode: 'full-page', blockedReason: event.reason }
    case 'RUNNING':
      return { mode: 'active-overlay', blockedReason: null }
    case 'MODE_SHUTDOWN':
      return { mode: 'shutdown', blockedReason: state.blockedReason }
    case 'TERMINATION_FAILED':
      return { mode: 'termination-failed-sticky', blockedReason: state.blockedReason }
    case 'GAME_CLOSED':
      return event.activeGameCount === 0
        ? { mode: 'full-page', blockedReason: null }
        : state
    case 'ADMIN_STOPPED':
      return { mode: 'full-page', blockedReason: null }
    case 'EXPIRED':
      return { mode: 'expired', blockedReason: null }
    case 'STATUS':
      if (event.running) return { mode: 'active-overlay', blockedReason: null }
      return state.mode === 'termination-failed-sticky' ? state : { mode: 'full-page', blockedReason: state.blockedReason }
  }
}
