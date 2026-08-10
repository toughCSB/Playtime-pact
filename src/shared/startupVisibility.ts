export type StartupWindowAction = 'show-main-window' | 'hide-to-tray' | 'keep-resumed-window'

const HIDDEN_LAUNCH_FLAGS = new Set([
  '--start-hidden',
  '--background',
  '--hidden',
  '--autostart',
  '--from-watchdog',
])

export function shouldStartHiddenFromLaunch(options: {
  argv: readonly string[]
  isPackaged: boolean
}): boolean {
  const flags = new Set(options.argv.map(arg => arg.toLowerCase()))
  if (flags.has('--show-main')) return false
  if ([...flags].some(arg => HIDDEN_LAUNCH_FLAGS.has(arg))) return true
  return options.isPackaged
}

export function decideStartupWindowAction(options: {
  startHidden: boolean
  resumedTimer: boolean
}): StartupWindowAction {
  if (options.resumedTimer) return 'keep-resumed-window'
  return options.startHidden ? 'hide-to-tray' : 'show-main-window'
}
