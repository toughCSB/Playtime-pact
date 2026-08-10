import type { PairingSession, ParentDevice, ProtectedAccountingScope, RemoteApprovalGrant, RemoteApprovalHealth, RemoteApprovalRequest } from '../../shared/types'
import { isRemoteApprovalGrant, isRemoteApprovalRequest, remoteApprovalTuplesMatch } from '../../shared/remoteApproval'

export type RemoteApprovalOperation =
  | 'create-request'
  | 'consume-grant'
  | 'read-status'
  | 'pair-parent'
  | 'revoke-parent'
  | 'reset-household'
  | 'delete-household'
  | 'reconcile-reset'
  | 'reconcile-delete'

export interface BrokerSignedProofOperations {
  invoke<T>(input: { operation: RemoteApprovalOperation; payload: Record<string, unknown>; idempotencyKey: string }): Promise<T>
  updateMembership?(membership: { membershipEpoch: number; serviceEpoch: number }): void
  disable?(): void
}

export class RemoteApprovalClientError extends Error {
  constructor(public readonly code: 'offline' | 'epoch-mismatch' | 'permission-denied' | 'unavailable' | 'invalid-response' | 'failed') {
    super(code === 'failed' ? 'Remote approval service failed' : `Remote approval ${code}`)
  }
}

function opaqueId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function sameRequestTuple(result: RemoteApprovalRequest, expected: RemoteApprovalRequest): boolean {
  return result.householdId === expected.householdId
    && result.requestId === expected.requestId
    && result.pcId === expected.pcId
    && result.gameId === expected.gameId
    && result.allowanceVersion === expected.allowanceVersion
    && result.processId === expected.processId
    && result.processStartedAt === expected.processStartedAt
    && result.membershipEpoch === expected.membershipEpoch
    && result.serviceEpoch === expected.serviceEpoch
}
function retryable(error: unknown): boolean {
  const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code === 'UNAVAILABLE' || code === 'DEPENDENCY_UNAVAILABLE' || code === 'HTTP_503'
}
function redact(error: unknown): RemoteApprovalClientError {
  const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
  if (code === 'EPOCH_MISMATCH' || code === 'STALE_EPOCH') return new RemoteApprovalClientError('epoch-mismatch')
  if (code === 'PERMISSION_DENIED' || code === 'FORBIDDEN' || code === 'AUTH_REQUIRED') return new RemoteApprovalClientError('permission-denied')
  if (code === 'OFFLINE') return new RemoteApprovalClientError('offline')
  if (retryable(error)) return new RemoteApprovalClientError('unavailable')
  return new RemoteApprovalClientError('failed')
}

export class RemoteApprovalApiClient {
  constructor(private readonly broker: BrokerSignedProofOperations, private readonly retries = 2) {}

  private async call<T>(operation: RemoteApprovalOperation, payload: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    if (!opaqueId(idempotencyKey)) throw new RemoteApprovalClientError('failed')
    for (let attempt = 0; ; attempt++) {
      try { return await this.broker.invoke<T>({ operation, payload, idempotencyKey }) } catch (error) {
        if (!retryable(error) || attempt >= this.retries) throw redact(error)
      }
    }
  }

  async createRequest(request: RemoteApprovalRequest, idempotencyKey: string): Promise<RemoteApprovalRequest> {
    const result = await this.call<{ v?: unknown; request?: unknown }>('create-request', { request }, idempotencyKey)
    if (result.v !== 1 || !isRemoteApprovalRequest(result.request) || !sameRequestTuple(result.request, request)) {
      throw new RemoteApprovalClientError('invalid-response')
    }
    return result.request
  }

  async consumeGrant(input: { grant: RemoteApprovalGrant; accountingScope: ProtectedAccountingScope; idempotencyKey: string }): Promise<RemoteApprovalGrant> {
    const result = await this.call<{ v?: unknown; grant?: unknown }>('consume-grant', { grant: input.grant, accountingScope: input.accountingScope }, input.idempotencyKey)
    if (result.v !== 1 || !isRemoteApprovalGrant(result.grant) || !remoteApprovalTuplesMatch(result.grant, input.grant)
      || result.grant.grantId !== input.grant.grantId
      || result.grant.allowanceReservationId !== input.grant.allowanceReservationId
      || result.grant.approvedMinutes !== input.grant.approvedMinutes
      || result.grant.launchGame !== false) {
      throw new RemoteApprovalClientError('invalid-response')
    }
    return result.grant
  }

