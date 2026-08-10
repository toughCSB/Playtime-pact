import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import type { PairingSession, ParentDevice, PublicSettings, RemoteApprovalHealth } from '../../../shared/types'
import { DEFAULT_PUBLIC_SETTINGS } from '../../../shared/types'
import VoxelCrew from '../components/VoxelCrew'
import { useModalFocusBoundary } from '../components/SmartphoneShell'
import QRCode from 'qrcode'

interface Props {
  onBack: () => void
}

interface SettingsCardProps {
  title: string
  subtitle?: string
  children: ReactNode
}

function SettingsCard({ title, subtitle, children }: SettingsCardProps) {
  return (
    <section className="ppt-card ppt-card--panel no-drag">
      <div className="ppt-card__header">
        <div>
          <p className="ppt-card__eyebrow">게임 규칙</p>
          <h3 className="ppt-card__title">{title}</h3>
        </div>
        {subtitle ? <p className="ppt-card__meta">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

export default function SettingsPage({ onBack }: Props) {
  const [settings, setSettings] = useState<PublicSettings>({ ...DEFAULT_PUBLIC_SETTINGS })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [shutdownConfirmOpen, setShutdownConfirmOpen] = useState(false)
  const [remoteHealth, setRemoteHealth] = useState<RemoteApprovalHealth | null>(null)
  const [pairing, setPairing] = useState<(PairingSession & { uri: string }) | null>(null)
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState('')
  const [remoteAction, setRemoteAction] = useState<'revoke' | 'reset' | 'delete' | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [parentDeviceId, setParentDeviceId] = useState('')
  const [parentDevices, setParentDevices] = useState<ParentDevice[]>([])
  const [remoteStatus, setRemoteStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [remoteRefreshWarning, setRemoteRefreshWarning] = useState('')
  const [remoteModalError, setRemoteModalError] = useState('')
  const remoteDialogRef = useRef<HTMLDivElement | null>(null)
  const remoteBackgroundRef = useRef<HTMLDivElement | null>(null)
  const remoteTriggerRef = useRef<HTMLElement | null>(null)
  const shutdownDialogRef = useRef<HTMLDivElement | null>(null)
  const shutdownTriggerRef = useRef<HTMLElement | null>(null)
  const firstInputRef = useRef<HTMLInputElement | null>(null)

  const hideMainWindow = (event?: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event?.preventDefault()
    event?.stopPropagation()
    const api = window.api
    if (!api) {
      setError('창 제어 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    try {
      api.hideMainWindowNow()
      void api.hideMainWindow().catch(() => setError('창을 숨기지 못했어요. 다시 시도해주세요.'))
    } catch {
      setError('창을 숨기지 못했어요. 다시 시도해주세요.')
    }
  }

  const refreshRemoteAdmin = async () => {
    setRemoteStatus('loading')
    setRemoteRefreshWarning('')
    try {
      const [health, state] = await Promise.all([window.api?.remoteHealth?.(), window.api?.remoteGetState?.()])
      setRemoteHealth(health ?? null)
      setParentDevices(state?.parentDevices ?? [])
      setRemoteStatus('loaded')
    } catch {
      setRemoteStatus('error')
      setRemoteRefreshWarning('원격 승인 상태를 새로고침하지 못했어요.')
    }
  }

  const closeRemoteAction = () => {
    setRemoteAction(null)
    setRemoteModalError('')
  }
  useModalFocusBoundary(Boolean(remoteAction), remoteDialogRef, remoteBackgroundRef, remoteTriggerRef, closeRemoteAction)
  const closeShutdownConfirm = () => setShutdownConfirmOpen(false)
  useModalFocusBoundary(shutdownConfirmOpen, shutdownDialogRef, remoteBackgroundRef, shutdownTriggerRef, closeShutdownConfirm)

  useEffect(() => {
    const api = window.api
    if (!api) {
      setError('설정 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    void api.readSettings()
      .then(setSettings)
      .catch(() => setError('설정을 불러오지 못했어요. 앱을 다시 시작해주세요.'))
    window.requestAnimationFrame(() => firstInputRef.current?.focus())
    void refreshRemoteAdmin()
  }, [])

  useEffect(() => {
    let active = true
    setPairingQrDataUrl('')
    if (!pairing) return () => { active = false }
    const expiresIn = Math.max(0, pairing.expiresAt - Date.now())
    const expiry = window.setTimeout(() => {
      if (active) setPairing(null)
    }, expiresIn)
    void QRCode.toDataURL(pairing.uri, { errorCorrectionLevel: 'M', margin: 2, width: 280 })
      .then((dataUrl) => { if (active) setPairingQrDataUrl(dataUrl) })
      .catch(() => { if (active) setRemoteError('연결 QR을 만들지 못했어요. 아래 일회용 주소를 사용해주세요.') })
    return () => {
      active = false
      window.clearTimeout(expiry)
      setPairingQrDataUrl('')
    }
  }, [pairing])
  const createPairing = async () => {
    const createSession = window.api?.remoteCreatePairingSession
    if (!createSession || remoteBusy) return
    setRemoteBusy(true)
    setRemoteError('')
    try {
      setPairing(await createSession())
    } catch {
      setRemoteError('연결 코드를 만들지 못했어요. 서비스 연결과 관리자 인증을 확인해주세요.')
    } finally {
      setRemoteBusy(false)
    }
  }

  const confirmRemoteAction = async () => {
    if (!remoteAction || remoteBusy) return
    const action = remoteAction
    const operation = action === 'revoke'
      ? () => window.api?.remoteRevokeParent(parentDeviceId)
      : action === 'reset' ? window.api?.remoteResetMembership : window.api?.remoteDeleteHousehold
    if (!operation) return
    setRemoteBusy(true)
    setRemoteModalError('')
    try {
      await operation()
      setPairing(null)
      if (action === 'revoke') setParentDeviceId('')
      closeRemoteAction()
      void refreshRemoteAdmin().catch(() => setRemoteRefreshWarning('변경은 완료됐지만 목록을 새로고침하지 못했어요.'))
    } catch {
      setRemoteModalError(action === 'revoke' ? '부모님 기기 연결 해제에 실패했어요.' : action === 'reset' ? '연결 초기화에 실패했어요.' : '가정 삭제에 실패했어요.')
    } finally {
      setRemoteBusy(false)
    }
  }

  const weekdayTotal = useMemo(() => settings.weekdayLimit * (settings.weekdaySessionCount ?? 1), [settings.weekdayLimit, settings.weekdaySessionCount])
  const weekendTotal = useMemo(() => settings.weekendLimit * (settings.weekendSessionCount ?? 1), [settings.weekendLimit, settings.weekendSessionCount])

  const settingsAreValid = [
    [settings.weekdayLimit, 5, 240],
    [settings.weekendLimit, 5, 480],
    [settings.weekdaySessionCount ?? 1, 1, 10],
    [settings.weekendSessionCount ?? 1, 1, 10],
    [settings.allowedStartHour, 0, 23],
    [settings.allowedEndHour, 0, 24],
  ].every(([value, minimum, maximum]) => Number.isInteger(value) && value >= minimum && value <= maximum)
    && settings.allowedStartHour !== settings.allowedEndHour

  const handleSave = async () => {
    if (saving) return
    if (!settingsAreValid) {
      setSaved(false)
      setError('입력값을 확인해주세요. 시간과 횟수는 올바른 범위의 숫자여야 해요.')
      return
    }
    const api = window.api
    if (!api) {
      setError('설정 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const persistedSettings = await api.writeSettings({ ...settings, updatedAt: new Date().toISOString() })
      setSettings(persistedSettings)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setSaved(false)
      setError('저장에 실패했어요. 설치 후 C:\\ProgramData\\PlaytimePact 권한을 확인해주세요.')
      setTimeout(() => setError(''), 3000)
    } finally {
      setSaving(false)
    }
  }

  const handleShutdown = async () => {
    const shutdownApp = window.api?.shutdownApp
    if (!shutdownApp) {
      setError('종료 서비스에 연결할 수 없어요. 앱을 다시 시작해주세요.')
      return
    }
    try {
      await shutdownApp()
    } catch {
      setError('앱 종료에 실패했어요. 관리자 PIN 인증 후 다시 시도해주세요.')
      setTimeout(() => setError(''), 3000)
    }
  }

  return (
    <div ref={remoteBackgroundRef} className="ppt-shell ppt-shell--settings">
      <div className="ppt-topbar app-drag">
        <div className="ppt-brand app-drag">
          <div className="ppt-brand__mark">P</div>
          <div className="ppt-brand__copy">
            <strong>Playtime Pact</strong>
            <span>부모님 설정 · Minecraft + Roblox</span>
          </div>
        </div>
        <div className="ppt-topbar__actions no-drag">
          <button type="button" className="ppt-window-action" onClick={onBack} aria-label="메인 화면으로 돌아가기">
            ←
          </button>
          <button
            type="button"
            className="ppt-window-action window-hide-button"
            onPointerDown={hideMainWindow}
            onClick={hideMainWindow}
            aria-label="창 숨기기"
          >
            −
          </button>
        </div>
      </div>

      <section className="ppt-adventure-hero ppt-adventure-hero--settings no-drag">
        <div className="ppt-adventure-hero__copy">
          <p className="ppt-page-heading__eyebrow">부모님 퀘스트 설정</p>
          <h1 className="ppt-adventure-hero__title">우리 집 게임 규칙</h1>
          <p className="ppt-adventure-hero__body">시간과 시작 조건을 쉽고 안전하게 정해요.</p>
        </div>
        <VoxelCrew variant="settings" />
      </section>

      <div className="ppt-scroll-stack no-drag">
        <SettingsCard title="하루 허용 시간" subtitle="세션당 분 × 하루 횟수">
          <div className="ppt-grid-2">
            <div className="ppt-stat-card">
              <div className="ppt-stat-card__head">
                <strong>평일</strong>
                <span>합계 {weekdayTotal}분</span>
              </div>
              <div className="ppt-form-row">
                <label className="ppt-field-group">
                  <span className="ppt-field-label">세션당 분</span>
                  <input
                    type="number"
                    min={5}
                    max={240}
                    value={settings.weekdayLimit}
                    onChange={(event) => setSettings((current) => ({ ...current, weekdayLimit: Number(event.target.value) }))}
                    className="ppt-input ppt-input--number"
                    ref={firstInputRef}
                  />
                </label>
                <label className="ppt-field-group">
                  <span className="ppt-field-label">하루 횟수</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.weekdaySessionCount ?? 1}
                    onChange={(event) => setSettings((current) => ({ ...current, weekdaySessionCount: Number(event.target.value) }))}
                    className="ppt-input ppt-input--number"
                  />
                </label>
              </div>
            </div>

            <div className="ppt-stat-card">
              <div className="ppt-stat-card__head">
                <strong>주말</strong>
                <span>합계 {weekendTotal}분</span>
              </div>
              <div className="ppt-form-row">
                <label className="ppt-field-group">
                  <span className="ppt-field-label">세션당 분</span>
                  <input
                    type="number"
                    min={5}
                    max={480}
                    value={settings.weekendLimit}
                    onChange={(event) => setSettings((current) => ({ ...current, weekendLimit: Number(event.target.value) }))}
                    className="ppt-input ppt-input--number"
                  />
                </label>
                <label className="ppt-field-group">
                  <span className="ppt-field-label">하루 횟수</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.weekendSessionCount ?? 1}
                    onChange={(event) => setSettings((current) => ({ ...current, weekendSessionCount: Number(event.target.value) }))}
                    className="ppt-input ppt-input--number"
                  />
                </label>
              </div>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="게임 가능 시간대" subtitle="허용된 시간에만 시작 가능">
          <div className="ppt-form-row">
            <label className="ppt-field-group">
              <span className="ppt-field-label">시작 가능 시각</span>
              <input
                type="number"
                min={0}
                max={23}
                value={settings.allowedStartHour}
                onChange={(event) => setSettings((current) => ({ ...current, allowedStartHour: Number(event.target.value) }))}
                className="ppt-input ppt-input--number"
              />
            </label>
            <label className="ppt-field-group">
              <span className="ppt-field-label">종료 시각</span>
              <input
                type="number"
                min={0}
                max={24}
                value={settings.allowedEndHour}
                onChange={(event) => setSettings((current) => ({ ...current, allowedEndHour: Number(event.target.value) }))}
                className="ppt-input ppt-input--number"
              />
            </label>
          </div>
          <p className="ppt-helper-text">{settings.allowedStartHour}시부터 {settings.allowedEndHour}시까지 지원 게임 시작을 허용해요.</p>
        </SettingsCard>

        <SettingsCard title="시작 승인 방식" subtitle="새 세션 시작 정책">
          <label className="ppt-toggle-card">
            <div>
              <strong>부모님 승인 후 게임 시작</strong>
              <p>
                켜두면 새 게임 타임마다 원격 승인 요청이 필요해요. 원격 서비스 장애 시에만 부모님 PIN 대체 승인을 사용할 수 있어요.
              </p>
            </div>
            <span className={`ppt-toggle${settings.requireApprovalBeforeStart ? ' is-on' : ''}`} aria-hidden="true">
              <span className="ppt-toggle__thumb" />
            </span>
            <input
              type="checkbox"
              checked={settings.requireApprovalBeforeStart}
              onChange={(event) => setSettings((current) => ({ ...current, requireApprovalBeforeStart: event.target.checked }))}
              className="ppt-toggle-card__input"
            />
          </label>
        </SettingsCard>
        <SettingsCard title="원격 부모님 승인" subtitle={remoteStatus === 'loading' ? '상태 확인 중' : remoteStatus === 'error' ? '상태 확인 실패' : `서비스 ${remoteHealth?.lifecycle ?? '알 수 없음'}`}>
          <div className="ppt-remote-admin" aria-live="polite">
            {remoteStatus === 'loading' ? <p><strong>상태 확인 중</strong> · 부모님 기기와 서비스 정보를 불러오고 있어요.</p> : null}
            {remoteStatus === 'error' ? <p><strong>상태 확인 실패</strong> · 새로고침 후 다시 시도해주세요.</p> : null}
            {remoteStatus === 'loaded' ? <p><strong>{remoteHealth?.lifecycle === 'online' ? '연결됨' : remoteHealth?.lifecycle === 'error' ? '오류' : '연결 확인 필요'}</strong> · {remoteHealth ? `${new Date(remoteHealth.checkedAt).toLocaleTimeString('ko-KR')}에 확인됨` : ''} · 부모님 기기는 같은 승인 권한을 가져요.</p> : null}
            <button type="button" className="ppt-button ppt-button--ghost ppt-button--small" onClick={() => void refreshRemoteAdmin()} disabled={remoteStatus === 'loading'}>원격 상태 새로고침</button>
            {pairing ? (
              <div className="ppt-pairing-code">
                <strong>한 번만 사용할 수 있는 연결 주소</strong>
                {pairingQrDataUrl ? <img className="ppt-pairing-code__qr" src={pairingQrDataUrl} alt="부모님 Android 앱 연결용 일회용 QR 코드" /> : <p>QR 코드 만드는 중...</p>}
                <code>{pairing.uri}</code>
                <p>{new Date(pairing.expiresAt).toLocaleTimeString('ko-KR')}까지 부모님 기기에서 QR/주소를 열어 연결하세요. 주소는 첫 연결에 사용되거나 만료되면 다시 사용할 수 없어요.</p>
                <button type="button" className="ppt-button ppt-button--ghost ppt-button--small" onClick={() => setPairing(null)}>연결 주소 숨기기</button>
              </div>
            ) : (
              <button type="button" className="ppt-button ppt-button--secondary" onClick={() => void createPairing()} disabled={remoteBusy || remoteStatus !== 'loaded'}>
                {remoteBusy ? '연결 코드 만드는 중...' : '부모님 기기 연결 QR/주소 만들기'}
              </button>
            )}
            <p className="ppt-helper-text">일회용 주소와 비밀 키는 저장하지 않아요. 현재 연결 기기는 아래 복구 영역에서 확인하고 해제할 수 있어요.</p>
            {remoteError ? <p className="ppt-inline-message ppt-inline-message--danger">{remoteError}</p> : null}
            {remoteRefreshWarning ? <p className="ppt-inline-message ppt-inline-message--danger">{remoteRefreshWarning}</p> : null}
          </div>
        </SettingsCard>

        <details className="ppt-danger-zone no-drag">
          <summary>원격 승인 복구 · 연결 초기화 또는 가정 삭제</summary>
          <p>연결 초기화는 모든 부모님 기기의 접근을 해제합니다. 가정 삭제는 원격 승인 데이터를 영구 삭제합니다.</p>
          {remoteStatus === 'loading' ? <p className="ppt-helper-text">연결된 부모님 기기를 확인하는 중이에요.</p> : parentDevices.length > 0 ? (
            <ul className="ppt-parent-device-list" aria-label="연결된 부모님 기기">
              {parentDevices.map((device) => (
                <li key={device.parentDeviceId}>
                  <span><strong>{device.displayName}</strong><small>연결됨 · {new Date(device.registeredAt).toLocaleDateString('ko-KR')}</small></span>
                  <button type="button" className="ppt-button ppt-button--secondary ppt-button--small" onClick={() => { remoteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setParentDeviceId(device.parentDeviceId); setRemoteModalError(''); setRemoteAction('revoke') }}>연결 해제</button>
                </li>
              ))}
            </ul>
          ) : remoteStatus === 'error' ? <p className="ppt-helper-text">기기 목록을 불러오지 못했어요. 원격 상태를 새로고침하세요.</p> : <p className="ppt-helper-text">현재 서버에서 확인된 부모님 기기가 없어요.</p>}
          <div className="ppt-actions">
            <button type="button" className="ppt-button ppt-button--secondary" onClick={() => { remoteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRemoteModalError(''); setRemoteAction('reset') }}>모든 부모님 기기 연결 해제</button>
            <button type="button" className="ppt-button ppt-button--danger" onClick={() => { remoteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRemoteModalError(''); setRemoteAction('delete') }}>가정 삭제</button>
          </div>
        </details>

        <details className="ppt-danger-zone no-drag">
          <summary>고급 설정 · 앱 완전 종료</summary>
          <p>부모님이 직접 종료할 때만 사용해요. 워치독을 중지하고 지원 게임도 함께 닫습니다.</p>
          <button type="button" className="ppt-button ppt-button--danger" onClick={() => { shutdownTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setShutdownConfirmOpen(true) }}>
            앱과 워치독 종료
          </button>
        </details>
        <div className="ppt-rules-strip ppt-rules-strip--settings no-drag">
          <span><strong>하나의 규칙</strong>으로 Minecraft + Roblox 동시 관리</span>
          <span>저장 즉시 다음 게임 세션부터 적용</span>
        </div>
      </div>

      <div className="ppt-sticky-actions no-drag">
        <div className="ppt-status-slot" aria-live="polite">
          {saving ? <p className="ppt-inline-message">저장 중...</p> : null}
          {saved ? <p className="ppt-inline-message ppt-inline-message--success">✓ 저장됐어요!</p> : null}
          {error ? <p className="ppt-inline-message ppt-inline-message--danger" data-settings-error={error.startsWith('입력값') ? 'validation' : error.startsWith('저장') ? 'save' : 'runtime'}>{error}</p> : null}
        </div>
        <div className="ppt-actions ppt-actions--stack">
          <button type="button" className="ppt-button ppt-button--primary" onClick={handleSave} disabled={saving}>{saving ? '저장 중...' : '게임 규칙 저장'}</button>
        </div>
      </div>

      {shutdownConfirmOpen ? (
        <div className="ppt-modal-backdrop app-drag" role="presentation">
          <div ref={shutdownDialogRef} className="ppt-dialog no-drag" role="dialog" aria-modal="true" aria-labelledby="shutdown-confirm-title" tabIndex={-1}>
            <p className="ppt-dialog__eyebrow">부모님 확인</p>
            <h2 id="shutdown-confirm-title" className="ppt-dialog__title">Playtime Pact를 종료할까요?</h2>
            <p className="ppt-dialog__copy">앱과 워치독이 멈추고 현재 실행 중인 지원 게임도 종료됩니다.</p>
            <div className="ppt-actions ppt-actions--dialog">
              <button type="button" className="ppt-button ppt-button--secondary" onClick={closeShutdownConfirm}>취소</button>
              <button type="button" className="ppt-button ppt-button--danger" onClick={() => void handleShutdown()}>완전 종료</button>
            </div>
          </div>
        </div>
      ) : null}
      {remoteAction ? (
        <div className="ppt-modal-backdrop app-drag" role="presentation">
          <div ref={remoteDialogRef} className="ppt-dialog no-drag" role="dialog" aria-modal="true" aria-labelledby="remote-confirm-title" tabIndex={-1}>
            <p className="ppt-dialog__eyebrow">부모님 확인</p>
            <h2 id="remote-confirm-title" className="ppt-dialog__title">{remoteAction === 'revoke' ? '이 부모님 기기 연결을 해제할까요?' : remoteAction === 'reset' ? '모든 부모님 기기 연결을 해제할까요?' : '이 가정을 삭제할까요?'}</h2>
            <p className="ppt-dialog__copy">{remoteAction === 'revoke' ? '선택한 부모님 기기는 즉시 원격 승인을 할 수 없게 됩니다.' : remoteAction === 'reset' ? '연결된 모든 부모님 기기가 즉시 원격 승인을 할 수 없게 됩니다.' : '원격 승인 데이터와 연결된 부모님 기기가 영구 삭제됩니다.'}</p>
            {remoteModalError ? <p className="ppt-inline-message ppt-inline-message--danger" role="alert">{remoteModalError}</p> : null}
            <div className="ppt-actions ppt-actions--dialog">
              <button type="button" className="ppt-button ppt-button--secondary" onClick={closeRemoteAction} disabled={remoteBusy}>취소</button>
              <button type="button" className="ppt-button ppt-button--danger" onClick={() => void confirmRemoteAction()} disabled={remoteBusy}>{remoteBusy ? '처리 중...' : '확인하고 계속'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
