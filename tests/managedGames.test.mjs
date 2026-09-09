import { describe, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'

import {
  classifyManagedGameProcess,
  collectManagedGameSnapshot,
  listSecondaryManagedGames,
  selectPrimaryManagedGame,
  splitWindowsCommandLine,
} from '../src/shared/managedGames'

import { buildWindowsIdentityTerminationScript, buildWindowsProcessCaptureScript, buildWindowsTerminationArgs, normalizeProcessRecords } from '../src/main/managedGameRuntime'
describe('managed game helpers', () => {
  it('splits Windows command lines while preserving quoted arguments', () => {
    expect(splitWindowsCommandLine('"C:\\Program Files\\Minecraft\\MinecraftLauncher.exe" --workDir "C:\\Users\\Kid\\.minecraft"')).toEqual([
      'C:\\Program Files\\Minecraft\\MinecraftLauncher.exe',
      '--workDir',
      'C:\\Users\\Kid\\.minecraft',
    ])
  })

  it('classifies Minecraft Java processes from command-line hints', () => {
    expect(classifyManagedGameProcess({
      name: 'javaw.exe',
      executablePath: 'C:\\Program Files\\Java\\bin\\javaw.exe',
      commandLine: 'javaw.exe -jar fabric-loader.jar --gameDir C:\\Users\\Kid\\AppData\\Roaming\\.minecraft',
    })).toBe('minecraft')
  })

  it('does not classify the vanilla launcher before a game process starts', () => {
    expect(classifyManagedGameProcess({
      name: 'MinecraftLauncher.exe',
      executablePath: 'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe',
      commandLine: '"C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe"',
    })).toBeNull()
  })

  it('ignores the Lunar launcher and classifies its game process for PID-targeted control', () => {
    const snapshot = collectManagedGameSnapshot([
      {
        processId: 5101,
        processStartedAt: 1_700_000_000_101,
        name: 'Lunar Client.exe',
        executablePath: 'C:\\Users\\Kid\\.lunarclient\\Lunar Client.exe',
        commandLine: '"C:\\Users\\Kid\\.lunarclient\\Lunar Client.exe"',
      },
      {
        processId: 5102,
        processStartedAt: 1_700_000_000_102,
        name: 'javaw.exe',
        executablePath: 'C:\\Users\\Kid\\.lunarclient\\jre\\bin\\javaw.exe',
        commandLine: 'javaw.exe --gameDir C:\\Users\\Kid\\.lunarclient\\offline\\multiver',
      },
    ])

    expect(snapshot).toEqual({
      activeGameIds: ['minecraft'],
      classifiedProcesses: [
        { gameId: 'minecraft', pid: 5102, processStartedAt: 1_700_000_000_102, imageName: 'javaw.exe' },
      ],
      launchCommands: [],
    })
    expect(snapshot.classifiedProcesses.map(({ pid }) => buildWindowsTerminationArgs(pid))).toEqual([
      ['/PID', '5102', '/T', '/F'],
    ])
  })

  it('collects distinct active games and deduplicated launch commands', () => {
    expect(collectManagedGameSnapshot([
      {
        processId: 4101,
        processStartedAt: 1_700_000_000_001,
        name: 'RobloxPlayerBeta.exe',
        executablePath: 'C:\\Roblox\\RobloxPlayerBeta.exe',
        commandLine: '"C:\\Roblox\\RobloxPlayerBeta.exe"',
      },
      {
        processId: 4102,
        processStartedAt: 1_700_000_000_002,
        name: 'javaw.exe',
        executablePath: 'C:\\Program Files\\Java\\bin\\javaw.exe',
        commandLine: 'javaw.exe -jar forge.jar --gameDir C:\\Users\\Kid\\.minecraft',
      },
      {
        processId: 4102,
        processStartedAt: 1_700_000_000_002,
        name: 'javaw.exe',
        executablePath: 'C:\\Program Files\\Java\\bin\\javaw.exe',
        commandLine: 'javaw.exe -jar forge.jar --gameDir C:\\Users\\Kid\\.minecraft',
      },
    ])).toEqual({
      activeGameIds: ['roblox', 'minecraft'],
      classifiedProcesses: [
        { gameId: 'roblox', pid: 4101, processStartedAt: 1_700_000_000_001, imageName: 'RobloxPlayerBeta.exe' },
        { gameId: 'minecraft', pid: 4102, processStartedAt: 1_700_000_000_002, imageName: 'javaw.exe' },
      ],
      launchCommands: [
        {
          gameId: 'roblox',
          executablePath: 'C:\\Roblox\\RobloxPlayerBeta.exe',
          args: [],
        },
      ],
    })
  })
  it('normalizes PowerShell process records before classification', () => {
    const records = normalizeProcessRecords({
      ProcessId: 4103,
      ProcessStartedAt: 1_700_000_000_003,
      Name: 'Minecraft.exe',
      ExecutablePath: 'C:\\Program Files\\WindowsApps\\Minecraft.exe',
      CommandLine: '"C:\\Program Files\\WindowsApps\\Minecraft.exe"',
    })

    expect(records).toEqual([{
      processId: 4103,
      processStartedAt: 1_700_000_000_003,
      name: 'Minecraft.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\Minecraft.exe',
      commandLine: '"C:\\Program Files\\WindowsApps\\Minecraft.exe"',
    }])
    expect(collectManagedGameSnapshot(records).activeGameIds).toEqual(['minecraft'])
  })

  it('prefers the most recently detected game and keeps the prior primary on ties', () => {
    expect(selectPrimaryManagedGame(['roblox', 'minecraft'], { roblox: 10, minecraft: 20 }, 'roblox')).toBe('minecraft')
    expect(selectPrimaryManagedGame(['roblox', 'minecraft'], { roblox: 20, minecraft: 20 }, 'roblox')).toBe('roblox')
  })

  it('lists only secondary managed games after normalization', () => {
    expect(listSecondaryManagedGames('minecraft', ['roblox', 'minecraft', 'roblox'])).toEqual(['roblox'])
  })
  it('builds a valid PowerShell array for process capture', () => {
    const script = buildWindowsProcessCaptureScript(['RobloxPlayerBeta.exe', "Kid'sGame.exe"])
    expect(script).toContain("$names = @('RobloxPlayerBeta.exe', 'Kid''sGame.exe')")
    expect(script).not.toContain('$names = ["')
    expect(script).toContain('ProcessStartedAt')
    expect(script).toContain('CreationDate')
    expect(script).toContain('ManagementDateTimeConverter')
  })
  it('builds PID-targeted Windows termination arguments', () => {
    expect(buildWindowsTerminationArgs(4102)).toEqual(['/PID', '4102', '/T', '/F'])
    expect(() => buildWindowsTerminationArgs(0)).toThrow('positive process ID')
  })
  it('checks identity before terminating the complete Windows process tree', () => {
    const script = buildWindowsIdentityTerminationScript({
      gameId: 'minecraft', pid: 4102, processStartedAt: 1_700_000_000_002, imageName: 'javaw.exe',
    })
    expect(script).toContain('Process identity changed')
    expect(script).toContain('taskkill.exe /PID 4102 /T /F')
    expect(script.indexOf('Process identity changed')).toBeLessThan(script.indexOf('CloseMainWindow()'))
    expect(script.indexOf('WaitForExit(10000)')).toBeLessThan(script.indexOf('taskkill.exe'))
    expect(script).toContain("Write-Output 'graceful'; return")
    expect(script).toContain("if ($target.HasExited)")
    expect(script).toContain('$target.Refresh()')
    expect(script).toContain('$windowWait.ElapsedMilliseconds -ge 60000')
    expect(() => buildWindowsIdentityTerminationScript({ gameId: 'minecraft', pid: 4102, processStartedAt: 1, imageName: 'javaw.exe' }, 10000, 60001)).toThrow('Invalid window readiness period')
  })

  it('recognizes the official Windows Roblox player but never its installer, Studio or crash reporter', () => {
    for (const name of ['RobloxPlayerBeta.exe', 'ROBLOXPLAYERBETA.EXE', 'RobloxPlayer.exe']) {
      expect(classifyManagedGameProcess({ name, executablePath: 'D:\\Games\\Roblox\\Versions\\version-new\\' + name })).toBe('roblox')
    }
    expect(classifyManagedGameProcess({ name: 'renamed.exe', originalFilename: 'RobloxPlayerBeta.exe' })).toBe('roblox')
    for (const helper of ['RobloxPlayerInstaller.exe', 'RobloxPlayerLauncher.exe', 'RobloxPlayerLauncherBeta.exe', 'RobloxStudioBeta.exe', 'RobloxStudioInstaller.exe', 'RobloxStudioLauncherBeta.exe', 'RobloxCrashHandler.exe']) {
      expect(classifyManagedGameProcess({ name: helper, productName: 'Roblox' })).toBeNull()
      expect(classifyManagedGameProcess({ name: 'renamed.exe', originalFilename: helper, productName: 'Roblox Player' })).toBeNull()
    }
  })
  it('recognizes game metadata after install path or filename changes without matching unrelated command text', () => {
    expect(classifyManagedGameProcess({ name: 'renamed.exe', executablePath: 'D:\\Games\\renamed.exe', originalFilename: 'RobloxPlayerBeta.exe' })).toBe('roblox')
    expect(classifyManagedGameProcess({ name: 'renamed.exe', productName: 'Minecraft for Windows' })).toBe('minecraft')
    expect(classifyManagedGameProcess({ name: 'runtime.exe', originalFilename: 'javaw.exe', commandLine: 'runtime.exe net.minecraft.client.main.Main' })).toBe('minecraft')
    expect(classifyManagedGameProcess({ name: 'powershell.exe', commandLine: 'Get-Content C:\\minecraft\\notes.txt' })).toBeNull()
    expect(classifyManagedGameProcess({ name: 'chrome.exe', commandLine: 'https://minecraft.net' })).toBeNull()
    expect(classifyManagedGameProcess({ name: 'javaw.exe', commandLine: 'javaw.exe -jar payroll.jar' })).toBeNull()
    expect(classifyManagedGameProcess({ name: 'RobloxStudioBeta.exe', productName: 'Roblox Studio' })).toBeNull()
  })

  it.skipIf(process.platform !== 'win32')('captures real CIM DateTime and refuses a changed process identity before terminating its own child', async () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', '[Console]::ReadLine()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    await once(child, 'spawn')
    const exited = once(child, 'exit')
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', buildWindowsProcessCaptureScript(['powershell.exe'])], { encoding: 'utf8', windowsHide: true })
      const record = normalizeProcessRecords(JSON.parse(output)).find((entry) => Number(entry.processId) === child.pid)
      expect(record?.processStartedAt).toBeGreaterThan(Date.now() - 60_000)
      expect(record?.processStartedAt).toBeLessThanOrEqual(Date.now())
      const identity = { pid: child.pid, imageName: record.name, processStartedAt: record.processStartedAt, gameId: 'roblox' }
      expect(() => execFileSync('powershell.exe', ['-NoProfile', '-Command', buildWindowsIdentityTerminationScript({ ...identity, processStartedAt: identity.processStartedAt - 1 })], { windowsHide: true, stdio: 'pipe' })).toThrow()
      expect(child.exitCode).toBeNull()
      execFileSync('powershell.exe', ['-NoProfile', '-Command', buildWindowsIdentityTerminationScript(identity, 10000, 0)], { windowsHide: true, stdio: 'pipe' })
      await exited
    } finally {
      if (child.exitCode === null) { child.kill(); await exited }
    }
  }, 20_000)
})
