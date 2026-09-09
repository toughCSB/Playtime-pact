import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
const extract = (start, end) => main.slice(main.indexOf(start), main.indexOf(end))
const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText

it('an authorized reduction past zero reaches completion while the adjustment lock remains held', () => {
  const adjustment = compile(extract('function adjustActiveTimer', 'async function adjustManagedTime'))
  const completionGuard = extract('function completeActiveTimer', '  gameTerminationPending = true')
  const source = compile(`${completionGuard}\n gameTerminationPending = true; timerLimitMs = null; }`)
  const result = new Function(`
    const isManagedGameTerminationInFlight = () => false
    let timerStart = Date.now(), timerLimitMs = 600000, timerLimitAtSession = 10
    let gameTerminationPending = false, timerAdjustmentInFlight = true
    const mainWindow = {}, normalizeTimerAdjustmentMinutes = x => x
    ${source}
    ${adjustment}
    const remaining = adjustActiveTimer(-15)
    return { remaining, gameTerminationPending, timerLimitMs, timerAdjustmentInFlight }
  `)()
  expect(result).toEqual({ remaining: 0, gameTerminationPending: true, timerLimitMs: null, timerAdjustmentInFlight: true })
})

it('defers game-close pause until the credited time has been applied and persisted', async () => {
  const adjustment = compile(extract('async function adjustManagedTime', 'type StartTimerOptions'))
  const pause = compile(extract('function pauseTimerBecauseManagedGamesClosed', 'function readPausedTimerResumeState'))
  const run = new Function(`return (async () => {
    const isManagedGameTerminationInFlight = () => false
    let timerAdjustmentInFlight = false, deferredClosedGameId = null, timerStart = 1
    let gameTerminationPending = false, accountingIntegrityFault = false
    const activeManagedGameIds = [], normalizeTimerAdjustmentMinutes = x => x
    let usage = { date: '2026-09-09', sessionsCompleted: 0, currentSessionRemainingMs: 600000 }
    let timerRemaining = 600000, pausedRemaining = null, usageWriteQueue = Promise.resolve()
    let resolveCredit, enteredCredit
    const entered = new Promise(resolve => { enteredCredit = resolve })
    const creditGate = new Promise(resolve => { resolveCredit = resolve })
    const remoteApprovalController = { isRecoveryInProgress: () => false }
    const getDailyUsage = () => usage, readTimerState = () => null
    const getLocalDateString = () => '2026-09-09', randomUUID = () => 'test'
    const privilegedBroker = { grantLocalTime: async () => {} }
    const persistProtectedUsage = async next => { enteredCredit(); await creditGate; usage = next }
    const adjustActiveTimer = delta => { timerRemaining += delta * 60000; return timerRemaining / 1000 }
    const shouldPauseTimerWhenSupportedGameMissing = running => running
    const pauseActiveTimer = () => { pausedRemaining = timerRemaining; usage = { ...usage, currentSessionRemainingMs: timerRemaining }; timerStart = null }
    const mainWindow = null, buildManagedGameEventPayload = () => ({})
    ${pause}
    ${adjustment}
    const adjusting = adjustManagedTime(10)
    await entered
    pauseTimerBecauseManagedGamesClosed('minecraft')
    const pausedBeforeCredit = pausedRemaining
    resolveCredit()
    const remaining = await adjusting
    return { remaining, pausedBeforeCredit, pausedRemaining, usage, timerStart, timerAdjustmentInFlight }
  })()`)
  expect(await run()).toMatchObject({ remaining: 1200, pausedBeforeCredit: null, pausedRemaining: 1200000,
    usage: { currentSessionRemainingMs: 1200000 }, timerStart: null, timerAdjustmentInFlight: false })
})
