export type ManagedGameId = 'minecraft' | 'roblox'
export interface RemoteApprovalPermissionTuple {
  householdId: string
  requestId: string
  pcId: string
  gameId: string
  allowanceVersion: number
  processId: string
  processStartedAt: number
}
export interface RemoteApprovalAllowanceReservation {
  reservationId: string
  householdId: string
  requestId: string
  pcId: string
  gameId: string
  allowanceVersion: number
  reservedMinutes: number
  reservedAt: number
  expiresAt: number
}


export interface RemoteApprovalRequest {
  requestId: string
  householdId: string
  pcId: string
  gameId: string
  allowanceVersion: number
  processId: string
  processStartedAt: number
  membershipEpoch: number
  serviceEpoch: number
  requestedAt: number
  expiresAt: number
}

export interface RemoteApprovalGrant {
  grantId: string
  allowanceReservationId: string
  householdId: string
  requestId: string
  pcId: string
  gameId: string
  allowanceVersion: number
  processId: string
  processStartedAt: number
  membershipEpoch: number
  serviceEpoch: number
  approvedMinutes: number
  grantedAt: number
  expiresAt: number
  launchGame: false
}

export type RemoteApprovalLifecycleState =
  | 'offline'
  | 'connecting'
  | 'online'
  | 'request-pending'
  | 'approved'
  | 'expired'
  | 'revoked'
  | 'error'

export interface ProtectedAccountingScope {
  householdId: string
  pcId: string
  gameId: string
  ianaTimeZone: string
  ianaDay: string
  allowanceVersion: number
  totalMs: number
}
export interface ProtectedAccountingHighWater {
  totalMs: number
  committedMs: number
  reservedMs: number
  version: number
}
export interface RemoteApprovalAllowance {
  pcId: string
  gameId: string
  ianaTimeZone: string
  ianaDay: string
  allowanceVersion: number
  totalSeconds: number
  committedSeconds: number
  reservedSeconds: number
}

export interface RemoteApprovalState {
  lifecycle: RemoteApprovalLifecycleState
  householdId?: string
  pcId?: string
  membershipEpoch?: number
  serviceEpoch?: number
  request?: RemoteApprovalRequest
  grant?: RemoteApprovalGrant
  parentDevices?: ParentDevice[]
  allowance?: RemoteApprovalAllowance
  updatedAt: number
}

export interface PairingSession {
  pairingSessionId: string
  householdId: string
  pcId: string
  membershipEpoch: number
  serviceEpoch: number
  createdAt: number
  expiresAt: number
  state: 'pending' | 'paired' | 'expired' | 'cancelled'
}

export interface ParentDevice {
  parentDeviceId: string
  householdId: string
  displayName: string
  membershipEpoch: number
  registeredAt: number
  lastSeenAt?: number
}

export interface RemoteApprovalHealth {
  lifecycle: Extract<RemoteApprovalLifecycleState, 'offline' | 'connecting' | 'online' | 'error'>
  serviceEpoch: number
  checkedAt: number
  lastOnlineAt?: number
}

export interface MemoryOnlyLocalPreauthorization {
  grantId: string
  permission: RemoteApprovalPermissionTuple
  membershipEpoch: number
  serviceEpoch: number
  expiresAt: number
  claimed: boolean
  bindFirstProcess?: boolean
}

export interface FirstProcessClaimInput {
  preauthorization: MemoryOnlyLocalPreauthorization
  permission: RemoteApprovalPermissionTuple
  serverTime: number
  membershipEpoch: number
  serviceEpoch: number
}

export interface FirstProcessClaimResult {
  claimed: boolean
  preauthorization: MemoryOnlyLocalPreauthorization
}

export type TimerBlockedReason =
  | 'outside-hours'
  | 'invalid-limit'
  | 'approval-required'
  | 'managed-game-not-running'

