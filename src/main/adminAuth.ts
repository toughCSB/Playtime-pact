import type { IpcMainInvokeEvent } from 'electron'
import { canUseAdminSession } from '../shared/policy'

const ADMIN_SESSION_MS = 5 * 60 * 1000
const adminSessions = new Map<number, number>()

export function grantAdminSession(event: IpcMainInvokeEvent, now = Date.now()): void {
  adminSessions.set(event.sender.id, now + ADMIN_SESSION_MS)
}

export function requireAdminSession(event: IpcMainInvokeEvent, now = Date.now()): void {
  if (!canUseAdminSession(now, adminSessions.get(event.sender.id))) {
    throw new Error('admin authorization required')
  }
}

export function clearAdminSession(webContentsId: number): void {
  adminSessions.delete(webContentsId)
}
