import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { buildWindowsIdentityTerminationScript, runManagedProcessCapture } from '../src/main/managedGameRuntime'

describe.skipIf(process.platform !== 'win32')('real Windows window shutdown', () => {
  for (const { refuseClose, delayedWindow } of [{ refuseClose: false, delayedWindow: false }, { refuseClose: true, delayedWindow: false }, { refuseClose: false, delayedWindow: true }]) {
    it(delayedWindow ? 'waits for a starting game window instead of immediately crashing its process' : refuseClose ? 'bounds refusal then forces only its fixture' : 'exits through the window close handler without force', async () => {
      const ready = '[Console]::WriteLine(([DateTimeOffset](Get-Process -Id $PID).StartTime).ToUnixTimeMilliseconds())'
      const script = [
        ...(delayedWindow ? [ready, 'Start-Sleep -Milliseconds 1200'] : []),
        'Add-Type -AssemblyName System.Windows.Forms',
        '$form = New-Object System.Windows.Forms.Form',
        "$form.Text = 'Playtime Pact shutdown test fixture'",
        '$form.Width = 220; $form.Height = 100',
        ...(refuseClose ? ['$form.Add_FormClosing({ param($s, $e) $e.Cancel = $true })'] : []),
        `$form.Add_Shown({ $form.Hide(); $form.Show(); ${delayedWindow ? '' : ready} })`,
        '[System.Windows.Forms.Application]::Run($form)',
        "[Console]::WriteLine('closed-cleanly')",
      ].join('; ')
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = once(child, 'exit')
      let output = ''
      try {
        const startedAt = await new Promise<number>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Fixture window did not become ready')), 10000)
          child.stdout.on('data', chunk => {
            output += chunk.toString()
            const match = output.match(/^(\d+)\r?\n/)
            if (match) { clearTimeout(deadline); resolve(Number(match[1])) }
          })
          child.once('error', error => { clearTimeout(deadline); reject(error) })
          child.once('exit', () => { clearTimeout(deadline); reject(new Error('Fixture exited before ready')) })
        })
        const command = buildWindowsIdentityTerminationScript({ pid: child.pid!, processStartedAt: startedAt, imageName: 'powershell.exe', gameId: 'minecraft' }, refuseClose ? 200 : 10000, 5000)
        expect((await runManagedProcessCapture(command, 20000)).trim()).toBe(refuseClose ? 'forced' : 'graceful')
        const [code] = await exited
        if (!refuseClose) { expect(code).toBe(0); expect(output).toContain('closed-cleanly') }
      } finally {
        if (child.exitCode === null) { child.kill(); await exited }
      }
    }, 30000)
  }
})
