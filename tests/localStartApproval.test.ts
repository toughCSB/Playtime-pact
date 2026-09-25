import { describe, it, expect } from 'vitest'
import { LocalStartApproval } from '../src/shared/localStartApproval'

describe('local parent start approval', () => {
  const fixture = () => {
    let wall = 1_000_000, mono = 100
    return {
      approval: new LocalStartApproval(() => wall, () => mono),
      advance: (ms: number) => { wall += ms; mono += ms },
      rollback: () => { wall -= 1000 },
      now: () => wall,
    }
  }
  it('denies without a PIN-issued approval and accepts only one fresh launch', () => {
    const f = fixture()
    expect(f.approval.claim(f.now(), 1)).toBe(false)
    f.approval.issue(1)
    expect(f.approval.claim(f.now(), 1)).toBe(false)
    f.advance(100)
    expect(f.approval.claim(f.now(), 1)).toBe(true)
    expect(f.approval.claim(f.now(), 1)).toBe(false)
  })
  it('expires after five minutes even if wall time changes', () => {
    const f = fixture()
    f.approval.issue(1); f.advance(300_000)
    expect(f.approval.claim(f.now(), 1)).toBe(false)
    f.approval.issue(1); f.rollback()
    expect(f.approval.claim(f.now(), 1)).toBe(false)
  })
  it('invalidates on a policy revision and rejects untrusted process timestamps', () => {
    const f = fixture()
    f.approval.issue(1); f.advance(100)
    expect(f.approval.claim(NaN, 1)).toBe(false)
    expect(f.approval.claim(f.now() + 1, 1)).toBe(false)
    expect(f.approval.claim(f.now(), 2)).toBe(false)
    expect(f.approval.claim(f.now(), 1)).toBe(false)
  })
  it('clears an unused approval when an existing session resumes', () => {
    const f = fixture()
    f.approval.issue(1)
    f.approval.clear()
    f.advance(100)
    expect(f.approval.claim(f.now(), 1)).toBe(false)
  })
})
