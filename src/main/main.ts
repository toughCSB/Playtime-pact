import { app, BrowserWindow, ipcMain, screen, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { exec, execFileSync, spawn } from 'child_process'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { registerIpcHandlers } from './ipc'
import { RemoteApprovalController } from './remoteApproval/controller'
import { ServerClock } from './remoteApproval/serverClock'
import { RemoteStartCoordinator } from './remoteApproval/startCoordinator'
import { RemoteApprovalApiClient } from './remoteApproval/apiClient'
import { PRIVILEGED_PIPE, PrivilegedApprovalService, PrivilegedBrokerClient, namedPipeTransport, startPrivilegedPipeServer, type ProtectedLocalPolicy } from './remoteApproval/privilegedService'
import { formatPrivilegedHealthDiagnostic } from './remoteApproval/privilegedHealthDiagnostic'
import { loadRemoteApprovalRuntimeConfig, RemoteApprovalConfigError, remoteMutableStatePath, WindowsCngRemoteApprovalBroker, type RemoteApprovalRuntimeConfig } from './remoteApproval/runtimeBroker'
import { requireAdminSession } from './adminAuth'
import {
  readSettings, writeTimerState, clearTimerState, readTimerState,
  appendSession, readSessions,
} from './fileStore'
import { isHourAllowed } from '../shared/policy'
import { shouldRequireApprovalForStart } from '../shared/startPolicy'
import { shouldBlockTimerStartWithoutSupportedGame, shouldPauseTimerWhenSupportedGameMissing } from '../shared/robloxSync'
import { listSecondaryManagedGames, selectPrimaryManagedGame, type ManagedGameSnapshot } from '../shared/managedGames'
import { normalizeTimerAdjustmentMinutes } from '../shared/timerAdjust'
import { decideStartupWindowAction, shouldStartHiddenFromLaunch } from '../shared/startupVisibility'
import { isDailyUsageExhausted, normalizeDailyUsage, shouldPersistNormalizedDailyUsage } from '../shared/dailyUsage'
import { getManagedGameSnapshot, getManagedGameSnapshotCapture, terminateSupportedGames, isManagedGameTerminationInFlight } from './managedGameRuntime'
import type { DailyUsage, GamePresenceSpan, ManagedGameId, PrimarySelectionEvent, ProtectedAccountingScope, RemoteApprovalPermissionTuple, RemoteApprovalRequest, Session, TimerState } from '../shared/types'
import {
  ADMIN_WINDOW_PROFILE,
  getCornerOverlayGeometry,
  getFullPageWindowGeometry,
  getWarningOverlayGeometry,
  MAIN_WINDOW_PROFILE,
} from './windowGeometry'


const privilegedServiceMode = process.argv.includes('--privileged-broker-service')
const privilegedHealthCheckMode = process.argv.includes('--privileged-broker-health-check')
const privilegedConfigCheckMode = process.argv.includes('--privileged-broker-config-check')
const initializeLocalProtectionMode = process.argv.includes('--initialize-local-protection')
const protectionReadinessMode = process.argv.includes('--protection-readiness-check')
const hasSingleInstanceLock = privilegedServiceMode || privilegedHealthCheckMode || privilegedConfigCheckMode || initializeLocalProtectionMode || protectionReadinessMode || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let adminWindow: BrowserWindow | null = null
let tray: Tray | null = null
let allowQuit = false
type MainWindowPresentation =
  | 'inactive-full-page'
  | 'active-overlay'
  | 'shutdown-overlay'
  | 'blocked-failure-overlay'
  | 'hidden-inactive'

type BlockedFailureContext = {
  reason: 'outside-hours' | 'daily-exhausted' | 'approval-required'
  gameId?: ManagedGameId
}

let mainWindowPresentation: MainWindowPresentation = 'hidden-inactive'
let blockedFailureContext: BlockedFailureContext | null = null
let gameTerminationPending = false
let gameTerminationAttemptFinished = false
let timerAdjustmentInFlight = false
let deferredClosedGameId: ManagedGameId | null = null
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  showMainWindowForCurrentPresentation(mainWindow)
  mainWindow.focus()
})
function broadcastTimerTick(remainingSeconds: number): void {
  const payload = { remainingSeconds }
  mainWindow?.webContents.send('timer:tick', payload)
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.webContents.send('timer:tick', payload)
  }
}

let timerStart: number | null = null
let timerLimitMs: number | null = null
let timerStartReceipt: string | undefined
let timerSessionStartTime = ''
let timerLimitAtSession = 0
let timerInterval: ReturnType<typeof setInterval> | null = null
const warnedMinutes = new Set<number>()
let inCenterMode = false
let timerUiMode: 'corner' | 'center-popup' | 'center-countdown' | 'shutdown' = 'corner'
let lastCornerOverlayBounds: Electron.Rectangle | null = null
let centerPopupEpoch = 0

let trayClicks: number[] = []
let trayClickTimer: ReturnType<typeof setTimeout> | null = null

let managedGameDetectInterval: ReturnType<typeof setInterval> | null = null
let activeManagedGameIds: ManagedGameId[] = []
let primaryManagedGameId: ManagedGameId | null = null
let lastManagedGameBlockedReason = ''
let managedGameLastDetectedAt: Partial<Record<ManagedGameId, number>> = {}
const observedProcessStartedAt = new Map<number, number>()

let timerDisplay: Electron.Display | null = null
let volatileDailyUsage: DailyUsage | null = null
const startHidden = shouldStartHiddenFromLaunch({ argv: process.argv, isPackaged: app.isPackaged })
let managedGameBaselineCaptured = false
const privilegedBroker = new PrivilegedBrokerClient(namedPipeTransport(PRIVILEGED_PIPE))
const remoteApprovalClient = new RemoteApprovalApiClient(privilegedBroker)
type RemoteRelaunchFence = {
  requestId: string
  gameId: ManagedGameId
  originalProcessId: string
  originalProcessStartedAt: number
  expiresAt: number
  armed: boolean
  claimedProcessId?: string
  claimedProcessStartedAt?: number
}
// Provisioned configuration is protected and read-only to this account; all mutable
// runtime state goes to the separate per-user directory it declares.
type ProvisionedRemoteConfigState =
  | { config: RemoteApprovalRuntimeConfig | null; error: null }
  | { config: null; error: RemoteApprovalConfigError }
const provisionedRemoteConfigState: ProvisionedRemoteConfigState = (() => {
  try {
    return { config: loadRemoteApprovalRuntimeConfig(), error: null }
  } catch (cause) {
    const error = cause instanceof RemoteApprovalConfigError
      ? cause
      : new RemoteApprovalConfigError('CONFIG_UNREADABLE', process.env.PLAYTIME_PACT_REMOTE_CONFIG ?? 'protected discovery', cause)
    return { config: null, error }
  }
})()
const provisionedRemoteConfig = provisionedRemoteConfigState.config
function bootstrapPrivilegedMembership(): Promise<RemoteApprovalRuntimeConfig['membership']> {
  if (provisionedRemoteConfigState.error) return Promise.reject(provisionedRemoteConfigState.error)
  return Promise.resolve(provisionedRemoteConfig
    ? { ...provisionedRemoteConfig.membership }
    : { householdId: 'local-only', pcId: 'local-pc', membershipEpoch: 1, serviceEpoch: 1 })
}
const REMOTE_RELAUNCH_FENCE_PATH = remoteMutableStatePath(provisionedRemoteConfig, 'relaunch-fence.json')
  ?? (process.env.PLAYTIME_PACT_REMOTE_CONFIG
    ? `${process.env.PLAYTIME_PACT_REMOTE_CONFIG}.relaunch-fence.json`
    : join(app.getPath('userData'), 'remote-relaunch-fence.json'))
