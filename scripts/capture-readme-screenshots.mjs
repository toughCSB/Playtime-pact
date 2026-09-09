import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

app.commandLine.appendSwitch('force-device-scale-factor', '2')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererPath = resolve(root, 'out/renderer/index.html')
const preloadPath = resolve(root, 'tests/fixtures/layout-preload.cjs')
const outputDir = resolve(root, 'screenshots')
const previewName = process.argv.includes('--preview')
  ? process.argv[process.argv.indexOf('--preview') + 1]
  : null

const captures = [
  { name: 'main-screen', scenario: 'play-ready', width: 420, height: 760, marker: '[data-surface="play"] [data-phone-shell]' },
  { name: 'settings-screen', scenario: 'settings-loaded', width: 420, height: 760, marker: '[data-surface="settings"] [data-phone-shell]', action: 'settings' },
  { name: 'admin-screen', scenario: 'admin-timer', width: 400, height: 720, marker: '.ppt-admin-shell[data-admin-destination="timer"]', hash: 'admin', action: 'admin' },
  { name: 'timer-green', scenario: 'readme-timer-green', width: 360, height: 151, marker: '.ppt-corner-timer__panel', crop: true, expectedText: '20:50', expectedColor: 'rgb(123, 255, 181)' },
  { name: 'timer-yellow', scenario: 'readme-timer-yellow', width: 360, height: 151, marker: '.ppt-corner-timer__panel', crop: true, expectedText: '04:50', expectedColor: 'rgb(255, 226, 122)' },
  { name: 'timer-orange', scenario: 'readme-timer-orange', width: 360, height: 151, marker: '.ppt-corner-timer__panel', crop: true, expectedText: '02:50', expectedColor: 'rgb(255, 179, 71)' },
  { name: 'timer-red', scenario: 'readme-timer-red', width: 360, height: 151, marker: '.ppt-corner-timer__panel', crop: true, expectedText: '00:50', expectedColor: 'rgb(255, 93, 108)' },
  { name: 'timer-warning', scenario: 'readme-timer-warning', width: 480, height: 200, marker: '.ppt-overlay-card--warning', crop: true, expectedText: '02:50', expectedColor: 'rgb(255, 179, 71)', warning: 3 },
  { name: 'timer-countdown', scenario: 'readme-timer-countdown', width: 480, height: 200, marker: '.ppt-overlay-card--countdown', crop: true, expectedText: '00:08', expectedColor: 'rgb(255, 93, 108)' },
]

const waitFor = async (win, selector, timeout = 2000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const found = await win.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      return Boolean(element && getComputedStyle(element).display !== 'none' && element.getClientRects().length)
    })()`)
    if (found) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`Timed out waiting for ${selector}`)
}

const clickByName = async (win, selector, accessibleName) => {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const visible = (element) => element && getComputedStyle(element).display !== 'none' && element.getClientRects().length
    const name = (element) => {
      const clone = element.cloneNode(true)
      clone.querySelectorAll('[aria-hidden="true"]').forEach((child) => child.remove())
      return element.getAttribute('aria-label') || clone.innerText.trim()
    }
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(visible)
      .filter((element) => name(element) === ${JSON.stringify(accessibleName)})
    if (matches.length !== 1) return false
    matches[0].click()
    return true
  })()`)
  if (!clicked) throw new Error(`Expected one ${accessibleName} control`)
}

const enterPin = async (win) => {
  for (const digit of ['1', '2', '3', '4']) await clickByName(win, '.ppt-pinpad button', digit)
}

const prepare = async (win, capture) => {
  const initialMarker = capture.action === 'admin'
    ? '.ppt-admin-shell .ppt-pinpad'
    : capture.action === 'settings'
      ? '[data-surface="play"] [data-phone-shell]'
      : capture.marker
  await waitFor(win, initialMarker)
  if (capture.action === 'settings') {
    await clickByName(win, '[data-phone-nav] button', 'Settings')
    await waitFor(win, '[role="dialog"][aria-modal="true"] .ppt-pinpad')
    await enterPin(win)
    await waitFor(win, capture.marker)
  }
  if (capture.action === 'admin') {
    await enterPin(win)
    await waitFor(win, capture.marker)
    await clickByName(win, '[data-phone-nav] button', 'Timer')
  }
  if (capture.warning) {
    win.webContents.send('timer:warning', { minutesLeft: capture.warning })
    await waitFor(win, '.ppt-overlay-card__alert')
  }
  await win.webContents.executeJavaScript(`new Promise((resolvePaint) => {
    document.querySelectorAll('[data-phone-content], .ppt-admin-scroll').forEach((element) => { element.scrollTop = 0 })
    requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint(true)))
  })`)
}

const inspect = async (win, capture) => win.webContents.executeJavaScript(`(() => {
  const target = document.querySelector(${JSON.stringify(capture.marker)})
  const timer = target?.querySelector('.ppt-corner-timer__time, .ppt-overlay-card__timer')
  const rect = target?.getBoundingClientRect()
  return {
    text: timer?.textContent?.trim() ?? null,
    color: timer ? getComputedStyle(timer).color : null,
    markerRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  }
})()`)

const cropRect = (metrics) => {
  const rect = metrics.markerRect
  return {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  }
}

const run = async () => {
  await mkdir(outputDir, { recursive: true })
  const results = []
  const selected = previewName ? captures.filter((capture) => capture.name === previewName) : captures
  if (selected.length === 0) throw new Error(`Unknown preview capture: ${previewName}`)
  const keeper = new BrowserWindow({ show: false })

  for (const capture of selected) {
    const win = new BrowserWindow({
      width: capture.width,
      height: capture.height,
      useContentSize: true,
      show: Boolean(previewName),
      frame: false,
      transparent: true,
      resizable: false,
      webPreferences: {
        backgroundThrottling: false,
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: [`--layout-scenario=${capture.scenario}`],
      },
    })
    await win.loadFile(rendererPath, capture.hash ? { hash: capture.hash } : undefined)
    await prepare(win, capture)
    const metrics = await inspect(win, capture)
    if (capture.expectedText && metrics.text !== capture.expectedText) {
      throw new Error(`${capture.name}: expected ${capture.expectedText}, observed ${metrics.text}`)
    }
    if (capture.expectedColor && metrics.color !== capture.expectedColor) {
      throw new Error(`${capture.name}: expected ${capture.expectedColor}, observed ${metrics.color}`)
    }
    const image = await win.webContents.capturePage(capture.crop ? cropRect(metrics) : undefined)
    const output = join(outputDir, `${capture.name}.png`)
    await writeFile(output, image.toPNG())
    results.push({ ...capture, output, metrics, imageSize: image.getSize() })

    if (previewName) await new Promise((resolvePreview) => setTimeout(resolvePreview, 60_000))
    win.destroy()
  }

  console.log(JSON.stringify({ passed: true, captures: results }, null, 2))
  keeper.destroy()
  app.exit(0)
}

app.whenReady().then(run).catch((error) => {
  console.error(error)
  app.exit(1)
})
