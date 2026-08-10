import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createAdminPasswordSecret, verifyAdminPasswordSecret } from '../src/main/fileStore'

describe('admin PIN secret hardening', () => {
  it('stores new PIN verifiers as salted stretched PBKDF2 secrets', () => {
    const secret = createAdminPasswordSecret('0000')

    expect(secret.schemaVersion).toBe(1)
    expect(secret.algorithm).toBe('pbkdf2-sha256')
    expect(secret.iterations).toBe(1_500_000)
    expect(secret.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(secret.salt).not.toBe('')
    expect(verifyAdminPasswordSecret(secret, '0000')).toEqual({ ok: true, needsMigration: false })
    expect(verifyAdminPasswordSecret(secret, '9999')).toEqual({ ok: false, needsMigration: false })
  })

  it('still accepts legacy SHA-256 verifiers but flags them for migration', () => {
    const legacySecret = {
      adminPasswordHash: createHash('sha256').update('1234').digest('hex'),
    }

    expect(verifyAdminPasswordSecret(legacySecret, '1234')).toEqual({ ok: true, needsMigration: true })
    expect(verifyAdminPasswordSecret(legacySecret, '0000')).toEqual({ ok: false, needsMigration: true })
  })
})