let remoteRelaunchFence: RemoteRelaunchFence | null = loadRemoteRelaunchFence()
const remoteServerClock = new ServerClock()
const remoteApprovalController = new RemoteApprovalController(
  remoteApprovalClient,
  10_000,
  () => Date.now(),
  persistRemoteRelaunchFenceForRequest,
  remoteServerClock,
  remoteMutableStatePath(provisionedRemoteConfig, 'intent.json')
    ?? (process.env.PLAYTIME_PACT_REMOTE_CONFIG ? `${process.env.PLAYTIME_PACT_REMOTE_CONFIG}.intent.json` : null),
  false,
)
let blockedApprovalGameId: ManagedGameId | null = null
let remoteRequestInFlight: Promise<unknown> | null = null
let accountingIntegrityFault = true
let protectedLocalPolicy: ProtectedLocalPolicy | null = null
const remoteStartCoordinator = new RemoteStartCoordinator(
  remoteApprovalClient,
  async ({ permission }) => {
    if (accountingIntegrityFault || gameTerminationPending) return false
    const snapshot = await getManagedGameSnapshot()
    return !accountingIntegrityFault && !gameTerminationPending && mainWindow !== null
      && timerStart === null
      && !remoteApprovalController.isRecoveryInProgress()
      && isAllowedHour()
      && !isSessionExhausted(getLocalDateString())
      && snapshot.classifiedProcesses.some((process) => process.gameId === permission.gameId
        && String(process.pid) === permission.processId
        && process.processStartedAt === permission.processStartedAt)
  },
  async (approvedMinutes, receipt) => {
    if (gameTerminationPending) return false
    const persisted = readTimerState()
    if ((timerStart !== null && timerStartReceipt === receipt) || persisted?.startReceipt === receipt) return true
    if (!mainWindow || timerStart !== null || remoteApprovalController.isRecoveryInProgress()) return false
    const snapshot = await getManagedGameSnapshot()
    if (!mainWindow || timerStart !== null || gameTerminationPending || remoteApprovalController.isRecoveryInProgress()) return false
    if (shouldBlockTimerStartWithoutSupportedGame(app.isPackaged, snapshot.activeGameIds.length > 0)) return false
    const startedAt = Date.now()
    const primaryGameId = selectPrimaryManagedGame(snapshot.activeGameIds, managedGameLastDetectedAt, primaryManagedGameId) ?? snapshot.activeGameIds[0]
    await persistProtectedUsage({ ...getDailyUsage(), currentSessionRemainingMs: Math.round(approvedMinutes * 60_000) }, receipt)
    if (!isAllowedHour() || accountingIntegrityFault || gameTerminationPending) return false
    writeTimerState({
      startTime: startedAt,
      limitMs: Math.round(approvedMinutes * 60_000),
      date: getLocalDateString(),
      sessionStartTime: getLocalTimeString(),
      limitAtSession: approvedMinutes,
      primaryGameId,
      activeGameIds: snapshot.activeGameIds,
      startReceipt: receipt,
    })
    blockedApprovalGameId = null
    await startTimer(mainWindow, approvedMinutes, { primaryGameId, activeGameIds: snapshot.activeGameIds, startReceipt: receipt, startTime: startedAt })
    return true
  },
  privilegedBroker,
  () => remoteApprovalController.authoritativeNow(),
  () => performance.timeOrigin + performance.now(),
  () => remoteApprovalController.getAuthoritySnapshot(),
  (permission) => {
    if (permission.householdId === 'policy' || permission.householdId === 'local-outage') {
      return localPolicyScope(permission)
    }
    const allowance = remoteApprovalController.getState().allowance
    if (allowance && allowance.pcId === permission.pcId && allowance.gameId === permission.gameId && allowance.allowanceVersion === permission.allowanceVersion) {
      return { householdId: permission.householdId, pcId: permission.pcId, gameId: permission.gameId, ianaTimeZone: allowance.ianaTimeZone, ianaDay: allowance.ianaDay, allowanceVersion: allowance.allowanceVersion, totalMs: allowance.totalSeconds * 1000 }
    }
    throw new Error('Authoritative protected allowance scope unavailable')
  },
)
let observedAuthorityGeneration: number | null = null
remoteApprovalController.subscribe((state) => {
  const authorityGeneration = remoteApprovalController.getAuthoritySnapshot()?.authorityGeneration ?? null
  if (authorityGeneration !== observedAuthorityGeneration) {
    void remoteStartCoordinator.invalidateLocalPreauthorization('remote-authority-changed')
    observedAuthorityGeneration = authorityGeneration
  }
  mainWindow?.webContents.send('remote:state', state)
  if (adminWindow && !adminWindow.isDestroyed()) adminWindow.webContents.send('remote:state', state)
})
function loadRemoteRelaunchFence(): RemoteRelaunchFence | null {
  try {
    const value = JSON.parse(readFileSync(REMOTE_RELAUNCH_FENCE_PATH, 'utf8')) as Partial<RemoteRelaunchFence>
    if (typeof value.requestId !== 'string' || (value.gameId !== 'minecraft' && value.gameId !== 'roblox')
      || typeof value.originalProcessId !== 'string' || typeof value.originalProcessStartedAt !== 'number' || !Number.isFinite(value.originalProcessStartedAt)
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || typeof value.armed !== 'boolean'
      || (value.claimedProcessId !== undefined && (typeof value.claimedProcessId !== 'string' || typeof value.claimedProcessStartedAt !== 'number' || !Number.isFinite(value.claimedProcessStartedAt)))) return null
    if (Date.now() >= value.expiresAt) { unlinkSync(REMOTE_RELAUNCH_FENCE_PATH); return null }
    return value as RemoteRelaunchFence
  } catch { return null }
}
function writeRemoteRelaunchFence(fence: RemoteRelaunchFence): void {
  const temporary = `${REMOTE_RELAUNCH_FENCE_PATH}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(fence)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, REMOTE_RELAUNCH_FENCE_PATH)
  remoteRelaunchFence = fence
}
function clearRemoteRelaunchFence(): void {
  if (existsSync(REMOTE_RELAUNCH_FENCE_PATH)) unlinkSync(REMOTE_RELAUNCH_FENCE_PATH)
  remoteRelaunchFence = null
}
function persistRemoteRelaunchFenceForRequest(request: RemoteApprovalRequest): void {
  writeRemoteRelaunchFence({
    requestId: request.requestId,
    gameId: request.gameId as ManagedGameId,
    originalProcessId: request.processId,
    originalProcessStartedAt: request.processStartedAt,
    expiresAt: request.expiresAt + 300000,
    armed: false,
  })
}
let quotaPresenceSpans: GamePresenceSpan[] = []
let quotaPrimarySelectionEvents: PrimarySelectionEvent[] = []
const COMMON_APP_DATA_DIR = process.platform === 'win32' ? 'C:\\ProgramData' : app.getPath('userData')
const WATCHDOG_DISABLED_PATH = join(COMMON_APP_DATA_DIR, 'PlaytimePact', 'watchdog-disabled.flag')
const FALLBACK_TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAB6ElEQVR4nI2SQUgUYRTHX0TdI9jd2R0NPARRLCYliLDe1Et2iDCo9KQiwSJ0CDYFPdimwmIYKOwcEiMS6RLoJaKCiKFZamfDgohaRGgCq6MwY/7j/+3OsO1uWw+Gx/f+v//73nzfJ9IgHNG/OaKDuRFXE6aEEjkJXy2b/e/I/5oPmBJyTQnhk0S/b4vubkmMkyw6onf8s4Ej+rwlYbw6HEP+8ihujaaQH7iG59op5CXCSeYbmY2XEsLGzduYnMyAMTKSUtkwVlWdOrl65iuvJYziXQM7Oz8QjcaRTt+BH5ZVUJk6OfJ/NPgiMftF90Ukk1PwvD309PSjpeUsKoN16uTIV+6u2aJhK7sSwK7rorm5DclzA6gOcuTp8xu0c6zU9WksLz8KwIUzvdh9+BjTxzuDGnVy5d9o9xu05iSC9aUVFIvbAfxz/SnsC0PoO3oCTU2nkc3eVzq5XOlGWv0Gh96L9uvj1BxM823NyOPjaXUeY2MTSidHnr7gHL6K/uDJsTbMzSzVNKgM6uTIV19jfFM0vLk0BM/zkMkYymDbH1TmmnXqm6UDjNd7C4MF0bCROA/r3iqwv4/h4ZTKXLNeKJkHG73G7s8SfWdJBM8Oalg7mVCZa9ap/9Vc1ajLEf2GI/psOXfV434Du+O1a17Rx5AAAAAASUVORK5CYII='

function getDailyUsage(): DailyUsage {
  if (!protectedLocalPolicy || accountingIntegrityFault) {
    return { date: protectedLocalPolicy ? getLocalDateString() : '', sessionsCompleted: 1000, currentSessionRemainingMs: 0 }
  }
  const today = getLocalDateString()
  if (!volatileDailyUsage || volatileDailyUsage.date !== today) {
    accountingIntegrityFault = true
    void requireProtectedPolicyReadiness().catch(handleUsagePersistenceFailure)
    return { date: today, sessionsCompleted: 1000, currentSessionRemainingMs: 0 }
  }
  const storedUsage = volatileDailyUsage
  const usage = normalizeDailyUsage({
    storedUsage,
    sessions: readSessions(),
    dateKey: today,
  })
  volatileDailyUsage = usage
  if (shouldPersistNormalizedDailyUsage(storedUsage, usage)) {
    safeWriteDailyUsage(usage)
  }
  return usage
}

function safeWriteTimerState(state: TimerState): void {
  try {
    writeTimerState(state)
  } catch (err) {
    console.error('timer-state write failed; continuing enforcement in memory', err)
  }
}

function safeClearTimerState(): void {
  try {
    clearTimerState()
  } catch (err) {
    console.error('timer-state clear failed', err)
  }
}

let usageRevision: number | null = null
let usageWriteQueue: Promise<void> = Promise.resolve()
let usageWritesPending = 0
let usageWriteGeneration = 0
function handleUsagePersistenceFailure(): void {
  const wasReady = !accountingIntegrityFault
  accountingIntegrityFault = true
  if (wasReady) console.error('protected usage persistence failed; denying starts')
  if (timerStart !== null && !gameTerminationPending) {
    void terminateSupportedGames().then((result) => {
      if (result.success) pauseTimerInternals()
      else mainWindow?.webContents.send('timer:termination-failed', { message: '사용 시간 저장에 실패했습니다. 게임을 종료할 수 없어 보호를 유지합니다.', remainingGameIds: result.remainingGameIds })
    }).catch(() => console.error('protected usage failure termination unavailable'))
  }
}
function persistProtectedUsage(usage: DailyUsage, creditReceipt?: string, running = timerStart !== null): Promise<void> {
  const snapshot = { ...usage }
  const generation = ++usageWriteGeneration
  usageWritesPending++
  volatileDailyUsage = snapshot
  const write = usageWriteQueue.then(async () => {
    if (usageRevision === null || accountingIntegrityFault) throw new Error('Protected usage not ready')
    const result = await privilegedBroker.writeDailyUsage(snapshot, usageRevision, creditReceipt, running)
    usageRevision = result.revision
    if (generation === usageWriteGeneration) volatileDailyUsage = result.usage
  }).finally(() => { usageWritesPending-- })
  usageWriteQueue = write.catch(handleUsagePersistenceFailure)
  return write
}
function safeWriteDailyUsage(usage: DailyUsage, running = timerStart !== null): void {
  void persistProtectedUsage(usage, undefined, running).catch(() => undefined)
}

function safeAppendSession(session: Omit<Session, 'id'>): void {
  try {
    appendSession(session)
  } catch (err) {
    console.error('session append failed; continuing enforcement', err)
  }
}

function disableWatchdog(): void {
  try {
    mkdirSync(join(COMMON_APP_DATA_DIR, 'PlaytimePact'), { recursive: true })
    writeFileSync(WATCHDOG_DISABLED_PATH, new Date().toISOString(), 'utf-8')
  } catch (err) {
    console.error('watchdog disable flag write failed', err)
  }
}

function stopWatchdogProcesses(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()

  const commands = [
    'schtasks /delete /tn "PlaytimePact" /f',
    'schtasks /delete /tn "MyPact" /f',
    'schtasks /delete /tn "MyPactForMyFuture" /f',
    'schtasks /delete /tn "PactWatchdog" /f',
    'reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v PlaytimePact /f',
    'reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v MyPact /f',
    'reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v MyPactForMyFuture /f',
    'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v PlaytimePact /f',
    'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v MyPact /f',
    'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq PlaytimePactWatchdog" /T',
    'taskkill /F /IM powershell.exe /FI "WINDOWTITLE eq MyPactWatchdog" /T',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq \'powershell.exe\' -or $_.Name -eq \'wscript.exe\') -and ($_.CommandLine -like \'*watch-loop.ps1*\' -or $_.CommandLine -like \'*start-watch-loop.vbs*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
  ]

  return Promise.all(commands.map((command) => new Promise<void>((resolve) => {
    exec(command, { windowsHide: true }, () => resolve())
  }))).then(() => undefined)
}

function getResourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(process.cwd(), 'resources')
}


function spawnSessionWatchdog(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  if (process.argv.includes('--no-watchdog')) return
  if (process.argv.includes('--from-watchdog')) return
  const launcherPath = join(getResourcesDir(), 'start-watch-loop.vbs')
  const watchdog = spawn('wscript.exe', ['//B', '//Nologo', launcherPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  watchdog.on('error', (err) => console.error('session watchdog spawn failed', err))
  watchdog.unref()
}

function dateTimePart(type: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'weekday', date = new Date()): string {
  const timeZone = protectedLocalPolicy?.ianaTimeZone
  if (!timeZone) throw new Error('Protected local policy unavailable')
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: type === 'year' ? 'numeric' : undefined,
    month: type === 'month' ? '2-digit' : undefined,
    day: type === 'day' ? '2-digit' : undefined,
    hour: type === 'hour' ? '2-digit' : undefined,
    minute: type === 'minute' ? '2-digit' : undefined,
    weekday: type === 'weekday' ? 'short' : undefined,
  }).formatToParts(date).find((part) => part.type === type)?.value ?? ''
}

function getLocalDateString(date = new Date()): string {
  const year = dateTimePart('year', date)
  const month = dateTimePart('month', date)
  const day = dateTimePart('day', date)
  if (!year || !month || !day) throw new Error('Protected local date unavailable')
  return `${year}-${month}-${day}`
}

function getLocalTimeString(date = new Date()): string {
  return `${dateTimePart('hour', date)}:${dateTimePart('minute', date)}`
}

function isAllowedHour(): boolean {
  if (!protectedLocalPolicy) return false
  const hour = Number(dateTimePart('hour'))
  return Number.isInteger(hour) && isHourAllowed(hour, protectedLocalPolicy.allowedStartHour, protectedLocalPolicy.allowedEndHour)
}

function getManagedGameState(): { primaryGameId?: ManagedGameId; activeGameIds: ManagedGameId[] } {
  return {
    primaryGameId: primaryManagedGameId ?? undefined,
    activeGameIds: [...activeManagedGameIds],
  }
}

function buildManagedGameEventPayload(gameId?: ManagedGameId) {
  const { primaryGameId, activeGameIds } = getManagedGameState()
  return {
    gameId: gameId ?? primaryGameId ?? activeGameIds[0] ?? 'minecraft',
    primaryGameId,
    activeGameIds,
    secondaryGameIds: listSecondaryManagedGames(primaryGameId, activeGameIds),
  }
}

function resetQuotaWindowTracking(): void {
  quotaPresenceSpans = []
  quotaPrimarySelectionEvents = []
}

function ensurePresenceSpansOpen(gameIds: readonly ManagedGameId[], startedAt = new Date().toISOString()): void {
  for (const gameId of gameIds) {
    const openSpan = quotaPresenceSpans.find((span) => span.gameId === gameId && !span.endedAt)
    if (!openSpan) quotaPresenceSpans.push({ gameId, startedAt })
  }
}

function closeOpenPresenceSpans(
  gameIds: readonly ManagedGameId[],
  terminationReason: GamePresenceSpan['terminationReason'],
  endedAt = new Date().toISOString(),
): void {
  for (const span of quotaPresenceSpans) {
    if (!gameIds.includes(span.gameId) || span.endedAt) continue
    span.endedAt = endedAt
    if (terminationReason) span.terminationReason = terminationReason
  }
}

function recordPrimarySelection(gameId: ManagedGameId | undefined, selectedAt = new Date().toISOString()): void {
  if (!gameId) return
  const lastEvent = quotaPrimarySelectionEvents.at(-1)
  if (lastEvent?.gameId === gameId) return
  quotaPrimarySelectionEvents.push({ gameId, selectedAt })
}

function applyManagedGameSnapshot(
  snapshot: ManagedGameSnapshot,
  options: { trackTimeline?: boolean; closedReason?: GamePresenceSpan['terminationReason'] } = {},
): { previousActiveGameIds: ManagedGameId[]; newlyActiveGameIds: ManagedGameId[]; closedGameIds: ManagedGameId[]; primaryChanged: boolean } {
  const previousActiveGameIds = [...activeManagedGameIds]
  const nextActiveGameIds = [...snapshot.activeGameIds]
  const newlyActiveGameIds = nextActiveGameIds.filter((gameId) => !previousActiveGameIds.includes(gameId))
  const closedGameIds = previousActiveGameIds.filter((gameId) => !nextActiveGameIds.includes(gameId))

  const detectedAt = Date.now()
  for (const gameId of newlyActiveGameIds) {
    managedGameLastDetectedAt[gameId] = detectedAt
  }
  for (const process of snapshot.classifiedProcesses) {
    if (typeof process.processStartedAt === 'number' && Number.isFinite(process.processStartedAt) && process.processStartedAt > 0) {
      observedProcessStartedAt.set(process.pid, process.processStartedAt)
    } else {
      observedProcessStartedAt.delete(process.pid)
    }
  }
  const liveProcessIds = new Set(snapshot.classifiedProcesses.map((process) => process.pid))
  for (const processId of observedProcessStartedAt.keys()) {
    if (!liveProcessIds.has(processId)) observedProcessStartedAt.delete(processId)
  }

  const previousPrimaryGameId = primaryManagedGameId
  activeManagedGameIds = nextActiveGameIds
  primaryManagedGameId = selectPrimaryManagedGame(nextActiveGameIds, managedGameLastDetectedAt, previousPrimaryGameId) ?? null

  if (options.trackTimeline !== false && timerStart !== null) {
    const nowIso = new Date().toISOString()
    if (closedGameIds.length > 0) closeOpenPresenceSpans(closedGameIds, options.closedReason ?? 'closed', nowIso)
    if (newlyActiveGameIds.length > 0) ensurePresenceSpansOpen(newlyActiveGameIds, nowIso)
    if (primaryManagedGameId && primaryManagedGameId !== previousPrimaryGameId) {
      recordPrimarySelection(primaryManagedGameId, nowIso)
    }
  }

  return {
    previousActiveGameIds,
    newlyActiveGameIds,
    closedGameIds,
    primaryChanged: previousPrimaryGameId !== primaryManagedGameId,
  }
}

async function approveNextSession(): Promise<boolean> {
  const gameId = blockedApprovalGameId
  const snapshot = await getManagedGameSnapshot()
  if (blockedApprovalGameId !== gameId) return false
  // PIN fallback is an outage/local-only authority and can be armed only after the
  // blocked original process has exited. It never launches a replacement process.
  if (!gameId || !remoteApprovalController.allowsLocalFallback() || snapshot.activeGameIds.includes(gameId)) return false
  const issuedAt = Date.now()
  const remoteState = remoteApprovalController.getState()
  if (!remoteState.householdId || !remoteState.pcId || !remoteState.membershipEpoch || !remoteState.serviceEpoch || !protectedLocalPolicy) return false
  const permission: RemoteApprovalPermissionTuple = {
    householdId: 'local-outage',
    requestId: `local-${gameId}-${issuedAt}`,
    pcId: remoteState.pcId,
    gameId,
    // Local policy revisions do not mint new allowance; one stable local
    // accounting epoch preserves usage high-water across policy edits.
    allowanceVersion: 1,
    processId: 'first-fresh-process',
    processStartedAt: issuedAt,
  }
  try {
    await remoteStartCoordinator.issueLocalPreauthorization({
      permission,
      bindFirstProcess: true,
    }, getTodaySessionCount().perSessionMinutes)
    return true
  } catch {
    return false
  }
}

function getTrustedManagedProcess(snapshot: ManagedGameSnapshot, gameId: ManagedGameId | undefined): { gameId: ManagedGameId; processId: string; processStartedAt: number } | null {
  const process = snapshot.classifiedProcesses.find((candidate) => candidate.gameId === gameId)
  if (!process) return null
  if (typeof process.processStartedAt !== 'number' || !Number.isFinite(process.processStartedAt) || process.processStartedAt <= 0) {
    observedProcessStartedAt.delete(process.pid)
    return null
  }
  observedProcessStartedAt.set(process.pid, process.processStartedAt)
  return { gameId: process.gameId, processId: String(process.pid), processStartedAt: process.processStartedAt }
}

// 세션 카운트 헬퍼
function getTodaySessionCount(): { sessionsPerDay: number; perSessionMinutes: number } {
  if (!protectedLocalPolicy) throw new Error('Protected local policy unavailable')
  const isWeekend = ['Sat', 'Sun'].includes(dateTimePart('weekday'))
  return {
    sessionsPerDay: isWeekend ? protectedLocalPolicy.weekendSessionCount : protectedLocalPolicy.weekdaySessionCount,
    perSessionMinutes: isWeekend ? protectedLocalPolicy.weekendLimit : protectedLocalPolicy.weekdayLimit,
  }
}
function localPolicyScope(permission: RemoteApprovalPermissionTuple): ProtectedAccountingScope {
  if (!protectedLocalPolicy) throw new Error('Protected local policy unavailable')
  const ianaTimeZone = protectedLocalPolicy.ianaTimeZone
  if (!ianaTimeZone || !/^[A-Za-z0-9_+./-]{1,128}$/.test(ianaTimeZone)) throw new Error('Local policy timezone unavailable')
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ianaTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts()
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value
  const ianaDay = `${part('year')}-${part('month')}-${part('day')}`
  const today = new Date(`${ianaDay}T12:00:00Z`).getUTCDay()
  const weekend = today === 0 || today === 6
  const totalMs = (weekend ? protectedLocalPolicy.weekendLimit * protectedLocalPolicy.weekendSessionCount : protectedLocalPolicy.weekdayLimit * protectedLocalPolicy.weekdaySessionCount) * 60_000
  if (!Number.isSafeInteger(totalMs) || totalMs <= 0) throw new Error('Local policy allowance unavailable')
  return {
    householdId: permission.householdId,
    pcId: permission.pcId,
    gameId: permission.gameId,
    ianaTimeZone,
    ianaDay,
    allowanceVersion: permission.allowanceVersion,
    totalMs,
  }
}
async function requireProtectedPolicyReadiness(): Promise<void> {
  if (!protectedLocalPolicy) throw new Error('Protected local policy unavailable')
  const probe = (gameId: ManagedGameId): RemoteApprovalPermissionTuple => ({
    householdId: 'policy',
    requestId: `policy-readiness-${gameId}`,
    pcId: 'policy',
    gameId,
    allowanceVersion: 1,
    processId: 'readiness',
    processStartedAt: 1,
  })
  await Promise.all([
    privilegedBroker.readAccounting(localPolicyScope(probe('roblox'))),
    privilegedBroker.readAccounting(localPolicyScope(probe('minecraft'))),
  ])
  await usageWriteQueue
  const snapshot = await privilegedBroker.readDailyUsage()
  usageRevision = snapshot.revision
  volatileDailyUsage = snapshot.usage
  accountingIntegrityFault = false
}

function isSessionExhausted(today: string): boolean {
  const usage = getDailyUsage()
  const { sessionsPerDay } = getTodaySessionCount()
  return usage.date === today && isDailyUsageExhausted(usage, sessionsPerDay)
}

function pauseTimerInternals(): void {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  timerStart = null
  timerLimitMs = null
  timerStartReceipt = undefined
  timerSessionStartTime = ''
  timerLimitAtSession = 0
  warnedMinutes.clear()
  inCenterMode = false
  timerUiMode = 'corner'
  timerDisplay = null
  lastCornerOverlayBounds = null
  centerPopupEpoch++
}

function stopTimerInternals(clearPersistedState = true): void {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null }
  timerStart = null
  timerLimitMs = null
  timerStartReceipt = undefined
  timerSessionStartTime = ''
  timerLimitAtSession = 0
  warnedMinutes.clear()
  inCenterMode = false
  timerUiMode = 'corner'
  timerDisplay = null
  resetQuotaWindowTracking()
  if (clearPersistedState) safeClearTimerState()
  lastCornerOverlayBounds = null
  centerPopupEpoch++
}

function persistPausedTimer(): void {
  if (timerStart === null || timerLimitMs === null) return
  const remainingMs = Math.max(0, timerLimitMs - (Date.now() - timerStart))
  const today = getLocalDateString()
  const usage = getDailyUsage()
  safeWriteDailyUsage({
    date: today,
    sessionsCompleted: (usage?.date === today ? usage.sessionsCompleted : 0),
    currentSessionRemainingMs: remainingMs,
  }, false)
  if (remainingMs > 0) {
    safeWriteTimerState({
      startTime: timerStart,
      limitMs: timerLimitMs,
      date: today,
      pausedRemainingMs: remainingMs,
      sessionStartTime: timerSessionStartTime,
      limitAtSession: timerLimitAtSession,
      primaryGameId: primaryManagedGameId ?? undefined,
      activeGameIds: [...activeManagedGameIds],
      presenceSpans: [...quotaPresenceSpans],
      primarySelectionEvents: [...quotaPrimarySelectionEvents],
      startReceipt: timerStartReceipt,
    })
  } else {
    safeClearTimerState()
  }
}

function pauseActiveTimer(): void {
  persistPausedTimer()
  pauseTimerInternals()
  mainWindowPresentation = 'hidden-inactive'
  blockedFailureContext = null
  hideToTray()
}

function pauseTimerBecauseManagedGamesClosed(closedGameId: ManagedGameId): void {
  if (timerAdjustmentInFlight) { deferredClosedGameId = closedGameId; return }
  if (!shouldPauseTimerWhenSupportedGameMissing(timerStart !== null, false)) return
  pauseActiveTimer()
  mainWindow?.webContents.send('game:closed', buildManagedGameEventPayload(closedGameId))
}


function readPausedTimerResumeState(today: string, fallbackRemainingMs: number) {
  const state = readTimerState()
  if (!state || state.date !== today) {
    return {
      remainingMs: fallbackRemainingMs,
      sessionStartTime: undefined,
      limitAtSession: undefined,
      primaryGameId: undefined,
      activeGameIds: undefined,
      presenceSpans: undefined,
      primarySelectionEvents: undefined,
      startReceipt: undefined,
    }
  }

  return {
    remainingMs: Math.min(state.pausedRemainingMs !== undefined ? state.pausedRemainingMs : fallbackRemainingMs, fallbackRemainingMs),
    sessionStartTime: state.sessionStartTime,
    limitAtSession: state.limitAtSession,
    primaryGameId: state.primaryGameId,
    activeGameIds: state.activeGameIds,
    presenceSpans: state.presenceSpans,
    primarySelectionEvents: state.primarySelectionEvents,
    startReceipt: state.startReceipt,
  }
}

function startTimerForDetectedManagedGames(snapshot: ManagedGameSnapshot): boolean {
  if (gameTerminationPending || timerAdjustmentInFlight || usageWritesPending > 0) return false
  if (accountingIntegrityFault) {
    enforceManagedGameBlock('daily-exhausted', snapshot.activeGameIds[0])
    return false
  }
  if (!mainWindow || timerStart !== null) return false
  if (shouldBlockTimerStartWithoutSupportedGame(app.isPackaged, snapshot.activeGameIds.length > 0)) return false

  const today = getLocalDateString()
  const { perSessionMinutes, sessionsPerDay } = getTodaySessionCount()
  const usage = getDailyUsage()
  const usageToday = usage && usage.date === today ? usage : null

  if (usageToday && usageToday.currentSessionRemainingMs > 0) {
    const resumeState = readPausedTimerResumeState(today, usageToday.currentSessionRemainingMs)
    void startTimer(mainWindow, perSessionMinutes, {
      resumeRemainingMs: resumeState.remainingMs,
      sessionStartTime: resumeState.sessionStartTime,
      limitAtSession: resumeState.limitAtSession,
      primaryGameId: resumeState.primaryGameId,
      activeGameIds: snapshot.activeGameIds,
      presenceSpans: resumeState.presenceSpans,
      primarySelectionEvents: resumeState.primarySelectionEvents,
      startReceipt: resumeState.startReceipt,
    }).catch(handleUsagePersistenceFailure)
    return true
  }

  if ((usageToday?.sessionsCompleted ?? 0) >= sessionsPerDay) {
    enforceManagedGameBlock('daily-exhausted', snapshot.activeGameIds[0])
    return false
  }

  if (remoteApprovalController.isRecoveryInProgress()) {
    void remoteStartCoordinator.invalidateLocalPreauthorization('remote-recovery-in-progress')
    enforceManagedGameBlock('approval-required', snapshot.activeGameIds[0])
    return false
  }
  if (!protectedLocalPolicy) return false
  if (!shouldRequireApprovalForStart(protectedLocalPolicy, { hasActiveSession: false })) {
    const process = snapshot.classifiedProcesses.find((candidate) => candidate.gameId === (primaryManagedGameId ?? snapshot.activeGameIds[0]))
    const startedAt = process && observedProcessStartedAt.get(process.pid)
    if (!process || !startedAt) return false
    void remoteStartCoordinator.startPolicyAuthorized(
      { gameId: process.gameId, processId: String(process.pid), processStartedAt: startedAt },
      perSessionMinutes,
    )
    return false
  }
  const remoteState = remoteApprovalController.getState()
  const approvedGrant = remoteState.grant
  const capturedAuthority = remoteApprovalController.getAuthoritySnapshot()
  if (approvedGrant && capturedAuthority && remoteRelaunchFence?.requestId === approvedGrant.requestId) {
    if (remoteRelaunchFence.expiresAt !== approvedGrant.expiresAt) writeRemoteRelaunchFence({ ...remoteRelaunchFence, expiresAt: approvedGrant.expiresAt })
    const fence = remoteRelaunchFence
    const originalStillPresent = snapshot.classifiedProcesses.some((candidate) =>
      candidate.gameId === fence.gameId
      && String(candidate.pid) === fence.originalProcessId
      && candidate.processStartedAt === fence.originalProcessStartedAt,
    )
    if (!fence.armed && !originalStillPresent) {
      writeRemoteRelaunchFence({ ...fence, armed: true })
      return false
    }
    if (fence.armed) {
      const process = getTrustedManagedProcess(snapshot, approvedGrant.gameId as ManagedGameId)
      if (process && (process.processId !== fence.originalProcessId || process.processStartedAt !== fence.originalProcessStartedAt)) {
        if (fence.claimedProcessId && (fence.claimedProcessId !== process.processId || fence.claimedProcessStartedAt !== process.processStartedAt)) return false
        if (!fence.claimedProcessId) writeRemoteRelaunchFence({
          ...fence,
          claimedProcessId: process.processId,
          claimedProcessStartedAt: process.processStartedAt,
        })
        void remoteStartCoordinator.consumeRemoteGrant(
          approvedGrant,
          process,
          capturedAuthority,
        ).then((result) => {
          if (result === 'started') clearRemoteRelaunchFence()
          else if (result === 'denied' && timerStart === null) enforceManagedGameBlock('approval-required', process.gameId)
        })
      }
    }
    return false
  }
  if (remoteRelaunchFence && Date.now() >= remoteRelaunchFence.expiresAt) clearRemoteRelaunchFence()
  const process = getTrustedManagedProcess(snapshot, primaryManagedGameId ?? snapshot.activeGameIds[0])
  if (!process) {
    enforceManagedGameBlock('approval-required', snapshot.activeGameIds[0])
    return false
  }
  if (remoteState.lifecycle === 'online' && !remoteState.request) {
    if (!remoteRequestInFlight) {
      remoteRequestInFlight = remoteApprovalController.createRequest({
        gameId: process.gameId,
        allowanceVersion: remoteState.allowance?.allowanceVersion ?? 0,
        processId: process.processId,
        processStartedAt: process.processStartedAt,
      }).then(() => {
        // Do not terminate the observed game before the broker has acknowledged the exact request.
        if (timerStart === null) enforceManagedGameBlock('approval-required', process.gameId)
      }).catch(() => {
        void remoteApprovalController.sync()
      }).finally(() => { remoteRequestInFlight = null })
    }
    return false
  }
  if (remoteState.lifecycle === 'request-pending') {
    enforceManagedGameBlock('approval-required', process.gameId)
    return false
  }
  void remoteStartCoordinator.consumeLocalPreauthorization(
    { gameId: process.gameId, processId: process.processId, processStartedAt: process.processStartedAt },
  ).then((started) => {
    if (!started && timerStart === null) enforceManagedGameBlock('approval-required', process.gameId)
  })
  return false
}

function getActiveDisplay(): Electron.Display {
  if (timerDisplay) return timerDisplay
  const cursor = screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(cursor)
}

function getCornerInfo(): { w: number; h: number; x: number; y: number } {
  const geometry = getCornerOverlayGeometry(getActiveDisplay().workArea)
  return { w: geometry.width, h: geometry.height, x: geometry.x, y: geometry.y }
}

// 경고 팝업: 현재 타이머 위치의 모니터에서 화면 중앙보다 위
function getCenterInfo(): { w: number; h: number; x: number; y: number } {
  const geometry = getWarningOverlayGeometry(getActiveDisplay().workArea)
  return { w: geometry.width, h: geometry.height, x: geometry.x, y: geometry.y }
}

function hideToTray(): void {
  if (mainWindow) {
    if (mainWindowPresentation === 'inactive-full-page') {
      mainWindowPresentation = 'hidden-inactive'
    }
    mainWindow.setAlwaysOnTop(false)
    mainWindow.hide()
  }
}

function restoreMainFullPageWindow(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const geometry = getFullPageWindowGeometry(display.workArea, MAIN_WINDOW_PROFILE)
  win.hide()
  win.setBounds({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  }, false)
  win.setAlwaysOnTop(false)
  win.setSkipTaskbar(true)
  mainWindowPresentation = 'inactive-full-page'
  blockedFailureContext = null
  setTimeout(() => {
    if (!win.isDestroyed()) win.show()
  }, 40)
}

function showMainWindowForCurrentPresentation(win: BrowserWindow): void {
  if (
    mainWindowPresentation === 'active-overlay'
    || mainWindowPresentation === 'shutdown-overlay'
    || mainWindowPresentation === 'blocked-failure-overlay'
  ) {
    win.show()
    return
  }
  restoreMainFullPageWindow(win)
}

function moveToBlockedFailureOverlay(win: BrowserWindow, context: BlockedFailureContext): void {
  const { w, h, x, y } = getCenterInfo()
  win.hide()
  win.setBounds({ x, y, width: w, height: h }, false)
  win.setAlwaysOnTop(true, 'floating')
  win.setSkipTaskbar(true)
  mainWindowPresentation = 'blocked-failure-overlay'
  blockedFailureContext = context
  setTimeout(() => {
    if (!win.isDestroyed()) win.show()
  }, 40)
}

function clearBlockedFailureViaGameClosed(win: BrowserWindow, gameId?: ManagedGameId): void {
  if (!blockedFailureContext) return
  const reason = blockedFailureContext.reason
  win.webContents.send('game:closed', {
    ...buildManagedGameEventPayload(gameId ?? blockedFailureContext.gameId),
    activeGameIds: [],
  })
  blockedFailureContext = null
  lastManagedGameBlockedReason = ''
  if (reason === 'approval-required' || reason === 'daily-exhausted') {
    restoreMainFullPageWindow(win)
  } else {
    mainWindowPresentation = 'hidden-inactive'
    hideToTray()
  }
}

function showSupportedGameBlocked(
  reason: 'outside-hours' | 'daily-exhausted' | 'approval-required',
  gameId?: ManagedGameId,
  options: { preserveCompact?: boolean } = {},
): void {
  if (!mainWindow) return
  const settings = readSettings()
  const message = reason === 'outside-hours'
    ? `지금은 게임 허용 시간이 아닙니다. (${settings.allowedStartHour}시 ~ ${settings.allowedEndHour}시)`
    : reason === 'approval-required'
      ? '부모님 PIN 승인 후 게임을 시작할 수 있습니다.'
      : '금일 약속된 게임 타임이 종료되었습니다. 당신의 인생이 플러스가 될 게임을 시작할 시간입니다. Do Your Best !!'
  if (reason === 'approval-required' && gameId) blockedApprovalGameId = gameId
  const key = `${reason}:${Math.floor(Date.now() / 60_000)}`
  if (lastManagedGameBlockedReason === key) return
  lastManagedGameBlockedReason = key
  if (!options.preserveCompact) restoreMainFullPageWindow(mainWindow)
  blockedFailureContext = { reason, gameId }
  mainWindow.webContents.send('game:blocked', {
    ...buildManagedGameEventPayload(gameId),
    reason,
    message,
  })
}

function enforceManagedGameBlock(
  reason: 'outside-hours' | 'daily-exhausted' | 'approval-required',
  gameId?: ManagedGameId,
): void {
  showSupportedGameBlocked(reason, gameId)
  void terminateSupportedGames().then((termination) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!termination.success) {
      moveToBlockedFailureOverlay(mainWindow, { reason, gameId })
      mainWindow.webContents.send('timer:termination-failed', {
        message: '게임을 종료하지 못했습니다. 보호 창을 계속 표시합니다.',
        remainingGameIds: termination.remainingGameIds,
      })
      return
    }
    clearBlockedFailureViaGameClosed(mainWindow, gameId)
  })
}

function getSessionHistoryGameId(): ManagedGameId {
  return primaryManagedGameId
    ?? quotaPrimarySelectionEvents.at(-1)?.gameId
    ?? activeManagedGameIds[0]
    ?? 'minecraft'
}

function rememberCornerOverlayBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  lastCornerOverlayBounds = win.getBounds()
  timerDisplay = screen.getDisplayMatching(lastCornerOverlayBounds)
}

function moveToCenterPopup(win: BrowserWindow): number {
  if (timerUiMode === 'corner') rememberCornerOverlayBounds(win)
  const epoch = ++centerPopupEpoch
  win.hide()
  const { w, h, x, y } = getCenterInfo()
  win.setSize(w, h, false)
  win.setPosition(x, y)
  mainWindowPresentation = 'active-overlay'
  blockedFailureContext = null
  timerUiMode = 'center-popup'
  win.webContents.send('timer:mode', { mode: 'center-popup' })
  setTimeout(() => win.show(), 40)
  return epoch
}

function moveToCorner(win: BrowserWindow): void {
  win.hide()
  const fallback = getCornerInfo()
  const bounds = lastCornerOverlayBounds ?? {
    x: fallback.x,
    y: fallback.y,
    width: fallback.w,
    height: fallback.h,
  }
  win.setBounds(bounds, false)
  timerDisplay = screen.getDisplayMatching(bounds)
  lastCornerOverlayBounds = { ...bounds }
  mainWindowPresentation = 'active-overlay'
  blockedFailureContext = null
  timerUiMode = 'corner'
  win.webContents.send('timer:mode', { mode: 'corner' })
  setTimeout(() => win.show(), 40)
}

function restoreCornerAfterPopup(win: BrowserWindow, epoch: number): void {
  if (inCenterMode || epoch !== centerPopupEpoch || win.isDestroyed()) return
  moveToCorner(win)
}

function completeActiveTimer(win: BrowserWindow, authorizedAdjustment = false): void {
  if (isManagedGameTerminationInFlight()) return
  if (timerLimitMs === null || gameTerminationPending || (timerAdjustmentInFlight && !authorizedAdjustment)) return
  gameTerminationPending = true
  gameTerminationAttemptFinished = false
  const today = getLocalDateString()
  const usage = getDailyUsage()
  const closedAt = new Date().toISOString()
  closeOpenPresenceSpans(activeManagedGameIds, 'expired', closedAt)

  const primaryGameId = getSessionHistoryGameId()
  const countsTowardDailySessions = !timerStartReceipt?.startsWith('parent-time:')
  const historyGameIds = Array.from(new Set([
    ...quotaPresenceSpans.map((span) => span.gameId),
    ...activeManagedGameIds,
  ]))

  safeWriteDailyUsage({
    date: today,
    sessionsCompleted: (usage?.date === today ? usage.sessionsCompleted : 0) + (countsTowardDailySessions ? 1 : 0),
    currentSessionRemainingMs: 0,
  })
  const completedSession: Omit<Session, 'id'> = {
    gameId: primaryGameId,
    date: today,
    startTime: timerSessionStartTime || getLocalTimeString(),
    endTime: getLocalTimeString(),
    duration: timerLimitAtSession || Math.round(timerLimitMs / 60000),
    limitAtSession: timerLimitAtSession || Math.round(timerLimitMs / 60000),
    primaryGameId,
    activeGameIds: historyGameIds,
    presenceSpans: [...quotaPresenceSpans],
    primarySelectionEvents: [...quotaPrimarySelectionEvents],
    terminated: false,
    countsTowardDailySessions,
  }
  stopTimerInternals()
  const { w, h, x, y } = getCenterInfo()
  win.setBounds({ x, y, width: w, height: h }, false)
  win.setAlwaysOnTop(true, 'floating')
  win.setSkipTaskbar(true)
  timerUiMode = 'shutdown'
  mainWindowPresentation = 'shutdown-overlay'
  blockedFailureContext = null
  win.webContents.send('timer:mode', { mode: 'shutdown' })
  setTimeout(async () => {
    const termination = await terminateSupportedGames()
    gameTerminationAttemptFinished = true
    safeAppendSession({ ...completedSession, terminated: termination.success })
    if (!termination.success) {
      if (win.isDestroyed()) return
      win.webContents.send('timer:termination-failed', {
        message: '게임을 종료하지 못했습니다. 보호 창을 계속 표시합니다.',
        remainingGameIds: termination.remainingGameIds,
      })
      return
    }
    gameTerminationPending = false
    if (win.isDestroyed()) return
    mainWindowPresentation = 'hidden-inactive'
    hideToTray()
    win.webContents.send('timer:expired')
  }, 3000)
}

function adjustActiveTimer(deltaMinutes: number): number {
  if (!mainWindow || timerStart === null || timerLimitMs === null) return 0
  const normalizedDeltaMinutes = normalizeTimerAdjustmentMinutes(deltaMinutes)

  const now = Date.now()
  const elapsed = now - timerStart
  const remainingMs = Math.max(0, timerLimitMs - elapsed)
  const nextRemainingMs = remainingMs + normalizedDeltaMinutes * 60 * 1000

  timerLimitAtSession = Math.max(0, timerLimitAtSession + normalizedDeltaMinutes)

  if (nextRemainingMs <= 0) {
    completeActiveTimer(mainWindow, true)
    return 0
  }

  timerLimitMs = elapsed + nextRemainingMs
  warnedMinutes.clear()
  const adjustedMinutesLeft = Math.ceil(nextRemainingMs / 60000)
  for (const warnAt of [5, 3, 1]) {
    if (adjustedMinutesLeft <= warnAt) warnedMinutes.add(warnAt)
  }
  if (nextRemainingMs <= 30_000) warnedMinutes.add(0)
  if (nextRemainingMs <= 10_000) warnedMinutes.add(-1)

  inCenterMode = false
  if (timerUiMode !== 'corner' || nextRemainingMs <= 10_000) {
    moveToCorner(mainWindow)
  } else {
    timerUiMode = 'corner'
    mainWindow.webContents.send('timer:mode', { mode: 'corner' })
  }

  const today = getLocalDateString()
  const usage = getDailyUsage()
  safeWriteDailyUsage({
    date: today,
    sessionsCompleted: (usage?.date === today ? usage.sessionsCompleted : 0),
    currentSessionRemainingMs: nextRemainingMs,
  })
  const settings = readSettings()
  if (settings.resumeTimerOnRestart || timerStartReceipt) {
    safeWriteTimerState({
      startTime: timerStart,
      limitMs: timerLimitMs,
      date: today,
      sessionStartTime: timerSessionStartTime,
      limitAtSession: timerLimitAtSession,
      primaryGameId: primaryManagedGameId ?? undefined,
      activeGameIds: [...activeManagedGameIds],
      presenceSpans: [...quotaPresenceSpans],
      primarySelectionEvents: [...quotaPrimarySelectionEvents],
      startReceipt: timerStartReceipt,
    })
  }
  broadcastTimerTick(Math.ceil(nextRemainingMs / 1000))
  return Math.ceil(nextRemainingMs / 1000)
}

async function adjustManagedTime(minutes: number): Promise<number> {
  if (isManagedGameTerminationInFlight()) throw new Error('Timer adjustment unavailable')
  const delta = normalizeTimerAdjustmentMinutes(minutes)
  if (timerAdjustmentInFlight || gameTerminationPending || accountingIntegrityFault || remoteApprovalController.isRecoveryInProgress()) throw new Error('Timer adjustment unavailable')
  const usage = getDailyUsage()
  const paused = readTimerState()
  const hasPaused = paused?.date === getLocalDateString() && usage.currentSessionRemainingMs > 0
  if (timerStart === null && !hasPaused && (!isSessionExhausted(getLocalDateString()) || delta < 0)) throw new Error('Start a game before adjusting time')
  timerAdjustmentInFlight = true
  const receipt = `parent-time:${randomUUID()}`
  try {
    if (delta > 0) {
      await privilegedBroker.grantLocalTime(delta, receipt)
      await persistProtectedUsage({ ...getDailyUsage(), currentSessionRemainingMs: getDailyUsage().currentSessionRemainingMs + delta * 60_000 }, `${receipt}:parent-credit`)
    }
    if (timerStart !== null) {
      const remaining = adjustActiveTimer(delta)
      await usageWriteQueue
      if (accountingIntegrityFault) throw new Error('Protected usage persistence failed')
      return remaining
    }
    const currentUsage = getDailyUsage()
    const state = readTimerState()
    const existing = state?.date === getLocalDateString() && currentUsage.currentSessionRemainingMs > 0 ? state : null
    const remainingMs = Math.max(0, currentUsage.currentSessionRemainingMs + Math.min(0, delta) * 60_000)
    if (remainingMs > 86_400_000) throw new Error('Timer allowance exceeded')
    const finishesBaseSession = remainingMs === 0 && existing && !existing.startReceipt?.startsWith('parent-time:')
    const nextUsage = { ...currentUsage, sessionsCompleted: currentUsage.sessionsCompleted + (finishesBaseSession ? 1 : 0), currentSessionRemainingMs: remainingMs }
    // Persist before acknowledging success; a failed write must not look like an approval.
    await persistProtectedUsage(nextUsage)
    if (remainingMs > 0) {
      writeTimerState({
        ...(existing ?? {}), startTime: Date.now(), date: getLocalDateString(),
        limitMs: remainingMs, pausedRemainingMs: remainingMs,
        limitAtSession: Math.max(0, (existing?.limitAtSession ?? 0) + delta),
        startReceipt: existing?.startReceipt ?? receipt,
      })
    } else {
      if (existing) safeAppendSession({
        gameId: existing.primaryGameId ?? 'roblox', date: getLocalDateString(),
        startTime: existing.sessionStartTime ?? getLocalTimeString(), endTime: getLocalTimeString(),
        duration: existing.limitAtSession ?? Math.ceil(existing.limitMs / 60_000),
        limitAtSession: existing.limitAtSession ?? Math.ceil(existing.limitMs / 60_000),
        primaryGameId: existing.primaryGameId, activeGameIds: existing.activeGameIds,
        presenceSpans: existing.presenceSpans, primarySelectionEvents: existing.primarySelectionEvents,
        terminated: true, countsTowardDailySessions: Boolean(finishesBaseSession),
      })
      clearTimerState()
    }
    return Math.ceil(remainingMs / 1000)
  } finally {
    timerAdjustmentInFlight = false
    const closedGameId = deferredClosedGameId
    deferredClosedGameId = null
    if (closedGameId && activeManagedGameIds.length === 0) pauseTimerBecauseManagedGamesClosed(closedGameId)
    await usageWriteQueue
  }
}

type StartTimerOptions = {
  resumeRemainingMs?: number
  sessionStartTime?: string
  limitAtSession?: number
  primaryGameId?: ManagedGameId
  activeGameIds?: ManagedGameId[]
  presenceSpans?: GamePresenceSpan[]
  primarySelectionEvents?: PrimarySelectionEvent[]
  startReceipt?: string
  startTime?: number
}

async function startTimer(win: BrowserWindow, limitMinutes: number, options: StartTimerOptions = {}): Promise<void> {
  const nextActiveGameIds = [...(options.activeGameIds ?? (await getManagedGameSnapshot()).activeGameIds)]
  if (accountingIntegrityFault) {
    return
  }
  await persistProtectedUsage({ ...getDailyUsage(), currentSessionRemainingMs: Math.min(getDailyUsage().currentSessionRemainingMs, options.resumeRemainingMs ?? Math.round(limitMinutes * 60000)) }, undefined, true)
  if (accountingIntegrityFault || gameTerminationPending || isManagedGameTerminationInFlight() || !isAllowedHour() || getDailyUsage().currentSessionRemainingMs <= 0) return
  options = { ...options, resumeRemainingMs: getDailyUsage().currentSessionRemainingMs }
  stopTimerInternals(options.startReceipt === undefined)

  const cursor = screen.getCursorScreenPoint()
  timerDisplay = screen.getDisplayNearestPoint(cursor)

  const limitMs = Math.round(limitMinutes * 60 * 1000)
  timerLimitMs = limitMs
  timerStartReceipt = options.startReceipt
  timerSessionStartTime = options.sessionStartTime || getLocalTimeString()
  timerLimitAtSession = options.limitAtSession || limitMinutes

  if (options.resumeRemainingMs !== undefined) {
    timerStart = Date.now() - (limitMs - options.resumeRemainingMs)
  } else {
    timerStart = options.startTime ?? Date.now()
  }

  warnedMinutes.clear()
  inCenterMode = false

  const detectedAt = Date.now()
  for (const gameId of nextActiveGameIds) {
    if (!managedGameLastDetectedAt[gameId]) managedGameLastDetectedAt[gameId] = detectedAt
  }

  activeManagedGameIds = nextActiveGameIds
  primaryManagedGameId = options.primaryGameId
    ?? selectPrimaryManagedGame(nextActiveGameIds, managedGameLastDetectedAt, primaryManagedGameId)
    ?? nextActiveGameIds[0]
    ?? null

  const timelineAt = new Date().toISOString()
  if (options.resumeRemainingMs !== undefined) {
    quotaPresenceSpans = [...(options.presenceSpans ?? [])]
    quotaPrimarySelectionEvents = [...(options.primarySelectionEvents ?? [])]
  } else {
    resetQuotaWindowTracking()
  }
  ensurePresenceSpansOpen(nextActiveGameIds, timelineAt)
  recordPrimarySelection(primaryManagedGameId ?? undefined, timelineAt)

  const settings = readSettings()
  if (settings.resumeTimerOnRestart || timerStartReceipt) {
    const today = getLocalDateString()
    safeWriteTimerState({
      startTime: timerStart,
      limitMs: timerLimitMs,
      date: today,
      sessionStartTime: timerSessionStartTime,
      limitAtSession: timerLimitAtSession,
      primaryGameId: primaryManagedGameId ?? undefined,
      activeGameIds: [...activeManagedGameIds],
      presenceSpans: [...quotaPresenceSpans],
      primarySelectionEvents: [...quotaPrimarySelectionEvents],
      startReceipt: options.startReceipt,
    })
  }

  win.setAlwaysOnTop(true, 'floating')
  win.setSkipTaskbar(true)
  moveToCorner(win)

  timerInterval = setInterval(() => {
    if (timerStart === null || timerLimitMs === null) return

    // Presence is sampled independently by startManagedGameDetection. Never
    // await OS process enumeration on the clock/warning/expiry path.

    if (!isAllowedHour()) {
      completeActiveTimer(win)
      showSupportedGameBlocked('outside-hours', primaryManagedGameId ?? activeManagedGameIds[0], { preserveCompact: true })
      return
    }

    const elapsed = Date.now() - timerStart
    const remaining = Math.max(0, timerLimitMs - elapsed)
    const remainingSeconds = Math.ceil(remaining / 1000)

    broadcastTimerTick(remainingSeconds)

    const minutesLeft = Math.ceil(remaining / 60000)
    for (const warnAt of [5, 3, 1]) {
      if (minutesLeft <= warnAt && limitMinutes > warnAt && minutesLeft > 0 && !warnedMinutes.has(warnAt)) {
        warnedMinutes.add(warnAt)
        win.webContents.send('timer:warning', { minutesLeft: warnAt })
        if (!inCenterMode) {
          const epoch = moveToCenterPopup(win)
          setTimeout(() => restoreCornerAfterPopup(win, epoch), 4000)
        }
      }
    }

    if (remainingSeconds <= 30 && remainingSeconds > 10 && !warnedMinutes.has(0)) {
      warnedMinutes.add(0)
      win.webContents.send('timer:warning', { minutesLeft: 0 })
      if (!inCenterMode) {
        const epoch = moveToCenterPopup(win)
        setTimeout(() => restoreCornerAfterPopup(win, epoch), 4000)
      }
    }

    if (remainingSeconds <= 10 && remainingSeconds > 0 && !warnedMinutes.has(-1)) {
      warnedMinutes.add(-1)
      if (timerUiMode === 'corner') rememberCornerOverlayBounds(win)
      centerPopupEpoch++
      inCenterMode = true
      win.hide()
      const { w: cw, h: ch, x: cx, y: cy } = getCenterInfo()
      win.setSize(cw, ch, false)
      win.setPosition(cx, cy)
      timerUiMode = 'center-countdown'
      win.webContents.send('timer:mode', { mode: 'center-countdown' })
      setTimeout(() => win.show(), 40)
    }

    if (remaining <= 0) completeActiveTimer(win)
  }, 1000)
}

async function tryResumeTimer(): Promise<boolean> {
  // Missing authority is a blocked startup, not a reason to read dates or
  // discard persisted timer state from an unhandled startup callback.
  if (!protectedLocalPolicy || accountingIntegrityFault) return false
  const win = mainWindow
  if (!win) return false

  const capture = await getManagedGameSnapshotCapture()
  if (timerStart !== null) return true
  if (win.isDestroyed() || gameTerminationPending || isManagedGameTerminationInFlight() || accountingIntegrityFault || !protectedLocalPolicy || timerAdjustmentInFlight) return false
  if (!capture.succeeded) return false

  const settings = readSettings()
  const state = readTimerState()
  if (!state) return false
  if (!settings.resumeTimerOnRestart && !state.startReceipt) return false

  const today = getLocalDateString()
  if (state.date !== today) {
    safeClearTimerState()
    return false
  }

  if (isSessionExhausted(today)) {
    safeClearTimerState()
    return false
  }

  const stateRemaining = state.pausedRemainingMs !== undefined
    ? state.pausedRemainingMs
    : Math.max(0, state.limitMs - (Date.now() - state.startTime))

  const usage = getDailyUsage()
  // A protected zero is authoritative; a stale/editable timer file cannot revive it.
  const dailyRemaining = usage.date === today ? usage.currentSessionRemainingMs : 0

  const remaining = Math.min(stateRemaining, dailyRemaining)
  if (remaining <= 0) {
    safeClearTimerState()
    return false
  }

  const snapshot = capture.snapshot
  if (shouldBlockTimerStartWithoutSupportedGame(app.isPackaged, snapshot.activeGameIds.length > 0)) {
    activeManagedGameIds = []
    primaryManagedGameId = null
    safeWriteDailyUsage({
      date: today,
      sessionsCompleted: (usage?.date === today ? usage.sessionsCompleted : 0),
      currentSessionRemainingMs: remaining,
    })
    safeWriteTimerState({
      startTime: Date.now(),
      limitMs: remaining,
      date: today,
      pausedRemainingMs: remaining,
      sessionStartTime: state.sessionStartTime,
      limitAtSession: state.limitAtSession,
      primaryGameId: state.primaryGameId,
      activeGameIds: [],
      presenceSpans: state.presenceSpans,
      primarySelectionEvents: state.primarySelectionEvents,
      startReceipt: state.startReceipt,
    })
    return false
  }

  const limitMinutes = Math.max(1, state.limitMs / 60000)
  void startTimer(win, limitMinutes, {
    resumeRemainingMs: remaining,
    sessionStartTime: state.sessionStartTime,
    limitAtSession: state.limitAtSession,
    primaryGameId: state.primaryGameId,
    activeGameIds: snapshot.activeGameIds,
    presenceSpans: state.presenceSpans,
    primarySelectionEvents: state.primarySelectionEvents,
    startReceipt: state.startReceipt,
  }).catch(handleUsagePersistenceFailure)
  win.webContents.send('timer:resumed', { remainingSeconds: Math.ceil(remaining / 1000) })
  return true
}

function getAdminFullPageGeometry() {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  return getFullPageWindowGeometry(display.workArea, ADMIN_WINDOW_PROFILE)
}

function openAdminWindow(): void {
  const geometry = getAdminFullPageGeometry()
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.setBounds({
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    }, false)
    adminWindow.show()
    adminWindow.focus()
    return
  }

  const preloadPath = join(__dirname, '../preload/index.js')
  adminWindow = new BrowserWindow({
    width: geometry.width,
    height: geometry.height,
    x: geometry.x,
    y: geometry.y,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    adminWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#admin`)
  } else {
    adminWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'admin' })
  }

  adminWindow.on('closed', () => { adminWindow = null })
}

