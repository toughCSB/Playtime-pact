/// <reference types="vite/client" />

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
} from '../../shared/types'


declare global {
  const __APP_VERSION__: string

  interface Window {
    api?: {
      readSettings(): Promise<PublicSettings>
      writeSettings(s: PublicSettings): Promise<PublicSettings>
      readSessions(): Promise<Session[]>

      startTimer(limitMinutes: number): Promise<TimerStartResult>
      minimizeMainWindow(): Promise<void>
      hideMainWindow(): Promise<void>
      hideMainWindowNow(): void
      showMainWindow(): Promise<void>

      timerGetStatus(): Promise<TimerStatus>
      timerAdjustTime(minutes: number): Promise<{ remainingSeconds: number }>
      timerAdminStop(): Promise<void>

      adminVerifyPassword(pin: string): Promise<boolean>
      adminUnlockSettings(pin: string): Promise<boolean>
      adminApproveNextSession(pin: string): Promise<AdminApprovalResult>
      adminChangePassword(currentPin: string, newPin: string): Promise<void>
      adminCloseWindow(): Promise<void>
      adminGetResumeOption(): Promise<boolean>
      adminSetResumeOption(enabled: boolean): Promise<void>
      shutdownApp(): Promise<void>

      dailyGetRemaining(): Promise<DailyRemaining>
      remoteGetState(): Promise<RemoteApprovalState>
      remoteCreateRequest(gameId: 'minecraft' | 'roblox'): Promise<RemoteApprovalRequest>
      remoteCreatePairingSession(): Promise<PairingSession & { uri: string }>
      remoteRevokeParent(parentDeviceId: ParentDevice['parentDeviceId']): Promise<void>
      remoteResetMembership(): Promise<void>
      remoteDeleteHousehold(): Promise<void>
      remoteHealth(): Promise<RemoteApprovalHealth>

      onTimerTick(cb: (d: { remainingSeconds: number }) => void): () => void
      onTimerWarning(cb: (d: { minutesLeft: number }) => void): () => void
      onTimerExpired(cb: () => void): () => void
      onTimerTerminationFailed(cb: (d: { message: string; remainingGameIds: string[] }) => void): () => void
      onTimerMode(cb: (d: { mode: string }) => void): () => void
      onTimerResumed(cb: (d: { remainingSeconds: number }) => void): () => void
      onTimerAdminStopped(cb: () => void): () => void
      onSupportedGameDetected(cb: (d: ManagedGameEventPayload) => void): () => void
      onSupportedGameClosed(cb: (d: ManagedGameEventPayload) => void): () => void
      onSupportedGameBlocked(cb: (d: ManagedGameEventPayload & { reason: 'outside-hours' | 'daily-exhausted' | 'approval-required'; message: string }) => void): () => void
    }
  }
}
