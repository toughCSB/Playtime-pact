/**
 * Deterministic, secret-free Wrangler config rendering.
 *
 * Environment identifiers live in the gitignored, non-secret local release
 * inventory (`.omo/inputs/project-completion.local.json`). Secrets are never read
 * here; only the names that must exist externally are reported.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { REPOSITORY_ROOT, runWrangler } from './wrangler.mjs'

export const REQUIRED_SECRET_NAMES = Object.freeze(['FCM_PRIVATE_KEY', 'FCM_TOKEN_ENCRYPTION_KEY', 'PAIRING_TOKEN_SECRET'])
export const SUPPORTED_ENVIRONMENTS = Object.freeze(['staging', 'production'])
export const TEMPLATE_PATH = join(REPOSITORY_ROOT, 'remote-backend', 'wrangler.template.toml')
export const DEFAULT_INPUTS_PATH = join(REPOSITORY_ROOT, '.omo', 'inputs', 'project-completion.local.json')
export const RENDERED_DIR = join(REPOSITORY_ROOT, 'remote-backend', '.wrangler')

const REQUIRED_KEYS = Object.freeze([
  'workerName',
  'workerBaseUrl',
  'd1DatabaseName',
  'd1DatabaseId',
  'firebaseProjectId',
  'firebaseClientEmail',
  'setupAuthorityActorId',
  'operatorAuthorityActorId',
])

const PLACEHOLDER = /(^|[^a-z])(todo|tbd|changeme|fill[-_ ]?me|placeholder|xxx)([^a-z]|$)/i
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/
const SERVICE_ACCOUNT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code })

export function validateEnvironmentName(env) {
  if (!SUPPORTED_ENVIRONMENTS.includes(env)) throw fail('BAD_ENVIRONMENT', `--env must be one of ${SUPPORTED_ENVIRONMENTS.join(', ')}`)
  return env
}

export function validateEnvironmentInput(env, value) {
  const errors = []
  const at = (key) => `${env}.${key}`
  if (!value || typeof value !== 'object') return { errors: [`${env} section is missing from the local release inventory`] }
  for (const key of REQUIRED_KEYS) {
    const raw = value[key]
    if (typeof raw !== 'string' || raw.trim() === '') { errors.push(`${at(key)} must be a non-empty string`); continue }
    if (raw !== raw.trim()) { errors.push(`${at(key)} must not have surrounding whitespace`); continue }
    if (PLACEHOLDER.test(raw) || raw.includes('<') || raw.includes('>')) { errors.push(`${at(key)} still contains a placeholder value`); continue }
    if (key === 'd1DatabaseId') {
      if (raw === ZERO_UUID || !UUID.test(raw)) errors.push(`${at(key)} must be a non-zero UUID`)
    } else if (key === 'workerBaseUrl') {
      let url
      try { url = new URL(raw) } catch { errors.push(`${at(key)} must be an absolute URL`); continue }
      if (url.protocol !== 'https:') errors.push(`${at(key)} must use HTTPS`)
      if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) errors.push(`${at(key)} must be an HTTPS origin without credentials, path, query or fragment`)
    } else if (key === 'firebaseClientEmail') {
      if (!SERVICE_ACCOUNT_EMAIL.test(raw)) errors.push(`${at(key)} must be a service account email address`)
    } else if (!IDENTIFIER.test(raw)) {
      errors.push(`${at(key)} must match ${IDENTIFIER}`)
    }
  }
  if (value.setupAuthorityActorId && value.setupAuthorityActorId === value.operatorAuthorityActorId) {
    errors.push(`${at('operatorAuthorityActorId')} must differ from ${at('setupAuthorityActorId')}`)
  }
  return { errors }
}

export function readInputs(inputsPath = DEFAULT_INPUTS_PATH) {
  if (!existsSync(inputsPath)) throw fail('INVENTORY_MISSING', `local release inventory not found at ${inputsPath}`)
  try { return JSON.parse(readFileSync(inputsPath, 'utf8')) } catch (error) { throw fail('INVENTORY_INVALID', `local release inventory is not valid JSON: ${error.message}`) }
}

export function environmentInput(env, inputsPath = DEFAULT_INPUTS_PATH) {
  validateEnvironmentName(env)
  const inputs = readInputs(inputsPath)
  const section = inputs?.[env]
  const { errors } = validateEnvironmentInput(env, section)
  if (errors.length > 0) throw fail('INVENTORY_INVALID', errors.join('; '))
  return section
}

export function renderTemplate(values, templatePath = TEMPLATE_PATH) {
  const template = readFileSync(templatePath, 'utf8')
  const rendered = template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, key) => {
    const value = values[key]
    if (typeof value !== 'string') throw fail('TEMPLATE_UNRESOLVED', `template placeholder \${${key}} has no value`)
    return value
  })
  if (rendered.includes('${')) throw fail('TEMPLATE_UNRESOLVED', 'rendered config still contains an unresolved placeholder')
  for (const secret of REQUIRED_SECRET_NAMES) {
    if (new RegExp(`^\\s*${secret}\\s*=`, 'm').test(rendered)) throw fail('SECRET_IN_CONFIG', `${secret} must never be rendered into the config`)
  }
  return rendered
}

export function renderedPath(env) { return join(RENDERED_DIR, `${validateEnvironmentName(env)}.toml`) }

export function renderConfig({ env, inputsPath = DEFAULT_INPUTS_PATH, outputPath = renderedPath(env), templatePath = TEMPLATE_PATH } = {}) {
  if (!env) throw fail('BAD_ARGUMENT', '--env is required')
  const values = environmentInput(env, inputsPath)
  const contents = renderTemplate(values, templatePath)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, contents, 'utf8')
  return { env, outputPath, contents, requiredSecretNames: [...REQUIRED_SECRET_NAMES] }
}

export function validateRenderedConfig({ env, inputsPath = DEFAULT_INPUTS_PATH, outputPath = renderedPath(env), templatePath = TEMPLATE_PATH } = {}) {
  if (!env) throw fail('BAD_ARGUMENT', '--env is required')
  const values = environmentInput(env, inputsPath)
  if (!existsSync(outputPath)) throw fail('CONFIG_MISSING', `render the config first: npm run remote:config:render -- --env ${env}`)
  const expected = renderTemplate(values, templatePath)
  const actual = readFileSync(outputPath, 'utf8')
  if (expected !== actual) throw fail('CONFIG_DRIFT', `${outputPath} does not match the current inventory; re-render it`)
  return {
    ok: true,
    env,
    outputPath,
    workerName: values.workerName,
    workerBaseUrl: values.workerBaseUrl,
    d1DatabaseName: values.d1DatabaseName,
    requiredSecretNames: [...REQUIRED_SECRET_NAMES],
    secretValuesRead: false,
  }
}

/** Deployment preflight checks secret names through Wrangler without reading values. */
export async function validateDeploymentPreflight(options = {}, { runner = runWrangler } = {}) {
  const report = validateRenderedConfig(options)
  const result = await runner(['secret', 'list', '--config', report.outputPath, '--format', 'json'])
  let rows
  try { rows = JSON.parse(result.stdout) } catch (error) { throw fail('SECRET_LIST_INVALID', `Wrangler returned invalid secret metadata: ${error.message}`) }
  if (!Array.isArray(rows)) throw fail('SECRET_LIST_INVALID', 'Wrangler secret metadata must be an array')
  const present = new Set(rows.map((row) => row?.name).filter((name) => typeof name === 'string'))
  const missing = REQUIRED_SECRET_NAMES.filter((name) => !present.has(name))
  if (missing.length > 0) throw fail('SECRETS_MISSING', `configure Worker secrets before deployment: ${missing.join(', ')}`)
  return { ...report, requiredSecretsPresent: true }
}

/** Environment view used by every operator tool: identifiers plus the rendered config path. */
export function resolveEnvironment(env, { inputsPath = DEFAULT_INPUTS_PATH, outputPath = renderedPath(env) } = {}) {
  const values = environmentInput(env, inputsPath)
  return { env, ...values, configPath: resolve(outputPath) }
}