function addTrayClick(count = 1): void {
  const now = Date.now()
  trayClicks = trayClicks.filter(t => now - t < 1500)
  for (let i = 0; i < count; i++) trayClicks.push(now)

  if (trayClickTimer) clearTimeout(trayClickTimer)

  if (trayClicks.length >= 3) {
    trayClicks = []
    openAdminWindow()
    return
  }

  trayClickTimer = setTimeout(() => {
    trayClicks = []
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindowForCurrentPresentation(mainWindow)
      mainWindow.focus()
    }
  }, 400)
}

function loadTrayIcon(): Electron.NativeImage {
  const resourcesDir = getResourcesDir()
  const candidatePaths = process.platform === 'win32'
    ? [
        join(resourcesDir, 'icon.ico'),
        join(resourcesDir, 'tray-icon.png'),
        join(resourcesDir, 'icon-256.png'),
      ]
    : [
        join(resourcesDir, 'tray-icon.png'),
        join(resourcesDir, 'icon-256.png'),
        join(resourcesDir, 'icon.ico'),
      ]

  for (const iconPath of candidatePaths) {
    if (!existsSync(iconPath)) continue
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) {
      return process.platform === 'win32' ? icon : icon.resize({ width: 16, height: 16 })
    }
    console.error('tray icon image was empty', iconPath)
  }

  const fallback = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL)
  if (!fallback.isEmpty()) return fallback

  throw new Error(`No usable tray icon found in ${resourcesDir}`)
}

