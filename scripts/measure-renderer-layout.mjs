import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_LAYOUT_SIZES, LAYOUT_SCENARIOS, MAIN_LAYOUT_SIZES } from '../tests/fixtures/layoutScenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const argvValue = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const rendererArg = argvValue('--renderer', 'out/renderer/index.html')
const reportArg = argvValue('--report', join(root, 'artifacts', 'layout'))
const frozenSourceHashValue = argvValue('--source-hash')
const expectedRendererSourceHash = argvValue('--renderer-source-hash')
const frozenSourceHash = frozenSourceHashValue
  ? frozenSourceHashValue.startsWith('sha256:') ? frozenSourceHashValue : `sha256:${frozenSourceHashValue}`
  : null
const scenarioFilter = argvValue('--scenario')
const requestedScaleFactor = argvValue('--scale-factor')
if (requestedScaleFactor) app.commandLine.appendSwitch('force-device-scale-factor', requestedScaleFactor)
const rendererPath = isAbsolute(rendererArg) ? rendererArg : resolve(root, rendererArg)
const reportDir = isAbsolute(reportArg) ? reportArg : resolve(root, reportArg)
const preloadPath = resolve(root, 'tests/fixtures/layout-preload.cjs')

const manifest = async (directory) => {
  const entries = []
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) entries.push({ path: relative(directory, file).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
    }
  }
  const info = await stat(directory)
  if (!info.isDirectory()) throw new Error(`Manifest root is not a directory: ${directory}`)
  await visit(directory)
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { files: entries, hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

const evidenceManifest = async (targets) => {
  const entries = []
  const visit = async (path) => {
    const info = await stat(path)
    if (info.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        await visit(join(path, entry.name))
      }
      return
    }
    if (info.isFile()) {
      entries.push({
        path: relative(root, path).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
      })
    }
  }
  for (const target of targets) await visit(resolve(root, target))
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return { files: entries, hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }
}

