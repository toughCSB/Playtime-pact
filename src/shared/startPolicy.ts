import type { Settings } from './types'

export function normalizeRequireApprovalBeforeStart(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true
}

export function requiresParentPinForRepeatSession(sessionsCompleted: number, hasActiveSession = false, pinApprovedSession = false): boolean {
  // A PIN-approved session may be resumed while its protected balance remains.
  return (!Number.isSafeInteger(sessionsCompleted) || sessionsCompleted !== 0)
    && !(hasActiveSession && pinApprovedSession)
}

export function shouldRequireApprovalForStart(
  settings: Pick<Settings, 'requireApprovalBeforeStart'>,
  options: { hasActiveSession: boolean; sessionsCompleted: number; pinApprovedSession?: boolean },
): boolean {
  if (requiresParentPinForRepeatSession(options.sessionsCompleted, options.hasActiveSession, options.pinApprovedSession)) return true
  if (options.hasActiveSession) return false
  return normalizeRequireApprovalBeforeStart(settings.requireApprovalBeforeStart)
}
