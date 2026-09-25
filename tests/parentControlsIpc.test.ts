import { beforeEach, describe, it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  send: vi.fn(), writeSettings: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] },
}))
vi.mock('../src/main/fileStore', () => ({
  readSettings: () => ({ adminPasswordHash: 'private', weekdayLimit: 60 }),
  writeSettings: mocks.writeSettings, readSessions: () => [], readDailyUsage: () => null, writeDailyUsage: vi.fn(),
}))
import { registerIpcHandlers } from '../src/main/ipc'
import { clearAdminSession } from '../src/main/adminAuth'
import { DEFAULT_PUBLIC_SETTINGS } from '../src/shared/types'
const event = { sender: { id: 41 } }
beforeEach(() => { clearAdminSession(41); clearAdminSession(42); vi.clearAllMocks(); mocks.handlers.clear() })
describe('parent control IPC boundary', () => {
  it('requires PIN before editing, broadcasts authoritative policy and locks only this renderer', async () => {
    const saved = { ...DEFAULT_PUBLIC_SETTINGS, weekdayLimit: 120, weekdaySessionCount: 0 }
    const protect = vi.fn(async () => {})
    const revoke = vi.fn(async () => {})
    registerIpcHandlers({ verifyAdminPin: async (pin) => pin === '1234', revokeAdminPin: revoke, protectLocalPolicy: protect, readPublicSettings: () => saved })
    const invoke = (name: string, payload?: any) => mocks.handlers.get(name)!(event, payload)
    expect(await invoke('admin:is-unlocked')).toBe(false)
    await expect(invoke('settings:write', saved)).rejects.toThrow('authorization')
    expect(protect).not.toHaveBeenCalled()
    expect(await invoke('admin:unlock-settings', { pin: '1234' })).toBe(true)
    expect(await invoke('admin:is-unlocked')).toBe(true)
    expect(await invoke('settings:write', saved)).toEqual(saved)
    expect(mocks.send).toHaveBeenCalledWith('settings:changed', saved)
    await expect(mocks.handlers.get('admin:is-unlocked')!({ sender: { id: 42 } })).resolves.toBe(false)
    await invoke('admin:lock')
    expect(revoke).toHaveBeenCalledOnce()
    await expect(invoke('settings:write', saved)).rejects.toThrow('authorization')
  })
  it('does not report successful approval when PIN passes but the next launch cannot be authorized', async () => {
    const approve = vi.fn(async () => false)
    registerIpcHandlers({ verifyAdminPin: async (pin) => pin === '1234', approveNextSession: approve })
    const invoke = (pin: string) => mocks.handlers.get('admin:approve-next-session')!(event, { pin })
    expect(await invoke('0000')).toMatchObject({ ok: false, reason: 'invalid-pin' })
    expect(approve).not.toHaveBeenCalled()
    expect(await invoke('1234')).toMatchObject({ ok: false, reason: 'start-unavailable' })
    approve.mockResolvedValue(true)
    expect(await invoke('1234')).toMatchObject({ ok: true, preauthorizedNextLaunch: true })
  })
  it('does not reopen a hidden parent screen when PIN verification finishes after locking', async () => {
    let finishVerification!: (ok: boolean) => void
    const pending = new Promise<boolean>((resolve) => { finishVerification = resolve })
    const revoke = vi.fn(async () => {})
    registerIpcHandlers({ verifyAdminPin: () => pending, revokeAdminPin: revoke })
    const unlock = mocks.handlers.get('admin:unlock-settings')!(event, { pin: '1234' })
    await mocks.handlers.get('admin:lock')!(event)
    finishVerification(true)
    await expect(unlock).resolves.toBe(false)
    await expect(mocks.handlers.get('admin:is-unlocked')!(event)).resolves.toBe(false)
    expect(revoke).toHaveBeenCalledTimes(2)
  })
})
