import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { runManagedProcessCapture, terminateSupportedGames, isManagedGameTerminationInFlight } from '../src/main/managedGameRuntime'

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('non-blocking managed process capture', () => {
  it.skipIf(process.platform !== 'win32')('shares shutdown across concurrent callers and releases the operation afterwards', async () => {
    const calls: Function[] = []
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      calls.push(args.at(-1)); return { kill: vi.fn() } as any
    })
    const first = terminateSupportedGames()
    const second = terminateSupportedGames()
    expect(second).toBe(first)
    expect(isManagedGameTerminationInFlight()).toBe(true)
    expect(calls).toHaveLength(1)
    calls[0](null, '[]')
    expect(await first).toEqual({ success: true, remainingGameIds: [] })
    expect(isManagedGameTerminationInFlight()).toBe(false)
    const next = terminateSupportedGames()
    expect(next).not.toBe(first)
    calls[1](null, '[]')
    await next
  })

  it('lets the countdown reach expiry even when a child never closes, then ignores late output', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn(), stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } }
    let complete: Function = () => {}
    vi.mocked(execFile).mockImplementation((...args: any[]) => { complete = args.at(-1); return child as any })
    let remaining = 3
    const tick = setInterval(() => { remaining = Math.max(0, remaining - 1) }, 1000)
    const pending = runManagedProcessCapture('fixture').catch(error => error.message)
    await vi.advanceTimersByTimeAsync(5000)
    expect(remaining).toBe(0)
    expect(await pending).toBe('Managed process capture timed out')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.stdout.destroy).toHaveBeenCalledOnce()
    expect(child.stderr.destroy).toHaveBeenCalledOnce()
    complete(null, 'late private output')
    expect(await pending).toBe('Managed process capture timed out')
    clearInterval(tick)
  })

  it('returns successful output and cancels its deadline', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn() }
    let complete: Function = () => {}
    vi.mocked(execFile).mockImplementation((...args: any[]) => { complete = args.at(-1); return child as any })
    const pending = runManagedProcessCapture('fixture')
    complete(null, '[]')
    expect(await pending).toBe('[]')
    await vi.advanceTimersByTimeAsync(6000)
    expect(child.kill).not.toHaveBeenCalled()
  })
})
