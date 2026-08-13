const PREFIX = 'PLAYTIME_PACT_PRIVILEGED_HEALTH_V1'

export const PRIVILEGED_HEALTH_STAGES = [
  'runtime-ready',
  'client-init',
  'pipe-open',
  'server-identity',
  'scm-lineage',
  'request-write',
  'response-read',
  'response-frame',
  'response-binding',
  'service-operation',
  'health-response',
] as const

export const PRIVILEGED_HEALTH_CODES = [
  'RUNTIME_INIT_FAILED',
  'NATIVE_API_UNAVAILABLE',
  'PIPE_ACCESS_DENIED',
  'PIPE_UNAVAILABLE',
  'PIPE_OPEN_FAILED',
  'SERVER_IDENTITY_UNAVAILABLE',
  'SCM_LINEAGE_MISMATCH',
  'REQUEST_WRITE_FAILED',
  'RESPONSE_TIMEOUT',
  'RESPONSE_READ_FAILED',
  'RESPONSE_FRAME_INVALID',
  'RESPONSE_NONCE_MISMATCH',
  'OPERATION_DENIED',
  'HEALTH_RESPONSE_INVALID',
  'UNAVAILABLE',
  'OFFLINE',
  'EPOCH_MISMATCH',
  'STALE_EPOCH',
  'PERMISSION_DENIED',
  'FORBIDDEN',
  'AUTH_REQUIRED',
  'DEPENDENCY_UNAVAILABLE',
  'INVALID_RESPONSE',
  'CONFIG_INVALID',
  'CONFIG_UNREADABLE',
] as const

export type PrivilegedHealthStage = typeof PRIVILEGED_HEALTH_STAGES[number]
export type PrivilegedHealthCode = typeof PRIVILEGED_HEALTH_CODES[number]

type PrivilegedHealthFailure = Error & {
  code?: string
  privilegedHealthStage: PrivilegedHealthStage
  privilegedHealthCode: PrivilegedHealthCode
}

const stageSet = new Set<string>(PRIVILEGED_HEALTH_STAGES)
const codeSet = new Set<string>(PRIVILEGED_HEALTH_CODES)

export function privilegedHealthFailure(
  stage: PrivilegedHealthStage,
  code: PrivilegedHealthCode,
  message: string,
  compatibilityCode = 'UNAVAILABLE',
): PrivilegedHealthFailure {
  return Object.assign(new Error(message), {
    code: compatibilityCode,
    privilegedHealthStage: stage,
    privilegedHealthCode: code,
  })
}

export function classifyWindowsPipeOpenError(win32Error: number | undefined): PrivilegedHealthCode {
  if (win32Error === 5) return 'PIPE_ACCESS_DENIED'
  if (win32Error === 2 || win32Error === 3 || win32Error === 231) return 'PIPE_UNAVAILABLE'
  return 'PIPE_OPEN_FAILED'
}

export function formatPrivilegedHealthDiagnostic(error: unknown): string {
  const candidate = typeof error === 'object' && error
    ? error as { privilegedHealthStage?: unknown; privilegedHealthCode?: unknown }
    : {}
  const stage = typeof candidate.privilegedHealthStage === 'string' && stageSet.has(candidate.privilegedHealthStage)
    ? candidate.privilegedHealthStage
    : 'runtime-ready'
  const code = typeof candidate.privilegedHealthCode === 'string' && codeSet.has(candidate.privilegedHealthCode)
    ? candidate.privilegedHealthCode
    : 'RUNTIME_INIT_FAILED'
  return `${PREFIX} stage=${stage} code=${code}\n`
}
