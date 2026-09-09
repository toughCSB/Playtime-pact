import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProtectedUsageStore, publicUsageView } from '../src/main/remoteApproval/protectedUsage'

const directories = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pact-usage-'))
  directories.push(dir)
  let day = '2026-09-09'
  const store = new ProtectedUsageStore(dir, () => day)
  store.initialize(() => null)
  return { dir, store, day: (next) => { day = next } }
}
const credit = { receipt: 'timer:policy:fixture-0001', amountMs: 60_000, date: '2026-09-09' }
describe('protected desktop usage', () => {
  it('counts a base session expiring while closed exactly once across reads, restart and delayed writes', () => {
    const { dir } = fixture()
    let now = 1000
    const store = new ProtectedUsageStore(dir, () => '2026-09-09', () => now)
    const running = store.write({ ...store.read().usage, currentSessionRemainingMs: 60_000 }, 0, credit, true)
    now = 61_000
    expect(store.read().usage).toMatchObject({ sessionsCompleted: 1, currentSessionRemainingMs: 0 })
    expect(store.read().usage.sessionsCompleted).toBe(1)
    const restarted = new ProtectedUsageStore(dir, () => '2026-09-09', () => now)
    const delayed = restarted.write(running.usage, running.revision, undefined, true)
    expect(delayed.usage).toMatchObject({ sessionsCompleted: 1, currentSessionRemainingMs: 0 })
    expect(restarted.read().usage.sessionsCompleted).toBe(1)
  })
  it('does not count parent-only time, but preserves the pending base count when extended', () => {
    const { dir } = fixture()
    let now = 1000
    const store = new ProtectedUsageStore(dir, () => '2026-09-09', () => now)
    const base = store.write({ ...store.read().usage, currentSessionRemainingMs: 60_000 }, 0, credit, true)
    now += 30_000
    const parentCredit = { ...credit, receipt: 'parent:fixture-0001', countsTowardDailySessions: false }
    const extended = store.write({ ...base.usage, currentSessionRemainingMs: 90_000 }, base.revision, parentCredit, true)
    now += 90_000
    expect(store.read().usage.sessionsCompleted).toBe(1)
    const parentOnly = store.write({ ...store.read().usage, currentSessionRemainingMs: 60_000 }, extended.revision,
      { ...parentCredit, receipt: 'parent:fixture-0002' }, true)
    now += 60_000
    expect(store.read().usage.sessionsCompleted).toBe(1)
    const finished = store.write(store.read().usage, parentOnly.revision)
    expect(finished.usage.sessionsCompleted).toBe(1)
  })
  it('does not expose the credit journal in the bounded client response', () => {
    const { store } = fixture()
    const snapshot = { ...store.read(), credits: Array(4096).fill('x'.repeat(256)) }
    const view = publicUsageView(snapshot)
    expect(view).not.toHaveProperty('credits')
    expect(JSON.stringify(view).length).toBeLessThan(1000)
  })
  it('requires a journal credit for increases and never lets the same credit mint time twice', () => {
    const { store } = fixture()
    const initial = store.read()
    const usage = { ...initial.usage, currentSessionRemainingMs: 60_000 }
    expect(() => store.write(usage, initial.revision)).toThrow('unused credit')
    const credited = store.write(usage, initial.revision, credit)
    const spent = store.write({ ...usage, currentSessionRemainingMs: 10_000 }, credited.revision)
    expect(() => store.write(usage, spent.revision, credit)).toThrow('unused credit')
    expect(store.read().usage.currentSessionRemainingMs).toBe(10_000)
  })
  it('rejects stale writes across independent client/store instances', () => {
    const { dir, store } = fixture()
    const other = new ProtectedUsageStore(dir, () => '2026-09-09')
    const first = store.read(), stale = other.read()
    store.write({ ...first.usage, sessionsCompleted: 1 }, first.revision)
    expect(() => other.write(stale.usage, stale.revision)).toThrow('revision conflict')
    expect(other.read().usage.sessionsCompleted).toBe(1)
  })
  it('rejects completion rollback and unbounded numeric values', () => {
    const { store } = fixture()
    const next = store.write({ ...store.read().usage, sessionsCompleted: 1 }, 0)
    expect(() => store.write({ ...next.usage, sessionsCompleted: 0 }, next.revision)).toThrow('counter rollback')
    expect(() => store.write({ ...next.usage, currentSessionRemainingMs: Infinity }, next.revision)).toThrow('value invalid')
  })
  it('rejects pre-midnight queued writes and yesterday credits without applying them to today', () => {
    const { store, day } = fixture()
    const old = store.read()
    day('2026-09-10')
    expect(() => store.write(old.usage, old.revision)).toThrow('date or value')
    const next = store.read()
    expect(next.usage).toEqual({ date: '2026-09-10', sessionsCompleted: 0, currentSessionRemainingMs: 0 })
    expect(() => store.write(next.usage, next.revision, credit)).toThrow('credit invalid')
    day('2026-09-09')
    expect(() => store.read()).toThrow('date rollback')
  })
  it('preserves migrated usage and never reruns migration or resets corrupted data', () => {
    const { dir, store } = fixture()
    const initial = store.read()
    store.write({ ...initial.usage, sessionsCompleted: 2 }, initial.revision)
    const before = readFileSync(join(dir, 'desktop-usage.json'), 'utf8')
    store.initialize(() => { throw new Error('must not migrate twice') })
    expect(readFileSync(join(dir, 'desktop-usage.json'), 'utf8')).toBe(before)
    writeFileSync(join(dir, 'desktop-usage.json'), 'corrupt')
    expect(() => store.initialize(() => null)).toThrow()
    expect(readFileSync(join(dir, 'desktop-usage.json'), 'utf8')).toBe('corrupt')
  })
  it('propagates failed legacy integrity validation without manufacturing empty usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pact-usage-migrate-'))
    directories.push(dir)
    const store = new ProtectedUsageStore(dir, () => '2026-09-09')
    expect(() => store.initialize(() => { throw new Error('legacy HMAC invalid') })).toThrow('HMAC invalid')
    expect(() => store.read()).toThrow()
    store.initialize(() => ({ date: '2026-09-09', sessionsCompleted: 1, currentSessionRemainingMs: 12_345 }))
    expect(store.read().usage.currentSessionRemainingMs).toBe(12_345)
  })
  it('keeps an active deadline across restart and cannot restore played time with an old timer value', () => {
    const { dir } = fixture()
    let now = 1000
    const store = new ProtectedUsageStore(dir, () => '2026-09-09', () => now)
    const running = store.write({ ...store.read().usage, currentSessionRemainingMs: 60_000 }, 0, credit, true)
    now += 30_000
    const restarted = new ProtectedUsageStore(dir, () => '2026-09-09', () => now)
    expect(restarted.read().usage.currentSessionRemainingMs).toBe(30_000)
    const attemptedRestore = restarted.write({ ...running.usage, currentSessionRemainingMs: 60_000 }, running.revision, undefined, true)
    expect(attemptedRestore.usage.currentSessionRemainingMs).toBe(30_000)
    now += 10_000
    const paused = restarted.write({ ...running.usage, currentSessionRemainingMs: 30_000 }, attemptedRestore.revision)
    expect(paused.usage.currentSessionRemainingMs).toBe(20_000)
    now += 120_000
    expect(restarted.read().usage.currentSessionRemainingMs).toBe(20_000)
  })
})
