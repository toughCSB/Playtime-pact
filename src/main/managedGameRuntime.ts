import { exec, execFile } from 'child_process'
import {
  collectManagedGameSnapshot,
  getManagedGameProcessImageNames,
  type ManagedGameSnapshot,
  type ManagedProcessRecord,
  type ClassifiedManagedGameProcess,
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

export function buildWindowsIdentityTerminationScript(process: ClassifiedManagedGameProcess, graceMs = 10000, windowReadyMs = 60000): string {
  buildWindowsTerminationArgs(process.pid)
  if (!Number.isFinite(process.processStartedAt) || !process.processStartedAt || process.processStartedAt <= 0) throw new Error('Process start identity required')
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 10000) throw new Error('Invalid shutdown grace period')
  if (!Number.isInteger(windowReadyMs) || windowReadyMs < 0 || windowReadyMs > 60000) throw new Error('Invalid window readiness period')
  return [
    '$ErrorActionPreference = "Stop"',
    `$target = [System.Diagnostics.Process]::GetProcessById(${process.pid})`,
    'try {',
    '  $null = $target.Handle',
    `  if (([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds() -ne ${process.processStartedAt}) { throw 'Process identity changed' }`,
    `  if (($target.ProcessName + '.exe') -ine ${toPowerShellSingleQuotedString(process.imageName)}) { throw 'Process image changed' }`,
    '  $closeRequested = $false',
    '  $windowWait = [Diagnostics.Stopwatch]::StartNew()',
    '  do {',
    "    if ($target.HasExited) { Write-Output 'exited'; return }",
    '    $target.Refresh()',
    '    $closeRequested = $target.CloseMainWindow()',
    `    if ($closeRequested -or $windowWait.ElapsedMilliseconds -ge ${windowReadyMs}) { break }`,
    '    Start-Sleep -Milliseconds 100',
    '  } while ($true)',
    `  if ($closeRequested -and $target.WaitForExit(${graceMs})) { Write-Output 'graceful'; return }`,
    "  if ($target.HasExited) { Write-Output 'exited'; return }",
    // Retain the identity-verified process handle through startup/close grace,
    // and never force an exited target. The fallback includes game children.
    `  & taskkill.exe /PID ${process.pid} /T /F | Out-Null`,
    '  if ($LASTEXITCODE -ne 0) { throw "Process tree termination failed" }',
    '  if (!$target.WaitForExit(5000)) { throw "Process termination timed out" }',
    "  Write-Output 'forced'",
    '} finally { $target.Dispose() }',
  ].join('; ')
}

async function runIdentityTermination(process: ClassifiedManagedGameProcess): Promise<void> {
  await runManagedProcessCapture(buildWindowsIdentityTerminationScript(process), 80000)
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
      originalFilename: (candidate.originalFilename ?? candidate.OriginalFilename) as ManagedProcessRecord['originalFilename'],
      productName: (candidate.productName ?? candidate.ProductName) as ManagedProcessRecord['productName'],
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
    '$ErrorActionPreference = "Stop"',
    '$records = Get-CimInstance Win32_Process | ForEach-Object {',
    '  $startedAt = $null',
    '  if ($_.CreationDate) { try { if ($_.CreationDate -is [DateTime]) { $startedAt = [DateTimeOffset]$_.CreationDate } elseif ($_.CreationDate -is [DateTimeOffset]) { $startedAt = $_.CreationDate } else { $startedAt = [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$_.CreationDate)) } } catch {} }',
    '  $version = $null; if ($_.ExecutablePath -and $names -notcontains $_.Name) { try { $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath) } catch {} }',
    '  [PSCustomObject]@{ ProcessId = $_.ProcessId; Name = $_.Name; ExecutablePath = $_.ExecutablePath; CommandLine = $_.CommandLine; OriginalFilename = $version.OriginalFilename; ProductName = $version.ProductName; ProcessStartedAt = if ($startedAt) { $startedAt.ToUnixTimeMilliseconds() } else { $null } }',
    '} | Where-Object { $names -contains $_.Name -or $names -contains $_.OriginalFilename -or @("Roblox", "Roblox Player", "Minecraft", "Minecraft for Windows") -contains $_.ProductName }',
    "if ($records) { $records | ConvertTo-Json -Compress } else { '[]' }",
  ].join('; ')
}

async function captureManagedGameSnapshot(): Promise<ManagedGameCaptureResult> {
  if (process.platform !== 'win32') return { snapshot: emptySnapshot(), succeeded: true }

  const processNames = getManagedGameProcessImageNames()
  if (processNames.length === 0) return { snapshot: emptySnapshot(), succeeded: true }

  try {
    const script = buildWindowsProcessCaptureScript(processNames)
    const stdout = (await runManagedProcessCapture(script)).trim()
    const parsed = stdout ? JSON.parse(stdout) : []
    return { snapshot: collectManagedGameSnapshot(normalizeProcessRecords(parsed)), succeeded: true }
  } catch {
    // Child-process errors can contain stdout and unrelated command-line secrets.
    console.error('managed-game snapshot capture failed; process state unavailable')
    return { snapshot: emptySnapshot(), succeeded: false }
  }
}

// The deadline resolves independently of child exit/pipe cleanup. A stuck CIM
// query must never block the Electron event loop or the expiry countdown.
export function runManagedProcessCapture(script: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(new Error('Managed process capture failed'))
      else resolve(stdout)
    })
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      child.stdout?.destroy()
      child.stderr?.destroy()
      reject(new Error('Managed process capture timed out'))
    }, timeoutMs)
  })
}

export function getManagedGameSnapshotCapture(): Promise<ManagedGameCaptureResult> {
  return captureManagedGameSnapshot()
}

export async function getManagedGameSnapshot(): Promise<ManagedGameSnapshot> {
  return (await getManagedGameSnapshotCapture()).snapshot
}

let terminationInFlight: Promise<ManagedGameTerminationResult> | null = null

export function isManagedGameTerminationInFlight(): boolean { return terminationInFlight !== null }

export function terminateSupportedGames(retries = 2): Promise<ManagedGameTerminationResult> {
  // Detection, expiry and policy enforcement share one shutdown operation.
  // Otherwise a second caller can force-kill while the first is saving a game.
  if (terminationInFlight) return terminationInFlight
  terminationInFlight = terminateSupportedGamesOnce(retries).finally(() => { terminationInFlight = null })
  return terminationInFlight
}

async function terminateSupportedGamesOnce(retries: number): Promise<ManagedGameTerminationResult> {
  if (process.platform === 'win32') {
    const attempts = Math.max(1, Math.min(3, Math.floor(retries) + 1))
    let capture = await captureManagedGameSnapshot()
    let snapshot = capture.snapshot

    for (let attempt = 0; attempt < attempts && capture.succeeded && snapshot.activeGameIds.length > 0; attempt++) {
      await Promise.allSettled(snapshot.classifiedProcesses.map((process) => runIdentityTermination(process)))
      capture = await captureManagedGameSnapshot()
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
