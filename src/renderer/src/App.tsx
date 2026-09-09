import { useEffect, useRef, useState, type RefObject } from 'react'
import Timer from './pages/Timer'
import Settings from './pages/Settings'
import AdminPanel from './pages/AdminPanel'
import { attemptSettingsUnlock } from './asyncAttempts'
import PinPad from './components/PinPad'
import SmartphoneShell, { useModalFocusBoundary } from './components/SmartphoneShell'
import PhoneBottomNav from './components/PhoneBottomNav'

type Page = 'timer' | 'settings'

const isAdminWindow = window.location.hash === '#admin'

interface SettingsUnlockDialogProps {
  pin: string
  error: string
  submitting: boolean
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  dialogRef: RefObject<HTMLDivElement>
}

function SettingsUnlockDialog({ pin, error, submitting, onChange, onSubmit, onCancel, dialogRef }: SettingsUnlockDialogProps) {
  return (
    <div className="ppt-modal-backdrop app-drag" role="presentation">
      <div ref={dialogRef} className="ppt-dialog ppt-dialog--pin no-drag" role="dialog" aria-modal="true" aria-labelledby="settings-unlock-title" tabIndex={-1}>
        <p className="ppt-dialog__eyebrow">부모님 전용</p>
        <h2 id="settings-unlock-title" className="ppt-dialog__title">PIN을 눌러주세요</h2>
        <PinPad
          id="settings-unlock-pin"
          label="부모님 4자리 PIN"
          value={pin}
          onChange={onChange}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={submitting}
          error={error}
        />
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>('timer')
  const [settingsPinOpen, setSettingsPinOpen] = useState(false)
  const [settingsPin, setSettingsPin] = useState('')
  const [settingsPinError, setSettingsPinError] = useState('')
  const [settingsPinSubmitting, setSettingsPinSubmitting] = useState(false)
  const [timerDestination, setTimerDestination] = useState<'play' | 'rules'>('play')
  const settingsTriggerRef = useRef<HTMLElement | null>(null)
  const unlockRequestRef = useRef(0)
  const settingsDialogRef = useRef<HTMLDivElement | null>(null)
  const appBackgroundRef = useRef<HTMLDivElement | null>(null)
  const settingsSurfaceRef = useRef<HTMLDivElement | null>(null)

  const closeSettingsPin = () => {
    unlockRequestRef.current += 1
    setSettingsPinOpen(false)
    setSettingsPin('')
    setSettingsPinError('')
    setSettingsPinSubmitting(false)
  }

  const submitSettingsPin = async (candidate = settingsPin) => {
    if (settingsPinSubmitting) return
    if (!/^\d{4}$/.test(candidate)) {
      setSettingsPinError('PIN 4자리를 입력하세요.')
      return
    }
    const requestId = unlockRequestRef.current + 1
    unlockRequestRef.current = requestId
    setSettingsPinSubmitting(true)
    try {
      const attempt = await attemptSettingsUnlock(candidate, window.api?.adminUnlockSettings)
      if (requestId !== unlockRequestRef.current || !settingsPinOpen) return
      setSettingsPin(attempt.pin)
      if (attempt.value === true) {
        settingsTriggerRef.current = null
        setPage('settings')
        setSettingsPinOpen(false)
        setSettingsPinError('')
        window.requestAnimationFrame(() => settingsSurfaceRef.current?.focus())
        return
      }
      setSettingsPinError(attempt.error)
    } finally {
      if (requestId === unlockRequestRef.current) {
        setSettingsPinSubmitting(false)
      }
    }
  }

  useEffect(() => {
    if (settingsPinOpen && /^\d{4}$/.test(settingsPin) && !settingsPinSubmitting) {
      void submitSettingsPin(settingsPin)
    }
  }, [settingsPin, settingsPinOpen, settingsPinSubmitting])


  useModalFocusBoundary(settingsPinOpen, settingsDialogRef, appBackgroundRef, settingsTriggerRef, closeSettingsPin)

  if (isAdminWindow) {
    return <AdminPanel />
  }
  const openTimerDestination = (destination: 'play' | 'rules') => {
    setTimerDestination(destination)
    setPage('timer')
  }

  return (
    <div ref={appBackgroundRef} className="ppt-app-root">
      <div hidden={page !== 'timer'}>
        <Timer
          visible={page === 'timer'}
          requestedSurface={timerDestination}
          onActiveChange={(active) => {
            if (active) {
              closeSettingsPin()
              setTimerDestination('play')
              setPage('timer')
            }
          }}
          onOpenSettings={() => {
            settingsTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            setSettingsPinError('')
            setSettingsPinOpen(true)
          }}
        />
      </div>
      <div ref={settingsSurfaceRef} hidden={page !== 'settings'} tabIndex={-1}>
        <SmartphoneShell
          surface="settings"
          title="부모님 설정"
          nav={(
            <PhoneBottomNav
              current="settings"
              items={[
                { id: 'play', label: 'Play', icon: '▶' },
                { id: 'rules', label: 'Rules', icon: '✓' },
                { id: 'settings', label: 'Settings', icon: '⚙' },
              ]}
              onSelect={(id) => {
                if (id === 'play' || id === 'rules') openTimerDestination(id)
              }}
            />
          )}
        >
          <Settings onBack={() => openTimerDestination('play')} />
        </SmartphoneShell>
      </div>

      {settingsPinOpen ? (
        <SettingsUnlockDialog
          pin={settingsPin}
          error={settingsPinError}
          submitting={settingsPinSubmitting}
          onChange={setSettingsPin}
          onSubmit={() => void submitSettingsPin()}
          onCancel={closeSettingsPin}
          dialogRef={settingsDialogRef}
        />
      ) : null}
    </div>
  )
}