const PROBE = `(() => {
  const rect = (element) => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
  };
  const visible = (element) => {
    if (!element || element.closest('[hidden]') || element.closest('details:not([open])')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && element.getClientRects().length > 0;
  };
  const describe = (element) => element ? { rect: rect(element), display: getComputedStyle(element).display, height: getComputedStyle(element).height, hidden: element.hasAttribute('hidden'), appHostMatch: element.matches('.ppt-app-root > div:not([hidden])'), overflowX: getComputedStyle(element).overflowX, overflowY: getComputedStyle(element).overflowY } : null;
  const intersects = (a, b) => a && b && Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(visible);
  const shell = [...document.querySelectorAll('[data-phone-shell]')].find(visible);
  const stage = shell?.parentElement || null;
  const screen = shell?.querySelector('[data-phone-screen]') || null;
  const content = screen?.querySelector('[data-phone-content]') || null;
  const nav = screen?.querySelector('[data-phone-nav]') || null;
  const surface = modal || shell || [...document.querySelectorAll('.ppt-admin-shell')].find(visible) || null;
  const focusables = surface ? [...surface.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(visible) : [];
  const navRect = rect(nav);
  const focusIssues = [];
  for (const element of focusables) {
    let value = rect(element);
    let navOverlap = Boolean(!modal && nav && !nav.contains(element) && intersects(navRect, value));
    let scrollDebug = null;
    const outsideViewport = !value || value.left < 0 || value.top < 0 || value.right > innerWidth || value.bottom > innerHeight;
    if (outsideViewport || navOverlap) {
      const scrollParent = (() => {
        let parent = element.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          if (parent.scrollHeight > parent.clientHeight && ['auto', 'scroll'].includes(style.overflowY)) return parent;
          if (parent === surface) break;
          parent = parent.parentElement;
        }
        return null;
      })();
      scrollDebug = scrollParent ? { className: scrollParent.className, before: scrollParent.scrollTop, maximum: scrollParent.scrollHeight - scrollParent.clientHeight } : null;
      if (scrollParent && value) {
        const parentRect = rect(scrollParent);
        scrollParent.scrollTop += value.top - parentRect.top - (scrollParent.clientHeight - value.height) / 2;
      if (scrollDebug && scrollParent) scrollDebug.after = scrollParent.scrollTop;
      }
      value = rect(element);
      navOverlap = Boolean(!modal && nav && !nav.contains(element) && intersects(navRect, value));
    }
    if (!value || value.width <= 0 || value.height <= 0 || value.left < 0 || value.top < 0 || value.right > innerWidth || value.bottom > innerHeight || navOverlap) {
      focusIssues.push({ tag: element.tagName, ariaLabel: element.getAttribute('aria-label'), rect: value, navOverlap, scrollDebug });
    }
  }
  const primary = surface ? [...surface.querySelectorAll('.ppt-button--primary')].filter(visible) : [];
  const glance = shell ? [...shell.querySelectorAll('[data-glance]')].filter(visible) : [];
  const contained = (value) => value && value.left >= 0 && value.top >= 0 && value.right <= innerWidth && value.bottom <= innerHeight;
  return {
    innerWidth, innerHeight, devicePixelRatio, surface: modal ? 'modal' : shell ? 'phone' : surface ? 'admin' : 'missing',
    geometryClass: stage?.getAttribute('data-geometry-class') || null,
    stage: describe(stage), host: describe(stage?.parentElement), appRoot: describe(stage?.parentElement?.parentElement), shell: describe(shell), screen: describe(screen), content: describe(content), nav: describe(nav),
    shellInset: shell ? { left: rect(shell).left, top: rect(shell).top, right: innerWidth - rect(shell).right, bottom: innerHeight - rect(shell).bottom } : null,
    shellContained: contained(rect(shell)), screenContained: contained(rect(screen)), navContained: contained(navRect),
    glance: glance.map(describe), primaryActionCount: primary.length, focusIssues,
    horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    contentScrollable: Boolean(content && content.scrollHeight > content.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(content).overflowY)),
    contentOverflow: content ? Math.max(0, content.scrollHeight - content.clientHeight) : null,
    compactScrollPath: Boolean(content && (content.scrollHeight <= content.clientHeight || ['auto', 'scroll'].includes(getComputedStyle(content).overflowY))),
    glanceAboveFold: glance.length > 0 && glance.every((item) => item.getBoundingClientRect().top >= 0 && item.getBoundingClientRect().bottom <= innerHeight),
  };
})()`

