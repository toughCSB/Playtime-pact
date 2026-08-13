import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const runnerPath = resolve('android-parent', 'scripts', 'run-connected-tests.ps1')
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const windowsIt = process.platform === 'win32' ? it : it.skip

const source = () => {
  expect(existsSync(runnerPath), `missing connected-test runner at ${runnerPath}`).toBe(true)
  return readFileSync(runnerPath, 'utf8')
}

function runPowerShell(args, { env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part })
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part })
    const timeout = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      resolvePromise({ code: null, stdout, stderr, error })
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

// Parses the runner with the Windows PowerShell 5.1 engine and returns machine-consumed
// facts about its declared contract rather than any human-facing prose.
async function inspectAst() {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:PLAYTIME_PACT_RUNNER_PATH
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
$parameters = @()
$block = $ast.ParamBlock
if ($block) {
  $parameters = @($block.Parameters | ForEach-Object {
    $attributes = @($_.Attributes | ForEach-Object { $_.TypeName.FullName })
    $mandatory = $false
    foreach ($attribute in $_.Attributes) {
      if ($attribute -is [System.Management.Automation.Language.AttributeAst]) {
        foreach ($named in $attribute.NamedArguments) {
          if ($named.ArgumentName -eq 'Mandatory') { $mandatory = [bool]$named.Argument.SafeGetValue() }
        }
      }
    }
    [pscustomobject]@{
      name = $_.Name.VariablePath.UserPath
      type = [string]$_.StaticType
      mandatory = $mandatory
      attributes = $attributes
    }
  })
}
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
  ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique)
$hasFinally = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TryStatementAst] }, $true) |
  Where-Object { $_.Finally }).Count -gt 0
