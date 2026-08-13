import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUTS = ['windows-payload-manifest.json', 'android-build-input-manifest.json', 'build-inputs.json']
const RELEASE_CONFIG_KEYS = [
  'PLAYTIME_PACT_FCM_ENABLED', 'PLAYTIME_PACT_FIREBASE_API_KEY',
  'PLAYTIME_PACT_FIREBASE_APPLICATION_ID', 'PLAYTIME_PACT_FIREBASE_PROJECT_ID',
  'PLAYTIME_PACT_FIREBASE_SENDER_ID', 'PLAYTIME_PACT_UPDATE_MANIFEST_URL',
  'PLAYTIME_PACT_UPDATE_PUBLIC_KEY_B64', 'PLAYTIME_PACT_ANDROID_VERSION_CODE',
  'PLAYTIME_PACT_ANDROID_VERSION_NAME',
]
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const portable = (path) => path.split(sep).join('/')
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`

const WORKTREE_DIGEST_EXCLUSIONS = [
  '.omo/evidence/', 'android-parent/.gradle/', 'android-parent/build/',
  'android-parent/app/build/', 'artifacts/', 'dist/', 'node_modules/', 'out/', '.wrangler/',
]
const excludedFromWorktreeDigest = (path) => path === '.mcp.json' || /^\d{4}-\d{2}-\d{2}T[^/]+\.jsonl$/u.test(path) ||
  WORKTREE_DIGEST_EXCLUSIONS.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))

async function regularFiles(root, directory, predicate = () => true) {
  const absolute = join(root, directory)
  if (!existsSync(absolute)) return []
  const found = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const projectPath = portable(relative(root, path))
        if (predicate(projectPath)) found.push(projectPath)
      }
    }
  }
  await visit(absolute)
  return found
}

async function hashFiles(root, paths) {
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b, 'en'))
  return Promise.all(unique.map(async (path) => {
    const bytes = await readFile(join(root, path))
    return { path, sha256: sha256(bytes), sizeBytes: bytes.byteLength }
  }))
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const digestFile = async (root, path) => sha256(await readFile(join(root, path)))
export function runCommand(root, command, args) {
  const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) {
    return execFileSync(command, args, options).trim()
  }
  const executable = /[\/]/u.test(command) ? resolve(command) : command
  const values = [executable, ...args.map(String)]
  if (values.some((value) => /[\0\r\n"&|<>^()%!]/u.test(value))) throw new Error('Unsafe batch-wrapper argument')
  return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', ...values], {
    ...options, windowsHide: true,
  }).trim()
}

function gitBytes(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
}

export async function detectGitIdentity(root) {
  const trackedDiff = gitBytes(root, ['diff', '--binary', 'HEAD', '--'])
  const untrackedPaths = gitBytes(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean).map(portable)
    .filter((path) => !excludedFromWorktreeDigest(path))
    .sort((a, b) => a.localeCompare(b, 'en'))
  const digest = createHash('sha256')
  digest.update('tracked-diff\0').update(String(trackedDiff.byteLength)).update('\0').update(trackedDiff)
  for (const path of untrackedPaths) {
    const bytes = await readFile(join(root, path))
    digest.update('untracked\0').update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes)
  }
  return {
    revision: runCommand(root, 'git', ['rev-parse', 'HEAD']),
    tree: runCommand(root, 'git', ['rev-parse', 'HEAD^{tree}']),
    diffSha256: digest.digest('hex'),
  }
}
async function detectToolchain(root, compileSdk) {
  const packageJson = await readJson(join(root, 'package.json'))
  const javaText = runCommand(root, 'java', ['--version'])
  const wrapper = process.platform === 'win32' ? join(root, 'android-parent', 'gradlew.bat') : join(root, 'android-parent', 'gradlew')
  const gradleText = runCommand(join(root, 'android-parent'), wrapper, ['--version'])
  return {
    node: process.version,
    npm: runCommand(root, process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']),
    electron: packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron ?? 'unknown',
    java: javaText.match(/version\s+"([^"]+)"/)?.[1] ?? javaText.split(/\r?\n/, 1)[0],
    gradle: gradleText.match(/^Gradle\s+([^\s]+)$/m)?.[1] ?? 'unknown',
    androidSdk: String(compileSdk),
  }
}
function parseInteger(source, name) {
  const value = source.match(new RegExp(String.raw`\b${name}\s*(?:=\s*)?(\d+)`))?.[1]
  if (!value) throw new Error(`PRECHECK_MISSING: android.identity.${name}`)
  return Number(value)
}
function parseQuoted(source, name) {
  const value = source.match(new RegExp(String.raw`\b${name}\s*(?:=\s*)?["']([^"']+)["']`))?.[1]
  if (!value) throw new Error(`PRECHECK_MISSING: android.identity.${name}`)
  return value
}
function androidIdentity(buildFile, releaseConfig) {
  const versionCodeValue = releaseConfig.PLAYTIME_PACT_ANDROID_VERSION_CODE?.trim()
  const versionNameValue = releaseConfig.PLAYTIME_PACT_ANDROID_VERSION_NAME?.trim()
  const versionCode = versionCodeValue ? Number(versionCodeValue) : parseInteger(buildFile, 'versionCode')
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new Error('PRECHECK_INVALID: android.identity.versionCode')
  return {
    applicationId: parseQuoted(buildFile, 'applicationId'),
    versionCode,
    versionName: versionNameValue || parseQuoted(buildFile, 'versionName'),
    compileSdk: parseInteger(buildFile, 'compileSdk'),
    targetSdk: parseInteger(buildFile, 'targetSdk'),
  }
}
function configDigests(releaseConfig, requireReleaseConfig) {
  if (requireReleaseConfig) {
    const missing = RELEASE_CONFIG_KEYS.filter((key) => !releaseConfig[key]?.trim())
    if (missing.length) throw new Error(`PRECHECK_MISSING: releaseConfig.${missing[0]}`)
  }
  return RELEASE_CONFIG_KEYS.filter((key) => releaseConfig[key]?.trim())
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => ({ name, sha256: sha256(releaseConfig[name].trim()) }))
}
async function androidInputPaths(root) {
  return regularFiles(root, 'android-parent', (path) => {
    const local = path.slice('android-parent/'.length)
    if (local.startsWith('.gradle/') || local.includes('/build/')) return false
    return local.startsWith('app/src/') ||
      /(^|\/)(?:build|settings)\.gradle(?:\.kts)?$/.test(local) ||
      /(^|\/)gradle\.properties$/.test(local) || /(^|\/)gradle\.lockfile$/.test(local) ||
      /(^|\/)gradle\/dependency-locks\/.+$/.test(local) || /(^|\/)gradle\/libs\.versions\.toml$/.test(local) ||
      /(^|\/)gradle\/wrapper\/.+$/.test(local) || local === 'gradlew' || local === 'gradlew.bat' ||
      local === 'app/proguard-rules.pro'
  })
}
function firstDifference(expected, actual, path = '') {
  if (Object.is(expected, actual)) return null
  if (typeof expected !== typeof actual || expected === null || actual === null) return path
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return path
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (typeof expected === 'object') {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort((a, b) => a.localeCompare(b, 'en'))
    for (const key of keys) {
      const difference = firstDifference(expected[key], actual[key], path ? `${path}.${key}` : key)
      if (difference) return difference
    }
    return null
  }
  return path
}

export async function createReleasePayloadManifests(options = {}) {
  const root = resolve(options.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const outputDir = resolve(options.outputDir ?? join(root, '.omo/evidence/project-completion/W4-T1'))
  const releaseConfig = options.releaseConfig ?? process.env
  const packageJson = await readJson(join(root, 'package.json'))
  const androidBuildFile = await readFile(join(root, 'android-parent/app/build.gradle.kts'), 'utf8')
  const identity = androidIdentity(androidBuildFile, releaseConfig)
  const configurationDigests = configDigests(releaseConfig, options.requireReleaseConfig ?? false)
  const toolchain = options.toolchain ?? await detectToolchain(root, identity.compileSdk)
  const git = options.gitIdentity ?? await detectGitIdentity(root)
  const windowsPaths = [...await regularFiles(root, 'out'), ...await regularFiles(root, 'resources')]
  if (existsSync(join(root, 'scripts/provision-remote-approval.ps1'))) windowsPaths.push('scripts/provision-remote-approval.ps1')
  const windows = {
    schemaVersion: 1,
    platform: 'windows',
    identity: {
      name: packageJson.name, version: packageJson.version, main: packageJson.main,
      appId: 'com.playtimepact.desktop', productName: 'Playtime Pact',
      packageJsonSha256: await digestFile(root, 'package.json'),
      electronBuilderConfigSha256: await digestFile(root, 'electron-builder.config.cjs'),
    },
    files: await hashFiles(root, windowsPaths),
  }
  const androidToolchain = { java: toolchain.java, gradle: toolchain.gradle, androidSdk: toolchain.androidSdk }
  const android = {
    schemaVersion: 1, platform: 'android', identity, toolchain: androidToolchain, configurationDigests,
    files: await hashFiles(root, await androidInputPaths(root)),
  }
  const buildInputs = {
    schemaVersion: 1, git,
    packageLockSha256: await digestFile(root, 'package-lock.json'),
    toolchain, androidIdentity: identity, configurationDigests,
    windowsPayloadSha256: sha256(stableJson(windows)),
    androidBuildInputSha256: sha256(stableJson(android)),
  }
  const outputPaths = OUTPUTS.map((name) => join(outputDir, name))
  if (options.writeOutputs !== false) {
    await mkdir(outputDir, { recursive: true })
    await Promise.all([
      writeFile(outputPaths[0], stableJson(windows)),
      writeFile(outputPaths[1], stableJson(android)),
      writeFile(outputPaths[2], stableJson(buildInputs)),
    ])
  }
  return { windows, android, buildInputs, outputPaths }
}

export async function verifyReleasePayloadManifests(options = {}) {
  if (!options.baselineDir) throw new Error('PRECHECK_MISSING: baselineDir')
  const baselineDir = resolve(options.baselineDir)
  const expected = {
    windows: await readJson(join(baselineDir, OUTPUTS[0])),
    android: await readJson(join(baselineDir, OUTPUTS[1])),
    buildInputs: await readJson(join(baselineDir, OUTPUTS[2])),
  }
  const actual = await createReleasePayloadManifests({ ...options, writeOutputs: false })
  const identityDifference = firstDifference(expected.android.identity, actual.android.identity, 'android.identity')
  if (identityDifference) throw new Error(`PRECHECK_MISMATCH: ${identityDifference}`)
  for (const key of ['windows', 'android', 'buildInputs']) {
    const difference = firstDifference(expected[key], actual[key], key)
    if (difference) throw new Error(`PRECHECK_MISMATCH: ${difference}`)
  }
  return actual
}
function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--require-release-config') options.requireReleaseConfig = true
    else if (argument === '--output') options.outputDir = args[++index]
    else if (argument === '--verify') options.baselineDir = args[++index]
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const result = options.baselineDir ? await verifyReleasePayloadManifests(options) : await createReleasePayloadManifests(options)
  console.log(`PASS release payload baseline: ${result.outputPaths.join(', ')}`)
}
