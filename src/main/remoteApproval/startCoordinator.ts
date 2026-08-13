import { randomUUID } from 'node:crypto'
import {
  REMOTE_APPROVAL_TTL_MS,
  claimFirstMatchingProcess,
  isRemoteApprovalGrantActive,
  remoteApprovalAuthoritySnapshotsMatch,
  remoteApprovalScopeMatches,
  remoteApprovalTuplesMatch,
} from '../../shared/remoteApproval'
import type {
  MemoryOnlyLocalPreauthorization,
  ProtectedAccountingScope,
  RemoteApprovalAuthoritySnapshot,
  RemoteApprovalGrant,
  RemoteApprovalPermissionTuple,
} from '../../shared/types'
import { RemoteApprovalApiClient, RemoteApprovalClientError } from './apiClient'

export type TrustedProcess = { gameId: string; processId: string; processStartedAt: number }
export type RemoteConsumeResult = 'started' | 'indeterminate' | 'denied'
type FinalRecheck = (input: { permission: RemoteApprovalPermissionTuple; approvedMinutes: number; source: 'remote' | 'local' }) => Promise<boolean> | boolean
type TimerStarter = (approvedMinutes: number, receipt: string) => Promise<boolean> | boolean
export type TimerStartHandoff = { receipt: string; minutes: number; permission: RemoteApprovalPermissionTuple; authority: RemoteApprovalAuthoritySnapshot; scope: ProtectedAccountingScope }
type ProtectedAccounting = {
  commitTimerStart(handoff: TimerStartHandoff): Promise<void>
  listRecoverableTimerStarts?(): Promise<TimerStartHandoff[]>
  acknowledgeTimerMaterialized?(handoff: TimerStartHandoff): Promise<void>
}
type CapturedOutcome = {
  permission: RemoteApprovalPermissionTuple
  receipt: string
  minutes: number
  scope: ProtectedAccountingScope
  outcomeRecorded: boolean
  pendingOutcome: boolean | null
  authority: RemoteApprovalAuthoritySnapshot
}
type LocalGrantState = CapturedOutcome & {
  preauthorization: MemoryOnlyLocalPreauthorization
  candidateFloor: number
}
type RemoteGrantState = CapturedOutcome & {
  state: 'pending' | 'indeterminate' | 'confirmed-not-started' | 'started' | 'denied'
  idempotencyKey: string
  claimedGrant: RemoteApprovalGrant
}
type FinalizeResult = 'started' | 'retryable' | 'denied'

/** Main-process-only authority. It never launches games; it starts a timer only for an observed process. */
export class RemoteStartCoordinator {
  private queues = new Map<string, Promise<unknown>>()
  private localGrant: LocalGrantState | null = null
  private remoteConsumes = new Map<string, RemoteGrantState>()
  private lastMonotonicNow = -Infinity

