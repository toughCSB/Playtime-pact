import { exec, execFile } from 'child_process'
import koffi from 'koffi'
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

const windowsKernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null
const windowsNtdll = process.platform === 'win32' ? koffi.load('ntdll.dll') : null
const WindowsProcessEntry32 = process.platform === 'win32'
  ? koffi.struct({
      dwSize: 'uint32_t', cntUsage: 'uint32_t', th32ProcessID: 'uint32_t', th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32_t', cntThreads: 'uint32_t', th32ParentProcessID: 'uint32_t', pcPriClassBase: 'int32_t',
      dwFlags: 'uint32_t', szExeFile: 'char16_t[260]',
    })
  : null
const WindowsFileTime = process.platform === 'win32'
  ? koffi.struct({ dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' })
  : null
const CreateToolhelp32Snapshot = windowsKernel32 && windowsKernel32.func('void * __stdcall CreateToolhelp32Snapshot(uint32_t Flags, uint32_t ProcessId)')
const Process32FirstW = windowsKernel32 && WindowsProcessEntry32 && windowsKernel32.func('Process32FirstW', 'bool', ['void *', koffi.inout(koffi.pointer(WindowsProcessEntry32))])
const Process32NextW = windowsKernel32 && WindowsProcessEntry32 && windowsKernel32.func('Process32NextW', 'bool', ['void *', koffi.inout(koffi.pointer(WindowsProcessEntry32))])
const ProcessIdToSessionId = windowsKernel32 && windowsKernel32.func('bool __stdcall ProcessIdToSessionId(uint32_t ProcessId, uint32_t * SessionId)')
const OpenProcess = windowsKernel32 && windowsKernel32.func('void * __stdcall OpenProcess(uint32_t Access, bool Inherit, uint32_t ProcessId)')
const QueryFullProcessImageNameW = windowsKernel32 && windowsKernel32.func('bool __stdcall QueryFullProcessImageNameW(void * Process, uint32_t Flags, uint16_t * Name, uint32_t * Size)')
const GetProcessTimes = windowsKernel32 && WindowsFileTime && windowsKernel32.func('GetProcessTimes', 'bool', [
  'void *',
  koffi.out(koffi.pointer(WindowsFileTime)),
  koffi.out(koffi.pointer(WindowsFileTime)),
  koffi.out(koffi.pointer(WindowsFileTime)),
  koffi.out(koffi.pointer(WindowsFileTime)),
])
const CloseHandle = windowsKernel32 && windowsKernel32.func('bool __stdcall CloseHandle(void * Handle)')
const NtQueryInformationProcess = windowsNtdll && windowsNtdll.func('int32_t __stdcall NtQueryInformationProcess(void * ProcessHandle, uint32_t ProcessInformationClass, void * ProcessInformation, uint32_t ProcessInformationLength, uint32_t * ReturnLength)')

const invalidWindowsHandle = (handle: unknown) => !handle || handle === -1n || handle === 0xffffffffffffffffn || handle === 0xffffffffn

function windowsSessionId(processId: number): number | null {
  if (!ProcessIdToSessionId) return null
  const session = Buffer.alloc(4)
  return ProcessIdToSessionId(processId, session) ? session.readUInt32LE(0) : null
}

function windowsProcessCommandLine(handle: unknown): string | undefined {
  if (!NtQueryInformationProcess) return undefined
  const requiredLength = Buffer.alloc(4)
  NtQueryInformationProcess(handle, 60, null, 0, requiredLength)
  const byteLength = requiredLength.readUInt32LE(0)
  if (byteLength < 16 || byteLength > 1024 * 1024) return undefined

  const output = Buffer.alloc(byteLength + 2)
  const status = NtQueryInformationProcess(handle, 60, output, output.length, requiredLength)
  if (status < 0) return undefined

  const stringByteLength = output.readUInt16LE(0)
  const pointerOffset = process.arch === 'ia32' ? 4 : 8
  if (stringByteLength === 0 || stringByteLength > byteLength - pointerOffset - (process.arch === 'ia32' ? 4 : 8)) return undefined
  const stringPointer = process.arch === 'ia32'
    ? BigInt(output.readUInt32LE(pointerOffset))
    : output.readBigUInt64LE(pointerOffset)
  if (stringPointer === 0n) return undefined
  try {
    return koffi.decode.string16(stringPointer, stringByteLength / 2).replace(/\0+$/, '')
  } catch {
    return undefined
  }
}

function windowsProcessDetails(processId: number): Pick<ManagedProcessRecord, 'processStartedAt' | 'executablePath' | 'commandLine'> {
  if (!OpenProcess || !QueryFullProcessImageNameW || !GetProcessTimes || !CloseHandle) return {}
  const handle = OpenProcess(0x1000, false, processId)
  if (invalidWindowsHandle(handle)) return {}
  try {
    const pathBuffer = Buffer.alloc(32768)
    const pathLength = Buffer.alloc(4)
    pathLength.writeUInt32LE(16384)
    const executablePath = QueryFullProcessImageNameW(handle, 0, pathBuffer, pathLength)
      ? pathBuffer.subarray(0, pathLength.readUInt32LE(0) * 2).toString('utf16le').replace(/\0+$/, '')
      : undefined
    const creation = {} as { dwLowDateTime?: number; dwHighDateTime?: number }
    const exited = {}
    const kernel = {}
    const user = {}
    let processStartedAt: number | undefined
    if (GetProcessTimes(handle, creation, exited, kernel, user)
      && Number.isInteger(creation.dwLowDateTime) && Number.isInteger(creation.dwHighDateTime)) {
      const ticks = (BigInt(creation.dwHighDateTime!) << 32n) | BigInt(creation.dwLowDateTime!)
      const unixMilliseconds = (ticks - 116444736000000000n) / 10000n
      const value = Number(unixMilliseconds)
      if (Number.isSafeInteger(value) && value > 0) processStartedAt = value
    }
    const commandLine = windowsProcessCommandLine(handle)
    return {
      ...(executablePath ? { executablePath } : {}),
      ...(commandLine ? { commandLine } : executablePath ? { commandLine: `"${executablePath}"` } : {}),
      ...(processStartedAt ? { processStartedAt } : {}),
    }
  } finally {
    CloseHandle(handle)
  }
}

export function captureNativeWindowsProcessRecords(processNames: readonly string[]): ManagedProcessRecord[] {
  if (!CreateToolhelp32Snapshot || !Process32FirstW || !Process32NextW || !CloseHandle || !WindowsProcessEntry32) {
    throw new Error('Native Windows process enumeration unavailable')
  }
  const currentSessionId = windowsSessionId(process.pid)
  if (currentSessionId === null) throw new Error('Current Windows session identity unavailable')
  const wanted = new Set(processNames.map((name) => name.toLowerCase()))
  const snapshot = CreateToolhelp32Snapshot(0x00000002, 0)
  if (invalidWindowsHandle(snapshot)) throw new Error('Windows process snapshot unavailable')
  try {
    const records: ManagedProcessRecord[] = []
    const entry = { dwSize: koffi.sizeof(WindowsProcessEntry32) } as {
      dwSize: number
      th32ProcessID?: number
      th32ParentProcessID?: number
      szExeFile?: string
    }
    for (let found = Process32FirstW(snapshot, entry); found; found = Process32NextW(snapshot, entry)) {
      const processId = Number(entry.th32ProcessID)
      const name = typeof entry.szExeFile === 'string' ? entry.szExeFile.trim() : ''
      if (!Number.isInteger(processId) || processId <= 0 || !wanted.has(name.toLowerCase())) {
        entry.dwSize = koffi.sizeof(WindowsProcessEntry32)
        continue
      }
      if (windowsSessionId(processId) === currentSessionId) {
        records.push({ processId, parentProcessId: Number(entry.th32ParentProcessID) || undefined, name, ...windowsProcessDetails(processId) })
      }
      entry.dwSize = koffi.sizeof(WindowsProcessEntry32)
    }
    return records
  } finally {
    CloseHandle(snapshot)
  }
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

function sameNativeWindowsProcess(process: ClassifiedManagedGameProcess): ManagedProcessRecord | null {
  if (!process.processStartedAt) return null
  const record = captureNativeWindowsProcessRecords([process.imageName])
    .find((candidate) => Number(candidate.processId) === process.pid)
  return record
    && record.name?.toLowerCase() === process.imageName.toLowerCase()
    && Number(record.processStartedAt) === process.processStartedAt
    ? record
    : null
}

function runTaskkill(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill.exe', args, { windowsHide: true, timeout: timeoutMs }, (error) => {
      if (error) reject(new Error('Managed process termination failed'))
      else resolve()
    })
  })
}

