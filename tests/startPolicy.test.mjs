import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'

import { DEFAULT_SETTINGS } from '../src/shared/types'
import {
  shouldRequireApprovalForStart,
  normalizeRequireApprovalBeforeStart,
} from '../src/shared/startPolicy'

describe('parent approval start policy', () => {
  it('defaults to requiring parent approval before a fresh game session starts', () => {
    expect(DEFAULT_SETTINGS.requireApprovalBeforeStart).toBe(true)
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: false })).toBe(true)
  })

  it('does not require approval when the parent chooses automatic start mode', () => {
    const settings = { ...DEFAULT_SETTINGS, requireApprovalBeforeStart: false }
    expect(shouldRequireApprovalForStart(settings, { hasActiveSession: false })).toBe(false)
  })

  it('does not ask for approval again when resuming an already active remaining session', () => {
    expect(shouldRequireApprovalForStart(DEFAULT_SETTINGS, { hasActiveSession: true })).toBe(false)
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
