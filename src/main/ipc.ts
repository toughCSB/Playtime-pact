import { ipcMain } from 'electron'

import {
  readSettings,
  writeSettings,
  readSessions,
  readDailyUsage,
  writeDailyUsage,
} from './fileStore'
import { grantAdminSession, requireAdminSession } from './adminAuth'

import { redactSettings } from '../shared/policy'
import { isDailyUsageExhausted, normalizeDailyUsage, shouldPersistNormalizedDailyUsage } from '../shared/dailyUsage'
import type { DailyRemaining, PublicSettings, RemoteApprovalRequest, RemoteApprovalState } from '../shared/types'
import { RemoteApprovalController } from './remoteApproval/controller'

const MAX_PIN_ATTEMPTS = 5
const PIN_LOCK_MS = 30_000

type PinThrottle = { attempts: number; lockedUntil: number }
let pinThrottle: PinThrottle = { attempts: 0, lockedUntil: 0 }

function assertPinAllowed(): void {
  if (pinThrottle.lockedUntil > Date.now()) throw new Error('too many attempts')
}

function recordPinAttempt(ok: boolean): void {
  if (ok) {
    pinThrottle = { attempts: 0, lockedUntil: 0 }
    return
  }
  const now = Date.now()
  const attempts = pinThrottle.lockedUntil <= now ? pinThrottle.attempts + 1 : pinThrottle.attempts
  pinThrottle = {
    attempts,
    lockedUntil: attempts >= MAX_PIN_ATTEMPTS ? now + PIN_LOCK_MS : 0,
  }
}

async function verifyAdminPin(pin: string, verify?: (pin: string) => Promise<boolean>): Promise<boolean> {
  assertPinAllowed()
  if (!/^\d{4}$/.test(pin)) {
    recordPinAttempt(false)
    return false
  }
  const ok = verify ? await verify(pin) : false
  recordPinAttempt(ok)
  return ok
}

function getLocalDateString(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}


