import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

export function createWranglerReadinessDetector(onReady) {
  let ready = false
  return (output) => {
    const plain = stripAnsi(output)
    const match = plain.match(/Ready on\s+(https?:\/\/[^\s]+)/i)
    const afterBanner = match ? plain.slice(match.index + match[0].length) : ''
    const routingActive = /\/cdn-cgi\/ProxyWorker\/play\s+204\b/i.test(afterBanner)
    if (!ready && match && routingActive) {
      ready = true
      onReady(match[1].replace(/[),.;]+$/, ''))
    }
  }
}

export function createWranglerOutputCapture(inspect) {
  let stdout = ''
  let stderr = ''
  let chronological = ''
  const append = (stream, chunk) => {
    if (stream === 'stdout') stdout += chunk
    else stderr += chunk
    chronological += chunk
    inspect(chronological)
  }
  return {
    stdout: (chunk) => append('stdout', chunk),
    stderr: (chunk) => append('stderr', chunk),
    output: () => ({ stdout, stderr }),
  }
}

function npxCommand() {
  if (process.platform !== 'win32') return { command: 'npx', prefix: [] }
  const npmBin = process.env.npm_execpath ? dirname(process.env.npm_execpath) : join(dirname(process.execPath), 'node_modules', 'npm', 'bin')
  return { command: process.execPath, prefix: [join(npmBin, 'npx-cli.js')] }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already stopped */ }
  }
}

function waitForClose(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`Process tree ${child.pid} did not terminate within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolvePromise(code)
    })
  })
}

function scrubMarkedProcesses(marker) {
  if (process.platform !== 'win32') return []
  const command = String.raw`
$marker = $env:PLAYTIME_PACT_WRANGLER_MARKER
$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($marker) })
$processIds = @($matches | ForEach-Object ProcessId)
foreach ($process in $matches) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
if ($processIds.Count -gt 0) {
  Wait-Process -Id $processIds -ErrorAction SilentlyContinue
  $remaining = @(Get-Process -Id $processIds -ErrorAction SilentlyContinue | ForEach-Object Id)
} else { $remaining = @() }
if ($remaining.Count -gt 0) { throw "Wrangler processes did not terminate: $($remaining -join ', ')" }
$processIds | ConvertTo-Json -Compress
`
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, PLAYTIME_PACT_WRANGLER_MARKER: marker },
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`Could not scrub Wrangler process marker ${marker}: ${result.stderr}`)
  const text = result.stdout.trim()
  return text ? JSON.parse(text) : []
}

export function createWranglerLocalHarness(prefix = 'playtime-pact-wrangler-', { processEnv = process.env } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const active = new Set()
  const repositoryStatePaths = [join(repositoryRoot, '.wrangler'), join(repositoryRoot, 'remote-backend', '.wrangler')]
  const preexistingState = new Set(repositoryStatePaths.filter(existsSync))
  const env = {
    ...processEnv,
    CI: '1',
    NO_COLOR: '1',
    WRANGLER_HIDE_BANNER: 'true',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    WRANGLER_SEND_METRICS: 'false',
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
  }
  delete env.CLOUDFLARE_INCLUDE_PROCESS_ENV

  const launch = (argv) => {
    const { command, prefix: commandPrefix } = npxCommand()
    const child = spawn(command, [...commandPrefix, '--no-install', 'wrangler', ...argv], {
      cwd: repositoryRoot,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active.add(child)
    child.once('close', () => active.delete(child))
    return child
  }

  const run = (argv, { timeoutMs = 60_000 } = {}) => new Promise((resolvePromise, reject) => {
    const child = launch(argv)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (timedOut) reject(new Error(`Wrangler timed out: ${argv.join(' ')}\n${stderr}`))
      else if (code !== 0) reject(Object.assign(new Error(stripAnsi(stderr).trim() || `Wrangler exited with ${code}`), { code: 'WRANGLER_FAILED', stdout, stderr, exitCode: code }))
      else resolvePromise({ stdout, stderr })
    })
  })

  const startWorker = (argv, { timeoutMs = 60_000 } = {}) => {
    const logLevel = argv.indexOf('--log-level')
    const workerArgv = logLevel === -1
      ? [...argv, '--log-level', 'debug']
      : [...argv.slice(0, logLevel), ...argv.slice(logLevel + 2), '--log-level', 'debug']
    const child = launch(workerArgv)
    let ready = false
    let resolveReady
    let rejectReady
    const readiness = new Promise((resolvePromise, reject) => { resolveReady = resolvePromise; rejectReady = reject })
    const outputWaiters = new Set()
    const inspectReadiness = createWranglerReadinessDetector((url) => {
      ready = true
      clearTimeout(timeout)
      resolveReady(url)
    })
    const inspect = (output) => {
      inspectReadiness(output)
      for (const waiter of outputWaiters) {
        if (!output.includes(waiter.marker)) continue
        outputWaiters.delete(waiter)
        clearTimeout(waiter.timeout)
        waiter.resolve(waiter.marker)
      }
    }
    const capture = createWranglerOutputCapture(inspect)
    child.stdout.setEncoding('utf8').on('data', capture.stdout)
    child.stderr.setEncoding('utf8').on('data', capture.stderr)
    const combinedOutput = () => {
      const { stdout, stderr } = capture.output()
      return `${stdout}\n${stderr}`
    }
    const timeout = setTimeout(() => {
      if (!ready) rejectReady(new Error(`Wrangler dev did not become ready:\n${stripAnsi(combinedOutput())}`))
      killTree(child.pid)
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      if (!ready) rejectReady(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (!ready) rejectReady(new Error(`Wrangler dev exited before readiness (${code}):\n${stripAnsi(combinedOutput())}`))
    })
    return {
      child,
      readiness,
      output: capture.output,
      waitForOutput(marker, { timeoutMs: waitTimeoutMs = 10_000 } = {}) {
        if (typeof marker !== 'string' || marker.length === 0) return Promise.reject(new TypeError('Output marker required'))
        return new Promise((resolveWaiter, rejectWaiter) => {
          const waiter = { marker, resolve: resolveWaiter, timeout: undefined }
          waiter.timeout = setTimeout(() => {
            outputWaiters.delete(waiter)
            rejectWaiter(new Error(`Wrangler output marker timed out: ${marker}`))
          }, waitTimeoutMs)
          outputWaiters.add(waiter)
          if (combinedOutput().includes(marker)) {
            outputWaiters.delete(waiter)
            clearTimeout(waiter.timeout)
            resolveWaiter(marker)
          }
        })
      },
      async stop() {
        if (child.exitCode === null) killTree(child.pid)
        await waitForClose(child)
      },
    }
  }

  return {
    root,
    run,
    startWorker,
    statePath: (name) => join(root, `state-${name}`),
    async cleanup() {
      const children = [...active]
      for (const child of children) killTree(child.pid)
      await Promise.all(children.map((child) => waitForClose(child)))
      const scrubbedProcessIds = scrubMarkedProcesses(root)
      rmSync(root, { recursive: true, force: true })
      if (existsSync(root)) throw new Error(`Wrangler sandbox residue remains at ${root}`)
      const createdRepositoryState = repositoryStatePaths.filter((path) => !preexistingState.has(path) && existsSync(path))
      for (const path of createdRepositoryState) rmSync(path, { recursive: true, force: true })
      if (createdRepositoryState.some(existsSync)) throw new Error(`Wrangler repository residue remains: ${createdRepositoryState.join(', ')}`)
      return { scrubbedProcessIds, remainingProcessIds: [] }
    },
  }
}
