import { describe, expect, it } from 'vitest'

import {
  classifyWindowsPipeOpenError,
  formatPrivilegedHealthDiagnostic,
  privilegedHealthFailure,
} from '../src/main/remoteApproval/privilegedHealthDiagnostic'

describe('privileged health diagnostic contract', () => {
  it.each([
    [5, 'PIPE_ACCESS_DENIED'],
    [2, 'PIPE_UNAVAILABLE'],
    [3, 'PIPE_UNAVAILABLE'],
    [231, 'PIPE_UNAVAILABLE'],
    [87, 'PIPE_OPEN_FAILED'],
    [undefined, 'PIPE_OPEN_FAILED'],
  ])('classifies Windows pipe-open error %s without emitting native details', (win32Error, code) => {
    expect(classifyWindowsPipeOpenError(win32Error)).toBe(code)
  })

  it('emits one stable allowlisted stderr record and no source error details', () => {
    const error = privilegedHealthFailure(
      'scm-lineage',
      'SCM_LINEAGE_MISMATCH',
      'secret token at C:\\Users\\Child\\config.json',
    )
    Object.assign(error, { payload: { token: 'secret' }, stack: 'private stack' })

    expect(formatPrivilegedHealthDiagnostic(error)).toBe(
      'PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=scm-lineage code=SCM_LINEAGE_MISMATCH\n',
    )
  })

  it('fails arbitrary or spoofed errors into a constant diagnostic', () => {
    expect(formatPrivilegedHealthDiagnostic(new Error('C:\\private\\path token=secret'))).toBe(
      'PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=runtime-ready code=RUNTIME_INIT_FAILED\n',
    )
    expect(formatPrivilegedHealthDiagnostic({
      privilegedHealthStage: 'path=C:\\private',
      privilegedHealthCode: 'TOKEN_secret',
    })).toBe('PLAYTIME_PACT_PRIVILEGED_HEALTH_V1 stage=runtime-ready code=RUNTIME_INIT_FAILED\n')
  })
})
