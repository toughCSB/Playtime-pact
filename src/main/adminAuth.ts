import type { IpcMainInvokeEvent } from 'electron'
const adminSessions = new Set<number>()
const lockGenerations = new Map<number, number>()

export function adminLockGeneration(webContentsId: number): number {
  if (!lockGenerations.has(webContentsId)) lockGenerations.set(webContentsId, 0)
  return lockGenerations.get(webContentsId)!
}

export function grantAdminSession(event: IpcMainInvokeEvent, expectedGeneration = adminLockGeneration(event.sender.id)): boolean {
  if (adminLockGeneration(event.sender.id) !== expectedGeneration) return false
  adminSessions.add(event.sender.id)
  return true
}

export function requireAdminSession(event: IpcMainInvokeEvent): void {
  if (!adminSessions.has(event.sender.id)) {
    throw new Error('admin authorization required')
  }
}

export function hasAdminSession(event: IpcMainInvokeEvent): boolean {
  return adminSessions.has(event.sender.id)
}

export function clearAdminSession(webContentsId: number): void {
  adminSessions.delete(webContentsId)
  lockGenerations.set(webContentsId, adminLockGeneration(webContentsId) + 1)
}

export function clearAllAdminSessions(): void {
  for (const id of lockGenerations.keys()) clearAdminSession(id)
}
