// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/renderer/src/App'
import AdminPanel from '../src/renderer/src/pages/AdminPanel'

type Listener = (payload?: any) => void

const listenerNames = [
  'onTimerTick',
  'onTimerWarning',
  'onTimerExpired',
  'onTimerTerminationFailed',
  'onTimerMode',
  'onTimerResumed',
  'onTimerAdminStopped',
  'onSupportedGameDetected',
  'onSupportedGameClosed',
  'onSupportedGameBlocked',
] as const

function createApi() {
  const listeners = new Map<string, Listener>()
  const disposers = new Map<string, ReturnType<typeof vi.fn>>()
  const api: Record<string, any> = {
    readSettings: vi.fn(async () => ({
      weekdayLimit: 60,
      weekendLimit: 90,
      weekdaySessionCount: 2,
      weekendSessionCount: 2,
      allowedStartHour: 0,
      allowedEndHour: 24,
      requireApprovalBeforeStart: false,
      resumeTimerOnRestart: true,
      updatedAt: '2026-08-02T00:00:00.000Z',
    })),
    writeSettings: vi.fn(async (settings) => settings),
    readSessions: vi.fn(async () => []),
    startTimer: vi.fn(async () => ({ resumed: false, remainingSeconds: 3600, exhausted: false })),
    minimizeMainWindow: vi.fn(async () => {}),
    hideMainWindow: vi.fn(async () => {}),
    hideMainWindowNow: vi.fn(),
    showMainWindow: vi.fn(async () => {}),
    timerGetStatus: vi.fn(async () => ({ running: false, remainingSeconds: 0, mode: 'corner', activeGameIds: [] })),
    timerAdjustTime: vi.fn(async () => ({ remainingSeconds: 1800 })),
    timerAdminStop: vi.fn(async () => {}),
    adminVerifyPassword: vi.fn(async () => true),
    adminUnlockSettings: vi.fn(async () => true),
    adminApproveNextSession: vi.fn(async () => ({ ok: true, launchedPendingGame: false })),
    remoteGetState: vi.fn(async () => ({
      lifecycle: 'offline',
      health: 'offline',
      serverTime: Date.now(),
      updatedAt: Date.now(),
    })),
    adminChangePassword: vi.fn(async () => {}),
    adminCloseWindow: vi.fn(async () => {}),
    adminGetResumeOption: vi.fn(async () => true),
    adminSetResumeOption: vi.fn(async () => {}),
    shutdownApp: vi.fn(async () => {}),
    dailyGetRemaining: vi.fn(async () => ({
      date: '2026-08-02',
      sessionsCompleted: 0,
      sessionsPerDay: 2,
      currentSessionActive: false,
      remainingSeconds: 7200,
      exhausted: false,
    })),
  }

  for (const name of listenerNames) {
    const dispose = vi.fn()
    disposers.set(name, dispose)
    api[name] = vi.fn((listener: Listener) => {
      listeners.set(name, listener)
      return dispose
    })
  }

  return { api, listeners, disposers }
}

beforeEach(() => {
  window.location.hash = ''
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0)
})

afterEach(() => {
  cleanup()
  delete window.api
})

