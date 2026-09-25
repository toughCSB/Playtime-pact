import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { readFileSync } from 'node:fs'

import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  shouldRequireApprovalForStart,
  normalizeRequireApprovalBeforeStart,
  requiresParentPinForRepeatSession,
} from '../src/shared/startPolicy'

describe('parent approval start policy', () => {
  it('defaults new households to automatic play within the parent configured allowance', () => {
    expect(DEFAULT_SETTINGS.requireApprovalBeforeStart).toBe(false)
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: false, sessionsCompleted: 0 })).toBe(false)
  })

  it('does not require approval when the parent chooses automatic start mode', () => {
    const settings = { ...DEFAULT_SETTINGS, requireApprovalBeforeStart: false }
    expect(shouldRequireApprovalForStart(settings, { hasActiveSession: false, sessionsCompleted: 0 })).toBe(false)
  })

  it('requires the PC PIN for a new second session but not for its PIN-approved resume', () => {
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: true, sessionsCompleted: 0 })).toBe(false)
    expect(requiresParentPinForRepeatSession(0)).toBe(false)
    expect(requiresParentPinForRepeatSession(1)).toBe(true)
    expect(requiresParentPinForRepeatSession(2)).toBe(true)
    expect(requiresParentPinForRepeatSession(Number.NaN)).toBe(true)
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: false, sessionsCompleted: 1 })).toBe(true)
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: true, sessionsCompleted: 1 })).toBe(true)
    expect(requiresParentPinForRepeatSession(1, true, true)).toBe(false)
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: true, sessionsCompleted: 1, pinApprovedSession: true })).toBe(false)
  })

  it('gates both timer entry points and the final protected handoff before remote or automatic starts', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
    const detection = main.slice(main.indexOf('function startTimerForDetectedManagedGames'), main.indexOf('function getActiveDisplay'))
    const timerIpc = main.slice(main.indexOf("ipcMain.handle('timer:start'"), main.indexOf("ipcMain.handle('timer:get-status'"))
    expect(detection).toContain("remoteStartCoordinator.startParentPinAuthorized(pinProcess, perSessionMinutes)")
    expect(detection.indexOf('requiresParentPinForRepeatSession(usageToday?.sessionsCompleted ?? 0)')).toBeLessThan(detection.indexOf('const remoteState = remoteApprovalController.getState()'))
    expect(timerIpc.indexOf('requiresParentPinForRepeatSession(sessionsCompleted)')).toBeLessThan(timerIpc.indexOf('const remoteState = remoteApprovalController.getState()'))
    expect(main).toContain("source === 'local' && permission.householdId === 'policy' && permission.requestId.startsWith('parent-pin-')")
  })

  it('treats missing legacy setting as approval-required for safety', () => {
    expect(normalizeRequireApprovalBeforeStart(undefined)).toBe(true)
    expect(normalizeRequireApprovalBeforeStart('bad')).toBe(true)
    expect(normalizeRequireApprovalBeforeStart(false)).toBe(false)
  })

  it('keeps default PIN hash as the full sha256 of 0000', () => {
    expect(DEFAULT_SETTINGS.adminPasswordHash).toBe(createHash('sha256').update('0000').digest('hex'))
    expect(DEFAULT_SETTINGS.adminPasswordHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