const action = async (win, selector, label, accessibleName = null) => win.webContents.executeJavaScript(`(() => {
  const visible = (element) => element && !element.closest('[hidden]') && !element.closest('details:not([open])') && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
  const name = (element) => { const clone = element.cloneNode(true); clone.querySelectorAll('[aria-hidden="true"]').forEach((child) => child.remove()); return element.getAttribute('aria-label') || clone.innerText.trim(); };
  const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(visible).filter((element) => ${JSON.stringify(accessibleName)} === null || name(element) === ${JSON.stringify(accessibleName)});
  if (candidates.length !== 1) return { ok: false, reason: 'expected one visible accessible/data selector match, found ' + candidates.length };
  candidates[0].click(); return { ok: true };
})()`)
const waitFor = async (win, marker, timeout = 800) => {
  const selector = typeof marker === 'string' ? marker : marker.selector
  const textIncludes = typeof marker === 'string' ? null : marker.textIncludes ?? null
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const found = await win.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return Boolean(e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length && (${JSON.stringify(textIncludes)} === null || e.textContent.includes(${JSON.stringify(textIncludes)}))); })()`)
    if (found) return true
    await new Promise((done) => setTimeout(done, 20))
  }
  return false
}
const requireStep = async (win, selector, label, accessibleName = null) => {
  const result = await action(win, selector, label, accessibleName)
  if (!result.ok) throw new Error(`${label}: ${result.reason}`)
}
const enterPin = async (win) => {
  for (const digit of ['1', '2', '3', '4']) await requireStep(win, '.ppt-pinpad button', `PIN digit ${digit}`, digit)
}

const prepareScenario = async (win, scenario) => {
  const initialSelector = scenario.presentation === 'overlay' ? scenario.marker.selector : scenario.window === 'admin' ? '.ppt-admin-shell .ppt-pinpad' : '[data-surface="play"] [data-phone-shell]'
  if (!await waitFor(win, initialSelector)) throw new Error(`initial surface missing: ${initialSelector}`)
  const nav = (name) => requireStep(win, '[data-phone-nav] button', `nav ${name}`, name)
  if (scenario.action === 'open-rules') { await nav('Rules'); if (!await waitFor(win, '[data-surface="rules"] [data-phone-shell]')) throw new Error('rules surface did not open') }
  if (scenario.action?.startsWith('open-settings')) {
    await nav('Settings'); if (!await waitFor(win, '[role="dialog"][aria-modal="true"] .ppt-pinpad__input')) throw new Error('settings PIN dialog did not open')
    await enterPin(win); if (!await waitFor(win, '[data-surface="settings"] [data-phone-shell]')) throw new Error('settings surface did not open')
    if (scenario.action !== 'open-settings') await requireStep(win, '[data-surface="settings"] [data-phone-shell] .ppt-button--primary', 'settings save')
  }
  if (scenario.action === 'open-approval' || scenario.action === 'reject-approval') {
    await requireStep(win, '[data-surface="play"] [data-phone-shell] .ppt-button--primary', 'play primary action')
    if (!await waitFor(win, '[role="dialog"][aria-modal="true"] .ppt-pinpad__input')) throw new Error('approval dialog did not open')
    if (scenario.action === 'reject-approval') await enterPin(win)
  }
  if (scenario.action?.startsWith('open-admin') || scenario.action === 'admin-timer-error') {
    await enterPin(win); if (!await waitFor(win, '.ppt-admin-shell[data-admin-destination]')) throw new Error('admin dashboard did not open')
    const destination = scenario.action === 'open-admin-safety' ? 'safety' : 'timer'
    await requireStep(win, '[data-phone-nav] button', `admin ${destination}`, destination === 'safety' ? 'Safety' : 'Timer')
    if (scenario.action === 'admin-timer-error') await requireStep(win, '[data-admin-panel="timer"] button', 'timer action', '타이머 중지')
  }
  if (scenario.action === 'reject-admin-pin') await enterPin(win)
  if (!await waitFor(win, scenario.marker)) throw new Error(`scenario marker missing: ${scenario.marker.selector}`)
}

const diagnostics = (metrics, scenario, rendererSourceMatches) => {
  const overlay = scenario.presentation === 'overlay'
  const phone = !overlay
  const requiresGlance = ['play-ready', 'play-outside-hours', 'play-exhausted', 'rules-long-copy'].includes(scenario.id)
  const aboveFold = requiresGlance && metrics.innerWidth >= 320 && metrics.innerHeight >= 579 ? metrics.glanceAboveFold : true
  const requiresNav = !overlay && scenario.id !== 'admin-pin'
  const preferredWidth = scenario.window === 'admin' ? 400 : 420
  const preferredHeight = scenario.window === 'admin' ? 720 : 760
  const expectedGeometryClass = metrics.innerWidth >= preferredWidth && metrics.innerHeight >= preferredHeight ? 'preferred' : 'scaled'
  const expectedInset = expectedGeometryClass === 'preferred' ? 4 : 2
  const insetMatches = !phone || Boolean(metrics.shellInset && Object.values(metrics.shellInset).every((value) => Math.abs(value - expectedInset) < 0.01))
  return {
    rendererSourceHashMatches: rendererSourceMatches,
    frozenSourceBound: Boolean(frozenSourceHash),
    markerPresent: true,
    shellPresent: overlay ? !metrics.shell : Boolean(metrics.shell),
    screenPresent: overlay ? !metrics.screen : Boolean(metrics.screen),
    contentPresent: overlay ? true : Boolean(metrics.content),
    navPresent: !requiresNav || Boolean(metrics.nav),
    geometryClassMatches: !phone || metrics.geometryClass === expectedGeometryClass,
    exactTransparentInset: insetMatches,
    glancePresent: !requiresGlance || metrics.glance.length > 0,
    primaryStatePresent: metrics.primaryActionCount <= 1,
    shellContained: overlay || metrics.shellContained,
    screenContained: overlay || metrics.screenContained,
    navContained: !requiresNav || metrics.navContained,
    noHorizontalOverflow: metrics.horizontalOverflow === 0,
    contentOverflowAccessible: !phone || metrics.contentOverflow === 0 || metrics.contentScrollable,
    focusablesVisibleAndClear: metrics.focusIssues.length === 0,
    primaryActionAtMostOne: metrics.primaryActionCount <= 1,
    aboveFoldGlance: aboveFold,
    compactScrollPath: !phone || metrics.compactScrollPath,
  }
}

const run = async () => {
  await mkdir(reportDir, { recursive: true })
  const source = await manifest(resolve(root, 'src/renderer'))
  const build = await manifest(dirname(rendererPath))
  const inputs = await evidenceManifest(['src', 'scripts/measure-renderer-layout.mjs', 'tests/fixtures/layout-preload.cjs', 'tests/fixtures/layoutScenarios.mjs', 'package.json', 'electron-builder.config.cjs'])
  const rendererSourceMatches = Boolean(expectedRendererSourceHash) && expectedRendererSourceHash === source.hash
  const results = []
  const keeper = new BrowserWindow({ show: false })
  try {
    for (const scenario of LAYOUT_SCENARIOS.filter((item) => !scenarioFilter || item.id === scenarioFilter)) {
      const sizes = scenario.window === 'admin' ? ADMIN_LAYOUT_SIZES : MAIN_LAYOUT_SIZES
      for (const [width, height] of sizes) {
        let win
        const record = { scenario: scenario.id, scenarioMarker: scenario.marker.selector, window: scenario.window, width, height, passed: false, diagnostics: {}, metrics: null }
        try {
          win = new BrowserWindow({ width, height, useContentSize: true, show: false, frame: false, transparent: true, resizable: false, webPreferences: { backgroundThrottling: false, preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, additionalArguments: [`--layout-scenario=${scenario.id}`] } })
          await win.loadFile(rendererPath, scenario.window === 'admin' ? { hash: 'admin' } : undefined)
          await prepareScenario(win, scenario)
          const metrics = await win.webContents.executeJavaScript(PROBE)
          record.metrics = metrics
          record.diagnostics = diagnostics(metrics, scenario, rendererSourceMatches)
          record.passed = Object.values(record.diagnostics).every(Boolean)
          // DOM state can precede the compositor frame, especially in hidden windows.
          // Reset probe scrolling and wait for paint before capturing the named scenario.
          await win.webContents.executeJavaScript(`new Promise((resolve) => {
            document.querySelectorAll('[data-phone-content], .ppt-admin-scroll, .ppt-scroll-stack').forEach((element) => { element.scrollTop = 0; });
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
          })`)
          const screenshotName = `${scenario.id}-${width}x${height}.png`
          await writeFile(join(reportDir, screenshotName), (await win.webContents.capturePage()).toPNG())
          record.screenshot = screenshotName
        } catch (error) { record.error = error instanceof Error ? error.message : String(error) }
        finally { if (win && !win.isDestroyed()) win.destroy() }
        results.push(record)
      }
    }
  } finally {
    const report = { schemaVersion: 3, generatedAt: new Date().toISOString(), frozenSourceHash, observedRendererSourceManifestHash: source.hash, expectedRendererSourceHash, evidenceInputManifestHash: inputs.hash, evidenceInputManifest: inputs.files, buildManifestHash: build.hash, rendererSourceManifest: source.files, buildManifest: build.files, electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, requestedScaleFactor, devicePixelRatioValues: [...new Set(results.map((result) => result.metrics?.devicePixelRatio).filter(Boolean))], results, passed: Boolean(frozenSourceHash) && rendererSourceMatches && results.length > 0 && results.every((result) => result.passed) }
    await writeFile(join(reportDir, 'layout-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    keeper.destroy()
    app.exit(report.passed ? 0 : 1)
  }
}

app.whenReady().then(run).catch((error) => { console.error(error); app.exit(1) })
