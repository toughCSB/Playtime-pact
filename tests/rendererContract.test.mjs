import { existsSync, readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('renderer frontend overhaul contract', () => {
  it('puts the primary play action above the fold with a tappable PIN pad instead of a scrolled input', () => {
    const timer = read('src/renderer/src/pages/Timer.tsx')

    expect(timer).toContain('ppt-status-strip')
    expect(timer).toContain('ppt-clock-card')
    expect(timer).toContain('ppt-action-zone')
    expect(timer).toContain('ppt-rules-details')
    expect(timer).toContain('게임 타임 시작')
    expect(timer).toContain('부모님 승인하고 시작')
    expect(timer).toContain('<PinPad')
    expect(timer).toContain('approvalOpen')
    expect(timer).toContain('VoxelCrew')
    expect(timer).toContain('onTimerTerminationFailed')
    expect(timer).toContain("overlayMode === 'shutdown'")
    expect(timer).toContain("overlayMode === 'center-countdown'")
    expect(timer).toContain("overlayMode === 'center-popup'")
    expect(timer).not.toContain('ppt-scroll-stack')
  })

  it('routes every PIN surface through the shared keypad', () => {
    const app = read('src/renderer/src/App.tsx')
    const timer = read('src/renderer/src/pages/Timer.tsx')
    const admin = read('src/renderer/src/pages/AdminPanel.tsx')
    const pinpad = read('src/renderer/src/components/PinPad.tsx')

    expect(app).toContain("import PinPad from './components/PinPad'")
    expect(timer).toContain("import PinPad from '../components/PinPad'")
    expect(admin).toContain("import PinPad from '../components/PinPad'")
    expect(app).toContain('<PinPad')
    expect(timer).toContain('<PinPad')
    expect(admin).toContain('<PinPad')
    expect(pinpad).toContain('ppt-pinpad__keys')
    expect(pinpad).toContain('ppt-pinpad__dot')
    expect(pinpad).toContain('aria-label={label}')
    expect(app).not.toContain('ppt-input--pin')
    expect(admin).not.toContain('ppt-keypad__key')
  })

  it('keeps keypad entry bounded to four digits and rejects non-numeric input', async () => {
    const { appendPinDigit, removePinDigit } = await import('../src/renderer/src/components/PinPad.tsx')

    expect(appendPinDigit('', '0')).toBe('0')
    expect(appendPinDigit('12', '3')).toBe('123')
    expect(appendPinDigit('1234', '5')).toBe('1234')
    expect(appendPinDigit('12', 'a')).toBe('12')
    expect(removePinDigit('1234')).toBe('123')
    expect(removePinDigit('')).toBe('')
  })

  it('groups parent policy controls with a safe advanced shutdown flow', () => {
    const settings = read('src/renderer/src/pages/Settings.tsx')

    expect(settings).toContain('우리 집 게임 규칙')
    expect(settings).toContain('하루 허용 시간')
    expect(settings).toContain('게임 가능 시간대')
    expect(settings).toContain('시작 승인 방식')
    expect(settings).toContain('고급 설정 · 앱 완전 종료')
    expect(settings).toContain('shutdownConfirmOpen')
    expect(settings).toContain('SettingsCard')
  })

  it('keeps admin controls compact with one adjustment grid and labeled PIN management', () => {
    const admin = read('src/renderer/src/pages/AdminPanel.tsx')

    expect(admin).toContain('게임 마스터 룸')
    expect(admin).toContain('타이머 상태')
    expect(admin).toContain('빠른 조정')
    expect(admin).toContain('adjustSign')
    expect(admin).toContain('직접 입력')
    expect(admin).toContain('재부팅 설정')
    expect(admin).toContain('부모 PIN 변경')
    expect(admin).toContain('htmlFor=\"admin-current-pin\"')
    expect(admin).toContain('PinStage')
  })

  it('preserves compact admin and settings-auth interaction contracts', () => {
    const app = read('src/renderer/src/App.tsx')
    const timer = read('src/renderer/src/pages/Timer.tsx')
    const attempts = read('src/renderer/src/asyncAttempts.ts')
    const admin = read('src/renderer/src/pages/AdminPanel.tsx')
    const css = read('src/renderer/src/index.css')

    expect(app).toContain('ppt-modal-backdrop app-drag')
    expect(app).toContain('unlockRequestRef.current += 1')
    expect(app).toContain('attemptSettingsUnlock')
    expect(timer).toContain('attemptParentApproval')
    expect(timer).toContain('attemptTimerStart')
    expect(attempts).toContain('타이머를 시작하지 못했어요')
    expect(attempts).toContain('승인 서비스에 연결할 수 없어요')
    expect(admin).toContain('ref={dashboardRef}')
    expect(admin).toContain('tabIndex={-1}')
    expect(css).toContain('.ppt-dialog--admin-auth .ppt-pinpad__key')
    expect(admin).toContain('const verifyPassword = window.api?.adminVerifyPassword')
    expect(admin).toContain("throw new Error('Timer adjustment bridge unavailable')")
    expect(admin).toContain("throw new Error('Timer stop bridge unavailable')")
    expect(admin).toContain("throw new Error('Resume settings bridge unavailable')")
    expect(admin).toContain('const closeWindow = window.api?.adminCloseWindow')
    expect(admin).toContain('await api.showMainWindow()')
    expect(admin).toContain('창 제어 서비스에 연결할 수 없어요')
    expect(css).toContain('min-height: 36px')
  })

  it('keeps admin timer delivery and saved settings synchronized with the main process', () => {
    const main = read('src/main/main.ts')
    const admin = read('src/renderer/src/pages/AdminPanel.tsx')
    const ipc = read('src/main/ipc.ts')
    const preload = read('src/preload/index.ts')
    const settings = read('src/renderer/src/pages/Settings.tsx')

    expect(main).toContain("adminWindow.webContents.send('timer:tick', payload)")
    expect(main.match(/broadcastTimerTick\(/g)).toHaveLength(3)
    expect(main).toContain("process.argv.includes('--qa-evidence')")
    expect(main).toContain('PLAYTIME_PACT_QA_OVERLAY')
    expect(admin).toContain("return api.onTimerTick(({ remainingSeconds: next }) => {")
    expect(admin).toContain('setTimerRunning(isTimerTickActive(next))')
    expect(ipc).toContain('return redactSettings(readSettings())')
    expect(preload).toContain('Promise<PublicSettings>')
    expect(settings).toContain('const persistedSettings = await api.writeSettings')
    expect(settings).toContain('setSettings(persistedSettings)')
    expect(settings).toContain('설정 서비스에 연결할 수 없어요')
    expect(settings).toContain('종료 서비스에 연결할 수 없어요')
    expect(settings).toContain('창을 숨기지 못했어요')
  })

  it('marks terminal admin timer ticks as stopped', async () => {
    const { isTimerTickActive } = await import('../src/renderer/src/pages/AdminPanel.tsx')

    expect(isTimerTickActive(60)).toBe(true)
    expect(isTimerTickActive(1)).toBe(true)
    expect(isTimerTickActive(0)).toBe(false)
    expect(isTimerTickActive(-1)).toBe(false)
    expect(isTimerTickActive(Number.NaN)).toBe(false)
  })

  it('runs settings unlock bridges once and returns stable failure state', async () => {
    const { attemptSettingsUnlock } = await import('../src/renderer/src/asyncAttempts.ts')
    const denied = vi.fn().mockResolvedValue(false)
    const rejected = vi.fn().mockRejectedValue(new Error('offline'))

    const deniedResult = await attemptSettingsUnlock('0000', denied)
    const rejectedResult = await attemptSettingsUnlock('0000', rejected)
    const missingResult = await attemptSettingsUnlock('0000', undefined)

    expect(denied).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledOnce()
    expect(deniedResult).toEqual({ value: false, pin: '', error: 'PIN이 틀렸어요.' })
    expect(rejectedResult.pin).toBe('')
    expect(rejectedResult.error).toContain('인증 서비스')
    expect(missingResult.pin).toBe('')
    expect(/^\d{4}$/.test(rejectedResult.pin)).toBe(false)
  })

  it('runs parent approval bridges once and clears rejected candidates', async () => {
    const { attemptParentApproval } = await import('../src/renderer/src/asyncAttempts.ts')
    const denied = vi.fn().mockResolvedValue({ ok: false, launchedPendingGame: false })
    const rejected = vi.fn().mockRejectedValue(new Error('locked'))

    const deniedResult = await attemptParentApproval('0000', denied)
    const rejectedResult = await attemptParentApproval('0000', rejected)
    const missingResult = await attemptParentApproval('0000', undefined)

    expect(denied).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledOnce()
    expect(deniedResult.pin).toBe('')
    expect(deniedResult.error).toBe('PIN이 올바르지 않아요.')
    expect(rejectedResult.pin).toBe('')
    expect(rejectedResult.error).toContain('문제가 계속되면 Playtime Pact를 다시 시작해주세요.')
    expect(missingResult.error).toContain('승인 서비스')
    expect(/^\d{4}$/.test(missingResult.pin)).toBe(false)
  })

  it('converts direct timer start rejection into visible error state', async () => {
    const { attemptTimerStart } = await import('../src/renderer/src/asyncAttempts.ts')
    const rejected = vi.fn().mockRejectedValue(new Error('ipc failed'))

    const result = await attemptTimerStart(60, rejected)

    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledWith(60)
    expect(result.value).toBeNull()
    expect(result.error).toContain('타이머를 시작하지 못했어요')
  })
  it('centralizes the fresh self-contained visual system with drag and reduced-motion coverage', () => {
    const css = read('src/renderer/src/index.css')
    const voxel = read('src/renderer/src/components/VoxelCrew.tsx')

    expect(css).toContain('--ppt-bg')
    expect(css).toContain('color-scheme: light')
    expect(css).not.toContain('fonts.googleapis.com')
    expect(css).toContain('.app-drag')
    expect(css).toContain('.no-drag')
    expect(css).toContain('.ppt-adventure-hero')
    expect(css).toContain('.ppt-voxel-character')
    expect(css).toContain('.ppt-button--primary')
    expect(css).toContain('.ppt-overlay-card--warning')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(voxel).toContain('ppt-voxel-character--explorer')
    expect(voxel).toContain('aria-hidden=\"true\"')
  })

  it('removes the legacy WarningPopup component and keeps inline styles tightly bounded', () => {
    const app = read('src/renderer/src/App.tsx')
    const timer = read('src/renderer/src/pages/Timer.tsx')
    const settings = read('src/renderer/src/pages/Settings.tsx')
    const admin = read('src/renderer/src/pages/AdminPanel.tsx')

    expect(existsSync(new URL('../src/renderer/src/components/WarningPopup.tsx', import.meta.url))).toBe(false)
    expect((app.match(/style=\{/g) ?? [])).toHaveLength(0)
    expect((settings.match(/style=\{/g) ?? [])).toHaveLength(0)
    expect((admin.match(/style=\{/g) ?? [])).toHaveLength(0)
    expect((timer.match(/style=\{/g) ?? [])).toHaveLength(4)
  })
})
