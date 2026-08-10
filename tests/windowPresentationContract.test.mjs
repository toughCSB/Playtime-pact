import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('native window presentation contract', () => {
  it('keeps main and admin full pages responsive, transparent, and non-resizable', () => {
    const main = read('src/main/main.ts')
    expect(main).toContain('getFullPageWindowGeometry(display.workArea, MAIN_WINDOW_PROFILE)')
    expect(main).toContain('getFullPageWindowGeometry(display.workArea, ADMIN_WINDOW_PROFILE)')
    expect(main.match(/resizable: false/g)).toHaveLength(2)
    expect(main.match(/transparent: true/g)).toHaveLength(2)
    expect(main).toContain('restoreMainFullPageWindow')
    expect(main).toContain('showMainWindowForCurrentPresentation')
  })

  it('uses responsive overlay geometry and prohibits experimental hit shaping', () => {
    const main = read('src/main/main.ts')
    const geometry = read('src/main/windowGeometry.ts')
    expect(main).toContain('getCornerOverlayGeometry(getActiveDisplay().workArea)')
    expect(main).toContain('getWarningOverlayGeometry(getActiveDisplay().workArea)')
    expect(geometry).toContain('CORNER_HORIZONTAL_INSET_RATIO')
    expect(geometry).toContain('WARNING_CENTER_Y_RATIO')
    expect(main).not.toContain('.setShape(')
    expect(main).not.toContain('.setIgnoreMouseEvents(')
  })

  it('restores warning popups to the exact draggable corner bounds', () => {
    const main = read('src/main/main.ts')
    expect(main).toContain("mainWindow.on('moved'")
    expect(main).toContain('rememberCornerOverlayBounds(win)')
    expect(main).toContain('const epoch = moveToCenterPopup(win)')
    expect(main).toContain('restoreCornerAfterPopup(win, epoch)')
    expect(main).toContain('lastCornerOverlayBounds ??')
  })

  it('moves direct termination failures to the existing center geometry without a fake shutdown event', () => {
    const main = read('src/main/main.ts')
    const helper = main.slice(main.indexOf('function moveToBlockedFailureOverlay'), main.indexOf('function clearBlockedFailureViaGameClosed'))
    expect(helper).toContain('getCenterInfo()')
    expect(helper).toContain("mainWindowPresentation = 'blocked-failure-overlay'")
    expect(helper).toContain("setAlwaysOnTop(true, 'floating')")
    expect(helper).not.toContain("send('timer:mode'")
  })

  it('preserves compact geometry for active outside-hours shutdown', () => {
    const main = read('src/main/main.ts')
    expect(main).toContain("showSupportedGameBlocked('outside-hours', primaryManagedGameId ?? activeManagedGameIds[0], { preserveCompact: true })")
    expect(main).toContain("mainWindowPresentation = 'shutdown-overlay'")
  })
  it('keeps unavailable process inspection from being treated as a zero-game closure', () => {
    const main = read('src/main/main.ts')
    const runtime = read('src/main/managedGameRuntime.ts')
    expect(runtime).toContain('export function getManagedGameSnapshotCapture(): ManagedGameCaptureResult')
    expect(main.match(/if \(!capture\.succeeded\) return/g).length).toBeGreaterThanOrEqual(2)
    expect(main).toContain('const capture = getManagedGameSnapshotCapture()')
    const activeTimerLoop = main.slice(main.indexOf('timerInterval = setInterval'), main.indexOf('function tryResumeTimer'))
    expect(activeTimerLoop).toContain('if (capture.succeeded)')
    expect(activeTimerLoop).not.toContain('if (!capture.succeeded) return')
    expect(activeTimerLoop).toContain('if (!isAllowedHour())')
  })

  it('clears every blocked-failure reason when a confirmed snapshot is empty without a closure delta', () => {
    const main = read('src/main/main.ts')
    const idleDetectionStart = main.indexOf('const presenceUpdate = applyManagedGameSnapshot(snapshot, { trackTimeline: false })')
    const idleDetection = main.slice(
      idleDetectionStart,
      main.indexOf('if (!isAllowedHour())', idleDetectionStart),
    )
    expect(idleDetection).toContain('if (blockedFailureContext && mainWindow && !mainWindow.isDestroyed())')
    expect(idleDetection).toContain('clearBlockedFailureViaGameClosed(mainWindow)')
    expect(idleDetection.indexOf('clearBlockedFailureViaGameClosed(mainWindow)')).toBeLessThan(
      idleDetection.indexOf('presenceUpdate.closedGameIds.length > 0'),
    )
    const clearFailure = main.slice(
      main.indexOf('function clearBlockedFailureViaGameClosed'),
      main.indexOf('function showSupportedGameBlocked'),
    )
    expect(clearFailure).toContain("reason === 'approval-required'")
    expect(main).toContain("reason: 'outside-hours' | 'daily-exhausted' | 'approval-required'")
  })

  it('uses presentation state to preserve terminal compact bounds while restoring active timers to the corner', () => {
    const main = read('src/main/main.ts')
    const showMain = main.slice(
      main.indexOf("ipcMain.handle('window:show-main'"),
      main.indexOf("ipcMain.handle('app:shutdown'"),
    )
    expect(showMain).toContain("mainWindowPresentation === 'active-overlay'")
    expect(showMain).toContain('moveToCorner(mainWindow)')
    expect(showMain).toContain('showMainWindowForCurrentPresentation(mainWindow)')
    expect(showMain).not.toContain('restoreMainFullPageWindow(mainWindow)')
  })

  it('waits for verified admin termination before persisting a resumable timeline', () => {
    const main = read('src/main/main.ts')
    const adminStop = main.slice(
      main.indexOf("ipcMain.handle('timer:admin-stop'"),
      main.indexOf("ipcMain.handle('admin:close-window'"),
    )
    expect(adminStop).toContain('const termination = await terminateSupportedGames()')
    expect(adminStop).toContain('if (!termination.success)')
    expect(adminStop).toContain("closeOpenPresenceSpans(activeManagedGameIds, 'admin-stop')")
    expect(adminStop).toContain('persistPausedTimer()')
    expect(adminStop).toContain('pauseTimerInternals()')
    expect(adminStop).not.toContain('stopTimerInternals()')
    expect(adminStop.indexOf('await terminateSupportedGames()')).toBeLessThan(adminStop.indexOf('persistPausedTimer()'))
    expect(adminStop).toContain("throw new Error('Managed game termination failed')")
    expect(adminStop.indexOf("throw new Error('Managed game termination failed')")).toBeLessThan(adminStop.indexOf('persistPausedTimer()'))
    expect(main).not.toContain("ipcMain.handle('timer:stop'")
  })
})
