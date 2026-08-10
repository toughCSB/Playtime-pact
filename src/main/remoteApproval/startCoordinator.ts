import { randomUUID } from 'node:crypto'
import { claimFirstMatchingProcess, isRemoteApprovalGrantActive, remoteApprovalScopeMatches, remoteApprovalTuplesMatch } from '../../shared/remoteApproval'
import type { MemoryOnlyLocalPreauthorization, ProtectedAccountingScope, RemoteApprovalGrant, RemoteApprovalPermissionTuple } from '../../shared/types'
import { RemoteApprovalApiClient, RemoteApprovalClientError } from './apiClient'

export type TrustedProcess = { gameId: string; processId: string; processStartedAt: number }
export type RemoteConsumeResult = 'started' | 'indeterminate' | 'denied'
type FinalRecheck = (input: { permission: RemoteApprovalPermissionTuple; approvedMinutes: number; source: 'remote' | 'local' }) => Promise<boolean> | boolean
type TimerStarter = (approvedMinutes: number) => Promise<boolean> | boolean
type ProtectedAccounting = {
  reservePreauthorization(receipt: string, minutes: number, scope?: ProtectedAccountingScope, expiresAt?: number): Promise<void>
  authorizeTimerStart(receipt: string, minutes: number, scope?: ProtectedAccountingScope): Promise<void>
  recordTimerOutcome(receipt: string, minutes: number, started: boolean, scope?: ProtectedAccountingScope): Promise<void>
}

/** Main-process-only authority. It never launches games; it starts a timer only for an observed process. */
export class RemoteStartCoordinator {
  private queues = new Map<string, Promise<unknown>>()
  private localPreauthorization: MemoryOnlyLocalPreauthorization | null = null
  private localCandidateFloor: number | null = null
  private remoteConsumes = new Map<string, { state: 'pending' | 'indeterminate' | 'confirmed-not-started' | 'started'; idempotencyKey: string; permission: RemoteApprovalPermissionTuple; claimedGrant: RemoteApprovalGrant }>()
  private lastAuthoritativeNow = -Infinity

  constructor(private readonly api: RemoteApprovalApiClient | null, private readonly finalRecheck: FinalRecheck, private readonly startTimer: TimerStarter, private readonly accounting: ProtectedAccounting | null, private readonly now: () => number, private readonly scopeFor: (permission: RemoteApprovalPermissionTuple) => ProtectedAccountingScope) {}
  private authoritativeNow(): number | null {
    const value = this.now()
    if (!Number.isFinite(value) || value < this.lastAuthoritativeNow) return null
    this.lastAuthoritativeNow = value
    return value
  }

