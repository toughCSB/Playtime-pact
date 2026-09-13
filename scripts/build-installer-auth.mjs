import { existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'

if (process.platform !== 'win32') process.exit(0)

const windows = process.env.SystemRoot ?? 'C:\\Windows'
const compiler = join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const source = join('build', 'native', 'PlaytimePactInstallerAuth.cs')
const output = join('build', 'native', 'PlaytimePactInstallerAuth.exe')

if (!existsSync(compiler)) throw new Error(`Windows .NET Framework compiler not found: ${compiler}`)
mkdirSync(dirname(output), { recursive: true })
execFileSync(compiler, [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  `/out:${output}`,
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Web.Extensions.dll',
  '/reference:System.ServiceProcess.dll',
  source,
], { stdio: 'inherit', windowsHide: true })
