import type {
  FirstProcessClaimInput,
  FirstProcessClaimResult,
  MemoryOnlyLocalPreauthorization,
  RemoteApprovalGrant,
  RemoteApprovalPermissionTuple,
  RemoteApprovalRequest,
} from './types'

export const REMOTE_APPROVAL_TTL_MS = 300000
export const DEFAULT_REMOTE_APPROVAL_MINUTES = 20
export const REMOTE_APPROVAL_MINUTE_PRESETS = [10, 20, 30, 40, 50, 60] as const

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isPositiveEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function isRemoteApprovalPermissionTuple(value: unknown): value is RemoteApprovalPermissionTuple {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const tuple = value as RemoteApprovalPermissionTuple
  return isOpaqueId(tuple.householdId)
    && isOpaqueId(tuple.requestId)
    && isOpaqueId(tuple.pcId)
    && isOpaqueId(tuple.gameId)
    && Number.isInteger(tuple.allowanceVersion)
    && tuple.allowanceVersion > 0
    && isOpaqueId(tuple.processId)
    && isFiniteTimestamp(tuple.processStartedAt)
}

export function remoteApprovalTuplesMatch(
  left: RemoteApprovalPermissionTuple,
  right: RemoteApprovalPermissionTuple,
): boolean {
  return left.householdId === right.householdId
    && left.requestId === right.requestId
    && left.pcId === right.pcId
    && left.gameId === right.gameId
    && left.allowanceVersion === right.allowanceVersion
    && left.processId === right.processId
    && left.processStartedAt === right.processStartedAt
}

export function remoteApprovalScopeMatches(left: RemoteApprovalPermissionTuple, right: RemoteApprovalPermissionTuple): boolean {
  return left.householdId === right.householdId
    && left.requestId === right.requestId
    && left.pcId === right.pcId
    && left.gameId === right.gameId
    && left.allowanceVersion === right.allowanceVersion
}

export function remoteApprovalEpochsMatch(
  membershipEpoch: number,
  serviceEpoch: number,
  expectedMembershipEpoch: number,
  expectedServiceEpoch: number,
): boolean {
  return isPositiveEpoch(membershipEpoch)
    && isPositiveEpoch(serviceEpoch)
    && membershipEpoch === expectedMembershipEpoch
    && serviceEpoch === expectedServiceEpoch
}

export function isRemoteApprovalRequest(value: unknown): value is RemoteApprovalRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const request = value as RemoteApprovalRequest
  return isRemoteApprovalPermissionTuple(request)
    && isPositiveEpoch(request.membershipEpoch)
    && isPositiveEpoch(request.serviceEpoch)
    && isFiniteTimestamp(request.requestedAt)
    && request.expiresAt === request.requestedAt + REMOTE_APPROVAL_TTL_MS
}

export function isRemoteApprovalGrant(value: unknown): value is RemoteApprovalGrant {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const grant = value as RemoteApprovalGrant
  return isOpaqueId(grant.grantId)
    && isOpaqueId(grant.allowanceReservationId)
    && isRemoteApprovalPermissionTuple(grant)
    && isPositiveEpoch(grant.membershipEpoch)
    && isPositiveEpoch(grant.serviceEpoch)
    && isValidRemoteApprovalMinutes(grant.approvedMinutes)
    && isFiniteTimestamp(grant.grantedAt)
    && grant.expiresAt === grant.grantedAt + REMOTE_APPROVAL_TTL_MS
    && grant.launchGame === false
}

export function isRemoteApprovalRequestExpired(request: RemoteApprovalRequest, serverTime: number): boolean {
  return serverTime >= request.expiresAt
}

export function isRemoteApprovalGrantExpired(grant: RemoteApprovalGrant, serverTime: number): boolean {
  return serverTime >= grant.expiresAt
}

export function isRemoteApprovalRequestActive(
  request: RemoteApprovalRequest,
  serverTime: number,
  membershipEpoch: number,
  serviceEpoch: number,
): boolean {
  return isRemoteApprovalRequest(request)
    && remoteApprovalEpochsMatch(
      request.membershipEpoch,
      request.serviceEpoch,
      membershipEpoch,
      serviceEpoch,
    )
    && !isRemoteApprovalRequestExpired(request, serverTime)
}

export function isRemoteApprovalGrantActive(
  grant: RemoteApprovalGrant,
  serverTime: number,
  membershipEpoch: number,
  serviceEpoch: number,
): boolean {
  return isRemoteApprovalGrant(grant)
    && remoteApprovalEpochsMatch(
      grant.membershipEpoch,
      grant.serviceEpoch,
      membershipEpoch,
      serviceEpoch,
    )
    && !isRemoteApprovalGrantExpired(grant, serverTime)
}

export function isRemoteApprovalPreset(minutes: number): boolean {
  return REMOTE_APPROVAL_MINUTE_PRESETS.includes(minutes as typeof REMOTE_APPROVAL_MINUTE_PRESETS[number])
}

export function isValidRemoteApprovalMinutes(minutes: unknown): minutes is number {
  return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 240
}

export function normalizeRemoteApprovalMinutes(minutes?: number): number | undefined {
  const resolvedMinutes = minutes === undefined ? DEFAULT_REMOTE_APPROVAL_MINUTES : minutes
  return isValidRemoteApprovalMinutes(resolvedMinutes) ? resolvedMinutes : undefined
}

export function shouldAutomaticallyLaunchRemoteApprovedGame(): false {
  return false
}

export function claimFirstMatchingProcess(input: FirstProcessClaimInput): FirstProcessClaimResult {
  const { preauthorization, permission, serverTime, membershipEpoch, serviceEpoch } = input
  const canClaim = !preauthorization.claimed
    && isRemoteApprovalPermissionTuple(preauthorization.permission)
    && (preauthorization.bindFirstProcess
      ? remoteApprovalScopeMatches(preauthorization.permission, permission)
      : remoteApprovalTuplesMatch(preauthorization.permission, permission))
    && remoteApprovalEpochsMatch(
      preauthorization.membershipEpoch,
      preauthorization.serviceEpoch,
      membershipEpoch,
      serviceEpoch,
    )
    && isFiniteTimestamp(serverTime)
    && serverTime < preauthorization.expiresAt

  if (!canClaim) {
    return { claimed: false, preauthorization }
  }

  const claimedPreauthorization: MemoryOnlyLocalPreauthorization = {
    ...preauthorization,
    permission: preauthorization.bindFirstProcess ? { ...permission } : preauthorization.permission,
    claimed: true,
  }
  return { claimed: true, preauthorization: claimedPreauthorization }
}
