import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isRemoteApprovalGrantActive, isRemoteApprovalRequestActive, REMOTE_APPROVAL_TTL_MS } from '../../shared/remoteApproval'
import type { PairingSession, RemoteApprovalAllowance, RemoteApprovalGrant, RemoteApprovalHealth, RemoteApprovalRequest, RemoteApprovalState } from '../../shared/types'
import { RemoteApprovalApiClient, RemoteApprovalClientError } from './apiClient'

type Membership = { householdId: string; pcId: string; membershipEpoch: number; serviceEpoch: number }
type Listener = (state: RemoteApprovalState) => void

export class RemoteApprovalController {
  private state: RemoteApprovalState = { lifecycle: 'offline', updatedAt: Date.now() }
  private membership: Membership | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<Listener>()
  private serverOffsetMs: number | null = null
  private lastServerNowMs = -Infinity
  private lastOnlineAt: number | undefined
  private localFallback = !this.client
  private readonly intentPath = process.env.PLAYTIME_PACT_REMOTE_CONFIG ? `${process.env.PLAYTIME_PACT_REMOTE_CONFIG}.intent.json` : null
  private generation = 0
  private requestInFlight = 0
  private syncSequence = 0
  private intentReplay: Promise<void> | null = null

  constructor(
    private readonly client: RemoteApprovalApiClient | null,
    private readonly pollMs = 10_000,
    private readonly now = () => Date.now(),
    private readonly onRequestAcknowledged?: (request: RemoteApprovalRequest) => void,
  ) {
    void this.replayDurableIntent()
  }

  subscribe(listener: Listener): () => void { this.listeners.add(listener); listener(this.getState()); return () => this.listeners.delete(listener) }
  getState(): RemoteApprovalState { return { ...this.state, request: this.state.request && { ...this.state.request }, grant: this.state.grant && { ...this.state.grant }, parentDevices: this.state.parentDevices?.map((device) => ({ ...device })) } }
  configureMembership(membership: Membership | null): void {
    this.membership = membership
    this.setState(membership ? { lifecycle: this.client ? 'connecting' : 'offline', ...membership } : { lifecycle: 'offline' })
  }
  startPolling(): void { if (this.timer || !this.client || !this.membership) return; this.maintainAuthority(); this.timer = setInterval(() => this.maintainAuthority(), this.pollMs) }
  stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  private setState(next: Omit<RemoteApprovalState, 'updatedAt'>): void {
    this.state = { ...next, updatedAt: this.now() }
    for (const listener of this.listeners) listener(this.getState())
  }
  private idempotency(operation: string): string { return `${operation}:${randomUUID()}` }
  private acceptServerNow(serverNowMs: number): number {
    if (!Number.isFinite(serverNowMs) || serverNowMs < this.lastServerNowMs) throw new RemoteApprovalClientError('invalid-response')
    const offset = serverNowMs - this.now()
    if (!Number.isFinite(offset) || Math.abs(offset) > 300_000) throw new RemoteApprovalClientError('invalid-response')
    this.serverOffsetMs = offset
    this.lastServerNowMs = serverNowMs
    return serverNowMs
  }
  authoritativeNow(): number | null {
    if (this.serverOffsetMs === null) return null
    const value = this.now() + this.serverOffsetMs
    return Number.isFinite(value) && value >= this.lastServerNowMs ? value : null
  }
  private validAllowance(value: unknown, pcId: string): RemoteApprovalAllowance | undefined {
    const allowance = value as Partial<RemoteApprovalAllowance> | undefined
    return allowance && allowance.pcId === pcId && typeof allowance.gameId === 'string'
      && typeof allowance.ianaTimeZone === 'string' && typeof allowance.ianaDay === 'string'
      && [allowance.totalSeconds, allowance.committedSeconds, allowance.reservedSeconds, allowance.allowanceVersion].every(Number.isFinite)
      && Number.isInteger(allowance.allowanceVersion) && allowance.allowanceVersion! > 0
      && allowance.totalSeconds! >= allowance.committedSeconds! + allowance.reservedSeconds!
      ? allowance as RemoteApprovalAllowance : undefined
  }
  private requireMembership(): Membership { if (!this.membership) throw new RemoteApprovalClientError('offline'); return this.membership }
  allowsLocalFallback(): boolean { return !this.hasIntentFile() && this.localFallback }
  isRecoveryInProgress(): boolean { return this.hasIntentFile() }

