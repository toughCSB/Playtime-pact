import { describe, expect, it } from 'vitest'

import {
  classifyManagedGameProcess,
  collectManagedGameSnapshot,
  listSecondaryManagedGames,
  selectPrimaryManagedGame,
  splitWindowsCommandLine,
} from '../src/shared/managedGames'

import { buildWindowsProcessCaptureScript, buildWindowsTerminationArgs, normalizeProcessRecords } from '../src/main/managedGameRuntime'
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
  })
  it('builds PID-targeted Windows termination arguments', () => {
    expect(buildWindowsTerminationArgs(4102)).toEqual(['/PID', '4102', '/T', '/F'])
    expect(() => buildWindowsTerminationArgs(0)).toThrow('positive process ID')
  })
})
