import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: harness.execFileSync,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    existsSync: harness.existsSync,
    mkdirSync: harness.mkdirSync,
    readFileSync: harness.readFileSync,
    writeFileSync: harness.writeFileSync,
  }
})

import { readAdminPasswordHash, verifyAdminPassword, writeAdminPasswordPin } from '../src/main/fileStore'

const accessDenied = () => Object.assign(new Error('access denied'), { code: 'EACCES' })

beforeEach(() => {
  harness.execFileSync.mockReset()
  harness.existsSync.mockReset().mockReturnValue(false)
  harness.mkdirSync.mockReset()
  harness.readFileSync.mockReset().mockImplementation(() => {
    throw accessDenied()
  })
  harness.writeFileSync.mockReset().mockImplementation(() => {
    throw accessDenied()
  })
})

describe('standard-account admin secret access', () => {
  it('does not request elevation when settings read cannot access the protected secret', () => {
    // Given: the standard account cannot inspect the protected Admin directory.

    // When: normal settings loading requests the compatibility hash.
    const hash = readAdminPasswordHash()

    // Then: the app stays locked without attempting a write or elevated process.
    expect(hash).toBe('0'.repeat(64))
    expect(harness.writeFileSync).not.toHaveBeenCalled()
    expect(harness.execFileSync).not.toHaveBeenCalled()
  })

  it('fails a denied PIN write without requesting elevation', () => {
    // Given: the standard account cannot write the protected secret.

    // When: a direct client-side PIN write is attempted.
    const write = () => writeAdminPasswordPin('1234')

    // Then: the access error is preserved and no elevated process is created.
    expect(write).toThrow('access denied')
    expect(harness.execFileSync).not.toHaveBeenCalled()
  })

  it('fails closed when PIN verification cannot access the protected secret', () => {
    // Given: the standard account cannot read the protected verifier.

    // When: the local verifier is called without broker access.
    const verified = verifyAdminPassword('0000')

    // Then: verification fails without rewriting the secret or requesting elevation.
    expect(verified).toBe(false)
    expect(harness.writeFileSync).not.toHaveBeenCalled()
    expect(harness.execFileSync).not.toHaveBeenCalled()
  })
})
