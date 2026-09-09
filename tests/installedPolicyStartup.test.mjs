import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
const dateHelpers = main.slice(
  main.indexOf('function dateTimePart'),
  main.indexOf('function getLocalTimeString'),
)
const blockedNotice = main.slice(
  main.indexOf('function showSupportedGameBlocked'),
  main.indexOf('function enforceManagedGameBlock'),
)
const executable = ts.transpileModule(`${dateHelpers}\n${blockedNotice}`, {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2020 },
}).outputText

const presentStartupBlock = new Function(`
  let protectedLocalPolicy = null
  let blockedApprovalGameId = null
  let lastManagedGameBlockedReason = ''
  const sent = []
  const mainWindow = { webContents: { send: (...args) => sent.push(args) } }
  const readSettings = () => ({ allowedStartHour: 8, allowedEndHour: 22 })
  const buildManagedGameEventPayload = (gameId) => ({ gameId })
  const restoreMainFullPageWindow = () => undefined
  ${executable}
  showSupportedGameBlocked('outside-hours', 'minecraft')
  return sent
`)

describe('installed protected-policy startup', () => {
  it('never revives a positive timer file when protected remaining is zero and daily slots remain', async () => {
    const source = ts.transpileModule(main.slice(main.indexOf('async function tryResumeTimer'), main.indexOf('function getAdminFullPageGeometry')),
      { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
    const result = new Function(`
      const isManagedGameTerminationInFlight = () => false
      const protectedLocalPolicy = {}, accountingIntegrityFault = false, mainWindow = { isDestroyed: () => false }
      const timerStart = null, gameTerminationPending = false, timerAdjustmentInFlight = false
      const getManagedGameSnapshotCapture = async () => ({ succeeded: true, snapshot: { activeGameIds: [] } })
      const readSettings = () => ({ resumeTimerOnRestart: true })
      const readTimerState = () => ({ date: '2026-09-09', pausedRemainingMs: 60000 })
      const getLocalDateString = () => '2026-09-09', isSessionExhausted = () => false
      const getDailyUsage = () => ({ date: '2026-09-09', currentSessionRemainingMs: 0, sessionsCompleted: 1 })
      const safeClearTimerState = () => {}
      const startTimer = () => { throw new Error('must not start') }
      ${source}
      return tryResumeTimer()
    `)()
    expect(await result).toBe(false)
  })
  it.each([
    [null, true],
    [null, false],
    [{ ianaTimeZone: 'Asia/Seoul' }, true],
  ])('does not read or discard saved timers before policy and accounting are ready (%j, %s)', async (policy, fault) => {
    const resumeSource = ts.transpileModule(main.slice(
      main.indexOf('async function tryResumeTimer'),
      main.indexOf('function getAdminFullPageGeometry'),
    ), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
    const resume = new Function('protectedLocalPolicy', 'accountingIntegrityFault', `
      const mainWindow = {}
      const readSettings = () => { throw new Error('must not read local settings') }
      const readTimerState = () => { throw new Error('must not touch saved timers') }
      ${resumeSource}
      return tryResumeTimer()
    `)
    expect(await resume(policy, fault)).toBe(false)
  })
  it('presents a fail-closed managed-game block when protected policy is unavailable', () => {
    // Given: ordinary packaged startup has not loaded protected policy into the main process.
    // When: managed-game enforcement presents its fail-closed startup notice.
    const sent = presentStartupBlock()

    // Then: the block reaches the renderer instead of crashing the main process.
    expect(sent).toEqual([[
      'game:blocked',
      expect.objectContaining({ gameId: 'minecraft', reason: 'outside-hours' }),
    ]])
  })
})
