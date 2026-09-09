import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { ManagedGameId, PublicSettings, RemoteApprovalState } from '../../../shared/types'
import { DEFAULT_PUBLIC_SETTINGS } from '../../../shared/types'
import { getManagedGameDisplayName, listSecondaryManagedGames } from '../../../shared/managedGames'
import { isHourAllowed } from '../../../shared/policy'
import { attemptParentApproval, attemptTimerStart } from '../asyncAttempts'
import VoxelCrew from '../components/VoxelCrew'
import PinPad from '../components/PinPad'
import SmartphoneShell, { useModalFocusBoundary } from '../components/SmartphoneShell'
import PhoneBottomNav from '../components/PhoneBottomNav'
import { INITIAL_TIMER_PRESENTATION, reduceTimerPresentation } from '../timerPresentation'

interface Props {
  visible?: boolean
  onOpenSettings: () => void
  onActiveChange?: (active: boolean) => void
  requestedSurface?: 'play' | 'rules'
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

function formatLimitDisplay(minutes: number): string {
  if (!isFinite(minutes) || minutes < 0) return '--:--'
  const value = Math.floor(minutes)
  return `${String(value).padStart(2, '0')}:00`
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function getTodayAllowedMinutes(settings: PublicSettings): number {
  const limit = isWeekend(new Date()) ? settings.weekendLimit : settings.weekdayLimit
  return isFinite(limit) && limit > 0 ? limit : DEFAULT_PUBLIC_SETTINGS.weekdayLimit
}

function ledColors(remainingSeconds: number): { color: string; glow: string; tone: 'safe' | 'warn' | 'danger' } {
  if (remainingSeconds <= 60) return { color: '#ff5d6c', glow: 'rgba(255,93,108,0.86)', tone: 'danger' }
  if (remainingSeconds <= 180) return { color: '#ffb347', glow: 'rgba(255,179,71,0.82)', tone: 'warn' }
  if (remainingSeconds <= 300) return { color: '#ffe27a', glow: 'rgba(255,226,122,0.74)', tone: 'warn' }
  return { color: '#7bffb5', glow: 'rgba(123,255,181,0.74)', tone: 'safe' }
}

function OverlayRoot({ children, dragEverywhere = false }: { children: ReactNode; dragEverywhere?: boolean }) {
  return (
    <div className={`ppt-overlay-screen ${dragEverywhere ? 'app-drag' : ''}`}>
      {children}
    </div>
  )
}

export default function Timer({ onOpenSettings, onActiveChange, requestedSurface = 'play', visible = true }: Props) {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [sessionStartTime, setSessionStartTime] = useState('')
  const [warningMessage, setWarningMessage] = useState<string | null>(null)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)
  const [terminationError, setTerminationError] = useState<string | null>(null)
  const [overlayMode, setOverlayMode] = useState<'corner' | 'center-popup' | 'center-countdown' | 'shutdown'>('corner')
  const [bannerMessage, setBannerMessage] = useState<string | null>(null)
  const [approvalPin, setApprovalPin] = useState('')
  const [approvalError, setApprovalError] = useState('')
  const [approvalPending, setApprovalPending] = useState(false)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [primaryGameId, setPrimaryGameId] = useState<ManagedGameId | null>(null)
  const [activeGameIds, setActiveGameIds] = useState<ManagedGameId[]>([])
  const [dailyRemainingSeconds, setDailyRemainingSeconds] = useState<number | null>(null)
  const [dailyExhausted, setDailyExhausted] = useState(false)
  const [sessionsCompleted, setSessionsCompleted] = useState(0)
  const [sessionsPerDay, setSessionsPerDay] = useState(1)
  const [currentSessionActive, setCurrentSessionActive] = useState(false)
  const [surface, setSurface] = useState<'play' | 'rules'>('play')
  const [presentation, dispatchPresentation] = useReducer(reduceTimerPresentation, INITIAL_TIMER_PRESENTATION)
  const [remoteState, setRemoteState] = useState<RemoteApprovalState | null>(null)
  const [remoteNow, setRemoteNow] = useState(Date.now())
  const [remoteRequestPending, setRemoteRequestPending] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [remoteRequestGameId, setRemoteRequestGameId] = useState<ManagedGameId | null>(null)

  const isRunningRef = useRef(false)
  const dailyExhaustedRef = useRef(false)
  const approvalDialogRef = useRef<HTMLDivElement | null>(null)
  const approvalBackgroundRef = useRef<HTMLDivElement | null>(null)
  const approvalTriggerRef = useRef<HTMLElement | null>(null)
  const refreshedRemoteExpiryRef = useRef<number | null>(null)

  const hideMainWindow = (event?: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    event?.stopPropagation()
    const api = window.api
    if (!api) {
      showBanner('창 제어 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    try {
      api.hideMainWindowNow()
      void api.hideMainWindow().catch(() => showBanner('창을 숨기지 못했어요. 다시 시도해주세요.'))
    } catch {
      showBanner('창을 숨기지 못했어요. 다시 시도해주세요.')
    }
  }

  useEffect(() => { isRunningRef.current = isRunning }, [isRunning])
  useEffect(() => { dailyExhaustedRef.current = dailyExhausted }, [dailyExhausted])
  useEffect(() => {
    onActiveChange?.(isRunning || presentation.mode === 'termination-failed-sticky' || presentation.blockedReason !== null)
  }, [isRunning, onActiveChange, presentation.mode, presentation.blockedReason])
  useEffect(() => {
    setSurface(requestedSurface)
  }, [requestedSurface])

  useEffect(() => {
    const api = window.api
    if (!api) {
      showBanner('앱 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    void api.readSettings()
      .then(setSettings)
      .catch(() => showBanner('설정을 불러오지 못했어요.'))
  }, [])

  useEffect(() => {
    if (visible) refreshDailyUsage()
  }, [visible])

  function refreshDailyUsage() {
    const getDailyRemaining = window.api?.dailyGetRemaining
    if (!getDailyRemaining) {
      showBanner('사용 시간 정보를 불러올 수 없어요.')
      return
    }
    void getDailyRemaining()
      .then((result) => {
        setDailyRemainingSeconds(result.remainingSeconds)
        setDailyExhausted(result.exhausted)
        setSessionsCompleted(result.sessionsCompleted)
        setSessionsPerDay(result.sessionsPerDay)
        setCurrentSessionActive(result.currentSessionActive)
      })
      .catch(() => showBanner('사용 시간 정보를 불러오지 못했어요.'))
  }

  function applyManagedGameStatus(status: { primaryGameId?: ManagedGameId; activeGameIds?: ManagedGameId[] }) {
    const nextActiveGameIds = Array.isArray(status.activeGameIds) ? [...status.activeGameIds] : []
    setActiveGameIds(nextActiveGameIds)
    setPrimaryGameId(status.primaryGameId ?? nextActiveGameIds[0] ?? null)
  }

  function showBanner(message: string) {
    setBannerMessage(message)
    setTimeout(() => setBannerMessage(null), 3000)
  }

  function syncTimerStatus() {
    const getStatus = window.api?.timerGetStatus
    if (!getStatus) {
      showBanner('타이머 상태를 불러올 수 없어요.')
      return
    }
    void getStatus()
      .then((status) => {
        applyManagedGameStatus(status)
        if (status.running && isFinite(status.remainingSeconds) && status.remainingSeconds > 0) {
          setIsRunning(true)
          dispatchPresentation({ type: 'RUNNING' })
          setOverlayMode(status.mode ?? 'corner')
          setRemainingSeconds(status.remainingSeconds)
          setBlockedMessage(null)
          return
        }
        setIsRunning(false)
        dispatchPresentation({ type: 'STATUS', running: false })
        setOverlayMode(status.mode ?? 'corner')
        setRemainingSeconds(0)
      })
      .catch(() => showBanner('타이머 상태를 불러오지 못했어요.'))
  }
  async function refreshRemoteState(): Promise<RemoteApprovalState | null> {
    const getState = window.api?.remoteGetState
    if (!getState) return null
    try {
      const state = await getState()
      setRemoteState(state)
      setRemoteError('')
      return state
    } catch {
      setRemoteState((current) => current ? { ...current, lifecycle: 'error', updatedAt: Date.now() } : current)
      setRemoteError('부모님 승인 서비스 상태를 확인할 수 없어요.')
      return null
    }
  }

  const handleRemoteRequest = async () => {
    const createRequest = window.api?.remoteCreateRequest
    const gameId = remoteRequestGameId ?? primaryGameId
    if (!createRequest || !gameId || remoteRequestPending) {
      if (!gameId) setRemoteError('Minecraft 또는 Roblox를 먼저 실행한 뒤 승인 요청을 보내주세요.')
      return
    }
    setRemoteRequestPending(true)
    setRemoteError('')
    try {
      const request = await createRequest(gameId)
      setRemoteRequestGameId(request.gameId as ManagedGameId)
      setRemoteState((current) => ({
        lifecycle: 'request-pending',
        householdId: request.householdId,
        pcId: request.pcId,
        membershipEpoch: request.membershipEpoch,
        serviceEpoch: request.serviceEpoch,
        request,
        updatedAt: Date.now(),
        grant: current?.grant,
      }))
      await refreshRemoteState()
    } catch {
      setRemoteError('승인 요청을 보내지 못했어요. 연결 상태를 확인해주세요.')
      await refreshRemoteState()
    } finally {
      setRemoteRequestPending(false)
    }
  }

  useEffect(() => {
    refreshRemoteState()
    const clock = window.setInterval(() => setRemoteNow(Date.now()), 1000)
    const poll = window.setInterval(() => { void refreshRemoteState() }, 5000)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(poll)
    }
  }, [])

  useEffect(() => {
    syncTimerStatus()
  }, [])

  const handleStartTimer = async (limitMinutes?: number) => {
    const api = window.api
    if (!api) {
      showBanner('타이머 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    const activeSettings = settings ?? DEFAULT_PUBLIC_SETTINGS
    const limit = limitMinutes ?? getTodayAllowedMinutes(activeSettings)
    if (!isFinite(limit) || limit <= 0) return

    const now = new Date()
    setTerminationError(null)
    setSessionStartTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
    setOverlayMode('corner')

    const startAttempt = await attemptTimerStart(limit, (minutes) => api.startTimer(minutes))
    if (!startAttempt.value) {
      setSessionStartTime('')
      showBanner(startAttempt.error)
      return
    }
    const result = startAttempt.value

    if (result?.blocked) {
      setSessionStartTime('')
      setBlockedMessage(result.blocked === 'outside-hours'
        ? `${activeSettings.allowedStartHour}시 ~ ${activeSettings.allowedEndHour}시에만 게임을 실행할 수 있어요.`
        : result.blocked === 'approval-required'
          ? '부모님 PIN 승인 후 게임을 시작할 수 있어요.'
          : result.blocked === 'managed-game-not-running'
            ? '게임이 실행 중일 때만 타이머가 시작돼요.'
            : '게임을 시작할 수 없어요.')
      refreshDailyUsage()
      return
    }

    if (result?.exhausted) {
      setDailyExhausted(true)
      setDailyRemainingSeconds(0)
      setSessionStartTime('')
      setBlockedMessage('오늘 게임 시간을 모두 사용했어요.')
      refreshDailyUsage()
      return
    }

    const nextRemainingSeconds = result?.remainingSeconds
    if (!isFinite(nextRemainingSeconds) || nextRemainingSeconds <= 0) {
      setSessionStartTime('')
      return
    }

    setApprovalPin('')
    setApprovalError('')
    setIsRunning(true)
    dispatchPresentation({ type: 'RUNNING' })
    setBlockedMessage(null)
    setRemainingSeconds(nextRemainingSeconds)
  }

  const handleParentApprovalAndStart = async (limitMinutes?: number, candidate = approvalPin) => {
    const api = window.api
    if (approvalPending) return
    if (!/^\d{4}$/.test(candidate)) {
      setApprovalError('PIN 4자리를 입력해주세요.')
      return
    }
    try {
      setApprovalPending(true)
      setApprovalError('')
      const attempt = await attemptParentApproval(candidate, api?.adminApproveNextSession)
      setApprovalPin(attempt.pin)
      const approval = attempt.value
      if (!approval?.ok) {
        setApprovalError(attempt.error)
        return
      }
      setApprovalError('')
      setApprovalOpen(false)
      showBanner('PIN 승인 완료. 타이머는 시작되지 않아요. 게임을 직접 다시 실행해주세요.')
      return
    } finally {
      setApprovalPending(false)
    }
  }

  useEffect(() => {
    const api = window.api
    if (!api) return
    const removeDetected = api.onSupportedGameDetected((event) => {
      applyManagedGameStatus(event)
      const detectedLabel = getManagedGameDisplayName(event.gameId)
      const wasRunning = isRunningRef.current
      if (!wasRunning && !dailyExhaustedRef.current) {
        const now = new Date()
        setSessionStartTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`)
      }
      api.timerGetStatus().then((status) => {
        applyManagedGameStatus(status)
        setBlockedMessage(null)
        if (status.running && isFinite(status.remainingSeconds) && status.remainingSeconds > 0) {
          setIsRunning(true)
          dispatchPresentation({ type: 'RUNNING' })
          setOverlayMode(status.mode ?? 'corner')
          setRemainingSeconds(status.remainingSeconds)
        }
        showBanner(!wasRunning && status.running
          ? `🎮 ${detectedLabel} 감지! 타이머 자동 시작...`
          : `🎮 ${detectedLabel} 감지! 함께 관리 중이에요.`)
      })
    })
    const removeClosed = api.onSupportedGameClosed((event) => {
      applyManagedGameStatus(event)
      if ((event.activeGameIds?.length ?? 0) > 0) {
        api.timerGetStatus().then((status) => {
          applyManagedGameStatus(status)
          if (status.running && isFinite(status.remainingSeconds) && status.remainingSeconds > 0) {
            setIsRunning(true)
            setOverlayMode(status.mode ?? 'corner')
            setRemainingSeconds(status.remainingSeconds)
          }
        })
        refreshDailyUsage()
        return
      }
      setIsRunning(false)
      dispatchPresentation({ type: 'GAME_CLOSED', activeGameCount: 0 })
      setOverlayMode('corner')
      setRemainingSeconds(0)
      setBlockedMessage(null)
      setSessionStartTime('')
      refreshDailyUsage()
    })
    return () => {
      removeDetected()
      removeClosed()
    }
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerResumed(({ remainingSeconds: next }) => {
      if (!isFinite(next) || next <= 0) return
      setIsRunning(true)
      dispatchPresentation({ type: 'RUNNING' })
      setRemainingSeconds(next)
      setBlockedMessage(null)
      setOverlayMode('corner')
      syncTimerStatus()
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerAdminStopped(() => {
      setIsRunning(false)
      dispatchPresentation({ type: 'ADMIN_STOPPED' })
      setOverlayMode('corner')
      setRemainingSeconds(0)
      setTerminationError(null)
      setSessionStartTime('')
      setBlockedMessage(null)
      setPrimaryGameId(null)
      setActiveGameIds([])
      refreshDailyUsage()
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerTick(({ remainingSeconds: next }) => {
      if (isFinite(next)) {
        setIsRunning(true)
        dispatchPresentation({ type: 'RUNNING' })
        setRemainingSeconds(next)
      }
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerWarning(({ minutesLeft }) => {
      setIsRunning(true)
      const message = minutesLeft === 0 ? '⏰ 30초 남았어!' : `⚠️ ${minutesLeft}분 남았어!`
      setWarningMessage(message)
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerExpired(() => {
      setIsRunning(false)
      dispatchPresentation({ type: 'EXPIRED' })
      setOverlayMode('corner')
      setWarningMessage(null)
      setTerminationError(null)
      setPrimaryGameId(null)
      setActiveGameIds([])
      refreshDailyUsage()
      setRemainingSeconds(0)
      setBlockedMessage(null)
      setSessionStartTime('')
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerTerminationFailed(({ message, remainingGameIds }) => {
      const gameNames = remainingGameIds
        .map((gameId) => gameId === 'minecraft' ? 'Minecraft' : gameId === 'roblox' ? 'Roblox' : gameId)
        .join(', ')
      setTerminationError(gameNames ? `${message} (${gameNames})` : message)
      setIsRunning(true)
      dispatchPresentation({ type: 'TERMINATION_FAILED' })
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onSupportedGameBlocked(({ gameId, message, reason }) => {
      setRemoteRequestGameId(gameId)
      setBlockedMessage(message)
      if (reason === 'daily-exhausted') {
        setDailyExhausted(true)
        setDailyRemainingSeconds(0)
      }
      dispatchPresentation({ type: 'BLOCKED', reason })
      refreshDailyUsage()
    })
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerMode(({ mode }) => {
      if (mode !== 'shutdown') setIsRunning(true)
      if (mode === 'shutdown') dispatchPresentation({ type: 'MODE_SHUTDOWN' })
      setOverlayMode(mode as typeof overlayMode)
    })
  }, [])

  useEffect(() => {
    if (!warningMessage) return
    const timer = setTimeout(() => setWarningMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [warningMessage])

  const displaySettings = settings ?? DEFAULT_PUBLIC_SETTINGS
  const todayLimitMinutes = getTodayAllowedMinutes(displaySettings)
  const dayType = isWeekend(new Date()) ? '주말' : '평일'
  const now = new Date()
  const hour = now.getHours()
  const isStartable = isHourAllowed(hour, displaySettings.allowedStartHour, displaySettings.allowedEndHour)

  const displayRemainingSeconds = dailyRemainingSeconds ?? (todayLimitMinutes * 60)
  const displayRemainingMinutes = Math.ceil(displayRemainingSeconds / 60)
  const canStart = isStartable && !dailyExhausted
  const requiresParentApproval = displaySettings.requireApprovalBeforeStart && !currentSessionActive
  const remoteExpiry = remoteState?.grant?.expiresAt ?? remoteState?.request?.expiresAt ?? null
  const remoteSecondsRemaining = remoteExpiry === null ? 0 : Math.max(0, Math.ceil((remoteExpiry - remoteNow) / 1000))
  const remoteIsOutage = remoteState?.lifecycle === 'offline' || remoteState?.lifecycle === 'error'
  const remoteLoading = remoteState === null
  const remoteRequestExpired = remoteState?.lifecycle === 'expired' || (remoteExpiry !== null && remoteSecondsRemaining === 0)
  useEffect(() => {
    if (remoteExpiry !== null && remoteSecondsRemaining === 0 && refreshedRemoteExpiryRef.current !== remoteExpiry) {
      refreshedRemoteExpiryRef.current = remoteExpiry
      void refreshRemoteState()
    }
    if (remoteExpiry !== null && remoteSecondsRemaining > 0) refreshedRemoteExpiryRef.current = null
  }, [remoteExpiry, remoteSecondsRemaining])
  const secondaryGameIds = listSecondaryManagedGames(primaryGameId, activeGameIds)
  const primaryGameLabel = primaryGameId ? getManagedGameDisplayName(primaryGameId) : null
  const runningGameSummary = primaryGameLabel
    ? secondaryGameIds.length > 0
      ? `${primaryGameLabel} + ${secondaryGameIds.map(getManagedGameDisplayName).join(', ')}`
      : primaryGameLabel
    : '현재 남은 시간 경고'

  useEffect(() => {
    if (approvalOpen && approvalPin.length === 4 && !approvalPending && !isRunning) {
      void handleParentApprovalAndStart(undefined, approvalPin)
    }
  }, [approvalOpen, approvalPin, approvalPending, isRunning])

  const closeApproval = () => {
    setApprovalOpen(false)
    setApprovalPin('')
    setApprovalError('')
  }
  useModalFocusBoundary(approvalOpen, approvalDialogRef, approvalBackgroundRef, approvalTriggerRef, closeApproval)


  const handlePrimaryStart = () => {
    if (requiresParentApproval) {
      if (remoteIsOutage) {
        approvalTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setApprovalPin('')
        setApprovalError('')
        setApprovalOpen(true)
      } else if (remoteRequestExpired || (remoteState?.lifecycle !== 'request-pending' && remoteState?.lifecycle !== 'approved')) {
        void handleRemoteRequest()
      }
      return
    }
    void handleStartTimer()
  }

  const lockTitle = dailyExhausted
    ? '금일 약속된 게임 타임이 종료되었습니다.'
    : hour < displaySettings.allowedStartHour
      ? `${displaySettings.allowedStartHour}시부터 시작할 수 있어요`
      : '오늘 플레이 시간이 끝났어요'

  const lockCopy = dailyExhausted
    ? '당신의 인생이 플러스가 될 게임을 시작할 시간입니다.'
    : `플레이 가능 시간은 ${displaySettings.allowedStartHour}시 ~ ${displaySettings.allowedEndHour}시예요.`

  if (isRunning) {
  const isStickyTerminationFailure = presentation.mode === 'termination-failed-sticky'
    const { color, glow, tone } = ledColors(remainingSeconds)

    if (overlayMode === 'shutdown' || isStickyTerminationFailure) {
      return (
        <OverlayRoot dragEverywhere>
          <div className="ppt-overlay-card ppt-overlay-card--shutdown" style={{ '--ppt-accent': color, '--ppt-glow': glow } as CSSProperties}>
            <span className="ppt-overlay-card__eyebrow">{terminationError ? '종료 확인 필요' : '게임 시간 완료'}</span>
            <strong className="ppt-overlay-card__title">{terminationError ? '게임을 닫지 못했어요' : '게임 종료 중...'}</strong>
            <p className="ppt-overlay-card__copy">{terminationError ?? '오늘 약속한 게임 시간이 끝났어요.'}</p>
          </div>
        </OverlayRoot>
      )
    }

    if (overlayMode === 'center-countdown') {
      return (
        <OverlayRoot dragEverywhere>
          <div className={`ppt-overlay-card ppt-overlay-card--countdown is-${tone}`} style={{ '--ppt-accent': color, '--ppt-glow': glow } as CSSProperties}>
            <span className="ppt-overlay-card__eyebrow">마지막 카운트다운</span>
            <strong className="ppt-overlay-card__title">{runningGameSummary}</strong>
            <span className="ppt-overlay-card__timer">{formatTime(remainingSeconds)}</span>
          </div>
        </OverlayRoot>
      )
    }

    if (overlayMode === 'center-popup') {
      return (
        <OverlayRoot dragEverywhere>
          <div className={`ppt-overlay-card ppt-overlay-card--warning is-${tone}`} style={{ '--ppt-accent': color, '--ppt-glow': glow } as CSSProperties}>
            {warningMessage ? <span className="ppt-overlay-card__alert">{warningMessage}</span> : null}
            <strong className="ppt-overlay-card__title">{runningGameSummary}</strong>
            <span className="ppt-overlay-card__timer">{formatTime(remainingSeconds)}</span>
          </div>
        </OverlayRoot>
      )
    }

    return (
      <div className="ppt-corner-timer app-drag" style={{ '--ppt-accent': color, '--ppt-glow': glow } as CSSProperties}>
        {warningMessage ? <div className="ppt-corner-timer__warning">{warningMessage}</div> : null}
        <div className={`ppt-corner-timer__panel is-${tone}`}>
          <span className="ppt-corner-timer__label">{runningGameSummary}</span>
          <span className="ppt-corner-timer__time">{formatTime(remainingSeconds)}</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div ref={approvalBackgroundRef} className="ppt-modal-background">
    <SmartphoneShell
      surface={surface}
      title="Playtime Pact"
      nav={(
        <PhoneBottomNav
          current={surface}
          items={[
            { id: 'play', label: 'Play', icon: '▶' },
            { id: 'rules', label: 'Rules', icon: '✓' },
            { id: 'settings', label: 'Settings', icon: '⚙' },
          ]}
          onSelect={(id) => {
            if (id === 'settings') {
              onOpenSettings()
              return
            }
            setSurface(id as 'play' | 'rules')
          }}
        />
      )}
    >
      <div className={`ppt-shell${dailyExhausted && surface === 'play' ? ' ppt-shell--daily-complete' : ''}`}>
      <div className="ppt-topbar app-drag">
        <div className="ppt-brand app-drag">
          <div className="ppt-brand__mark">P</div>
          <div className="ppt-brand__copy">
            <strong>Playtime Pact</strong>
            <span>하루 게임 약속 · Minecraft + Roblox</span>
          </div>
        </div>
        <button
          type="button"
          className="ppt-window-action no-drag window-hide-button"
          onPointerDown={hideMainWindow}
          onClick={hideMainWindow}
          aria-label="창 숨기기"
        >
          −
        </button>
      </div>

      {bannerMessage ? (
        <div className="ppt-floating-banner ppt-floating-banner--info no-drag">
          {bannerMessage}
        </div>
      ) : null}

      {blockedMessage && !dailyExhausted ? (
        <div className={`ppt-floating-banner ppt-floating-banner--danger no-drag${bannerMessage ? ' has-offset' : ''}`}>
          {blockedMessage}
        </div>
      ) : null}

      <section className="ppt-status-strip no-drag" data-glance="status">
        <span className={`ppt-status-strip__dot${primaryGameLabel ? ' is-live' : ''}`} aria-hidden="true" />
        <span className="ppt-status-strip__label">
          {primaryGameLabel ? `${runningGameSummary} 연결됨` : '게임을 켜면 자동 연결'}
        </span>
        <span className="ppt-status-strip__quota">{dayType} {todayLimitMinutes}분 · {sessionsCompleted}/{sessionsPerDay}회</span>
      </section>

      <section className="ppt-clock-card no-drag" data-glance="time">
        <div className="ppt-clock-card__copy">
          <p className="ppt-clock-card__label">
            {dailyExhausted
              ? '오늘 남은 시간'
              : currentSessionActive
                ? '이번 세션 남은 시간'
                : '이번에 놀 수 있는 시간'}
          </p>
          <strong className={`ppt-clock-card__value${dailyExhausted ? ' is-danger' : ''}`}>
            {formatLimitDisplay(displayRemainingMinutes)}
          </strong>
        </div>
        <VoxelCrew variant="home" />
      </section>

      <section className="ppt-action-zone no-drag" data-glance="action">
        {canStart ? (
          <>
            <button type="button" className="ppt-button ppt-button--primary ppt-button--hero" onClick={handlePrimaryStart} disabled={requiresParentApproval && (remoteLoading || remoteRequestPending || (!remoteRequestExpired && (remoteState?.lifecycle === 'request-pending' || remoteState?.lifecycle === 'approved')))}>
              {requiresParentApproval
                ? remoteLoading
                  ? '원격 승인 상태 확인 중...'
                  : remoteIsOutage
                    ? '부모님 승인하고 시작'
                    : remoteState?.lifecycle === 'approved'
                      ? '승인됨 · 게임을 다시 실행하세요'
                      : remoteState?.lifecycle === 'request-pending'
                        ? '부모님 응답 기다리는 중'
                        : remoteRequestPending ? '요청 보내는 중...' : '부모님께 승인 요청'
                : '게임 타임 시작'}
            </button>
            <p className="ppt-helper-text">
              {requiresParentApproval
                ? remoteLoading
                  ? '원격 승인 상태를 확인하는 동안에는 PIN 대체 승인을 사용할 수 없어요.'
                  : remoteIsOutage
                    ? '승인 서비스 연결이 안 될 때만 부모님 PIN으로 확인할 수 있어요.'
                    : '부모님께 요청을 보내면, 승인 후 게임을 직접 다시 실행해야 해요.'
                : 'Minecraft나 Roblox를 켜면 자동으로 이어져요.'}
            </p>
            {requiresParentApproval ? (
              <div className={`ppt-remote-status${remoteIsOutage || remoteRequestExpired ? ' is-warning' : ''}`} role="status" aria-live="polite">
                {remoteState?.lifecycle === 'request-pending' && !remoteRequestExpired ? (
                  <><strong>부모님 응답 대기 중 · {formatTime(remoteSecondsRemaining)}</strong><p>요청은 5분 뒤 만료돼요. 승인되면 게임을 직접 다시 실행해주세요.</p></>
                ) : remoteState?.lifecycle === 'approved' && !remoteRequestExpired ? (
                  <><strong>승인됨 · {formatTime(remoteSecondsRemaining)}</strong><p>자동으로 게임을 시작하지 않아요. {primaryGameLabel ?? '게임'}을 직접 다시 실행해주세요.</p></>
                ) : remoteRequestExpired ? (
                  <><strong>요청 또는 승인이 만료됐어요.</strong><p>게임이 실행 중이면 새 승인 요청을 보낼 수 있어요.</p></>
                ) : remoteLoading ? (
                  <><strong>원격 승인 상태 확인 중</strong><p>연결 상태를 확인하는 동안에는 PIN 대체 승인을 사용할 수 없어요.</p></>
                ) : remoteIsOutage ? (
                  <><strong>부모님 승인 서비스 연결 안 됨</strong><p>이 경우에만 부모님 PIN 대체 승인을 사용할 수 있어요.</p></>
                ) : (
                  <><strong>원격 승인 준비됨</strong><p>게임을 실행한 뒤 승인 요청을 보내주세요.</p></>
                )}
                {remoteError ? <p className="ppt-inline-message ppt-inline-message--danger">{remoteError}</p> : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className={`ppt-lock-state${dailyExhausted ? ' ppt-lock-state--complete' : ''}`} role="status">
            <strong>{lockTitle}</strong>
            <p>{lockCopy}</p>
            {dailyExhausted ? <span className="ppt-lock-state__encouragement">Do Your Best !!</span> : null}
            {dailyExhausted && !displaySettings.requireApprovalBeforeStart ? <button type="button" className="ppt-lock-state__request" aria-label="부모님께 추가 시간 요청" onClick={onOpenSettings}>추가 요청</button> : null}
          </div>
        )}

        {import.meta.env.DEV && !dailyExhausted ? (
          <button
            type="button"
            className="ppt-button ppt-button--ghost ppt-button--small"
            onClick={() => requiresParentApproval ? handleParentApprovalAndStart(2) : handleStartTimer(2)}
          >
            테스트 세션 (2분)
          </button>
        ) : null}
      </section>

      <details className="ppt-rules-details no-drag" open={surface === 'rules'}>
        <summary>오늘 규칙 보기</summary>
        <ul>
          <li>플레이 가능 <strong>{displaySettings.allowedStartHour}시 – {displaySettings.allowedEndHour}시</strong></li>
          <li>세션당 <strong>{todayLimitMinutes}분</strong> · 하루 <strong>{sessionsPerDay}회</strong></li>
          <li>{secondaryGameIds.length > 0
            ? `함께 실행 중 · ${secondaryGameIds.map(getManagedGameDisplayName).join(', ')}`
            : 'Minecraft와 Roblox가 같은 하루 시간을 나눠 써요.'}</li>
          <li>{sessionStartTime ? `최근 시작 ${sessionStartTime}` : '게임을 켜면 타이머가 자동으로 시작돼요.'}</li>
        </ul>
      </details>

      <div className="ppt-meadow no-drag" aria-hidden="true" />

      <div className="ppt-phone-spacer" aria-hidden="true" />

      </div>
    </SmartphoneShell>
      </div>
      {approvalOpen ? (
        <div className="ppt-modal-backdrop app-drag" role="presentation">
          <div ref={approvalDialogRef} className="ppt-dialog ppt-dialog--pin no-drag" role="dialog" aria-modal="true" aria-labelledby="approval-pin-title" tabIndex={-1}>
            <p className="ppt-dialog__eyebrow">연결 장애 시 대체 승인</p>
            <h2 id="approval-pin-title" className="ppt-dialog__title">PIN을 눌러주세요</h2>
            <PinPad
              id="approval-pin"
              label="부모님 4자리 PIN"
              value={approvalPin}
              onChange={setApprovalPin}
              onSubmit={() => void handleParentApprovalAndStart()}
              onCancel={closeApproval}
              disabled={approvalPending}
              error={approvalError}
              submitLabel={approvalPending ? '확인' : '부모님 승인하고 시작'}
            />
          </div>
        </div>
      ) : null}
    </>
  )
}