function createTray(): void {
  try {
    const icon = loadTrayIcon()
    tray = new Tray(icon)
    tray.setToolTip('Playtime Pact')
    tray.on('click', () => addTrayClick(1))
    tray.on('double-click', () => addTrayClick(2))
  } catch (err) {
    console.error('tray creation failed; continuing without crashing startup', err)
  }
}

function startManagedGameDetection(): void {
  if (managedGameDetectInterval) return
  let capturing = false
  managedGameDetectInterval = setInterval(async () => {
    if (capturing) return
    capturing = true
    let capture
    try { capture = await getManagedGameSnapshotCapture() } finally { capturing = false }
    if (!managedGameDetectInterval || !mainWindow || mainWindow.isDestroyed()) return
    if (!capture.succeeded) return
    if (isManagedGameTerminationInFlight()) return
    const snapshot = capture.snapshot
    const hasRunningManagedGames = snapshot.activeGameIds.length > 0

    if (gameTerminationPending) {
      if (!gameTerminationAttemptFinished) return
      if (hasRunningManagedGames) return
      gameTerminationPending = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindowPresentation = 'hidden-inactive'
        hideToTray()
        mainWindow.webContents.send('timer:expired')
      }
      return
    }

    if (!managedGameBaselineCaptured) {
      managedGameBaselineCaptured = true
      activeManagedGameIds = []
      primaryManagedGameId = null
      if (!hasRunningManagedGames) return
    }

    if (timerStart !== null) {
      const presenceUpdate = applyManagedGameSnapshot(snapshot)
      const affectedGameId = presenceUpdate.newlyActiveGameIds.at(-1)
        ?? presenceUpdate.closedGameIds.at(0)
        ?? primaryManagedGameId
        ?? snapshot.activeGameIds[0]
        ?? getSessionHistoryGameId()

      if (!hasRunningManagedGames) {
        pauseTimerBecauseManagedGamesClosed(affectedGameId)
        return
      }

      if (presenceUpdate.newlyActiveGameIds.length > 0 || presenceUpdate.closedGameIds.length > 0 || presenceUpdate.primaryChanged) {
        const channel = presenceUpdate.closedGameIds.length > 0 && presenceUpdate.newlyActiveGameIds.length === 0
          ? 'game:closed'
          : 'game:detected'
        mainWindow?.webContents.send(channel, buildManagedGameEventPayload(affectedGameId))
      }
      return
    }

    const presenceUpdate = applyManagedGameSnapshot(snapshot, { trackTimeline: false })
    const detectedGameId = presenceUpdate.newlyActiveGameIds.at(-1)
      ?? primaryManagedGameId
      ?? snapshot.activeGameIds[0]
      ?? 'minecraft'

    if (!hasRunningManagedGames) {
      if (blockedFailureContext && mainWindow && !mainWindow.isDestroyed()) {
        clearBlockedFailureViaGameClosed(mainWindow)
      } else if (presenceUpdate.closedGameIds.length > 0) {
        mainWindow?.webContents.send('game:closed', buildManagedGameEventPayload(detectedGameId))
      }
      return
    }

    if (!isAllowedHour()) {
      activeManagedGameIds = []
      primaryManagedGameId = null
      enforceManagedGameBlock('outside-hours', detectedGameId)
      return
    }

    const today = getLocalDateString()
    if (isSessionExhausted(today)) {
      activeManagedGameIds = []
      primaryManagedGameId = null
      enforceManagedGameBlock('daily-exhausted', detectedGameId)
      return
    }

    const started = startTimerForDetectedManagedGames(snapshot)
    if (started || presenceUpdate.newlyActiveGameIds.length > 0 || presenceUpdate.primaryChanged) {
      mainWindow?.webContents.send('game:detected', buildManagedGameEventPayload(detectedGameId))
    }
  }, 2000)
}

