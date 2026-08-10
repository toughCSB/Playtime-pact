import { useEffect, useRef, useState } from 'react'
import VoxelCrew from '../components/VoxelCrew'
import PinPad from '../components/PinPad'
import SmartphoneShell from '../components/SmartphoneShell'
import PhoneBottomNav from '../components/PhoneBottomNav'

type Stage = 'pin' | 'admin'

export function isTimerTickActive(remainingSeconds: number): boolean {
  return isFinite(remainingSeconds) && remainingSeconds > 0
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function PinStage({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [lockoutSeconds, setLockoutSeconds] = useState(0)
  const [verifying, setVerifying] = useState(false)


  useEffect(() => {
    if (lockoutSeconds <= 0) return
    const timer = setInterval(() => {
      setLockoutSeconds((current) => {
        if (current <= 1) {
          clearInterval(timer)
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [lockoutSeconds])


  const handleConfirm = async (candidate = pin) => {
    if (candidate.length !== 4 || lockoutSeconds > 0 || verifying) return
    setVerifying(true)
    try {
      const verifyPassword = window.api?.adminVerifyPassword
      if (!verifyPassword) {
        setPin('')
        setError('인증 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
        return
      }
      const ok = await verifyPassword(candidate)
      if (ok) {
        onSuccess()
        return
      }
      const next = attempts + 1
      setAttempts(next)
      setPin('')
      if (next >= 5) {
        setAttempts(0)
        setLockoutSeconds(30)
        setError('5회 실패. 30초 후 재시도.')
      } else {
        setError(`비밀번호가 틀렸어요. (${next}/5)`)
        setTimeout(() => setError(''), 2000)
      }
    } catch {
      setPin('')
      setError('인증에 실패했어요. 잠시 후 다시 시도하세요.')
    } finally {
      setVerifying(false)
    }
  }

  useEffect(() => {
    if (pin.length === 4 && lockoutSeconds <= 0 && !verifying) {
      void handleConfirm(pin)
    }
  }, [pin, lockoutSeconds, verifying])

  const handleClose = async () => {
    const closeWindow = window.api?.adminCloseWindow
    if (!closeWindow) {
      setError('창 제어 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    try {
      await closeWindow()
    } catch {
      setError('관리자 창을 닫지 못했어요. 다시 시도해주세요.')
    }
  }

  const isLocked = lockoutSeconds > 0

  return (
    <div className="ppt-admin-shell">
      <div className="ppt-admin-topbar app-drag">
        <div className="ppt-brand app-drag">
          <div className="ppt-brand__mark">P</div>
          <div className="ppt-brand__copy">
            <strong>Playtime Pact</strong>
            <span>부모님 전용</span>
          </div>
        </div>
        <button type="button" className="ppt-window-action no-drag" onClick={() => void handleClose()} aria-label="닫기">
          ×
        </button>
      </div>

      <div className="ppt-admin-auth no-drag">
        <div className="ppt-dialog ppt-dialog--pin ppt-dialog--admin-auth">
          <p className="ppt-dialog__eyebrow">부모님 인증</p>
          <h1 className="ppt-dialog__title">PIN을 눌러주세요</h1>
          <PinPad
            id="admin-pin-input"
            label="부모님 4자리 PIN"
            value={pin}
            onChange={setPin}
            onSubmit={() => void handleConfirm()}
            onCancel={() => void handleClose()}
            cancelLabel="닫기"
            disabled={isLocked || verifying}
            error={isLocked ? `${lockoutSeconds}초 후 재시도 가능` : error}
          />
        </div>
      </div>
    </div>
  )
}

function AdminStage({ destination }: { destination: 'timer' | 'safety' }) {
  const [timerRunning, setTimerRunning] = useState(false)
  const [remainingSeconds, setRemainingSeconds] = useState(0)
  const [resumeEnabled, setResumeEnabled] = useState(true)
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState(false)
  const [addMsg, setAddMsg] = useState('')
  const [addError, setAddError] = useState(false)
  const [manualMinutes, setManualMinutes] = useState('')
  const [adjustSign, setAdjustSign] = useState<1 | -1>(1)
  const [changingPassword, setChangingPassword] = useState(false)
  const [resumePending, setResumePending] = useState(false)
  const [resumeMsg, setResumeMsg] = useState('')
  const [resumeError, setResumeError] = useState(false)
  const dashboardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const api = window.api
    if (!api) {
      setAddMsg('관리자 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      setResumeError(true)
      setResumeMsg('재부팅 설정을 불러오지 못했어요.')
    } else {
      void api.timerGetStatus()
        .then((status) => {
          setTimerRunning(status.running)
          setRemainingSeconds(status.remainingSeconds)
        })
        .catch(() => setAddMsg('타이머 상태를 불러오지 못했어요.'))
      void api.adminGetResumeOption()
        .then(setResumeEnabled)
        .catch(() => {
          setResumeError(true)
          setResumeMsg('재부팅 설정을 불러오지 못했어요.')
        })
    }
    window.requestAnimationFrame(() => dashboardRef.current?.focus())
  }, [])

  useEffect(() => {
    const api = window.api
    if (!api) return
    return api.onTimerTick(({ remainingSeconds: next }) => {
      setTimerRunning(isTimerTickActive(next))
      setRemainingSeconds(next)
    })
  }, [])

  const refreshTimerStatus = async () => {
    const getStatus = window.api?.timerGetStatus
    if (!getStatus) throw new Error('Timer status bridge unavailable')
    const status = await getStatus()
    setTimerRunning(status.running)
    setRemainingSeconds(status.remainingSeconds)
  }

  const handleAdjustTime = async (minutes: number) => {
    if (!Number.isInteger(minutes) || minutes === 0) {
      setAddError(true)
      setAddMsg('0이 아닌 분 단위로 입력해주세요')
      setTimeout(() => setAddMsg(''), 2000)
      return
    }
    try {
      setAddError(false)
      const adjustTime = window.api?.timerAdjustTime
      if (!adjustTime) throw new Error('Timer adjustment bridge unavailable')
      const result = await adjustTime(minutes)
      if (result && isFinite(result.remainingSeconds)) {
        setRemainingSeconds(result.remainingSeconds)
        setTimerRunning(result.remainingSeconds > 0)
      } else {
        await refreshTimerStatus()
      }
      setAddMsg(minutes > 0 ? `+${minutes}분 추가됐어요` : `${minutes}분 차감됐어요`)
      setManualMinutes('')
      setTimeout(() => setAddMsg(''), 2000)
    } catch {
      setAddError(true)
      setAddMsg('시간 변경에 실패했어요')
      setTimeout(() => setAddMsg(''), 2000)
    }
  }

  const handleManualAdjust = async () => {
    const minutes = Number(manualMinutes)
    await handleAdjustTime(minutes)
  }

  const handleStopTimer = async () => {
    try {
      setAddError(false)
      const stopTimer = window.api?.timerAdminStop
      if (!stopTimer) throw new Error('Timer stop bridge unavailable')
      await stopTimer()
      setTimerRunning(false)
      setRemainingSeconds(0)
    } catch {
      setAddError(true)
      setAddMsg('타이머 중지에 실패했어요.')
      setTimeout(() => setAddMsg(''), 2000)
    }
  }

  const handleToggleResume = async () => {
    if (resumePending) return
    const next = !resumeEnabled
    setResumePending(true)
    setResumeError(false)
    setResumeMsg('재부팅 정책을 저장 중이에요...')
    setResumeEnabled(next)
    try {
      const setResumeOption = window.api?.adminSetResumeOption
      if (!setResumeOption) throw new Error('Resume settings bridge unavailable')
      await setResumeOption(next)
      setResumeMsg(next ? '재부팅 후에도 타이머를 이어서 시작해요.' : '재부팅 시 새로 시작하도록 저장했어요.')
      setTimeout(() => setResumeMsg(''), 2200)
    } catch {
      setResumeEnabled(!next)
      setResumeError(true)
      setResumeMsg('재부팅 설정 저장에 실패했어요.')
      setTimeout(() => setResumeMsg(''), 2500)
    } finally {
      setResumePending(false)
    }
  }

  const handleChangePassword = async () => {
    if (changingPassword) return
    if (!pwNew || pwNew !== pwConfirm) {
      setPwMsg('새 비밀번호가 일치하지 않아요')
      setPwError(true)
      setTimeout(() => setPwMsg(''), 2500)
      return
    }
    if (!/^\d{4}$/.test(pwNew)) {
      setPwMsg('새 비밀번호는 숫자 4자리여야 해요')
      setPwError(true)
      setTimeout(() => setPwMsg(''), 2500)
      return
    }
    setChangingPassword(true)
    try {
      const api = window.api
      if (!api) throw new Error('Admin bridge unavailable')
      const ok = await api.adminVerifyPassword(pwCurrent)
      if (!ok) {
        setPwMsg('현재 비밀번호가 틀렸어요')
        setPwError(true)
        setTimeout(() => setPwMsg(''), 2500)
        return
      }
      await api.adminChangePassword(pwCurrent, pwNew)
      setPwCurrent('')
      setPwNew('')
      setPwConfirm('')
      setPwMsg('비밀번호가 변경됐어요')
      setPwError(false)
      setTimeout(() => setPwMsg(''), 3000)
    } catch {
      setPwMsg('비밀번호 변경에 실패했어요')
      setPwError(true)
      setTimeout(() => setPwMsg(''), 2500)
    } finally {
      setChangingPassword(false)
    }
  }

  const handleCloseWindow = async () => {
    const closeWindow = window.api?.adminCloseWindow
    if (!closeWindow) {
      setAddMsg('창 제어 서비스에 연결할 수 없어요.')
      return
    }
    try {
      await closeWindow()
    } catch {
      setAddMsg('관리자 창을 닫지 못했어요.')
    }
  }

  const handleShowMain = async () => {
    const api = window.api
    if (!api) {
      setAddMsg('창 제어 서비스에 연결할 수 없어요.')
      return
    }
    try {
      await api.showMainWindow()
      await api.adminCloseWindow()
    } catch {
      setAddMsg('메인 창을 열지 못했어요.')
    }
  }

  const quickAdjustments = [5, 10, 15, 30, 60]

  return (
    <div className="ppt-admin-shell" data-admin-destination={destination}>
      <div className="ppt-admin-topbar app-drag">
        <div className="ppt-brand app-drag">
          <div className="ppt-brand__mark">P</div>
          <div className="ppt-brand__copy">
            <strong>Playtime Pact</strong>
            <span>부모님 전용</span>
          </div>
        </div>
        <div className="ppt-admin-topbar__actions no-drag">
          <button type="button" className="ppt-button ppt-button--secondary ppt-button--small" onClick={() => void handleShowMain()}>
            메인
          </button>
          <button type="button" className="ppt-window-action" onClick={() => void handleCloseWindow()} aria-label="닫기">
            ×
          </button>
        </div>
      </div>

      <div ref={dashboardRef} className="ppt-admin-scroll no-drag" tabIndex={-1} aria-label="관리자 대시보드">
        <section className="ppt-admin-hero">
          <div>
            <p className="ppt-card__eyebrow">부모님 전용 컨트롤</p>
            <h1 className="ppt-card__title">게임 마스터 룸</h1>
            <p className="ppt-card__body">남은 시간과 안전 설정을 한눈에 관리해요.</p>
          </div>
          <VoxelCrew variant="admin" />
        </section>

        <section className="ppt-card ppt-card--panel" data-admin-panel="timer">
          <div className="ppt-card__header">
            <div>
              <p className="ppt-card__eyebrow">현재 게임 시간</p>
              <h2 className="ppt-card__title">타이머 상태</h2>
            </div>
            <span className={`ppt-badge${timerRunning ? ' is-success' : ''}`}>{timerRunning ? '실행 중' : '대기 중'}</span>
          </div>
          {timerRunning ? (
            <>
              <div className="ppt-display ppt-display--compact">
                <span className="ppt-display__label">남은 시간</span>
                <strong className="ppt-display__value">{formatTime(remainingSeconds)}</strong>
              </div>

              {addMsg ? <p className={`ppt-inline-message ${addError ? 'ppt-inline-message--danger' : 'ppt-inline-message--success'}`}>{addMsg}</p> : null}

              <div className="ppt-section-block">
                <div className="ppt-section-block__header">
                  <strong>빠른 조정</strong>
                  <span>{adjustSign > 0 ? '시간 추가' : '시간 차감'}</span>
                </div>
                <div className="ppt-segmented" role="group" aria-label="시간 조정 방향">
                  <button type="button" className={adjustSign > 0 ? 'is-active' : ''} aria-pressed={adjustSign > 0} onClick={() => setAdjustSign(1)}>추가</button>
                  <button type="button" className={adjustSign < 0 ? 'is-active is-warning' : ''} aria-pressed={adjustSign < 0} onClick={() => setAdjustSign(-1)}>차감</button>
                </div>
                <div className="ppt-chip-grid">
                  {quickAdjustments.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      className={`ppt-chip ${adjustSign > 0 ? 'ppt-chip--positive' : 'ppt-chip--warning'}`}
                      onClick={() => handleAdjustTime(adjustSign * minutes)}
                    >
                      {adjustSign > 0 ? '+' : '-'}{minutes}분
                    </button>
                  ))}
                </div>
              </div>

              <div className="ppt-section-block">
                <div className="ppt-section-block__header">
                  <strong>직접 입력</strong>
                  <span>예: 25 / -10</span>
                </div>
                <div className="ppt-inline-form">
                  <input
                    type="number"
                    value={manualMinutes}
                    placeholder="예: 25 또는 -10"
                    onChange={(event) => setManualMinutes(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void handleManualAdjust() }}
                    className="ppt-input"
                  />
                  <button type="button" className="ppt-button ppt-button--secondary" onClick={() => void handleManualAdjust()}>
                    적용
                  </button>
                </div>
              </div>

              <button type="button" className="ppt-button ppt-button--danger" onClick={handleStopTimer}>
                타이머 중지
              </button>
            </>
          ) : (
            <p className="ppt-card__body">타이머가 실행 중이 아닙니다.</p>
          )}
        </section>

        <section className="ppt-card ppt-card--panel" data-admin-panel="safety">
          <div className="ppt-card__header">
            <div>
              <p className="ppt-card__eyebrow">다시 시작할 때</p>
              <h2 className="ppt-card__title">재부팅 설정</h2>
            </div>
          </div>
          <label className="ppt-toggle-card">
            <div>
              <strong>재부팅 후 타이머 유지</strong>
              <p>컴퓨터를 다시 켜도 타이머가 이어집니다.</p>
            </div>
            <span className={`ppt-toggle${resumeEnabled ? ' is-on' : ''}`} aria-hidden="true">
              <span className="ppt-toggle__thumb" />
            </span>
            <input type="checkbox" checked={resumeEnabled} onChange={handleToggleResume} className="ppt-toggle-card__input" disabled={resumePending} />
          </label>
          <div className="ppt-status-slot" aria-live="polite">
            {resumeMsg ? <p className={`ppt-inline-message ${resumeError ? 'ppt-inline-message--danger' : 'ppt-inline-message--success'}`}>{resumeMsg}</p> : null}
          </div>
        </section>

        <details className="ppt-card ppt-card--panel ppt-admin-disclosure" data-admin-panel="safety">
          <summary>부모 PIN 변경</summary>
          <div className="ppt-form-stack">
            <label className="ppt-field-group" htmlFor="admin-current-pin">
              <span className="ppt-field-label">현재 PIN</span>
              <input
                id="admin-current-pin"
                type="password"
                value={pwCurrent}
                maxLength={4}
                inputMode="numeric"
                onChange={(event) => setPwCurrent(event.target.value.replace(/\D/g, '').slice(0, 4))}
                className="ppt-input"
              />
            </label>
            <label className="ppt-field-group" htmlFor="admin-new-pin">
              <span className="ppt-field-label">새 PIN</span>
              <input
                id="admin-new-pin"
                type="password"
                value={pwNew}
                maxLength={4}
                inputMode="numeric"
                onChange={(event) => setPwNew(event.target.value.replace(/\D/g, '').slice(0, 4))}
                className="ppt-input"
              />
            </label>
            <label className="ppt-field-group" htmlFor="admin-confirm-pin">
              <span className="ppt-field-label">새 PIN 확인</span>
              <input
                id="admin-confirm-pin"
                type="password"
                value={pwConfirm}
                maxLength={4}
                inputMode="numeric"
                onChange={(event) => setPwConfirm(event.target.value.replace(/\D/g, '').slice(0, 4))}
                className="ppt-input"
                aria-describedby="admin-pin-message"
              />
            </label>
            <div id="admin-pin-message" className="ppt-status-slot" aria-live="polite">
              {pwMsg ? <p className={`ppt-inline-message ${pwError ? 'ppt-inline-message--danger' : 'ppt-inline-message--success'}`}>{pwMsg}</p> : null}
            </div>
            <button type="button" className="ppt-button ppt-button--primary" onClick={() => void handleChangePassword()} disabled={changingPassword}>
              {changingPassword ? '변경 중...' : 'PIN 변경'}
            </button>
          </div>
        </details>
      </div>
    </div>
  )
}

export default function AdminPanel() {
  const [stage, setStage] = useState<Stage>('pin')
  const [destination, setDestination] = useState<'timer' | 'safety'>('timer')

  return (
    <SmartphoneShell
      surface={`admin-${destination}`}
      title="부모님 관리자"
      nav={stage === 'admin' ? (
        <PhoneBottomNav
          current={destination}
          items={[
            { id: 'timer', label: 'Timer', icon: '◷' },
            { id: 'safety', label: 'Safety', icon: '◇' },
          ]}
          onSelect={(id) => setDestination(id as 'timer' | 'safety')}
        />
      ) : undefined}
    >
      <div className="ppt-admin-root">
        {stage === 'pin' ? (
          <PinStage onSuccess={() => setStage('admin')} />
        ) : (
          <AdminStage destination={destination} />
        )}
      </div>
    </SmartphoneShell>
  )
}