[pscustomobject]@{
  parseErrors = @($errors | ForEach-Object { $_.Message })
  parameters = $parameters
  commands = $commands
  hasFinally = $hasFinally
} | ConvertTo-Json -Depth 6 -Compress
`
  const result = await runPowerShell(['-Command', command], {
    env: { ...process.env, PLAYTIME_PACT_RUNNER_PATH: runnerPath },
  })
  expect(result.error).toBeUndefined()
  expect(result.code, result.stderr || result.stdout).toBe(0)
  const parsed = JSON.parse(result.stdout)
  return {
    ...parsed,
    parseErrors: [].concat(parsed.parseErrors ?? []),
    parameters: [].concat(parsed.parameters ?? []),
    commands: [].concat(parsed.commands ?? []),
  }
}

// Strips comments and here-doc style report text so assertions only look at executable code.
const executableLines = (text) => text
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const parameterNamed = (parameters, name) => parameters.find((parameter) => parameter.name === name)

describe('android connected-test runner contract', () => {
  it('exists at the owned path', () => {
    expect(existsSync(runnerPath), `missing connected-test runner at ${runnerPath}`).toBe(true)
  })

  windowsIt('parses under Windows PowerShell 5.1 and declares the required parameter contract', async () => {
    const inspected = await inspectAst()
    expect(inspected.parseErrors).toEqual([])

    const avdName = parameterNamed(inspected.parameters, 'AvdName')
    expect(avdName, 'runner must declare -AvdName').toBeDefined()
    expect(avdName.mandatory).toBe(true)
    expect(avdName.type).toMatch(/^(System\.)?[Ss]tring$/)

    const verifyLockedFailure = parameterNamed(inspected.parameters, 'VerifyLockedFailure')
    expect(verifyLockedFailure, 'runner must declare -VerifyLockedFailure').toBeDefined()
    expect(verifyLockedFailure.mandatory).toBe(false)
    expect(verifyLockedFailure.type).toMatch(/^(switch|System\.Management\.Automation\.SwitchParameter)$/)

    expect(inspected.hasFinally, 'credential cleanup must live in a finally block').toBe(true)
  })

  it('standardizes the API 36 device matrix and JDK 17', () => {
    const text = source()
    expect(text).toContain('PlaytimePactApi36')
    expect(text).toContain('system-images;android-36;google_apis;x86_64')
    expect(text).toMatch(/-no-snapshot(-load|-save)?\b/)
    expect(text).toContain('-wipe-data')
    expect(text).toMatch(/\b17\b/)
    expect(text).toMatch(/JAVA_HOME/)
  })

  it('uses an environment PIN or generates an ephemeral one without arguments or output', () => {
    const text = source()
    const code = executableLines(text)

    expect(code).toContain('PLAYTIME_PACT_TEST_DEVICE_PIN')
    expect(code).toContain('RandomNumberGenerator')
    expect(code).toContain('generated-ephemeral')
    // The PIN must never be declared as a script parameter.
    expect(code).not.toMatch(/\[string\]\s*\$(Pin|DevicePin|TestPin)\b/i)
    expect(code).not.toMatch(/param\s*\([^)]*\$\w*Pin\b/is)

    // The secret must never be interpolated into any write/log/report surface.
    const secretExpression = /\$(?:env:PLAYTIME_PACT_TEST_DEVICE_PIN|(?:script:)?[A-Za-z]*[Pp]in\b)/
    for (const line of code.split(/\r?\n/)) {
      if (!secretExpression.test(line)) continue
      expect(
        line,
        `secret value must not reach an output surface: ${line.trim()}`,
      ).not.toMatch(/Write-(Host|Output|Information|Warning|Error|Verbose|Debug)|Out-File|Add-Content|Set-Content|ConvertTo-Json|Tee-Object/)
    }

    // Absence of the environment variable generates a process-local credential.
    expect(code).toMatch(/IsNullOrWhiteSpace\(\$supplied\)[\s\S]{0,900}?RandomNumberGenerator/)
    expect(code).toMatch(/\$script:DeviceCredential\s*=\s*\$null/)
  })

  it('drives device readiness through exact Android state signals', () => {
    const code = executableLines(source())
    expect(code).toContain('wait-for-device')
    expect(code).toContain('sys.boot_completed')
    expect(code).toMatch(/getprop\b/)
    expect(code).toMatch(/dumpsys['",\s]+user['",\s]+--user['",\s]+0/)
    expect(code).toContain('RUNNING_UNLOCKED')
    expect(code).not.toContain('is-user-unlocked')
    expect(code).toContain('uc_finish_user_unlocked_completed')
    expect(code).toMatch(/locksettings['",\s]+set-pin/)
    expect(code).toMatch(/--old\b/)
    expect(code).toMatch(/dismiss_keyguard|input\s+keyevent/)
    expect(code).toMatch(/uninstall/)
    expect(code).toMatch(/install|installDebug|connectedAndroidTest|connectedDebugAndroidTest/)
    expect(code).toMatch(/package(-| )?installer|PackageInstaller|INSTALL_PACKAGES/i)
  })

  windowsIt('does not consume an early screen-enable event before boot completion', async () => {
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:PLAYTIME_PACT_RUNNER_PATH
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
$function = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Wait-ForBootCompleted'
}, $true)
if (-not $function) { throw 'Wait-ForBootCompleted was not found' }
Invoke-Expression $function.Extent.Text
$script:Adb = 'mock-adb.exe'
$script:DeviceSerial = $null
$script:bootCompleted = $false
$script:sequence = New-Object System.Collections.Generic.List[string]
function Fail([string]$Code, [string]$Message) { throw ('{0}: {1}' -f $Code, $Message) }
function Invoke-Tool {
  param([string]$FilePath, [string[]]$Arguments, [switch]$AllowFailure)
  $command = $Arguments -join ' '
  $script:sequence.Add($command)
  if ($command -eq 'devices') {
    $devices = 'List of devices attached' + [Environment]::NewLine + 'emulator-5554' + [char]9 + 'device'
    return [pscustomobject]@{ ExitCode = 0; StdOut = $devices; StdErr = '' }
  }
  return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
}
function Invoke-Adb {
  param([string[]]$Arguments, [switch]$AllowFailure)
  $event = $Arguments[-1]
  $script:sequence.Add("event:$event")
  if ($event -eq 'uc_finish_user_unlocked_completed') { $script:bootCompleted = $true }
  return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
}
function Invoke-AdbShell {
  param([string]$Command, [switch]$AllowFailure)
  $script:sequence.Add("shell:$Command")
  $value = if ($script:bootCompleted) { '1' } else { '' }
  return [pscustomobject]@{ ExitCode = 0; StdOut = $value; StdErr = '' }
}
$completed = $false
$errorCode = $null
try {
  $null = Wait-ForBootCompleted
  $completed = $true
} catch {
  $errorCode = $_.Exception.Message
}
[pscustomobject]@{
  completed = $completed
  errorCode = $errorCode
  sequence = @($script:sequence)
} | ConvertTo-Json -Compress
`
    const result = await runPowerShell(['-Command', command], {
      env: { ...process.env, PLAYTIME_PACT_RUNNER_PATH: runnerPath },
    })
    expect(result.error).toBeUndefined()
    expect(result.code, result.stderr || result.stdout).toBe(0)
    const modeled = JSON.parse(result.stdout)
    expect(modeled.completed, modeled.errorCode).toBe(true)
    expect(modeled.sequence.indexOf('event:uc_finish_user_unlocked_completed'))
      .toBeLessThan(modeled.sequence.indexOf('shell:getprop sys.boot_completed'))
    expect(modeled.sequence.indexOf('shell:getprop sys.boot_completed'))
      .toBeLessThan(modeled.sequence.indexOf('event:boot_progress_enable_screen'))
  })

  it('fails closed when the boot signal command fails', () => {
    const code = executableLines(source())
    const bootSignalCall = code
      .split('\n')
      .find((line) => line.includes('Invoke-Adb') && line.includes('boot_progress_enable_screen'))
    expect(bootSignalCall, 'runner must await the framework screen-enable boot event').toBeDefined()
    expect(bootSignalCall).not.toContain('-AllowFailure')
    const userUnlockSignalCall = code
      .split('\n')
      .find((line) => line.includes('Invoke-Adb') && line.includes('uc_finish_user_unlocked_completed'))
    expect(userUnlockSignalCall, 'runner must subscribe to the user-unlocked lifecycle transition').toBeDefined()
    expect(userUnlockSignalCall).not.toContain('-AllowFailure')
  })

  it('always clears the test credential in cleanup', () => {
    const code = executableLines(source())
    // Matches the credential-clearing adb invocation in either inline or argument-array form.
    const clearCredential = /locksettings['",\s]+clear[\s\S]{0,120}?--old/
    expect(code).toMatch(clearCredential)

    // The finally block must invoke the cleanup routine that issues that command.
    const finallyIndex = code.search(/\bfinally\b/)
    expect(finallyIndex, 'runner must have a finally block').toBeGreaterThan(-1)
    const cleanupFunction = code.match(/function\s+([A-Za-z-]*Clear[A-Za-z-]*Credential)\b/)
    expect(cleanupFunction, 'runner must define a credential cleanup function').not.toBeNull()
    expect(code.slice(finallyIndex)).toContain(cleanupFunction[1])
  })

  it('fails a passed run when credential cleanup does not complete', () => {
    const code = executableLines(source())
    expect(code).toContain('credentialClearExitCode')
    expect(code).toContain('credentialClearClassification')
    expect(code).toContain('credentialRemovalVerified')
    expect(code).toMatch(/locksettings['",\s]+verify[\s\S]{0,80}?--old/)
    expect(code).toMatch(/\$report\.outcome\s+-eq\s+'passed'[\s\S]{0,200}-not\s+\$report\.credentialCleared/)
    expect(code).toContain('CREDENTIAL_CLEAR_FAILED')
  })

  it('splits success and locked-failure behavior around the preflight gate', () => {
    const code = executableLines(source())
    expect(code).toContain('VerifyLockedFailure')
    // The locked path must reject before instrumentation is ever launched.
    const gradleIndex = code.search(/connected\w*AndroidTest/)
    expect(gradleIndex, 'runner must invoke the connected instrumentation task').toBeGreaterThan(-1)
    const lockedRejectIndex = code.search(/VerifyLockedFailure/)
    expect(lockedRejectIndex).toBeLessThan(gradleIndex)
  })

  it('contains no fixed sleeps, polling delays, or wait-until-time loops', () => {
    const code = executableLines(source())
    expect(code).not.toMatch(/\bStart-Sleep\b/)
    expect(code).not.toMatch(/\[(System\.)?Threading\.Thread\]::Sleep/i)
    expect(code).not.toMatch(/\bsleep\s+\d/)
    expect(code).not.toMatch(/while\s*\([^)]*(Get-Date|Stopwatch|Elapsed|timeout)/i)
    expect(code).not.toMatch(/do\s*\{[\s\S]{0,600}?\}\s*while\s*\([^)]*(Get-Date|Elapsed)/i)
    // Every process wait is either event-driven and bounded or follows a completed process.
    expect(code).toMatch(/WaitForExit\(\s*\d+\s*\)/)
  })

  it('emits and persists a machine-parseable result report with cleanup facts', () => {
    const code = executableLines(source())
    expect(code).toMatch(/ConvertTo-Json/)
    expect(code).toMatch(/connectedTestCount|testCount|totalTests/)
    expect(code).toMatch(/outcome|status|result/)
    expect(code).toContain('reportPath')
    expect(code).toContain('emulatorResidueCount')
    expect(code).toContain('deviceDisconnected')
  })

  it('subscribes to exact disconnect before kill and includes unnamed qemu helpers in residue', () => {
    const code = executableLines(source())
    const stopFunction = code.slice(code.indexOf('function Start-DeviceDisconnectWait'), code.indexOf('function Wait-ForBootCompleted'))
    expect(stopFunction.indexOf('Start-DeviceDisconnectWait')).toBeGreaterThan(-1)
    expect(stopFunction.indexOf('Start-DeviceDisconnectWait')).toBeLessThan(stopFunction.indexOf("@('emu', 'kill')"))
    expect(stopFunction).toContain('wait-for-disconnect')
    expect(stopFunction).toMatch(/WaitForExit\(\s*30000\s*\)/)

    const processFunction = code.slice(code.indexOf('function Get-ManagedEmulatorProcesses'), code.indexOf('function Start-DeviceDisconnectWait'))
    expect(processFunction).toContain('qemu-system-x86_64.exe')
    expect(processFunction).not.toMatch(/CommandLine[\s\S]*AvdName/)
  })

  windowsIt('generates an ephemeral PIN internally when the environment variable is absent', async () => {
    const environment = { ...process.env }
    delete environment.PLAYTIME_PACT_TEST_DEVICE_PIN
    const result = await runPowerShell(
      ['-File', runnerPath, '-AvdName', 'PlaytimePactMissingAvd-doesnotexist'],
      { env: environment, timeoutMs: 120_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain('generated-ephemeral')
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/PRECONDITION_PIN_ENV_MISSING/)
  })

  windowsIt('rejects a missing AVD during preflight without starting instrumentation', async () => {
    const environment = { ...process.env, PLAYTIME_PACT_TEST_DEVICE_PIN: '246813' }
    const result = await runPowerShell(
      ['-File', runnerPath, '-AvdName', 'PlaytimePactMissingAvd-doesnotexist'],
      { env: environment, timeoutMs: 120_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.code, `expected non-zero exit, stdout=${result.stdout} stderr=${result.stderr}`).not.toBe(0)
    const combined = `${result.stdout}\n${result.stderr}`
    expect(combined).toMatch(/PRECONDITION|AVD/i)
    // The secret must never surface in the runner's own streams.
    expect(combined).not.toContain('246813')
    // Preflight rejection means the Gradle instrumentation task never ran.
    expect(combined).not.toMatch(/connectedDebugAndroidTest\s+(SUCCESS|FAILED)|Starting \d+ tests/i)
  })
})
