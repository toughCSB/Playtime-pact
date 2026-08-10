import { contextBridge, ipcRenderer } from 'electron'
import type {
  AdminApprovalResult,
  DailyRemaining,
  ManagedGameEventPayload,
  PairingSession,
  ParentDevice,
  PublicSettings,
  RemoteApprovalHealth,
  RemoteApprovalRequest,
  RemoteApprovalState,
  Session,
  TimerStartResult,
  TimerStatus,
} from '../shared/types'


const api = {
  readSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:read'),
  writeSettings: (s: PublicSettings): Promise<PublicSettings> => ipcRenderer.invoke('settings:write', s),
  readSessions: (): Promise<Session[]> => ipcRenderer.invoke('sessions:read'),

  startTimer: (limitMinutes: number): Promise<TimerStartResult> =>
    ipcRenderer.invoke('timer:start', { limitMinutes }),
  minimizeMainWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize-main'),
  hideMainWindow: (): Promise<void> => ipcRenderer.invoke('window:hide-main'),
  hideMainWindowNow: (): void => ipcRenderer.send('window:hide-main-now'),
  showMainWindow: (): Promise<void> => ipcRenderer.invoke('window:show-main'),

  timerGetStatus: (): Promise<TimerStatus> =>
    ipcRenderer.invoke('timer:get-status'),
  timerAdjustTime: (minutes: number): Promise<{ remainingSeconds: number }> =>
    ipcRenderer.invoke('timer:adjust-time', { minutes }),
  timerAdminStop: (): Promise<void> => ipcRenderer.invoke('timer:admin-stop'),

  adminVerifyPassword: (pin: string): Promise<boolean> =>
    ipcRenderer.invoke('admin:verify-password', { pin }),
  adminUnlockSettings: (pin: string): Promise<boolean> =>
    ipcRenderer.invoke('admin:unlock-settings', { pin }),
  adminApproveNextSession: (pin: string): Promise<AdminApprovalResult> =>
    ipcRenderer.invoke('admin:approve-next-session', { pin }),
  adminChangePassword: (currentPin: string, newPin: string): Promise<void> =>
    ipcRenderer.invoke('admin:change-password', { currentPin, newPin }),
  adminCloseWindow: (): Promise<void> => ipcRenderer.invoke('admin:close-window'),
  adminGetResumeOption: (): Promise<boolean> => ipcRenderer.invoke('admin:get-resume-option'),
  adminSetResumeOption: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('admin:set-resume-option', { enabled }),
  shutdownApp: (): Promise<void> => ipcRenderer.invoke('app:shutdown'),

  dailyGetRemaining: (): Promise<DailyRemaining> =>
    ipcRenderer.invoke('daily:get-remaining'),
  remoteGetState: (): Promise<RemoteApprovalState> => ipcRenderer.invoke('remote:get-state'),
  remoteCreateRequest: (gameId: 'minecraft' | 'roblox'): Promise<RemoteApprovalRequest> =>
    ipcRenderer.invoke('remote:create-request', { gameId }),
  remoteCreatePairingSession: (): Promise<PairingSession & { uri: string }> =>
    ipcRenderer.invoke('remote:create-pairing-session'),
  remoteRevokeParent: (parentDeviceId: ParentDevice['parentDeviceId']): Promise<void> =>
    ipcRenderer.invoke('remote:revoke-parent', { parentDeviceId }),
  remoteResetMembership: (): Promise<void> => ipcRenderer.invoke('remote:reset-membership'),
  remoteDeleteHousehold: (): Promise<void> => ipcRenderer.invoke('remote:delete-household'),
  remoteHealth: (): Promise<RemoteApprovalHealth> => ipcRenderer.invoke('remote:health'),

  onTimerTick: (cb: (d: { remainingSeconds: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: { remainingSeconds: number }) => cb(d)
    ipcRenderer.on('timer:tick', handler)
    return () => ipcRenderer.removeListener('timer:tick', handler)
  },
  onTimerWarning: (cb: (d: { minutesLeft: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: { minutesLeft: number }) => cb(d)
    ipcRenderer.on('timer:warning', handler)
    return () => ipcRenderer.removeListener('timer:warning', handler)
  },
  onTimerExpired: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on('timer:expired', handler)
    return () => ipcRenderer.removeListener('timer:expired', handler)
  },
  onTimerTerminationFailed: (cb: (d: { message: string; remainingGameIds: string[] }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: { message: string; remainingGameIds: string[] }) => cb(d)
    ipcRenderer.on('timer:termination-failed', handler)
    return () => ipcRenderer.removeListener('timer:termination-failed', handler)
  },
  onTimerMode: (cb: (d: { mode: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: { mode: string }) => cb(d)
    ipcRenderer.on('timer:mode', handler)
    return () => ipcRenderer.removeListener('timer:mode', handler)
  },
  onTimerResumed: (cb: (d: { remainingSeconds: number }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: { remainingSeconds: number }) => cb(d)
    ipcRenderer.on('timer:resumed', handler)
    return () => ipcRenderer.removeListener('timer:resumed', handler)
  },
  onTimerAdminStopped: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on('timer:admin-stopped', handler)
    return () => ipcRenderer.removeListener('timer:admin-stopped', handler)
  },
  onSupportedGameDetected: (cb: (d: ManagedGameEventPayload) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: ManagedGameEventPayload) => cb(d)
    ipcRenderer.on('game:detected', handler)
    return () => ipcRenderer.removeListener('game:detected', handler)
  },
  onSupportedGameClosed: (cb: (d: ManagedGameEventPayload) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: ManagedGameEventPayload) => cb(d)
    ipcRenderer.on('game:closed', handler)
    return () => ipcRenderer.removeListener('game:closed', handler)
  },
  onSupportedGameBlocked: (cb: (d: ManagedGameEventPayload & { reason: 'outside-hours' | 'daily-exhausted' | 'approval-required'; message: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, d: ManagedGameEventPayload & { reason: 'outside-hours' | 'daily-exhausted' | 'approval-required'; message: string }) => cb(d)
    ipcRenderer.on('game:blocked', handler)
    return () => ipcRenderer.removeListener('game:blocked', handler)
  },
}

contextBridge.exposeInMainWorld('api', api)