  constructor(
    private readonly api: RemoteApprovalApiClient | null,
    private readonly finalRecheck: FinalRecheck,
    private readonly startTimer: TimerStarter,
    private readonly accounting: ProtectedAccounting | null,
    private readonly remoteAuthorityNow: () => number | null,
    private readonly monotonicNow: () => number,
    private readonly currentAuthority: () => RemoteApprovalAuthoritySnapshot | null,
    private readonly scopeFor: (permission: RemoteApprovalPermissionTuple) => ProtectedAccountingScope,
  ) {}

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(key, next)
    const cleanup = () => { if (this.queues.get(key) === next) this.queues.delete(key) }
    void next.then(cleanup, cleanup)
    return next
  }

  private readMonotonicNow(): number | null {
    const value = this.monotonicNow()
    if (!Number.isFinite(value) || value < this.lastMonotonicNow) return null
    this.lastMonotonicNow = value
    return value
  }

  private validAuthority(snapshot: RemoteApprovalAuthoritySnapshot | null | undefined): snapshot is RemoteApprovalAuthoritySnapshot {
    if (!snapshot) return false
    return Number.isInteger(snapshot.membershipEpoch) && snapshot.membershipEpoch > 0
      && Number.isInteger(snapshot.serviceEpoch) && snapshot.serviceEpoch > 0
      && Number.isInteger(snapshot.authorityGeneration) && snapshot.authorityGeneration > 0
  }

  private authorityIsCurrent(snapshot: RemoteApprovalAuthoritySnapshot): boolean {
    return this.validAuthority(snapshot) && remoteApprovalAuthoritySnapshotsMatch(snapshot, this.currentAuthority())
  }

  private receipt(permission: RemoteApprovalPermissionTuple): string {
    return `timer:${permission.householdId}:${permission.requestId}`
  }

  private captureScope(permission: RemoteApprovalPermissionTuple): ProtectedAccountingScope {
    const scope = this.scopeFor(permission)
    if (scope.householdId !== permission.householdId
      || scope.pcId !== permission.pcId
      || scope.gameId !== permission.gameId
      || scope.allowanceVersion !== permission.allowanceVersion) {
      throw new Error('Protected accounting scope mismatch')
    }
    return { ...scope }
  }

  private async materialize(attempt: CapturedOutcome): Promise<boolean> {
    if (!this.accounting) return false
    const handoff = { receipt: attempt.receipt, minutes: attempt.minutes, permission: attempt.permission, authority: attempt.authority, scope: attempt.scope }
    await this.accounting.commitTimerStart(handoff)
    const materialized = await this.startTimer(attempt.minutes, attempt.receipt)
    if (materialized) await this.accounting.acknowledgeTimerMaterialized?.(handoff)
    return materialized
  }

  async recoverCommittedTimerStarts(): Promise<void> {
    for (const handoff of await this.accounting?.listRecoverableTimerStarts?.() ?? []) {
      if (await this.startTimer(handoff.minutes, handoff.receipt)) {
        await this.accounting?.acknowledgeTimerMaterialized?.(handoff)
      }
    }
  }

  private canFinalize(authority: RemoteApprovalAuthoritySnapshot, source: 'remote' | 'local', expiresAt?: number): boolean {
    if (!this.authorityIsCurrent(authority) || expiresAt === undefined) return false
    if (source === 'remote') {
      const now = this.remoteAuthorityNow()
      return now !== null && now < expiresAt
    }
    const now = this.readMonotonicNow()
    return now !== null && now < expiresAt
  }

  private async finalize(
    attempt: CapturedOutcome,
    authority: RemoteApprovalAuthoritySnapshot,
    source: 'remote' | 'local',
    recordRecheckDenial: boolean,
    expiresAt?: number,
  ): Promise<FinalizeResult> {
    if (!this.accounting || !this.canFinalize(authority, source, expiresAt)) return 'denied'
    let permitted: boolean
    try {
      permitted = await this.finalRecheck({ permission: attempt.permission, approvedMinutes: attempt.minutes, source })
    } catch {
      return 'denied'
    }
    if (!this.canFinalize(authority, source, expiresAt)) return 'denied'
    if (!permitted) return recordRecheckDenial ? 'denied' : 'retryable'
    try {
      const started = await this.materialize(attempt)
      return started ? 'started' : 'retryable'
    } catch {
      return 'retryable'
    }
  }

  async issueLocalPreauthorization(
    input: Pick<MemoryOnlyLocalPreauthorization, 'permission' | 'bindFirstProcess'>,
    minutes: number,
  ): Promise<MemoryOnlyLocalPreauthorization> {
    const issuedAt = this.readMonotonicNow()
    const currentAuthority = this.currentAuthority()
    if (issuedAt === null || !this.accounting || !this.validAuthority(currentAuthority) || !this.authorityIsCurrent(currentAuthority) || this.localGrant) {
      throw new RemoteApprovalClientError('failed')
    }
    const capturedAuthority = Object.freeze({ ...currentAuthority })
    const permission = { ...input.permission }
    const expiresAt = issuedAt + REMOTE_APPROVAL_TTL_MS
    if (!Number.isFinite(expiresAt)) throw new RemoteApprovalClientError('failed')
    const preauthorization: MemoryOnlyLocalPreauthorization = {
      grantId: randomUUID(),
      permission,
      membershipEpoch: capturedAuthority.membershipEpoch,
      serviceEpoch: capturedAuthority.serviceEpoch,
      authorityGeneration: capturedAuthority.authorityGeneration,
      issuedAt,
      expiresAt,
      state: 'armed',
      claimed: false,
      bindFirstProcess: input.bindFirstProcess,
    }
    const local: LocalGrantState = {
      preauthorization,
      candidateFloor: permission.processStartedAt,
      permission,
      receipt: this.receipt(permission),
      minutes,
      scope: this.captureScope(permission),
      outcomeRecorded: false,
      pendingOutcome: null,
      authority: capturedAuthority,
    }
    this.localGrant = local
    return this.serial(`local:${preauthorization.grantId}`, async () => {
      const now = this.readMonotonicNow()
      if (this.localGrant !== local || !this.authorityIsCurrent(capturedAuthority) || now === null || now >= expiresAt) {
        if (this.localGrant === local) this.localGrant = null
        throw new RemoteApprovalClientError('failed')
      }
      return { ...preauthorization, permission: { ...preauthorization.permission } }
    })
  }

  invalidateLocalPreauthorization(_reason: string): Promise<void> {
    const local = this.localGrant
    if (!local) return Promise.resolve()
    return this.serial(`local:${local.preauthorization.grantId}`, async () => {
      if (this.localGrant !== local) return
      this.localGrant = null
    })
  }

  consumeLocalPreauthorization(trustedProcess: TrustedProcess, _minutes?: number): Promise<boolean> {
    const local = this.localGrant
    if (!local) return Promise.resolve(false)
    return this.serial(`local:${local.preauthorization.grantId}`, async () => {
      if (this.localGrant !== local || local.preauthorization.state !== 'armed' || !local.preauthorization.bindFirstProcess) return false
      const currentAuthority = this.currentAuthority()
      const now = this.readMonotonicNow()
      if (!this.validAuthority(currentAuthority)
        || !remoteApprovalAuthoritySnapshotsMatch(currentAuthority, local.preauthorization)
        || now === null
        || now >= local.preauthorization.expiresAt) {
        this.localGrant = null
        return false
      }
      if (trustedProcess.processStartedAt <= local.candidateFloor) return false
      const permission = {
        ...local.preauthorization.permission,
        gameId: trustedProcess.gameId,
        processId: trustedProcess.processId,
        processStartedAt: trustedProcess.processStartedAt,
      }
      const claimed = claimFirstMatchingProcess({
        preauthorization: local.preauthorization,
        permission,
        serverTime: now,
        membershipEpoch: currentAuthority.membershipEpoch,
        serviceEpoch: currentAuthority.serviceEpoch,
        authorityGeneration: currentAuthority.authorityGeneration,
      })
      if (!claimed.claimed) return false
      local.preauthorization = claimed.preauthorization
      local.permission = { ...claimed.preauthorization.permission }
      const result = await this.finalize(local, currentAuthority, 'local', true, local.preauthorization.expiresAt)
      if (this.localGrant === local) this.localGrant = null
      return result === 'started'
    })
  }

  startPolicyAuthorized(trustedProcess: TrustedProcess, minutes: number): Promise<boolean> {
    const permission: RemoteApprovalPermissionTuple = {
      householdId: 'policy', requestId: `policy-${trustedProcess.processId}-${trustedProcess.processStartedAt}`,
      pcId: 'policy', gameId: trustedProcess.gameId, allowanceVersion: 1,
      processId: trustedProcess.processId, processStartedAt: trustedProcess.processStartedAt,
    }
    return this.serial(`policy:${permission.processId}:${permission.processStartedAt}`, async () => {
      if (!this.accounting || !(await this.finalRecheck({ permission, approvedMinutes: minutes, source: 'local' }))) return false
      const capturedAuthority = this.currentAuthority()
      if (!this.validAuthority(capturedAuthority)) return false
      const attempt: CapturedOutcome = {
        permission,
        receipt: this.receipt(permission),
        minutes,
        scope: this.captureScope(permission),
        outcomeRecorded: false,
        pendingOutcome: null,
        authority: Object.freeze({ ...capturedAuthority }),
      }
      try { return await this.materialize(attempt) } catch { return false }
    })
  }

  consumeRemoteGrant(
    grant: RemoteApprovalGrant,
    trustedProcess: TrustedProcess,
    capturedAuthority: RemoteApprovalAuthoritySnapshot,
  ): Promise<RemoteConsumeResult> {
    const permission: RemoteApprovalPermissionTuple = {
      householdId: grant.householdId,
      requestId: grant.requestId,
      pcId: grant.pcId,
      gameId: grant.gameId,
      allowanceVersion: grant.allowanceVersion,
      processId: trustedProcess.processId,
      processStartedAt: trustedProcess.processStartedAt,
    }
    const claimedGrant: RemoteApprovalGrant = { ...grant, processId: permission.processId, processStartedAt: permission.processStartedAt }
    return this.serial(`remote:${grant.grantId}`, async () => {
      const current = this.remoteConsumes.get(grant.grantId)
      if (current) {
        if (!remoteApprovalTuplesMatch(current.permission, permission)
          || !remoteApprovalAuthoritySnapshotsMatch(current.authority, capturedAuthority)) return 'denied'
        if (current.state === 'started' || current.state === 'denied') return 'denied'
        if (!this.authorityIsCurrent(current.authority) || this.remoteAuthorityNow() === null) {
          current.state = 'denied'
          return 'denied'
        }
        if (current.state === 'confirmed-not-started') {
          const result = await this.finalize(current, current.authority, 'remote', false, current.claimedGrant.expiresAt)
          current.state = result === 'started' ? 'started' : result === 'retryable' ? 'confirmed-not-started' : 'denied'
          return result === 'started' ? 'started' : 'denied'
        }
      }

      const serverNow = this.remoteAuthorityNow()
      if (!this.api
        || !this.accounting
        || serverNow === null
        || !this.validAuthority(capturedAuthority)
        || !this.authorityIsCurrent(capturedAuthority)
        || grant.gameId !== trustedProcess.gameId
        || !remoteApprovalScopeMatches(grant, permission)
        || !isRemoteApprovalGrantActive(grant, serverNow, capturedAuthority.membershipEpoch, capturedAuthority.serviceEpoch)) return 'denied'

      let accountingScope: ProtectedAccountingScope
      try { accountingScope = current?.scope ?? this.captureScope(permission) } catch { return 'denied' }
      const attempt: RemoteGrantState = current ?? {
        state: 'pending',
        idempotencyKey: `consume-grant:${grant.grantId}`,
        permission,
        claimedGrant,
        authority: Object.freeze({ ...capturedAuthority }),
        receipt: this.receipt(permission),
        minutes: grant.approvedMinutes,
        scope: accountingScope,
        outcomeRecorded: false,
        pendingOutcome: null,
      }
      attempt.state = 'pending'
      this.remoteConsumes.set(grant.grantId, attempt)
      try {
        const receipt = await this.api.consumeGrant({
          grant: attempt.claimedGrant,
          accountingScope: attempt.scope,
          idempotencyKey: attempt.idempotencyKey,
        })
        const receiptNow = this.remoteAuthorityNow()
        const validReceipt = receiptNow !== null
          && receipt.grantId === grant.grantId
          && receipt.allowanceReservationId === grant.allowanceReservationId
          && receipt.approvedMinutes === grant.approvedMinutes
          && receipt.launchGame === false
          && remoteApprovalTuplesMatch(receipt, attempt.permission)
          && isRemoteApprovalGrantActive(receipt, receiptNow, attempt.authority.membershipEpoch, attempt.authority.serviceEpoch)
        if (!validReceipt || !this.authorityIsCurrent(attempt.authority)) {
          attempt.state = 'denied'
          return 'denied'
        }
        attempt.state = 'confirmed-not-started'
        const result = await this.finalize(attempt, attempt.authority, 'remote', false, attempt.claimedGrant.expiresAt)
        attempt.state = result === 'started' ? 'started' : result === 'retryable' ? 'confirmed-not-started' : 'denied'
        return result === 'started' ? 'started' : 'denied'
      } catch (error) {
        if (error instanceof RemoteApprovalClientError && ['unavailable', 'offline'].includes(error.code)) {
          attempt.state = 'indeterminate'
          return 'indeterminate'
        }
        attempt.state = 'denied'
        if (!(error instanceof RemoteApprovalClientError)) throw error
        return 'denied'
      }
    })
  }
}