type QaOverlayMode = 'corner' | 'center-popup' | 'center-countdown' | 'shutdown'

function showQaOverlayEvidence(win: BrowserWindow): boolean {
  if (!process.argv.includes('--qa-evidence')) return false
  const mode = process.env.PLAYTIME_PACT_QA_OVERLAY as QaOverlayMode | undefined
  if (!mode || !['corner', 'center-popup', 'center-countdown', 'shutdown'].includes(mode)) return false

  setTimeout(() => {
    if (win.isDestroyed()) return
    const remainingSeconds = mode === 'center-countdown' ? 8 : mode === 'shutdown' ? 0 : 180
    win.webContents.send('timer:tick', { remainingSeconds })
    if (mode === 'center-popup') {
      win.webContents.send('timer:warning', { minutesLeft: 3 })
    }
    win.webContents.send('timer:mode', { mode })
    showMainWindowForCurrentPresentation(win)
    win.focus()
  }, 700)
  return true
}

function createWindow(): void {
  const preloadPath = join(__dirname, '../preload/index.js')

  const initialDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const initialGeometry = getFullPageWindowGeometry(initialDisplay.workArea, MAIN_WINDOW_PROFILE)
  mainWindow = new BrowserWindow({
    width: initialGeometry.width,
    height: initialGeometry.height,
    x: initialGeometry.x,
    y: initialGeometry.y,
    resizable: false,
    frame: false,
    movable: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindowPresentation = 'hidden-inactive'

  mainWindow.on('close', (e) => {
    if (allowQuit) return
    e.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('moved', () => {
    const win = mainWindow
    if (!win || win.isDestroyed() || timerStart === null || timerUiMode !== 'corner') return
    rememberCornerOverlayBounds(win)
  })

  ipcMain.handle('timer:start', async (_e, { limitMinutes }: { limitMinutes: number }) => {
    if (usageWritesPending > 0) return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'invalid-limit' }
    if (!protectedLocalPolicy || accountingIntegrityFault) return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'invalid-limit' }
    if (gameTerminationPending || timerAdjustmentInFlight) return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'managed-game-not-running' }
    if (!mainWindow) return { resumed: false, remainingSeconds: 0, exhausted: false }
    if (timerStart !== null && timerLimitMs !== null) {
      const remaining = Math.max(0, timerLimitMs - (Date.now() - timerStart))
      return { resumed: true, remainingSeconds: Math.ceil(remaining / 1000), exhausted: false }
    }

    const snapshot = await getManagedGameSnapshot()
    if (!mainWindow || timerStart !== null || gameTerminationPending || timerAdjustmentInFlight || accountingIntegrityFault) {
      return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'managed-game-not-running' }
    }
    if (shouldBlockTimerStartWithoutSupportedGame(app.isPackaged, snapshot.activeGameIds.length > 0)) {
      return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'managed-game-not-running' }
    }

    const trustedLimit = getTodaySessionCount().perSessionMinutes
    const requestedLimit = Number(limitMinutes)
    const limitMins = app.isPackaged ? trustedLimit : requestedLimit
    if (!isFinite(limitMins) || limitMins <= 0) {
      return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'invalid-limit' }
    }

    if (!isAllowedHour()) {
      enforceManagedGameBlock('outside-hours', snapshot.activeGameIds[0])
      return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'outside-hours' }
    }

    const today = getLocalDateString()
    const { sessionsPerDay } = getTodaySessionCount()
    const usage = getDailyUsage()
    const usageToday = usage && usage.date === today ? usage : null

    if (usageToday && usageToday.currentSessionRemainingMs > 0) {
      const resumeState = readPausedTimerResumeState(today, usageToday.currentSessionRemainingMs)
      await startTimer(mainWindow, limitMins, {
        resumeRemainingMs: resumeState.remainingMs,
        sessionStartTime: resumeState.sessionStartTime,
        limitAtSession: resumeState.limitAtSession,
        primaryGameId: resumeState.primaryGameId,
        activeGameIds: snapshot.activeGameIds,
        presenceSpans: resumeState.presenceSpans,
      primarySelectionEvents: resumeState.primarySelectionEvents,
      startReceipt: resumeState.startReceipt,
      })
      return { resumed: true, remainingSeconds: Math.ceil(resumeState.remainingMs / 1000), exhausted: false }
    }

    const sessionsCompleted = usageToday ? usageToday.sessionsCompleted : 0
    if (sessionsCompleted >= sessionsPerDay) {
      enforceManagedGameBlock('daily-exhausted', snapshot.activeGameIds[0])
      return { resumed: false, remainingSeconds: 0, exhausted: true }
    }

    const process = snapshot.classifiedProcesses.find((candidate) => candidate.gameId === (primaryManagedGameId ?? snapshot.activeGameIds[0]))
    const startedAt = process && observedProcessStartedAt.get(process.pid)
    if (!process || !startedAt) {
      return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'managed-game-not-running' }
    }
    const remoteState = remoteApprovalController.getState()
    const capturedAuthority = remoteApprovalController.getAuthoritySnapshot()
    const fence = remoteRelaunchFence
    if (remoteState.grant && capturedAuthority && fence?.requestId === remoteState.grant.requestId && fence.armed) {
      if (fence.expiresAt !== remoteState.grant.expiresAt) writeRemoteRelaunchFence({ ...fence, expiresAt: remoteState.grant.expiresAt })
      const trusted = getTrustedManagedProcess(snapshot, remoteState.grant.gameId as ManagedGameId)
      if (trusted && (trusted.processId !== fence.originalProcessId || trusted.processStartedAt !== fence.originalProcessStartedAt)
        && (!fence.claimedProcessId || (fence.claimedProcessId === trusted.processId && fence.claimedProcessStartedAt === trusted.processStartedAt))) {
        if (!fence.claimedProcessId) writeRemoteRelaunchFence({ ...fence, claimedProcessId: trusted.processId, claimedProcessStartedAt: trusted.processStartedAt })
        void remoteStartCoordinator.consumeRemoteGrant(
          remoteState.grant,
          trusted,
          capturedAuthority,
        ).then((result) => { if (result === 'started') clearRemoteRelaunchFence() })
      }
    } else if (protectedLocalPolicy && !shouldRequireApprovalForStart(protectedLocalPolicy, { hasActiveSession: false })) {
      void remoteStartCoordinator.startPolicyAuthorized(
        { gameId: process.gameId, processId: String(process.pid), processStartedAt: startedAt },
        limitMins,
      )
    } else {
      void remoteStartCoordinator.consumeLocalPreauthorization(
        { gameId: process.gameId, processId: String(process.pid), processStartedAt: startedAt },
      )
    }
    return { resumed: false, remainingSeconds: 0, exhausted: false, blocked: 'approval-required' }
  })


  ipcMain.handle('timer:get-status', async () => {
    const managedState = getManagedGameState()
    if (timerStart === null || timerLimitMs === null) {
      return { running: false, remainingSeconds: Math.ceil(getDailyUsage().currentSessionRemainingMs / 1000), mode: timerUiMode, ...managedState }
    }
    const elapsed = Date.now() - timerStart
    const remaining = Math.max(0, timerLimitMs - elapsed)
    return { running: true, remainingSeconds: Math.ceil(remaining / 1000), mode: timerUiMode, ...managedState }
  })

  ipcMain.handle('timer:adjust-time', async (event, { minutes }: { minutes: number }) => {
    requireAdminSession(event)
    return { remainingSeconds: await adjustManagedTime(Number(minutes)) }
  })

  ipcMain.handle('timer:admin-stop', async (event) => {
    requireAdminSession(event)
    if (isManagedGameTerminationInFlight()) throw new Error('Timer action in progress')
    if (timerAdjustmentInFlight || gameTerminationPending) throw new Error('Timer action in progress')
    const termination = await terminateSupportedGames()
    if (!termination.success) {
      mainWindow?.webContents.send('timer:termination-failed', {
        message: '게임을 종료하지 못했습니다. 보호 창을 계속 표시합니다.',
        remainingGameIds: termination.remainingGameIds,
      })
      throw new Error('Managed game termination failed')
    }

    if (timerStart !== null && timerLimitMs !== null) {
      closeOpenPresenceSpans(activeManagedGameIds, 'admin-stop')
      persistPausedTimer()
      pauseTimerInternals()
    }
    if (mainWindow) {
      restoreMainFullPageWindow(mainWindow)
      mainWindow.webContents.send('timer:admin-stopped')
    }
  })

  ipcMain.handle('admin:close-window', async () => { adminWindow?.close() })
  ipcMain.handle('admin:get-resume-option', async (event) => {
    requireAdminSession(event)
    return readSettings().resumeTimerOnRestart
  })

  ipcMain.handle('window:hide-main', async () => {
    hideToTray()
    return true
  })

  ipcMain.handle('window:minimize-main', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false)
      win.hide()
    }
    return true
  })

  ipcMain.on('window:hide-main-now', () => {
    hideToTray()
  })

  ipcMain.handle('window:show-main', async () => {
    if (mainWindow) {
      if (mainWindowPresentation === 'active-overlay' && timerStart !== null && timerLimitMs !== null) {
        moveToCorner(mainWindow)
      } else {
        showMainWindowForCurrentPresentation(mainWindow)
      }
      mainWindow.focus()
    }
  })

  ipcMain.handle('app:shutdown', async (event) => {
    requireAdminSession(event)
    disableWatchdog()
    await stopWatchdogProcesses()
    await terminateSupportedGames()
    allowQuit = true
    app.quit()
    return true
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    stopTimerInternals()
  })
}

