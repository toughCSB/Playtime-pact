import type { PublicSettings, Settings } from './types'

export function redactSettings(settings: Settings): PublicSettings {
  const { adminPasswordHash: _adminPasswordHash, ...publicSettings } = settings
  return publicSettings
}

export function isHourAllowed(hour: number, allowedStartHour: number, allowedEndHour: number): boolean {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return false
  if (!Number.isFinite(allowedStartHour) || allowedStartHour < 0 || allowedStartHour > 23) return false
  if (!Number.isFinite(allowedEndHour) || allowedEndHour < 0 || allowedEndHour > 24) return false
  if (allowedStartHour === 0 && allowedEndHour === 24) return true
  if (allowedStartHour === allowedEndHour) return false
  if (allowedStartHour < allowedEndHour) {
    return hour >= allowedStartHour && hour < allowedEndHour
  }
  return hour >= allowedStartHour || hour < allowedEndHour
}

export function canUseAdminSession(now: number, expiresAt: number | undefined): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now
}