  private hasIntentFile(): boolean { return Boolean(this.intentPath && existsSync(this.intentPath)) }
  private readIntent(): { operation: 'reset' | 'delete'; membership: Membership; idempotencyKey: string } | null {
    if (!this.intentPath || !existsSync(this.intentPath)) return null
    try {
      const value = JSON.parse(readFileSync(this.intentPath, 'utf8')) as { operation?: unknown; membership?: Membership; idempotencyKey?: unknown }
      if ((value.operation !== 'reset' && value.operation !== 'delete') || !value.membership || typeof value.idempotencyKey !== 'string') return null
      return { operation: value.operation, membership: value.membership, idempotencyKey: value.idempotencyKey }
    } catch { return null }
  }
  private writeIntent(intent: { operation: 'reset' | 'delete'; membership: Membership; idempotencyKey: string }): void {
    if (!this.intentPath) throw new RemoteApprovalClientError('failed')
    const temporary = `${this.intentPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.intentPath)
    this.generation++
    this.syncSequence++
    this.localFallback = false
    this.setState({ lifecycle: 'error', ...intent.membership })
  }
  private clearIntent(): void { if (this.intentPath && existsSync(this.intentPath)) unlinkSync(this.intentPath) }
  private maintainAuthority(): void {
    void this.replayDurableIntent().then(async () => {
      if (this.hasIntentFile()) {
        this.localFallback = false
        if (this.membership) this.setState({ lifecycle: 'error', ...this.membership })
        return
      }
      if (this.membership) await this.sync()
    })
  }
  private replayDurableIntent(): Promise<void> {
    if (this.intentReplay) return this.intentReplay
    const replay = this.performDurableIntentReplay().finally(() => {
      if (this.intentReplay === replay) this.intentReplay = null
    })
    this.intentReplay = replay
    return replay
  }
  private async performDurableIntentReplay(): Promise<void> {
    const intent = this.readIntent()
    if (!intent || !this.client) return
    try {
      if (intent.operation === 'delete') {
        try {
          await this.client.deleteHousehold({ ...intent.membership, idempotencyKey: intent.idempotencyKey })
        } catch (error) {
          if (!(error instanceof RemoteApprovalClientError) || !['epoch-mismatch', 'permission-denied'].includes(error.code)) throw error
          await this.client.reconcileDelete({ ...intent.membership, idempotencyKey: intent.idempotencyKey })
        }
        this.generation++
        this.client.persistDisable()
        this.clearIntent()
        this.stopPolling()
        this.configureMembership(null)
      } else {
        let epochs: { membershipEpoch: number; serviceEpoch: number }
        try {
          epochs = await this.client.resetMembership({ ...intent.membership, idempotencyKey: intent.idempotencyKey })
        } catch (error) {
          if (!(error instanceof RemoteApprovalClientError) || !['epoch-mismatch', 'permission-denied'].includes(error.code)) throw error
          epochs = await this.client.reconcileReset({ ...intent.membership, idempotencyKey: intent.idempotencyKey })
        }
        this.generation++
        this.client.persistMembership(epochs)
        this.membership = { ...intent.membership, ...epochs }
        this.clearIntent()
      }
    } catch { /* keep durable intent for polling/startup reconciliation */ }
  }

  async createRequest(permission: Pick<RemoteApprovalRequest, 'gameId' | 'allowanceVersion' | 'processId' | 'processStartedAt'>): Promise<RemoteApprovalRequest> {
    if (this.hasIntentFile()) throw new RemoteApprovalClientError('failed')
    const membership = this.requireMembership()
    if (!this.client) throw new RemoteApprovalClientError('offline')
    const requestedAt = this.authoritativeNow()
    if (requestedAt === null) throw new RemoteApprovalClientError('offline')
    const request: RemoteApprovalRequest = { ...permission, ...membership, requestId: randomUUID(), requestedAt, expiresAt: requestedAt + REMOTE_APPROVAL_TTL_MS }
    const generation = ++this.generation
    this.requestInFlight++
    try {
      const created = await this.client.createRequest(request, this.idempotency('create-request'))
      const serverNow = this.acceptServerNow(created.requestedAt)
      if (!isRemoteApprovalRequestActive(created, serverNow, membership.membershipEpoch, membership.serviceEpoch)) throw new RemoteApprovalClientError('epoch-mismatch')
      if (generation !== this.generation) throw new RemoteApprovalClientError('failed')
      this.localFallback = false
      this.onRequestAcknowledged?.(created)
      this.setState({ lifecycle: 'request-pending', ...membership, request: created })
      return created
    } catch (error) {
      if (generation === this.generation) {
        this.localFallback = error instanceof RemoteApprovalClientError && ['offline', 'unavailable'].includes(error.code)
        this.setState({ lifecycle: this.localFallback ? 'offline' : 'error', ...membership })
      }
      throw error
    } finally {
      this.requestInFlight--
    }
  }

  async sync(): Promise<RemoteApprovalState> {
    if (this.hasIntentFile()) {
      this.localFallback = false
      if (this.membership) this.setState({ lifecycle: 'error', ...this.membership })
      return this.getState()
    }
    const generation = this.generation
    const sequence = ++this.syncSequence
    const startedDuringRequest = this.requestInFlight > 0
    const membership = this.requireMembership()
    if (!this.client) return this.getState()
    try {
      const status = await this.client.readStatus({ ...membership, idempotencyKey: this.idempotency('read-status') })
      const serverNow = this.acceptServerNow(status.serverNowMs)
      this.lastOnlineAt = serverNow
      this.localFallback = false
      const grant = status.grant && isRemoteApprovalGrantActive(status.grant, serverNow, membership.membershipEpoch, membership.serviceEpoch) ? status.grant : undefined
      const request = status.request && isRemoteApprovalRequestActive(status.request, serverNow, membership.membershipEpoch, membership.serviceEpoch) ? status.request : undefined
      if (this.hasIntentFile() || generation !== this.generation || sequence !== this.syncSequence || startedDuringRequest || this.requestInFlight > 0) return this.getState()
      this.setState({ lifecycle: grant ? 'approved' : request ? 'request-pending' : 'online', ...membership, request, grant, parentDevices: status.parentDevices, allowance: this.validAllowance(status.allowance, membership.pcId) })
    } catch (error) {
      if (this.hasIntentFile() || generation !== this.generation || sequence !== this.syncSequence || startedDuringRequest || this.requestInFlight > 0) return this.getState()
      this.localFallback = error instanceof RemoteApprovalClientError && ['offline', 'unavailable'].includes(error.code)
      this.setState({ lifecycle: this.localFallback ? 'offline' : 'error', ...membership })
    }
    return this.getState()
  }

  health(): RemoteApprovalHealth {
    const lifecycle = this.state.lifecycle === 'offline'
      ? 'offline'
      : this.state.lifecycle === 'error'
        ? 'error'
        : this.state.lifecycle === 'connecting'
          ? 'connecting'
          : 'online'
    return { lifecycle, serviceEpoch: this.membership?.serviceEpoch ?? 1, checkedAt: this.authoritativeNow() ?? this.now(), lastOnlineAt: this.lastOnlineAt }
  }
  createPairingSession(): Promise<PairingSession & { uri: string }> { if (this.hasIntentFile()) throw new RemoteApprovalClientError('failed'); const m = this.requireMembership(); if (!this.client) throw new RemoteApprovalClientError('offline'); return this.client.createPairingSession({ ...m, idempotencyKey: this.idempotency('pair-parent') }) }
  revokeParent(parentDeviceId: string): Promise<void> { if (this.hasIntentFile()) throw new RemoteApprovalClientError('failed'); const m = this.requireMembership(); if (!this.client) throw new RemoteApprovalClientError('offline'); return this.client.revokeParent({ ...m, parentDeviceId, idempotencyKey: this.idempotency('revoke-parent') }) }
  async resetMembership(): Promise<void> {
    const membership = this.requireMembership()
    if (!this.client) throw new RemoteApprovalClientError('offline')
    const existing = this.readIntent()
    if (this.hasIntentFile() && existing?.operation !== 'reset') throw new RemoteApprovalClientError('failed')
    if (!existing) this.writeIntent({ operation: 'reset', membership, idempotencyKey: this.idempotency('reset-household') })
    await this.replayDurableIntent()
    if (this.hasIntentFile()) throw new RemoteApprovalClientError('unavailable')
    if (this.membership) await this.sync()
  }
  async deleteHousehold(): Promise<void> {
    const membership = this.requireMembership()
    if (!this.client) throw new RemoteApprovalClientError('offline')
    const existing = this.readIntent()
    if (this.hasIntentFile() && existing?.operation !== 'delete') throw new RemoteApprovalClientError('failed')
    if (!existing) this.writeIntent({ operation: 'delete', membership, idempotencyKey: this.idempotency('delete-household') })
    await this.replayDurableIntent()
    if (this.hasIntentFile()) throw new RemoteApprovalClientError('unavailable')
  }
}