async function waitForNativeWindowsProcessExit(process: ClassifiedManagedGameProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!sameNativeWindowsProcess(process)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !sameNativeWindowsProcess(process)
}

export async function terminateNativeWindowsProcess(process: ClassifiedManagedGameProcess): Promise<void> {
  if (!process.processStartedAt || !sameNativeWindowsProcess(process)) throw new Error('Process identity changed')
  try { await runTaskkill(['/PID', String(process.pid), '/T'], 15000) } catch {}
  if (await waitForNativeWindowsProcessExit(process, 10000)) return
  // Re-check PID, image and creation time immediately before the forced fallback.
  if (!sameNativeWindowsProcess(process)) return
  try { await runTaskkill(['/PID', String(process.pid), '/T', '/F'], 15000) } catch {}
  if (!await waitForNativeWindowsProcessExit(process, 5000)) throw new Error('Process termination timed out')
}

export function normalizeProcessRecords(value: unknown): ManagedProcessRecord[] {
  const records = Array.isArray(value) ? value : value ? [value] : []

  return records.flatMap((record) => {
    if (!record || typeof record !== 'object') return []
    const candidate = record as Record<string, unknown>
    return [{
      processId: (candidate.processId ?? candidate.ProcessId) as ManagedProcessRecord['processId'],
      parentProcessId: (candidate.parentProcessId ?? candidate.ParentProcessId) as ManagedProcessRecord['parentProcessId'],
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
    const records = captureNativeWindowsProcessRecords(processNames)
    return { snapshot: collectManagedGameSnapshot(records), succeeded: true }
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
      await Promise.allSettled(snapshot.classifiedProcesses.map((process) => terminateNativeWindowsProcess(process)))
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