describe('renderer interactions', () => {
  it('navigates in one tap and unlocks Settings with the existing PIN API', async () => {
    const { api } = createApi()
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    const rules = await screen.findByRole('button', { name: 'Rules' })
    await user.click(rules)
    expect(rules.getAttribute('aria-current')).toBe('page')

    const settingsButton = screen.getByRole('button', { name: 'Settings' })
    await user.click(settingsButton)
    expect(screen.getByRole('dialog', { name: 'PIN을 눌러주세요' })).toBeTruthy()
    for (const digit of ['1', '2', '3', '4']) {
      await user.click(screen.getByRole('button', { name: digit }))
    }

    expect(await screen.findByRole('heading', { name: '우리 집 게임 규칙' })).toBeTruthy()
    expect(api.adminUnlockSettings).toHaveBeenCalledWith('1234')
    await waitFor(() => {
      const settingsSurface = document.querySelector('[data-surface="settings"]')
      expect(document.activeElement?.contains(settingsSurface)).toBe(true)
      expect(document.activeElement).not.toBe(settingsButton)
    })
  })

  it('rejects invalid Settings values before persistence and identifies the validation error', async () => {
    const { api } = createApi()
    api.readSettings.mockResolvedValue({ ...(await api.readSettings()), weekdayLimit: Number.NaN })
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    for (const digit of ['1', '2', '3', '4']) await user.click(screen.getByRole('button', { name: digit }))
    await user.click(await screen.findByRole('button', { name: '게임 규칙 저장' }))

    expect(document.querySelector('[data-settings-error="validation"]')?.textContent).toContain('입력값을 확인해주세요')
    expect(api.writeSettings).not.toHaveBeenCalled()
  })

  it('persists overnight Settings windows and rejects equal hour endpoints', async () => {
    const { api } = createApi()
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    for (const digit of ['1', '2', '3', '4']) await user.click(screen.getByRole('button', { name: digit }))
    const startHour = await screen.findByLabelText('시작 가능 시각')
    const endHour = screen.getByLabelText('종료 시각')
    await user.clear(startHour)
    await user.type(startHour, '22')
    await user.clear(endHour)
    await user.type(endHour, '6')
    await user.click(screen.getByRole('button', { name: '게임 규칙 저장' }))
    await waitFor(() => expect(api.writeSettings).toHaveBeenCalledOnce())
    expect(api.writeSettings.mock.calls[0][0]).toMatchObject({ allowedStartHour: 22, allowedEndHour: 6 })

    await user.clear(startHour)
    await user.type(startHour, '6')
    await user.click(screen.getByRole('button', { name: '게임 규칙 저장' }))
    expect(document.querySelector('[data-settings-error="validation"]')).not.toBeNull()
    expect(api.writeSettings).toHaveBeenCalledOnce()
  })

  it('keeps an active admin timer visible when the stop bridge rejects', async () => {
    window.location.hash = '#admin'
    const { api } = createApi()
    api.timerGetStatus.mockResolvedValue({ running: true, remainingSeconds: 1800, mode: 'corner', activeGameIds: ['roblox'] })
    api.timerAdminStop.mockRejectedValue(new Error('termination failed'))
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<AdminPanel />)

    for (const digit of ['1', '2', '3', '4']) await user.click(await screen.findByRole('button', { name: digit }))
    await user.click(await screen.findByRole('button', { name: 'Timer' }))
    await user.click(await screen.findByRole('button', { name: '타이머 중지' }))

    expect(await screen.findByText('타이머 중지에 실패했어요.')).toBeTruthy()
    expect(screen.getByText('실행 중')).toBeTruthy()
    expect(screen.getByText('30:00')).toBeTruthy()
  })

  it('removes the phone shell for direct blocked termination failure and exits only on an authoritative close', async () => {
    const { api, listeners } = createApi()
    window.api = api as Window['api']
    render(<App />)
    await screen.findByRole('button', { name: 'Play' })

    listeners.get('onSupportedGameBlocked')?.({
      gameId: 'roblox',
      activeGameIds: ['roblox'],
      primaryGameId: 'roblox',
      reason: 'outside-hours',
      message: '지금은 플레이 시간이 아니에요.',
    })
    listeners.get('onTimerTerminationFailed')?.({
      message: '게임을 닫지 못했어요.',
      remainingGameIds: ['roblox'],
    })

    expect(await screen.findByText('종료 확인 필요')).toBeTruthy()
    const timerHost = document.querySelector('.ppt-app-root')?.firstElementChild
    expect(timerHost?.querySelector('[data-phone-shell]')).toBeNull()

    listeners.get('onSupportedGameClosed')?.({ activeGameIds: [], primaryGameId: null })
    await waitFor(() => expect(timerHost?.querySelector('[data-phone-shell]')).not.toBeNull())
  })

  it('disposes every registered lifecycle listener on unmount', async () => {
    const { api, disposers } = createApi()
    window.api = api as Window['api']
    const view = render(<App />)
    await screen.findByRole('button', { name: 'Play' })

    view.unmount()
    for (const name of listenerNames) {
      expect(disposers.get(name)).toHaveBeenCalledOnce()
    }
  })
  it('traps Settings PIN focus, closes on Escape, restores its trigger, and makes the background inert', async () => {
    const { api } = createApi()
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    const settings = await screen.findByRole('button', { name: 'Settings' })
    await user.click(settings)
    const dialog = screen.getByRole('dialog', { name: 'PIN을 눌러주세요' })
    const input = screen.getByLabelText('부모님 4자리 PIN')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(document.querySelector('.ppt-app-root > div')?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Rules' })).toBeNull()

    await user.tab({ shift: true })
    expect(document.activeElement).toBe(dialog.querySelector('.ppt-text-button'))
    await user.tab()
    expect(document.activeElement).toBe(input)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(settings)
  })
  it('traps shutdown confirmation focus, closes on Escape, and restores its trigger', async () => {
    const { api } = createApi()
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    for (const digit of ['1', '2', '3', '4']) await user.click(screen.getByRole('button', { name: digit }))
    const trigger = await screen.findByRole('button', { name: '앱과 워치독 종료' })
    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Playtime Pact를 종료할까요?' })
    const cancel = screen.getByRole('button', { name: '취소' })
    await waitFor(() => expect(document.activeElement).toBe(cancel))
    expect(screen.queryByRole('button', { name: '게임 규칙 저장' })).toBeNull()

    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '완전 종료' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
  it('traps approval PIN focus and restores the start trigger on Escape', async () => {
    const { api } = createApi()
    api.readSettings.mockResolvedValue({ ...(await api.readSettings()), requireApprovalBeforeStart: true })
    window.api = api as Window['api']
    const user = userEvent.setup()
    render(<App />)

    const start = await screen.findByRole('button', { name: '부모님 승인하고 시작' })
    await user.click(start)
    const dialog = screen.getByRole('dialog', { name: 'PIN을 눌러주세요' })
    const input = screen.getByLabelText('부모님 4자리 PIN')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.queryByRole('button', { name: 'Rules' })).toBeNull()

    await user.tab({ shift: true })
    expect(document.activeElement).toBe(dialog.querySelector('.ppt-text-button'))
    await user.tab()
    expect(document.activeElement).toBe(input)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(start)
  })

  it('keeps blocked feedback through false status and clears it only after zero-active close', async () => {
    const { api, listeners } = createApi()
    window.api = api as Window['api']
    render(<App />)
    await screen.findByRole('button', { name: 'Play' })

    listeners.get('onSupportedGameBlocked')?.({ message: '지금은 플레이 시간이 아니에요.', reason: 'outside-hours' })
    expect(await screen.findByText('지금은 플레이 시간이 아니에요.')).toBeTruthy()
    listeners.get('onSupportedGameClosed')?.({ activeGameIds: ['roblox'], primaryGameId: 'roblox' })
    await waitFor(() => expect(screen.getByText('지금은 플레이 시간이 아니에요.')).toBeTruthy())
    listeners.get('onSupportedGameClosed')?.({ activeGameIds: [], primaryGameId: null })
    await waitFor(() => expect(screen.queryByText('지금은 플레이 시간이 아니에요.')).toBeNull())
  })

  it('marks preferred and scaled phone geometry without relying on layout measurements', async () => {
    const { api } = createApi()
    window.api = api as Window['api']
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 760 })
    const preferred = render(<App />)
    expect(document.querySelector('[data-phone-shell]')?.parentElement?.getAttribute('data-geometry-class')).toBe('preferred')
    preferred.unmount()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 680 })
    const downscaled = render(<App />)
    expect(document.querySelector('[data-phone-shell]')?.parentElement?.getAttribute('data-geometry-class')).toBe('scaled')
    downscaled.unmount()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    render(<App />)
    expect(document.querySelector('[data-phone-shell]')?.parentElement?.getAttribute('data-geometry-class')).toBe('scaled')
    if (width) Object.defineProperty(window, 'innerWidth', width)
    if (height) Object.defineProperty(window, 'innerHeight', height)
  })
})