  async issueLocalPreauthorization(input: Omit<MemoryOnlyLocalPreauthorization, 'grantId' | 'claimed'>, minutes: number): Promise<MemoryOnlyLocalPreauthorization> {
    const issuedAt = this.authoritativeNow()
    if (issuedAt === null || !this.accounting) throw new RemoteApprovalClientError('failed')
    const grant = {
      ...input,
      permission: { ...input.permission, processStartedAt: input.permission.processStartedAt },
      grantId: randomUUID(),
      claimed: false,
    }
    await this.accounting.reservePreauthorization(this.receipt(grant.permission), minutes, this.scopeFor(grant.permission), grant.expiresAt)
    this.localCandidateFloor = issuedAt
    this.localPreauthorization = grant
    return { ...grant, permission: { ...grant.permission } }
  }
  clearLocalPreauthorization(): void { this.localPreauthorization = null; this.localCandidateFloor = null }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(key, next)
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) })
    return next
  }
  private receipt(permission: RemoteApprovalPermissionTuple): string {
    return `timer:${permission.householdId}:${permission.requestId}`
  }
  private async finalize(permission: RemoteApprovalPermissionTuple, minutes: number, source: 'remote' | 'local'): Promise<boolean> {
    if (!this.accounting || !(await this.finalRecheck({ permission, approvedMinutes: minutes, source }))) return false
    const receipt = this.receipt(permission)
    try {
      await this.accounting.authorizeTimerStart(receipt, minutes, this.scopeFor(permission))
      const started = await this.startTimer(minutes)
      await this.accounting.recordTimerOutcome(receipt, minutes, started, this.scopeFor(permission))
      return started
    } catch {
      try { await this.accounting.recordTimerOutcome(receipt, minutes, false, this.scopeFor(permission)) } catch {}
      return false
    }
  }
  startPolicyAuthorized(trustedProcess: TrustedProcess, minutes: number): Promise<boolean> {
    const permission: RemoteApprovalPermissionTuple = {
      householdId: 'policy', requestId: `policy-${trustedProcess.processId}-${trustedProcess.processStartedAt}`,
      pcId: 'policy', gameId: trustedProcess.gameId, allowanceVersion: 1,
      processId: trustedProcess.processId, processStartedAt: trustedProcess.processStartedAt,
    }
    return this.serial(`policy:${permission.processId}:${permission.processStartedAt}`, () => this.finalize(permission, minutes, 'local'))
  }

  consumeRemoteGrant(grant: RemoteApprovalGrant, trustedProcess: TrustedProcess, membershipEpoch: number, serviceEpoch: number): Promise<RemoteConsumeResult> {
    const permission: RemoteApprovalPermissionTuple = { householdId: grant.householdId, requestId: grant.requestId, pcId: grant.pcId, gameId: grant.gameId, allowanceVersion: grant.allowanceVersion, processId: trustedProcess.processId, processStartedAt: trustedProcess.processStartedAt }
    const claimedGrant: RemoteApprovalGrant = { ...grant, processId: permission.processId, processStartedAt: permission.processStartedAt }
    return this.serial(`remote:${grant.grantId}`, async () => {
      const serverNow = this.authoritativeNow()
      if (!this.api || serverNow === null || grant.gameId !== trustedProcess.gameId || !remoteApprovalScopeMatches(grant, permission) || !isRemoteApprovalGrantActive(grant, serverNow, membershipEpoch, serviceEpoch)) return 'denied'
      const current = this.remoteConsumes.get(grant.grantId)
      if (current?.state === 'started') return 'denied'
      if (current && !remoteApprovalTuplesMatch(current.permission, permission)) return 'denied'
      if (current?.state === 'confirmed-not-started') {
        const started = await this.finalize(permission, grant.approvedMinutes, 'remote')
        if (started) this.remoteConsumes.set(grant.grantId, { ...current, state: 'started' })
        return started ? 'started' : 'denied'
      }
      const idempotencyKey = current?.idempotencyKey ?? `consume-grant:${grant.grantId}`
      const originalClaim = current?.claimedGrant ?? claimedGrant
      this.remoteConsumes.set(grant.grantId, { state: 'pending', idempotencyKey, permission, claimedGrant: originalClaim })
      try {
        const receipt = await this.api.consumeGrant({ grant: originalClaim, accountingScope: this.scopeFor(permission), idempotencyKey })
        const receiptNow = this.authoritativeNow()
        if (receiptNow === null || receipt.grantId !== grant.grantId || !remoteApprovalTuplesMatch(receipt, permission) || !isRemoteApprovalGrantActive(receipt, receiptNow, membershipEpoch, serviceEpoch)) {
          this.remoteConsumes.delete(grant.grantId)
          return 'denied'
        }
        const started = await this.finalize(permission, receipt.approvedMinutes, 'remote')
        this.remoteConsumes.set(grant.grantId, { state: started ? 'started' : 'confirmed-not-started', idempotencyKey, permission, claimedGrant: originalClaim })
        return started ? 'started' : 'denied'
      } catch (error) {
        if (error instanceof RemoteApprovalClientError && ['unavailable', 'offline'].includes(error.code)) {
          this.remoteConsumes.set(grant.grantId, { state: 'indeterminate', idempotencyKey, permission, claimedGrant: originalClaim })
          return 'indeterminate'
        }
        this.remoteConsumes.delete(grant.grantId)
        if (!(error instanceof RemoteApprovalClientError)) throw error
        return 'denied'
      }
    })
  }

  consumeLocalPreauthorization(trustedProcess: TrustedProcess, membershipEpoch: number, serviceEpoch: number, minutes: number): Promise<boolean> {
    const local = this.localPreauthorization
    if (!local) return Promise.resolve(false)
    const permission = { ...local.permission, gameId: trustedProcess.gameId, processId: trustedProcess.processId, processStartedAt: trustedProcess.processStartedAt }
    return this.serial(`local:${local.grantId}`, async () => {
      const armed = this.localPreauthorization
      if (!armed || !armed.bindFirstProcess) return false
      const serverNow = this.authoritativeNow()
      if (serverNow === null || this.localCandidateFloor === null || trustedProcess.processStartedAt <= this.localCandidateFloor) return false
      const result = claimFirstMatchingProcess({ preauthorization: armed, permission, serverTime: serverNow, membershipEpoch, serviceEpoch })
      this.localPreauthorization = result.preauthorization
      if (result.claimed) this.localCandidateFloor = null
      if (!result.claimed) {
        if (serverNow >= armed.expiresAt) {
          try { await this.accounting?.recordTimerOutcome(this.receipt(armed.permission), minutes, false, this.scopeFor(armed.permission)) } catch {}
          this.clearLocalPreauthorization()
        }
        return false
      }
      return this.finalize(permission, minutes, 'local')
    })
  }
}
