const { contextBridge, ipcRenderer } = require('electron')

const scenarioArg = process.argv.find((value) => value.startsWith('--layout-scenario='))
const scenario = scenarioArg ? scenarioArg.slice('--layout-scenario='.length) : 'play-ready'
const listeners = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
const fail = (name) => Promise.reject(new Error(`layout fixture: ${name}`))
const currentHour = new Date().getHours()
const outsideHours = scenario === 'play-outside-hours'
const settings = {
  weekdayLimit: scenario === 'settings-validation-error' ? Number.NaN : 60,
  weekendLimit: 90,
  weekdaySessionCount: 2,
  weekendSessionCount: 2,
  allowedStartHour: outsideHours ? (currentHour === 0 ? 1 : 0) : 6,
  allowedEndHour: outsideHours ? (currentHour === 0 ? 2 : currentHour) : 23,
  requireApprovalBeforeStart: ['play-approval', 'modal-long-korean-error'].includes(scenario),
  resumeTimerOnRestart: true,
  updatedAt: '2026-08-02T00:00:00.000Z',
}

// This bridge intentionally exposes only the renderer's public preload contract.
contextBridge.exposeInMainWorld('api', {
  readSettings: async () => scenario === 'settings-read-error' ? fail('readSettings') : settings,
  writeSettings: async (next) => scenario === 'settings-save-error' ? fail('writeSettings') : next,
  readSessions: async () => [],
  startTimer: async () => ({ resumed: false, remainingSeconds: 3600, exhausted: false }),
  minimizeMainWindow: async () => {},
  hideMainWindow: async () => {},
  hideMainWindowNow: () => {},
  showMainWindow: async () => {},
  timerGetStatus: async () => ({
    running: ['admin-action-error', 'play-active-overlay'].includes(scenario),
    remainingSeconds: ['admin-action-error', 'play-active-overlay'].includes(scenario) ? 1800 : 0,
    mode: 'corner',
    activeGameIds: scenario === 'play-active-overlay' ? ['roblox'] : [],
    primaryGameId: scenario === 'play-active-overlay' ? 'roblox' : undefined,
  }),
  timerAdjustTime: async (minutes) => scenario === 'admin-action-error' ? fail('timerAdjustTime') : ({ remainingSeconds: Math.max(0, 1800 + minutes * 60) }),
  timerAdminStop: async () => scenario === 'admin-action-error' ? fail('timerAdminStop') : undefined,
  adminVerifyPassword: async () => scenario !== 'admin-pin',
  adminUnlockSettings: async () => true,
  adminApproveNextSession: async () => scenario === 'modal-long-korean-error'
    ? fail('adminApproveNextSession')
    : { ok: true, launchedPendingGame: false },
  adminChangePassword: async () => {},
  adminCloseWindow: async () => {},
  adminGetResumeOption: async () => true,
  adminSetResumeOption: async () => {},
  shutdownApp: async () => {},
  dailyGetRemaining: async () => ({
    date: '2026-08-02',
    sessionsCompleted: scenario === 'play-exhausted' ? 2 : 0,
    sessionsPerDay: 2,
    currentSessionActive: false,
    remainingSeconds: scenario === 'play-exhausted' ? 0 : 7200,
    exhausted: scenario === 'play-exhausted',
  }),
  onTimerTick: listeners('timer:tick'),
  onTimerWarning: listeners('timer:warning'),
  onTimerExpired: listeners('timer:expired'),
  onTimerTerminationFailed: listeners('timer:termination-failed'),
  onTimerMode: listeners('timer:mode'),
  onTimerResumed: listeners('timer:resumed'),
  onTimerAdminStopped: listeners('timer:admin-stopped'),
  onSupportedGameDetected: listeners('game:detected'),
  onSupportedGameClosed: listeners('game:closed'),
  onSupportedGameBlocked: listeners('game:blocked'),
})
