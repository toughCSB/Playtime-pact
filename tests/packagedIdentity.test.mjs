import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const installerScript = readFileSync('build/installer.nsh', 'utf8')
const mainProcessSource = readFileSync('src/main/main.ts', 'utf8')
const privilegedServiceSource = readFileSync('src/main/remoteApproval/privilegedService.ts', 'utf8')
const watchdogLauncher = readFileSync('resources/start-watch-loop.vbs', 'utf8')
const watchLoopScript = readFileSync('resources/watch-loop.ps1', 'utf8')
const watchdogScript = readFileSync('resources/watchdog.ps1', 'utf8')
const signatureVerifier = readFileSync('scripts/verify-win-signature.mjs', 'utf8')
const signingGate = readFileSync('scripts/ensure-win-signing-configured.mjs', 'utf8')
const builderConfig = readFileSync('electron-builder.config.cjs', 'utf8')
const packagedExePath = 'dist/win-unpacked/Playtime Pact.exe'
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

describe('packaged Playtime Pact identity surfaces', () => {
  it('keeps package metadata on the Playtime Pact identity', () => {
    expect(packageJson.name).toBe('playtime-pact')
    expect(packageJson.build.appId).toBe('com.playtimepact.desktop')
    expect(packageJson.build.productName).toBe('Playtime Pact')
    expect(packageJson.build.executableName).toBe('Playtime Pact')
    expect(packageJson.build.nsis.shortcutName).toBe('Playtime Pact')
    expect(packageJson.build.nsis.uninstallDisplayName).toBe('Playtime Pact')
    expect(builderConfig).toContain("appId: 'com.playtimepact.desktop'")
    expect(builderConfig).toContain("productName: 'Playtime Pact'")
    expect(builderConfig).toContain("executableName: 'Playtime Pact'")
    expect(builderConfig).toContain("shortcutName: 'Playtime Pact'")
    expect(builderConfig).toContain("uninstallDisplayName: 'Playtime Pact'")
    expect(builderConfig).not.toContain("appId: 'com.mypact.myfuture'")
  })

  it('uses packaging scripts that keep Windows metadata editing enabled and avoid implicit publish', () => {
    expect(packageJson.scripts['package:win:unsigned']).toContain('--config electron-builder.config.cjs')
    expect(packageJson.scripts['package:win:unsigned']).toContain('--config.win.forceCodeSigning=false')
    expect(packageJson.scripts['package:win:unsigned']).toContain('--publish never')
    expect(packageJson.scripts['package:win:unsigned']).not.toContain('signAndEditExecutable=false')
    expect(packageJson.scripts['package:win:signed']).toContain('--config electron-builder.config.cjs')
    expect(packageJson.scripts['package:win:signed']).toContain('--publish never')
    expect(signatureVerifier).toContain('Playtime Pact Setup')
    expect(signatureVerifier).toContain("join('dist', 'win-unpacked', 'Playtime Pact.exe')")
    expect(signatureVerifier).toContain("'node-windows'")
    expect(signatureVerifier).toContain("'winsw.exe'")
    expect(signatureVerifier).toContain('WIN_CSC_PUBLISHER_NAME')
    expect(signatureVerifier).toContain('WIN_CSC_SUBJECT_NAME')
    expect(signatureVerifier).toContain('WIN_CSC_SHA1')
    expect(signatureVerifier).toContain('AZURE_TRUSTED_SIGNING_PUBLISHER_NAME')
    expect(signatureVerifier).toContain('A pinned Windows signer publisher, subject, or thumbprint is required.')
    expect(signingGate).toContain('hasPinnedSigner')
    expect(signatureVerifier).not.toContain('My Pact Setup')
    expect(signatureVerifier).not.toContain("join('dist', 'win-unpacked', 'My Pact.exe')")
  })


  it('points watchdog scripts at the Playtime Pact executable and storage root', () => {
    expect(watchdogLauncher).toContain('Playtime Pact.exe')
    expect(watchdogLauncher).toContain('Win32_Process')
    expect(watchdogLauncher).toContain('WScript.Sleep 3000')
    expect(watchdogLauncher).toContain('PlaytimePactWatchdog-')
    expect(watchdogLauncher).toContain('fso.CreateFolder lockPath')
    expect(watchdogLauncher).not.toContain('powershell.exe')
    expect(watchdogLauncher).not.toContain('watch-loop.ps1')
    expect(mainProcessSource).toContain("spawn('wscript.exe'")
    expect(mainProcessSource).toContain('detached: true')
    expect(mainProcessSource).toContain("process.argv.includes('--from-watchdog')")
    expect(mainProcessSource).not.toContain('exec(`wscript.exe')

    expect(watchLoopScript).toContain('Playtime Pact.exe')
    expect(watchLoopScript).toContain('Playtime Pact')
    expect(watchLoopScript).toContain('PlaytimePactWatchdog')
    expect(watchLoopScript).toContain('PlaytimePact\\watchdog-disabled.flag')
    expect(watchLoopScript).not.toContain('MyPact\\Admin\\watchdog-disabled.flag')

    expect(watchdogScript).toContain('Playtime Pact.exe')
    expect(watchdogScript).toContain('Get-Process -Name "Playtime Pact"')
    expect(watchdogScript).not.toContain('My Pact.exe')
  })

  it('validates packaged Windows executable metadata when the artifact exists', () => {
    if (process.platform !== 'win32' || !existsSync(packagedExePath)) return

    expect(isAbsolute(powershell)).toBe(true)
    expect(existsSync(powershell)).toBe(true)

    const script = [
      "$p=(Resolve-Path 'dist/win-unpacked/Playtime Pact.exe').Path",
      "$v=(Get-Item -LiteralPath $p).VersionInfo",
      "[pscustomobject]@{ ProductName=$v.ProductName; FileDescription=$v.FileDescription; InternalName=$v.InternalName; OriginalFilename=$v.OriginalFilename } | ConvertTo-Json -Compress",
    ].join('; ')
    const raw = execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()

    const metadata = JSON.parse(raw)
    expect(metadata.ProductName).toBe('Playtime Pact')
    expect(metadata.FileDescription).toBe('Playtime Pact')
    expect(metadata.InternalName).toBe('Playtime Pact')
  })

  it('creates new installer/runtime identity surfaces while failing closed on active legacy remnants', () => {
    const customInstallStart = installerScript.indexOf('!macro customInstall')
    const customInstallEnd = installerScript.indexOf('!macroend', customInstallStart)
    const customInstall = installerScript.slice(customInstallStart, customInstallEnd)

    expect(installerScript).toContain('WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "PlaytimePact"')
    expect(installerScript).toContain('schtasks /create /tn "PlaytimePact"')
    expect(installerScript).toContain('C:\\ProgramData\\PlaytimePact\\Admin\\admin-secret.json')
    expect(installerScript).toContain('Playtime Pact - Uninstall')
    expect(installerScript).toContain('Legacy MyPact remnants are still active. Remove MyPact completely before installing Playtime Pact.')
    expect(installerScript).toContain('Get-ScheduledTask -TaskName $$_ -ErrorAction SilentlyContinue')
    expect(installerScript).toContain('Rfc2898DeriveBytes')
    expect(installerScript).toContain("algorithm='pbkdf2-sha256'")
    expect(installerScript).toContain('iterations=1500000')
    expect(installerScript).toContain('icacls.exe C:\\ProgramData\\PlaytimePact\\Admin /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /T /C')
    expect(installerScript).toContain('icacls.exe C:\\ProgramData\\PlaytimePact\\Admin\\admin-secret.json /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F /C')
    expect(installerScript).not.toContain('PlaytimePact\\Admin\\watchdog-disabled.flag')
    expect(installerScript).toContain('PlaytimePact\\watchdog-disabled.flag')
    expect(installerScript).toContain("DeleteRegValue HKLM \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"MyPact\"")
    expect(installerScript).toContain("ExecWait 'taskkill /F /IM \"MyPact.exe\" /T'")
    expect(installerScript).toContain("@('My Pact.exe','My Pact for My Future.exe','MyPact.exe')")
    expect(installerScript).toContain('PlaytimePactPrivilegedBroker.exe" install')
    expect(installerScript).toContain('<domain>NT AUTHORITY</domain>')
    expect(installerScript).toContain('<user>SYSTEM</user>')
    expect(installerScript).not.toContain('<user>LocalSystem</user>')
    expect(installerScript).toContain('PlaytimePactPrivilegedBroker.exe" start')
    expect(installerScript).toContain('--initialize-local-protection')
    expect(installerScript).toContain('--privileged-broker-service --initialize-local-protection')
    expect(installerScript).toContain('PlaytimePactPrivilegedBroker.exe" uninstall')
    expect(installerScript).toContain('PlaytimePactPrivilegedBroker.exe" install')
    expect(installerScript).toContain(`nsExec::ExecToStack '"$INSTDIR\\Playtime Pact.exe" --protection-readiness-check'`)
    expect(installerScript).not.toContain("nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden")
    expect(installerScript).toContain('failed its IPC health check')
    expect(customInstall).toContain('PlaytimePactPrivilegedBroker.exe" stop')
    expect(customInstall).not.toContain('sc.exe delete PlaytimePactPrivilegedBroker')
    expect(installerScript).not.toContain('sc.exe create PlaytimePactPrivilegedBroker')
    expect(builderConfig).toContain("'node_modules/node-windows/bin/winsw/**'")
    expect(builderConfig).toContain("'!node_modules/node-windows/bin/sudowin/**'")
    expect(builderConfig).toContain("'!node_modules/node-windows/bin/elevate/**'")
    expect(privilegedServiceSource).toContain("FlushFileBuffers = kernel32 && kernel32.func('bool __stdcall FlushFileBuffers(void * File)')")
    expect(privilegedServiceSource).toContain('if (!writeOk || !FlushFileBuffers?.(handle))')
  })
})
