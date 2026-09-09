import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
const section = (start, end) => main.slice(main.indexOf(start), main.indexOf(end))
const source = ts.transpileModule([
  section('function completeActiveTimer', 'function adjustActiveTimer'),
  section('function startTimerForDetectedManagedGames', 'function getActiveDisplay'),
  section('function startManagedGameDetection', 'type QaOverlayMode'),
].join('\n'), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText

function harness(success) {
  return new Function('terminationSuccess', `
    const isManagedGameTerminationInFlight = () => false
    let timerLimitMs = 60_000, timerStart = 1, timerStartReceipt = 'timer:policy:fixture'
    let gameTerminationPending = false, gameTerminationAttemptFinished = false, timerAdjustmentInFlight = false
    let timerSessionStartTime = '20:00', timerLimitAtSession = 1, mainWindowPresentation = 'active-overlay', blockedFailureContext = null
    let activeManagedGameIds = ['roblox'], quotaPresenceSpans = [], quotaPrimarySelectionEvents = [], timerUiMode = 'corner'
    let accountingIntegrityFault = false, managedGameDetectInterval = null
    let gamePresent = true, deadline, detect, starts = 0, usage = { sessionsCompleted: 0 }, history = [], sent = []
    const mainWindow = { setBounds() {}, setAlwaysOnTop() {}, setSkipTaskbar() {}, isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }
    const getLocalDateString = () => '2026-09-08', getLocalTimeString = () => '20:01', getDailyUsage = () => usage
    const getSessionHistoryGameId = () => 'roblox', closeOpenPresenceSpans = () => {}, getCenterInfo = () => ({ w: 300, h: 200, x: 20, y: 20 })
    const safeWriteDailyUsage = (value) => { usage = value }, safeAppendSession = (value) => history.push(value)
    const stopTimerInternals = () => { timerLimitMs = null; timerStart = null }
    const setTimeout = (callback) => { deadline = callback }, setInterval = (callback) => { detect = callback; return 1 }
    const hideToTray = () => {}, terminateSupportedGames = async () => ({ success: terminationSuccess, remainingGameIds: terminationSuccess ? [] : ['roblox'] })
    const getManagedGameSnapshotCapture = () => ({ succeeded: true, snapshot: { activeGameIds: gamePresent ? ['roblox'] : [] } })
    ${source}
    return {
      expire: () => completeActiveTimer(mainWindow),
      detect: () => { if (!detect) startManagedGameDetection(); return detect() },
      closeGame: () => { gamePresent = false },
      startDuringShutdown: () => startTimerForDetectedManagedGames({ activeGameIds: ['roblox'] }),
      finish: () => deadline(),
      state: () => ({ pending: gameTerminationPending, history, usage, sent })
    }
  `)(success)
}

describe('managed game expiry lifecycle', () => {
  it('blocks new starts until actual termination has completed and only then records successful termination', async () => {
    const app = harness(true)
    app.expire()
    expect(app.startDuringShutdown()).toBe(false)
    app.closeGame()
    await app.detect()
    expect(app.state().pending).toBe(true)
    expect(app.state().history).toEqual([])
    await app.finish()
    expect(app.state().pending).toBe(false)
    expect(app.state().history).toEqual([expect.objectContaining({ terminated: true })])
    expect(app.state().usage.sessionsCompleted).toBe(1)
  })
  it('keeps failed termination blocking while the game remains, and clears only after observing it closed', async () => {
    const app = harness(false)
    app.expire()
    await app.finish()
    await app.detect()
    expect(app.startDuringShutdown()).toBe(false)
    expect(app.state().history).toEqual([expect.objectContaining({ terminated: false })])
    expect(app.state().pending).toBe(true)
    app.closeGame()
    await app.detect()
    expect(app.state().pending).toBe(false)
  })
})
