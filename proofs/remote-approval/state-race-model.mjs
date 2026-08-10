export class RemoteApprovalModel {
  constructor({ membershipEpoch = 1, serviceEpoch = 1, parentIds = ['p1', 'p2', 'p3'], environmentMode = 'LOCAL_ONLY' } = {}) {
    this.membershipEpoch = membershipEpoch
    this.serviceEpoch = serviceEpoch
    this.environmentMode = environmentMode
    this.parentStatus = new Map(parentIds.map((id) => [id, 'active']))
    this.householdServiceEpoch = new Map()
    this.householdRemoteEnabled = new Map()
    this.requests = new Map()
    this.grants = new Map()
  }

  createRequest({ id, householdId, pcId, gameId, allowanceVersion, createdAt }) {
    this.#requireRemoteEnabled(householdId)
    const existing = this.requests.get(id)
    if (existing) {
      const sameBinding = existing.householdId === householdId
        && existing.pcId === pcId
        && existing.gameId === gameId
        && existing.allowanceVersion === allowanceVersion
        && existing.createdAt === createdAt
      if (!sameBinding) throw new Error('Request idempotency conflict')
      return existing
    }
    const request = {
      id,
      householdId,
      pcId,
      gameId,
      allowanceVersion,
      membershipEpoch: this.membershipEpoch,
      serviceEpoch: this.serviceEpoch,
      householdServiceEpoch: this.#householdEpoch(householdId),
      createdAt,
      expiresAt: createdAt + 300_000,
      status: 'pending',
      responses: new Map(),
    }
    this.requests.set(id, request)
    return request
  }

  respond({ requestId, parentId, decision, minutes, now }) {
    const request = this.#currentRequest(requestId, now)
    this.#requireActiveParent(parentId)
    if (request.status === 'approved') return { won: false, request, grant: this.grants.get(requestId) }
    if (decision !== 'reject' && decision !== 'approve') throw new Error('Unknown decision')
    if (decision === 'approve' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)) throw new Error('Invalid minutes')
    const priorResponse = request.responses.get(parentId)
    const proposed = { decision, minutes: decision === 'approve' ? minutes : null }
    if (priorResponse) {
      if (priorResponse.decision !== proposed.decision || priorResponse.minutes !== proposed.minutes) throw new Error('Personal response conflict')
      return { won: false, request, grant: this.grants.get(requestId) }
    }
    request.responses.set(parentId, { ...proposed, at: now })
    if (decision === 'reject') return { won: false, request }
    request.status = 'approved'
    request.approvedBy = parentId
    request.approvedMinutes = minutes
    request.approvedAt = now
    const grant = {
      id: `grant:${request.id}`,
      requestId: request.id,
      householdId: request.householdId,
      pcId: request.pcId,
      gameId: request.gameId,
      allowanceVersion: request.allowanceVersion,
      membershipEpoch: request.membershipEpoch,
      serviceEpoch: request.serviceEpoch,
      householdServiceEpoch: request.householdServiceEpoch,
      approvedBy: parentId,
      approvedMinutes: minutes,
      issuedAt: now,
      expiresAt: now + 300_000,
      state: 'issued',
    }
    this.grants.set(requestId, grant)
    return { won: true, request, grant }
  }

  consume({ requestId, pcId, gameId, allowanceVersion, processEpoch, processIdentity, now }) {
    const grant = this.grants.get(requestId)
    if (!grant) throw new Error('Grant unavailable')
    this.#requireRemoteEnabled(grant.householdId)
    if (grant.state !== 'issued') throw new Error('Grant already consumed')
    if (now >= grant.expiresAt) throw new Error('Grant expired')
    if (grant.membershipEpoch !== this.membershipEpoch || grant.serviceEpoch !== this.serviceEpoch || grant.householdServiceEpoch !== this.#householdEpoch(grant.householdId)) throw new Error('Stale grant epoch')
    if (grant.pcId !== pcId || grant.gameId !== gameId || grant.allowanceVersion !== allowanceVersion) throw new Error('Grant binding mismatch')
    if (!Number.isInteger(processEpoch) || processEpoch <= 0 || !processIdentity) throw new Error('Process binding required')
    grant.state = 'consumed'
    grant.consumedAt = now
    grant.processEpoch = processEpoch
    grant.processIdentity = processIdentity
    return grant
  }

  revokeParent(parentId) {
    this.#requireActiveParent(parentId)
    this.parentStatus.set(parentId, 'revoked')
    this.membershipEpoch += 1
  }

  resetMembership(parentIds = []) {
    this.membershipEpoch += 1
    this.parentStatus = new Map(parentIds.map((id) => [id, 'active']))
  }

  enterLocalOnly() {
    if (this.environmentMode === 'LOCAL_ONLY') return
    this.environmentMode = 'LOCAL_ONLY'
    this.serviceEpoch += 1
  }

  enableRemoteEnvironment() {
    this.environmentMode = 'REMOTE_ENABLED'
  }

  setHouseholdRemote(householdId, enabled) {
    const current = this.householdRemoteEnabled.get(householdId) ?? false
    if (current === enabled) return
    this.householdRemoteEnabled.set(householdId, enabled)
    if (!enabled) this.householdServiceEpoch.set(householdId, this.#householdEpoch(householdId) + 1)
  }

  #currentRequest(requestId, now) {
    const request = this.requests.get(requestId)
    if (!request) throw new Error('Request unavailable')
    this.#requireRemoteEnabled(request.householdId)
    if (request.membershipEpoch !== this.membershipEpoch || request.serviceEpoch !== this.serviceEpoch || request.householdServiceEpoch !== this.#householdEpoch(request.householdId)) throw new Error('Stale request epoch')
    if (request.status === 'pending' && now >= request.expiresAt) {
      request.status = 'expired'
      throw new Error('Request expired')
    }
    return request
  }

  #requireActiveParent(parentId) {
    if (this.parentStatus.get(parentId) !== 'active') throw new Error('Inactive parent')
  }

  #requireRemoteEnabled(householdId) {
    if (this.environmentMode !== 'REMOTE_ENABLED' || this.householdRemoteEnabled.get(householdId) !== true) throw new Error('LOCAL_ONLY')
  }

  #householdEpoch(householdId) {
    return this.householdServiceEpoch.get(householdId) ?? 1
  }
}