// A fresh install must migrate the legacy HMAC record under the SYSTEM-only
// service identity. An elevated installer administrator token is deliberately
// not sufficient to read that key, so the service-mode bootstrap below owns
// this explicit initialization.
if (initializeLocalProtectionMode && !privilegedServiceMode) {
  app.whenReady().then(() => {
    const elevated = execFileSync('powershell.exe', ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8', windowsHide: true }).trim()
    if (elevated !== 'True') throw new Error('Administrator initialization required')
    PrivilegedApprovalService.initializeLocalProtection('C:\\ProgramData\\PlaytimePact\\Broker\\Accounting')
    app.exit(0)
  }).catch(() => { process.stderr.write('Local protection initialization failed\n'); app.exit(1) })
} else if (protectionReadinessMode) {
  app.whenReady().then(async () => { await privilegedBroker.readinessCheck(); app.exit(0) })
    .catch((error: unknown) => { process.stderr.write(formatPrivilegedHealthDiagnostic(error)); app.exit(1) })
} else if (privilegedConfigCheckMode) {
  app.whenReady().then(async () => {
    try {
      const membership = await bootstrapPrivilegedMembership()
      process.stdout.write(`${JSON.stringify({ ok: true, membership })}\n`)
      app.exit(0)
    } catch (error) {
      const code = error instanceof RemoteApprovalConfigError ? error.code : 'CONFIG_UNREADABLE'
      process.stdout.write(`${JSON.stringify({ ok: false, code })}\n`)
      app.exit(2)
    }
  }).catch(() => app.exit(2))
} else if (privilegedServiceMode) {
  app.whenReady().then(async () => {
    const stateDir = 'C:\\ProgramData\\PlaytimePact\\Broker\\Accounting'
    if (initializeLocalProtectionMode) {
      PrivilegedApprovalService.initializeLocalProtection(stateDir)
    }
    const config = provisionedRemoteConfig
    const configLoadError = provisionedRemoteConfigState.error
    const remote = config ? new WindowsCngRemoteApprovalBroker(config, undefined, undefined, () => Date.now(), remoteServerClock) : null
    const unavailable = () => Promise.reject(configLoadError
      ?? Object.assign(new Error('Remote authority configuration unavailable'), { code: 'UNAVAILABLE' }))
    const hosted = new PrivilegedApprovalService(
      (operation, payload) => {
        if (operation === 'bootstrap-membership') return bootstrapPrivilegedMembership()
        if (!remote) return unavailable()
        const { __privilegedIdempotencyKey, ...body } = payload
        return remote.invoke({ operation: operation as never, payload: body, idempotencyKey: String(__privilegedIdempotencyKey ?? '') })
      },
      (operation, payload) => {
        if (!remote) return unavailable()
        const { __privilegedIdempotencyKey, ...body } = payload
        return remote.invoke({ operation: operation as never, payload: body, idempotencyKey: String(__privilegedIdempotencyKey ?? '') })
      },
      PrivilegedApprovalService.loadAccounting(stateDir),
      stateDir,
    )
    await startPrivilegedPipeServer(hosted)
  }).catch(() => app.exit(1))
} else if (privilegedHealthCheckMode) {
  app.whenReady().then(async () => {
    await privilegedBroker.healthCheck()
    app.exit(0)
  }).catch((error: unknown) => {
    process.stderr.write(formatPrivilegedHealthDiagnostic(error))
    app.exit(1)
  })
} else {
app.whenReady().then(async () => {
  try {
    protectedLocalPolicy = await privilegedBroker.readLocalPolicy()
    remoteApprovalController.setEnabled(protectedLocalPolicy.requireApprovalBeforeStart)
    await requireProtectedPolicyReadiness()
  } catch (error) {
    protectedLocalPolicy = null
    accountingIntegrityFault = true
    console.error('protected local policy/accounting unavailable; denying starts', error)
  }
  void privilegedBroker.bootstrapMembership().then(
    (membership) => {
      remoteApprovalController.configureMembership(membership)
      remoteApprovalController.startPolling()
    },
    (error: unknown) => {
      const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
      if (code !== 'UNAVAILABLE' && code !== 'OFFLINE') console.error('remote membership bootstrap failed', error)
    },
  )
  registerIpcHandlers({
    readPublicSettings: () => {
      const settings = readSettings()
      if (protectedLocalPolicy) {
        const { version: _version, ianaTimeZone: _timeZone, ...policy } = protectedLocalPolicy
        Object.assign(settings, policy)
      }
      const { adminPasswordHash: _secret, ...publicSettings } = settings
      return publicSettings
    },
    readDailyRemaining: async () => {
      if (!protectedLocalPolicy || accountingIntegrityFault) throw new Error('Protected usage unavailable')
      const usage = getDailyUsage()
      const { sessionsPerDay, perSessionMinutes } = getTodaySessionCount()
      const exhausted = accountingIntegrityFault || isDailyUsageExhausted(usage, sessionsPerDay)
      return { remainingSeconds: exhausted ? 0 : usage.currentSessionRemainingMs > 0 ? Math.ceil(usage.currentSessionRemainingMs / 1000) : perSessionMinutes * 60,
        exhausted, totalSeconds: perSessionMinutes * 60, sessionsCompleted: usage.sessionsCompleted, sessionsPerDay,
        currentSessionActive: !exhausted && usage.currentSessionRemainingMs > 0 }
    },
    approveNextSession,
    verifyAdminPin: (pin) => privilegedBroker.verifyPin(pin),
    changeAdminPin: (newPin) => privilegedBroker.changePin(newPin),
    protectLocalPolicy: async (settings) => {
      const ianaTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (!ianaTimeZone) throw new Error('Local policy timezone unavailable')
      protectedLocalPolicy = await privilegedBroker.setLocalPolicy({
        ianaTimeZone,
        weekdayLimit: settings.weekdayLimit,
        weekendLimit: settings.weekendLimit,
        weekdaySessionCount: settings.weekdaySessionCount,
        weekendSessionCount: settings.weekendSessionCount,
        allowedStartHour: settings.allowedStartHour,
        allowedEndHour: settings.allowedEndHour,
        requireApprovalBeforeStart: settings.requireApprovalBeforeStart,
      })
      remoteApprovalController.setEnabled(protectedLocalPolicy.requireApprovalBeforeStart)
      accountingIntegrityFault = true
      await requireProtectedPolicyReadiness()
    },
    remote: {
      getState: () => remoteApprovalController.getState(),
      controller: remoteApprovalController,
      createRequest: async ({ gameId }) => {
        if (gameId !== 'minecraft' && gameId !== 'roblox') throw new Error('unsupported managed game')
        const snapshot = await getManagedGameSnapshot()
        const process = getTrustedManagedProcess(snapshot, gameId)
        if (!process) throw new Error('managed game not running')
        return remoteApprovalController.createRequest({
          gameId: process.gameId,
          allowanceVersion: remoteApprovalController.getState().allowance?.allowanceVersion ?? 0,
          processId: process.processId,
          processStartedAt: process.processStartedAt,
        })
      },
    },
  })
  spawnSessionWatchdog()
  createWindow()
  createTray()
  startManagedGameDetection()

  mainWindow?.webContents.once('did-finish-load', async () => {
    if (mainWindow && showQaOverlayEvidence(mainWindow)) return
    try { await remoteStartCoordinator.recoverCommittedTimerStarts() } catch (error) {
      accountingIntegrityFault = true
      console.error('committed timer handoff recovery failed', error)
    }
    setTimeout(async () => {
      const resumed = timerStart !== null || await tryResumeTimer()
      const action = decideStartupWindowAction({ startHidden, resumedTimer: resumed })
      if (action === 'show-main-window' && mainWindow) {
        restoreMainFullPageWindow(mainWindow)
        mainWindow.focus()
      } else if (action === 'hide-to-tray') {
        mainWindow?.hide()
        mainWindowPresentation = 'hidden-inactive'
      }
    }, 500)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
}

app.on('window-all-closed', () => {
  // 트레이에서 계속 실행
})
