import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createReleasePayloadManifests, detectGitIdentity, runCommand, verifyReleasePayloadManifests } from '../scripts/create-release-payload-manifest.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'playtime-pact-release-manifest-'))
  temporaryDirectories.push(root)
  const files = {
    'out/main/main.js': 'desktop-entry',
    'out/renderer/index.js': 'renderer-entry',
    'resources/tray.png': 'resource',
    'android-parent/app/src/main/java/example/Main.java': 'class Main {}',
    'android-parent/app/src/main/res/values/strings.xml': '<resources/>',
    'android-parent/app/build.gradle.kts': 'applicationId = "com.playtimepact.parent"\nversionCode = configuredVersionCode\nversionName = configuredVersionName\ncompileSdk = 36\ntargetSdk = 36\n',
    'android-parent/build.gradle.kts': 'plugins {}',
    'android-parent/settings.gradle.kts': 'rootProject.name = "parent"',
    'android-parent/gradle.properties': 'org.gradle.jvmargs=-Xmx1g',
    'android-parent/gradle.lockfile': 'locked=true',
    'package-lock.json': '{"lockfileVersion":3}',
    'electron-builder.config.cjs': 'module.exports = {}',
  }
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'playtime-pact', version: '1.2.3', main: 'out/main/main.js' }))
  return root
}

const toolchain = {
  node: 'v22.1.0', npm: '10.8.0', electron: '42.5.1', java: '17.0.12', gradle: '8.13', androidSdk: '36',
}
const gitIdentity = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), diffSha256: 'c'.repeat(64), statusSha256: 'd'.repeat(64) }
const releaseConfig = {
  PLAYTIME_PACT_FCM_ENABLED: 'true',
  PLAYTIME_PACT_FIREBASE_PROJECT_ID: 'staging-project',
  PLAYTIME_PACT_ANDROID_VERSION_CODE: '7',
  PLAYTIME_PACT_ANDROID_VERSION_NAME: '7.0.0',
  PLAYTIME_PACT_ANDROID_STORE_PASSWORD: 'must-never-appear',
}

test('creates deterministic separated payload manifests and rejects named Android identity drift', async () => {
  const root = await fixture()
  const baseline = join(root, 'baseline')
  const options = { root, outputDir: baseline, toolchain, gitIdentity, releaseConfig }
  const first = await createReleasePayloadManifests(options)
  const firstBytes = await Promise.all(first.outputPaths.map((path) => readFile(path, 'utf8')))
  const second = await createReleasePayloadManifests(options)
  const secondBytes = await Promise.all(second.outputPaths.map((path) => readFile(path, 'utf8')))

  expect(secondBytes).toEqual(firstBytes)
  expect(first.windows.files.map(({ path }) => path)).toEqual([
    'out/main/main.js', 'out/renderer/index.js', 'resources/tray.png',
  ])
  expect(first.android.files.map(({ path }) => path)).toEqual([...first.android.files.map(({ path }) => path)].sort())
  expect(first.windows.files.some(({ path }) => path.startsWith('android-parent/'))).toBe(false)
  expect(first.android.files.some(({ path }) => path.startsWith('out/') || path.startsWith('resources/'))).toBe(false)
  expect(first.android.identity).toMatchObject({ applicationId: 'com.playtimepact.parent', versionCode: 7, versionName: '7.0.0' })
  expect(JSON.stringify(first)).not.toContain('must-never-appear')
  expect(JSON.stringify(first)).not.toMatch(/timestamp|signature|installer/i)

  const baselineBytes = await Promise.all(first.outputPaths.map((path) => readFile(path)))
  await expect(verifyReleasePayloadManifests({
    ...options,
    outputDir: baseline,
    baselineDir: baseline,
    releaseConfig: { ...releaseConfig, PLAYTIME_PACT_ANDROID_VERSION_NAME: '7.0.1' },
  })).rejects.toThrow('PRECHECK_MISMATCH: android.identity.versionName')
  expect(await Promise.all(first.outputPaths.map((path) => readFile(path)))).toEqual(baselineBytes)
})


test.runIf(process.platform === 'win32')('runs a Windows batch wrapper without shell-string execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playtime-pact-batch-wrapper-'))
  temporaryDirectories.push(root)
  const wrapper = join(root, 'gradle wrapper.bat')
  await writeFile(wrapper, '@echo off\r\nif not "%~1"=="--version" exit /b 9\r\necho Gradle 8.13\r\n')

  expect(runCommand(root, wrapper, ['--version'])).toBe('Gradle 8.13')
  expect(() => runCommand(root, wrapper, ['--version & whoami'])).toThrow('Unsafe batch-wrapper argument')
})

test('Git identity includes non-ignored untracked source and explicitly excludes generated trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'playtime-pact-git-identity-'))
  temporaryDirectories.push(root)
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  await writeFile(join(root, 'tracked.txt'), 'tracked\n')
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'contract@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Contract Test'], { cwd: root })
  execFileSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })

  const initial = await detectGitIdentity(root)
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts', 'new-tool.mjs'), 'export const value = 1\n')
  const withUntrackedSource = await detectGitIdentity(root)
  await writeFile(join(root, 'scripts', 'new-tool.mjs'), 'export const value = 2\n')
  const withChangedUntrackedSource = await detectGitIdentity(root)

  expect(withUntrackedSource.diffSha256).not.toBe(initial.diffSha256)
  expect(withChangedUntrackedSource.diffSha256).not.toBe(withUntrackedSource.diffSha256)

  await mkdir(join(root, '.omo', 'evidence', 'generated'), { recursive: true })
  await mkdir(join(root, 'out'), { recursive: true })
  await mkdir(join(root, 'android-parent', 'app', 'build'), { recursive: true })
  await writeFile(join(root, '.omo', 'evidence', 'generated', 'receipt.json'), '{}')
  await writeFile(join(root, 'out', 'bundle.js'), 'generated')
  await writeFile(join(root, 'android-parent', 'app', 'build', 'app.apk'), 'generated')
  await writeFile(join(root, '.mcp.json'), '{"local":true}')
  await writeFile(join(root, '2026-08-11T01-35-50-354Z_session.jsonl'), '{"local":true}')
  const withGeneratedOutputs = await detectGitIdentity(root)

  expect(withGeneratedOutputs.diffSha256).toBe(withChangedUntrackedSource.diffSha256)
})
