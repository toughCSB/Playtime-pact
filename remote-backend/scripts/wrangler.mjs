import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Every Wrangler invocation goes through the single root-installed binary.
 * `--no-install` keeps this offline: it never downloads a package.
 */
function npxInvocation() {
  if (process.platform !== 'win32') return { command: 'npx', prefix: [] }
  // Node 24 refuses to spawn .cmd shims directly on Windows (EINVAL). Execute the
  // root npm installation's npx CLI with this Node binary, without a command shell.
  const npmBin = process.env.npm_execpath ? dirname(process.env.npm_execpath) : join(dirname(process.execPath), 'node_modules', 'npm', 'bin')
  const npxCli = join(npmBin, 'npx-cli.js')
  if (!existsSync(npxCli)) throw Object.assign(new Error(`npx CLI not found at ${npxCli}`), { code: 'NPX_MISSING' })
  return { command: process.execPath, prefix: [npxCli] }
}

export function runWrangler(argv, { cwd = REPOSITORY_ROOT, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const { command, prefix } = npxInvocation()
    const child = spawn(command, [...prefix, '--no-install', 'wrangler', ...argv], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(Object.assign(new Error(stderr.trim() || `wrangler exited with ${code}`), { code: 'WRANGLER_FAILED', stdout, stderr, exitCode: code }))
    })
  })
}