export interface Settings {
  weekdayLimit: number           // 세션당 허용 시간 (분)
  weekendLimit: number
  weekdaySessionCount: number    // 평일 하루 최대 세션 수
  weekendSessionCount: number    // 주말 하루 최대 세션 수
  allowedStartHour: number
  allowedEndHour: number
  adminPasswordHash: string
  resumeTimerOnRestart: boolean
  requireApprovalBeforeStart: boolean // 새 게임 타임 시작 전 부모 PIN 승인 필요
  updatedAt: string
}

export interface Session {
  id: string
  gameId: ManagedGameId
  date: string
  startTime: string
  endTime: string
  duration: number
  limitAtSession: number
  primaryGameId?: ManagedGameId
  activeGameIds?: ManagedGameId[]
  presenceSpans?: GamePresenceSpan[]
  primarySelectionEvents?: PrimarySelectionEvent[]
  terminated: boolean
}


export interface TimerState {
  startTime: number        // Date.now() at timer start
  limitMs: number          // total limit in ms
  date: string             // YYYY-MM-DD — 날짜 다르면 무효
  pausedRemainingMs?: number  // 일시정지 시 잔여 ms 스냅샷
  sessionStartTime?: string
  limitAtSession?: number
  primaryGameId?: ManagedGameId
  activeGameIds?: ManagedGameId[]
  presenceSpans?: GamePresenceSpan[]
  primarySelectionEvents?: PrimarySelectionEvent[]
}


export type PublicSettings = Omit<Settings, 'adminPasswordHash'>

export interface DailyUsage {
  date: string
  sessionsCompleted: number      // 타이머가 만료된 완료 세션 수
  currentSessionRemainingMs: number  // 현재 진행/일시정지 중인 세션의 잔여 ms (0이면 없음)
}

export interface GamePresenceSpan {
  gameId: ManagedGameId
  startedAt: string
  endedAt?: string
  terminationReason?: 'closed' | 'expired' | 'admin-stop'
}

export interface PrimarySelectionEvent {
  gameId: ManagedGameId
  selectedAt: string
}

export interface QuotaWindow {
  id: string
  date: string
  startedAt: string
  endedAt?: string
  remainingMs: number
  limitAtSession: number
  primaryGameId?: ManagedGameId
  activeGameIds: ManagedGameId[]
  presenceSpans: GamePresenceSpan[]
  primarySelectionEvents: PrimarySelectionEvent[]
  terminated: boolean
}

export interface TimerStartResult {
  resumed: boolean
  remainingSeconds: number
  exhausted?: boolean
  blocked?: TimerBlockedReason
}

export interface AdminApprovalResult {
  ok: boolean
  launchedPendingGame: boolean
  preauthorizedNextLaunch?: boolean
}

export interface ManagedGameEventPayload {
  gameId: ManagedGameId
  primaryGameId?: ManagedGameId
  activeGameIds: ManagedGameId[]
  secondaryGameIds?: ManagedGameId[]
}

export interface TimerStatus {
  running: boolean
  remainingSeconds: number
  mode?: 'corner' | 'center-popup' | 'center-countdown' | 'shutdown'
  primaryGameId?: ManagedGameId
  activeGameIds?: ManagedGameId[]
}

export interface DailyRemaining {
  remainingSeconds: number
  exhausted: boolean
  totalSeconds: number
  sessionsCompleted: number
  sessionsPerDay: number
  currentSessionActive: boolean
}

// SHA-256('0000')
const DEFAULT_PASSWORD_HASH = '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0'

export const DEFAULT_SETTINGS: Settings = {
  weekdayLimit: 60,
  weekendLimit: 60,
  weekdaySessionCount: 1,
  weekendSessionCount: 1,
  allowedStartHour: 16,
  allowedEndHour: 22,
  adminPasswordHash: DEFAULT_PASSWORD_HASH,
  resumeTimerOnRestart: true,
  requireApprovalBeforeStart: true,
  updatedAt: new Date().toISOString(),
}

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  weekdayLimit: 60,
  weekendLimit: 60,
  weekdaySessionCount: 1,
  weekendSessionCount: 1,
  allowedStartHour: 16,
  allowedEndHour: 22,
  resumeTimerOnRestart: true,
  requireApprovalBeforeStart: true,
  updatedAt: new Date().toISOString(),
}