export function registerIpcHandlers(callbacks: {
  readPublicSettings?: () => PublicSettings
  readDailyRemaining?: () => Promise<DailyRemaining>
  approveNextSession?: () => Promise<boolean>
  verifyAdminPin?: (pin: string) => Promise<boolean>
  changeAdminPin?: (newPin: string) => Promise<void>
  protectLocalPolicy?: (settings: PublicSettings) => Promise<void>
  remote?: {
    getState: () => RemoteApprovalState
    createRequest: (input: { gameId: string }) => Promise<RemoteApprovalRequest>
    controller: RemoteApprovalController
  }
} = {}): void {
  ipcMain.handle('settings:read', async () => callbacks.readPublicSettings?.() ?? redactSettings(readSettings()))

  ipcMain.handle('settings:write', async (event, settings: PublicSettings) => {
    requireAdminSession(event)
    const current = readSettings()
    if (!callbacks.protectLocalPolicy) throw new Error('protected local policy unavailable')
    await callbacks.protectLocalPolicy(settings)
    writeSettings({ ...current, ...settings, adminPasswordHash: current.adminPasswordHash })
    return redactSettings(readSettings())
  })

  ipcMain.handle('sessions:read', async () => readSessions())


  ipcMain.handle('admin:verify-password', async (event, { pin }: { pin: string }) => {
    const ok = await verifyAdminPin(pin, callbacks.verifyAdminPin)
    if (ok) grantAdminSession(event)
    return ok
  })

  ipcMain.handle('admin:unlock-settings', async (event, { pin }: { pin: string }) => {
    const ok = await verifyAdminPin(pin, callbacks.verifyAdminPin)
    if (ok) grantAdminSession(event)
    return ok
  })

  ipcMain.handle('admin:approve-next-session', async (_event, { pin }: { pin: string }) => {
    const ok = await verifyAdminPin(pin, callbacks.verifyAdminPin)
    const preauthorizedNextLaunch = ok && await callbacks.approveNextSession?.() === true
    return { ok, launchedPendingGame: false, preauthorizedNextLaunch }
  })

  ipcMain.handle('admin:change-password', async (event, { currentPin, newPin }: { currentPin: string; newPin: string }) => {
    requireAdminSession(event)
    if (!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) throw new Error('invalid pin')
    if (!(await verifyAdminPin(currentPin, callbacks.verifyAdminPin))) throw new Error('invalid current password')
    if (!callbacks.changeAdminPin) throw new Error('protected broker unavailable')
    await callbacks.changeAdminPin(newPin)
  })

  ipcMain.handle('admin:set-resume-option', async (event, { enabled }: { enabled: boolean }) => {
    requireAdminSession(event)
    const settings = readSettings()
    settings.resumeTimerOnRestart = enabled
    settings.updatedAt = new Date().toISOString()
    writeSettings(settings)
  })

  // 오늘 남은 세션 정보 조회
  ipcMain.handle('daily:get-remaining', async (): Promise<DailyRemaining> => {
    if (callbacks.readDailyRemaining) return callbacks.readDailyRemaining()
    const today = getLocalDateString()
    const storedUsage = readDailyUsage()
    const usage = normalizeDailyUsage({
      storedUsage,
      sessions: readSessions(),
      dateKey: today,
    })
    if (shouldPersistNormalizedDailyUsage(storedUsage, usage)) {
      try {
        writeDailyUsage(usage)
      } catch (err) {
        console.error('daily-usage normalization write failed; returning recovered usage', err)
      }
    }
    const settings = readSettings()
    const dow = new Date().getDay()
    const isWeekend = dow === 0 || dow === 6
    const perSessionMinutes = isWeekend ? settings.weekendLimit : settings.weekdayLimit
    const sessionsPerDay = isWeekend ? settings.weekendSessionCount : settings.weekdaySessionCount

    const exhausted = isDailyUsageExhausted(usage, sessionsPerDay)

    // 표시할 남은 시간: 진행 중인 세션이 있으면 그 잔여 시간, 없으면 세션 한 번의 전체 시간
    const remainingSeconds = usage.currentSessionRemainingMs > 0
      ? Math.ceil(usage.currentSessionRemainingMs / 1000)
      : perSessionMinutes * 60

    return {
      remainingSeconds: exhausted ? 0 : remainingSeconds,
      exhausted,
      totalSeconds: perSessionMinutes * 60,
      sessionsCompleted: usage.sessionsCompleted,
      sessionsPerDay,
      currentSessionActive: usage.currentSessionRemainingMs > 0,
    }
  })

  ipcMain.handle('remote:get-state', async () => callbacks.remote?.getState() ?? { lifecycle: 'offline', updatedAt: Date.now() })
  ipcMain.handle('remote:create-request', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object' || !['minecraft', 'roblox'].includes(String((payload as { gameId?: unknown }).gameId))) throw new Error('invalid remote request')
    if (!callbacks.remote) throw new Error('remote approval unavailable')
    return callbacks.remote.createRequest({ gameId: String((payload as { gameId: string }).gameId) })
  })
  ipcMain.handle('remote:create-pairing-session', async (event) => {
    requireAdminSession(event)
    if (!callbacks.remote) throw new Error('remote approval unavailable')
    return callbacks.remote.controller.createPairingSession()
  })
  ipcMain.handle('remote:revoke-parent', async (event, payload: unknown) => {
    requireAdminSession(event)
    const parentDeviceId = payload && typeof payload === 'object' ? (payload as { parentDeviceId?: unknown }).parentDeviceId : undefined
    if (typeof parentDeviceId !== 'string' || parentDeviceId.length === 0) throw new Error('invalid parent device')
    if (!callbacks.remote) throw new Error('remote approval unavailable')
    await callbacks.remote.controller.revokeParent(parentDeviceId)
  })
  ipcMain.handle('remote:reset-membership', async (event) => {
    requireAdminSession(event)
    if (!callbacks.remote) throw new Error('remote approval unavailable')
    await callbacks.remote.controller.resetMembership()
  })
  ipcMain.handle('remote:delete-household', async (event) => {
    requireAdminSession(event)
    if (!callbacks.remote) throw new Error('remote approval unavailable')
    await callbacks.remote.controller.deleteHousehold()
  })
  ipcMain.handle('remote:health', async () => callbacks.remote?.controller.health() ?? { lifecycle: 'offline', serviceEpoch: 1, checkedAt: Date.now() })
}
