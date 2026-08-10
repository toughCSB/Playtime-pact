import { exec, execFile, execFileSync } from 'child_process'
import {
  collectManagedGameSnapshot,
  getManagedGameProcessImageNames,
  type ManagedGameSnapshot,
  type ManagedProcessRecord,
} from '../shared/managedGames'

function emptySnapshot(): ManagedGameSnapshot {
  return { activeGameIds: [], classifiedProcesses: [], launchCommands: [] }
}

export interface ManagedGameTerminationResult {
  success: boolean
  remainingGameIds: ManagedGameSnapshot['activeGameIds']
}

export interface ManagedGameCaptureResult {
  snapshot: ManagedGameSnapshot
  succeeded: boolean
}

export function buildWindowsTerminationArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('A positive process ID is required')
  return ['/PID', String(pid), '/T', '/F']
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', buildWindowsTerminationArgs(pid), { windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export function normalizeProcessRecords(value: unknown): ManagedProcessRecord[] {
  const records = Array.isArray(value) ? value : value ? [value] : []

  return records.flatMap((record) => {
    if (!record || typeof record !== 'object') return []
    const candidate = record as Record<string, unknown>
    return [{
      processId: (candidate.processId ?? candidate.ProcessId) as ManagedProcessRecord['processId'],
      processStartedAt: (candidate.processStartedAt ?? candidate.ProcessStartedAt) as ManagedProcessRecord['processStartedAt'],
      name: (candidate.name ?? candidate.Name) as ManagedProcessRecord['name'],
      executablePath: (candidate.executablePath ?? candidate.ExecutablePath) as ManagedProcessRecord['executablePath'],
      commandLine: (candidate.commandLine ?? candidate.CommandLine) as ManagedProcessRecord['commandLine'],
    }]
  })
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function buildWindowsProcessCaptureScript(processNames: string[]): string {
  const names = processNames.map(toPowerShellSingleQuotedString).join(', ')
  return [
    `$names = @(${names})`,
    '$records = Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | ForEach-Object {',
    '  $startedAt = if ($_.CreationDate) { [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)).ToUniversalTime() } else { $null }',
    '  [PSCustomObject]@{ ProcessId = $_.ProcessId; Name = $_.Name; ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine; ProcessStartedAt = if ($startedAt) { $startedAt.ToUnixTimeMilliseconds() } else { $null } }',
    '}',
    "if ($records) { $records | ConvertTo-Json -Compress } else { '[]' }",
  ].join('; ')
}

function captureManagedGameSnapshot(): ManagedGameCaptureResult {
  if (process.platform !== 'win32') return { snapshot: emptySnapshot(), succeeded: true }

  const processNames = getManagedGameProcessImageNames()
  if (processNames.length === 0) return { snapshot: emptySnapshot(), succeeded: true }

  try {
    const script = buildWindowsProcessCaptureScript(processNames)
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    const parsed = stdout ? JSON.parse(stdout) : []
    return { snapshot: collectManagedGameSnapshot(normalizeProcessRecords(parsed)), succeeded: true }
  } catch (err) {
    console.error('managed-game snapshot capture failed', err)
    return { snapshot: emptySnapshot(), succeeded: false }
  }
}

export function getManagedGameSnapshotCapture(): ManagedGameCaptureResult {
  return captureManagedGameSnapshot()
}

export function getManagedGameSnapshot(): ManagedGameSnapshot {
  return getManagedGameSnapshotCapture().snapshot
}

export async function terminateSupportedGames(retries = 2): Promise<ManagedGameTerminationResult> {
  if (process.platform === 'win32') {
    const attempts = Math.max(1, Math.min(3, Math.floor(retries) + 1))
    let capture = captureManagedGameSnapshot()
    let snapshot = capture.snapshot

    for (let attempt = 0; attempt < attempts && capture.succeeded && snapshot.activeGameIds.length > 0; attempt++) {
      await Promise.allSettled(snapshot.classifiedProcesses.map(({ pid }) => runTaskkill(pid)))
      capture = captureManagedGameSnapshot()
      snapshot = capture.snapshot
    }

    return {
      success: capture.succeeded && snapshot.activeGameIds.length === 0,
      remainingGameIds: snapshot.activeGameIds,
    }
  }

  if (process.platform === 'darwin') {
    const processNames = ['Roblox', 'Minecraft', 'Minecraft Launcher', 'PrismLauncher', 'MultiMC']
    const results = await Promise.allSettled(processNames.map((processName) => new Promise<void>((resolve, reject) => {
      exec(`pkill -x "${processName}"`, (error) => {
        if (error && error.code !== 1) reject(error)
        else resolve()
      })
    })))
    return { success: results.every((result) => result.status === 'fulfilled'), remainingGameIds: [] }
  }

  return { success: true, remainingGameIds: [] }
}
