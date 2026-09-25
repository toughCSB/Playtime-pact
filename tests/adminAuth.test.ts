import { describe, expect, it } from 'vitest'
import { clearAdminSession, clearAllAdminSessions, grantAdminSession, hasAdminSession, requireAdminSession } from '../src/main/adminAuth'

const event = (id: number) => ({ sender: { id } }) as Parameters<typeof grantAdminSession>[0]

describe('parent administration lock', () => {
  it('keeps an open parent screen authorized until it is explicitly locked', () => {
    const parent = event(501)
    const otherWindow = event(502)
    grantAdminSession(parent)
    expect(hasAdminSession(parent)).toBe(true)
    expect(hasAdminSession(otherWindow)).toBe(false)
    expect(() => requireAdminSession(parent)).not.toThrow()
    clearAdminSession(501)
    expect(() => requireAdminSession(parent)).toThrow('admin authorization required')
  })
  it('locks every open parent renderer together', () => {
    const first = event(503)
    const second = event(504)
    grantAdminSession(first)
    grantAdminSession(second)
    clearAllAdminSessions()
    expect(hasAdminSession(first)).toBe(false)
    expect(hasAdminSession(second)).toBe(false)
  })
})
