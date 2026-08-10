import type { Settings } from './types'

export function normalizeRequireApprovalBeforeStart(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true
}

export function shouldRequireApprovalForStart(
  settings: Pick<Settings, 'requireApprovalBeforeStart'>,
  options: { hasActiveSession: boolean },
): boolean {
  if (options.hasActiveSession) return false
  return normalizeRequireApprovalBeforeStart(settings.requireApprovalBeforeStart)
}