  readStatus(input: { householdId: string; pcId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<{ serverNowMs: number; request?: RemoteApprovalRequest; grant?: RemoteApprovalGrant; parentDevices?: ParentDevice[]; allowance?: { pcId: string; gameId: string; ianaTimeZone: string; ianaDay: string; allowanceVersion: number; totalSeconds: number; committedSeconds: number; reservedSeconds: number }; health: RemoteApprovalHealth }> {
    return this.call('read-status', input, input.idempotencyKey)
  }

  async createPairingSession(input: { householdId: string; pcId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<PairingSession & { uri: string }> {
    const result = await this.call<Record<string, unknown>>('pair-parent', input, input.idempotencyKey)
    const pairingSessionId = String(result.pairing_session_id ?? '')
    const token = String(result.token ?? '')
    const createdAt = Number(result.created_at_ms)
    const expiresAt = Number(result.expires_at_ms)
    if (result.operation !== 'issuePairing' || !opaqueId(pairingSessionId) || !/^[A-Za-z0-9_-]{43,128}$/.test(token)
      || !Number.isFinite(createdAt) || expiresAt !== createdAt + 300000) throw new RemoteApprovalClientError('invalid-response')
    const baseUrl = String(result.base_url ?? '')
    const uri = new URL('playtimepact://pair')
    for (const [key, value] of Object.entries({
      baseUrl,
      householdId: input.householdId,
      parentId: pairingSessionId,
      token,
      membershipEpoch: String(input.membershipEpoch),
      serviceEpoch: String(input.serviceEpoch),
    })) uri.searchParams.set(key, value)
    return { pairingSessionId, householdId: input.householdId, pcId: input.pcId, membershipEpoch: input.membershipEpoch, serviceEpoch: input.serviceEpoch, createdAt, expiresAt, state: 'pending', uri: uri.toString() }
  }

  async revokeParent(input: { householdId: string; parentDeviceId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<void> {
    const result = await this.call<Record<string, unknown>>('revoke-parent', input, input.idempotencyKey)
    if (result.operation !== 'revokeParent' || result.household_id !== input.householdId || result.parent_id !== input.parentDeviceId) throw new RemoteApprovalClientError('invalid-response')
  }
  async resetMembership(input: { householdId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<{ membershipEpoch: number; serviceEpoch: number }> {
    const result = await this.call<Record<string, unknown>>('reset-household', input, input.idempotencyKey)
    const membershipEpoch = Number(result.membership_epoch)
    const serviceEpoch = Number(result.service_epoch)
    if (result.operation !== 'reset' || !Number.isInteger(membershipEpoch) || membershipEpoch !== input.membershipEpoch + 1
      || !Number.isInteger(serviceEpoch) || serviceEpoch !== input.serviceEpoch) throw new RemoteApprovalClientError('invalid-response')
    return { membershipEpoch, serviceEpoch }
  }
  async deleteHousehold(input: { householdId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<void> {
    const result = await this.call<Record<string, unknown>>('delete-household', input, input.idempotencyKey)
    if (result.operation !== 'delete' || result.household_id !== input.householdId) throw new RemoteApprovalClientError('invalid-response')
  }
  async reconcileReset(input: { householdId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<{ membershipEpoch: number; serviceEpoch: number }> {
    const result = await this.call<Record<string, unknown>>('reconcile-reset', input, input.idempotencyKey)
    const membershipEpoch = Number(result.membership_epoch)
    const serviceEpoch = Number(result.service_epoch)
    if (result.operation !== 'reset' || !Number.isInteger(membershipEpoch) || !Number.isInteger(serviceEpoch)) throw new RemoteApprovalClientError('invalid-response')
    return { membershipEpoch, serviceEpoch }
  }
  async reconcileDelete(input: { householdId: string; membershipEpoch: number; serviceEpoch: number; idempotencyKey: string }): Promise<boolean> {
    const result = await this.call<Record<string, unknown>>('reconcile-delete', input, input.idempotencyKey)
    if (result.operation !== 'delete' || result.household_id !== input.householdId) throw new RemoteApprovalClientError('invalid-response')
    return true
  }
  persistMembership(membership: { membershipEpoch: number; serviceEpoch: number }): void { this.broker.updateMembership?.(membership) }
  persistDisable(): void { this.broker.disable?.() }
}
