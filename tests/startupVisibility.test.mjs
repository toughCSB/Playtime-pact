import { describe, expect, it } from 'vitest'

import {
  decideStartupWindowAction,
  shouldStartHiddenFromLaunch,
} from '../src/shared/startupVisibility'

describe('startup window visibility', () => {
  it('shows the main window for a manual launch when no timer resumes', () => {
    expect(decideStartupWindowAction({ startHidden: false, resumedTimer: false })).toBe('show-main-window')
  })

  it('stays hidden for watchdog auto-start when no timer resumes', () => {
    expect(decideStartupWindowAction({ startHidden: true, resumedTimer: false })).toBe('hide-to-tray')
  })

  it('treats packaged no-argument launches as tray-only for boot auto-start compatibility', () => {
    expect(shouldStartHiddenFromLaunch({ argv: ['Playtime Pact.exe'], isPackaged: true })).toBe(true)
  })

  it('keeps local development launches visible unless explicitly hidden', () => {
    expect(shouldStartHiddenFromLaunch({ argv: ['electron.exe', '.'], isPackaged: false })).toBe(false)
    expect(shouldStartHiddenFromLaunch({ argv: ['electron.exe', '.', '--start-hidden'], isPackaged: false })).toBe(true)
  })

  it('keeps the resumed timer window behavior independent of launch source', () => {
    expect(decideStartupWindowAction({ startHidden: false, resumedTimer: true })).toBe('keep-resumed-window')
    expect(decideStartupWindowAction({ startHidden: true, resumedTimer: true })).toBe('keep-resumed-window')
  })
})
