import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REMOTE_APPROVAL_MINUTES,
  REMOTE_APPROVAL_TTL_MS,
  claimFirstMatchingProcess,
  isRemoteApprovalGrantActive,
  isRemoteApprovalGrantExpired,
  isRemoteApprovalPreset,
  isRemoteApprovalRequestActive,
  isRemoteApprovalRequestExpired,
  normalizeRemoteApprovalMinutes,
  remoteApprovalTuplesMatch,
  shouldAutomaticallyLaunchRemoteApprovedGame,
} from '../src/shared/remoteApproval'

const requestedAt = 1_000_000
const permission = {
  householdId: 'household-1',
  requestId: 'request-1',
  pcId: 'pc-1',
  gameId: 'roblox-place-1',
  allowanceVersion: 7,
  processId: 'process-1',
  processStartedAt: 999_000,
}

function createRequest() {
  return {
    ...permission,
    membershipEpoch: 3,
    serviceEpoch: 4,
    requestedAt,
    expiresAt: requestedAt + REMOTE_APPROVAL_TTL_MS,
  }
}

function createGrant() {
  return {
    ...permission,
    grantId: 'grant-1',
    allowanceReservationId: 'reservation-1',
    membershipEpoch: 3,
    serviceEpoch: 4,
    approvedMinutes: 20,
    grantedAt: requestedAt,
    expiresAt: requestedAt + REMOTE_APPROVAL_TTL_MS,
    launchGame: false,
  }
}

describe('remote approval contracts', () => {
  it('uses server time and an exclusive five-minute expiry boundary for requests and grants', () => {
    const request = createRequest()
    const grant = createGrant()

    expect(REMOTE_APPROVAL_TTL_MS).toBe(300000)
    expect(isRemoteApprovalRequestExpired(request, requestedAt + 299999)).toBe(false)
    expect(isRemoteApprovalRequestExpired(request, requestedAt + 300000)).toBe(true)
    expect(isRemoteApprovalRequestExpired(request, requestedAt + 300001)).toBe(true)
    expect(isRemoteApprovalGrantExpired(grant, requestedAt + 299999)).toBe(false)
    expect(isRemoteApprovalGrantExpired(grant, requestedAt + 300000)).toBe(true)
    expect(isRemoteApprovalGrantExpired(grant, requestedAt + 300001)).toBe(true)
  })

  it('rejects mismatched process permission tuples and stale epochs', () => {
    const request = createRequest()
    const grant = createGrant()
    const anotherProcess = { ...permission, processId: 'process-2' }

    expect(remoteApprovalTuplesMatch(permission, anotherProcess)).toBe(false)
    expect(isRemoteApprovalRequestActive(request, requestedAt, 4, 4)).toBe(false)
    expect(isRemoteApprovalGrantActive(grant, requestedAt, 3, 5)).toBe(false)
    expect(isRemoteApprovalRequestActive(request, requestedAt, 3, 4)).toBe(true)
    expect(isRemoteApprovalGrantActive(grant, requestedAt, 3, 4)).toBe(true)
  })

  it('accepts presets and valid manual approval minutes while defaulting to twenty', () => {
    expect(DEFAULT_REMOTE_APPROVAL_MINUTES).toBe(20)
    expect([10, 20, 30, 40, 50, 60].every(isRemoteApprovalPreset)).toBe(true)
    expect(isRemoteApprovalPreset(25)).toBe(false)
    expect(normalizeRemoteApprovalMinutes()).toBe(20)
    expect(normalizeRemoteApprovalMinutes(1)).toBe(1)
    expect(normalizeRemoteApprovalMinutes(240)).toBe(240)
    expect(normalizeRemoteApprovalMinutes(25)).toBe(25)
    expect(normalizeRemoteApprovalMinutes(0)).toBeUndefined()
    expect(normalizeRemoteApprovalMinutes(241)).toBeUndefined()
    expect(normalizeRemoteApprovalMinutes(1.5)).toBeUndefined()
  })

  it('never automatically launches a game after remote approval', () => {
    expect(shouldAutomaticallyLaunchRemoteApprovedGame()).toBe(false)
  })

  it('claims only the first matching unexpired process without mutating the original preauthorization', () => {
    const preauthorization = {
      grantId: 'grant-1',
      permission,
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 2,
      issuedAt: requestedAt,
      expiresAt: requestedAt + REMOTE_APPROVAL_TTL_MS,
      state: 'armed',
      claimed: false,
    }
    const mismatch = claimFirstMatchingProcess({
      preauthorization,
      permission: { ...permission, processStartedAt: permission.processStartedAt + 1 },
      serverTime: requestedAt,
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 2,
    })
    const staleGeneration = claimFirstMatchingProcess({
      preauthorization,
      permission,
      serverTime: requestedAt,
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 3,
    })
    const claim = claimFirstMatchingProcess({
      preauthorization,
      permission,
      serverTime: requestedAt,
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 2,
    })
    const secondClaim = claimFirstMatchingProcess({
      preauthorization: claim.preauthorization,
      permission,
      serverTime: requestedAt,
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 2,
    })

    expect(mismatch.claimed).toBe(false)
    expect(staleGeneration.claimed).toBe(false)
    expect(preauthorization.claimed).toBe(false)
    expect(claim.claimed).toBe(true)
    expect(claim.preauthorization.claimed).toBe(true)
    expect(secondClaim.claimed).toBe(false)
  })
  it('binds an outage PIN preauthorization to exactly the first matching relaunch process', () => {
    const preauthorization = {
      grantId: 'local-1',
      permission: { ...permission, processId: 'pending-relaunch', processStartedAt: requestedAt },
      membershipEpoch: 3,
      serviceEpoch: 4,
      authorityGeneration: 2,
      issuedAt: requestedAt,
      expiresAt: requestedAt + REMOTE_APPROVAL_TTL_MS,
      state: 'armed',
      claimed: false,
      bindFirstProcess: true,
    }
    const relaunched = { ...permission, processId: 'relaunched-process', processStartedAt: requestedAt + 100 }
    const claim = claimFirstMatchingProcess({ preauthorization, permission: relaunched, serverTime: requestedAt + 100, membershipEpoch: 3, serviceEpoch: 4, authorityGeneration: 2 })
    expect(claim.claimed).toBe(true)
    expect(claim.preauthorization.permission).toEqual(relaunched)
    expect(claimFirstMatchingProcess({ preauthorization: claim.preauthorization, permission: { ...relaunched, processId: 'second' }, serverTime: requestedAt + 101, membershipEpoch: 3, serviceEpoch: 4, authorityGeneration: 2 }).claimed).toBe(false)
  })
})
