import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const source = readFileSync('build/installer.nsh', 'utf8')
const macro = (name) => source.slice(source.indexOf(`!macro ${name}\n`), source.indexOf('!macroend', source.indexOf(`!macro ${name}\n`)))
describe('installer rollback boundaries', () => {
  it('does not destroy protected policy selectors on uninstall or update', () => {
    expect(source).not.toMatch(/DeleteRegKey\s+HKLM\s+"Software\\PlaytimePact"/i)
  })
  it('authenticates before reversible shutdown and does not unregister before staging', () => {
    const auth = macro('customUnInit')
    expect(auth).toContain('PIN verification failed')
    expect(auth).not.toContain(' stop')
    expect(auth).not.toContain('" uninstall')
    const stop = macro('customUnInstall')
    expect(stop).toContain('previous-watchdog-disabled.flag')
    expect(stop).not.toContain('DeleteRegKey')
    expect(stop).not.toContain('schtasks /delete')
    expect(stop).not.toContain('" uninstall')
  })
  it('restores files and the service before reporting a file-lock failure', () => {
    const remove = macro('customRemoveFiles')
    const stage = remove.indexOf('Call un.atomicRMDir')
    const restore = remove.indexOf('Call un.restoreFiles')
    const restart = remove.indexOf('PlaytimePactPrivilegedBroker.exe" start')
    const abort = remove.indexOf('Abort "Installation files are in use."')
    const unregister = remove.indexOf('sc.exe delete PlaytimePactPrivilegedBroker')
    expect(stage).toBeGreaterThanOrEqual(0)
    expect(restore).toBeGreaterThan(stage)
    expect(restart).toBeGreaterThan(restore)
    expect(abort).toBeGreaterThan(restart)
    expect(unregister).toBeGreaterThan(abort)
  })
})