export class RemoteStartCoordinatorModel {
  constructor() {
    this.state = 'idle'
    this.startedProcess = null
    this.startedRequestId = null
    this.localGrant = null
    this.inFlight = Promise.resolve()
  }

  issueLocal({ contextId, gameId, processEpochFloor, expiresAt }) {
    if (this.localGrant && !this.localGrant.claimed) throw new Error('Local grant already pending')
    this.localGrant = { contextId, gameId, processEpochFloor, expiresAt, claimed: false }
  }

  claimLocal(input) {
    return this.#serialize(async () => {
      const { contextId, gameId, candidates, now, finalPolicyAllows, startProcess = async (candidate) => candidate } = input
      if (this.startedProcess) return { status: 'joined', process: this.startedProcess }
      if (this.state === 'indeterminate') throw new Error('Remote consume reconciliation required')
      const grant = this.localGrant
      if (!grant || grant.claimed || now >= grant.expiresAt || contextId !== grant.contextId || gameId !== grant.gameId) throw new Error('Local grant unavailable')
      const eligible = candidates
        .filter((candidate) => candidate.gameId === gameId && candidate.processEpoch > grant.processEpochFloor && candidate.startTime)
        .sort((left, right) => left.observedAt - right.observedAt || left.startTime - right.startTime || left.pid - right.pid)
      const candidate = eligible[0]
      if (!candidate) throw new Error('No matching process')
      grant.claimed = true
      if (!await finalPolicyAllows(candidate)) {
        this.state = 'denied-after-claim'
        return { status: 'denied-after-claim' }
      }
      try {
        this.startedProcess = await startProcess(candidate)
        this.state = 'started'
        return { status: 'started', process: this.startedProcess }
      } catch (error) {
        this.state = 'start-failed'
        return { status: 'start-failed', error }
      }
    })
  }

  consumeRemote({ requestId, candidate, consume, finalPolicyAllows, startProcess = async (value) => value }) {
    return this.#serialize(async () => {
      if (this.startedProcess) {
        const exactMatch = this.startedRequestId === requestId
          && this.startedProcess.pid === candidate.pid
          && this.startedProcess.startTime === candidate.startTime
        return exactMatch ? { status: 'joined', process: this.startedProcess } : { status: 'lost-race' }
      }
      if (this.state === 'indeterminate') return { status: 'indeterminate' }
      if (!candidate.startTime) throw new Error('Exact process identity required')
      this.state = 'consuming'
      const result = await consume({ requestId, candidate })
      if (result.status === 'indeterminate') {
        this.state = 'indeterminate'
        return result
      }
      if (result.status !== 'consumed') {
        this.state = 'idle'
        return result
      }
      if (!await finalPolicyAllows(candidate)) {
        this.state = 'denied-after-consume'
        return { status: 'denied-after-consume' }
      }
      try {
        this.startedProcess = await startProcess(candidate)
        this.startedRequestId = requestId
        this.state = 'started'
        return { status: 'started', process: this.startedProcess }
      } catch (error) {
        this.state = 'consumed-without-start'
        return { status: 'consumed-without-start', error }
      }
    })
  }

  reconcileIndeterminate(status) {
    return this.#serialize(async () => {
      if (this.state !== 'indeterminate') throw new Error('No indeterminate consume')
      this.state = status === 'not-consumed' ? 'idle' : 'consumed-without-start'
      return this.state
    })
  }

  #serialize(operation) {
    const result = this.inFlight.then(operation, operation)
    this.inFlight = result.then(() => undefined, () => undefined)
    return result
  }
}
